/** Durable source authority for one existing-preset capability-authoring continuation. */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { BLUEPRINT_CAPABILITY_AUTHORING_TOOL } from './proposal.ts'
import type {
  BlueprintCapabilityAuthoringEvent,
  BlueprintCapabilityAuthoringRoute,
  BlueprintConversationContextRequest,
} from './types.ts'

type CapabilityAuthoringRequest = NonNullable<BlueprintConversationContextRequest['capabilityAuthoring']>
type CapabilityAuthoringStart = Extract<BlueprintCapabilityAuthoringEvent, { state: 'started' }>

const CREATOR_INITIALIZATION_EVENT_TYPES = new Set([
  'permission/preset',
  'sandbox/mode',
  'approval/policy',
])

function hasOnlyFreshCreatorInitialization(session: Session): boolean {
  const seen = new Set<string>()
  for (const event of session.events) {
    if (!CREATOR_INITIALIZATION_EVENT_TYPES.has(event.type) || seen.has(event.type)) return false
    seen.add(event.type)
  }
  return true
}

/** One source-accepted route and its existing child adoption, when a retry is still active. */
export interface DurableCapabilityAuthoringAuthority {
  /** Source Session whose successful Tool result owns the route content. */
  source: Session
  /** Sequence of the successful source Tool result. */
  resultSeq: number
  /** Exact route reconstructed from that result. */
  route: BlueprintCapabilityAuthoringRoute
  /** Existing active adoption in the only admissible child, for an idempotent retry. */
  existingStart?: { seq: number; data: CapabilityAuthoringStart }
}

/**
 * Derive the sole Creator Session identity that may adopt one source route.
 * @param sourceSessionId - Session that owns the successful routing result.
 * @param routeId - source-owned interaction identity.
 * @returns domain-separated deterministic Creator Session id.
 */
export function capabilityAuthoringCreatorSessionId(sourceSessionId: string, routeId: string): string {
  return `creator-capability-${createHash('sha256')
    .update(JSON.stringify(['blueprint-capability-authoring', sourceSessionId, routeId])).digest('hex')}`
}

function requiredText(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`blueprint capability authoring authority: durable route ${key} must be non-empty text`)
  }
  return value
}

function parseRoute(value: unknown): BlueprintCapabilityAuthoringRoute {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('blueprint capability authoring authority: durable Tool result route is missing')
  }
  const record = value as Record<string, unknown>
  const kind = record['kind']
  if (kind !== 'skill' && kind !== 'subagent') {
    throw new Error('blueprint capability authoring authority: durable route kind must be skill or subagent')
  }
  return {
    routeId: requiredText(record, 'routeId'),
    sourceSessionId: requiredText(record, 'sourceSessionId'),
    presetId: requiredText(record, 'presetId'),
    revision: requiredText(record, 'revision'),
    request: requiredText(record, 'request'),
    kind,
    reason: requiredText(record, 'reason'),
  }
}

function sameRequest(route: BlueprintCapabilityAuthoringRoute, request: CapabilityAuthoringRequest): boolean {
  return route.routeId === request.routeId
    && route.sourceSessionId === request.sourceSessionId
    && route.presetId === request.targetPresetId
    && route.revision === request.baseRevision
    && route.request === request.request
    && route.kind === request.kind
}

function sameStart(route: BlueprintCapabilityAuthoringRoute, start: CapabilityAuthoringStart): boolean {
  return route.routeId === start.routeId
    && route.sourceSessionId === start.sourceSessionId
    && route.presetId === start.targetPresetId
    && route.revision === start.baseRevision
    && route.request === start.request
    && route.kind === start.kind
}

interface AcceptedCapabilityRoute {
  resultSeq: number
  sourceTurn: number
  route: BlueprintCapabilityAuthoringRoute
}

function resolveSourceRoute(source: Session, routeId: string): AcceptedCapabilityRoute {
  const accepted: AcceptedCapabilityRoute[] = []
  for (const decision of source.events) {
    if (decision.type !== 'blueprint/route-decision' || decision.data.sourceSessionId !== source.id
      || decision.data.routeId !== routeId
      || (decision.data.operation !== 'skill' && decision.data.operation !== 'subagent')) continue
    const call = source.events.find(event => event.seq < decision.seq && event.type === 'tool/call'
      && String(event.data.callId) === String(decision.data.callId)
      && event.data.turn === decision.data.turn && event.data.name === BLUEPRINT_CAPABILITY_AUTHORING_TOOL)
    if (call?.type !== 'tool/call') continue
    const results = source.events.filter(event => event.seq > decision.seq && event.type === 'tool/result'
      && String(event.data.message.source.callId) === String(decision.data.callId)
      && event.data.turn === call.data.turn && event.data.step === call.data.step
      && event.data.message.content[0].isError === false)
    for (const result of results) {
      if (result.type !== 'tool/result') continue
      const route = parseRoute((result.data.meta as Record<string, unknown> | undefined)?.['blueprintCapabilityAuthoring'])
      if (route.sourceSessionId !== String(source.id) || route.routeId !== decision.data.routeId
        || route.presetId !== decision.data.targetPresetId || route.kind !== decision.data.operation) {
        throw new Error('blueprint capability authoring authority: durable route does not match its source decision')
      }
      const turnStart = source.events.find(event => event.type === 'turn/start'
        && event.data.turn === decision.data.turn && event.seq < result.seq)
      if (turnStart?.type !== 'turn/start') {
        throw new Error('blueprint capability authoring authority: accepted route has no owning source turn')
      }
      accepted.push({ resultSeq: result.seq, sourceTurn: decision.data.turn, route })
    }
  }
  if (accepted.length !== 1) {
    throw new Error('blueprint capability authoring authority: expected exactly one successful source Tool result with a matching call and route decision')
  }
  const [authority] = accepted
  if (authority === undefined) {
    throw new Error('blueprint capability authoring authority: accepted route disappeared after cardinality validation')
  }
  return authority
}

async function awaitAcceptedSourceTurnEnd(
  ctx: Context,
  source: Session,
  accepted: AcceptedCapabilityRoute,
): Promise<void> {
  const settled = (): boolean => source.events.some(event => event.type === 'turn/end'
    && event.data.turn === accepted.sourceTurn && event.seq > accepted.resultSeq)
  if (!settled()) {
    const sourceAgent = ctx.agents.get(source.id)
    if (sourceAgent === undefined) {
      throw new Error('blueprint capability authoring authority: reopen the source conversation until its accepted routing turn settles')
    }
    await sourceAgent.whenIdle()
    await ctx.sessions.flush(source)
  }
  if (!settled()) {
    throw new Error('blueprint capability authoring authority: accepted source routing turn has not durably ended')
  }
}

/**
 * Admit one browser continuation only when source authority and the unique child agree exactly.
 * Validation completes before callers may change child lifecycle or conversation context.
 * @param ctx - Host Session store owning durable source and child logs.
 * @param creator - proposed Creator child.
 * @param request - untrusted browser continuation DTO.
 * @returns reconstructed route authority and an optional active idempotent adoption.
 */
export async function resolveDurableCapabilityAuthoring(
  ctx: Context,
  creator: Agent,
  request: CapabilityAuthoringRequest,
): Promise<DurableCapabilityAuthoringAuthority> {
  const source = ctx.sessions.get(request.sourceSessionId as SessionId)
  if (source === undefined) {
    throw new Error('blueprint capability authoring authority: source Session is not available')
  }
  await ctx.sessions.flush(source)
  const accepted = resolveSourceRoute(source, request.routeId)
  if (!sameRequest(accepted.route, request)) {
    throw new Error('blueprint capability authoring authority: browser continuation differs from the durable source route')
  }
  const authoringSessionId = String(creator.session.id)
  const sameSource = authoringSessionId === request.sourceSessionId
  const expectedCreator = capabilityAuthoringCreatorSessionId(request.sourceSessionId, request.routeId)
  if (!sameSource && authoringSessionId !== expectedCreator) {
    throw new Error('blueprint capability authoring authority: authoring Session does not own this source route')
  }

  const starts = creator.session.events.filter(event => event.type === 'blueprint/capability-authoring'
    && event.data.state === 'started')
  const matchingStarts = starts.filter(event => event.type === 'blueprint/capability-authoring'
    && event.data.state === 'started' && event.data.routeId === request.routeId)
  if (matchingStarts.length > 1) {
    throw new Error('blueprint capability authoring authority: interaction has duplicate durable adoptions')
  }
  const existing = matchingStarts[0]
  if (existing?.type === 'blueprint/capability-authoring' && existing.data.state === 'started') {
    if (!sameStart(accepted.route, existing.data)) {
      throw new Error('blueprint capability authoring authority: Creator child already owns a different durable route')
    }
    if (creator.session.events.some(event => event.type === 'blueprint/capability-authoring'
      && event.data.state === 'ended' && event.data.startSeq === existing.seq)) {
      throw new Error('blueprint capability authoring authority: source route was already adopted and settled')
    }
    return { source, resultSeq: accepted.resultSeq, route: accepted.route, existingStart: { seq: existing.seq, data: existing.data } }
  }
  const activeOther = starts.find(event => event.type === 'blueprint/capability-authoring'
    && event.data.state === 'started' && !creator.session.events.some(candidate => (
    candidate.type === 'blueprint/capability-authoring' && candidate.data.state === 'ended'
      && candidate.data.startSeq === event.seq
  )))
  if (activeOther !== undefined) {
    throw new Error('blueprint capability authoring authority: another capability lifecycle is already active')
  }
  if (!sameSource) {
    const sourceAgent = ctx.agents.get(source.id)
    const sourcePreset = sourceAgent === undefined
      ? source.header.agentPreset
      : ctx.agentPresets.composedPreset(sourceAgent.ctx)
    if (sourcePreset === 'cordis') {
      throw new Error('blueprint capability authoring authority: a cordis source must author its new capability in place')
    }
    if (!hasOnlyFreshCreatorInitialization(creator.session)) {
      throw new Error('blueprint capability authoring authority: dedicated Creator fallback must have no prior task history before durable adoption')
    }
  }
  await awaitAcceptedSourceTurnEnd(ctx, source, accepted)
  return { source, resultSeq: accepted.resultSeq, route: accepted.route }
}
