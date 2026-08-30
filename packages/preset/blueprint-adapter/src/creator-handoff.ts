/** Exclusive create-agent routing over durable Session events and the existing Agent driver. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { freezeMessage, MessageId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { BlueprintCreatorAuthoringEvent, BlueprintCreatorAuthoringRoute } from './types.ts'

const STOP_REASON = 'blueprint create-agent exclusive handoff'

/**
 * Reserve a single Creator identity and checkpoint its original request before source termination.
 * @param ctx - Host services owning persistence.
 * @param source - routing Agent, still inside the exclusive Tool body.
 * @param route - validated direct-user route.
 * @returns the durable route with its exact source turn and destination.
 */
export async function prepareCreatorHandoff(
  ctx: Context, source: Agent, route: BlueprintCreatorAuthoringRoute,
): Promise<BlueprintCreatorAuthoringRoute> {
  const start = source.session.events.findLast(event => event.type === 'turn/start')
  if (start?.type !== 'turn/start' || source.session.events.some(event =>
    event.type === 'turn/end' && event.data.turn === start.data.turn)) {
    throw new Error('Creator handoff requires an active source turn')
  }
  const targetCreatorSessionId = `creator-${createHash('sha256')
    .update(JSON.stringify([source.session.id, route.routeId])).digest('hex')}`
  const prepared = {
    ...route,
    sourceSessionId: String(source.session.id),
    handoff: { sourceTurn: start.data.turn, targetCreatorSessionId },
  }
  const prior = source.session.events.find(event => event.type === 'blueprint/creator-authoring'
    && event.data.routeId === route.routeId)
  if (prior === undefined) source.session.append('blueprint/creator-authoring', prepared)
  await ctx.sessions.flush(source.session)
  return prepared
}

/**
 * Stop at the accepted result publication, before the scheduler can dispatch another Tool.
 * @param ctx - Host Agent registry.
 * @param session - emitting source Session.
 * @param event - newly committed event; cancellation must not reenter Session.append.
 */
export function stopAcceptedCreatorRoute(ctx: Context, session: Session, event: SessionEvent): void {
  if (event.type !== 'tool/result' || event.data.message.content[0].isError) return
  const prepared = session.events.find(candidate => candidate.type === 'blueprint/creator-authoring'
    && candidate.data.handoff !== undefined && candidate.data.sourceSessionId === session.id
    && candidate.data.routeId === event.data.message.source.callId)
  if (prepared?.type !== 'blueprint/creator-authoring') return
  ctx.agents.get(session.id)?.cancel({ kind: 'hook', reason: STOP_REASON }, { keepInbox: true })
}

/**
 * Admit exactly one Creator continuation after durable acceptance and actual source quiescence.
 * The caller serializes this operation with other context updates for the destination Session.
 * @param ctx - Host registry and persistence.
 * @param creator - distinct Creator Agent with its authoring context already installed.
 * @param task - original task adopted from the source log.
 */
export async function startExclusiveCreator(ctx: Context, creator: Agent, task: BlueprintCreatorAuthoringEvent): Promise<void> {
  const fence = task.handoff
  if (fence === undefined) throw new Error('Creator handoff is missing its source-turn fence')
  if (creator.session.id !== fence.targetCreatorSessionId || creator.session.id === task.sourceSessionId) {
    throw new Error('Creator handoff destination does not own this route')
  }
  const source = ctx.agents.get(task.sourceSessionId as SessionId)
  if (source === undefined) throw new Error('Creator handoff: reopen the source conversation before retrying')
  const prepared = source.session.events.find(event => event.type === 'blueprint/creator-authoring'
    && event.data.routeId === task.routeId)
  if (prepared?.type !== 'blueprint/creator-authoring'
    || prepared.data.sourceSessionId !== task.sourceSessionId
    || prepared.data.request !== task.request || prepared.data.name !== task.name
    || prepared.data.sourceLanguage !== task.sourceLanguage
    || prepared.data.handoff?.sourceTurn !== fence.sourceTurn
    || prepared.data.handoff.targetCreatorSessionId !== fence.targetCreatorSessionId) {
    throw new Error('Creator handoff does not match the durable source request')
  }
  const accepted = source.session.events.find(event => event.type === 'tool/result'
    && event.data.turn === fence.sourceTurn && event.data.message.source.callId === task.routeId
    && !event.data.message.content[0].isError)
  if (accepted === undefined) throw new Error('Creator handoff source route was not accepted')
  const continuationId = MessageId(`blueprint-creator:${task.routeId}`)
  // An inbox insertion is the durable delivery receipt, including after claim, cancellation, or completion.
  if (creator.session.events.some(event => event.type === 'agent/inbox/spliced'
    && event.data.inserted.some(message => message.id === continuationId))) return
  await ctx.sessions.flush(creator.session)
  const ended = (): boolean => source.session.events.some(event => event.type === 'turn/end'
    && event.data.turn === fence.sourceTurn && event.seq > accepted.seq)
  if (!ended()) {
    source.cancel({ kind: 'hook', reason: STOP_REASON }, { keepInbox: true })
  }
  await source.whenIdle()
  if (!ended() || source.status !== 'idle') {
    throw new Error('Creator handoff failed: source turn has not reached quiescence')
  }
  await ctx.sessions.flush(source.session)
  creator.followup(freezeMessage({
    id: continuationId,
    role: 'user',
    content: [{ type: 'text', text: 'Continue the typed create-agent authoring task already recorded in this Session context.' }],
    source: { kind: 'plugin', plugin: 'blueprint-adapter', form: 'notice', summary: 'Creator handoff continuation' },
  }))
  await ctx.sessions.flush(creator.session)
}
