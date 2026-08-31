/** Interactive Blueprint projection and narrow write-back over real agent presets. */

import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import {
  AgentPresetTransactionNotFoundError,
  type AgentPreset,
  type AgentPresetProjectionSnapshot,
  type AgentPresetTransactionRecovery,
} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { JsonValue, SessionId } from '@deepseek-ai/dsh-session/types'
import { CallId, createUserMessage, freezeMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { defineTool, RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { canonicalJson } from './canonical-json.ts'
import {
  blueprintSourceLanguage,
  assertCapabilityCompositionDelta,
  type CapabilityCompositionDelta,
  compositionRevision,
  configuredBoolean,
  configuredWebFetch,
  hasUniqueTrimmedLine,
  parseComposition,
  personaText,
  projectDelegations,
  projectPersona,
} from './composition.ts'
import { executeBlueprintTransaction, stageBlueprintChangeSet } from './transaction.ts'
import { projectBehaviors } from './behavior.ts'
import { assertMountedDelegationReference } from './delegation-reference.ts'
import { applyBlueprintOperation, isOutputItem } from './writeback.ts'
import { validateRuntimeConformance } from './conformance.ts'
import { prepareCreatorHandoff, startExclusiveCreator, stopAcceptedCreatorRoute } from './creator-handoff.ts'
import { resolveDurableCapabilityAuthoring } from './capability-authority.ts'
import { creatorTerminalEvidence } from './creator-lifecycle.ts'
import { registerBlueprintSessionEventTypes } from './session-events.ts'
import {
  cleanupCapabilityCandidate,
  commitCapabilityCandidate,
  discardCapabilityCandidate,
  assertCapabilityPresetTreeDelta,
  fenceCapabilityCandidate,
  recoverCapabilityCandidate,
  resolveCapabilityCandidatePreset,
  type CapabilityCandidateTreeDelta,
} from './capability-candidate.ts'
import { blueprintRoutingInput, blueprintRoutingGuidance, selectBlueprintOperation } from './routing.ts'
import {
  assertBlueprintProposalForRoutingInput,
  BLUEPRINT_CONVERSATION_SECTION,
  BLUEPRINT_CAPABILITY_AUTHORING_TOOL,
  BLUEPRINT_CREATOR_AUTHORING_TOOL,
  BLUEPRINT_PROPOSAL_TOOL,
  blueprintConversationGuidance,
  blueprintChangeSetOperations,
  sameBlueprintChangeSetOperations,
  blueprintStructuredEditMessage,
  blueprintUserChangeForCurrentTurn,
  blueprintUserChangeMessage,
  capabilityAuthoringGuidance,
  createBlueprintCapabilityAuthoringRoute,
  createBlueprintCreatorAuthoringRoute,
  createBlueprintChangeSet,
  createBlueprintReconciliationChangeSet,
  createBlueprintStructuredEdit,
  createBlueprintStructuredEditChangeSet,
  createBlueprintUserChange,
  creatorAuthoringGuidance,
  parseBlueprintChangeSetArgs,
} from './proposal.ts'
import type {
  Blueprint,
  BlueprintApplyChangeSetRequest,
  BlueprintApplyChangeSetResult,
  BlueprintApplyReceipt,
  BlueprintBehaviorWrite,
  BlueprintCapabilityCandidate,
  BlueprintCapabilityCandidateDisposition,
  BlueprintCapabilityCancelRequestedEvent,
  BlueprintCapabilityRepairEvent,
  BlueprintCapabilityVerifiedEvent,
  BlueprintCapabilityPresetBaseline,
  BlueprintCapabilityWrite,
  BlueprintCapabilityAuthoringEvent,
  BlueprintCancelChangeSetRequest,
  BlueprintChangeSet,
  BlueprintConversationContextRequest,
  BlueprintConversationContextResult,
  BlueprintCreatorAuthoringEvent,
  BlueprintGetRequest,
  BlueprintIdentityWrite,
  BlueprintNode,
  BlueprintOutputWrite,
  BlueprintRuntimeSnapshot,
  BlueprintRuntimeSkill,
  BlueprintProposalCancellation,
  BlueprintSessionValidation,
  BlueprintTextWrite,
  BlueprintValidateSessionRequest,
} from '../contract/types.ts'

export type {
  Blueprint,
  BlueprintApplyChangeSetRequest,
  BlueprintApplyChangeSetResult,
  BlueprintApplyChangeSetStatus,
  BlueprintApplyReceipt,
  BlueprintApplyResultEvent,
  BlueprintCancelChangeSetRequest,
  BlueprintBehaviorWrite,
  BlueprintCapabilityCandidate,
  BlueprintCapabilityCandidateDisposition,
  BlueprintCapabilityCancelRequestedEvent,
  BlueprintCapabilityPresetBaseline,
  BlueprintCapabilityAuthoringKind,
  BlueprintCapabilityAuthoringRoute,
  BlueprintCapabilityVerifiedEvent,
  BlueprintCapabilityWrite,
  BlueprintChangeReceipt,
  BlueprintChangeSetCapabilityOperation,
  BlueprintChangeSetOperation,
  BlueprintChangeSetTextOperation,
  BlueprintChangeOperation,
  BlueprintChangeProposal,
  BlueprintChangeSet,
  BlueprintConformanceStatus,
  BlueprintConversationContextRequest,
  BlueprintConversationContextResult,
  BlueprintCreatorAuthoringEvent,
  BlueprintCreatorAuthoringRoute,
  BlueprintDelegationEvidence,
  BlueprintGetRequest,
  BlueprintIdentityWrite,
  BlueprintImpactCandidate,
  BlueprintImpactEvidence,
  BlueprintMappingGap,
  BlueprintNode,
  BlueprintNodeType,
  BlueprintPromptEvidence,
  BlueprintProposalValue,
  BlueprintProposalCancellation,
  BlueprintRuntimeSnapshot,
  BlueprintRuntimeDelegation,
  BlueprintRuntimeSkill,
  BlueprintSource,
  BlueprintStatus,
  BlueprintSessionValidation,
  BlueprintStructuredEdit,
  BlueprintStructuredEditInput,
  BlueprintSessionBindingEvidence,
  BlueprintSkillEvidence,
  BlueprintTextWrite,
  BlueprintToolEvidence,
  BlueprintUserChange,
  BlueprintUserChangeInput,
  BlueprintUserChangeOperation,
  BlueprintValidateSessionRequest,
} from '../contract/types.ts'
export {
  BLUEPRINT_CAPABILITY_AUTHORING_TOOL,
  BLUEPRINT_CREATOR_AUTHORING_TOOL,
  BLUEPRINT_CONVERSATION_SECTION,
  BLUEPRINT_PROPOSAL_TOOL,
  blueprintConversationGuidance,
  blueprintChangeSetOperations,
  blueprintStructuredEditMessage,
  blueprintNodeLabel,
  blueprintUserChangeForCurrentTurn,
  blueprintUserChangeMessage,
  capabilityAuthoringGuidance,
  createBlueprintCapabilityAuthoringRoute,
  createBlueprintCreatorAuthoringRoute,
  createBlueprintChangeProposal,
  createBlueprintChangeSet,
  createBlueprintReconciliationChangeSet,
  createBlueprintStructuredEdit,
  createBlueprintStructuredEditChangeSet,
  createBlueprintUserChange,
  hasExplicitBlueprintModificationIntent,
} from './proposal.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    blueprintAdapter: BlueprintAdapter
  }
}

interface ConversationBinding {
  agent: Agent
  mode: 'blueprint' | 'creator-authoring' | 'capability-authoring'
  presetId?: string
  revision?: string
  selectedNodeId?: string
  disposeContext: () => void
  disposeTools?: () => void
}

interface DeferredConversationClear {
  agent: Agent
  binding: ConversationBinding
  turn: number
}

interface ActiveCapabilityAuthoring {
  seq: number
  data: Extract<BlueprintCapabilityAuthoringEvent, { state: 'started' }>
}

interface CapabilityAuthoringRecord extends ActiveCapabilityAuthoring {
  endSeq?: number
  outcome?: 'completed' | 'failed' | 'cancelled'
  explicitlyEnded: boolean
  terminal?: Extract<BlueprintCapabilityAuthoringEvent, { state: 'ended' }>
}

type CapabilityAuthoringTerminal = Extract<BlueprintCapabilityAuthoringEvent, { state: 'ended' }>

interface CapabilityAuthoringSettlement {
  record: CapabilityAuthoringRecord
  end: Extract<SessionEvent, { type: 'turn/end' }>
}

interface CapabilityAuthoringTerminalEvidence {
  skillEvidence?: CapabilityAuthoringTerminal['skillEvidence']
  subagentEvidence?: CapabilityAuthoringTerminal['subagentEvidence']
  capabilityFailure?: CapabilityAuthoringTerminal['capabilityFailure']
  candidateDisposition?: BlueprintCapabilityCandidateDisposition
}

interface CapabilityVerificationFailure {
  prerequisite: Exclude<NonNullable<CapabilityAuthoringTerminal['capabilityFailure']>['prerequisite'], 'cancelled'>
  message: string
}

interface CapabilityRepairRecord {
  seq: number
  data: BlueprintCapabilityRepairEvent
}

interface CapabilityMessageDelivery {
  state: 'pending' | 'claimed' | 'cancelled'
  claimSeq?: number
  turn?: number
}

interface CapabilityCancelRequestedRecord {
  seq: number
  data: BlueprintCapabilityCancelRequestedEvent
}

interface CapabilityVerifiedRecord {
  seq: number
  data: BlueprintCapabilityVerifiedEvent
}

interface VerifiedCapabilityCandidate {
  evidence: CapabilityAuthoringTerminalEvidence
  candidateTreeDigest: string
}

class CapabilityVerificationError extends Error {
  constructor(readonly failure: CapabilityVerificationFailure) {
    super(failure.message)
    this.name = 'CapabilityVerificationError'
  }
}

function capabilityAuthoringRecords(agent: Agent): CapabilityAuthoringRecord[] {
  return agent.session.events.flatMap<CapabilityAuthoringRecord>((started) => {
    if (started.type !== 'blueprint/capability-authoring' || started.data.state !== 'started') return []
    const ended = agent.session.events.find(event => event.seq > started.seq
      && event.type === 'blueprint/capability-authoring'
      && event.data.state === 'ended' && event.data.startSeq === started.seq)
    if (ended?.type === 'blueprint/capability-authoring' && ended.data.state === 'ended') {
      return [{
        seq: started.seq, data: started.data, endSeq: ended.seq,
        outcome: ended.data.outcome, explicitlyEnded: true,
        terminal: ended.data,
      }]
    }
    return [{ seq: started.seq, data: started.data, explicitlyEnded: false }]
  })
}

function latestCapabilityAuthoringRecord(agent: Agent): CapabilityAuthoringRecord | undefined {
  return capabilityAuthoringRecords(agent).at(-1)
}

function activeCapabilityAuthoring(agent: Agent): ActiveCapabilityAuthoring | undefined {
  const record = latestCapabilityAuthoringRecord(agent)
  return record?.outcome === undefined ? record : undefined
}

function latestCreatorAuthoring(agent: Agent): {
  seq: number
  data: BlueprintCreatorAuthoringEvent
} | undefined {
  const event = agent.session.events.findLast(candidate => candidate.type === 'blueprint/creator-authoring'
    && (candidate.data.handoff === undefined || candidate.data.handoff.targetCreatorSessionId === agent.session.id))
  if (event?.type !== 'blueprint/creator-authoring') return undefined
  const sourceLanguage = (event.data.sourceLanguage ?? event.data.language)?.trim()
  return {
    seq: event.seq,
    data: {
      operation: event.data.operation,
      routeId: event.data.routeId,
      sourceSessionId: event.data.sourceSessionId,
      request: event.data.request,
      name: event.data.name,
      ...(sourceLanguage === undefined ? {} : { sourceLanguage }),
      ...(event.data.handoff === undefined ? {} : { handoff: event.data.handoff }),
    },
  }
}

function sameCreatorAuthoring(
  left: BlueprintCreatorAuthoringEvent,
  right: BlueprintCreatorAuthoringEvent,
): boolean {
  return left.routeId === right.routeId
    && left.sourceSessionId === right.sourceSessionId
    && left.request === right.request
    && left.name === right.name
    && left.sourceLanguage === right.sourceLanguage
    && left.handoff?.sourceTurn === right.handoff?.sourceTurn
    && left.handoff?.targetCreatorSessionId === right.handoff?.targetCreatorSessionId
}

function capabilityAuthoringResultRecord(record: CapabilityAuthoringRecord): NonNullable<
  BlueprintConversationContextResult['capabilityAuthoringRecord']
> {
  const terminal = record.outcome === undefined || record.endSeq === undefined
    ? {}
    : { endSeq: record.endSeq, outcome: record.outcome }
  return {
    routeId: record.data.routeId,
    sourceSessionId: record.data.sourceSessionId,
    targetPresetId: record.data.targetPresetId,
    request: record.data.request,
    kind: record.data.kind,
    baseRevision: record.data.baseRevision,
    startSeq: record.seq,
    baselineDelegationRowIds: record.data.baselineDelegations.map(row => row.rowId),
    state: record.outcome === undefined ? 'active' : 'ended',
    ...terminal,
    ...(record.terminal?.skillEvidence === undefined ? {} : { skillEvidence: record.terminal.skillEvidence }),
    ...(record.terminal?.subagentEvidence === undefined ? {} : { subagentEvidence: record.terminal.subagentEvidence }),
  }
}

function sameCapabilityAuthoring(
  left: Pick<BlueprintCapabilityAuthoringEvent, 'routeId' | 'sourceSessionId' | 'targetPresetId' | 'request' | 'kind' | 'baseRevision'>,
  right: NonNullable<BlueprintConversationContextRequest['capabilityAuthoring']>,
): boolean {
  return left.routeId === right.routeId && left.sourceSessionId === right.sourceSessionId
    && left.targetPresetId === right.targetPresetId && left.request === right.request && left.kind === right.kind
    && left.baseRevision === right.baseRevision
}

function capabilityPresetBaseline(
  preset: AgentPreset,
  compositionDigest: string | null,
): BlueprintCapabilityPresetBaseline {
  return {
    id: preset.id,
    trust: preset.trust,
    ...(preset.name === undefined ? {} : { name: preset.name }),
    ...(preset.description === undefined ? {} : { description: preset.description }),
    ...(preset.order === undefined ? {} : { order: preset.order }),
    ...(preset.broken === undefined ? {} : { broken: preset.broken }),
    compositionDigest,
  }
}

function exactAdditions<T>(
  baseline: readonly T[],
  current: readonly T[],
  identity: (value: T) => string,
  label: string,
): T[] {
  const baselineById = new Map(baseline.map(value => [identity(value), value]))
  const currentById = new Map(current.map(value => [identity(value), value]))
  if (baselineById.size !== baseline.length || currentById.size !== current.length) {
    throw new Error(`capability authoring ${label} identities must remain unique`)
  }
  for (const [id, expected] of baselineById) {
    if (canonicalJson(currentById.get(id)) !== canonicalJson(expected)) {
      throw new Error(`capability authoring changed or removed existing ${label} ${JSON.stringify(id)}`)
    }
  }
  return current.filter(value => !baselineById.has(identity(value)))
}

function isRecoverableCapabilityInterruption(reason: Extract<SessionEvent, { type: 'turn/end' }>['data']['reason']): boolean {
  return reason.kind === 'interrupted'
    || (reason.kind === 'aborted' && reason.reason.kind === 'disposed')
}

function capabilityAuthoringWakeMessageId(record: ActiveCapabilityAuthoring): MessageId {
  return MessageId(`blueprint-capability:${createHash('sha256')
    .update(JSON.stringify([record.data.sourceSessionId, record.data.routeId, record.seq])).digest('hex')}`)
}

function capabilityAuthoringTerminalMessageId(record: CapabilityAuthoringRecord, turn: number): MessageId {
  return MessageId(`blueprint-history:${createHash('sha256')
    .update(JSON.stringify([record.data.sourceSessionId, record.data.routeId, record.seq, turn])).digest('hex')}`)
}

function capabilityMessageDelivery(
  events: readonly SessionEvent[],
  id: MessageId,
): CapabilityMessageDelivery | undefined {
  const pending: Record<'next-turn' | 'next-step', MessageId[]> = { 'next-turn': [], 'next-step': [] }
  let openTurn: number | undefined
  let delivery: CapabilityMessageDelivery | undefined
  for (const event of events) {
    if (event.type === 'turn/start') {
      openTurn = event.data.turn
      continue
    }
    if (event.type === 'turn/end') {
      if (openTurn === event.data.turn) openTurn = undefined
      continue
    }
    if (event.type !== 'agent/inbox/spliced') continue
    const inbox = pending[event.data.target]
    const removed = inbox.splice(
      event.data.start,
      event.data.removedCount ?? 0,
      ...event.data.inserted.map(message => message.id),
    )
    if (removed.includes(id)) {
      delivery = event.data.outcome === 'canceled'
        ? { state: 'cancelled' }
        : { state: 'claimed', claimSeq: event.seq, ...(openTurn === undefined ? {} : { turn: openTurn }) }
    }
    if (event.data.inserted.some(message => message.id === id)) delivery = { state: 'pending' }
  }
  return delivery
}

/** Whether one exact Add capability input owns the currently open routing turn. */
function activeCapabilityRoutingTurn(agent: Agent): boolean {
  const events = agent.session.events
  const start = events.findLast(event => event.type === 'turn/start')
  if (start?.type !== 'turn/start'
    || events.some(event => event.type === 'turn/end' && event.data.turn === start.data.turn)) return false
  return events.some((event) => {
    if (event.type !== 'blueprint/routing-input' || event.data.uiAction !== 'add-capability'
      || event.data.sourceSessionId !== agent.session.id) return false
    const delivery = capabilityMessageDelivery(events, event.data.messageId)
    return delivery?.state === 'claimed' && delivery.turn === start.data.turn
  })
}

/** Optional live agent whose exact assembly and permissions the adapter reads. */
export interface BlueprintReadOptions {
  /** Agent already composed from the requested preset. */
  agent?: Agent
  /** Workspace used by filesystem-backed Skill providers. */
  cwd?: string
}

const DEFAULT_CAPABILITY_REPAIR_ATTEMPTS = 2

/** Runtime policy for background capability repair. */
export interface Config {
  /** Additional Creator turns allowed after internal candidate verification misses. */
  capabilityRepairAttempts?: number
}

/** Project and narrowly edit real agent presets for Interactive Blueprint. */
export class BlueprintAdapter extends TypertRemoteService {
  static inject = ['agentPresets', 'systemPrompt', 'agents', 'sessions', 'tools', 'skills', 'subagents']
  static Config: z<Config> = z.object({
    capabilityRepairAttempts: z.number().step(1).min(0).default(DEFAULT_CAPABILITY_REPAIR_ATTEMPTS),
  })

  private readonly conversationBindings = new Map<string, ConversationBinding>()
  private readonly deferredConversationClears = new Map<string, DeferredConversationClear>()
  private readonly conversationUpdates = new Map<string, Promise<BlueprintConversationContextResult>>()
  private readonly presetUpdates = new Map<string, Promise<unknown>>()
  private readonly capabilityTargetOwners = new Map<string, string>()
  private readonly capabilityCandidateOverlays = new Map<string, { agent: Agent; dispose: () => Promise<void> }>()
  private readonly capabilityRoutingGuards = new Map<Agent, () => void>()

  constructor(ctx: Context, public config: Config = {}) {
    super(ctx, 'blueprintAdapter', { namespace: 'blueprint' })
    ctx.effect(
      () => registerBlueprintSessionEventTypes(ctx),
      'blueprint-adapter: durable Session event vocabulary',
    )
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return
      const sessionId = String(session.id)
      const deferred = this.deferredConversationClears.get(sessionId)
      if (deferred === undefined || deferred.agent.session !== session || deferred.turn !== event.data.turn) return
      this.deferredConversationClears.delete(sessionId)
      if (this.conversationBindings.get(sessionId) === deferred.binding) {
        this.clearConversationBinding(sessionId, deferred.agent, 'blueprint')
      }
    }, { global: true })
    ctx.on('session/event', (session, event) => { stopAcceptedCreatorRoute(ctx, session, event) }, { global: true })
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return
      const agent = ctx.agents.get(session.id)
      const task = agent === undefined ? undefined : latestCreatorAuthoring(agent)
      if (agent === undefined || task === undefined || activeCapabilityAuthoring(agent) !== undefined
        || session.events.some(candidate => candidate.type === 'blueprint/creator-authoring-ended'
          && candidate.data.startSeq === task.seq)) return
      void this.setConversationContext({ sessionId: String(session.id), recoverCreatorAuthoring: true })
        .catch((error: unknown) => {
          ctx.logger.warn(`Creator task ${String(session.id)} terminalization failed: ${String(error)}`)
        })
    }, { global: true })
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return
      const agent = ctx.agents.get(session.id)
      if (agent === undefined) return
      const settlement = this.capabilityAuthoringSettlement(agent)
      if (settlement?.end.seq !== event.seq) return
      void agent.whenIdle()
        .then(() => agent.runMaintenance(async () => {
          await this.setConversationContext({ sessionId: String(session.id), recoverCapabilityAuthoring: true })
        }))
        .catch((error: unknown) => {
          ctx.logger.warn(`Capability authoring ${String(session.id)} settlement failed: ${String(error)}`)
        })
    }, { global: true })
    ctx.on('agent/disposed', ({ agent }) => {
      const disposeRoutingGuard = this.capabilityRoutingGuards.get(agent)
      this.capabilityRoutingGuards.delete(agent)
      disposeRoutingGuard?.()
      this.clearConversationBinding(String(agent.session.id), agent)
      void this.clearCapabilityCandidateOverlay(String(agent.session.id), agent)
        .catch((error: unknown) => {
          ctx.logger.warn(`Capability candidate overlay cleanup failed: ${String(error)}`)
        })
    })
    ctx.effect(() => () => {
      for (const sessionId of [...this.conversationBindings.keys()]) this.clearConversationBinding(sessionId)
      this.deferredConversationClears.clear()
      for (const sessionId of [...this.capabilityCandidateOverlays.keys()]) {
        void this.clearCapabilityCandidateOverlay(sessionId)
          .catch((error: unknown) => {
            ctx.logger.warn(`Capability candidate overlay cleanup failed: ${String(error)}`)
          })
      }
      for (const disposeRoutingGuard of this.capabilityRoutingGuards.values()) disposeRoutingGuard()
      this.capabilityRoutingGuards.clear()
      this.capabilityTargetOwners.clear()
    }, 'blueprint-adapter: conversation and candidate bindings')
  }

  /**
   * Project one preset through the Host Remote API.
   * @param request - preset identity.
   * @returns one freshly assembled Blueprint.
   */
  @Remote('get')
  async get(request: BlueprintGetRequest): Promise<Blueprint> {
    return await this.read(request.presetId)
  }

  /**
   * Project preset text, its mounted runtime assembly, and effective permissions.
   * @param presetId - preset resolved by the real roster.
   * @param options - optional live agent for session-specific assembly and access.
   * @returns one JSON-serializable Blueprint.
   */
  async read(presetId: string, options: BlueprintReadOptions = {}): Promise<Blueprint> {
    if (options.agent === undefined) {
      const snapshot = await this.ctx.agentPresets.projectionSnapshot(presetId)
      return await this.project(snapshot.preset, snapshot.composition, options, snapshot.standingKey)
    }
    const preset = await this.ctx.agentPresets.resolve(presetId)
    if (preset.broken !== undefined) throw new Error(`blueprint-adapter: preset ${JSON.stringify(presetId)} is broken: ${preset.broken}`)
    const composition = await this.ctx.agentPresets.read(presetId)
    return await this.project(preset, composition, options)
  }

  /** Project one exact composition together with its standing or live assembly. */
  private async project(
    preset: AgentPreset,
    composition: string,
    options: BlueprintReadOptions = {},
    standingKey?: AgentPresetProjectionSnapshot['standingKey'],
  ): Promise<Blueprint> {
    const rows = parseComposition(composition)
    const text = personaText(rows)
    const persona = projectPersona(text)
    const writable = preset.trust === 'user'
    const behaviors = projectBehaviors(text, persona.items, composition, writable)
    const assembly = await this.assembly(preset.id, options.agent, standingKey)
    const toolNames = assembly.tools.map(tool => tool.name).filter(name => name !== BLUEPRINT_PROPOSAL_TOOL)
    const toolNameSet = new Set(toolNames)
    const outputOrdinals = new Set(persona.items.filter(item => isOutputItem(item.text)).map(item => item.ordinal))
    const nodes: BlueprintNode[] = []

    if (persona.identity !== undefined) {
      const editable = writable
        && persona.identity.editable
        && persona.identity.writebackMethod === 'replace-role-span'
        && persona.identity.prefix !== undefined
        && persona.identity.suffix !== undefined
        && hasUniqueTrimmedLine(composition, persona.identity.sourceValue)
      nodes.push({
        id: 'identity:persona', type: 'identity', value: persona.identity.displayValue,
        source: persona.identity.source, status: 'active',
        editable, adapterRef: editable ? 'preset:persona.config.text#identity' : null,
      })
    }
    if (persona.purpose !== undefined) {
      const editable = writable
        && persona.purpose.editable
        && persona.purpose.writebackMethod === 'replace-purpose-span'
        && persona.purpose.prefix !== undefined
        && persona.purpose.suffix !== undefined
        && hasUniqueTrimmedLine(composition, persona.purpose.sourceValue)
      nodes.push({
        id: 'purpose:persona', type: 'purpose', value: persona.purpose.displayValue,
        source: persona.purpose.source, status: 'active',
        editable, adapterRef: editable ? 'preset:persona.config.text#purpose' : null,
      })
    }
    if (persona.output !== undefined) {
      nodes.push({
        id: 'output:persona', type: 'output', value: persona.output.displayValue,
        source: persona.output.source, status: 'active', editable: false, adapterRef: null,
      })
    }
    for (const item of persona.items) {
      const output = outputOrdinals.has(item.ordinal)
      if (!output) {
        const behavior = behaviors.nodes.find(node => node.id === `behavior:${String(item.ordinal)}`)
        if (behavior !== undefined && !nodes.includes(behavior)) nodes.push(behavior)
        continue
      }
      const editable = writable && hasUniqueTrimmedLine(composition, item.paragraph)
      nodes.push({
        id: `output:${String(item.ordinal)}`,
        type: 'output',
        value: item.text,
        source: 'inferred',
        status: 'active',
        editable,
        adapterRef: editable
          ? `preset:persona.config.text#output:${String(item.ordinal)}`
          : null,
      })
    }
    nodes.push(...behaviors.nodes.filter(node => !nodes.includes(node)))

    const configuredSearch = configuredBoolean(rows, 'tool-web', 'search', true)
    const runtimeSearch = toolNames.includes('web_search')
    if (configuredSearch !== undefined || runtimeSearch) {
      nodes.push({
        id: 'capability:web-search',
        type: 'capability',
        value: { name: 'Web Search', tool: 'web_search', enabled: runtimeSearch },
        source: runtimeSearch ? 'runtime' : 'preset',
        status: runtimeSearch ? 'active' : 'inactive',
        editable: writable && configuredSearch !== undefined,
        adapterRef: writable && configuredSearch !== undefined ? 'preset:tool-web.config.search' : null,
      })
    }
    const configuredFetch = configuredWebFetch(rows)
    const runtimeFetch = toolNames.includes('web_fetch')
    if (configuredFetch !== undefined || runtimeFetch) {
      nodes.push({
        id: 'capability:web-fetch',
        type: 'capability',
        value: { name: 'Web Fetch', tool: 'web_fetch', enabled: runtimeFetch },
        source: runtimeFetch ? 'runtime' : 'preset',
        status: runtimeFetch ? 'active' : 'inactive',
        editable: writable && configuredFetch !== undefined,
        adapterRef: writable && configuredFetch !== undefined ? 'preset:tool-web.config.fetch' : null,
      })
    }
    if (toolNames.includes('read')) {
      nodes.push({
        id: 'capability:file-read',
        type: 'capability',
        value: { name: 'File Read', tool: 'read', enabled: true },
        source: 'runtime',
        status: 'active',
        editable: false,
        adapterRef: null,
      })
    }

    const cwd = options.cwd ?? options.agent?.session.header.cwd ?? process.cwd()
    const skillProjection = await this.skillProjection(preset.id, cwd, options.agent, standingKey)
    nodes.push(...skillProjection.nodes)
    const delegationProjection = projectDelegations(
      rows,
      toolNameSet,
      new Set(this.ctx.subagents.list()),
    )
    for (const delegation of delegationProjection.delegations) {
      nodes.push({
        id: `capability:delegation:${delegation.rowId}`,
        type: 'capability',
        value: {
          kind: 'delegation',
          name: delegationName(delegation.tool),
          tool: delegation.tool,
          provider: delegation.provider,
          mode: delegation.mode,
          providerAvailable: delegation.providerAvailable,
          enabled: delegation.enabled,
          ...(delegation.persona === undefined ? {} : { responsibility: delegation.persona }),
        },
        source: 'preset',
        status: delegation.enabled ? 'active' : 'inactive',
        editable: false,
        adapterRef: null,
      })
    }

    const permissions = this.permissions(options.agent)
    if (permissions !== null) {
      nodes.push({
        id: 'access:permission-preset',
        type: 'access',
        value: permissions,
        source: 'inherited',
        status: 'active',
        editable: false,
        adapterRef: options.agent === undefined
          ? 'runtime:permissionPresets.defaultPreset'
          : 'session:permission/preset',
      })
    }

    const sourceLanguage = blueprintSourceLanguage(persona.identity, preset.name, preset.description)
    return {
      schemaVersion: 1,
      ...(sourceLanguage === undefined ? {} : { sourceLanguage }),
      preset: {
        id: preset.id,
        trust: preset.trust,
        ...(preset.name === undefined ? {} : { name: preset.name }),
        ...(preset.description === undefined ? {} : { description: preset.description }),
      },
      revision: compositionRevision(composition),
      nodes,
      runtime: {
        tools: toolNames,
        promptSections: assembly.sections.map(section => section.name)
          .filter(name => name !== BLUEPRINT_CONVERSATION_SECTION),
        skills: skillProjection.runtime,
        delegations: delegationProjection.delegations.map(delegation => ({
          rowId: delegation.rowId,
          tool: delegation.tool,
          provider: delegation.provider,
          mode: delegation.mode,
          configDigest: delegation.configDigest,
          providerAvailable: delegation.providerAvailable,
          enabled: delegation.enabled,
        })),
        permissions,
      },
      mappingGaps: [
        ...behaviors.gaps,
        {
          field: 'identity',
          reason: persona.identity?.editable === true
            ? 'Identity is projected from one deterministic semantic role span and writes preserve the surrounding persona text.'
            : 'Legacy persona prose supplies a user-level role only when a deterministic role clause exists; ambiguous clauses remain readable without direct write-back.',
        },
        {
          field: 'persona semantics',
          reason: 'Purpose uses an explicit semantic task line when present and otherwise a deterministic persona clause or safe legacy paragraph. A standalone explicit Output line is readable; only a uniquely numbered Output item uses the current typed write address.',
        },
        {
          field: 'runtime capability ownership',
          reason: 'Most tool schemas prove runtime visibility but do not identify one preset row that can be safely changed; this adapter writes only tool-web.config.search and tool-web.config.fetch.',
        },
        {
          field: 'skill authoring',
          reason: 'Scoped Skill definitions are projected read-only because the registry has no per-preset create, install, enable, or remove operation.',
        },
        {
          field: 'delegation authoring',
          reason: 'Delegation rows are projected read-only because disabled expressions and provider lifecycle cannot be safely changed through one literal boolean anchor.',
        },
        ...delegationProjection.gaps.map(gap => ({
          field: gap.rowId === undefined ? 'delegation row' : `delegation row ${gap.rowId}`,
          reason: gap.reason,
        })),
        {
          field: 'provider availability',
          reason: 'The tool registry intentionally keeps enabled schemas visible when a Web provider is unavailable and exposes no provider-enumeration API.',
        },
        {
          field: 'access',
          reason: 'Permissions belong to the host and session log rather than the agent preset, so the adapter reads but never writes them through preset authoring.',
        },
      ],
    }
  }

  /**
   * Update the role-only Identity slot in one supported persona sentence.
   * @param request - optimistic Identity update addressed by its stable node id.
   * @returns the Blueprint re-read from the next preset generation.
   */
  async updateIdentity(request: BlueprintIdentityWrite): Promise<Blueprint> {
    return await this.withPresetUpdate(request.presetId, async () => {
      const { preset, composition } = await this.writableComposition(request.presetId, request.revision)
      assertMountedDelegationReference(await this.project(preset, composition), request.value)
      const next = applyBlueprintOperation(composition, {
        operation: 'updateIdentity', targetNodeId: request.nodeId,
        expected: request.expected, value: request.value,
      })
      await this.commit(preset, next)
      return await this.read(request.presetId)
    })
  }

  /**
   * Update the inferred Purpose sentence in the real persona scalar.
   * @param request - optimistic single-line update.
   * @returns the Blueprint re-read from the next preset generation.
   */
  async updatePurpose(request: BlueprintTextWrite): Promise<Blueprint> {
    return await this.withPresetUpdate(request.presetId, async () => {
      const { preset, composition } = await this.writableComposition(request.presetId, request.revision)
      assertMountedDelegationReference(await this.project(preset, composition), request.value)
      const next = applyBlueprintOperation(composition, {
        operation: 'updatePurpose', targetNodeId: 'purpose:persona',
        expected: request.expected, value: request.value,
      })
      await this.commit(preset, next)
      return await this.read(request.presetId)
    })
  }

  /**
   * Update one numbered Behavior in the real persona scalar.
   * @param request - optimistic item update.
   * @returns the Blueprint re-read from the next preset generation.
   */
  async updateBehavior(request: BlueprintBehaviorWrite): Promise<Blueprint> {
    return await this.withPresetUpdate(request.presetId, async () => {
      const { preset, composition } = await this.writableComposition(request.presetId, request.revision)
      assertMountedDelegationReference(await this.project(preset, composition), request.value)
      const next = applyBlueprintOperation(composition, {
        operation: 'updateBehavior', targetNodeId: `behavior:${String(request.ordinal)}`,
        expected: request.expected, value: request.value,
      })
      await this.commit(preset, next)
      return await this.read(request.presetId)
    })
  }

  /**
   * Update the uniquely anchored Output item in the real persona scalar.
   * @param request - optimistic inferred-output update.
   * @returns the Blueprint re-read from the next preset generation.
   */
  async updateOutput(request: BlueprintOutputWrite): Promise<Blueprint> {
    return await this.withPresetUpdate(request.presetId, async () => {
      const { preset, composition } = await this.writableComposition(request.presetId, request.revision)
      assertMountedDelegationReference(await this.project(preset, composition), request.value)
      const next = applyBlueprintOperation(composition, {
        operation: 'updateOutput', targetNodeId: `output:${String(request.ordinal)}`,
        expected: request.expected, value: request.value,
      })
      await this.commit(preset, next)
      return await this.read(request.presetId)
    })
  }

  /**
   * Add or remove Web Fetch by updating the real `tool-web.config.fetch` field.
   * @param request - optimistic capability update.
   * @returns the Blueprint re-read from the next preset generation.
   */
  async setWebFetch(request: Omit<BlueprintCapabilityWrite, 'capability'>): Promise<Blueprint> {
    return await this.setCapability({ ...request, capability: 'web-fetch' })
  }

  /**
   * Enable or disable one admitted Web capability through its typed preset field.
   * @param request - optimistic capability update.
   * @returns the Blueprint re-read from the next preset generation.
   */
  async setCapability(request: BlueprintCapabilityWrite): Promise<Blueprint> {
    return await this.withPresetUpdate(request.presetId, async () => {
      const { preset, composition } = await this.writableComposition(request.presetId, request.revision)
      const next = applyBlueprintOperation(composition, {
        operation: 'setCapability', targetNodeId: `capability:${request.capability}`,
        capability: request.capability, expected: request.expected, enabled: request.enabled,
      })
      await this.commit(preset, next)
      return await this.read(request.presetId)
    })
  }

  /**
   * Apply one confirmed Change Set after whole-set preflight and in-memory staging.
   * @param request - source-owned Proposal identity plus an exact copy of its closed typed transaction.
   * @returns the immutable terminal transaction evidence; only `committed` changes the preset without recovery.
   */
  @Remote
  async applyChangeSet(request: BlueprintApplyChangeSetRequest): Promise<BlueprintApplyChangeSetResult> {
    const authority = this.resolveDurableProposal(request)
    await this.ctx.sessions.flush(authority.session)
    return await this.withPresetUpdate(authority.changeSet.presetId, async (): Promise<BlueprintApplyChangeSetResult> => {
      const cancelled = proposalCancellation(authority.session.events, request)
      if (cancelled !== undefined) throw new Error('blueprint proposal authority: Proposal was already cancelled')
      const prior = proposalApplyReceipt(authority.session.events, request)
      if (prior !== undefined) return prior.result
      let preset: AgentPreset
      let composition: string
      let blueprint: Blueprint
      try {
        preset = await this.ctx.agentPresets.resolve(request.presetId)
        if (preset.trust !== 'user') {
          throw new Error(`blueprint-adapter: preset ${JSON.stringify(request.presetId)} ships with the deployment and is read-only`)
        }
        if (preset.broken !== undefined) {
          throw new Error(`blueprint-adapter: preset ${JSON.stringify(request.presetId)} is broken: ${preset.broken}`)
        }
        composition = await this.ctx.agentPresets.read(request.presetId)
        blueprint = await this.project(preset, composition)
      } catch (error) {
        const result: BlueprintApplyChangeSetResult = {
          sourceSessionId: request.sourceSessionId,
          routeId: request.routeId,
          changeSetId: request.changeSetId,
          baseRevision: request.baseRevision,
          status: 'preflight_failed',
          operations: request.operations,
          preflight: { ok: false, reason: error instanceof Error ? error.message : String(error) },
          unexpectedDrift: [],
        }
        authority.session.append('blueprint/apply-result', {
          sourceSessionId: request.sourceSessionId,
          routeId: request.routeId,
          proposalResultSeq: authority.resultSeq,
          presetId: request.presetId,
          result,
        })
        await this.ctx.sessions.flush(authority.session)
        return result
      }
      const result = await executeBlueprintTransaction(request, blueprint, composition, {
        stage: () => stageBlueprintChangeSet(composition, request.operations),
        commit: async (next) => { await this.commit(preset, next) },
        reproject: async () => await this.read(request.presetId),
        readCurrentComposition: async () => await this.ctx.agentPresets.read(request.presetId),
      })
      authority.session.append('blueprint/apply-result', {
        sourceSessionId: request.sourceSessionId,
        routeId: request.routeId,
        proposalResultSeq: authority.resultSeq,
        presetId: request.presetId,
        result,
      })
      await this.ctx.sessions.flush(authority.session)
      return result
    })
  }

  /**
   * Dismiss one exact durable Proposal without changing its preset.
   * @param request - source Session, interaction, and Proposal Tool-call identity.
   * @returns the immutable cancellation terminal recovered by later context refreshes.
   */
  @Remote
  async cancelChangeSet(request: BlueprintCancelChangeSetRequest): Promise<BlueprintProposalCancellation> {
    const authority = this.resolveDurableProposal(request)
    await this.ctx.sessions.flush(authority.session)
    return await this.withPresetUpdate(authority.changeSet.presetId, async () => {
      const prior = proposalCancellation(authority.session.events, request)
      if (prior !== undefined) return prior
      if (proposalApplyReceipt(authority.session.events, request) !== undefined) {
        throw new Error('blueprint proposal authority: Proposal already has an Apply terminal')
      }
      const cancellation: BlueprintProposalCancellation = {
        sourceSessionId: request.sourceSessionId,
        routeId: request.routeId,
        changeSetId: request.changeSetId,
        proposalResultSeq: authority.resultSeq,
        presetId: authority.changeSet.presetId,
        baseRevision: authority.changeSet.revision,
        status: 'cancelled',
      }
      authority.session.append('blueprint/proposal-cancelled', cancellation)
      await this.ctx.sessions.flush(authority.session)
      return cancellation
    })
  }

  /**
   * Synchronize one live conversation's optional Blueprint context and proposal Tool.
   * @param request - Session plus target projection, Creator Draft, or Session alone to clear.
   * @returns scoped conversation state and that Session's recorded Apply outcomes.
   */
  @Remote
  async setConversationContext(
    request: BlueprintConversationContextRequest,
  ): Promise<BlueprintConversationContextResult> {
    const prior = this.conversationUpdates.get(request.sessionId)
    const update = (prior === undefined ? Promise.resolve() : prior.catch(() => undefined))
      .then(async () => await this.applyConversationContext(request))
    this.conversationUpdates.set(request.sessionId, update)
    try {
      const result = await update
      const agent = this.ctx.agents.get(request.sessionId as SessionId)
      return {
        ...result,
        ...(agent?.session.events.some(event => event.type === 'blueprint/apply-result') ? {
          applyReceipts: agent.session.events.flatMap(event => event.type === 'blueprint/apply-result'
            && event.data.sourceSessionId === request.sessionId
            ? [{ ...event.data, terminalSeq: event.seq }]
            : []),
        } : {}),
        ...(agent?.session.events.some(event => event.type === 'blueprint/proposal-cancelled') ? {
          proposalCancellations: agent.session.events.flatMap(event => event.type === 'blueprint/proposal-cancelled'
            && event.data.sourceSessionId === request.sessionId ? [event.data] : []),
        } : {}),
      }
    } finally {
      if (this.conversationUpdates.get(request.sessionId) === update) {
        this.conversationUpdates.delete(request.sessionId)
      }
    }
  }

  /**
   * Compare one new Session's prompt content, tool schemas, permissions, and preset identity with a fresh projection.
   * @param request - expected preset revision, live Session identity, and optional P0 Change Set receipt.
   * @returns digest-only runtime evidence; raw prompt and schemas remain on the Host.
   */
  @Remote
  async validateSession(request: BlueprintValidateSessionRequest): Promise<BlueprintSessionValidation> {
    const receiptIdentity = validateReceiptIdentity(request)
    const agent = this.ctx.agents.get(request.sessionId as SessionId)
    if (agent === undefined) throw new Error(`blueprint-adapter: live session ${JSON.stringify(request.sessionId)} not found`)
    const expectedBlueprint = await this.read(request.presetId, {
      cwd: agent.session.header.cwd ?? process.cwd(),
    })
    const expectedAssembly = await this.assembly(request.presetId, undefined)
    const liveAssembly = await this.assembly(request.presetId, agent)
    const liveSkills = (await this.skillProjection(
      request.presetId,
      agent.session.header.cwd ?? process.cwd(),
      agent,
    )).runtime
    const sessionPresetId = agent.session.header.agentPreset
    const composedPresetId = this.ctx.agentPresets.composedPreset(agent.ctx)
    const receipt = receiptIdentity === undefined ? undefined : proposalApplyReceipt(
      this.ctx.sessions.get(receiptIdentity.sourceSessionId as SessionId)?.events ?? [],
      receiptIdentity,
    )
    const transaction = receipt !== undefined && receiptIdentity !== undefined
      && receipt.presetId === request.presetId
      && sameProposalIdentity(receipt.result, receiptIdentity)
      && receipt.result.status === 'committed'
      && receipt.result.committedRevision === request.expectedRevision
      ? receipt.result
      : undefined
    return validateRuntimeConformance({
      presetId: request.presetId,
      sessionId: request.sessionId,
      expectedRevision: request.expectedRevision,
      expectedBlueprint,
      expectedAssembly,
      liveAssembly,
      ...(sessionPresetId === undefined ? {} : { sessionPresetId }),
      ...(composedPresetId === undefined ? {} : { composedPresetId }),
      expectedPermissions: expectedBlueprint.runtime.permissions,
      livePermissions: this.permissions(agent),
      liveSkills,
      liveDelegationProviders: this.ctx.subagents.list(),
      ...(transaction === undefined ? {} : { transaction }),
    })
  }

  /** Apply one serialized context update after its predecessor settles. */
  private async applyConversationContext(
    request: BlueprintConversationContextRequest,
  ): Promise<BlueprintConversationContextResult> {
    const agent = this.ctx.agents.get(request.sessionId as SessionId)
    if (agent === undefined) {
      throw new Error(`blueprint-adapter: live session ${JSON.stringify(request.sessionId)} not found`)
    }
    this.ensureCapabilityRoutingGuard(agent)
    if (request.capabilityInput !== undefined && (request.presetId === undefined || request.creatorDraft !== undefined
      || request.creatorAuthoring !== undefined || request.capabilityAuthoring !== undefined
      || request.recoverCreatorAuthoring !== undefined || request.recoverCapabilityAuthoring !== undefined
      || request.capabilityAuthoringEnd !== undefined || request.userChange !== undefined
      || request.directEditInput !== undefined)) {
      throw new Error('blueprint-adapter: Add capability input requires only an existing Blueprint target context')
    }
    if (request.directEditInput !== undefined && (request.presetId === undefined || request.revision === undefined
      || request.creatorDraft !== undefined || request.creatorAuthoring !== undefined
      || request.capabilityAuthoring !== undefined || request.capabilityInput !== undefined
      || request.recoverCreatorAuthoring !== undefined || request.recoverCapabilityAuthoring !== undefined
      || request.capabilityAuthoringEnd !== undefined || request.userChange !== undefined)) {
      throw new Error('blueprint-adapter: structured edit input requires only an existing Blueprint target context')
    }
    const capabilityText = request.capabilityInput?.userRequest.trim()
    if (capabilityText !== undefined && (capabilityText === '' || capabilityText.length > 2_000)) {
      throw new Error('blueprint-adapter: Add capability input must contain a concise original user request')
    }
    if (request.capabilityInput?.routeId.trim() === '') {
      throw new Error('blueprint-adapter: Add capability input requires an interaction route id')
    }
    if (request.directEditInput?.routeId.trim() === '' || (request.directEditInput !== undefined
      && request.directEditInput.sourceSessionId !== request.sessionId)) {
      throw new Error('blueprint-adapter: structured edit input requires its source Session and interaction route')
    }
    if (request.capabilityAuthoring !== undefined
      && (request.capabilityAuthoring.routeId.trim() === '' || request.capabilityAuthoring.sourceSessionId.trim() === '')) {
      throw new Error('blueprint-adapter: capability authoring requires its source interaction identity')
    }
    const authoringContexts = [request.creatorDraft, request.creatorAuthoring, request.capabilityAuthoring]
      .filter(value => value !== undefined).length
    if (authoringContexts > 1) {
      throw new Error('blueprint-adapter: Creator Draft, Creator authoring, and capability authoring contexts are mutually exclusive')
    }
    if (request.recoverCreatorAuthoring === true) {
      if (request.creatorAuthoring !== undefined || request.capabilityAuthoring !== undefined
        || request.capabilityAuthoringEnd !== undefined || request.recoverCapabilityAuthoring !== undefined
        || request.creatorDraft !== undefined || request.presetId !== undefined || request.revision !== undefined
        || request.selectedNodeId !== undefined || request.userChange !== undefined
        || request.directEditInput !== undefined) {
        throw new Error('blueprint-adapter: Creator authoring recovery accepts only sessionId')
      }
      this.clearConversationBinding(request.sessionId)
      const authoring = latestCreatorAuthoring(agent)
      if (authoring === undefined) return { sessionId: request.sessionId, active: false }
      const terminal = await this.restoreCreatorTerminal(request.sessionId, agent, authoring)
      if (terminal !== undefined) return terminal
      return this.installCreatorAuthoring(request.sessionId, agent, authoring.data, authoring.seq)
    }
    if (request.recoverCapabilityAuthoring === true) {
      if (request.capabilityAuthoring !== undefined || request.capabilityAuthoringEnd !== undefined
        || request.creatorAuthoring !== undefined || request.recoverCreatorAuthoring !== undefined
        || request.creatorDraft !== undefined || request.presetId !== undefined || request.revision !== undefined
        || request.selectedNodeId !== undefined || request.userChange !== undefined
        || request.directEditInput !== undefined) {
        throw new Error('blueprint-adapter: capability authoring recovery accepts only sessionId')
      }
      const beforeSettlement = activeCapabilityAuthoring(agent)
      let installed: BlueprintConversationContextResult | undefined
      if (beforeSettlement !== undefined) {
        this.clearConversationBinding(request.sessionId)
        const record = latestCapabilityAuthoringRecord(agent)
        if (record !== undefined && this.capabilityCancelRequestedEvent(agent, record) !== undefined) {
          await this.cancelCapabilityAuthoring(agent, record, false)
        } else {
          installed = await this.installCapabilityAuthoring(
            request.sessionId,
            agent,
            beforeSettlement.data,
            beforeSettlement.seq,
          )
          await this.settleCapabilityAuthoring(agent)
        }
      }
      const active = activeCapabilityAuthoring(agent)
      if (active !== undefined && installed !== undefined) {
        return installed
      }
      const record = latestCapabilityAuthoringRecord(agent)
      if (this.closeCapabilityAuthoringSurfaces(agent)) {
        await this.ctx.sessions.flush(agent.session)
      }
      if (record?.terminal?.candidateDisposition !== undefined) {
        try {
          await this.finalizeCapabilityCandidateTerminal(record, record.terminal.candidateDisposition)
          try {
            await this.clearCapabilityCandidateOverlay(request.sessionId, agent)
          } catch (error) {
            this.ctx.logger.warn(`Capability candidate overlay cleanup failed: ${String(error)}`)
          }
        } finally {
          this.releaseCapabilityTarget(record.data.targetPresetId, request.sessionId)
        }
      }
      return {
        sessionId: request.sessionId,
        active: false,
        ...(record === undefined ? {} : { capabilityAuthoringRecord: capabilityAuthoringResultRecord(record) }),
      }
    }
    if (request.capabilityAuthoringEnd !== undefined) {
      if (request.capabilityAuthoring !== undefined || request.creatorAuthoring !== undefined
        || request.recoverCreatorAuthoring !== undefined || request.creatorDraft !== undefined
        || request.presetId !== undefined || request.revision !== undefined
        || request.selectedNodeId !== undefined || request.userChange !== undefined
        || request.directEditInput !== undefined) {
        throw new Error('blueprint-adapter: ending capability authoring accepts only sessionId and outcome')
      }
      if (request.capabilityAuthoringEnd.outcome === 'failed') {
        throw new Error('blueprint-adapter: internal capability failures are Host-owned and cannot be published by a client')
      }
      if (request.capabilityAuthoringEnd.outcome === 'cancelled') {
        const record = latestCapabilityAuthoringRecord(agent)
        if (record !== undefined && !record.explicitlyEnded) {
          await this.cancelCapabilityAuthoring(agent, record, true)
        }
      }
      if (request.capabilityAuthoringEnd.outcome === 'completed') {
        await this.settleCapabilityAuthoring(agent)
        if (activeCapabilityAuthoring(agent) !== undefined) {
          throw new Error('blueprint-adapter: capability authoring is still configuring internally')
        }
      }
      this.clearConversationBinding(request.sessionId, agent, 'capability-authoring')
      const record = latestCapabilityAuthoringRecord(agent)
      this.closeCapabilityAuthoringSurfaces(agent)
      await this.ctx.sessions.flush(agent.session)
      return {
        sessionId: request.sessionId,
        active: false,
        ...(record === undefined ? {} : {
          capabilityAuthoringRecord: capabilityAuthoringResultRecord(record),
        }),
      }
    }
    const active = activeCapabilityAuthoring(agent)
    if (active !== undefined && request.capabilityAuthoring === undefined) {
      if (request.creatorAuthoring !== undefined) {
        throw new Error('blueprint-adapter: Creator authoring cannot replace active capability authoring')
      }
      const record = latestCapabilityAuthoringRecord(agent)
      if (record !== undefined && this.capabilityCancelRequestedEvent(agent, record) !== undefined) {
        await this.cancelCapabilityAuthoring(agent, record, false)
        return {
          sessionId: request.sessionId,
          active: false,
          capabilityAuthoringRecord: capabilityAuthoringResultRecord(
            latestCapabilityAuthoringRecord(agent) ?? record,
          ),
        }
      }
      this.clearConversationBinding(request.sessionId)
      return await this.installCapabilityAuthoring(request.sessionId, agent, active.data, active.seq)
    }
    if (this.closeCapabilityAuthoringSurfaces(agent)) {
      await this.ctx.sessions.flush(agent.session)
    }
    if (request.capabilityAuthoring !== undefined) {
      if (request.presetId !== undefined || request.revision !== undefined || request.selectedNodeId !== undefined
        || request.userChange !== undefined || request.directEditInput !== undefined) {
        throw new Error('blueprint-adapter: capability authoring context cannot carry normal Blueprint target fields')
      }
      if (this.ctx.agentPresets.composedPreset(agent.ctx) !== 'cordis') {
        throw new Error('blueprint-adapter: capability authoring context requires a cordis Creator Session')
      }
      const authority = await resolveDurableCapabilityAuthoring(this.ctx, agent, request.capabilityAuthoring)
      if (active !== undefined && (authority.existingStart?.seq !== active.seq
        || !sameCapabilityAuthoring(active.data, request.capabilityAuthoring))) {
        throw new Error('blueprint-adapter: a different capability authoring lifecycle is already active')
      }
      const lifecycle = authority.existingStart
        ?? await this.startCapabilityAuthoringLifecycle(agent, request.capabilityAuthoring)
      this.clearConversationBinding(request.sessionId)
      return await this.installCapabilityAuthoring(request.sessionId, agent, lifecycle.data, lifecycle.seq)
    }
    if (request.creatorAuthoring !== undefined) {
      this.clearConversationBinding(request.sessionId)
      if (request.presetId !== undefined || request.revision !== undefined || request.selectedNodeId !== undefined
        || request.userChange !== undefined || request.directEditInput !== undefined) {
        throw new Error('blueprint-adapter: Creator authoring context cannot carry normal Blueprint target fields')
      }
      if (this.ctx.agentPresets.composedPreset(agent.ctx) !== 'cordis') {
        throw new Error('blueprint-adapter: Creator authoring context requires a cordis Creator Session')
      }
      if (active !== undefined) {
        throw new Error('blueprint-adapter: Creator authoring cannot replace active capability authoring')
      }
      const existing = latestCreatorAuthoring(agent)
      if (existing !== undefined && !sameCreatorAuthoring(existing.data, {
        ...request.creatorAuthoring,
        operation: 'create-agent',
      })) {
        throw new Error('blueprint-adapter: Creator Session already owns a different typed authoring task')
      }
      const data: BlueprintCreatorAuthoringEvent = {
        ...request.creatorAuthoring,
        operation: 'create-agent',
      }
      const startSeq = existing?.seq ?? agent.session.append('blueprint/creator-authoring', data).seq
      const terminal = await this.restoreCreatorTerminal(request.sessionId, agent, { seq: startSeq, data })
      if (terminal !== undefined) return terminal
      const result = this.installCreatorAuthoring(request.sessionId, agent, data, startSeq)
      if (data.handoff !== undefined) await startExclusiveCreator(this.ctx, agent, data)
      return result
    }
    if (request.creatorDraft !== undefined) {
      this.clearConversationBinding(request.sessionId)
      const authoring = latestCreatorAuthoring(agent)
      if (authoring !== undefined) {
        const terminal = await this.restoreCreatorTerminal(request.sessionId, agent, authoring)
        if (terminal !== undefined) return terminal
      }
      if (request.presetId !== undefined || request.revision !== undefined || request.selectedNodeId !== undefined
        || request.userChange !== undefined || request.directEditInput !== undefined) {
        throw new Error('blueprint-adapter: Creator Draft context cannot carry a preset, revision, selected node, or user change')
      }
      if (request.creatorDraft.selectedNodeId !== undefined && request.creatorDraft.targetPresetId === undefined) {
        throw new Error('blueprint-adapter: Creator Draft node selection requires an associated target preset')
      }
      if (this.ctx.agentPresets.composedPreset(agent.ctx) !== 'cordis') {
        throw new Error('blueprint-adapter: Creator Draft context requires a cordis Creator Session')
      }
      const selectedNode = request.creatorDraft.targetPresetId === undefined
        ? undefined
        : (await this.read(request.creatorDraft.targetPresetId)).nodes.find(
          node => node.id === request.creatorDraft?.selectedNodeId,
        )
      if (request.creatorDraft.selectedNodeId !== undefined && selectedNode === undefined) {
        throw new Error(`blueprint-adapter: selected Creator Draft node ${JSON.stringify(request.creatorDraft.selectedNodeId)} not found`)
      }
      const disposeContext = agent.ctx.systemPrompt.context({
        name: BLUEPRINT_CONVERSATION_SECTION,
        order: 118,
        text: creatorAuthoringGuidance(request.creatorDraft, selectedNode, latestCreatorAuthoring(agent)?.data),
      })
      this.conversationBindings.set(request.sessionId, {
        agent,
        mode: 'creator-authoring',
        disposeContext,
      })
      return { sessionId: request.sessionId, active: true }
    }
    if (request.presetId === undefined) {
      if (request.revision !== undefined || request.selectedNodeId !== undefined || request.userChange !== undefined
        || request.directEditInput !== undefined) {
        throw new Error('blueprint-adapter: clearing conversation context accepts only sessionId')
      }
      if (this.deferConversationClearForCapabilityRoute(request.sessionId, agent)) {
        const binding = this.conversationBindings.get(request.sessionId)
        return {
          sessionId: request.sessionId,
          active: true,
          ...(binding?.presetId === undefined ? {} : { presetId: binding.presetId }),
          ...(binding?.selectedNodeId === undefined ? {} : { selectedNodeId: binding.selectedNodeId }),
        }
      }
      this.clearConversationBinding(request.sessionId)
      return { sessionId: request.sessionId, active: false }
    }
    if (request.revision === undefined) {
      throw new Error('blueprint-adapter: conversation context requires a Blueprint revision')
    }
    const presetId = request.presetId
    const blueprint = await this.read(presetId)
    if (blueprint.revision !== request.revision) {
      throw new Error('blueprint-adapter: conversation context projection is stale; re-read the Blueprint')
    }
    if (request.selectedNodeId !== undefined
      && !blueprint.nodes.some(node => node.id === request.selectedNodeId)) {
      throw new Error(`blueprint-adapter: selected node ${JSON.stringify(request.selectedNodeId)} is not in the Blueprint`)
    }
    if (request.directEditInput !== undefined && request.selectedNodeId !== request.directEditInput.nodeId) {
      throw new Error('blueprint-adapter: structured edit input must keep its semantic node selected')
    }
    const structuredEdit = request.directEditInput === undefined
      ? undefined
      : createBlueprintStructuredEdit(blueprint, request.directEditInput)
    const userChange = request.userChange === undefined
      ? undefined
      : createBlueprintUserChange(blueprint, request.userChange)
    if (this.ctx.agents.get(request.sessionId as SessionId) !== agent) {
      throw new Error(`blueprint-adapter: live session ${JSON.stringify(request.sessionId)} changed during context setup`)
    }
    this.clearConversationBinding(request.sessionId)
    const disposeProposalTool = agent.ctx.tools.register(defineTool({
      name: BLUEPRINT_PROPOSAL_TOOL,
      description: 'Create a typed preview for one explicit user-requested change to the active Interactive Blueprint. '
        + 'A structured Identity, Purpose, Behavior, Output, or Web submission authorizes its exact source edit plus only dependent nodes from its Host-discovered deterministic impact candidate set. '
        + 'A post-write direct-edit notice may authorize only conflicting candidate nodes. Targets outside either candidate set are rejected. '
        + 'This Tool never writes the preset. Do not call it for discussion, explanation, judgment, or hypothetical questions. '
        + 'Only updateIdentity for an editable Identity, updatePurpose, updateBehavior, setCapability for Web Search/Web Fetch, and updateOutput are allowed.',
      parameters: {
        intent: {
          type: 'string',
          required: true,
          description: 'Exactly modify-existing-agent for an explicit conversation or structured semantic edit, or reconcile-direct-edit for a post-write consistency check.',
        },
        changes: {
          type: 'json',
          required: true,
          description: 'A JSON array. Each item must contain target_node_id, operation, current_value, proposed_value, impact, and every dependent or reconciliation item needs an exact dependency. Use one item for a direct request; a structured edit starts with its exact source edit and may then use only impactCandidates.',
        },
      },
      output: {
        schema: { type: 'json' },
        render: () => [{
          type: 'text',
          text: 'Change Set created. The preset has not changed; wait for explicit user confirmation in the UI.',
        }],
        presentationMeta: (_args, value) => ({ blueprintChangeSet: value }),
      },
      execute: async (args, exec): Promise<JsonValue> => {
        if (exec.agent !== agent) throw new Error('blueprint proposal: execution Agent does not own this context')
        const input = blueprintRoutingInput(agent, presetId)
        const directUserText = input?.userRequest
        const reconciledChange = blueprintUserChangeForCurrentTurn(agent)
        if (directUserText === undefined && reconciledChange === undefined) {
          throw new Error('blueprint proposal: no user intent authorized this proposal')
        }
        const binding = this.conversationBindings.get(request.sessionId)
        if (binding?.mode === 'creator-authoring' || binding?.mode === 'capability-authoring') {
          throw new Error('creator-authoring-in-progress: continue creating the new preset; do not propose a change to the existing Agent')
        }
        if (binding?.mode !== 'blueprint' || binding.presetId !== presetId
          || binding.revision !== request.revision) {
          throw new Error('blueprint proposal: the active conversation context changed; do not use the stale proposal target')
        }
        const current = await this.read(presetId)
        if (current.revision !== request.revision) {
          throw new Error('blueprint proposal: the active projection is stale; re-read before proposing')
        }
        const parsedArgs = parseBlueprintChangeSetArgs(args)
        if (reconciledChange === undefined && input !== undefined) {
          assertBlueprintProposalForRoutingInput(input, parsedArgs)
          selectBlueprintOperation(agent.session, input, 'modify-existing-agent', exec.callId)
        }
        const changeSet = reconciledChange !== undefined
          ? createBlueprintReconciliationChangeSet(
            current,
            parsedArgs,
            String(exec.callId),
            reconciledChange,
            { sourceSessionId: request.sessionId, routeId: String(exec.callId) },
          )
          : input?.provenance === 'direct-edit'
            ? createBlueprintStructuredEditChangeSet(
              current,
              parsedArgs,
              String(exec.callId),
              input,
              { sourceSessionId: String(input.sourceSessionId), routeId: input.routeId },
            )
            : createBlueprintChangeSet(
              current,
              parsedArgs,
              String(exec.callId),
              directUserText as string,
              request.selectedNodeId,
              input === undefined
                ? { sourceSessionId: request.sessionId, routeId: String(exec.callId) }
                : { sourceSessionId: String(input.sourceSessionId), routeId: input.routeId },
            )
        exec.concludeTurn()
        return changeSet as unknown as JsonValue
      },
      presentCall: () => ({ card: 'generic', title: 'Propose Blueprint change', kind: 'other' }),
    }))
    const disposeAuthoringTool = agent.ctx.tools.register(defineTool({
      name: BLUEPRINT_CAPABILITY_AUTHORING_TOOL,
      description: 'Route one capability request to Creator authoring only when the active Blueprint operations cannot implement it and a new Skill definition or Subagent configuration is required. This Tool never writes a preset.',
      parameters: {
        request: { type: 'string', required: true, description: 'The user outcome to preserve, without implementation syntax.' },
        kind: { type: 'string', required: true, description: 'Exactly one of skill or subagent.' },
        reason: { type: 'string', required: true, description: 'Why editable Blueprint nodes and existing enabled capabilities are insufficient.' },
      },
      output: {
        schema: { type: 'json' },
        render: () => [{ type: 'text', text: 'Capability authoring route accepted. The preset has not changed.' }],
        presentationMeta: (_args, value) => ({ blueprintCapabilityAuthoring: value }),
      },
      execute: async (args, exec): Promise<JsonValue> => {
        if (exec.agent !== agent) throw new Error('blueprint capability routing: execution Agent does not own this context')
        const input = blueprintRoutingInput(agent, presetId)
        if (input === undefined) throw new Error('blueprint capability routing: no current direct user request authorized this route')
        const binding = this.conversationBindings.get(request.sessionId)
        if (binding?.mode !== 'blueprint' || binding.presetId !== presetId
          || binding.revision !== request.revision) {
          throw new Error('blueprint capability routing: the active conversation context changed')
        }
        const route = createBlueprintCapabilityAuthoringRoute(blueprint, args, {
          routeId: input.routeId,
          sourceSessionId: String(input.sourceSessionId),
        })
        selectBlueprintOperation(agent.session, input, route.kind, exec.callId)
        const current = await this.read(presetId)
        if (current.revision !== request.revision) {
          throw new Error('blueprint capability routing: the active projection is stale; re-read before routing')
        }
        exec.concludeTurn()
        return { ...route, request: input.userRequest }
      },
      presentCall: () => ({ card: 'generic', title: 'Route capability authoring', kind: 'other' }),
    }))
    const disposeCreatorAuthoringTool = agent.ctx.tools.register(defineTool({
      name: BLUEPRINT_CREATOR_AUTHORING_TOOL,
      description: 'Route one explicit request for a distinct new Agent to the Creator executor. '
          + 'Use this for creating a new Agent, never for changing the current Agent or adding a Skill or Subagent. '
          + 'The Host preserves the exact direct-user request; this Tool does not create or modify a preset itself.',
      parameters: {
        user_intent: {
          type: 'string',
          required: true,
          description: 'Quote the exact words in the current original user request asking for a distinct new Agent. Never quote system guidance, examples or previous assistant text.',
        },
        name: {
          type: 'string',
          required: true,
          description: 'One concise user-facing name for the requested new Agent, in the user request language.',
        },
      },
      output: {
        schema: { type: 'json' },
        render: () => [{
          type: 'text',
          text: 'New-Agent authoring route accepted. Creator continuation is starting; continue the real authoring task.',
        }],
        presentationMeta: (_args, value) => ({ blueprintCreatorAuthoring: value }),
      },
      execute: async (args, exec): Promise<JsonValue> => {
        if (exec.agent !== agent) throw new Error('blueprint Creator routing: execution Agent does not own this context')
        const input = blueprintRoutingInput(agent, presetId)
        if (input === undefined) throw new Error('blueprint Creator routing: no current direct user request authorized this route')
        const binding = this.conversationBindings.get(request.sessionId)
        if (binding?.mode !== 'blueprint' || binding.presetId !== presetId
            || binding.revision !== request.revision) {
          throw new Error('blueprint Creator routing: the active conversation context changed')
        }
        const classified = createBlueprintCreatorAuthoringRoute(
          input,
          args,
          String(exec.callId),
        )
        selectBlueprintOperation(agent.session, input, 'create-agent', exec.callId)
        const route = await prepareCreatorHandoff(this.ctx, agent, classified)
        exec.concludeTurn()
        return route as unknown as JsonValue
      },
      presentCall: () => ({ card: 'generic', title: 'Route new-Agent authoring', kind: 'other' }),
    }))
    const disposeTools = (): void => {
      disposeCreatorAuthoringTool()
      disposeAuthoringTool()
      disposeProposalTool()
    }
    let disposeContext: (() => void) | undefined
    try {
      disposeContext = agent.ctx.systemPrompt.context({
        name: BLUEPRINT_CONVERSATION_SECTION,
        order: 118,
        text: () => [blueprintConversationGuidance(blueprint, request.selectedNodeId),
          blueprintRoutingGuidance(blueprintRoutingInput(agent, presetId))].filter(Boolean).join('\n'),
      })
    } catch (error) {
      disposeTools()
      throw error
    }
    this.conversationBindings.set(request.sessionId, {
      agent,
      mode: 'blueprint',
      presetId,
      revision: request.revision,
      ...(request.selectedNodeId === undefined ? {} : { selectedNodeId: request.selectedNodeId }),
      disposeContext,
      disposeTools,
    })
    if (capabilityText !== undefined && request.capabilityInput !== undefined) {
      const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: capabilityText }] })
      agent.session.append('blueprint/routing-input', {
        routeId: request.capabilityInput.routeId,
        sourceSessionId: agent.session.id, messageId: message.id, userRequest: capabilityText,
        uiAction: 'add-capability', targetPresetId: presetId,
      })
      agent.followup(message)
      await this.ctx.sessions.flush(agent.session)
    }
    let directEditEnqueue: BlueprintConversationContextResult['directEditEnqueue']
    if (structuredEdit !== undefined && request.directEditInput !== undefined) {
      const message = blueprintStructuredEditMessage(structuredEdit)
      const routingInput = agent.session.append('blueprint/routing-input', {
        routeId: request.directEditInput.routeId,
        sourceSessionId: agent.session.id,
        messageId: message.id,
        userRequest: message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'),
        uiAction: 'direct-edit',
        targetPresetId: presetId,
        directEdit: structuredEdit,
      })
      agent.followup(message)
      await this.ctx.sessions.flush(agent.session)
      directEditEnqueue = {
        routeId: request.directEditInput.routeId,
        sourceSessionId: String(agent.session.id),
        routingInputSeq: routingInput.seq,
        messageId: message.id,
      }
    }
    if (userChange !== undefined) {
      agent.session.append('blueprint/user-change', userChange)
      agent.followup(blueprintUserChangeMessage(userChange))
    }
    return {
      sessionId: request.sessionId,
      active: true,
      presetId: request.presetId,
      ...(request.selectedNodeId === undefined ? {} : { selectedNodeId: request.selectedNodeId }),
      ...(directEditEnqueue === undefined ? {} : { directEditEnqueue }),
    }
  }

  private async installCapabilityAuthoring(
    sessionId: string,
    agent: Agent,
    context: Extract<BlueprintCapabilityAuthoringEvent, { state: 'started' }>,
    startSeq: number,
  ): Promise<BlueprintConversationContextResult> {
    if (this.ctx.agentPresets.composedPreset(agent.ctx) !== 'cordis') {
      throw new Error('blueprint-adapter: capability authoring context requires a cordis Creator Session')
    }
    await this.ensureCapabilityCandidateOverlay(sessionId, agent, context)
    const blueprint = await this.read(context.targetPresetId)
    const disposeContext = agent.ctx.systemPrompt.context({
      name: BLUEPRINT_CONVERSATION_SECTION,
      order: 118,
      text: capabilityAuthoringGuidance(context),
    })
    this.conversationBindings.set(sessionId, {
      agent,
      mode: 'capability-authoring',
      presetId: blueprint.preset.id,
      revision: blueprint.revision,
      disposeContext,
    })
    await this.ensureCapabilityAuthoringWake(agent, { seq: startSeq, data: context })
    return {
      sessionId,
      active: true,
      presetId: blueprint.preset.id,
      capabilityAuthoring: {
        routeId: context.routeId,
        sourceSessionId: context.sourceSessionId,
        targetPresetId: blueprint.preset.id,
        request: context.request,
        kind: context.kind,
        baseRevision: context.baseRevision,
        startSeq,
        baselineDelegationRowIds: context.baselineDelegations.map(row => row.rowId),
      },
      capabilityAuthoringRecord: {
        routeId: context.routeId,
        sourceSessionId: context.sourceSessionId,
        targetPresetId: blueprint.preset.id,
        request: context.request,
        kind: context.kind,
        baseRevision: context.baseRevision,
        startSeq,
        baselineDelegationRowIds: context.baselineDelegations.map(row => row.rowId),
        state: 'active',
      },
    }
  }

  private installCreatorAuthoring(
    sessionId: string,
    agent: Agent,
    context: BlueprintCreatorAuthoringEvent,
    startSeq: number,
  ): BlueprintConversationContextResult {
    if (this.ctx.agentPresets.composedPreset(agent.ctx) !== 'cordis') {
      throw new Error('blueprint-adapter: Creator authoring context requires a cordis Creator Session')
    }
    const disposeContext = agent.ctx.systemPrompt.context({
      name: BLUEPRINT_CONVERSATION_SECTION,
      order: 118,
      text: creatorAuthoringGuidance({ name: context.name, status: 'creating' }, undefined, context),
    })
    this.conversationBindings.set(sessionId, {
      agent,
      mode: 'creator-authoring',
      disposeContext,
    })
    return {
      sessionId,
      active: true,
      creatorAuthoring: { ...context, startSeq },
    }
  }

  /** Checkpoint a task's terminal fact before restoring ordinary Blueprint interaction. */
  private async restoreCreatorTerminal(
    sessionId: string,
    agent: Agent,
    task: NonNullable<ReturnType<typeof latestCreatorAuthoring>>,
  ): Promise<BlueprintConversationContextResult | undefined> {
    const terminal = creatorTerminalEvidence(agent.session.events, task.seq)
    if (terminal === undefined) return undefined
    if (!agent.session.events.some(event => event.type === 'blueprint/creator-authoring-ended'
      && event.data.startSeq === task.seq)) {
      agent.session.append('blueprint/creator-authoring-ended', terminal)
    }
    await this.ctx.sessions.flush(agent.session)
    const creatorAuthoring = { ...task.data, startSeq: task.seq, terminal }
    if (terminal.outcome !== 'completed') return { sessionId, active: false, creatorAuthoring }
    const blueprint = await this.read(terminal.targetPresetId)
    const context = await this.applyConversationContext({ sessionId, presetId: terminal.targetPresetId, revision: blueprint.revision })
    return { ...context, creatorAuthoring }
  }

  /** Prepare new lifecycles through the generic AgentPresets transaction seam. */
  private async prepareCapabilityTransaction(
    preset: AgentPreset,
    identity: {
      creatorSessionId: string
      sourceSessionId: string
      routeId: string
      targetPresetId: string
      baseRevision: string
    },
  ): Promise<BlueprintCapabilityCandidate> {
    const key = JSON.stringify([
      'blueprint-capability-authoring',
      identity.creatorSessionId,
      identity.sourceSessionId,
      identity.routeId,
    ])
    return await this.ctx.agentPresets.prepareTransaction(preset.id, {
      key,
      expectedRevision: identity.baseRevision,
    })
  }

  /** Resolve a new generic transaction or an already-durable legacy candidate. */
  private async resolveCapabilityTransaction(
    preset: AgentPreset,
    candidate: BlueprintCapabilityCandidate,
  ): Promise<AgentPreset> {
    try {
      return await this.ctx.agentPresets.resolveTransaction(candidate)
    } catch (error) {
      if (!(error instanceof AgentPresetTransactionNotFoundError)) throw error
      return await resolveCapabilityCandidatePreset(preset, candidate)
    }
  }

  /** Fence a new generic transaction or an already-durable legacy candidate. */
  private async fenceCapabilityTransaction(
    preset: AgentPreset,
    candidate: BlueprintCapabilityCandidate,
  ): Promise<string> {
    try {
      return await this.ctx.agentPresets.fenceTransaction(candidate)
    } catch (error) {
      if (!(error instanceof AgentPresetTransactionNotFoundError)) throw error
      return await fenceCapabilityCandidate(preset, candidate)
    }
  }

  /** Recover a new transaction, falling back only when its generic journal is absent. */
  private async recoverCapabilityTransaction(
    targetPresetId: string,
    candidate: BlueprintCapabilityCandidate,
  ): Promise<AgentPresetTransactionRecovery> {
    try {
      return await this.ctx.agentPresets.recoverTransaction(candidate)
    } catch (error) {
      if (!(error instanceof AgentPresetTransactionNotFoundError)) throw error
      return await this.ctx.agentPresets.runLegacyPublication(targetPresetId, async () => {
        const recovery = await recoverCapabilityCandidate(candidate)
        if (recovery.state === 'committed') this.ctx.agentPresets.refreshStanding(targetPresetId)
        return recovery
      })
    }
  }

  /** Publish a new transaction, retaining the old journal reader only for restart compatibility. */
  private async publishCapabilityTransaction(
    preset: AgentPreset,
    candidate: BlueprintCapabilityCandidate,
    candidateTreeDigest: string,
  ): Promise<BlueprintCapabilityCandidateDisposition> {
    try {
      return await this.ctx.agentPresets.publishTransaction(candidate, candidateTreeDigest)
    } catch (error) {
      if (!(error instanceof AgentPresetTransactionNotFoundError)) throw error
      return await this.ctx.agentPresets.runLegacyPublication(preset.id, async () => {
        const disposition = await commitCapabilityCandidate(preset, candidate, candidateTreeDigest)
        this.ctx.agentPresets.refreshStanding(preset.id)
        return disposition
      })
    }
  }

  /** Discard a new transaction, retaining old journal settlement for restart compatibility. */
  private async discardCapabilityTransaction(
    preset: AgentPreset,
    candidate: BlueprintCapabilityCandidate,
    candidateTreeDigest: string,
  ): Promise<BlueprintCapabilityCandidateDisposition> {
    try {
      return await this.ctx.agentPresets.discardTransaction(candidate, candidateTreeDigest)
    } catch (error) {
      if (!(error instanceof AgentPresetTransactionNotFoundError)) throw error
      return await this.ctx.agentPresets.runLegacyPublication(preset.id, async () => {
        return await discardCapabilityCandidate(preset, candidate, candidateTreeDigest)
      })
    }
  }

  /** Clean one settled new transaction or an already-durable legacy candidate. */
  private async cleanupCapabilityTransaction(
    preset: AgentPreset,
    candidate: BlueprintCapabilityCandidate,
  ): Promise<void> {
    await this.ctx.agentPresets.cleanupTransaction(candidate)
    // Both cleanup methods are idempotent when their own directory is absent.
    // Calling the legacy reader second removes old durable records without
    // teaching AgentPresets the Blueprint-specific directory vocabulary.
    await cleanupCapabilityCandidate(preset, candidate)
  }

  private async startCapabilityAuthoringLifecycle(
    agent: Agent,
    request: NonNullable<BlueprintConversationContextRequest['capabilityAuthoring']>,
  ): Promise<ActiveCapabilityAuthoring> {
    const sessionId = String(agent.session.id)
    this.reserveCapabilityTarget(request.targetPresetId, sessionId)
    let preset: AgentPreset | undefined
    let candidate: BlueprintCapabilityCandidate | undefined
    let startAppended = false
    try {
      const cwd = agent.session.header.cwd
      const blueprint = await this.read(request.targetPresetId, cwd === undefined ? {} : { cwd })
      if (blueprint.revision !== request.baseRevision) {
        throw new Error('blueprint-adapter: capability authoring route is stale')
      }
      const baselinePresets = await this.capabilityPresetRoster()
      this.assertRosterTargetMatchesBlueprint(baselinePresets, blueprint)
      preset = await this.ctx.agentPresets.resolve(request.targetPresetId)
      candidate = await this.prepareCapabilityTransaction(preset, {
        creatorSessionId: sessionId,
        sourceSessionId: request.sourceSessionId,
        routeId: request.routeId,
        targetPresetId: request.targetPresetId,
        baseRevision: request.baseRevision,
      })
      const data: Extract<BlueprintCapabilityAuthoringEvent, { state: 'started' }> = {
        routeId: request.routeId,
        sourceSessionId: request.sourceSessionId,
        targetPresetId: request.targetPresetId,
        request: request.request,
        kind: request.kind,
        baseRevision: request.baseRevision,
        baselinePresets,
        baselineNodes: blueprint.nodes.map(({ id, type, value, source, status }) => ({ id, type, value, source, status })),
        baselineSkills: blueprint.runtime.skills.map(skill => ({ ...skill, invocation: { ...skill.invocation } })),
        baselineDelegations: blueprint.runtime.delegations.map(delegation => ({ ...delegation })),
        candidate,
        maxRepairAttempts: this.config.capabilityRepairAttempts ?? DEFAULT_CAPABILITY_REPAIR_ATTEMPTS,
        state: 'started',
      }
      const seq = agent.session.append('blueprint/capability-authoring', data).seq
      startAppended = true
      await this.ctx.sessions.flush(agent.session)
      return { seq, data }
    } catch (error) {
      if (!startAppended) {
        if (preset !== undefined && candidate !== undefined) {
          try {
            const candidateTreeDigest = await this.fenceCapabilityTransaction(preset, candidate)
            await this.discardCapabilityTransaction(preset, candidate, candidateTreeDigest)
            await this.cleanupCapabilityTransaction(preset, candidate)
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              'blueprint-adapter: capability start failed and its unadopted candidate could not be safely discarded',
            )
          }
        }
        this.releaseCapabilityTarget(request.targetPresetId, sessionId)
      }
      throw error
    }
  }

  /** Validate one quiescent candidate, schedule a same-route repair, or publish its verified terminal. */
  private async settleCapabilityAuthoring(agent: Agent): Promise<void> {
    const record = latestCapabilityAuthoringRecord(agent)
    if (record === undefined || record.explicitlyEnded) return
    if (this.capabilityCancelRequestedEvent(agent, record) !== undefined) {
      await this.cancelCapabilityAuthoring(agent, record, false)
      return
    }
    await this.ensureCapabilityCandidateOverlay(String(agent.session.id), agent, record.data)
    const verifiedCheckpoint = this.capabilityVerifiedEvent(agent, record)
    if (verifiedCheckpoint !== undefined) {
      await this.publishVerifiedCapabilityCandidate(agent, record, verifiedCheckpoint)
      return
    }
    const settlement = this.capabilityAuthoringSettlement(agent)
    if (settlement === undefined) {
      await this.resumeCapabilityRepair(agent, record)
      return
    }
    const { end } = settlement
    const repairs = this.capabilityRepairEvents(agent, record)
    const existingRepair = repairs.findLast(repair => repair.data.turnEndSeq === end.seq)
    if (existingRepair !== undefined) {
      await this.enqueueCapabilityRepair(agent, record, existingRepair)
      return
    }
    const cancelled = end.data.reason.kind === 'aborted' && end.data.reason.reason.kind === 'user'
    if (cancelled) {
      const candidateDisposition = await this.discardCapabilityAuthoringCandidate(record)
      await this.publishCapabilityAuthoringTerminal(agent, record, end.seq, 'cancelled', {
        capabilityFailure: {
          turnEndSeq: end.seq,
          attempt: repairs.length,
          prerequisite: 'cancelled',
          message: 'Creator capability authoring was explicitly cancelled.',
        },
        candidateDisposition,
      })
      return
    }

    let verified: VerifiedCapabilityCandidate
    try {
      if (end.data.reason.kind !== 'completed' && !isRecoverableCapabilityInterruption(end.data.reason)) {
        throw this.capabilityVerificationError(
          'creator_turn',
          `Creator turn did not complete: ${canonicalJson(end.data.reason)}`,
        )
      }
      verified = await this.verifyCapabilityAuthoringCandidate(agent, record, end)
    } catch (error) {
      const failure = this.capabilityVerificationFailure(error)
      if (repairs.length < record.data.maxRepairAttempts) {
        await this.scheduleCapabilityRepair(agent, record, end, repairs.length + 1, failure)
        return
      }
      const candidateDisposition = await this.discardCapabilityAuthoringCandidate(record)
      await this.publishCapabilityAuthoringTerminal(agent, record, end.seq, 'failed', {
        capabilityFailure: {
          turnEndSeq: end.seq,
          attempt: repairs.length,
          prerequisite: failure.prerequisite,
          message: failure.message,
        },
        candidateDisposition,
      })
      return
    }

    await this.checkpointCapabilityVerification(agent, record, end.seq, verified)
    const checkpoint = this.capabilityVerifiedEvent(agent, record)
    if (checkpoint === undefined) throw new Error('blueprint-adapter: durable capability verification checkpoint is missing')
    await this.publishVerifiedCapabilityCandidate(agent, record, checkpoint)
  }

  /** Retry verified filesystem publication internally, then fail closed on the unchanged formal baseline. */
  private async publishVerifiedCapabilityCandidate(
    agent: Agent,
    record: CapabilityAuthoringRecord,
    checkpoint: CapabilityVerifiedRecord,
  ): Promise<void> {
    let candidateDisposition: BlueprintCapabilityCandidateDisposition | undefined
    let publicationError: unknown
    for (let attempt = 0; attempt <= record.data.maxRepairAttempts; attempt += 1) {
      try {
        candidateDisposition = await this.commitCapabilityAuthoringCandidate(
          record,
          checkpoint.data.candidateTreeDigest,
        )
        break
      } catch (error) {
        publicationError = error
      }
    }
    if (candidateDisposition === undefined) {
      let recovery: AgentPresetTransactionRecovery | undefined
      try {
        recovery = await this.recoverCapabilityAuthoringCandidate(record.data)
      } catch (error) {
        publicationError = error
      }
      if (recovery?.state === 'committed') {
        candidateDisposition = recovery.disposition
      } else if (recovery?.state === 'discarded') {
        candidateDisposition = recovery.disposition
      } else if (recovery?.state === 'active') {
        candidateDisposition = await this.discardCapabilityAuthoringCandidate(record)
      } else {
        candidateDisposition = await this.discardFailedCapabilityPublication(
          record,
          checkpoint.data.candidateTreeDigest,
        )
        if (candidateDisposition.candidateTreeDigest !== checkpoint.data.candidateTreeDigest) {
          throw new Error('blueprint-adapter: verified capability candidate changed after publication attempts')
        }
      }
    }
    if (candidateDisposition.disposition === 'discarded') {
      publicationError ??= new Error('Verified candidate publication was durably abandoned before terminal recovery.')
      await this.publishCapabilityAuthoringTerminal(
        agent,
        record,
        checkpoint.data.turnEndSeq,
        'failed',
        {
          capabilityFailure: {
            turnEndSeq: checkpoint.data.turnEndSeq,
            attempt: this.capabilityRepairEvents(agent, record).length,
            prerequisite: 'commit',
            message: `Verified candidate publication remained unavailable: ${String(publicationError)}`,
          },
          candidateDisposition,
        },
      )
      return
    }
    await this.publishCapabilityAuthoringTerminal(
      agent,
      record,
      checkpoint.data.turnEndSeq,
      'completed',
      {
        ...(checkpoint.data.kind === 'skill'
          ? { skillEvidence: checkpoint.data.skillEvidence }
          : { subagentEvidence: checkpoint.data.subagentEvidence }),
        candidateDisposition,
      },
    )
  }

  private capabilityAuthoringSettlement(agent: Agent): CapabilityAuthoringSettlement | undefined {
    const record = latestCapabilityAuthoringRecord(agent)
    if (record === undefined || record.explicitlyEnded) return undefined
    const repair = this.capabilityRepairEvents(agent, record).at(-1)
    const messageId = repair?.data.repairMessageId ?? capabilityAuthoringWakeMessageId(record)
    const delivery = capabilityMessageDelivery(agent.session.events, messageId)
    if (delivery?.state !== 'claimed' || delivery.turn === undefined || delivery.claimSeq === undefined) return undefined
    const claimSeq = delivery.claimSeq
    const end = agent.session.events.find(event => event.type === 'turn/end'
      && event.data.turn === delivery.turn && event.seq > claimSeq)
    if (end?.type !== 'turn/end') return undefined
    return { record, end }
  }

  /** Return this lifecycle's repair checkpoints in durable order. */
  private capabilityRepairEvents(agent: Agent, record: CapabilityAuthoringRecord): CapabilityRepairRecord[] {
    return agent.session.events.flatMap(event => event.type === 'blueprint/capability-repair'
      && event.data.startSeq === record.seq && event.data.routeId === record.data.routeId
      ? [{ seq: event.seq, data: event.data }]
      : [])
  }

  /** Resolve the sole durable user cancellation request for this lifecycle. */
  private capabilityCancelRequestedEvent(
    agent: Agent,
    record: CapabilityAuthoringRecord,
  ): CapabilityCancelRequestedRecord | undefined {
    const requests = agent.session.events.flatMap(event => event.type === 'blueprint/capability-cancel-requested'
      && event.data.startSeq === record.seq && event.data.routeId === record.data.routeId
      ? [{ seq: event.seq, data: event.data }]
      : [])
    if (requests.length > 1) {
      throw new Error('blueprint-adapter: capability lifecycle has duplicate cancellation requests')
    }
    return requests[0]
  }

  /** Flush user cancellation authority before aborting or retracting Creator work. */
  private async checkpointCapabilityAuthoringCancellation(
    agent: Agent,
    record: CapabilityAuthoringRecord,
  ): Promise<CapabilityCancelRequestedRecord> {
    const existing = this.capabilityCancelRequestedEvent(agent, record)
    if (existing !== undefined) return existing
    const event = agent.session.append('blueprint/capability-cancel-requested', {
      routeId: record.data.routeId,
      startSeq: record.seq,
    })
    await this.ctx.sessions.flush(agent.session)
    return { seq: event.seq, data: event.data }
  }

  /** Remove only pending inputs owned by one capability lifecycle. */
  private removeCapabilityAuthoringInputs(agent: Agent, record: CapabilityAuthoringRecord): void {
    const ids = [
      capabilityAuthoringWakeMessageId(record),
      ...this.capabilityRepairEvents(agent, record).map(repair => repair.data.repairMessageId),
    ]
    for (const id of ids) agent.inbox.remove(id)
  }

  /** Checkpoint cancellation, then stop only a currently claimed lifecycle turn. */
  private async cancelCapabilityAuthoring(
    agent: Agent,
    record: CapabilityAuthoringRecord,
    checkpoint: boolean,
  ): Promise<void> {
    if (checkpoint) await this.checkpointCapabilityAuthoringCancellation(agent, record)
    else if (this.capabilityCancelRequestedEvent(agent, record) === undefined) {
      throw new Error('blueprint-adapter: capability cancellation has no durable request')
    }
    const repair = this.capabilityRepairEvents(agent, record).at(-1)
    const currentId = repair?.data.repairMessageId ?? capabilityAuthoringWakeMessageId(record)
    const delivery = capabilityMessageDelivery(agent.session.events, currentId)
    const settled = this.capabilityAuthoringSettlement(agent)
    const ownsOpenTurn = delivery?.state === 'claimed' && delivery.turn !== undefined
      && delivery.claimSeq !== undefined && settled === undefined && agent.status === 'running'
    this.removeCapabilityAuthoringInputs(agent, record)
    if (ownsOpenTurn) agent.cancel({ kind: 'user' }, { keepInbox: true })
    await this.ctx.sessions.flush(agent.session)
    if (ownsOpenTurn) await agent.whenIdle()
    await this.finishCapabilityAuthoringCancellation(agent, record)
  }

  /** Discard an unpublished candidate and close one durably cancelled lifecycle. */
  private async finishCapabilityAuthoringCancellation(
    agent: Agent,
    expected: CapabilityAuthoringRecord,
  ): Promise<void> {
    const record = latestCapabilityAuthoringRecord(agent)
    if (record === undefined || record.explicitlyEnded) return
    if (record.seq !== expected.seq || record.data.routeId !== expected.data.routeId
      || this.capabilityCancelRequestedEvent(agent, record) === undefined) {
      throw new Error('blueprint-adapter: capability cancellation no longer binds the active lifecycle')
    }
    this.removeCapabilityAuthoringInputs(agent, record)
    await this.ctx.sessions.flush(agent.session)
    const turnEndSeq = this.capabilityAuthoringSettlement(agent)?.end.seq ?? record.seq
    const candidateDisposition = await this.discardCapabilityAuthoringCandidate(record)
    await this.publishCapabilityAuthoringTerminal(agent, record, turnEndSeq, 'cancelled', {
      capabilityFailure: {
        turnEndSeq,
        attempt: this.capabilityRepairEvents(agent, record).length,
        prerequisite: 'cancelled',
        message: 'User cancelled capability authoring; the unpublished candidate was discarded.',
      },
      candidateDisposition,
    })
  }

  /** Resolve the sole pre-publication verification checkpoint for this lifecycle. */
  private capabilityVerifiedEvent(
    agent: Agent,
    record: CapabilityAuthoringRecord,
  ): CapabilityVerifiedRecord | undefined {
    const checkpoints = agent.session.events.flatMap(event => event.type === 'blueprint/capability-verified'
      && event.data.startSeq === record.seq && event.data.routeId === record.data.routeId
      ? [{ seq: event.seq, data: event.data }]
      : [])
    if (checkpoints.length > 1) {
      throw new Error('blueprint-adapter: capability lifecycle has duplicate verification checkpoints')
    }
    const checkpoint = checkpoints[0]
    if (checkpoint !== undefined && checkpoint.data.kind !== record.data.kind) {
      throw new Error('blueprint-adapter: capability verification kind differs from its lifecycle')
    }
    return checkpoint
  }

  /** Flush fresh runtime proof before any formal preset tree is moved. */
  private async checkpointCapabilityVerification(
    agent: Agent,
    record: CapabilityAuthoringRecord,
    turnEndSeq: number,
    verified: VerifiedCapabilityCandidate,
  ): Promise<CapabilityVerifiedRecord> {
    let data: BlueprintCapabilityVerifiedEvent
    if (verified.evidence.skillEvidence !== undefined) {
      data = {
        routeId: record.data.routeId,
        startSeq: record.seq,
        turnEndSeq,
        candidateTreeDigest: verified.candidateTreeDigest,
        kind: 'skill',
        skillEvidence: verified.evidence.skillEvidence,
      }
    } else if (verified.evidence.subagentEvidence !== undefined) {
      data = {
        routeId: record.data.routeId,
        startSeq: record.seq,
        turnEndSeq,
        candidateTreeDigest: verified.candidateTreeDigest,
        kind: 'subagent',
        subagentEvidence: verified.evidence.subagentEvidence,
      }
    } else {
      throw new Error('blueprint-adapter: verified capability has no lane evidence')
    }
    const existing = this.capabilityVerifiedEvent(agent, record)
    if (existing !== undefined) {
      if (canonicalJson(existing.data) !== canonicalJson(data)) {
        throw new Error('blueprint-adapter: capability verification checkpoint changed during replay')
      }
      return existing
    }
    const event = agent.session.append('blueprint/capability-verified', data)
    await this.ctx.sessions.flush(agent.session)
    return { seq: event.seq, data: event.data }
  }

  /** Convert an internal validation miss to its typed private repair fact. */
  private capabilityVerificationError(
    prerequisite: CapabilityVerificationFailure['prerequisite'],
    message: string,
  ): CapabilityVerificationError {
    return new CapabilityVerificationError({ prerequisite, message })
  }

  /** Preserve typed validation diagnostics and classify unexpected verifier failures as projection failures. */
  private capabilityVerificationFailure(error: unknown): CapabilityVerificationFailure {
    return error instanceof CapabilityVerificationError
      ? error.failure
      : { prerequisite: 'projection', message: String(error) }
  }

  /** Resume a checkpointed repair delivery, or the deterministic first authoring wake. */
  private async resumeCapabilityRepair(agent: Agent, record: CapabilityAuthoringRecord): Promise<void> {
    const repair = this.capabilityRepairEvents(agent, record).at(-1)
    if (repair === undefined) {
      await this.ensureCapabilityAuthoringWake(agent, record)
      return
    }
    await this.enqueueCapabilityRepair(agent, record, repair)
  }

  /** Deliver the initial Creator task exactly once after candidate isolation and guidance are installed. */
  private async ensureCapabilityAuthoringWake(agent: Agent, record: ActiveCapabilityAuthoring): Promise<void> {
    const repairs = this.capabilityRepairEvents(agent, { ...record, explicitlyEnded: false })
    if (repairs.length > 0) {
      await this.enqueueCapabilityRepair(agent, { ...record, explicitlyEnded: false }, repairs.at(-1) as CapabilityRepairRecord)
      return
    }
    const id = capabilityAuthoringWakeMessageId(record)
    if (this.capabilityMessageWasDelivered(agent, id)) return
    const sameSource = String(agent.session.id) === record.data.sourceSessionId
    agent.followup(freezeMessage({
      id,
      role: 'user',
      content: [{ type: 'text', text: [
        `为现有 preset ${record.data.targetPresetId} 补充能力：${record.data.request}`,
        `需要的 authoring 类型：${record.data.kind}。`,
        '这是隔离 candidate。先用 preset_resolve 获取唯一可写路径，只修改该 candidate，保留无关配置，并用 preset_validate 验证。',
      ].join('\n') }],
      source: sameSource
        ? {
          kind: 'blueprint-capability-authoring',
          routeId: record.data.routeId,
          startSeq: record.seq,
          presentation: 'internal',
        }
        : { kind: 'plugin', plugin: 'blueprint-adapter' },
    }))
    await this.ctx.sessions.flush(agent.session)
  }

  /** Check the durable inbox insertion receipt, including an item already claimed by a turn. */
  private capabilityMessageWasDelivered(agent: Agent, id: MessageId): boolean {
    const delivery = capabilityMessageDelivery(
      agent.session.events.slice(agent.session.header.seedLength ?? 0),
      id,
    )
    return delivery?.state === 'pending' || delivery?.state === 'claimed'
  }

  /** Persist one failed verification before privately waking the same Creator for repair. */
  private async scheduleCapabilityRepair(
    agent: Agent,
    record: CapabilityAuthoringRecord,
    end: Extract<SessionEvent, { type: 'turn/end' }>,
    attempt: number,
    failure: CapabilityVerificationFailure,
  ): Promise<void> {
    const preset = await this.ctx.agentPresets.resolve(record.data.targetPresetId)
    const candidateTreeDigest = await this.fenceCapabilityTransaction(preset, record.data.candidate)
    const repairMessageId = MessageId(`blueprint-capability-repair:${createHash('sha256')
      .update(JSON.stringify([record.data.routeId, record.seq, attempt])).digest('hex')}`)
    const event = agent.session.append('blueprint/capability-repair', {
      routeId: record.data.routeId,
      startSeq: record.seq,
      turnEndSeq: end.seq,
      attempt,
      prerequisite: failure.prerequisite,
      message: failure.message,
      candidateTreeDigest,
      repairMessageId,
    })
    await this.ctx.sessions.flush(agent.session)
    await this.enqueueCapabilityRepair(agent, record, { seq: event.seq, data: event.data })
  }

  /** Recover one repair event's deterministic private Creator input without duplicating a turn. */
  private async enqueueCapabilityRepair(
    agent: Agent,
    record: CapabilityAuthoringRecord,
    repair: CapabilityRepairRecord,
  ): Promise<void> {
    if (this.capabilityMessageWasDelivered(agent, repair.data.repairMessageId)) return
    const laterRepair = this.capabilityRepairEvents(agent, record)
      .some(candidate => candidate.seq > repair.seq)
    if (laterRepair) return
    agent.followup(freezeMessage({
      id: repair.data.repairMessageId,
      role: 'user',
      content: [{ type: 'text', text: [
        `Candidate validation attempt ${String(repair.data.attempt)} failed at ${repair.data.prerequisite}.`,
        repair.data.message,
        'Repair the same isolated candidate for this route. Do not create or copy another preset. Run preset_validate, then finish the turn for Host re-verification.',
      ].join('\n') }],
      source: {
        kind: 'blueprint-capability-repair',
        routeId: record.data.routeId,
        startSeq: record.seq,
        attempt: repair.data.attempt,
        prerequisite: repair.data.prerequisite,
        presentation: 'internal',
      },
    }))
    await this.ctx.sessions.flush(agent.session)
  }

  /** Fresh-mount and fully project one fenced candidate without publishing it. */
  private async verifyCapabilityAuthoringCandidate(
    creator: Agent,
    record: CapabilityAuthoringRecord,
    end: Extract<SessionEvent, { type: 'turn/end' }>,
  ): Promise<VerifiedCapabilityCandidate> {
    const formal = await this.ctx.agentPresets.resolve(record.data.targetPresetId)
    const candidate = await this.resolveCapabilityTransaction(formal, record.data.candidate)
    let candidateTreeDigest: string
    let candidateComposition: string
    let compositionDelta: CapabilityCompositionDelta
    try {
      candidateTreeDigest = await this.fenceCapabilityTransaction(formal, record.data.candidate)
      await this.assertFormalCapabilityBaseline(record.data)
      const baselineComposition = await readFile(formal.path, 'utf8')
      candidateComposition = await readFile(candidate.path, 'utf8')
      compositionDelta = assertCapabilityCompositionDelta(
        baselineComposition,
        candidateComposition,
        record.data.kind,
      )
      const authorityTreeDigest = await this.fenceCapabilityTransaction(formal, record.data.candidate)
      if (authorityTreeDigest !== candidateTreeDigest) {
        throw new Error('candidate changed during pre-mount authority validation')
      }
    } catch (error) {
      throw this.capabilityVerificationError('candidate_delta', String(error))
    }
    const source = this.ctx.sessions.get(record.data.sourceSessionId as SessionId)
    const cwd = source?.header.cwd ?? creator.session.header.cwd ?? process.cwd()
    const verificationSessionId = `blueprint-${record.data.kind}-verification-${randomUUID()}` as SessionId
    let handle: Awaited<ReturnType<typeof this.ctx.agents.create>>
    try {
      handle = await this.ctx.agents.create({
        sessionId: verificationSessionId,
        meta: { cwd, agentPreset: record.data.targetPresetId },
        setup: async (agentCtx) => { await this.ctx.agentPresets.mountIsolated(agentCtx, candidate) },
      })
    } catch (error) {
      throw this.capabilityVerificationError('fresh_mount', String(error))
    }
    try {
      let blueprint: Blueprint
      let assembly: Awaited<ReturnType<BlueprintAdapter['assembly']>>
      let liveSkills: BlueprintRuntimeSkill[]
      try {
        blueprint = await this.project(candidate, candidateComposition, { cwd, agent: handle.agent })
        assembly = await this.assembly(record.data.targetPresetId, handle.agent)
        liveSkills = (await this.skillProjection(record.data.targetPresetId, cwd, handle.agent)).runtime
      } catch (error) {
        throw this.capabilityVerificationError('projection', String(error))
      }
      let admittedNodeIds: Set<string>
      let evidence: CapabilityAuthoringTerminalEvidence
      let treeDelta: CapabilityCandidateTreeDelta
      const sessionPresetId = handle.agent.session.header.agentPreset
      const composedPresetId = this.ctx.agentPresets.composedPreset(handle.agent.ctx)
      if (record.data.kind === 'skill') {
        const addedSkills = exactAdditions(record.data.baselineSkills, blueprint.runtime.skills, skill => skill.name, 'Skill')
        const addedDelegations = exactAdditions(
          record.data.baselineDelegations, blueprint.runtime.delegations, row => row.rowId, 'delegation',
        )
        if (addedSkills.length !== 1 || addedDelegations.length !== 0
          || addedSkills.some(skill => skill.scope !== 'preset'
            || (!skill.invocation.modelInvocable && !skill.invocation.userInvocable))) {
          throw this.capabilityVerificationError(
            'candidate_delta',
            `Skill authoring requires exactly one callable preset Skill and no delegation delta; found ${String(addedSkills.length)} Skills and ${String(addedDelegations.length)} delegations.`,
          )
        }
        const newSkill = addedSkills[0]
        if (newSkill === undefined) {
          throw this.capabilityVerificationError('candidate_delta', 'Skill authoring produced no new Skill.')
        }
        if (compositionDelta.kind !== 'skill') {
          throw this.capabilityVerificationError('candidate_delta', 'Skill runtime evidence differs from its composition authority proof.')
        }
        admittedNodeIds = new Set(addedSkills.map(skill => `capability:skill:${skill.name}`))
        treeDelta = { kind: 'skill', skillName: newSkill.name }
        this.assertCapabilityCandidateNodeDelta(record.data, blueprint, admittedNodeIds)
        const verification = validateRuntimeConformance({
          presetId: record.data.targetPresetId,
          sessionId: String(verificationSessionId),
          expectedRevision: blueprint.revision,
          expectedBlueprint: blueprint,
          expectedAssembly: assembly,
          liveAssembly: assembly,
          ...(sessionPresetId === undefined ? {} : { sessionPresetId }),
          ...(composedPresetId === undefined ? {} : { composedPresetId }),
          expectedPermissions: blueprint.runtime.permissions,
          livePermissions: this.permissions(handle.agent),
          liveSkills,
          liveDelegationProviders: this.ctx.subagents.list(),
        })
        if (!verification.valid || addedSkills.some(skill => !verification.skills.evidence.some(item => (
          item.name === skill.name && item.liveDefinitionDigest === skill.definitionDigest && item.status === 'pass'
        )))) {
          throw this.capabilityVerificationError('runtime_conformance', 'Fresh Session Skill runtime conformance failed.')
        }
        if (addedSkills.some(skill => !blueprint.nodes.some(node => node.id === `capability:skill:${skill.name}`
          && node.type === 'capability' && node.source === 'preset' && node.status === 'active'))) {
          throw this.capabilityVerificationError('projection', 'Verified Skill has no active Blueprint capability.')
        }
        const loaded = await this.ctx.tools.execute({
          callId: CallId(`blueprint-skill-verification-${randomUUID()}`),
          name: 'skill',
          arguments: { name: newSkill.name },
          agent: handle.agent,
          signal: new AbortController().signal,
        })
        if (loaded.isError) {
          throw this.capabilityVerificationError('runtime_conformance', 'Fresh Session could not load the authored Skill body.')
        }
        evidence = {
          skillEvidence: {
            turnEndSeq: end.seq,
            revision: blueprint.revision,
            skills: addedSkills.map(({ name, definitionDigest, invocation }) => ({ name, definitionDigest, invocation })),
            verification,
          },
        }
      } else {
        const addedSkills = exactAdditions(record.data.baselineSkills, blueprint.runtime.skills, skill => skill.name, 'Skill')
        const addedDelegations = exactAdditions(
          record.data.baselineDelegations, blueprint.runtime.delegations, row => row.rowId, 'delegation',
        )
        if (addedSkills.length !== 0 || addedDelegations.length !== 1
          || addedDelegations.some(row => !row.enabled || !row.providerAvailable)) {
          throw this.capabilityVerificationError(
            'candidate_delta',
            `Subagent authoring requires exactly one enabled delegation and no Skill delta; found ${String(addedDelegations.length)} delegations and ${String(addedSkills.length)} Skills.`,
          )
        }
        const newDelegation = addedDelegations[0]
        if (newDelegation === undefined || compositionDelta.kind !== 'subagent'
          || compositionDelta.rowId !== newDelegation.rowId
          || compositionDelta.configDigest !== newDelegation.configDigest) {
          throw this.capabilityVerificationError(
            'candidate_delta',
            'Fresh Session delegation evidence differs from its composition authority proof.',
          )
        }
        admittedNodeIds = new Set(addedDelegations.map(row => `capability:delegation:${row.rowId}`))
        treeDelta = compositionDelta
        this.assertCapabilityCandidateNodeDelta(record.data, blueprint, admittedNodeIds)
        const verification = validateRuntimeConformance({
          presetId: record.data.targetPresetId,
          sessionId: String(verificationSessionId),
          expectedRevision: blueprint.revision,
          expectedBlueprint: blueprint,
          expectedAssembly: assembly,
          liveAssembly: assembly,
          ...(sessionPresetId === undefined ? {} : { sessionPresetId }),
          ...(composedPresetId === undefined ? {} : { composedPresetId }),
          expectedPermissions: blueprint.runtime.permissions,
          livePermissions: this.permissions(handle.agent),
          liveSkills,
          liveDelegationProviders: this.ctx.subagents.list(),
        })
        if (!verification.valid || addedDelegations.some(row => !verification.delegations.evidence.some(item => (
          item.rowId === row.rowId && item.status === 'pass'
        )))) {
          throw this.capabilityVerificationError('runtime_conformance', 'Fresh Session delegation runtime conformance failed.')
        }
        if (addedDelegations.some(row => !blueprint.nodes.some(node => node.id === `capability:delegation:${row.rowId}`
          && node.type === 'capability' && node.source === 'preset' && node.status === 'active'))) {
          throw this.capabilityVerificationError('projection', 'Verified delegation has no active Blueprint capability.')
        }
        evidence = {
          subagentEvidence: {
            turnEndSeq: end.seq,
            revision: blueprint.revision,
            delegations: addedDelegations,
            verification,
          },
        }
      }
      const afterVerification = await this.fenceCapabilityTransaction(formal, record.data.candidate)
      if (afterVerification !== candidateTreeDigest) {
        throw this.capabilityVerificationError('candidate_delta', 'Candidate changed during fresh runtime verification.')
      }
      try {
        await assertCapabilityPresetTreeDelta(
          formal,
          candidate,
          record.data.candidate,
          candidateTreeDigest,
          treeDelta,
        )
      } catch (error) {
        throw this.capabilityVerificationError('candidate_delta', String(error))
      }
      await this.assertFormalCapabilityBaseline(record.data)
      return { evidence, candidateTreeDigest }
    } finally {
      try {
        await this.ctx.sessions.flush(handle.agent.session)
      } finally {
        await handle.dispose()
      }
    }
  }

  /** Prove every formal preset remains byte-for-byte and metadata-identical before publication. */
  private async assertFormalCapabilityBaseline(
    start: Extract<BlueprintCapabilityAuthoringEvent, { state: 'started' }>,
  ): Promise<void> {
    const current = await this.capabilityPresetRoster()
    if (canonicalJson(current) !== canonicalJson(start.baselinePresets)) {
      throw new Error('formal preset roster changed while the isolated capability candidate was active')
    }
  }

  /** Prove a candidate projection preserves all baseline nodes and adds only admitted capability nodes. */
  private assertCapabilityCandidateNodeDelta(
    start: Extract<BlueprintCapabilityAuthoringEvent, { state: 'started' }>,
    blueprint: Blueprint,
    admittedNodeIds: ReadonlySet<string>,
  ): void {
    const baseline = new Map(start.baselineNodes.map(node => [node.id, node]))
    const current = new Map(blueprint.nodes.map(({ id, type, value, source, status }) => (
      [id, { id, type, value, source, status }] as const
    )))
    for (const [nodeId, node] of baseline) {
      if (canonicalJson(current.get(nodeId)) !== canonicalJson(node)) {
        throw this.capabilityVerificationError(
          'candidate_delta',
          `Capability candidate changed or removed unrelated node ${JSON.stringify(nodeId)}.`,
        )
      }
    }
    for (const nodeId of current.keys()) {
      if (!baseline.has(nodeId) && !admittedNodeIds.has(nodeId)) {
        throw this.capabilityVerificationError(
          'candidate_delta',
          `Capability candidate added unrelated node ${JSON.stringify(nodeId)}.`,
        )
      }
    }
    if ([...admittedNodeIds].some(nodeId => !current.has(nodeId))) {
      throw this.capabilityVerificationError('projection', 'Candidate evidence does not match its projected capability.')
    }
  }

  /** Commit a still-fenced verified candidate and make only future Sessions see its generation. */
  private async commitCapabilityAuthoringCandidate(
    record: CapabilityAuthoringRecord,
    candidateTreeDigest: string,
  ): Promise<BlueprintCapabilityCandidateDisposition> {
    const recovery = await this.recoverCapabilityAuthoringCandidate(record.data)
    if (recovery.state === 'committed') return recovery.disposition
    if (recovery.state === 'discarded') {
      throw new Error('blueprint-adapter: discarded capability candidate cannot be committed')
    }
    const preset = await this.ctx.agentPresets.resolve(record.data.targetPresetId)
    const currentTreeDigest = await this.fenceCapabilityTransaction(preset, record.data.candidate)
    if (currentTreeDigest !== candidateTreeDigest) {
      throw new Error('blueprint-adapter: verified capability candidate changed before commit')
    }
    return await this.publishCapabilityTransaction(preset, record.data.candidate, candidateTreeDigest)
  }

  /** Prepare discard evidence while leaving cleanup behind the durable user terminal. */
  private async discardCapabilityAuthoringCandidate(
    record: CapabilityAuthoringRecord,
  ): Promise<BlueprintCapabilityCandidateDisposition> {
    const recovery = await this.recoverCapabilityAuthoringCandidate(record.data)
    if (recovery.state === 'discarded') return recovery.disposition
    if (recovery.state === 'committed') {
      throw new Error('blueprint-adapter: a committed capability candidate cannot be discarded')
    }
    const preset = await this.ctx.agentPresets.resolve(record.data.targetPresetId)
    const candidateTreeDigest = await this.fenceCapabilityTransaction(preset, record.data.candidate)
    return {
      transactionId: record.data.candidate.transactionId,
      candidateTreeDigest,
      finalTreeDigest: record.data.candidate.baselineTreeDigest,
      disposition: 'discarded',
    }
  }

  /** Durably abandon only a verified publication that has not moved the formal baseline. */
  private async discardFailedCapabilityPublication(
    record: CapabilityAuthoringRecord,
    candidateTreeDigest: string,
  ): Promise<BlueprintCapabilityCandidateDisposition> {
    const preset = await this.ctx.agentPresets.resolve(record.data.targetPresetId)
    return await this.discardCapabilityTransaction(preset, record.data.candidate, candidateTreeDigest)
  }

  /** Backfill terminal surface closure for every same-source lifecycle retained in this Session. */
  private closeCapabilityAuthoringSurfaces(agent: Agent): boolean {
    let changed = false
    for (const record of capabilityAuthoringRecords(agent)) {
      if (this.closeCapabilityAuthoringSurface(agent, record)) changed = true
    }
    return changed
  }

  /** Replace settled same-source implementation turns with durable lifecycle-closure markers. */
  private closeCapabilityAuthoringSurface(agent: Agent, record: CapabilityAuthoringRecord): boolean {
    if (!record.explicitlyEnded || record.endSeq === undefined || record.outcome === undefined
      || String(agent.session.id) !== record.data.sourceSessionId) return false
    let changed = false
    const messageIds = [
      capabilityAuthoringWakeMessageId(record),
      ...this.capabilityRepairEvents(agent, record).map(repair => repair.data.repairMessageId),
    ]
    for (const messageId of messageIds) {
      const delivery = capabilityMessageDelivery(agent.session.events, messageId)
      if (delivery?.state !== 'claimed' || delivery.claimSeq === undefined || delivery.turn === undefined) continue
      const { claimSeq, turn } = delivery
      const id = capabilityAuthoringTerminalMessageId(record, turn)
      if (agent.session.events.some(event => event.type === 'user/message' && event.data.id === id)) continue
      const end = agent.session.events.find(event => event.type === 'turn/end'
        && event.data.turn === turn && event.seq > claimSeq)
      if (end?.type !== 'turn/end') continue
      const surfaceNodes = agent.session.surface.nodes
      const anchor = surfaceNodes.findIndex((seq) => {
        const event = agent.session.events[seq]
        return event?.type === 'user/message' && event.data.id === messageId
      })
      if (anchor < 0) continue
      const nodes: number[] = []
      for (const seq of surfaceNodes.slice(anchor)) {
        if (seq > end.seq) break
        nodes.push(seq)
      }
      const first = nodes[0]
      const last = nodes.at(-1)
      if (first === undefined || last === undefined) continue
      agent.session.append('user/message', freezeMessage({
        id,
        role: 'user',
        content: [{ type: 'text', text: [
          'A prior internal capability-configuration turn is closed.',
          JSON.stringify({ routeId: record.data.routeId, startSeq: record.seq, outcome: record.outcome }),
          'It no longer authorizes preset or candidate work. Treat later user input as a new ordinary request unless a new typed capability route starts another lifecycle.',
        ].join('\n') }],
        source: {
          kind: 'blueprint-capability-terminal',
          routeId: record.data.routeId,
          startSeq: record.seq,
          outcome: record.outcome,
          presentation: 'internal',
        },
      }), {
        surfaceOp: { op: 'replace', start: first, end: last },
        sourceEventSeqs: [record.endSeq, ...nodes],
      })
      changed = true
    }
    return changed
  }

  private async publishCapabilityAuthoringTerminal(
    agent: Agent,
    record: CapabilityAuthoringRecord,
    turnEndSeq: number,
    outcome: CapabilityAuthoringTerminal['outcome'],
    evidence: CapabilityAuthoringTerminalEvidence,
  ): Promise<void> {
    const settlement = this.capabilityAuthoringSettlement(agent)
    if (!(outcome === 'cancelled' && turnEndSeq === record.seq)
      && (settlement === undefined || settlement.record.seq !== record.seq
        || settlement.record.data.routeId !== record.data.routeId)) {
      throw new Error('blueprint-adapter: capability terminal settlement changed lifecycle')
    }
    if (!(outcome === 'cancelled' && turnEndSeq === record.seq)
      && settlement?.end.seq !== turnEndSeq) {
      throw new Error('blueprint-adapter: capability terminal must cite its settled Creator turn')
    }
    const terminalData: CapabilityAuthoringTerminal = {
      ...record.data,
      state: 'ended',
      startSeq: record.seq,
      outcome,
      ...(evidence.skillEvidence === undefined ? {} : { skillEvidence: evidence.skillEvidence }),
      ...(evidence.subagentEvidence === undefined ? {} : { subagentEvidence: evidence.subagentEvidence }),
      ...(evidence.capabilityFailure === undefined ? {} : { capabilityFailure: evidence.capabilityFailure }),
      ...(evidence.candidateDisposition === undefined ? {} : { candidateDisposition: evidence.candidateDisposition }),
    }
    const terminal = agent.session.append('blueprint/capability-authoring', terminalData)
    this.closeCapabilityAuthoringSurface(agent, {
      ...record,
      endSeq: terminal.seq,
      outcome,
      explicitlyEnded: true,
      terminal: terminalData,
    })
    await this.ctx.sessions.flush(agent.session)
    this.clearConversationBinding(String(agent.session.id), agent, 'capability-authoring')
    try {
      await this.finalizeCapabilityCandidateTerminal(record, evidence.candidateDisposition)
      try {
        await this.clearCapabilityCandidateOverlay(String(agent.session.id), agent)
      } catch (error) {
        this.ctx.logger.warn(`Capability candidate overlay cleanup failed: ${String(error)}`)
      }
    } finally {
      this.releaseCapabilityTarget(record.data.targetPresetId, String(agent.session.id))
    }
  }

  /** Settle and clean hidden filesystem state only after its source-visible terminal is durable. */
  private async finalizeCapabilityCandidateTerminal(
    record: CapabilityAuthoringRecord,
    disposition: BlueprintCapabilityCandidateDisposition | undefined,
  ): Promise<void> {
    if (disposition === undefined) return
    try {
      let recovery = await this.recoverCapabilityAuthoringCandidate(record.data)
      if (disposition.disposition === 'discarded' && recovery.state === 'active') {
        const preset = await this.ctx.agentPresets.resolve(record.data.targetPresetId)
        await this.discardCapabilityTransaction(
          preset,
          record.data.candidate,
          disposition.candidateTreeDigest,
        )
        recovery = await this.recoverCapabilityAuthoringCandidate(record.data)
      }
      if (recovery.state !== disposition.disposition
        || canonicalJson(recovery.disposition) !== canonicalJson(disposition)) {
        throw new Error('candidate settlement differs from its durable terminal evidence')
      }
      const preset = await this.ctx.agentPresets.resolve(record.data.targetPresetId)
      await this.cleanupCapabilityTransaction(preset, record.data.candidate)
    } catch (error) {
      this.ctx.logger.warn(`Capability candidate ${record.data.routeId} terminal cleanup failed: ${String(error)}`)
    }
  }

  /** Give one Creator a private candidate roster plus the minimum non-delegating authoring surface. */
  private async ensureCapabilityCandidateOverlay(
    sessionId: string,
    agent: Agent,
    context: Extract<BlueprintCapabilityAuthoringEvent, { state: 'started' }>,
  ): Promise<void> {
    this.reserveCapabilityTarget(context.targetPresetId, sessionId)
    const existing = this.capabilityCandidateOverlays.get(sessionId)
    if (existing !== undefined) {
      if (existing.agent !== agent) throw new Error('blueprint-adapter: capability candidate owner Agent changed')
      return
    }
    await this.recoverCapabilityAuthoringCandidate(context)
    const formal = await this.ctx.agentPresets.resolve(context.targetPresetId)
    const candidate = await this.resolveCapabilityTransaction(formal, context.candidate)
    const candidateRoot = dirname(candidate.path)
    const candidateEditable = candidate.path !== formal.path
    const safeNames = new Set([
      'preset_list', 'preset_read', 'preset_resolve', 'preset_validate',
      'read', 'glob', 'grep', 'skill',
      ...(candidateEditable ? ['write', 'edit'] : []),
    ])
    const inheritedNames = this.ctx.tools.schemas(agent).map(tool => tool.name)
    const deniedNames = inheritedNames.filter(name => name !== 'run_code' && !safeNames.has(name))
    const disposeOverlay = this.ctx.agentPresets.registerScopedOverlay(agent.ctx, candidate)
    let disposeRestriction: (() => void) | undefined
    let disposeGuard: (() => void) | undefined
    try {
      disposeRestriction = deniedNames.length === 0
        ? () => undefined
        : agent.ctx.tools.restrict({ deny: deniedNames })
      disposeGuard = agent.ctx.tools.guard((execution) => {
        if (execution.agent !== agent) return undefined
        if (!safeNames.has(execution.name)) {
          return 'This internal capability Creator may only use its isolated candidate authoring tools.'
        }
        if (execution.name !== 'write' && execution.name !== 'edit') return undefined
        if (!candidateEditable) return 'The verified candidate is no longer editable.'
        if (!isRecord(execution.arguments) || typeof execution.arguments['file_path'] !== 'string') {
          return 'Candidate writes require one explicit file_path.'
        }
        if (Object.keys(execution.arguments).some(key => key.includes('sandbox') || key.includes('approval'))) {
          return 'Candidate writes cannot request permission or sandbox escalation.'
        }
        const requested = execution.arguments['file_path']
        const target = resolve(agent.session.header.cwd ?? process.cwd(), requested)
        const fromCandidate = relative(candidateRoot, target)
        if (fromCandidate === '..' || fromCandidate.startsWith(`..${sep}`) || isAbsolute(fromCandidate)) {
          return 'Capability authoring writes must stay inside the isolated candidate returned by preset_resolve.'
        }
        return undefined
      })
    } catch (error) {
      disposeGuard?.()
      disposeRestriction?.()
      await disposeOverlay()
      throw error
    }
    let disposed = false
    this.capabilityCandidateOverlays.set(sessionId, {
      agent,
      dispose: async () => {
        if (disposed) return
        disposed = true
        disposeGuard()
        disposeRestriction()
        await disposeOverlay()
      },
    })
  }

  /** Hide every crash-recovery rename from formal preset readers. */
  private async recoverCapabilityAuthoringCandidate(
    context: Extract<BlueprintCapabilityAuthoringEvent, { state: 'started' }>,
  ): Promise<AgentPresetTransactionRecovery> {
    return await this.recoverCapabilityTransaction(context.targetPresetId, context.candidate)
  }

  /** Remove one Creator's scoped candidate and authoring restrictions. */
  private async clearCapabilityCandidateOverlay(sessionId: string, expectedAgent?: Agent): Promise<void> {
    const overlay = this.capabilityCandidateOverlays.get(sessionId)
    if (overlay === undefined || (expectedAgent !== undefined && overlay.agent !== expectedAgent)) return
    this.capabilityCandidateOverlays.delete(sessionId)
    await overlay.dispose()
  }

  /** Serialize an active capability route against ordinary writes to the formal target. */
  private reserveCapabilityTarget(targetPresetId: string, sessionId: string): void {
    const owner = this.capabilityTargetOwners.get(targetPresetId)
    if (owner !== undefined && owner !== sessionId) {
      throw new Error(`blueprint-adapter: preset ${JSON.stringify(targetPresetId)} already has an active capability configuration`)
    }
    this.capabilityTargetOwners.set(targetPresetId, sessionId)
  }

  /** Release only the exact Creator's formal-target lease after durable terminal publication. */
  private releaseCapabilityTarget(targetPresetId: string, sessionId: string): void {
    if (this.capabilityTargetOwners.get(targetPresetId) === sessionId) {
      this.capabilityTargetOwners.delete(targetPresetId)
    }
  }

  /** Install one durable-turn-aware construction guard for the Agent scope lifetime. */
  private ensureCapabilityRoutingGuard(agent: Agent): void {
    if (this.capabilityRoutingGuards.has(agent)) return
    const dispose = agent.ctx.tools.guard(execution => execution.agent === agent
      && execution.name !== RUN_CODE_NAME
      && execution.name !== BLUEPRINT_PROPOSAL_TOOL
      && execution.name !== BLUEPRINT_CAPABILITY_AUTHORING_TOOL
      && activeCapabilityRoutingTurn(agent)
      ? 'Add capability routing must settle through one typed Blueprint route before authoring starts.'
      : undefined)
    this.capabilityRoutingGuards.set(agent, dispose)
  }

  /** Capture exact roster metadata and content without requiring every broken row to be readable. */
  private async capabilityPresetRoster(): Promise<BlueprintCapabilityPresetBaseline[]> {
    const presets = await this.ctx.agentPresets.list()
    const baseline = await Promise.all(presets.map(async (preset) => {
      let compositionDigest: string | null
      try {
        compositionDigest = compositionRevision(await this.ctx.agentPresets.read(preset.id))
      } catch (error) {
        if (preset.broken === undefined) throw error
        compositionDigest = null
      }
      return capabilityPresetBaseline(preset, compositionDigest)
    }))
    return baseline.sort((left, right) => left.id.localeCompare(right.id))
  }

  /** Require a roster snapshot's target entry to describe the exact projected composition. */
  private assertRosterTargetMatchesBlueprint(
    roster: readonly BlueprintCapabilityPresetBaseline[],
    blueprint: Blueprint,
  ): void {
    const target = roster.find(preset => preset.id === blueprint.preset.id)
    if (target === undefined || target.broken !== undefined || target.compositionDigest !== blueprint.revision
      || target.trust !== blueprint.preset.trust || target.name !== blueprint.preset.name
      || target.description !== blueprint.preset.description) {
      throw new Error('capability authoring target roster entry changed during projection')
    }
  }

  /** Remove the exact scoped registrations for one live conversation. */
  private clearConversationBinding(
    sessionId: string,
    expectedAgent?: Agent,
    expectedMode?: ConversationBinding['mode'],
  ): void {
    const binding = this.conversationBindings.get(sessionId)
    if (binding === undefined || (expectedAgent !== undefined && binding.agent !== expectedAgent)
      || (expectedMode !== undefined && binding.mode !== expectedMode)) return
    if (this.deferredConversationClears.get(sessionId)?.binding === binding) {
      this.deferredConversationClears.delete(sessionId)
    }
    this.conversationBindings.delete(sessionId)
    binding.disposeContext()
    binding.disposeTools?.()
  }

  /** Retain one source-scoped typed route until the exact in-flight Add turn settles. */
  private deferConversationClearForCapabilityRoute(sessionId: string, agent: Agent): boolean {
    const binding = this.conversationBindings.get(sessionId)
    const start = agent.session.events.findLast(event => event.type === 'turn/start')
    if (binding?.agent !== agent || binding.mode !== 'blueprint' || start?.type !== 'turn/start'
      || !activeCapabilityRoutingTurn(agent)) return false
    this.deferredConversationClears.set(sessionId, { agent, binding, turn: start.data.turn })
    return true
  }

  /** Assemble through the same scoped prompt service used before a model step. */
  private async assembly(
    presetId: string,
    agent: Agent | undefined,
    standingKey?: AgentPresetProjectionSnapshot['standingKey'],
  ) {
    if (agent !== undefined) {
      const composed = this.ctx.agentPresets.composedPreset(agent.ctx)
      if (composed !== presetId) {
        throw new Error(`blueprint-adapter: agent runs preset ${JSON.stringify(composed)}, not ${JSON.stringify(presetId)}`)
      }
      return await this.ctx.systemPrompt.assemble(assembleContextFor(agent))
    }
    const scope = standingKey ?? await this.ctx.agentPresets.standingKeyFor(presetId)
    return await this.ctx.systemPrompt.assemble({ scope })
  }

  /** Resolve Skill definitions through the same scope chain the target Agent uses. */
  private async skillProjection(
    presetId: string,
    cwd: string,
    agent: Agent | undefined,
    standingKey?: AgentPresetProjectionSnapshot['standingKey'],
  ): Promise<{ nodes: BlueprintNode[]; runtime: BlueprintRuntimeSkill[] }> {
    const scope = agent ?? standingKey ?? await this.ctx.agentPresets.standingKeyFor(presetId)
    const registry = agent === undefined
      ? this.ctx.skills
      : this.ctx.agentPresets.serviceFor(agent, 'skills') ?? this.ctx.skills
    const snapshot = await registry.snapshot({ cwd, scope })
    if (!snapshot.complete) {
      throw new Error(`blueprint-adapter: scoped Skill catalog for preset ${JSON.stringify(presetId)} changed during projection`)
    }
    const globalSnapshot = await registry.snapshot({ cwd })
    if (!globalSnapshot.complete) {
      throw new Error('blueprint-adapter: inherited Skill catalog changed during projection')
    }
    const globalByName = new Map(globalSnapshot.skills.map(skill => [skill.name, skill]))
    const projected = await Promise.all(snapshot.skills.map(async (skill) => {
      const definition = await registry.get(skill.name, { cwd, scope })
      if (definition === undefined) {
        throw new Error(`blueprint-adapter: scoped Skill ${JSON.stringify(skill.name)} disappeared during projection`)
      }
      const global = globalByName.get(skill.name)
      const globalDefinition = global === undefined ? undefined : await registry.get(skill.name, { cwd })
      const definitionDigest = createHash('sha256').update(definition.content).digest('hex')
      const inherited = global !== undefined && globalDefinition !== undefined
        && global.provider === skill.provider
        && global.source === skill.source
        && global.description === skill.description
        && global.whenToUse === skill.whenToUse
        && sameInvocation(global.invocation, skill.invocation)
        && createHash('sha256').update(globalDefinition.content).digest('hex') === definitionDigest
      const runtime: BlueprintRuntimeSkill = {
        name: skill.name,
        description: skill.description,
        invocation: skill.invocation,
        scope: inherited ? 'inherited' : 'preset',
        provider: skill.provider,
        source: skill.source,
        definitionDigest,
      }
      const node: BlueprintNode = {
        id: `capability:skill:${skill.name}`,
        type: 'capability',
        value: {
          kind: 'skill',
          name: skill.name,
          description: skill.description,
          invocation: {
            modelInvocable: skill.invocation.modelInvocable,
            userInvocable: skill.invocation.userInvocable,
          },
          callable: skill.invocation.modelInvocable || skill.invocation.userInvocable,
          scope: runtime.scope,
        },
        source: inherited ? 'inherited' : 'preset',
        status: skill.invocation.modelInvocable || skill.invocation.userInvocable ? 'active' : 'inactive',
        editable: false,
        adapterRef: null,
      }
      return { node, runtime }
    }))
    return {
      nodes: projected.map(item => item.node),
      runtime: projected.map(item => item.runtime),
    }
  }

  /** Resolve future-session defaults or one live session's pinned access. */
  private permissions(agent: Agent | undefined): BlueprintRuntimeSnapshot['permissions'] {
    const service = this.ctx.get('permissionPresets')
    if (service === undefined) return null
    const preset = agent === undefined ? service.defaultPreset : service.current(agent.session.events)
    if (!service.names.includes(preset)) return { preset }
    const spec = service.resolve(preset)
    return { preset, sandbox: spec.sandbox, approval: spec.approval }
  }

  /** Resolve one successful Proposal Tool result as the sole content authority for Apply or Cancel. */
  private resolveDurableProposal(
    request: BlueprintApplyChangeSetRequest | BlueprintCancelChangeSetRequest,
  ): { session: Session; resultSeq: number; changeSet: BlueprintChangeSet } {
    if (request.sourceSessionId.trim() === '' || request.routeId.trim() === '' || request.changeSetId.trim() === '') {
      throw new Error('blueprint proposal authority: sourceSessionId, routeId, and changeSetId are required')
    }
    const session = this.ctx.sessions.get(request.sourceSessionId as SessionId)
    if (session === undefined) throw new Error('blueprint proposal authority: source Session is not available')
    const results = session.events.flatMap(event => event.type === 'tool/result'
      && String(event.data.message.source.callId) === request.changeSetId ? [event] : [])
    if (results.length !== 1) {
      throw new Error('blueprint proposal authority: expected exactly one durable Proposal Tool result')
    }
    const [result] = results
    if (result === undefined) {
      throw new Error('blueprint proposal authority: expected exactly one durable Proposal Tool result')
    }
    if ((result.data.message.content as readonly { isError?: boolean }[])[0]?.isError === true) {
      throw new Error('blueprint proposal authority: Proposal Tool result failed')
    }
    const call = session.events.find(event => event.seq < result.seq && event.type === 'tool/call'
      && String(event.data.callId) === request.changeSetId && event.data.name === BLUEPRINT_PROPOSAL_TOOL)
    if (call === undefined) throw new Error('blueprint proposal authority: matching Proposal Tool call is missing')
    const changeSet = parseDurableChangeSet((result.data.meta as Record<string, unknown> | undefined)?.['blueprintChangeSet'])
    if (changeSet.sourceSessionId !== request.sourceSessionId || changeSet.routeId !== request.routeId
      || changeSet.changeSetId !== request.changeSetId) {
      throw new Error('blueprint proposal authority: Proposal owner, route, or Change Set identity does not match')
    }
    const decision = session.events.find(event => event.seq < result.seq && event.type === 'blueprint/route-decision'
      && event.data.sourceSessionId === session.id && event.data.routeId === request.routeId
      && String(event.data.callId) === request.changeSetId && event.data.operation === 'modify-existing-agent'
      && event.data.targetPresetId === changeSet.presetId)
    if (decision === undefined) {
      throw new Error('blueprint proposal authority: matching source-owned route decision is missing')
    }
    if ('operations' in request) {
      const operations = blueprintChangeSetOperations(changeSet)
      if (request.presetId !== changeSet.presetId || request.baseRevision !== changeSet.revision
        || !sameBlueprintChangeSetOperations(request.operations, operations)) {
        throw new Error('blueprint proposal authority: Apply content differs from the durable Proposal')
      }
    }
    return { session, resultSeq: result.seq, changeSet }
  }

  /** Serialize every adapter-owned mutation of one preset across single and batch APIs. */
  private async withPresetUpdate<T>(presetId: string, operation: () => Promise<T>): Promise<T> {
    const capabilityOwner = this.capabilityTargetOwners.get(presetId)
    if (capabilityOwner !== undefined) {
      throw new Error(`blueprint-adapter: preset ${JSON.stringify(presetId)} is being configured by an isolated capability route`)
    }
    const prior = this.presetUpdates.get(presetId)
    const update = (prior === undefined ? Promise.resolve() : prior.catch(() => undefined))
      .then(operation)
    this.presetUpdates.set(presetId, update)
    try {
      return await update
    } finally {
      if (this.presetUpdates.get(presetId) === update) this.presetUpdates.delete(presetId)
    }
  }

  /** Resolve and revision-check a writable user preset. */
  private async writableComposition(presetId: string, revision: string): Promise<{
    preset: AgentPreset
    composition: string
  }> {
    const preset = await this.ctx.agentPresets.resolve(presetId)
    if (preset.trust !== 'user') throw new Error(`blueprint-adapter: preset ${JSON.stringify(presetId)} ships with the deployment and is read-only`)
    if (preset.broken !== undefined) throw new Error(`blueprint-adapter: preset ${JSON.stringify(presetId)} is broken: ${preset.broken}`)
    const composition = await this.ctx.agentPresets.read(presetId)
    if (compositionRevision(composition) !== revision) {
      throw new Error('blueprint-adapter: preset changed since Blueprint projection; re-read before writing')
    }
    return { preset, composition }
  }

  /** Publish one complete composition atomically with owner-only modes. */
  private async commit(preset: AgentPreset, composition: string): Promise<void> {
    await writeFileAtomic(preset.path, composition, { mode: 0o600, dirMode: 0o700 })
  }
}

function parseDurableChangeSet(value: unknown): BlueprintChangeSet {
  if (!isRecord(value) || typeof value['sourceSessionId'] !== 'string' || value['sourceSessionId'].trim() === ''
    || typeof value['routeId'] !== 'string' || value['routeId'].trim() === ''
    || typeof value['changeSetId'] !== 'string' || value['changeSetId'].trim() === ''
    || typeof value['presetId'] !== 'string' || value['presetId'].trim() === ''
    || typeof value['revision'] !== 'string' || value['revision'].trim() === ''
    || (value['kind'] !== 'direct-request' && value['kind'] !== 'structured-edit'
      && value['kind'] !== 'direct-edit-reconciliation')
    || !Array.isArray(value['proposals']) || value['proposals'].length === 0) {
    throw new Error('blueprint proposal authority: durable Proposal metadata is invalid')
  }
  for (const proposal of value['proposals']) {
    if (!isRecord(proposal) || typeof proposal['proposalId'] !== 'string' || proposal['proposalId'].trim() === ''
      || proposal['presetId'] !== value['presetId'] || proposal['revision'] !== value['revision']
      || typeof proposal['targetNodeId'] !== 'string' || proposal['targetNodeId'].trim() === ''
      || !isChangeOperation(proposal['operation'])
      || typeof proposal['impact'] !== 'string' || proposal['impact'].trim() === ''
      || proposal['currentValue'] === proposal['proposedValue']
      || (proposal['operation'] === 'setCapability'
        ? typeof proposal['currentValue'] !== 'boolean' || typeof proposal['proposedValue'] !== 'boolean'
        : typeof proposal['currentValue'] !== 'string' || typeof proposal['proposedValue'] !== 'string')) {
      throw new Error('blueprint proposal authority: durable Proposal item is invalid')
    }
  }
  return value as unknown as BlueprintChangeSet
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isChangeOperation(value: unknown): value is BlueprintChangeSet['proposals'][number]['operation'] {
  return value === 'updateIdentity' || value === 'updatePurpose' || value === 'updateBehavior'
    || value === 'setCapability' || value === 'updateOutput'
}

function validateReceiptIdentity(request: BlueprintValidateSessionRequest): {
  sourceSessionId: string
  routeId: string
  changeSetId: string
} | undefined {
  const {
    sourceSessionId,
    routeId,
    changeSetId,
  } = request as unknown as {
    sourceSessionId?: unknown
    routeId?: unknown
    changeSetId?: unknown
  }
  if (sourceSessionId === undefined && routeId === undefined && changeSetId === undefined) return undefined
  if (typeof sourceSessionId !== 'string' || typeof routeId !== 'string' || typeof changeSetId !== 'string') {
    throw new Error('blueprint-adapter: validation receipt identity requires sourceSessionId, routeId, and changeSetId together')
  }
  if (sourceSessionId.trim() === '' || routeId.trim() === '' || changeSetId.trim() === '') {
    throw new Error('blueprint-adapter: validation receipt identity fields must be non-empty')
  }
  return { sourceSessionId, routeId, changeSetId }
}

function sameProposalIdentity(
  value: { sourceSessionId: string; routeId: string; changeSetId: string },
  request: Pick<BlueprintApplyChangeSetRequest, 'sourceSessionId' | 'routeId' | 'changeSetId'>,
): boolean {
  return value.sourceSessionId === request.sourceSessionId && value.routeId === request.routeId
    && value.changeSetId === request.changeSetId
}

function proposalApplyReceipt(
  events: readonly SessionEvent[],
  request: Pick<BlueprintApplyChangeSetRequest, 'sourceSessionId' | 'routeId' | 'changeSetId'>,
): BlueprintApplyReceipt | undefined {
  for (const event of events) {
    if (event.type === 'blueprint/apply-result' && sameProposalIdentity({
      sourceSessionId: event.data.sourceSessionId,
      routeId: event.data.routeId,
      changeSetId: event.data.result.changeSetId,
    }, request)) return { ...event.data, terminalSeq: event.seq }
  }
  return undefined
}

function proposalCancellation(
  events: readonly SessionEvent[],
  request: Pick<BlueprintApplyChangeSetRequest, 'sourceSessionId' | 'routeId' | 'changeSetId'>,
): BlueprintProposalCancellation | undefined {
  for (const event of events) {
    if (event.type === 'blueprint/proposal-cancelled' && sameProposalIdentity(event.data, request)) return event.data
  }
  return undefined
}

function sameInvocation(
  left: { modelInvocable: boolean; userInvocable: boolean },
  right: { modelInvocable: boolean; userInvocable: boolean },
): boolean {
  return left.modelInvocable === right.modelInvocable && left.userInvocable === right.userInvocable
}

function delegationName(tool: string): string {
  if (tool === 'subagent') return 'Collaborating Agent'
  if (tool === 'subagent_fork') return 'Parallel Collaborating Agent'
  const subject = tool.replace(/^subagent[_-]?/u, '').replace(/[_-]+/gu, ' ').trim()
  return subject.length === 0 ? 'Collaborating Agent' : `${subject} Collaborating Agent`
}

export default BlueprintAdapter
