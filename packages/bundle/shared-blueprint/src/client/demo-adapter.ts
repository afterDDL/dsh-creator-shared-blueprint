/** Deterministic in-browser Blueprint data source for a deployable static Demo. */

import type {
  Blueprint, BlueprintApplyChangeSetRequest, BlueprintApplyChangeSetResult,
  BlueprintConversationContextRequest, BlueprintConversationContextResult, BlueprintNode,
} from 'dsh-shared-blueprint/contract'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  BlueprintAgentCatalog, BlueprintAgentCatalogSnapshot, BlueprintAgentOption, BlueprintRemote,
} from './controller.ts'

/** One content-owned Agent and its initial Blueprint projection. */
export interface BlueprintDemoSeed {
  agent: BlueprintAgentOption
  blueprint: Blueprint
}

/** Initial-selection policy for an in-memory Blueprint Demo. */
export interface BlueprintDemoAdapterOptions {
  preferredPresetId?: string
}

interface DemoRecord {
  readonly agent: BlueprintAgentOption
  readonly initial: Blueprint
  blueprint: Blueprint
  revisionNumber: number
}

function cloned<T>(value: T): T {
  return structuredClone(value)
}

function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

function failure<T>(code: string, message: string, details: object = {}): RemoteResult<T> {
  return { ok: false, error: { code, message, details } }
}

interface DemoCapabilityValue {
  raw: Record<string, unknown>
  tool?: string
  enabled: boolean
}

function capabilityValue(node: BlueprintNode): DemoCapabilityValue | undefined {
  if (typeof node.value !== 'object' || node.value === null || Array.isArray(node.value)) return undefined
  const value = node.value as Record<string, unknown>
  if (typeof value['enabled'] !== 'boolean') return undefined
  return {
    raw: value,
    enabled: value['enabled'],
    ...(typeof value['tool'] === 'string' ? { tool: value['tool'] } : {}),
  }
}

function withNodeValue(blueprint: Blueprint, targetNodeId: string, value: BlueprintNode['value']): Blueprint {
  return {
    ...blueprint,
    nodes: blueprint.nodes.map(node => node.id === targetNodeId ? { ...node, value } : node),
  }
}

function withCapability(
  blueprint: Blueprint,
  targetNodeId: string,
  value: DemoCapabilityValue,
  enabled: boolean,
): Blueprint {
  const tools = value.tool === undefined
    ? blueprint.runtime.tools
    : enabled
      ? blueprint.runtime.tools.includes(value.tool)
        ? blueprint.runtime.tools
        : [...blueprint.runtime.tools, value.tool]
      : blueprint.runtime.tools.filter(tool => tool !== value.tool)
  return {
    ...withNodeValue(blueprint, targetNodeId, {
      ...value.raw,
      enabled,
    }),
    runtime: { ...blueprint.runtime, tools },
  }
}

/**
 * In-memory implementation of the same roster, projection, and transaction face used by the DSH binding.
 * It never claims runtime conformance and accepts its scenario content from the caller.
 */
export class InMemoryBlueprintDemoAdapter implements BlueprintAgentCatalog, BlueprintRemote {
  private readonly records = new Map<string, DemoRecord>()
  private readonly preferredPresetId: string | undefined

  /**
   * @param seeds - caller-owned Demo content; no example Agent is built into the adapter.
   * @param options - optional initial target preference.
   */
  constructor(seeds: readonly BlueprintDemoSeed[], options: BlueprintDemoAdapterOptions = {}) {
    for (const seed of seeds) this.installScenario(seed)
    if (options.preferredPresetId !== undefined && !this.records.has(options.preferredPresetId)) {
      throw new Error(`Unknown preferred Blueprint Demo preset: ${options.preferredPresetId}`)
    }
    this.preferredPresetId = options.preferredPresetId
  }

  /** @returns a detached roster snapshot and caller-selected initial target. */
  list(): Promise<BlueprintAgentCatalogSnapshot> {
    const agents = [...this.records.values()].map(record => cloned(record.agent))
    return Promise.resolve({
      agents,
      ...(this.preferredPresetId === undefined ? {} : { preferredPresetId: this.preferredPresetId }),
    })
  }

  /**
   * Add one caller-owned preset when a scripted Demo journey reaches that page state.
   * @param seed - detached Agent identity and Blueprint projection to publish.
   */
  installScenario(seed: BlueprintDemoSeed): void {
    if (this.records.has(seed.agent.id)) throw new Error(`Duplicate Blueprint Demo preset: ${seed.agent.id}`)
    if (seed.blueprint.preset.id !== seed.agent.id) {
      throw new Error(`Blueprint Demo seed ${seed.agent.id} projects preset ${seed.blueprint.preset.id}`)
    }
    if (seed.blueprint.preset.trust !== seed.agent.trust) {
      throw new Error(`Blueprint Demo seed ${seed.agent.id} has inconsistent trust`)
    }
    this.records.set(seed.agent.id, {
      agent: cloned(seed.agent),
      initial: cloned(seed.blueprint),
      blueprint: cloned(seed.blueprint),
      revisionNumber: 0,
    })
  }

  /**
   * Replace the visible projection for one installed Demo preset.
   * The caller owns milestone timing; replacement keeps the original reset seed.
   * @param seed - detached Agent identity and current Blueprint projection.
   */
  replaceScenario(seed: BlueprintDemoSeed): void {
    const record = this.requireRecord(seed.agent.id)
    if (seed.blueprint.preset.id !== seed.agent.id || seed.blueprint.preset.trust !== seed.agent.trust) {
      throw new Error(`Blueprint Demo replacement ${seed.agent.id} is inconsistent`)
    }
    record.blueprint = cloned(seed.blueprint)
    record.revisionNumber = Number(seed.blueprint.revision.match(/(\d+)$/u)?.[1] ?? record.revisionNumber)
  }

  /**
   * Restore one preset or the complete Demo to its supplied seed state.
   * @param presetId - optional single target; omission resets every target.
   */
  reset(presetId?: string): void {
    const records = presetId === undefined
      ? [...this.records.values()]
      : [this.requireRecord(presetId)]
    for (const record of records) {
      record.blueprint = cloned(record.initial)
      record.revisionNumber = 0
    }
  }

  /**
   * @param request - preset projection request.
   * @returns the current detached in-browser projection.
   */
  get(request: { presetId: string }): Promise<RemoteResult<Blueprint>> {
    const record = this.records.get(request.presetId)
    return Promise.resolve(record === undefined
      ? failure('demo-preset-not-found', `Demo 中没有 Agent：${request.presetId}`)
      : ok(cloned(record.blueprint)))
  }

  /**
   * Apply a complete closed Change Set atomically in browser memory.
   * @param request - confirmed transaction against one visible revision.
   * @returns committed or preflight-failed transaction evidence.
   */
  applyChangeSet(
    request: BlueprintApplyChangeSetRequest,
  ): Promise<RemoteResult<BlueprintApplyChangeSetResult>> {
    const record = this.records.get(request.presetId)
    if (record === undefined) {
      return Promise.resolve(failure('demo-preset-not-found', `Demo 中没有 Agent：${request.presetId}`))
    }
    const duplicate = request.operations.find((operation, index) => (
      request.operations.findIndex(candidate => candidate.targetNodeId === operation.targetNodeId) !== index
    ))
    let reason = record.blueprint.revision !== request.baseRevision
      ? 'Blueprint revision changed before Apply.'
      : request.operations.length === 0
        ? 'Change Set contains no operations.'
        : duplicate !== undefined
          ? `Duplicate target node: ${duplicate.targetNodeId}`
          : undefined
    let staged = cloned(record.blueprint)
    if (reason === undefined) {
      for (const operation of request.operations) {
        const step = this.stageOperation(staged, operation)
        if ('problem' in step) {
          reason = step.problem
          break
        }
        staged = step.blueprint
      }
    }
    if (reason !== undefined) {
      return Promise.resolve(ok({
        sourceSessionId: request.sourceSessionId,
        routeId: request.routeId,
        changeSetId: request.changeSetId,
        baseRevision: request.baseRevision,
        status: 'preflight_failed',
        operations: cloned(request.operations),
        preflight: { ok: false, reason },
        unexpectedDrift: [],
        failure: reason,
      }))
    }
    const current = this.commit(record, staged)
    return Promise.resolve(ok({
      sourceSessionId: request.sourceSessionId,
      routeId: request.routeId,
      changeSetId: request.changeSetId,
      baseRevision: request.baseRevision,
      committedRevision: current.revision,
      status: 'committed',
      operations: cloned(request.operations),
      preflight: { ok: true },
      unexpectedDrift: [],
    }))
  }

  /**
   * A static Demo retains selected context only in the UI controller, so this operation has no external effect.
   * @param request - context request issued by the shared controller.
   * @returns a truthful acknowledgement without runtime or model claims.
   */
  setConversationContext(
    request: BlueprintConversationContextRequest,
  ): Promise<RemoteResult<BlueprintConversationContextResult>> {
    const active = request.presetId !== undefined || request.creatorDraft !== undefined
      || request.capabilityAuthoring !== undefined
    return Promise.resolve(ok({
      sessionId: request.sessionId,
      active,
      ...(request.presetId === undefined ? {} : { presetId: request.presetId }),
      ...(request.selectedNodeId === undefined ? {} : { selectedNodeId: request.selectedNodeId }),
    }))
  }

  private requireRecord(presetId: string): DemoRecord {
    const record = this.records.get(presetId)
    if (record === undefined) throw new Error(`Unknown Blueprint Demo preset: ${presetId}`)
    return record
  }

  private stageOperation(
    blueprint: Blueprint,
    operation: BlueprintApplyChangeSetRequest['operations'][number],
  ): { blueprint: Blueprint } | { problem: string } {
    const node = blueprint.nodes.find(candidate => candidate.id === operation.targetNodeId)
    if (node === undefined) return { problem: `Unknown target node: ${operation.targetNodeId}` }
    if (!node.editable) return { problem: `Read-only target node: ${operation.targetNodeId}` }
    if (operation.operation === 'setCapability') {
      const value = capabilityValue(node)
      if (node.type !== 'capability' || value === undefined) {
        return { problem: `Invalid capability target: ${operation.targetNodeId}` }
      }
      if (operation.targetNodeId !== `capability:${operation.capability}`) {
        return { problem: `Capability target mismatch: ${operation.targetNodeId}` }
      }
      if (value.enabled !== operation.expected) {
        return { problem: `Changed target node: ${operation.targetNodeId}` }
      }
      return { blueprint: withCapability(blueprint, operation.targetNodeId, value, operation.enabled) }
    }
    const expectedType = operation.operation === 'updateIdentity' ? 'identity'
      : operation.operation === 'updatePurpose' ? 'purpose'
        : operation.operation === 'updateBehavior' ? 'behavior' : 'output'
    if (node.type !== expectedType || typeof node.value !== 'string') {
      return { problem: `Invalid text target: ${operation.targetNodeId}` }
    }
    if (node.value !== operation.expected) return { problem: `Changed target node: ${operation.targetNodeId}` }
    if (operation.value.trim() === '' || operation.value.includes('\n') || operation.value.includes('\r')) {
      return { problem: `Invalid replacement text: ${operation.targetNodeId}` }
    }
    return { blueprint: withNodeValue(blueprint, operation.targetNodeId, operation.value) }
  }

  private commit(record: DemoRecord, staged: Blueprint): Blueprint {
    record.revisionNumber += 1
    record.blueprint = {
      ...cloned(staged),
      revision: `demo:${record.agent.id}:${String(record.revisionNumber)}`,
    }
    return cloned(record.blueprint)
  }

}
