/** Interactive Blueprint UI assembly across existing Web Client slots. */
import type {
  ClientContext, ConversationSnapshot, PendingInteraction, SessionId, SteeringMessageNode, ToolCallBlock,
  UserMessageNode, WorkspaceId,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  BlueprintApplyReceipt, BlueprintCreatorAuthoringRoute, ConnectionHandle,
} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { BlueprintUiController } from './controller.ts'
import type {
  BlueprintAgentCatalog, BlueprintAgentOption, BlueprintCapabilityAuthoringStart,
  BlueprintCapabilityConversationStart, BlueprintCapabilityHandoff,
  BlueprintCapabilityObservation, BlueprintCreatorDraft, BlueprintCreatorObservation,
  BlueprintRemote, BlueprintUiState,
} from './controller.ts'
import type {
  BlueprintCreatorAssociationAnswer, BlueprintCreatorAuthoredPreset, BlueprintCreatorPresetCopy,
  BlueprintCreatorValidatedPreset,
} from './controller.ts'
import type { BlueprintInjected } from './slots.ts'
import { InMemoryBlueprintDemoAdapter } from './demo-adapter.ts'
import type { BlueprintDemoSeed } from './demo-adapter.ts'
import { DemoScenarioController } from './demo-scenario-controller.ts'
import type { BlueprintDemoFixtureBridge } from './demo-scenario-controller.ts'
import { createBlueprintTargetPreference } from './target-preference.ts'
import { prepareBlueprintTrialSession } from './trial-session.ts'
import { assertDirectEditEnqueued } from './direct-edit-enqueue.ts'
import {
  resolveCapabilityAuthoringExecution, resolveCapabilityAuthoringSourcePreset,
} from './capability-topology.ts'
import { BlueprintContextRestorePending } from './context-restore.ts'
import { BlueprintCapabilityComposerBlockProjection } from './capability-composer-block.ts'
import {
  BlueprintAgentRoster, BlueprintOverlay, BlueprintPanel, BlueprintProposalRow, BlueprintSelectedContext,
} from './BlueprintUi.tsx'
import { registerBlueprintRouteToolViews } from './BlueprintRouteRow.tsx'
import { registerBlueprintCapabilityRouteTurnPresentation } from './capability-route-turn-presentation.ts'
import { registerBlueprintCreatorTurnPresentation } from './creator-turn-presentation.ts'

export type { BlueprintInjected, BlueprintPanelProps } from './slots.ts'
export { BlueprintUiController }
export type {
  BlueprintAgentCatalog, BlueprintAgentCatalogSnapshot, BlueprintAgentOption, BlueprintRemote,
  BlueprintTrialRequest, BlueprintUiState,
} from './controller.ts'
export {
  InMemoryBlueprintDemoAdapter,
  type BlueprintDemoAdapterOptions,
  type BlueprintDemoSeed,
} from './demo-adapter.ts'

type RecoveredCreatorAuthoring = NonNullable<
  import('@deepseek-ai/dsh-api-remotes/client').BlueprintConversationContextResult['creatorAuthoring']
>
type RecoveredCapabilityAuthoring = NonNullable<
  import('@deepseek-ai/dsh-api-remotes/client').BlueprintConversationContextResult['capabilityAuthoring']
>
type RecoveredCapabilityAuthoringRecord = NonNullable<
  import('@deepseek-ai/dsh-api-remotes/client').BlueprintConversationContextResult['capabilityAuthoringRecord']
>

type BackgroundCapabilityRecovery = BlueprintCapabilityRecoveryCandidate & {
  creatorSessionId: SessionId
  observation: BlueprintCapabilityObservation
} & ({
  state: 'active'
  recovered: RecoveredCapabilityAuthoring
} | {
  state: 'terminal'
  record: RecoveredCapabilityAuthoringRecord
})

/**
 * Determine whether durable Creator context already owns one typed source route.
 * @param authoring - recovered Creator context.
 * @param sourceSessionId - source Session expected to own the route.
 * @param route - typed routing decision to compare.
 * @returns whether the durable context owns the exact source and route.
 */
export function creatorAuthoringOwnsRoute(
  authoring: RecoveredCreatorAuthoring,
  sourceSessionId: SessionId,
  route: BlueprintCreatorAuthoringRoute,
): boolean {
  return authoring.sourceSessionId === sourceSessionId && authoring.routeId === route.routeId
}

/** Minimum identity and source order used to collapse recovered Creator capability tasks. */
export interface BlueprintCapabilityRecoveryCandidate {
  creatorSessionId: string
  sourceSessionId: string
  routeId: string
  sourceRouteSeq?: number
}

/**
 * Keep the newest durable source interaction for each source Session.
 * Candidates without source evidence remain unresolved until their source Session is addressable.
 * @param candidates - recovered Creator records plus source Tool-result sequence when addressable.
 * @returns at most one candidate per source Session in first-source encounter order.
 */
export function latestCapabilityRecoveryCandidates<T extends BlueprintCapabilityRecoveryCandidate>(
  candidates: readonly T[],
): readonly T[] {
  const latest = new Map<string, T>()
  for (const candidate of candidates) {
    if (candidate.sourceRouteSeq === undefined) continue
    const current = latest.get(candidate.sourceSessionId)
    if (current === undefined || current.sourceRouteSeq === undefined
      || candidate.sourceRouteSeq > current.sourceRouteSeq) {
      latest.set(candidate.sourceSessionId, candidate)
    }
  }
  return [...latest.values()]
}

function dshAgentCatalog(api: ConnectionHandle['api']): BlueprintAgentCatalog {
  return {
    async list() {
      const response = await api.agentPresets.list({})
      if (!response.result.ok) throw new Error(response.result.error.message)
      const agents = response.result.value.presets.map((preset): BlueprintAgentOption => ({
        id: preset.id,
        label: preset.name ?? preset.id,
        trust: preset.trust,
        ...(preset.description === undefined ? {} : { description: preset.description }),
        ...(preset.broken === undefined ? {} : { broken: preset.broken }),
      }))
      const preferredPresetId = agents.some(agent => agent.id === 'competitive-research')
        ? 'competitive-research'
        : response.result.value.presets.find(preset => preset.isDefault)?.id
      return {
        agents,
        ...(preferredPresetId === undefined ? {} : { preferredPresetId }),
      }
    },
  }
}

/** Services required by the four Builder entries and the trial coordinator. */
export const inject = [
  'slots', 'remote', 'remote.blueprint', 'connection', 'sessions', 'workspaces', 'layout', 'conversation',
  'conversationEvents', 'locale',
]

/** Build-owned state injected before booting the real Web shell in Blueprint Demo mode. */
export interface BlueprintDemoBootstrap {
  seeds: readonly BlueprintDemoSeed[]
  preferredPresetId?: string
  /** Preset published only after the scripted Creator journey starts. */
  creatorScenario: BlueprintDemoSeed
}

interface BlueprintDemoWindow extends Window {
  __DSH_BLUEPRINT_DEMO__?: BlueprintDemoBootstrap
}

function demoFixtureBridge(): BlueprintDemoFixtureBridge | undefined {
  return (globalThis as typeof globalThis & { __dshBlueprintDemoFixture?: BlueprintDemoFixtureBridge })
    .__dshBlueprintDemoFixture
}

function currentDemoBootstrap(): BlueprintDemoBootstrap | undefined {
  if (typeof window === 'undefined' || typeof location === 'undefined') return undefined
  const query = new URLSearchParams(location.search)
  if (!query.has('fixture') || !query.has('blueprintDemo')) return undefined
  return (window as BlueprintDemoWindow).__DSH_BLUEPRINT_DEMO__
}

function trialWorkspace(ctx: ClientContext): WorkspaceId | undefined {
  const sessions = ctx.sessions.list.getSnapshot()
  const workspaces = ctx.workspaces.list.getSnapshot()
  if (sessions.current !== undefined) {
    const current = workspaces.items.find(workspace => workspace.sessionIds.includes(sessions.current as SessionId))
    if (current !== undefined) return current.workspaceId
  }
  return workspaces.recentWorkspaceId
}

function latestSeq(snapshot: ConversationSnapshot): number {
  return snapshot.nodes.reduce((maximum, node) => Math.max(maximum, node.seq), 0)
}

/**
 * Derive the Host-required Creator destination for the non-Cordis fallback path.
 * @param sourceSessionId - Session that owns the successful routing result.
 * @param routeId - source-owned interaction identity.
 * @returns domain-separated deterministic legacy Creator Session id.
 */
export async function capabilityAuthoringCreatorSessionId(
  sourceSessionId: string,
  routeId: string,
): Promise<SessionId> {
  const preimage = new TextEncoder().encode(JSON.stringify([
    'blueprint-capability-authoring', sourceSessionId, routeId,
  ]))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', preimage)
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  return `creator-capability-${hex}` as SessionId
}

async function createSessionForPreset(ctx: ClientContext, presetId: string, open = true, reservedId?: SessionId): Promise<SessionId> {
  const workspaceId = trialWorkspace(ctx)
  const sessionId = await ctx.sessions.create({
    ...(workspaceId === undefined ? {} : { workspaceId }),
    agentPreset: presetId,
    ...(reservedId === undefined ? {} : { sessionId: reservedId }),
  })
  if (open) ctx.sessions.open(sessionId)
  return sessionId
}

async function startCapabilityConversation(
  ctx: ClientContext,
  handoff: BlueprintCapabilityHandoff,
): Promise<BlueprintCapabilityConversationStart> {
  const list = ctx.sessions.list.getSnapshot()
  const sessionId = handoff.sourceSessionId as SessionId
  if (list.current !== sessionId || list.byId[sessionId] === undefined) {
    throw new Error('Capability request source Session is no longer foreground.')
  }
  const session = ctx.sessions.binding(sessionId)?.session
  if (session === undefined) throw new Error('请先打开一个对话，再继续添加能力。')
  const startSeq = latestSeq(session.getSnapshot())
  const context = await ctx.remote.blueprint.setConversationContext({
    sessionId,
    presetId: handoff.targetPresetId,
    revision: handoff.revision,
    capabilityInput: { routeId: handoff.routeId, userRequest: handoff.request },
  })
  if (!context.ok) throw new Error(context.error.message)
  return { sourceSessionId: sessionId, sourceStartSeq: startSeq }
}

async function startCapabilityAuthoring(
  ctx: ClientContext,
  route: import('@deepseek-ai/dsh-api-remotes/client').BlueprintCapabilityAuthoringRoute,
  setExecutionActive: (sessionId: SessionId, active: boolean) => void,
): Promise<BlueprintCapabilityAuthoringStart> {
  const sourceSessionId = route.sourceSessionId as SessionId
  const execution = await resolveCapabilityAuthoringExecution(
    sourceSessionId,
    async () => {
      const summary = ctx.sessions.list.getSnapshot().byId[sourceSessionId]
      return await resolveCapabilityAuthoringSourcePreset(
        sourceSessionId,
        summary?.cwd,
        ctx.sessions.binding(sourceSessionId)?.session !== undefined,
        async (request) => {
          const sessionId = await ctx.sessions.create(request)
          const agentPreset = ctx.sessions.list.getSnapshot().byId[sessionId]?.agentPreset
          return {
            sessionId,
            ...(agentPreset === undefined ? {} : { agentPreset }),
          }
        },
        (sessionId, agentPreset) => { ctx.sessions.noteAgentPreset(sessionId, agentPreset) },
      )
    },
    async () => await createSessionForPreset(
      ctx,
      'cordis',
      false,
      await capabilityAuthoringCreatorSessionId(route.sourceSessionId, route.routeId),
    ),
  )
  const sessionId = execution.sessionId
  const sourceOwnsAuthoring = !execution.dedicatedWorker
  const session = ctx.sessions.binding(sessionId)?.session
  if (session === undefined) {
    throw new Error(sourceOwnsAuthoring
      ? 'Source Session 已不可用，无法继续配置能力。'
      : 'Creator Session 未能进入当前工作区。')
  }
  setExecutionActive(sessionId, true)
  try {
    const context = await ctx.remote.blueprint.setConversationContext({
      sessionId,
      capabilityAuthoring: {
        routeId: route.routeId,
        sourceSessionId: route.sourceSessionId,
        targetPresetId: route.presetId,
        request: route.request,
        baseRevision: route.revision,
        kind: route.kind,
      },
    })
    if (!context.ok) throw new Error(context.error.message)
    const recovered = context.value.capabilityAuthoring
    if (recovered === undefined) throw new Error('Authoring Session 未记录 capability authoring lifecycle。')
    return {
      ...(sourceOwnsAuthoring ? {} : { creatorSessionId: sessionId }),
      startSeq: recovered.startSeq,
      baselineDelegationRowIds: recovered.baselineDelegationRowIds,
    }
  } catch (error) {
    setExecutionActive(sessionId, false)
    throw error
  }
}

async function startCreatorAuthoringContinuation(
  ctx: ClientContext,
  sourceSessionId: SessionId,
  route: BlueprintCreatorAuthoringRoute,
): Promise<{
  sessionId: SessionId
  authoring: NonNullable<import('@deepseek-ai/dsh-api-remotes/client').BlueprintConversationContextResult['creatorAuthoring']>
}> {
  if (route.handoff === undefined) throw new Error('此创建请求缺少安全交接记录，请重新发起创建。')
  const sessionId = await createSessionForPreset(ctx, 'cordis', false, route.handoff.targetCreatorSessionId as SessionId)
  const session = ctx.sessions.binding(sessionId)?.session
  if (session === undefined) throw new Error('Creator Session 未能进入当前工作区。')
  const context = await ctx.remote.blueprint.setConversationContext({
    sessionId,
    creatorAuthoring: {
      routeId: route.routeId,
      sourceSessionId,
      request: route.request,
      name: route.name,
      ...(route.sourceLanguage === undefined ? {} : { sourceLanguage: route.sourceLanguage }),
      handoff: route.handoff,
    },
  })
  if (!context.ok) throw new Error(context.error.message)
  const authoring = context.value.creatorAuthoring
  if (authoring === undefined) throw new Error('Creator Session 未记录 typed create-agent lifecycle。')
  ctx.layout.openDetails()
  return { sessionId, authoring }
}

async function findCreatorAuthoringContinuation(
  ctx: ClientContext,
  sourceSessionId: SessionId,
  route: BlueprintCreatorAuthoringRoute,
): Promise<{ sessionId: SessionId; authoring: RecoveredCreatorAuthoring } | null> {
  const list = ctx.sessions.list.getSnapshot()
  const candidates = await Promise.all(Object.entries(list.byId).map(async ([rawSessionId, summary]) => {
    const sessionId = rawSessionId as SessionId
    const binding = summary.agentPreset === 'cordis' ? ctx.sessions.binding(sessionId) : undefined
    if (binding === undefined) return null
    const result = await ctx.remote.blueprint.setConversationContext({
      sessionId,
      recoverCreatorAuthoring: true,
    })
    if (!result.ok || result.value.creatorAuthoring === undefined) return null
    return creatorAuthoringOwnsRoute(result.value.creatorAuthoring, sourceSessionId, route)
      ? { sessionId, authoring: result.value.creatorAuthoring }
      : null
  }))
  return candidates.find(candidate => candidate !== null) ?? null
}

async function startDemoConversation(
  ctx: ClientContext,
  presetId: string,
  text: string,
): Promise<BlueprintCapabilityConversationStart> {
  const sessionId = await createSessionForPreset(ctx, presetId)
  const session = ctx.sessions.binding(sessionId)?.session
  if (session === undefined) throw new Error('Demo Session 未能进入当前工作区。')
  const startSeq = latestSeq(session.getSnapshot())
  const result = await session.prompt([{ type: 'text', text }], 'queue')
  if (!result.ok) throw new Error(result.error.message)
  return { sourceSessionId: sessionId, sourceStartSeq: startSeq }
}

function textContent(content: readonly { type: string; text?: string }[]): string {
  return content.flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n').trim()
}

function argumentStrings(argsRaw: string): readonly string[] {
  const strings: string[] = []
  const visit = (value: unknown): void => {
    if (typeof value === 'string') strings.push(value)
    else if (Array.isArray(value)) value.forEach(visit)
    else if (typeof value === 'object' && value !== null) Object.values(value).forEach(visit)
  }
  try {
    visit(JSON.parse(argsRaw))
  } catch {
    strings.push(argsRaw)
  }
  return strings
}

const AUTHORING_TOOLS = new Set(['write', 'edit', 'apply_patch', 'bash', 'pwsh', 'run_code'])
const PRESET_PATH = /(?:^|[\\/])\.agent-presets[\\/]([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)[\\/](?:agent\.)?cordis\.ya?ml/giu
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/u

function jsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function presetIdField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && PRESET_ID.test(value) ? value : null
}

function presetIdMention(text: string): string | null {
  return text.match(/(?:preset(?:\s+id)?|预设(?:\s*id)?)\s*[:：]\s*`?([a-z0-9][a-z0-9-]*)/iu)?.[1] ?? null
}

function associationStrategy(text: string): BlueprintCreatorAssociationAnswer['strategy'] | null {
  if (/(?:新建|创建).*(?:独立|全新|新的?).*(?:preset|预设)?|(?:独立|全新).*(?:preset|预设)/iu.test(text)
    || /(?:create|new).*(?:independent|separate).*(?:preset|agent)/iu.test(text)) return 'new-independent'
  if (/(?:基于|在).*(?:已有|现有).*(?:完善|改进|修改|扩展|改造)|(?:完善|改进|改造).*(?:已有|现有)/iu.test(text)
    || /(?:improve|extend|modify).*(?:existing|current).*(?:preset|agent)/iu.test(text)) return 'enhance-existing'
  if (/(?:直接)?(?:使用|用|复用|沿用).*(?:已有|现有)/iu.test(text)
    || /(?:use|reuse).*(?:existing|current).*(?:preset|agent)/iu.test(text)) return 'reuse-existing'
  return null
}

function collectAssociationAnswers(
  block: Extract<ToolCallBlock, { kind: 'tool-result' }>,
  target: BlueprintCreatorAssociationAnswer[],
): void {
  if (block.isError || block.call?.name !== 'ask_user_question') return
  const args = jsonRecord(block.call.argsRaw)
  const result = jsonRecord(textContent(block.content))
  const questions = Array.isArray(args?.['questions']) ? args['questions'] as readonly unknown[] : null
  const answers = Array.isArray(result?.['answers']) ? result['answers'] as readonly unknown[] : null
  if (questions === null || answers === null) return
  for (const answerValue of answers) {
    if (typeof answerValue !== 'object' || answerValue === null || Array.isArray(answerValue)) continue
    const answer = answerValue as Record<string, unknown>
    const id = answer['id']
    const selected = answer['selected']
    if (typeof id !== 'string' || !Array.isArray(selected)) continue
    const questionValue = questions.find(candidate => typeof candidate === 'object' && candidate !== null
      && !Array.isArray(candidate) && (candidate as Record<string, unknown>)['id'] === id)
    if (typeof questionValue !== 'object' || questionValue === null || Array.isArray(questionValue)) continue
    const question = questionValue as Record<string, unknown>
    const questionText = typeof question['question'] === 'string' ? question['question'] : ''
    const options: readonly unknown[] = Array.isArray(question['options'])
      ? question['options'] as readonly unknown[]
      : []
    for (const selectedValue of selected) {
      if (typeof selectedValue !== 'string') continue
      const optionValue = options.find(candidate => typeof candidate === 'object' && candidate !== null
        && !Array.isArray(candidate) && (candidate as Record<string, unknown>)['label'] === selectedValue)
      const option = typeof optionValue === 'object' && optionValue !== null && !Array.isArray(optionValue)
        ? optionValue as Record<string, unknown>
        : null
      const description = typeof option?.['description'] === 'string' ? option['description'] : ''
      const text = `${questionText}\n${selectedValue}\n${description}`
      if (!/(?:preset|预设)/iu.test(text)) continue
      const strategy = associationStrategy(`${selectedValue}\n${description}`)
      if (strategy === null) continue
      target.push({
        seq: block.seq,
        strategy,
        existingPresetId: strategy === 'new-independent' ? null : presetIdMention(text),
      })
    }
  }
}

function collectCreatorEvidence(
  block: ToolCallBlock,
  authored: BlueprintCreatorAuthoredPreset[],
  copies: BlueprintCreatorPresetCopy[],
  answers: BlueprintCreatorAssociationAnswer[],
  validated: BlueprintCreatorValidatedPreset[],
): void {
  if (!('kind' in block)) return
  const call = block.call
  if (!block.isError && call?.name === 'preset_copy') {
    const args = jsonRecord(call.argsRaw)
    const sourcePresetId = args === null ? null : presetIdField(args, 'source') ?? presetIdField(args, 'from')
    const targetPresetId = args === null ? null : presetIdField(args, 'id')
    if (sourcePresetId !== null && targetPresetId !== null) {
      copies.push({ seq: block.seq, sourcePresetId, targetPresetId })
      authored.push({ seq: block.seq, presetId: targetPresetId })
    }
  }
  if (!block.isError && call !== null && AUTHORING_TOOLS.has(call.name)) {
    for (const value of argumentStrings(call.argsRaw)) {
      for (const match of value.matchAll(PRESET_PATH)) {
        const presetId = match[1]
        if (presetId !== undefined) authored.push({ seq: block.seq, presetId })
      }
    }
  }
  if (!block.isError && call?.name === 'preset_validate') {
    const args = jsonRecord(call.argsRaw)
    const presetId = args === null ? null : presetIdField(args, 'id')
    if (presetId !== null) validated.push({ seq: block.seq, presetId })
  }
  collectAssociationAnswers(block, answers)
  for (const child of block.subCalls) collectCreatorEvidence(child, authored, copies, answers, validated)
}

/**
 * Project recoverable Creator lifecycle evidence from one Session snapshot.
 * @param sessionId - Session that owns the Creator lifecycle.
 * @param presetId - preset currently mounted by that Session, when known.
 * @param snapshot - durable conversation and pending-interaction projection.
 * @returns structured evidence consumed by the Blueprint coordinator.
 */
export function creatorObservation(
  sessionId: SessionId,
  presetId: string | undefined,
  snapshot: ConversationSnapshot,
): BlueprintCreatorObservation {
  const userMessages = conversationInputNodes(snapshot)
    .map(node => ({ seq: node.seq, text: textContent(node.content) }))
    .filter(message => message.text !== '')
  const authoredPresets: BlueprintCreatorAuthoredPreset[] = []
  const presetCopies: BlueprintCreatorPresetCopy[] = []
  const associationAnswers: BlueprintCreatorAssociationAnswer[] = []
  const validatedPresets: BlueprintCreatorValidatedPreset[] = []
  for (const root of conversationToolRoots(snapshot)) {
    collectCreatorEvidence(root, authoredPresets, presetCopies, associationAnswers, validatedPresets)
  }
  const waiting = snapshot.pending.find(interaction => interaction.kind === 'approval')
    ?? snapshot.pending.find(interaction => interaction.kind === 'question')
  let lastTurnEnd
  for (let index = snapshot.chat.timeline.turnOrder.length - 1; index >= 0; index -= 1) {
    const turnNumber = snapshot.chat.timeline.turnOrder[index]
    if (turnNumber === undefined) continue
    lastTurnEnd = snapshot.chat.timeline.turns.get(turnNumber)?.end
    if (lastTurnEnd !== undefined) break
  }
  return {
    sessionId,
    ...(presetId === undefined ? {} : { presetId }),
    running: snapshot.running,
    waitingFor: waiting?.kind ?? null,
    pendingInteraction: waiting ?? null,
    lastTurnEnd: lastTurnEnd === undefined
      ? null
      : { seq: lastTurnEnd.seq, reason: lastTurnEnd.data.reason.kind },
    userMessages,
    presetCopies,
    associationAnswers,
    authoredPresets,
    validatedPresets,
  }
}

function capabilityMetaRecord(value: unknown, key: string): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const candidate = (value as Record<string, unknown>)[key]
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : null
}

/** Return user inputs from the complete Chat store, independent of presentation visibility. */
function conversationInputNodes(snapshot: ConversationSnapshot): readonly (UserMessageNode | SteeringMessageNode)[] {
  return snapshot.chat.nodes.values()
    .filter(node => node.kind === 'user' || node.kind === 'steering')
    .map(node => node.data as UserMessageNode | SteeringMessageNode)
}

/** Return Tool roots from the complete Chat store, including implementation-only Turns. */
function conversationToolRoots(snapshot: ConversationSnapshot): readonly ToolCallBlock[] {
  return snapshot.chat.nodes.values()
    .filter(node => node.kind === 'tool-call')
    .map(node => (node.data as { readonly root: ToolCallBlock }).root)
}

/**
 * Project typed capability routing and proposal results from one Session snapshot.
 * @param sessionId - Session whose durable conversation is being observed.
 * @param snapshot - current conversation and pending-interaction projection.
 * @returns structured evidence consumed by the capability coordinator.
 */
export function capabilityObservation(
  sessionId: SessionId,
  snapshot: ConversationSnapshot,
): BlueprintCapabilityObservation {
  const proposals: BlueprintCapabilityObservation['proposals'][number][] = []
  const authoringRoutes: BlueprintCapabilityObservation['authoringRoutes'][number][] = []
  for (const root of conversationToolRoots(snapshot)) {
    if (!('kind' in root) || root.isError) continue
    const changeSet = capabilityMetaRecord(root.meta, 'blueprintChangeSet')
    if (changeSet !== null && typeof changeSet['presetId'] === 'string'
      && typeof changeSet['sourceSessionId'] === 'string' && typeof changeSet['routeId'] === 'string') {
      proposals.push({
        seq: root.seq, presetId: changeSet['presetId'],
        sourceSessionId: changeSet['sourceSessionId'], routeId: changeSet['routeId'],
      })
    }
    const route = capabilityMetaRecord(root.meta, 'blueprintCapabilityAuthoring')
    if (route !== null
      && typeof route['presetId'] === 'string'
      && typeof route['routeId'] === 'string'
      && typeof route['sourceSessionId'] === 'string'
      && typeof route['revision'] === 'string'
      && typeof route['request'] === 'string'
      && typeof route['reason'] === 'string'
      && (route['kind'] === 'skill' || route['kind'] === 'subagent')) {
      authoringRoutes.push({
        seq: root.seq,
        route: {
          routeId: route['routeId'], sourceSessionId: route['sourceSessionId'],
          presetId: route['presetId'], revision: route['revision'], request: route['request'],
          reason: route['reason'], kind: route['kind'],
        },
      })
    }
  }
  const lastTurnNumber = snapshot.chat.timeline.turnOrder.at(-1)
  const lastTurnEnd = lastTurnNumber === undefined
    ? undefined
    : snapshot.chat.timeline.turns.get(lastTurnNumber)?.end
  const pendingInteraction = snapshot.pending.find(interaction => interaction.kind === 'approval')
    ?? snapshot.pending.find(interaction => interaction.kind === 'question')
  return {
    sessionId,
    running: snapshot.running,
    stopped: snapshot.removed,
    waitingFor: pendingInteraction?.kind ?? null,
    pendingInteraction: pendingInteraction ?? null,
    lastTurnEnd: lastTurnEnd === undefined
      ? null
      : { seq: lastTurnEnd.seq, reason: lastTurnEnd.data.reason.kind },
    proposals,
    authoringRoutes,
  }
}

/**
 * Select the exact background wait that the current source Session must present.
 * @param state - current Blueprint coordinator projection.
 * @param sourceSessionId - foreground Session that may own the Blueprint flow.
 * @returns a child-owned carrier only when the foreground Session owns its route.
 */
export function blueprintComposerInteraction(
  state: BlueprintUiState,
  sourceSessionId: SessionId | undefined,
): PendingInteraction | undefined {
  if (sourceSessionId === undefined) return undefined
  const creator = state.creator
  if (creator?.sessionId === sourceSessionId
    && creator.pendingInteraction !== undefined
    && creator.pendingInteraction.sessionId !== sourceSessionId) return creator.pendingInteraction
  const capability = state.capabilityHandoff
  if (capability?.sourceSessionId === sourceSessionId
    && capability.creatorSessionId !== undefined
    && capability.pendingInteraction !== undefined
    && capability.pendingInteraction.sessionId === capability.creatorSessionId) return capability.pendingInteraction
  return undefined
}

function capabilitySourceRouteSeq(
  ctx: ClientContext,
  sourceSessionId: string,
  routeId: string,
): number | undefined {
  const source = ctx.sessions.binding(sourceSessionId as SessionId)?.session
  if (source === undefined) return undefined
  const observation = capabilityObservation(sourceSessionId as SessionId, source.getSnapshot())
  return [
    ...observation.proposals
      .filter(candidate => candidate.routeId === routeId)
      .map(candidate => candidate.seq),
    ...observation.authoringRoutes
      .filter(candidate => candidate.route.routeId === routeId)
      .map(candidate => candidate.seq),
  ].sort((left, right) => right - left)[0]
}

/**
 * Project typed new-Agent routing decisions from one durable conversation snapshot.
 * @param snapshot - durable source conversation snapshot.
 * @returns accepted create-Agent routes with their event sequence.
 */
export function creatorAuthoringRoutes(snapshot: ConversationSnapshot): readonly {
  seq: number
  route: BlueprintCreatorAuthoringRoute
}[] {
  const routes: { seq: number; route: BlueprintCreatorAuthoringRoute }[] = []
  for (const root of conversationToolRoots(snapshot)) {
    if (!('kind' in root) || root.isError) continue
    const route = capabilityMetaRecord(root.meta, 'blueprintCreatorAuthoring')
    if (route === null || route['operation'] !== 'create-agent'
      || typeof route['routeId'] !== 'string' || typeof route['request'] !== 'string'
      || typeof route['name'] !== 'string') continue
    if (route['sourceLanguage'] !== undefined && typeof route['sourceLanguage'] !== 'string') continue
    if (route['language'] !== undefined && typeof route['language'] !== 'string') continue
    const sourceLanguage = typeof route['sourceLanguage'] === 'string'
      ? route['sourceLanguage'].trim()
      : typeof route['language'] === 'string' ? route['language'].trim() : undefined
    if (sourceLanguage === '') continue
    const handoff = route['handoff']
    if (handoff !== undefined && (handoff === null || typeof handoff !== 'object'
      || !('sourceTurn' in handoff) || !Number.isSafeInteger(handoff.sourceTurn)
      || !('targetCreatorSessionId' in handoff) || typeof handoff.targetCreatorSessionId !== 'string')) continue
    routes.push({
      seq: root.seq,
      route: {
        operation: 'create-agent',
        routeId: route['routeId'],
        request: route['request'],
        name: route['name'],
        ...(sourceLanguage === undefined ? {} : { sourceLanguage }),
        ...(handoff === undefined ? {} : { handoff: handoff as NonNullable<BlueprintCreatorAuthoringRoute['handoff']> }),
      },
    })
  }
  return routes
}

function registerBlueprintSlots(ctx: ClientContext, face: BlueprintInjected): void {
  registerBlueprintCreatorTurnPresentation(ctx)
  registerBlueprintCapabilityRouteTurnPresentation(ctx)
  registerBlueprintRouteToolViews(ctx)

  ctx.slots.inject('sidebar.navigation.section', () => ctx.slots.register({
    name: 'sidebar.navigation.section',
    id: 'blueprint-agents',
    order: 0,
    inject: (): BlueprintInjected => face,
  }, BlueprintAgentRoster))

  ctx.slots.inject('conversation.details.default', () => {
    const dispose = ctx.slots.register({
      name: 'conversation.details.default',
      inject: (): BlueprintInjected => face,
    }, BlueprintPanel)
    // Geometry follows presentation readiness, not a successful context RPC or target projection.
    ctx.layout.openDetails()
    return dispose
  })

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'blueprint-context',
    order: -100,
    inject: (): BlueprintInjected => face,
  }, BlueprintSelectedContext))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'blueprint-modal',
    order: 10,
    inject: (): BlueprintInjected => face,
  }, BlueprintOverlay))

  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'propose_blueprint_change',
    inject: (): BlueprintInjected => face,
  }, BlueprintProposalRow))
}

type BlueprintFaceOverrides = Pick<BlueprintInjected, 'selectPreset' | 'selectNode' | 'selectCapability' | 'applyChangeSet'>
  & Partial<Pick<BlueprintInjected, 'startDemoCapability' | 'resetDemo'>>

function blueprintFace(
  controller: BlueprintUiController,
  overrides: BlueprintFaceOverrides,
): BlueprintInjected {
  return {
    hooks: { blueprintUi: controller.store },
    load: () => controller.load(),
    clearSelection: () => { controller.clearSelection() },
    updateText: (nodeId, value, expectedValue) => controller.updateText(nodeId, value, expectedValue),
    setCapability: (nodeId, enabled) => controller.setCapability(nodeId, enabled),
    addCapability: nodeId => controller.addCapability(nodeId),
    beginCapabilityHandoff: request => controller.beginCapabilityHandoff(request),
    clearCapabilityHandoff: () => { controller.clearCapabilityHandoff() },
    openModal: (modal) => { controller.openModal(modal) },
    closeModal: () => { controller.closeModal() },
    startTrial: () => controller.startTrial(),
    cancelProposal: changeSet => controller.cancelProposal(changeSet),
    cancelChangeSet: changeSet => controller.cancelChangeSet(changeSet),
    ...overrides,
  }
}

/**
 * Mount Demo data into the production Blueprint slots and real Web shell.
 * @param ctx - browser Cordis root with the normal layout, runtime, and fixture transport mounted.
 * @param bootstrap - caller-owned Agent seeds and initial-selection policy.
 * @returns controller driving the same Blueprint components as the real DSH binding.
 */
export function mountBlueprintDemoUi(
  ctx: ClientContext,
  bootstrap: BlueprintDemoBootstrap,
): BlueprintUiController {
  const adapter = new InMemoryBlueprintDemoAdapter(bootstrap.seeds, {
    ...(bootstrap.preferredPresetId === undefined
      ? {}
      : { preferredPresetId: bootstrap.preferredPresetId }),
  })
  const creatorScenario = (bootstrap as Partial<BlueprintDemoBootstrap>).creatorScenario
  if (creatorScenario === undefined) throw new Error('Blueprint Demo requires one Creator scenario')
  const applyReceipts: BlueprintApplyReceipt[] = []
  let terminalSeq = 0
  const remote: BlueprintRemote = {
    get: request => adapter.get(request),
    setConversationContext: request => adapter.setConversationContext(request),
    async applyChangeSet(request) {
      const result = await adapter.applyChangeSet(request)
      if (!result.ok) return result
      const snapshot = ctx.sessions.binding(request.sourceSessionId as SessionId)?.session.getSnapshot()
      const proposalResult = snapshot?.nodes.find((node) => {
        if (node.kind !== 'tool-result' || node.callId !== request.changeSetId || node.isError) return false
        const changeSet = capabilityMetaRecord(node.meta, 'blueprintChangeSet')
        return changeSet?.['sourceSessionId'] === request.sourceSessionId
          && changeSet['routeId'] === request.routeId
          && changeSet['presetId'] === request.presetId
      })
      if (proposalResult === undefined) {
        throw new Error(`Blueprint Demo Apply cannot identify Proposal ${request.changeSetId}`)
      }
      terminalSeq = Math.max(terminalSeq + 1, proposalResult.seq + 1)
      applyReceipts.push({
        sourceSessionId: request.sourceSessionId,
        routeId: request.routeId,
        proposalResultSeq: proposalResult.seq,
        terminalSeq,
        presetId: request.presetId,
        result: result.value,
      })
      return result
    },
  }
  const controllerRef: { current?: BlueprintUiController } = {}
  const scenarioRef: { current?: DemoScenarioController } = {}
  const controller: BlueprintUiController = new BlueprintUiController(
    adapter,
    remote,
    () => { ctx.layout.openDetails() },
    async (sessionId, blueprint, selectedNodeId) => {
      if (sessionId === undefined) return
      const result = await adapter.setConversationContext({
        sessionId,
        ...(blueprint === null ? {} : { presetId: blueprint.preset.id, revision: blueprint.revision }),
        ...(selectedNodeId === null ? {} : { selectedNodeId }),
      })
      if (!result.ok) throw new Error(result.error.message)
      const current = controllerRef.current
      if (current === undefined) throw new Error('Blueprint Demo controller is not ready')
      current.restoreApplyReceipts(
        sessionId,
        applyReceipts.filter(receipt => receipt.sourceSessionId === sessionId),
      )
    },
    () => Promise.reject(new Error('Blueprint Demo trial must use the fixture Session handoff.')),
    handoff => startDemoConversation(ctx, handoff.targetPresetId, handoff.request),
    async (route) => {
      const started = await startDemoConversation(ctx, 'cordis', route.request)
      return { creatorSessionId: started.sourceSessionId, startSeq: started.sourceStartSeq }
    },
    (request) => {
      const current = scenarioRef.current
      if (current === undefined) return Promise.reject(new Error('Blueprint Demo scenario is not ready'))
      return current.startTrial(request)
    },
    undefined,
    undefined,
    changeSet => Promise.resolve({ ok: true, value: {
      sourceSessionId: changeSet.sourceSessionId,
      routeId: changeSet.routeId,
      proposalResultSeq: 0,
      changeSetId: changeSet.changeSetId,
      presetId: changeSet.presetId,
      baseRevision: changeSet.revision,
      status: 'cancelled',
    } }),
  )
  controllerRef.current = controller
  const scenario: DemoScenarioController = new DemoScenarioController({
    ctx,
    blueprint: controller,
    adapter,
    creatorScenario,
    createSession: (presetId, open) => createSessionForPreset(ctx, presetId, open),
    observeCreator: creatorObservation,
    fixtureBridge: demoFixtureBridge,
  })
  scenarioRef.current = scenario
  const face = blueprintFace(controller, {
    selectPreset: presetId => controller.selectPreset(presetId),
    selectNode: (nodeId) => { scenario.selectNode(nodeId) },
    selectCapability: (capabilityId, label, nodeId) => { controller.selectCapability(capabilityId, label, nodeId) },
    applyChangeSet: changeSet => scenario.applyChangeSet(changeSet),
    startDemoCapability: kind => scenario.startCapability(kind),
    resetDemo: () => { scenario.reset() },
  })
  registerBlueprintSlots(ctx, face)
  scenario.start()
  ctx.effect(() => () => { scenario.dispose() }, 'ui-blueprint: dispose Demo scenario controller')
  return controller
}

/**
 * Register the Agent roster, Blueprint panel, selected context, and modal layer.
 * @param ctx - browser Cordis root.
 */
export function apply(ctx: ClientContext): void {
  const demo = currentDemoBootstrap()
  if (demo !== undefined) {
    mountBlueprintDemoUi(ctx, demo)
    return
  }
  const api = (ctx.get('connection') as ConnectionHandle).api
  let syncedSessionId: SessionId | undefined
  const capabilityAuthoringSessions = new Set<SessionId>()
  const capabilityContextRestorePending = new BlueprintContextRestorePending()
  const capabilityComposerBlocks = new BlueprintCapabilityComposerBlockProjection(ctx.conversation.blocks)
  let syncCapabilityComposerBlocks = (): void => {}
  let contextUpdate: Promise<void> = Promise.resolve()
  const syncConversationContext = (
    intendedSessionId: string | undefined,
    blueprint: import('@deepseek-ai/dsh-api-remotes/client').Blueprint | null,
    selectedNodeId: string | null,
    creatorDraft?: BlueprintCreatorDraft,
    userChange?: import('@deepseek-ai/dsh-api-remotes/client').BlueprintUserChangeInput,
    directEditInput?: import('@deepseek-ai/dsh-api-remotes/client').BlueprintStructuredEditInput,
    isCurrent: () => boolean = () => true,
  ): Promise<void> => {
    contextUpdate = contextUpdate.catch(() => undefined).then(async () => {
      const current = ctx.sessions.list.getSnapshot().current
      if (!isCurrent() || intendedSessionId === undefined || intendedSessionId !== current) {
        if (directEditInput !== undefined) throw new Error('目标修改所属对话已不在前台，请回到原对话后重试。')
        return
      }
      if (syncedSessionId !== undefined && syncedSessionId !== current) {
        const cleared = await ctx.remote.blueprint.setConversationContext({ sessionId: syncedSessionId })
        if (!cleared.ok) throw new Error(`Unable to clear Blueprint context for ${syncedSessionId}: ${cleared.error.message}`)
        syncedSessionId = undefined
        if (!isCurrent() || ctx.sessions.list.getSnapshot().current !== current) {
          if (directEditInput !== undefined) throw new Error('目标修改所属对话已不在前台，请回到原对话后重试。')
          return
        }
      }
      if (capabilityAuthoringSessions.has(current)) {
        if (directEditInput !== undefined) {
          throw new Error('当前对话正在执行能力配置，不能接收这次目标修改。')
        }
        return
      }
      if (creatorDraft !== undefined && creatorDraft.sessionId === current && creatorDraft.status !== 'ready') {
        const result = await ctx.remote.blueprint.setConversationContext({
          sessionId: current,
          creatorDraft: {
            name: creatorDraft.name,
            status: creatorDraft.status,
            ...(creatorDraft.targetPresetId === undefined ? {} : { targetPresetId: creatorDraft.targetPresetId }),
            ...(blueprint === null || selectedNodeId === null ? {} : { selectedNodeId }),
          },
        })
        if (!result.ok) throw new Error(result.error.message)
        syncedSessionId = current
        if (!isCurrent() || ctx.sessions.list.getSnapshot().current !== current) return
        controller.restoreApplyReceipts(current, result.value.applyReceipts ?? [])
        controller.restoreProposalCancellations(current, result.value.proposalCancellations ?? [])
        return
      }
      if (blueprint === null) {
        const cleared = await ctx.remote.blueprint.setConversationContext({ sessionId: current })
        if (!cleared.ok) throw new Error(cleared.error.message)
        if (syncedSessionId === current) syncedSessionId = undefined
        if (!isCurrent() || ctx.sessions.list.getSnapshot().current !== current) return
        controller.restoreApplyReceipts(current, cleared.value.applyReceipts ?? [])
        controller.restoreProposalCancellations(current, cleared.value.proposalCancellations ?? [])
        return
      }
      const result = await ctx.remote.blueprint.setConversationContext({
        sessionId: current,
        presetId: blueprint.preset.id,
        revision: blueprint.revision,
        ...(selectedNodeId === null ? {} : { selectedNodeId }),
        ...(userChange === undefined ? {} : { userChange }),
        ...(directEditInput === undefined ? {} : { directEditInput }),
      })
      if (!result.ok) throw new Error(result.error.message)
      if (directEditInput !== undefined) assertDirectEditEnqueued(result.value, current, directEditInput)
      syncedSessionId = current
      if (!isCurrent() || ctx.sessions.list.getSnapshot().current !== current) return
      controller.restoreApplyReceipts(current, result.value.applyReceipts ?? [])
      controller.restoreProposalCancellations(current, result.value.proposalCancellations ?? [])
    })
    return contextUpdate
  }
  const controller = new BlueprintUiController(
    dshAgentCatalog(api),
    ctx.remote.blueprint,
    () => { ctx.layout.openDetails() },
    syncConversationContext,
    async (request) => {
      const workspaceId = trialWorkspace(ctx)
      const originSessionId = ctx.sessions.list.getSnapshot().current
      return await prepareBlueprintTrialSession(request, {
        async create() {
          const sessionId = await ctx.sessions.create({
            ...(workspaceId === undefined ? {} : { workspaceId }),
            agentPreset: request.presetId,
          })
          const agentPreset = ctx.sessions.list.getSnapshot().byId[sessionId]?.agentPreset
          return {
            sessionId,
            ...(agentPreset === undefined ? {} : { agentPreset }),
          }
        },
        waitUntilAddressable: () => Promise.resolve(),
        notePreset: (sessionId, presetId) => { ctx.sessions.noteAgentPreset(sessionId, presetId) },
        async installContext(sessionId) {
          const result = await ctx.remote.blueprint.setConversationContext({
            sessionId,
            presetId: request.presetId,
            revision: request.expectedRevision,
          })
          if (!result.ok) throw new Error(result.error.message)
        },
        async validate(sessionId) {
          const result = await ctx.remote.blueprint.validateSession({ sessionId, ...request })
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
        mayOpen: () => ctx.sessions.list.getSnapshot().current === originSessionId,
        open(sessionId) {
          ctx.sessions.open(sessionId)
          ctx.layout.openDetails()
        },
      })
    },
    handoff => startCapabilityConversation(ctx, handoff),
    route => startCapabilityAuthoring(ctx, route, (sessionId, active) => {
      if (active) capabilityAuthoringSessions.add(sessionId)
      else capabilityAuthoringSessions.delete(sessionId)
    }),
    undefined,
    async (sessionId) => {
      const session = ctx.sessions.binding(sessionId as SessionId)?.session
      if (session === undefined) throw new Error('Creator Session 已不可用，无法停止本次能力配置。')
      const result = await session.cancel()
      if (!result.ok) throw new Error(result.error.message)
    },
    createBlueprintTargetPreference(),
    changeSet => ctx.remote.blueprint.cancelChangeSet({
      sourceSessionId: changeSet.sourceSessionId,
      routeId: changeSet.routeId,
      changeSetId: changeSet.changeSetId,
    }),
  )
  const markCapabilityContextRestore = (sourceSessionId: SessionId): void => {
    if (capabilityContextRestorePending.mark(sourceSessionId)) syncCapabilityComposerBlocks()
  }
  const clearCapabilityContextRestore = (sourceSessionId: SessionId): void => {
    if (capabilityContextRestorePending.clear(sourceSessionId)) syncCapabilityComposerBlocks()
  }
  const restoreCapabilityContext = async (sourceSessionId: SessionId): Promise<boolean> => {
    const restored = await capabilityContextRestorePending.restore(sourceSessionId, async () => {
      if (ctx.sessions.list.getSnapshot().current !== sourceSessionId) return false
      const installed = await controller.syncConversation()
      return installed && ctx.sessions.list.getSnapshot().current === sourceSessionId
    })
    syncCapabilityComposerBlocks()
    return restored
  }
  const syncForegroundConversation = async (): Promise<boolean> => {
    const current = ctx.sessions.list.getSnapshot().current
    if (current === undefined) return false
    return capabilityContextRestorePending.has(current)
      ? await restoreCapabilityContext(current)
      : await controller.syncConversation()
  }
  const continuedCreatorRoutes = new Set<string>()
  const creatorAuthoringContinuations = new Map<SessionId, RecoveredCreatorAuthoring>()
  const creatorContinuationUpdates = new Map<SessionId, Promise<void>>()
  let refreshCreatorAuthoringSubscriptions = (): void => {}
  const observeCreatorContinuation = (sessionId: SessionId): Promise<void> => {
    const pending = creatorContinuationUpdates.get(sessionId)
    if (pending !== undefined) return pending
    const update = (async () => {
      const retained = creatorAuthoringContinuations.get(sessionId)
      const binding = ctx.sessions.binding(sessionId)
      const summary = ctx.sessions.list.getSnapshot().byId[sessionId]
      if (retained === undefined || binding === undefined || summary?.agentPreset !== 'cordis') return
      const recovered = await ctx.remote.blueprint.setConversationContext({
        sessionId,
        recoverCreatorAuthoring: true,
      })
      if (!recovered.ok) throw new Error(recovered.error.message)
      const authoring = recovered.value.creatorAuthoring ?? retained
      creatorAuthoringContinuations.set(sessionId, authoring)
      await controller.observeCreator({
        ...creatorObservation(sessionId, summary.agentPreset, binding.session.getSnapshot()),
        creatorAuthoring: authoring,
      })
      if (ctx.sessions.list.getSnapshot().current !== authoring.sourceSessionId) return
      const creator = controller.store.getSnapshot().creator
      if (authoring.terminal === undefined && creator !== null && creator.routeId === authoring.routeId
        && creator.status !== 'ready') return
      creatorAuthoringContinuations.delete(sessionId)
      refreshCreatorAuthoringSubscriptions()
    })().finally(() => { creatorContinuationUpdates.delete(sessionId) })
    creatorContinuationUpdates.set(sessionId, update)
    return update
  }
  const continueCreatorRoute = (
    sourceSessionId: SessionId,
    route: BlueprintCreatorAuthoringRoute,
  ): boolean => {
    const key = `${sourceSessionId}:${route.routeId}`
    if (continuedCreatorRoutes.has(key)) return false
    continuedCreatorRoutes.add(key)
    controller.beginCreatorAuthoringRoute(sourceSessionId, route)
    void findCreatorAuthoringContinuation(ctx, sourceSessionId, route).then(async (recovered) => {
      if (recovered !== null) {
        let authoring = recovered.authoring
        if (route.handoff !== undefined) {
          const result = await ctx.remote.blueprint.setConversationContext({
            sessionId: recovered.sessionId,
            creatorAuthoring: { ...route, sourceSessionId },
          })
          if (!result.ok) throw new Error(result.error.message)
          authoring = result.value.creatorAuthoring ?? authoring
        }
        creatorAuthoringContinuations.set(recovered.sessionId, authoring)
        refreshCreatorAuthoringSubscriptions()
        await observeCreatorContinuation(recovered.sessionId)
        return
      }
      const continuation = await startCreatorAuthoringContinuation(ctx, sourceSessionId, route)
      const creatorSessionId = continuation.sessionId
      const binding = ctx.sessions.binding(creatorSessionId)
      const summary = ctx.sessions.list.getSnapshot().byId[creatorSessionId]
      if (binding === undefined || summary?.agentPreset !== 'cordis') {
        throw new Error('Typed Creator continuation did not enter a Creator runtime Session.')
      }
      creatorAuthoringContinuations.set(creatorSessionId, continuation.authoring)
      refreshCreatorAuthoringSubscriptions()
      await observeCreatorContinuation(creatorSessionId)
    }).catch((error: unknown) => {
      continuedCreatorRoutes.delete(key)
      controller.failCreatorAuthoringRoute(sourceSessionId, error)
      void controller.load()
    })
    return true
  }

  let recoveryUpdate: Promise<boolean> = Promise.resolve(false)
  const checkedBackgroundCapabilityAuthoring = new Set<SessionId>()
  let backgroundRecoveryPending = false
  const recoverCurrentCapabilityAuthoring = (): Promise<boolean> => {
    recoveryUpdate = recoveryUpdate.catch(() => false).then(async () => {
      const list = ctx.sessions.list.getSnapshot()
      const sessionId = list.current
      if (sessionId === undefined || list.byId[sessionId]?.agentPreset !== 'cordis') return false
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) return false
      markCapabilityContextRestore(sessionId)
      const result = await ctx.remote.blueprint.setConversationContext({
        sessionId,
        recoverCapabilityAuthoring: true,
      })
      if (ctx.sessions.list.getSnapshot().current !== sessionId) return false
      if (!result.ok) throw new Error(result.error.message)
      controller.restoreApplyReceipts(sessionId, result.value.applyReceipts ?? [])
      controller.restoreProposalCancellations(sessionId, result.value.proposalCancellations ?? [])
      const recovered = result.value.capabilityAuthoring
      if (recovered === undefined) {
        const record = result.value.capabilityAuthoringRecord
        if (record?.state === 'ended') {
          const sourceSessionId = record.sourceSessionId as SessionId
          if (sourceSessionId !== sessionId) clearCapabilityContextRestore(sessionId)
          markCapabilityContextRestore(sourceSessionId)
          const sourceRouteSeq = capabilitySourceRouteSeq(ctx, record.sourceSessionId, record.routeId)
          const restored = await controller.restoreTerminalCapabilityAuthoring(sessionId, record, sourceRouteSeq)
          capabilityAuthoringSessions.delete(sessionId)
          return record.sourceSessionId === sessionId ? false : restored
        }
        const creatorResult = await ctx.remote.blueprint.setConversationContext({
          sessionId,
          recoverCreatorAuthoring: true,
        })
        if (ctx.sessions.list.getSnapshot().current !== sessionId) return false
        if (!creatorResult.ok) throw new Error(creatorResult.error.message)
        const creatorAuthoring = creatorResult.value.creatorAuthoring
        if (creatorAuthoring === undefined) return false
        await controller.observeCreator({
          ...creatorObservation(sessionId, list.byId[sessionId].agentPreset, binding.session.getSnapshot()),
          creatorAuthoring,
        })
        await controller.observeCapability(capabilityObservation(sessionId, binding.session.getSnapshot()))
        clearCapabilityContextRestore(sessionId)
        return true
      }
      const sourceSessionId = recovered.sourceSessionId as SessionId
      if (sourceSessionId !== sessionId) clearCapabilityContextRestore(sessionId)
      markCapabilityContextRestore(sourceSessionId)
      capabilityAuthoringSessions.add(sessionId)
      const observation = capabilityObservation(sessionId, binding.session.getSnapshot())
      const sourceRouteSeq = capabilitySourceRouteSeq(ctx, recovered.sourceSessionId, recovered.routeId)
      const restored = await controller.restoreCapabilityAuthoring(
        sessionId, recovered, observation.waitingFor, sourceRouteSeq, observation.pendingInteraction,
      )
      if (!restored) return false
      await controller.observeCapability(observation)
      return true
    })
    return recoveryUpdate
  }

  const recoverBackgroundCapabilityAuthoring = async (): Promise<boolean> => {
    const list = ctx.sessions.list.getSnapshot()
    const candidates: BackgroundCapabilityRecovery[] = []
    for (const [rawSessionId, summary] of Object.entries(list.byId)) {
      const sessionId = rawSessionId as SessionId
      if (summary.agentPreset !== 'cordis' || sessionId === list.current
        || checkedBackgroundCapabilityAuthoring.has(sessionId)) continue
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) continue
      const result = await ctx.remote.blueprint.setConversationContext({
        sessionId,
        recoverCapabilityAuthoring: true,
      })
      if (!result.ok) continue
      const recovered = result.value.capabilityAuthoring
      const record = result.value.capabilityAuthoringRecord
      const observation = capabilityObservation(sessionId, binding.session.getSnapshot())
      if (recovered === undefined) {
        if (record?.state !== 'ended') {
          checkedBackgroundCapabilityAuthoring.add(sessionId)
          continue
        }
        if (record.sourceSessionId === sessionId) {
          checkedBackgroundCapabilityAuthoring.add(sessionId)
          continue
        }
        const sourceRouteSeq = capabilitySourceRouteSeq(ctx, record.sourceSessionId, record.routeId)
        candidates.push({
          state: 'terminal', creatorSessionId: sessionId,
          sourceSessionId: record.sourceSessionId, routeId: record.routeId,
          ...(sourceRouteSeq === undefined ? {} : { sourceRouteSeq }),
          observation, record,
        })
        continue
      }
      if (recovered.sourceSessionId === sessionId) {
        checkedBackgroundCapabilityAuthoring.add(sessionId)
        continue
      }
      const sourceRouteSeq = capabilitySourceRouteSeq(ctx, recovered.sourceSessionId, recovered.routeId)
      candidates.push({
        state: 'active', creatorSessionId: sessionId,
        sourceSessionId: recovered.sourceSessionId, routeId: recovered.routeId,
        ...(sourceRouteSeq === undefined ? {} : { sourceRouteSeq }),
        observation, recovered,
      })
    }
    let restoredAny = false
    for (const candidate of latestCapabilityRecoveryCandidates(candidates)) {
      const sourceSessionId = candidate.sourceSessionId as SessionId
      markCapabilityContextRestore(sourceSessionId)
      if (candidate.state === 'terminal') {
        const restored = await controller.restoreTerminalCapabilityAuthoring(
          candidate.creatorSessionId, candidate.record, candidate.sourceRouteSeq,
        )
        capabilityAuthoringSessions.delete(candidate.creatorSessionId)
        if (restored
          && ctx.sessions.list.getSnapshot().current === candidate.sourceSessionId) {
          await restoreCapabilityContext(sourceSessionId)
        }
        restoredAny = restoredAny || restored
        continue
      }
      capabilityAuthoringSessions.add(candidate.creatorSessionId)
      const restored = await controller.restoreCapabilityAuthoring(
        candidate.creatorSessionId,
        candidate.recovered,
        candidate.observation.waitingFor,
        candidate.sourceRouteSeq,
        candidate.observation.pendingInteraction,
      )
      if (!restored) continue
      await controller.observeCapability(candidate.observation)
      restoredAny = true
    }
    for (const candidate of candidates) {
      if (candidate.sourceRouteSeq !== undefined) {
        checkedBackgroundCapabilityAuthoring.add(candidate.creatorSessionId)
      }
    }
    return restoredAny
  }

  const retryBackgroundCapabilityAuthoring = (): void => {
    if (backgroundRecoveryPending) return
    backgroundRecoveryPending = true
    void recoverBackgroundCapabilityAuthoring()
      .catch(() => false)
      .finally(() => { backgroundRecoveryPending = false })
  }
  const recoverCapabilityAuthoring = async (): Promise<boolean> => {
    const currentRecovered = await recoverCurrentCapabilityAuthoring()
    retryBackgroundCapabilityAuthoring()
    return currentRecovered
  }
  const face = blueprintFace(controller, {
    selectPreset: async (presetId) => {
      if (presetId === 'cordis') {
        ctx.workspaces.startSession(undefined, { agentPreset: 'cordis' })
        return
      }
      await controller.selectPreset(presetId)
    },
    selectNode: (nodeId) => { controller.selectNode(nodeId) },
    selectCapability: (capabilityId, label, nodeId) => { controller.selectCapability(capabilityId, label, nodeId) },
    applyChangeSet: changeSet => controller.applyChangeSet(changeSet),
  })

  ctx.on('connection/reset', () => {
    checkedBackgroundCapabilityAuthoring.clear()
    const current = ctx.sessions.list.getSnapshot().current
    if (current !== undefined
      && ctx.sessions.list.getSnapshot().byId[current]?.agentPreset === 'cordis') {
      markCapabilityContextRestore(current)
    }
    void controller.load()
      .then(async () => {
        const recovered = await recoverCapabilityAuthoring()
        if (!recovered) await syncForegroundConversation()
      })
      .catch(() => undefined)
  })
  let observedSession = ctx.sessions.list.getSnapshot().current
  let observedRuntimePreset = observedSession === undefined
    ? undefined
    : ctx.sessions.list.getSnapshot().byId[observedSession]?.agentPreset
  ctx.effect(() => ctx.sessions.list.subscribe(() => {
    const list = ctx.sessions.list.getSnapshot()
    const current = list.current
    const runtimePreset = current === undefined ? undefined : list.byId[current]?.agentPreset
    if (current === observedSession && runtimePreset === observedRuntimePreset) return
    observedSession = current
    observedRuntimePreset = runtimePreset
    if (current !== undefined && runtimePreset === 'cordis') markCapabilityContextRestore(current)
    void controller.activateSession(current, runtimePreset).then(async () => {
      const recovered = await recoverCapabilityAuthoring()
      if (!recovered) await syncForegroundConversation()
    }).catch(async () => { await syncForegroundConversation() })
  }), 'ui-blueprint: conversation context session')

  if (observedSession !== undefined && observedRuntimePreset === 'cordis') {
    markCapabilityContextRestore(observedSession)
  }
  void controller.activateSession(observedSession, observedRuntimePreset)
    .then(async () => {
      const recovered = await recoverCapabilityAuthoring()
      if (!recovered) await syncForegroundConversation()
    })
    .catch(() => undefined)

  ctx.effect(() => {
    let stopSession = (): void => {}
    let boundSessionId: SessionId | undefined
    let recoveryRetry: number | undefined
    const recoveryChecked = new Set<SessionId>()
    const recoveryPending = new Set<SessionId>()
    const observeSession = (
      sessionId: SessionId,
      presetId: string | undefined,
      snapshot: ConversationSnapshot,
    ): void => {
      const route = creatorAuthoringRoutes(snapshot).at(-1)
      if (route !== undefined && continueCreatorRoute(sessionId, route.route)) return
      void controller.observeCapability(capabilityObservation(sessionId, snapshot))
      void controller.observeCreator(creatorObservation(sessionId, presetId, snapshot))
    }
    const retryRecovery = (sessionId: SessionId): void => {
      if (recoveryRetry !== undefined) return
      recoveryRetry = window.setTimeout(() => {
        recoveryRetry = undefined
        if (ctx.sessions.list.getSnapshot().current === sessionId) attach()
      }, 250)
    }
    const recoverCreatorSessionIfNeeded = (
      sessionId: SessionId,
      presetId: string | undefined,
      observe: () => void,
    ): boolean => {
      if (presetId !== 'cordis' || recoveryChecked.has(sessionId)) return false
      recoveryChecked.add(sessionId)
      recoveryPending.add(sessionId)
      void recoverCurrentCapabilityAuthoring().then(async (recovered) => {
        recoveryPending.delete(sessionId)
        if (!recovered && ctx.sessions.list.getSnapshot().current === sessionId) {
          await syncForegroundConversation()
          if (ctx.sessions.list.getSnapshot().current === sessionId) observe()
        }
      }).catch(() => {
        recoveryPending.delete(sessionId)
        recoveryChecked.delete(sessionId)
        retryRecovery(sessionId)
      })
      return true
    }
    const attach = (): void => {
      const list = ctx.sessions.list.getSnapshot()
      const current = list.current
      if (current === boundSessionId) {
        const summary = current === undefined ? undefined : list.byId[current]
        const binding = current === undefined ? undefined : ctx.sessions.binding(current)
        if (current !== undefined && summary !== undefined && binding !== undefined) {
          if (capabilityAuthoringSessions.has(current)) return
          if (recoveryPending.has(current)) return
          if (recoverCreatorSessionIfNeeded(current, summary.agentPreset, () => {
            observeSession(current, summary.agentPreset, binding.session.getSnapshot())
          })) return
          observeSession(current, summary.agentPreset, binding.session.getSnapshot())
        }
        return
      }
      stopSession()
      stopSession = (): void => {}
      boundSessionId = current
      if (current === undefined) return
      const binding = ctx.sessions.binding(current)
      if (binding === undefined) return
      const observe = (): void => {
        const summary = ctx.sessions.list.getSnapshot().byId[current]
        if (capabilityAuthoringSessions.has(current)) return
        if (recoveryPending.has(current)) return
        if (recoverCreatorSessionIfNeeded(current, summary?.agentPreset, () => {
          observeSession(current, summary?.agentPreset, binding.session.getSnapshot())
        })) return
        observeSession(current, summary?.agentPreset, binding.session.getSnapshot())
      }
      observe()
      stopSession = binding.session.subscribe(observe)
    }
    const stopList = ctx.sessions.list.subscribe(attach)
    attach()
    const timer = window.setInterval(() => {
      void controller.pollCreator()
      retryBackgroundCapabilityAuthoring()
    }, 1000)
    return () => {
      if (recoveryRetry !== undefined) window.clearTimeout(recoveryRetry)
      window.clearInterval(timer)
      stopList()
      stopSession()
    }
  }, 'ui-blueprint: creator session coordinator')

  ctx.effect(() => {
    const subscriptions = new Map<SessionId, { stop: () => void; observe: () => void }>()
    const attach = (): void => {
      const desired = new Set(creatorAuthoringContinuations.keys())
      for (const [sessionId, subscription] of subscriptions) {
        if (desired.has(sessionId)) {
          subscription.observe()
          continue
        }
        subscription.stop()
        subscriptions.delete(sessionId)
      }
      for (const sessionId of desired) {
        if (subscriptions.has(sessionId)) continue
        const binding = ctx.sessions.binding(sessionId)
        if (binding === undefined) continue
        const observe = (): void => {
          void observeCreatorContinuation(sessionId).catch(() => undefined)
        }
        subscriptions.set(sessionId, { stop: binding.session.subscribe(observe), observe })
        observe()
      }
    }
    refreshCreatorAuthoringSubscriptions = attach
    const stopList = ctx.sessions.list.subscribe(attach)
    attach()
    return () => {
      refreshCreatorAuthoringSubscriptions = (): void => {}
      stopList()
      for (const subscription of subscriptions.values()) subscription.stop()
      subscriptions.clear()
    }
  }, 'ui-blueprint: background Creator authoring lifecycle')

  ctx.effect(() => {
    const stops = new Map<SessionId, () => void>()
    const reconciling = new Set<SessionId>()
    const attach = (): void => {
      const desired = new Set(controller.capabilityAuthoringSessionIds().map(sessionId => sessionId as SessionId))
      for (const [sessionId, stop] of stops) {
        if (desired.has(sessionId)) continue
        if (reconciling.has(sessionId)) continue
        stop()
        stops.delete(sessionId)
        capabilityAuthoringSessions.delete(sessionId)
      }
      for (const sessionId of desired) {
        if (stops.has(sessionId)) continue
        const binding = ctx.sessions.binding(sessionId)
        if (binding === undefined) continue
        const sourceSessionId = controller.capabilityAuthoringSourceSessionId(sessionId)
        if (sourceSessionId !== undefined) markCapabilityContextRestore(sourceSessionId as SessionId)
        const observe = (): void => {
          const sourceSessionId = controller.capabilityAuthoringSourceSessionId(sessionId)
          const observation = capabilityObservation(sessionId, binding.session.getSnapshot())
          reconciling.add(sessionId)
          void controller.observeCapability(observation).then(async () => {
            reconciling.delete(sessionId)
            if (controller.hasCapabilityAuthoringSession(sessionId)) return
            attach()
            if (sourceSessionId !== undefined
              && ctx.sessions.list.getSnapshot().current === sourceSessionId) {
              await restoreCapabilityContext(sourceSessionId as SessionId)
            }
            syncCapabilityComposerBlocks()
          }).catch(() => { reconciling.delete(sessionId) })
        }
        observe()
        stops.set(sessionId, binding.session.subscribe(observe))
      }
    }
    const stopStore = controller.store.subscribe(attach)
    const stopList = ctx.sessions.list.subscribe(attach)
    attach()
    return () => {
      stopList()
      stopStore()
      for (const stop of stops.values()) stop()
      stops.clear()
      reconciling.clear()
    }
  }, 'ui-blueprint: capability configuration lifecycle')

  ctx.effect(() => {
    const sync = (): void => {
      capabilityComposerBlocks.sync([
        ...controller.capabilityInputBlockedSessionIds().map(sessionId => sessionId as SessionId),
        ...capabilityContextRestorePending.sessionIds().map(sessionId => sessionId as SessionId),
      ], capabilityAuthoringSessions)
    }
    syncCapabilityComposerBlocks = sync
    const stop = controller.store.subscribe(sync)
    sync()
    return () => {
      syncCapabilityComposerBlocks = (): void => {}
      stop()
      capabilityComposerBlocks.dispose()
    }
  }, 'ui-blueprint: source capability composer block')

  ctx.effect(() => {
    let projectedSource: SessionId | undefined
    const sync = (): void => {
      const current = ctx.sessions.list.getSnapshot().current
      const interaction = blueprintComposerInteraction(controller.store.getSnapshot(), current)
      if (projectedSource !== undefined && (projectedSource !== current || interaction === undefined)) {
        ctx.conversation.interactions.set(projectedSource, [])
        projectedSource = undefined
      }
      if (current === undefined || interaction === undefined) return
      ctx.conversation.interactions.set(current, [interaction])
      projectedSource = current
    }
    const stopController = controller.store.subscribe(sync)
    const stopSessions = ctx.sessions.list.subscribe(sync)
    sync()
    return () => {
      stopController()
      stopSessions()
      if (projectedSource !== undefined) ctx.conversation.interactions.set(projectedSource, [])
    }
  }, 'ui-blueprint: source composer background Creator interactions')

  registerBlueprintSlots(ctx, face)
}
