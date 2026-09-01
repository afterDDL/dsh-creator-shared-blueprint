import { describe, expect, it, vi } from 'vitest'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type {
  Blueprint,
  BlueprintApplyChangeSetRequest,
  BlueprintApplyChangeSetResult,
  BlueprintApplyReceipt,
  BlueprintCapabilityAuthoringKind,
  BlueprintCapabilityAuthoringRoute,
  BlueprintChangeProposal,
  BlueprintChangeSet,
  BlueprintConversationContextRequest,
  BlueprintConversationContextResult,
  BlueprintCreatorAuthoringRoute,
  BlueprintProposalCancellation,
  BlueprintSessionValidation,
  BlueprintStructuredEditInput,
} from 'dsh-shared-blueprint/contract'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import {
  BlueprintUiController,
  blueprintSessionLifecycleDiagnostic,
  creatorOwnsForeground,
  type BlueprintAgentOption,
  type BlueprintCapabilityHandoff,
  type BlueprintCapabilityObservation,
  type BlueprintCreatorObservation,
  type BlueprintRemote,
  type BlueprintTrialRequest,
  type BlueprintUiState,
} from '../src/client/controller.ts'
import { assertDirectEditEnqueued } from '../src/client/direct-edit-enqueue.ts'
import { creatorAuthoringOwnsRoute } from '../src/client/index.ts'
import { blueprintProposalStatus, type BlueprintProposalStatus } from '../src/client/proposal-status.ts'
import { prepareBlueprintTrialSession } from '../src/client/trial-session.ts'

const sessionId = (value: string): SessionId => value as SessionId

/** Stable comparison checkpoints exercised against the production controller. */
export const INTERACTION_CONFORMANCE_STAGES = [
  'idle',
  'creating',
  'waiting-input',
  'waiting-approval',
  'ready',
  'existing-agent-edit',
  'proposal',
  'apply',
  'capability-authoring',
  'skill',
  'subagent',
  'test',
] as const

export type InteractionConformanceStage = typeof INTERACTION_CONFORMANCE_STAGES[number]

/** Product-derived facts retained at one lifecycle checkpoint. */
export interface InteractionConformanceCheckpoint {
  stage: InteractionConformanceStage
  foregroundSessionId: string | null
  targetPresetId: string | null
  sessionEventTypes: readonly string[]
  pendingInteraction: 'input' | 'approval' | null
  lifecycle: string
  blueprintRevision: string | null
  selectedNodeId: string | null
  proposalIds: readonly string[]
  routeIds: readonly string[]
  capabilityAuthoring: BlueprintCapabilityAuthoringKind | null
  testSessionId: string | null
  visibleControls: readonly string[]
}

/** Driver boundary backed by the real Blueprint controller and durable Host fixtures. */
export interface InteractionConformanceDriver {
  reset(): Promise<void>
  reach(stage: InteractionConformanceStage): Promise<void>
  capture(stage: InteractionConformanceStage): Promise<InteractionConformanceCheckpoint>
}

interface DurableCheckpoint {
  seq: number
  type: string
  sourceSessionId?: string
  routeId?: string
  creatorSessionId?: string
  presetId?: string
  changeSetId?: string
}

type CapabilityRecord = NonNullable<BlueprintConversationContextResult['capabilityAuthoringRecord']>

interface StoredCapabilityRecord {
  executionSessionId: string
  legacyCreatorSessionId?: string
  sourceRouteSeq: number
  waitingFor: BlueprintCapabilityObservation['waitingFor']
  record: CapabilityRecord
}

interface CreationTask {
  sourceSessionId: string
  creatorSessionId: string
  startSeq: number
  route: BlueprintCreatorAuthoringRoute
}

function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

function blueprint(
  revision = 'r1',
  presetId = 'competitive-research',
  name = 'AI 产品竞品研究',
  trust: 'system' | 'user' = 'user',
): Blueprint {
  return {
    schemaVersion: 1,
    sourceLanguage: 'zh',
    preset: { id: presetId, name, trust },
    revision,
    nodes: [
      { id: 'identity:persona', type: 'identity', value: 'AI 产品竞品研究分析师', source: 'preset', status: 'active', editable: true, adapterRef: 'identity' },
      { id: 'purpose:persona', type: 'purpose', value: '比较 AI 产品的能力、定价与定位。', source: 'inferred', status: 'active', editable: true, adapterRef: 'purpose' },
      { id: 'behavior:1', type: 'behavior', value: '重要结论必须给出来源。', source: 'preset', status: 'active', editable: true, adapterRef: 'behavior:1' },
      { id: 'output:2', type: 'output', value: '输出结构化竞品报告。', source: 'inferred', status: 'active', editable: true, adapterRef: 'output:2' },
      { id: 'capability:web-search', type: 'capability', value: { name: 'Web Search', tool: 'web_search', enabled: true }, source: 'runtime', status: 'active', editable: true, adapterRef: 'search' },
      { id: 'capability:web-fetch', type: 'capability', value: { name: 'Web Fetch', tool: 'web_fetch', enabled: true }, source: 'runtime', status: 'active', editable: true, adapterRef: 'fetch' },
      { id: 'capability:file-read', type: 'capability', value: { name: 'File Read', tool: 'read', enabled: true }, source: 'runtime', status: 'active', editable: false, adapterRef: null },
    ],
    runtime: {
      tools: ['web_search', 'web_fetch', 'read'],
      promptSections: ['deployment:persona'],
      skills: [],
      delegations: [],
      permissions: null,
    },
    mappingGaps: [],
  }
}

function validation(
  sessionId: string,
  presetId: string,
  revision: string,
): BlueprintSessionValidation {
  return {
    sessionId,
    presetId,
    valid: true,
    overall: 'pass',
    binding: {
      status: 'pass',
      sessionPresetId: presetId,
      composedPresetId: presetId,
      expectedRevision: revision,
      projectedRevision: revision,
      strictRevisionBound: false,
    },
    prompt: { status: 'pass', evidence: [] },
    tools: { status: 'pass', evidence: [], missing: [], unexpected: [], schemaMismatches: [] },
    skills: { status: 'pass', evidence: [], missing: [], unexpected: [] },
    delegations: { status: 'pass', evidence: [] },
    permissions: { status: 'pass' },
  }
}

function proposalOperation(input: BlueprintStructuredEditInput): BlueprintChangeProposal['operation'] {
  switch (input.nodeType) {
    case 'identity': return 'updateIdentity'
    case 'purpose': return 'updatePurpose'
    case 'behavior': return 'updateBehavior'
    case 'output': return 'updateOutput'
    case 'capability': return 'setCapability'
  }
}

function transactionOperation(proposal: BlueprintChangeProposal) {
  if (proposal.operation === 'setCapability') {
    return {
      operation: proposal.operation,
      targetNodeId: proposal.targetNodeId,
      capability: proposal.targetNodeId === 'capability:web-search' ? 'web-search' as const : 'web-fetch' as const,
      expected: proposal.currentValue as boolean,
      enabled: proposal.proposedValue as boolean,
    }
  }
  return {
    operation: proposal.operation,
    targetNodeId: proposal.targetNodeId,
    expected: proposal.currentValue as string,
    value: proposal.proposedValue as string,
  }
}

class ContractHost {
  readonly events: DurableCheckpoint[] = []
  readonly structuredEdits: BlueprintStructuredEditInput[] = []
  readonly structuredEditTargets = new Map<string, { presetId: string; revision: string }>()
  readonly proposals: BlueprintChangeSet[] = []
  readonly receipts: BlueprintApplyReceipt[] = []
  readonly cancellations: BlueprintProposalCancellation[] = []
  readonly applyRequests: BlueprintApplyChangeSetRequest[] = []
  readonly trialRequests: BlueprintTrialRequest[] = []
  readonly trialSteps: string[] = []
  readonly capabilityRecords = new Map<string, StoredCapabilityRecord>()
  readonly projections = new Map<string, Blueprint>()
  readonly agents: BlueprintAgentOption[] = []
  readonly initialPresetCount: number
  testSessionId: string | null = null
  private seq = 0
  private revision = 1
  private creatorCount = 0
  private trialCount = 0

  constructor() {
    this.agents.push(
      { id: 'cordis', label: 'Creator', trust: 'system' },
      { id: 'competitive-research', label: 'AI 产品竞品研究', trust: 'user' },
    )
    this.projections.set('cordis', blueprint('cordis-r1', 'cordis', 'Creator', 'system'))
    this.projections.set('competitive-research', blueprint())
    this.initialPresetCount = this.projections.size
  }

  append(type: string, data: Omit<DurableCheckpoint, 'seq' | 'type'> = {}): number {
    const seq = ++this.seq
    this.events.push({ seq, type, ...data })
    return seq
  }

  read(presetId: string): Blueprint {
    const value = this.projections.get(presetId)
    if (value === undefined) throw new Error(`Unknown Blueprint ${presetId}`)
    return structuredClone(value)
  }

  addCreatedPreset(): Blueprint {
    const created = blueprint('created-r1', 'ai-product-research', 'AI 产品竞品研究 Agent')
    this.agents.push({ id: created.preset.id, label: created.preset.name!, trust: 'user' })
    this.projections.set(created.preset.id, created)
    return created
  }

  publishStructuredEdit(
    sourceSessionId: string,
    projected: Blueprint,
    input: BlueprintStructuredEditInput,
  ): void {
    if (input.sourceSessionId !== sourceSessionId) throw new Error('structured edit crossed its source Session')
    const projectedNode = projected.nodes.find(node => node.id === input.nodeId)
    if (projectedNode === undefined || projectedNode.type !== input.nodeType) {
      throw new Error('structured edit target differs from the projected Blueprint')
    }
    const routingInputSeq = this.append('blueprint/routing-input', {
      sourceSessionId,
      routeId: input.routeId,
      presetId: projected.preset.id,
    })
    const messageSeq = this.append('user/message', { sourceSessionId, routeId: input.routeId })
    const response: BlueprintConversationContextResult = {
      sessionId: sourceSessionId,
      active: true,
      directEditEnqueue: {
        sourceSessionId,
        routeId: input.routeId,
        routingInputSeq,
        messageId: MessageId(`structured-${String(messageSeq)}`),
      },
    }
    assertDirectEditEnqueued(response, sourceSessionId, input)
    this.structuredEdits.push(input)
    this.structuredEditTargets.set(input.routeId, {
      presetId: projected.preset.id,
      revision: projected.revision,
    })
  }

  registerProposal(input: BlueprintStructuredEditInput): BlueprintChangeSet {
    const target = this.structuredEditTargets.get(input.routeId)
    if (target === undefined) throw new Error('Proposal lacks a durable structured-edit target')
    const current = this.read(target.presetId)
    if (current.revision !== target.revision) throw new Error('Proposal target changed after the structured edit')
    const changeSetId = `proposal-${String(this.proposals.length + 1)}`
    const proposal: BlueprintChangeProposal = {
      proposalId: `${changeSetId}:1`,
      presetId: current.preset.id,
      revision: current.revision,
      targetNodeId: input.nodeId,
      operation: proposalOperation(input),
      currentValue: input.expectedValue,
      proposedValue: input.proposedValue,
      impact: '按用户确认的结构化编辑更新目标节点。',
    }
    const changeSet: BlueprintChangeSet = {
      kind: 'structured-edit',
      changeSetId,
      sourceSessionId: input.sourceSessionId,
      routeId: input.routeId,
      presetId: current.preset.id,
      revision: current.revision,
      sourceNodeId: input.nodeId,
      sourceNodeType: input.nodeType,
      sourceLabel: input.nodeType === 'purpose' ? 'Purpose' : input.nodeType,
      proposals: [proposal],
    }
    this.append('tool/call', {
      sourceSessionId: input.sourceSessionId,
      routeId: input.routeId,
      changeSetId,
    })
    this.append('blueprint/route-decision', {
      sourceSessionId: input.sourceSessionId,
      routeId: input.routeId,
      presetId: current.preset.id,
      changeSetId,
    })
    this.append('tool/result', {
      sourceSessionId: input.sourceSessionId,
      routeId: input.routeId,
      presetId: current.preset.id,
      changeSetId,
    })
    this.proposals.push(changeSet)
    return changeSet
  }

  async apply(request: BlueprintApplyChangeSetRequest): Promise<RemoteResult<BlueprintApplyChangeSetResult>> {
    const proposal = this.proposals.find(candidate => candidate.changeSetId === request.changeSetId
      && candidate.sourceSessionId === request.sourceSessionId && candidate.routeId === request.routeId)
    if (proposal === undefined) throw new Error('Apply lacks durable Proposal ownership')
    if (proposal.presetId !== request.presetId || proposal.revision !== request.baseRevision) {
      throw new Error('Apply target differs from durable Proposal')
    }
    expect(request.operations).toEqual(proposal.proposals.map(transactionOperation))
    this.applyRequests.push(request)
    const current = this.read(request.presetId)
    const revision = `r${String(++this.revision)}`
    const next: Blueprint = {
      ...current,
      revision,
      nodes: current.nodes.map((node) => {
        const operation = request.operations.find(candidate => candidate.targetNodeId === node.id)
        if (operation === undefined) return node
        if (operation.operation === 'setCapability') {
          if (typeof node.value !== 'object' || node.value === null || Array.isArray(node.value)) return node
          return { ...node, value: { ...node.value, enabled: operation.enabled } }
        }
        return { ...node, value: operation.value }
      }),
    }
    this.projections.set(request.presetId, next)
    const result: BlueprintApplyChangeSetResult = {
      sourceSessionId: request.sourceSessionId,
      routeId: request.routeId,
      changeSetId: request.changeSetId,
      baseRevision: request.baseRevision,
      committedRevision: revision,
      status: 'committed',
      operations: request.operations,
      preflight: { ok: true },
      unexpectedDrift: [],
    }
    const terminalSeq = this.append('blueprint/apply-result', {
      sourceSessionId: request.sourceSessionId,
      routeId: request.routeId,
      presetId: request.presetId,
      changeSetId: request.changeSetId,
    })
    const receipt: BlueprintApplyReceipt = {
      sourceSessionId: request.sourceSessionId,
      routeId: request.routeId,
      proposalResultSeq: this.proposalResultSeq(proposal),
      terminalSeq,
      presetId: request.presetId,
      result,
    }
    this.receipts.push(receipt)
    return ok(result)
  }

  async cancel(changeSet: BlueprintChangeSet): Promise<RemoteResult<BlueprintProposalCancellation>> {
    const durable = this.proposals.find(candidate => candidate.changeSetId === changeSet.changeSetId
      && candidate.sourceSessionId === changeSet.sourceSessionId && candidate.routeId === changeSet.routeId)
    if (durable === undefined) throw new Error('Cancel lacks durable Proposal ownership')
    const existing = this.cancellations.find(candidate => candidate.changeSetId === changeSet.changeSetId
      && candidate.sourceSessionId === changeSet.sourceSessionId && candidate.routeId === changeSet.routeId)
    if (existing !== undefined) return ok(existing)
    const cancellation: BlueprintProposalCancellation = {
      sourceSessionId: changeSet.sourceSessionId,
      routeId: changeSet.routeId,
      proposalResultSeq: this.proposalResultSeq(changeSet),
      changeSetId: changeSet.changeSetId,
      presetId: changeSet.presetId,
      baseRevision: changeSet.revision,
      status: 'cancelled',
    }
    this.cancellations.push(cancellation)
    this.append('blueprint/proposal-cancelled', {
      sourceSessionId: changeSet.sourceSessionId,
      routeId: changeSet.routeId,
      presetId: changeSet.presetId,
      changeSetId: changeSet.changeSetId,
    })
    return ok(cancellation)
  }

  startCapabilityConversation(handoff: BlueprintCapabilityHandoff): { sourceSessionId: string; sourceStartSeq: number } {
    this.append('blueprint/routing-input', {
      sourceSessionId: handoff.sourceSessionId,
      routeId: handoff.routeId,
      presetId: handoff.targetPresetId,
    })
    const sourceStartSeq = this.append('user/message', {
      sourceSessionId: handoff.sourceSessionId,
      routeId: handoff.routeId,
      presetId: handoff.targetPresetId,
    })
    return { sourceSessionId: handoff.sourceSessionId, sourceStartSeq }
  }

  startCapabilityAuthoring(route: BlueprintCapabilityAuthoringRoute, legacyWorker = false): {
    creatorSessionId?: string
    startSeq: number
    baselineDelegationRowIds: readonly string[]
  } {
    const sourceRouteSeq = this.events.findLast(event => event.type === 'blueprint/route-decision'
      && event.sourceSessionId === route.sourceSessionId && event.routeId === route.routeId)?.seq
    if (sourceRouteSeq === undefined) throw new Error('Capability authoring lacks its durable route decision')
    const legacyCreatorSessionId = legacyWorker
      ? `creator-${route.kind}-${String(++this.creatorCount)}`
      : undefined
    const executionSessionId = legacyCreatorSessionId ?? route.sourceSessionId
    const target = this.read(route.presetId)
    const baselineDelegationRowIds = target.runtime.delegations.map(row => row.rowId)
    const startSeq = this.append('blueprint/capability-authoring', {
      sourceSessionId: route.sourceSessionId,
      routeId: route.routeId,
      ...(legacyCreatorSessionId === undefined ? {} : { creatorSessionId: legacyCreatorSessionId }),
      presetId: route.presetId,
    })
    const record: CapabilityRecord = {
      routeId: route.routeId,
      sourceSessionId: route.sourceSessionId,
      targetPresetId: route.presetId,
      request: route.request,
      kind: route.kind,
      baseRevision: route.revision,
      startSeq,
      baselineDelegationRowIds,
      state: 'active',
    }
    this.capabilityRecords.set(executionSessionId, {
      executionSessionId,
      ...(legacyCreatorSessionId === undefined ? {} : { legacyCreatorSessionId }),
      sourceRouteSeq,
      waitingFor: null,
      record,
    })
    return {
      ...(legacyCreatorSessionId === undefined ? {} : { creatorSessionId: legacyCreatorSessionId }),
      startSeq,
      baselineDelegationRowIds,
    }
  }

  installCapability(kind: BlueprintCapabilityAuthoringKind, presetId: string): Blueprint {
    const current = this.read(presetId)
    const revision = `r${String(++this.revision)}`
    if (kind === 'skill') {
      const name = 'csv-competitor-summary'
      if (current.runtime.skills.some(skill => skill.name === name)) return current
      const next: Blueprint = {
        ...current,
        revision,
        nodes: [...current.nodes, {
          id: `capability:skill:${name}`,
          type: 'capability',
          value: { kind: 'skill', name, description: 'CSV 竞品数据结构化摘要', callable: true, scope: 'preset' },
          source: 'preset', status: 'active', editable: false, adapterRef: null,
        }],
        runtime: { ...current.runtime, skills: [...current.runtime.skills, {
          name,
          description: 'CSV 竞品数据结构化摘要',
          invocation: { modelInvocable: true, userInvocable: true },
          scope: 'preset', provider: 'local', source: 'preset', definitionDigest: 'a'.repeat(64),
        }] },
      }
      this.projections.set(presetId, next)
      return next
    }
    const rowId = 'market-positioning'
    if (current.runtime.delegations.some(row => row.rowId === rowId)) return current
    const delegation = {
      rowId, tool: 'market_positioning', provider: 'spawn', mode: 'one-shot' as const,
      providerAvailable: true, enabled: true,
      configDigest: '9d1eb8ab111984253a3cd5e26787d4521ac1eb7ace52eb9163152f970c4d2904',
    }
    const next: Blueprint = {
      ...current,
      revision,
      nodes: [...current.nodes, {
        id: `capability:delegation:${rowId}`,
        type: 'capability',
        value: {
          kind: 'delegation', displayLabel: '目标用户与市场定位协作',
          responsibility: '研究目标用户、市场定位和商业化方向。', enabled: true, providerAvailable: true,
        },
        source: 'preset', status: 'active', editable: false, adapterRef: null,
      }],
      runtime: { ...current.runtime, delegations: [...current.runtime.delegations, delegation] },
    }
    this.projections.set(presetId, next)
    return next
  }

  terminalCapability(
    executionSessionId: string,
    outcome: 'completed' | 'failed' | 'cancelled',
  ): StoredCapabilityRecord {
    const stored = this.capabilityRecords.get(executionSessionId)
    if (stored === undefined) throw new Error(`Unknown capability execution ${executionSessionId}`)
    if (outcome === 'completed') this.installCapability(stored.record.kind, stored.record.targetPresetId)
    const endSeq = this.append('blueprint/capability-authoring', {
      sourceSessionId: stored.record.sourceSessionId,
      routeId: stored.record.routeId,
      ...(stored.legacyCreatorSessionId === undefined
        ? {}
        : { creatorSessionId: stored.legacyCreatorSessionId }),
      presetId: stored.record.targetPresetId,
    })
    const record: CapabilityRecord = { ...stored.record, state: 'ended', endSeq, outcome }
    const terminal = { ...stored, record }
    this.capabilityRecords.set(executionSessionId, terminal)
    return terminal
  }

  setCapabilityWait(executionSessionId: string, waitingFor: BlueprintCapabilityObservation['waitingFor']): void {
    const stored = this.capabilityRecords.get(executionSessionId)
    if (stored === undefined) throw new Error(`Unknown capability execution ${executionSessionId}`)
    this.capabilityRecords.set(executionSessionId, { ...stored, waitingFor })
  }

  async createTrial(request: BlueprintTrialRequest): Promise<BlueprintSessionValidation> {
    this.trialRequests.push(request)
    const trialSessionId = sessionId(`trial-${String(++this.trialCount)}`)
    this.testSessionId = trialSessionId
    return await prepareBlueprintTrialSession(request, {
      create: async () => {
        this.trialSteps.push('create')
        this.append('session/created', { presetId: request.presetId })
        return { sessionId: trialSessionId, agentPreset: request.presetId }
      },
      waitUntilAddressable: async () => { this.trialSteps.push('addressable') },
      notePreset: () => { this.trialSteps.push('preset-noted') },
      installContext: async () => {
        this.trialSteps.push('context-installed')
        this.append('session/context-installed', { presetId: request.presetId })
      },
      mayOpen: () => true,
      open: () => {
        this.trialSteps.push('opened')
        this.append('session/opened', { presetId: request.presetId })
      },
      validate: async () => {
        this.trialSteps.push('validated')
        this.append('blueprint/session-validated', { presetId: request.presetId })
        return validation(trialSessionId, request.presetId, request.expectedRevision)
      },
    })
  }

  contextResult(request: BlueprintConversationContextRequest): BlueprintConversationContextResult {
    if (request.capabilityAuthoringEnd !== undefined) {
      this.terminalCapability(request.sessionId, request.capabilityAuthoringEnd.outcome)
    }
    const stored = this.capabilityRecords.get(request.sessionId)
    return {
      sessionId: request.sessionId,
      active: request.presetId !== undefined || stored?.record.state === 'active',
      applyReceipts: this.receipts.filter(receipt => receipt.sourceSessionId === request.sessionId),
      proposalCancellations: this.cancellations.filter(item => item.sourceSessionId === request.sessionId),
      ...(stored === undefined ? {} : { capabilityAuthoringRecord: stored.record }),
    }
  }

  private proposalResultSeq(changeSet: BlueprintChangeSet): number {
    const result = this.events.findLast(event => event.type === 'tool/result'
      && event.sourceSessionId === changeSet.sourceSessionId
      && event.routeId === changeSet.routeId
      && event.changeSetId === changeSet.changeSetId)
    if (result === undefined) throw new Error('Proposal result checkpoint is missing')
    return result.seq
  }
}

class ProductionInteractionDriver implements InteractionConformanceDriver {
  host = new ContractHost()
  controller = this.createController()
  foregroundSessionId: string | null = null
  runtimePresetId: string | null = null
  creationTask: CreationTask | null = null
  readonly targetPresetBySession = new Map<string, string>()

  async reset(): Promise<void> {
    this.host = new ContractHost()
    this.foregroundSessionId = null
    this.runtimePresetId = null
    this.creationTask = null
    this.targetPresetBySession.clear()
    this.controller = this.createController()
  }

  async activate(sessionId: string, runtimePresetId: string): Promise<void> {
    this.foregroundSessionId = sessionId
    this.runtimePresetId = runtimePresetId
    await this.controller.activateSession(sessionId, runtimePresetId)
    await this.restoreDurableSession(sessionId)
  }

  async refresh(): Promise<void> {
    const sessionId = this.foregroundSessionId
    const runtimePresetId = this.runtimePresetId
    this.controller = this.createController()
    if (sessionId !== null && runtimePresetId !== null) await this.activate(sessionId, runtimePresetId)
  }

  async readyExisting(sessionId = 'source-a'): Promise<void> {
    await this.activate(sessionId, 'cordis')
    await this.controller.selectPreset('competitive-research')
  }

  async beginCreation(waitingFor: BlueprintCreatorObservation['waitingFor'] = null): Promise<void> {
    const sourceSessionId = 'source-create'
    await this.activate(sourceSessionId, 'cordis')
    const route: BlueprintCreatorAuthoringRoute = {
      operation: 'create-agent',
      routeId: 'create-agent-route',
      request: '创建 AI 产品竞品研究 Agent',
      name: 'AI 产品竞品研究 Agent',
      sourceLanguage: 'zh',
    }
    this.host.append('blueprint/route-decision', { sourceSessionId, routeId: route.routeId })
    this.controller.beginCreatorAuthoringRoute(sourceSessionId, route)
    const creatorSessionId = 'creator-create-agent'
    const startSeq = this.host.append('blueprint/creator-authoring', {
      sourceSessionId, routeId: route.routeId, creatorSessionId,
    })
    this.creationTask = { sourceSessionId, creatorSessionId, startSeq, route }
    const authoring = { ...route, sourceSessionId, startSeq }
    expect(creatorAuthoringOwnsRoute(authoring, sessionId(sourceSessionId), route)).toBe(true)
    expect(creatorOwnsForeground(this.foregroundSessionId ?? undefined, sourceSessionId)).toBe(true)
    await this.controller.observeCreator({
      sessionId: creatorSessionId,
      presetId: 'cordis',
      running: true,
      waitingFor,
      lastTurnEnd: null,
      userMessages: [],
      presetCopies: [],
      associationAnswers: [],
      authoredPresets: [],
      validatedPresets: [],
      creatorAuthoring: authoring,
    })
  }

  async completeCreation(): Promise<void> {
    if (this.creationTask === null) await this.beginCreation()
    const task = this.creationTask!
    const created = this.host.addCreatedPreset()
    const validationSeq = this.host.append('tool/result', {
      sourceSessionId: task.sourceSessionId,
      routeId: task.route.routeId,
      creatorSessionId: task.creatorSessionId,
      presetId: created.preset.id,
    })
    const turnEndSeq = this.host.append('turn/end', {
      sourceSessionId: task.sourceSessionId,
      routeId: task.route.routeId,
      creatorSessionId: task.creatorSessionId,
      presetId: created.preset.id,
    })
    const terminal = {
      routeId: task.route.routeId,
      startSeq: task.startSeq,
      turnEndSeq,
      outcome: 'completed' as const,
      targetPresetId: created.preset.id,
      validationSeq,
    }
    this.host.append('blueprint/creator-authoring-ended', {
      sourceSessionId: task.sourceSessionId,
      routeId: task.route.routeId,
      creatorSessionId: task.creatorSessionId,
      presetId: created.preset.id,
    })
    await this.controller.observeCreator({
      sessionId: task.creatorSessionId,
      presetId: 'cordis',
      running: false,
      waitingFor: null,
      lastTurnEnd: { seq: turnEndSeq, reason: 'completed' },
      userMessages: [],
      presetCopies: [],
      associationAnswers: [],
      authoredPresets: [{ seq: validationSeq - 1, presetId: created.preset.id }],
      validatedPresets: [{ seq: validationSeq, presetId: created.preset.id }],
      creatorAuthoring: {
        ...task.route,
        sourceSessionId: task.sourceSessionId,
        startSeq: task.startSeq,
        terminal,
      },
    })
  }

  async createReady(): Promise<void> {
    await this.beginCreation()
    await this.completeCreation()
  }

  async editPurpose(value = '研究不同 AI 产品的能力、定价、目标用户与市场定位。'): Promise<BlueprintStructuredEditInput> {
    const state = this.controller.store.getSnapshot()
    const purpose = state.blueprint?.nodes.find(node => node.id === 'purpose:persona')
    if (purpose === undefined || typeof purpose.value !== 'string') throw new Error('Purpose is unavailable')
    const before = state.blueprint!.revision
    await this.controller.updateText(purpose.id, value, purpose.value)
    expect(this.controller.store.getSnapshot().blueprint?.revision).toBe(before)
    const input = this.host.structuredEdits.at(-1)
    if (input === undefined) throw new Error('Structured edit was not durably enqueued')
    return input
  }

  propose(input = this.host.structuredEdits.at(-1)): BlueprintChangeSet {
    if (input === undefined) throw new Error('No structured edit is available for Proposal')
    const changeSet = this.host.registerProposal(input)
    expect(blueprintProposalStatus(changeSet, this.controller.store.getSnapshot())).toBe('pending')
    return changeSet
  }

  async apply(changeSet = this.host.proposals.at(-1)): Promise<void> {
    if (changeSet === undefined) throw new Error('No Proposal is available to Apply')
    await this.controller.applyChangeSet(changeSet)
    this.controller.restoreApplyReceipts(
      changeSet.sourceSessionId,
      this.host.receipts.filter(receipt => receipt.sourceSessionId === changeSet.sourceSessionId),
    )
  }

  async cancel(changeSet = this.host.proposals.at(-1)): Promise<void> {
    if (changeSet === undefined) throw new Error('No Proposal is available to Cancel')
    await this.controller.cancelProposal(changeSet)
  }

  async beginAuthoring(
    kind: BlueprintCapabilityAuthoringKind,
    request = kind === 'skill' ? '创建 CSV 竞品数据处理 Skill' : '添加市场定位研究协作 Agent',
  ): Promise<BlueprintCapabilityHandoff> {
    await this.controller.beginCapabilityHandoff(request)
    const handoff = this.controller.store.getSnapshot().capabilityHandoff
    if (handoff === null) throw new Error('Capability handoff did not start')
    const route: BlueprintCapabilityAuthoringRoute = {
      routeId: handoff.routeId,
      sourceSessionId: handoff.sourceSessionId,
      presetId: handoff.targetPresetId,
      revision: handoff.revision,
      request,
      kind,
      reason: kind === 'skill' ? '需要可调用的 CSV 定义。' : '需要真实 delegation row。',
    }
    const sourceRouteSeq = this.host.append('blueprint/route-decision', {
      sourceSessionId: route.sourceSessionId,
      routeId: route.routeId,
      presetId: route.presetId,
    })
    this.host.append('turn/end', {
      sourceSessionId: route.sourceSessionId,
      routeId: route.routeId,
      presetId: route.presetId,
    })
    await this.controller.observeCapability({
      sessionId: handoff.sourceSessionId,
      running: false,
      stopped: false,
      waitingFor: null,
      lastTurnEnd: { seq: sourceRouteSeq + 1, reason: 'completed' },
      proposals: [],
      authoringRoutes: [{ seq: sourceRouteSeq, route }],
    })
    const current = this.controller.store.getSnapshot().capabilityHandoff
    if (current?.status !== 'authoring') {
      throw new Error('Capability authoring did not acquire an execution owner')
    }
    if (current.creatorSessionId !== undefined) {
      throw new Error('A Cordis source unexpectedly allocated a capability Creator Session')
    }
    return current
  }

  async settleAuthoring(
    outcome: 'completed' | 'failed' | 'cancelled',
    executionSessionId = this.capabilityExecutionSessionId(),
  ): Promise<void> {
    if (executionSessionId === undefined) throw new Error('No capability execution is active')
    const terminal = this.host.terminalCapability(executionSessionId, outcome)
    await this.controller.restoreTerminalCapabilityAuthoring(
      executionSessionId,
      terminal.record,
      terminal.sourceRouteSeq,
    )
  }

  async setAuthoringWait(waitingFor: 'question' | 'approval'): Promise<void> {
    const executionSessionId = this.capabilityExecutionSessionId()
    if (executionSessionId === undefined) throw new Error('No capability execution is active')
    this.host.setCapabilityWait(executionSessionId, waitingFor)
    const stored = this.host.capabilityRecords.get(executionSessionId)!
    await this.controller.restoreCapabilityAuthoring(
      executionSessionId,
      {
        routeId: stored.record.routeId,
        sourceSessionId: stored.record.sourceSessionId,
        targetPresetId: stored.record.targetPresetId,
        request: stored.record.request,
        kind: stored.record.kind,
        baseRevision: stored.record.baseRevision,
        startSeq: stored.record.startSeq,
        baselineDelegationRowIds: stored.record.baselineDelegationRowIds,
      },
      waitingFor,
      stored.sourceRouteSeq,
    )
  }

  async restoreLegacyBackgroundAuthoring(): Promise<BlueprintCapabilityHandoff> {
    await this.readyExisting('source-legacy')
    const projected = this.controller.store.getSnapshot().blueprint
    if (projected === null) throw new Error('Legacy recovery requires a projected target')
    const route: BlueprintCapabilityAuthoringRoute = {
      routeId: 'legacy-route',
      sourceSessionId: 'source-legacy',
      presetId: projected.preset.id,
      revision: projected.revision,
      request: '恢复旧版 CSV Skill 配置',
      kind: 'skill',
      reason: '兼容旧版 background Creator durable record。',
    }
    this.host.append('blueprint/route-decision', {
      sourceSessionId: route.sourceSessionId,
      routeId: route.routeId,
      presetId: route.presetId,
    })
    const started = this.host.startCapabilityAuthoring(route, true)
    if (started.creatorSessionId === undefined) throw new Error('Legacy fixture did not allocate its recorded worker')
    const stored = this.host.capabilityRecords.get(started.creatorSessionId)
    if (stored === undefined) throw new Error('Legacy fixture did not retain its durable record')
    await this.controller.restoreCapabilityAuthoring(
      stored.executionSessionId,
      {
        routeId: stored.record.routeId,
        sourceSessionId: stored.record.sourceSessionId,
        targetPresetId: stored.record.targetPresetId,
        request: stored.record.request,
        kind: stored.record.kind,
        baseRevision: stored.record.baseRevision,
        startSeq: stored.record.startSeq,
        baselineDelegationRowIds: stored.record.baselineDelegationRowIds,
      },
      stored.waitingFor,
      stored.sourceRouteSeq,
    )
    const handoff = this.controller.store.getSnapshot().capabilityHandoff
    if (handoff === null) throw new Error('Legacy durable record was not restored')
    return handoff
  }

  async startTrial(): Promise<void> {
    this.controller.openModal('try')
    await this.controller.startTrial()
  }

  appendFirstBusinessTurn(): void {
    if (this.host.testSessionId === null) throw new Error('Trial Session is not ready')
    this.host.trialSteps.push('first-business-turn')
    this.host.append('user/message', { sourceSessionId: this.host.testSessionId })
  }

  async reach(stage: InteractionConformanceStage): Promise<void> {
    switch (stage) {
      case 'idle': return
      case 'creating': await this.beginCreation(); return
      case 'waiting-input': await this.beginCreation('question'); return
      case 'waiting-approval': await this.beginCreation('approval'); return
      case 'ready': await this.createReady(); return
      case 'existing-agent-edit': await this.readyExisting(); await this.editPurpose(); return
      case 'proposal': await this.readyExisting(); await this.editPurpose(); this.propose(); return
      case 'apply': await this.readyExisting(); await this.editPurpose(); this.propose(); await this.apply(); return
      case 'capability-authoring': await this.readyExisting(); await this.beginAuthoring('skill'); return
      case 'skill': await this.readyExisting(); await this.beginAuthoring('skill'); await this.settleAuthoring('completed'); return
      case 'subagent': await this.readyExisting(); await this.beginAuthoring('subagent'); await this.settleAuthoring('completed'); return
      case 'test': await this.readyExisting(); await this.startTrial(); return
    }
  }

  async capture(stage: InteractionConformanceStage): Promise<InteractionConformanceCheckpoint> {
    const state = this.controller.store.getSnapshot()
    const proposal = this.host.proposals.at(-1)
    const proposalStatus = proposal === undefined ? null : blueprintProposalStatus(proposal, state)
    const pendingInteraction = state.creator?.waitingFor === 'question'
      || state.capabilityHandoff?.waitingFor === 'input' ? 'input'
      : state.creator?.waitingFor === 'approval' || state.capabilityHandoff?.waitingFor === 'approval'
        ? 'approval' : null
    const lifecycle = state.validation !== null
      ? 'trial:validated'
      : state.capabilityHandoff !== null
        ? `capability:${state.capabilityHandoff.status}`
        : state.creator !== null
          ? `creator:${state.creator.status}`
          : proposalStatus !== null
            ? `proposal:${proposalStatus}`
            : this.host.structuredEdits.length > 0 ? 'edit:queued' : state.phase
    return {
      stage,
      foregroundSessionId: this.foregroundSessionId,
      targetPresetId: state.blueprint?.preset.id ?? null,
      sessionEventTypes: this.host.events.map(event => event.type),
      pendingInteraction,
      lifecycle,
      blueprintRevision: state.blueprint?.revision ?? null,
      selectedNodeId: state.selectedNodeId,
      proposalIds: this.host.proposals.map(changeSet => changeSet.changeSetId),
      routeIds: distinctRoutes(this.host.events),
      capabilityAuthoring: state.capabilityHandoff?.authoringKind ?? null,
      testSessionId: this.host.testSessionId,
      visibleControls: visibleControls(state, proposalStatus),
    }
  }

  assertHealthy(expectedPresetCount = this.host.initialPresetCount): void {
    const state = this.controller.store.getSnapshot()
    expect(this.host.projections.size).toBe(expectedPresetCount)
    expect(new Set(this.host.projections.keys())).toEqual(new Set(this.host.agents.map(agent => agent.id)))
    if (state.selectedNodeId !== null) {
      expect(state.blueprint?.nodes.some(node => node.id === state.selectedNodeId)).toBe(true)
    }
    if (state.capabilityHandoff !== null) {
      expect(state.capabilityHandoff.sourceSessionId).toBe(this.foregroundSessionId)
      expect(state.capabilityHandoff.targetPresetId).toBe(state.blueprint?.preset.id)
    }
    if (state.creator !== null) expect(state.creator.sessionId).toBe(this.foregroundSessionId)
    expect(blueprintSessionLifecycleDiagnostic({
      ...(this.foregroundSessionId === null ? {} : { activeSessionId: this.foregroundSessionId }),
      ...(this.runtimePresetId === null ? {} : { runtimePresetId: this.runtimePresetId }),
      ...(state.blueprint === null ? {} : { targetPresetId: state.blueprint.preset.id }),
      ...(state.creator === null ? {} : { creatorSessionId: state.creator.sessionId }),
      stagedAuthoring: state.creator !== null || state.capabilityHandoff !== null,
      sessionOverride: this.foregroundSessionId !== null
        && this.targetPresetBySession.get(this.foregroundSessionId) === state.blueprint?.preset.id,
    })).toBeNull()
    for (const edit of this.host.structuredEdits) {
      expect(edit.sourceSessionId).not.toBe('')
      expect(edit.routeId).not.toBe('')
      expect(this.host.events.some(event => event.type === 'blueprint/routing-input'
        && event.sourceSessionId === edit.sourceSessionId && event.routeId === edit.routeId)).toBe(true)
      expect(this.host.events.some(event => event.type === 'user/message'
        && event.sourceSessionId === edit.sourceSessionId && event.routeId === edit.routeId)).toBe(true)
    }
    for (const changeSet of this.host.proposals) {
      expect(changeSet.sourceSessionId).not.toBe('')
      expect(changeSet.routeId).not.toBe('')
      expect(this.host.events.some(event => event.type === 'tool/result'
        && event.sourceSessionId === changeSet.sourceSessionId
        && event.routeId === changeSet.routeId
        && event.changeSetId === changeSet.changeSetId)).toBe(true)
      const terminals = this.host.receipts.filter(receipt => receipt.result.changeSetId === changeSet.changeSetId
        && receipt.sourceSessionId === changeSet.sourceSessionId && receipt.routeId === changeSet.routeId).length
        + this.host.cancellations.filter(item => item.changeSetId === changeSet.changeSetId
          && item.sourceSessionId === changeSet.sourceSessionId && item.routeId === changeSet.routeId).length
      expect(terminals).toBeLessThanOrEqual(1)
    }
    const creatorRoutes = [...this.host.capabilityRecords.values()].map(stored =>
      `${stored.record.sourceSessionId}:${stored.record.routeId}`)
    expect(new Set(creatorRoutes).size).toBe(creatorRoutes.length)
    expect(this.host.applyRequests).toHaveLength(this.host.receipts.length)
  }

  private createController(): BlueprintUiController {
    const remote: BlueprintRemote = {
      get: async ({ presetId }) => ok(this.host.read(presetId)),
      applyChangeSet: async request => await this.host.apply(request),
      setConversationContext: async request => ok(this.host.contextResult(request)),
    }
    return new BlueprintUiController(
      {
        list: async () => ({
          agents: structuredClone(this.host.agents),
          preferredPresetId: 'competitive-research',
        }),
      },
      remote,
      () => {},
      async (sessionId, projected, _selected, _creator, _userChange, directEditInput) => {
        if (directEditInput !== undefined) {
          if (sessionId === undefined) throw new Error('Structured edit has no source Session')
          if (projected === null) throw new Error('Structured edit has no projected Blueprint')
          this.host.publishStructuredEdit(sessionId, projected, directEditInput)
        }
      },
      async request => await this.host.createTrial(request),
      async handoff => this.host.startCapabilityConversation(handoff),
      async route => this.host.startCapabilityAuthoring(route),
      undefined,
      async (creatorSessionId) => {
        this.host.append('turn/cancelled', { creatorSessionId })
      },
      {
        read: sessionId => sessionId === undefined ? null : this.targetPresetBySession.get(sessionId) ?? null,
        write: (presetId, sessionId) => {
          if (sessionId !== undefined) this.targetPresetBySession.set(sessionId, presetId)
        },
        clear: (sessionId) => {
          if (sessionId !== undefined) this.targetPresetBySession.delete(sessionId)
        },
      },
      async changeSet => await this.host.cancel(changeSet),
    )
  }

  private async restoreDurableSession(sessionId: string): Promise<void> {
    this.controller.restoreApplyReceipts(
      sessionId,
      this.host.receipts.filter(receipt => receipt.sourceSessionId === sessionId),
    )
    this.controller.restoreProposalCancellations(
      sessionId,
      this.host.cancellations.filter(item => item.sourceSessionId === sessionId),
    )
    for (const stored of this.host.capabilityRecords.values()) {
      if (stored.record.sourceSessionId !== sessionId) continue
      if (stored.record.state === 'ended') {
        await this.controller.restoreTerminalCapabilityAuthoring(
          stored.executionSessionId,
          stored.record,
          stored.sourceRouteSeq,
        )
      } else {
        await this.controller.restoreCapabilityAuthoring(
          stored.executionSessionId,
          {
            routeId: stored.record.routeId,
            sourceSessionId: stored.record.sourceSessionId,
            targetPresetId: stored.record.targetPresetId,
            request: stored.record.request,
            kind: stored.record.kind,
            baseRevision: stored.record.baseRevision,
            startSeq: stored.record.startSeq,
            baselineDelegationRowIds: stored.record.baselineDelegationRowIds,
          },
          stored.waitingFor,
          stored.sourceRouteSeq,
        )
      }
    }
  }

  private capabilityExecutionSessionId(): string | undefined {
    const handoff = this.controller.store.getSnapshot().capabilityHandoff
    return handoff === null ? undefined : handoff.creatorSessionId ?? handoff.sourceSessionId
  }
}

function visibleControls(state: BlueprintUiState, proposalStatus: BlueprintProposalStatus | null): string[] {
  if (state.blueprint === null) return state.creator === null ? [] : ['creator-progress']
  const activeCapability = state.capabilityHandoff?.status === 'configuring'
    || state.capabilityHandoff?.status === 'authoring'
  const locked = state.creator?.status !== undefined && state.creator.status !== 'ready' || activeCapability
  const controls = [locked ? 'try-agent:locked' : 'try-agent']
  if (locked) controls.push('capability-progress')
  else controls.push('edit', 'add-capability')
  if (proposalStatus === 'pending') controls.push('apply', 'cancel')
  if (proposalStatus === 'locked') controls.push('proposal:locked')
  if (state.capabilityHandoff?.terminal !== undefined) controls.push('capability-terminal')
  if (state.validation !== null) controls.push('runtime-validation')
  return controls
}

function distinctRoutes(events: readonly DurableCheckpoint[]): string[] {
  return [...new Set(events.flatMap(event => event.routeId === undefined ? [] : [event.routeId]))]
}

const STAGE_CONTRACT: Record<InteractionConformanceStage, {
  lifecycle: string
  foregroundSessionId: string | null
  targetPresetId: string | null
  revision: string | null
  selectedNodeId: string | null
  pendingInteraction: 'input' | 'approval' | null
  capabilityAuthoring: BlueprintCapabilityAuthoringKind | null
  eventTypes: readonly string[]
  controls: readonly string[]
  presetCount: number
}> = {
  idle: {
    lifecycle: 'idle', foregroundSessionId: null, targetPresetId: null, revision: null,
    selectedNodeId: null, pendingInteraction: null, capabilityAuthoring: null,
    eventTypes: [], controls: [], presetCount: 2,
  },
  creating: {
    lifecycle: 'creator:creating', foregroundSessionId: 'source-create', targetPresetId: null, revision: null,
    selectedNodeId: null, pendingInteraction: null, capabilityAuthoring: null,
    eventTypes: ['blueprint/route-decision', 'blueprint/creator-authoring'], controls: ['creator-progress'], presetCount: 2,
  },
  'waiting-input': {
    lifecycle: 'creator:waiting', foregroundSessionId: 'source-create', targetPresetId: null, revision: null,
    selectedNodeId: null, pendingInteraction: 'input', capabilityAuthoring: null,
    eventTypes: ['blueprint/creator-authoring'], controls: ['creator-progress'], presetCount: 2,
  },
  'waiting-approval': {
    lifecycle: 'creator:waiting', foregroundSessionId: 'source-create', targetPresetId: null, revision: null,
    selectedNodeId: null, pendingInteraction: 'approval', capabilityAuthoring: null,
    eventTypes: ['blueprint/creator-authoring'], controls: ['creator-progress'], presetCount: 2,
  },
  ready: {
    lifecycle: 'creator:ready', foregroundSessionId: 'source-create', targetPresetId: 'ai-product-research', revision: 'created-r1',
    selectedNodeId: null, pendingInteraction: null, capabilityAuthoring: null,
    eventTypes: ['blueprint/creator-authoring-ended'], controls: ['try-agent', 'edit', 'add-capability'], presetCount: 3,
  },
  'existing-agent-edit': {
    lifecycle: 'edit:queued', foregroundSessionId: 'source-a', targetPresetId: 'competitive-research', revision: 'r1',
    selectedNodeId: 'purpose:persona', pendingInteraction: null, capabilityAuthoring: null,
    eventTypes: ['blueprint/routing-input', 'user/message'], controls: ['try-agent', 'edit', 'add-capability'], presetCount: 2,
  },
  proposal: {
    lifecycle: 'proposal:pending', foregroundSessionId: 'source-a', targetPresetId: 'competitive-research', revision: 'r1',
    selectedNodeId: 'purpose:persona', pendingInteraction: null, capabilityAuthoring: null,
    eventTypes: ['tool/call', 'blueprint/route-decision', 'tool/result'], controls: ['apply', 'cancel'], presetCount: 2,
  },
  apply: {
    lifecycle: 'proposal:applied', foregroundSessionId: 'source-a', targetPresetId: 'competitive-research', revision: 'r2',
    selectedNodeId: 'purpose:persona', pendingInteraction: null, capabilityAuthoring: null,
    eventTypes: ['blueprint/apply-result'], controls: ['try-agent', 'edit', 'add-capability'], presetCount: 2,
  },
  'capability-authoring': {
    lifecycle: 'capability:authoring', foregroundSessionId: 'source-a', targetPresetId: 'competitive-research', revision: 'r1',
    selectedNodeId: null, pendingInteraction: null, capabilityAuthoring: 'skill',
    eventTypes: ['blueprint/routing-input', 'blueprint/route-decision', 'blueprint/capability-authoring'], controls: ['capability-progress'], presetCount: 2,
  },
  skill: {
    lifecycle: 'capability:completed', foregroundSessionId: 'source-a', targetPresetId: 'competitive-research', revision: 'r2',
    selectedNodeId: null, pendingInteraction: null, capabilityAuthoring: 'skill',
    eventTypes: ['blueprint/capability-authoring'], controls: ['capability-terminal', 'try-agent'], presetCount: 2,
  },
  subagent: {
    lifecycle: 'capability:completed', foregroundSessionId: 'source-a', targetPresetId: 'competitive-research', revision: 'r2',
    selectedNodeId: null, pendingInteraction: null, capabilityAuthoring: 'subagent',
    eventTypes: ['blueprint/capability-authoring'], controls: ['capability-terminal', 'try-agent'], presetCount: 2,
  },
  test: {
    lifecycle: 'trial:validated', foregroundSessionId: 'source-a', targetPresetId: 'competitive-research', revision: 'r1',
    selectedNodeId: null, pendingInteraction: null, capabilityAuthoring: null,
    eventTypes: ['session/created', 'session/context-installed', 'session/opened', 'blueprint/session-validated'],
    controls: ['runtime-validation', 'try-agent'], presetCount: 2,
  },
}

describe('Interactive Blueprint lifecycle checkpoints', () => {
  expect(INTERACTION_CONFORMANCE_STAGES).toHaveLength(12)

  for (const stage of INTERACTION_CONFORMANCE_STAGES) {
    it(`${stage}: captures the production controller checkpoint`, async () => {
      const driver = new ProductionInteractionDriver()
      await driver.reach(stage)
      const checkpoint = await driver.capture(stage)
      const contract = STAGE_CONTRACT[stage]
      expect(checkpoint).toMatchObject({
        stage,
        foregroundSessionId: contract.foregroundSessionId,
        targetPresetId: contract.targetPresetId,
        lifecycle: contract.lifecycle,
        blueprintRevision: contract.revision,
        selectedNodeId: contract.selectedNodeId,
        pendingInteraction: contract.pendingInteraction,
        capabilityAuthoring: contract.capabilityAuthoring,
      })
      expect(checkpoint.sessionEventTypes).toEqual(expect.arrayContaining([...contract.eventTypes]))
      expect(checkpoint.visibleControls).toEqual(expect.arrayContaining([...contract.controls]))
      if (stage === 'proposal' || stage === 'apply') expect(checkpoint.proposalIds).toEqual(['proposal-1'])
      if (stage === 'test') expect(checkpoint.testSessionId).toBe('trial-1')
    })

    it(`${stage}: preserves owner, durable identity, target, and write isolation`, async () => {
      const driver = new ProductionInteractionDriver()
      await driver.reach(stage)
      driver.assertHealthy(STAGE_CONTRACT[stage].presetCount)
      const checkpoint = await driver.capture(stage)
      expect(checkpoint.routeIds.every(routeId => routeId.length > 0)).toBe(true)
      if (stage !== 'idle' && stage !== 'test') {
        expect(checkpoint.routeIds.length).toBeGreaterThan(0)
      }
      if (checkpoint.foregroundSessionId !== null && checkpoint.targetPresetId !== null) {
        expect(driver.controller.store.getSnapshot().blueprint?.preset.id).toBe(checkpoint.targetPresetId)
      }
      if (stage === 'existing-agent-edit' || stage === 'proposal') {
        expect(driver.host.applyRequests).toHaveLength(0)
        expect(checkpoint.blueprintRevision).toBe('r1')
      }
    })
  }
})

const MATRIX_SCENARIOS: readonly {
  name: string
  run: () => Promise<void>
}[] = [
  {
    name: '01 Create → Ready → Purpose edit → Cancel',
    run: async () => {
      const driver = new ProductionInteractionDriver()
      await driver.createReady()
      const committedRevision = driver.controller.store.getSnapshot().blueprint!.revision
      const changeSet = driver.propose(await driver.editPurpose())
      await driver.cancel(changeSet)
      expect(blueprintProposalStatus(changeSet, driver.controller.store.getSnapshot())).toBe('canceled')
      expect(driver.controller.store.getSnapshot().blueprint?.revision).toBe(committedRevision)
      expect(driver.host.applyRequests).toHaveLength(0)
      driver.assertHealthy(3)
    },
  },
  {
    name: '02 Purpose edit → Submit → Proposal pending → Apply',
    run: async () => {
      const driver = new ProductionInteractionDriver()
      await driver.readyExisting()
      const revision = driver.controller.store.getSnapshot().blueprint!.revision
      const changeSet = driver.propose(await driver.editPurpose())
      expect(driver.controller.store.getSnapshot().blueprint?.revision).toBe(revision)
      expect(blueprintProposalStatus(changeSet, driver.controller.store.getSnapshot())).toBe('pending')
      await driver.apply(changeSet)
      expect(blueprintProposalStatus(changeSet, driver.controller.store.getSnapshot())).toBe('applied')
      expect(driver.controller.store.getSnapshot().blueprint?.revision).not.toBe(revision)
      expect(driver.host.applyRequests).toHaveLength(1)
      driver.assertHealthy()
    },
  },
  {
    name: '03 Purpose Proposal pending → Session switch → return',
    run: async () => {
      const driver = new ProductionInteractionDriver()
      await driver.readyExisting('source-a')
      const changeSet = driver.propose(await driver.editPurpose())
      await driver.readyExisting('source-b')
      expect(driver.controller.store.getSnapshot().selectedNodeId).toBeNull()
      await driver.activate('source-a', 'cordis')
      expect(blueprintProposalStatus(changeSet, driver.controller.store.getSnapshot())).toBe('pending')
      expect(changeSet.sourceSessionId).toBe('source-a')
      expect(driver.host.applyRequests).toHaveLength(0)
      driver.assertHealthy()
    },
  },
  {
    name: '04 Purpose Proposal pending → Add Skill',
    run: async () => {
      const driver = new ProductionInteractionDriver()
      await driver.readyExisting()
      const changeSet = driver.propose(await driver.editPurpose())
      const proposalRoute = changeSet.routeId
      const handoff = await driver.beginAuthoring('skill')
      expect(handoff.routeId).not.toBe(proposalRoute)
      expect(blueprintProposalStatus(changeSet, driver.controller.store.getSnapshot())).toBe('locked')
      expect(driver.controller.store.getSnapshot().blueprint?.revision).toBe('r1')
      expect(driver.host.applyRequests).toHaveLength(0)
      driver.assertHealthy()
    },
  },
  {
    name: '05 Purpose Applied → Add Skill',
    run: async () => {
      const driver = new ProductionInteractionDriver()
      await driver.readyExisting()
      const changeSet = driver.propose(await driver.editPurpose())
      await driver.apply(changeSet)
      const revision = driver.controller.store.getSnapshot().blueprint!.revision
      const handoff = await driver.beginAuthoring('skill')
      expect(handoff.revision).toBe(revision)
      expect(handoff.sourceSessionId).toBe(changeSet.sourceSessionId)
      driver.assertHealthy()
    },
  },
  {
    name: '06 Add Skill authoring → Session switch → return',
    run: async () => {
      const driver = new ProductionInteractionDriver()
      await driver.readyExisting('source-a')
      const changeSet = driver.propose(await driver.editPurpose())
      await driver.apply(changeSet)
      const handoff = await driver.beginAuthoring('skill')
      await driver.readyExisting('source-b')
      expect(driver.controller.store.getSnapshot().capabilityHandoff).toBeNull()
      await driver.activate('source-a', 'cordis')
      expect(driver.controller.store.getSnapshot().capabilityHandoff).toMatchObject({
        sourceSessionId: 'source-a', routeId: handoff.routeId, status: 'authoring',
      })
      expect(driver.controller.store.getSnapshot().capabilityHandoff).not.toHaveProperty('creatorSessionId')
      expect(driver.controller.capabilityAuthoringSessionIds()).toEqual(['source-a'])
      expect(driver.controller.store.getSnapshot().applyReceiptsLoading).toBe(false)
      expect(blueprintProposalStatus(changeSet, driver.controller.store.getSnapshot())).toBe('applied')
      driver.assertHealthy()
    },
  },
  {
    name: '07 Add Skill completed → refresh',
    run: async () => {
      const driver = new ProductionInteractionDriver()
      await driver.readyExisting()
      await driver.beginAuthoring('skill')
      await driver.settleAuthoring('completed')
      await driver.refresh()
      expect(driver.controller.store.getSnapshot().capabilityHandoff).toMatchObject({
        authoringKind: 'skill', status: 'completed', terminal: { outcome: 'completed' },
      })
      expect(driver.controller.store.getSnapshot().capabilityHandoff).not.toHaveProperty('creatorSessionId')
      expect(driver.controller.store.getSnapshot().blueprint?.runtime.skills.map(skill => skill.name))
        .toEqual(['csv-competitor-summary'])
      driver.assertHealthy()
    },
  },
  {
    name: '08 Add Skill failed / cancelled → refresh',
    run: async () => {
      for (const outcome of ['failed', 'cancelled'] as const) {
        const driver = new ProductionInteractionDriver()
        await driver.readyExisting()
        await driver.beginAuthoring('skill')
        await driver.settleAuthoring(outcome)
        await driver.refresh()
        expect(driver.controller.store.getSnapshot().capabilityHandoff).toMatchObject({
          status: outcome, terminal: { outcome },
        })
        expect(driver.controller.store.getSnapshot().blueprint?.revision).toBe('r1')
        expect(driver.controller.store.getSnapshot().blueprint?.runtime.skills).toEqual([])
        driver.assertHealthy()
      }
    },
  },
  {
    name: '09 Add Skill completed → Add Subagent',
    run: async () => {
      const driver = new ProductionInteractionDriver()
      await driver.readyExisting()
      const skill = await driver.beginAuthoring('skill')
      await driver.settleAuthoring('completed')
      const subagent = await driver.beginAuthoring('subagent')
      expect(subagent.routeId).not.toBe(skill.routeId)
      expect(subagent.authoringKind).toBe('subagent')
      expect(skill).not.toHaveProperty('creatorSessionId')
      expect(subagent).not.toHaveProperty('creatorSessionId')
      expect(driver.host.events.filter(event => event.type === 'blueprint/capability-authoring'))
        .toHaveLength(3)
      expect(driver.controller.store.getSnapshot().blueprint?.runtime.skills).toHaveLength(1)
      expect(driver.host.projections.size).toBe(driver.host.initialPresetCount)
      driver.assertHealthy()
    },
  },
  {
    name: '10 Subagent authoring → waiting input / approval → refresh',
    run: async () => {
      const driver = new ProductionInteractionDriver()
      await driver.readyExisting()
      await driver.beginAuthoring('subagent')
      await driver.setAuthoringWait('question')
      await driver.refresh()
      expect(driver.controller.store.getSnapshot().capabilityHandoff?.waitingFor).toBe('input')
      await driver.setAuthoringWait('approval')
      await driver.refresh()
      expect(driver.controller.store.getSnapshot().capabilityHandoff?.waitingFor).toBe('approval')
      expect(driver.controller.store.getSnapshot().capabilityHandoff?.status).toBe('authoring')
      driver.assertHealthy()
    },
  },
  {
    name: '11 Subagent completed → refresh',
    run: async () => {
      const driver = new ProductionInteractionDriver()
      await driver.readyExisting()
      await driver.beginAuthoring('subagent')
      await driver.settleAuthoring('completed')
      await driver.refresh()
      expect(driver.controller.store.getSnapshot().capabilityHandoff).toMatchObject({
        authoringKind: 'subagent', status: 'completed', terminal: { outcome: 'completed' },
      })
      expect(driver.controller.store.getSnapshot().capabilityHandoff).not.toHaveProperty('creatorSessionId')
      expect(driver.controller.store.getSnapshot().blueprint?.runtime.delegations).toEqual([
        expect.objectContaining({ rowId: 'market-positioning', providerAvailable: true, enabled: true }),
      ])
      driver.assertHealthy()
    },
  },
  {
    name: '12 Subagent completed → Purpose edit',
    run: async () => {
      const driver = new ProductionInteractionDriver()
      await driver.readyExisting()
      await driver.beginAuthoring('subagent')
      await driver.settleAuthoring('completed')
      const revision = driver.controller.store.getSnapshot().blueprint!.revision
      const edit = await driver.editPurpose('加入目标用户与市场定位研究。')
      expect(edit.sourceSessionId).toBe('source-a')
      expect(driver.controller.store.getSnapshot().blueprint?.revision).toBe(revision)
      expect(driver.controller.store.getSnapshot().capabilityHandoff?.status).toBe('completed')
      driver.assertHealthy()
    },
  },
  {
    name: '13 Purpose edit → Add Capability → Purpose edit again',
    run: async () => {
      const driver = new ProductionInteractionDriver()
      await driver.readyExisting()
      const first = await driver.editPurpose()
      const changeSet = driver.propose(first)
      await driver.beginAuthoring('skill')
      await driver.controller.updateText(
        'purpose:persona',
        '第二次编辑不得穿过能力 authoring lock。',
        '比较 AI 产品的能力、定价与定位。',
      )
      expect(driver.host.structuredEdits).toHaveLength(1)
      expect(blueprintProposalStatus(changeSet, driver.controller.store.getSnapshot())).toBe('locked')
      expect(driver.controller.store.getSnapshot().blueprint?.revision).toBe('r1')
      driver.assertHealthy()
    },
  },
  {
    name: '14 Session A pending Proposal; Session B capability authoring → rapid switch A/B',
    run: async () => {
      const driver = new ProductionInteractionDriver()
      await driver.readyExisting('source-a')
      const changeSet = driver.propose(await driver.editPurpose())
      await driver.readyExisting('source-b')
      const handoff = await driver.beginAuthoring('skill')
      for (const source of ['source-a', 'source-b', 'source-a', 'source-b']) {
        await driver.activate(source, 'cordis')
        const state = driver.controller.store.getSnapshot()
        if (source === 'source-a') {
          expect(state.capabilityHandoff).toBeNull()
          expect(blueprintProposalStatus(changeSet, state)).toBe('pending')
        } else {
          expect(state.capabilityHandoff).toMatchObject({
            sourceSessionId: 'source-b', routeId: handoff.routeId, status: 'authoring',
          })
        }
      }
      expect(driver.controller.store.getSnapshot().capabilityHandoff?.sourceSessionId).toBe('source-b')
      driver.assertHealthy()
    },
  },
  {
    name: '15 Try Agent immediately after creation',
    run: async () => {
      const driver = new ProductionInteractionDriver()
      await driver.createReady()
      await driver.startTrial()
      expect(driver.host.trialRequests).toEqual([{
        presetId: 'ai-product-research', expectedRevision: 'created-r1',
      }])
      expect(driver.controller.store.getSnapshot().validation).toMatchObject({ valid: true, overall: 'pass' })
      expect(driver.host.testSessionId).toBe('trial-1')
      driver.assertHealthy(3)
    },
  },
  {
    name: '16 Try Agent immediately after Apply',
    run: async () => {
      const driver = new ProductionInteractionDriver()
      await driver.readyExisting()
      const changeSet = driver.propose(await driver.editPurpose())
      await driver.apply(changeSet)
      await driver.startTrial()
      expect(driver.host.trialRequests.at(-1)).toEqual({
        presetId: changeSet.presetId,
        expectedRevision: driver.controller.store.getSnapshot().blueprint?.revision,
        sourceSessionId: changeSet.sourceSessionId,
        routeId: changeSet.routeId,
        changeSetId: changeSet.changeSetId,
      })
      driver.assertHealthy()
    },
  },
  {
    name: '17 Try Agent after Skill/Subagent addition',
    run: async () => {
      const driver = new ProductionInteractionDriver()
      await driver.readyExisting()
      await driver.beginAuthoring('skill')
      await driver.settleAuthoring('completed')
      await driver.beginAuthoring('subagent')
      await driver.settleAuthoring('completed')
      const current = driver.controller.store.getSnapshot().blueprint!
      await driver.startTrial()
      expect(driver.host.trialRequests.at(-1)).toEqual({
        presetId: current.preset.id, expectedRevision: current.revision,
      })
      expect(current.runtime.skills).toHaveLength(1)
      expect(current.runtime.delegations).toHaveLength(1)
      expect(driver.controller.store.getSnapshot().validation?.valid).toBe(true)
      driver.assertHealthy()
    },
  },
  {
    name: '18 First business turn immediately after Trial Session creation',
    run: async () => {
      const driver = new ProductionInteractionDriver()
      await driver.readyExisting()
      await driver.startTrial()
      driver.appendFirstBusinessTurn()
      expect(driver.host.trialSteps).toEqual([
        'create', 'addressable', 'preset-noted', 'context-installed', 'opened', 'validated', 'first-business-turn',
      ])
      const context = driver.host.events.find(event => event.type === 'session/context-installed')!
      const business = driver.host.events.findLast(event => event.type === 'user/message')!
      expect(business.seq).toBeGreaterThan(context.seq)
      expect(business.sourceSessionId).toBe(driver.host.testSessionId)
      driver.assertHealthy()
    },
  },
  {
    name: '19 Refresh during pending Proposal',
    run: async () => {
      const driver = new ProductionInteractionDriver()
      await driver.readyExisting()
      const changeSet = driver.propose(await driver.editPurpose())
      const resultSeq = driver.host.events.findLast(event => event.type === 'tool/result')!.seq
      await driver.refresh()
      expect(blueprintProposalStatus(changeSet, driver.controller.store.getSnapshot())).toBe('pending')
      expect(driver.host.events.filter(event => event.type === 'tool/result')).toHaveLength(1)
      expect(driver.host.events.findLast(event => event.type === 'tool/result')?.seq).toBe(resultSeq)
      expect(driver.host.applyRequests).toHaveLength(0)
      driver.assertHealthy()
    },
  },
  {
    name: '20 Refresh after receipt Applied',
    run: async () => {
      const driver = new ProductionInteractionDriver()
      await driver.readyExisting()
      const proposedValue = '刷新后仍显示已提交的竞品研究目标。'
      const changeSet = driver.propose(await driver.editPurpose(proposedValue))
      await driver.apply(changeSet)
      await driver.refresh()
      expect(blueprintProposalStatus(changeSet, driver.controller.store.getSnapshot())).toBe('applied')
      expect(driver.controller.store.getSnapshot().applyReceipts).toHaveLength(1)
      expect(driver.controller.store.getSnapshot().blueprint?.nodes.find(node => node.id === 'purpose:persona')?.value)
        .toBe(proposedValue)
      expect(driver.host.events.filter(event => event.type === 'blueprint/apply-result')).toHaveLength(1)
      driver.assertHealthy()
    },
  },
]

describe('Interactive Blueprint 20-operation interaction matrix', () => {
  it.each(MATRIX_SCENARIOS)('$name', async ({ run }) => { await run() })
})

describe('capability authoring execution topology conformance', () => {
  it('durably cancels source-owned authoring without cancelling the Cordis source turn', async () => {
    const driver = new ProductionInteractionDriver()
    await driver.readyExisting()
    const handoff = await driver.beginAuthoring('skill')

    driver.controller.clearCapabilityHandoff()

    await vi.waitFor(() => {
      expect(driver.host.capabilityRecords.get(handoff.sourceSessionId)?.record).toMatchObject({
        routeId: handoff.routeId, state: 'ended', outcome: 'cancelled',
      })
    })
    expect(driver.host.events.filter(event => event.type === 'turn/cancelled')).toEqual([])
    await driver.refresh()
    expect(driver.controller.store.getSnapshot().capabilityHandoff).toMatchObject({
      sourceSessionId: handoff.sourceSessionId,
      routeId: handoff.routeId,
      status: 'cancelled',
      terminal: { outcome: 'cancelled' },
    })
    expect(driver.controller.store.getSnapshot().capabilityHandoff).not.toHaveProperty('creatorSessionId')
    driver.assertHealthy()
  })

  it('refresh-recovers an explicit legacy background-Creator durable record', async () => {
    const driver = new ProductionInteractionDriver()
    const handoff = await driver.restoreLegacyBackgroundAuthoring()
    const legacyCreatorSessionId = handoff.creatorSessionId
    if (legacyCreatorSessionId === undefined) throw new Error('Legacy recovery lost its Creator Session id')
    expect(legacyCreatorSessionId).toMatch(/^creator-skill-/)
    expect(driver.controller.capabilityAuthoringSessionIds()).toEqual([legacyCreatorSessionId])

    await driver.refresh()

    expect(driver.controller.store.getSnapshot().capabilityHandoff).toMatchObject({
      sourceSessionId: 'source-legacy',
      routeId: 'legacy-route',
      creatorSessionId: legacyCreatorSessionId,
      status: 'authoring',
    })
    expect(driver.controller.capabilityAuthoringSessionIds()).toEqual([legacyCreatorSessionId])
    driver.assertHealthy()
  })
})
