/** Transaction coordinator for one confirmed Interactive Blueprint Change Set. */

import { compositionRevision, parseComposition } from './composition.ts'
import type {
  Blueprint,
  BlueprintApplyChangeSetRequest,
  BlueprintApplyChangeSetResult,
  BlueprintChangeSetOperation,
  BlueprintNode,
  BlueprintProposalValue,
} from '../contract/types.ts'
import {
  applyBlueprintOperation,
  operationAdapterRef,
  operationExpected,
  operationNodeType,
  operationProposed,
  stagedOperationValue,
} from './writeback.ts'
import { assertMountedDelegationReferences } from './delegation-reference.ts'

/** I/O supplied by the adapter while this coordinator owns one serialized preset transaction. */
export interface BlueprintTransactionIO {
  /** Produce the staged composition without publishing it. */
  stage(): string
  /** Atomically publish either the staged composition or the recovery snapshot. */
  commit(composition: string): Promise<void>
  /** Reproject the just-published real preset. */
  reproject(): Promise<Blueprint>
  /** Read the composition currently on disk for commit and recovery conflict checks. */
  readCurrentComposition(): Promise<string>
}

/** Validate every operation and physical write target without changing the preset. */
function preflightBlueprintChangeSet(
  request: BlueprintApplyChangeSetRequest,
  blueprint: Blueprint,
  composition: string,
): void {
  if (request.changeSetId.trim() === '') throw new Error('blueprint transaction: changeSetId must not be empty')
  if (request.presetId !== blueprint.preset.id) {
    throw new Error('blueprint transaction: Change Set targets a different preset')
  }
  if (request.baseRevision !== blueprint.revision
    || request.baseRevision !== compositionRevision(composition)) {
    throw new Error('blueprint transaction: base revision is stale')
  }
  if (request.operations.length === 0) throw new Error('blueprint transaction: Change Set has no operations')
  assertMountedDelegationReferences(blueprint, request.operations)

  const targets = new Set<string>()
  const physicalTargets = new Set<string>()
  for (const operation of request.operations) {
    if (targets.has(operation.targetNodeId)) {
      throw new Error(`blueprint transaction: duplicate target ${JSON.stringify(operation.targetNodeId)}`)
    }
    targets.add(operation.targetNodeId)
    const node = blueprint.nodes.find(candidate => candidate.id === operation.targetNodeId)
    if (node === undefined) throw new Error('blueprint transaction: target node no longer exists')
    if (!node.editable || node.adapterRef === null) {
      throw new Error('blueprint transaction: target node is read-only')
    }
    if (node.adapterRef !== operationAdapterRef(operation)) {
      throw new Error('blueprint transaction: target node has an incompatible physical adapter reference')
    }
    if (node.type !== operationNodeType(operation)) {
      throw new Error('blueprint transaction: operation does not match target node type')
    }
    if (physicalTargets.has(node.adapterRef)) {
      throw new Error('blueprint transaction: operations share one physical write target')
    }
    physicalTargets.add(node.adapterRef)
    if (!sameScalar(nodeScalar(node), operationExpected(operation))) {
      throw new Error('blueprint transaction: expected value is stale')
    }
    if (sameScalar(operationExpected(operation), operationProposed(operation))) {
      throw new Error('blueprint transaction: proposed value must differ from expected value')
    }
    // The same pure transform used for staging proves the raw source value,
    // operation-specific address, and unique physical anchor before any write.
    applyBlueprintOperation(composition, operation)
  }
}

/** Apply all typed transforms to one in-memory composition. */
export function stageBlueprintChangeSet(
  composition: string,
  operations: readonly BlueprintChangeSetOperation[],
): string {
  return operations.reduce(
    (staged, operation) => applyBlueprintOperation(staged, operation),
    composition,
  )
}

/** Reparse staged YAML and prove every target remains projected at its proposed scalar. */
function validateStagedBlueprint(
  composition: string,
  operations: readonly BlueprintChangeSetOperation[],
): void {
  parseComposition(composition)
  for (const operation of operations) {
    if (!sameScalar(stagedOperationValue(composition, operation), operationProposed(operation))) {
      throw new Error(`blueprint transaction: staged target ${JSON.stringify(operation.targetNodeId)} is not projectable`)
    }
  }
}

/** Verify all targets and return semantic drift outside the confirmed Change Set. */
function verifyBlueprintTransaction(
  before: Blueprint,
  after: Blueprint,
  operations: readonly BlueprintChangeSetOperation[],
): string[] {
  const targets = new Set(operations.map(operation => operation.targetNodeId))
  for (const operation of operations) {
    const node = after.nodes.find(candidate => candidate.id === operation.targetNodeId)
    if (node === undefined || !sameScalar(nodeScalar(node), operationProposed(operation))) {
      throw new BlueprintVerificationError(
        `blueprint transaction: committed target ${JSON.stringify(operation.targetNodeId)} failed reprojection`,
        semanticDrift(before, after, targets),
      )
    }
  }
  return semanticDrift(before, after, targets)
}

/** Execute one full no-partial-success transaction over adapter-owned I/O. */
export async function executeBlueprintTransaction(
  request: BlueprintApplyChangeSetRequest,
  beforeBlueprint: Blueprint,
  beforeComposition: string,
  io: BlueprintTransactionIO,
): Promise<BlueprintApplyChangeSetResult> {
  const base = resultBase(request)
  try {
    preflightBlueprintChangeSet(request, beforeBlueprint, beforeComposition)
  } catch (error) {
    return {
      ...base,
      status: 'preflight_failed',
      preflight: { ok: false, reason: messageOf(error) },
      unexpectedDrift: [],
    }
  }

  let stagedComposition: string
  try {
    stagedComposition = io.stage()
    validateStagedBlueprint(stagedComposition, request.operations)
  } catch (error) {
    return {
      ...base,
      status: 'staging_failed',
      preflight: { ok: true },
      unexpectedDrift: [],
      failure: messageOf(error),
    }
  }
  const committedRevision = compositionRevision(stagedComposition)

  try {
    const current = await io.readCurrentComposition()
    if (compositionRevision(current) !== request.baseRevision) {
      return {
        ...base,
        status: 'preflight_failed',
        preflight: { ok: false, reason: 'blueprint transaction: preset changed before commit' },
        unexpectedDrift: [],
      }
    }
    await io.commit(stagedComposition)
  } catch (error) {
    return {
      ...base,
      committedRevision,
      status: 'commit_failed',
      preflight: { ok: true },
      unexpectedDrift: [],
      failure: messageOf(error),
    }
  }

  let unexpectedDrift: string[] = []
  try {
    const after = await io.reproject()
    unexpectedDrift = verifyBlueprintTransaction(beforeBlueprint, after, request.operations)
    if (unexpectedDrift.length > 0) {
      throw new BlueprintVerificationError('blueprint transaction: unexpected semantic drift', unexpectedDrift)
    }
    return {
      ...base,
      committedRevision,
      status: 'committed',
      preflight: { ok: true },
      unexpectedDrift: [],
    }
  } catch (error) {
    unexpectedDrift = error instanceof BlueprintVerificationError ? error.unexpectedDrift : unexpectedDrift
    const failure = messageOf(error)
    let currentComposition: string
    try {
      currentComposition = await io.readCurrentComposition()
    } catch {
      return {
        ...base,
        committedRevision,
        status: 'reprojection_failed_conflict',
        preflight: { ok: true },
        unexpectedDrift,
        failure,
      }
    }
    if (compositionRevision(currentComposition) !== committedRevision) {
      return {
        ...base,
        committedRevision,
        status: 'reprojection_failed_conflict',
        preflight: { ok: true },
        unexpectedDrift,
        failure,
      }
    }
    try {
      await io.commit(beforeComposition)
      const restored = await io.readCurrentComposition()
      if (compositionRevision(restored) !== request.baseRevision) {
        throw new Error('blueprint transaction: recovery snapshot was not retained')
      }
    } catch (recoveryError) {
      return {
        ...base,
        committedRevision,
        status: 'reprojection_failed_recovery_failed',
        preflight: { ok: true },
        unexpectedDrift,
        failure: `${failure}; recovery failed: ${messageOf(recoveryError)}`,
      }
    }
    return {
      ...base,
      committedRevision,
      status: 'reprojection_failed_recovered',
      preflight: { ok: true },
      unexpectedDrift,
      failure,
    }
  }
}

class BlueprintVerificationError extends Error {
  constructor(message: string, readonly unexpectedDrift: string[]) {
    super(message)
  }
}

function resultBase(request: BlueprintApplyChangeSetRequest): Pick<
  BlueprintApplyChangeSetResult,
  'sourceSessionId' | 'routeId' | 'changeSetId' | 'baseRevision' | 'operations'
> {
  return {
    sourceSessionId: request.sourceSessionId,
    routeId: request.routeId,
    changeSetId: request.changeSetId,
    baseRevision: request.baseRevision,
    operations: request.operations,
  }
}

function nodeScalar(node: BlueprintNode): BlueprintProposalValue | undefined {
  if (node.type !== 'capability') return typeof node.value === 'string' ? node.value : undefined
  if (typeof node.value !== 'object' || node.value === null || Array.isArray(node.value)) return undefined
  const enabled = (node.value as Record<string, unknown>)['enabled']
  return typeof enabled === 'boolean' ? enabled : undefined
}

function semanticDrift(before: Blueprint, after: Blueprint, targets: ReadonlySet<string>): string[] {
  const beforeNodes = semanticNodes(before)
  const afterNodes = semanticNodes(after)
  return [...new Set([...beforeNodes.keys(), ...afterNodes.keys()])]
    .filter(nodeId => !targets.has(nodeId)
      && JSON.stringify(beforeNodes.get(nodeId)) !== JSON.stringify(afterNodes.get(nodeId)))
    .sort()
}

function semanticNodes(blueprint: Blueprint): Map<string, { type: BlueprintNode['type']; value: BlueprintNode['value'] }> {
  return new Map(blueprint.nodes
    .filter(node => node.type !== 'access')
    .map(node => [node.id, { type: node.type, value: node.value }]))
}

function sameScalar(left: BlueprintProposalValue | undefined, right: BlueprintProposalValue): boolean {
  return left === right
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
