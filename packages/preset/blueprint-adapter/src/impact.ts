/** Deterministic impact candidates for one committed direct Blueprint edit. */

import type {
  Blueprint, BlueprintImpactCandidate, BlueprintImpactEvidence, BlueprintNode, BlueprintProposalValue,
  BlueprintUserChangeOperation,
} from './types.ts'

/** Direct-edit facts required by deterministic candidate discovery. */
export interface BlueprintImpactSource {
  /** Node whose direct edit already committed. */
  nodeId: string
  /** Semantic category of the edited node. */
  nodeType: BlueprintNode['type']
  /** Scalar value before the edit. */
  previousValue: BlueprintProposalValue
  /** Scalar value after fresh reprojection. */
  currentValue: BlueprintProposalValue
  /** Host-derived edit operation. */
  operation: BlueprintUserChangeOperation
}

/**
 * Discover the only nodes the model may consider for direct-edit reconciliation.
 * @param blueprint - fresh projection after the direct edit committed.
 * @param change - Host-derived old and new scalar values.
 * @returns deterministic candidates with literal or persona-structure evidence.
 */
export function discoverBlueprintImpactCandidates(
  blueprint: Blueprint,
  change: BlueprintImpactSource,
): BlueprintImpactCandidate[] {
  if (change.nodeType === 'capability' && change.operation === 'disable') {
    return capabilityDisableCandidates(blueprint, change.nodeId)
  }
  if (change.nodeType === 'purpose'
    && typeof change.previousValue === 'string'
    && typeof change.currentValue === 'string') {
    return purposeCandidates(blueprint, change)
  }
  if (change.nodeType === 'identity'
    && typeof change.previousValue === 'string'
    && typeof change.currentValue === 'string') {
    return identityCandidates(blueprint, change)
  }
  return []
}

function identityCandidates(blueprint: Blueprint, change: BlueprintImpactSource): BlueprintImpactCandidate[] {
  const previous = change.previousValue as string
  const current = change.currentValue as string
  return blueprint.nodes.flatMap((node): BlueprintImpactCandidate[] => {
    if (node.id === change.nodeId || !node.editable || typeof node.value !== 'string') return []
    if (node.type !== 'purpose' && node.type !== 'behavior' && node.type !== 'output') return []
    const evidence: BlueprintImpactEvidence[] = [{ kind: 'identity-peer' }]
    for (const value of removedLiterals(previous, current, node.value)) {
      evidence.push({ kind: 'removed-literal', value })
    }
    return [{ nodeId: node.id, evidence }]
  })
}

function capabilityDisableCandidates(blueprint: Blueprint, sourceNodeId: string): BlueprintImpactCandidate[] {
  const source = blueprint.nodes.find(node => node.id === sourceNodeId)
  const tool = capabilityTool(source)
  if (tool === undefined) return []
  return blueprint.nodes.flatMap((node): BlueprintImpactCandidate[] => {
    if (!node.editable || !isPromptNode(node) || typeof node.value !== 'string') return []
    if (!containsCanonicalToolReference(node.value, tool)) return []
    return [{ nodeId: node.id, evidence: [{ kind: 'tool-reference', value: tool }] }]
  })
}

function purposeCandidates(blueprint: Blueprint, change: BlueprintImpactSource): BlueprintImpactCandidate[] {
  const previous = change.previousValue as string
  const current = change.currentValue as string
  return blueprint.nodes.flatMap((node): BlueprintImpactCandidate[] => {
    if (node.id === change.nodeId || !node.editable || typeof node.value !== 'string') return []
    if (node.type !== 'identity' && node.type !== 'behavior' && node.type !== 'output') return []
    const evidence: BlueprintImpactEvidence[] = [{ kind: 'purpose-child' }]
    for (const value of removedLiterals(previous, current, node.value)) {
      evidence.push({ kind: 'removed-literal', value })
    }
    return [{ nodeId: node.id, evidence }]
  })
}

function removedLiterals(previous: string, current: string, target: string): string[] {
  const values = new Set<string>()
  for (const word of previous.match(/[A-Za-z0-9][A-Za-z0-9_-]*/gu) ?? []) {
    if (!current.includes(word) && target.includes(word)) values.add(word)
  }
  for (const run of previous.match(/\p{Script=Han}+/gu) ?? []) {
    const characters = Array.from(run)
    for (let size = 2; size <= Math.min(8, characters.length); size++) {
      for (let start = 0; start + size <= characters.length; start++) {
        const value = characters.slice(start, start + size).join('')
        if (!current.includes(value) && target.includes(value)) values.add(value)
      }
    }
  }
  const ordered = [...values].sort((left, right) => left.length - right.length || left.localeCompare(right))
  return ordered.filter(value => !ordered.some(other => other !== value && value.includes(other))).slice(0, 4)
}

function capabilityTool(node: BlueprintNode | undefined): string | undefined {
  if (node?.type !== 'capability' || typeof node.value !== 'object'
    || node.value === null || Array.isArray(node.value)) return undefined
  const tool = (node.value as Record<string, unknown>)['tool']
  return typeof tool === 'string' && tool !== '' ? tool : undefined
}

function isPromptNode(node: BlueprintNode): boolean {
  return node.type === 'identity' || node.type === 'purpose'
    || node.type === 'behavior' || node.type === 'output'
}

function containsCanonicalToolReference(text: string, tool: string): boolean {
  const escaped = tool.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`, 'u').test(text)
}
