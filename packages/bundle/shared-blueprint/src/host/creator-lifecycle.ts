/** Creator task terminal evidence reconstructed from its own durable authoring interval. */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { BlueprintCreatorAuthoringEnd } from '../contract/types.ts'

/**
 * Find a successful preset validation in the recorded Tool result, never Assistant prose.
 * @param events - owning Session log.
 * @param result - settled Tool result.
 * @returns the validated preset id, or undefined for other and failed results.
 */
export function creatorValidatedPreset(events: readonly SessionEvent[], result: SessionEvent): string | undefined {
  if (result.type !== 'tool/result' || result.data.message.content[0].isError) return undefined
  const call = events.find(event => event.type === 'tool/call'
    && event.data.callId === result.data.message.source.callId && event.seq < result.seq)
  if (call?.type !== 'tool/call' || call.data.name !== 'preset_validate') return undefined
  let args: unknown
  try { args = JSON.parse(call.data.arguments) } catch { return undefined /* Invalid model JSON cannot validate a preset. */ }
  if (typeof args !== 'object' || args === null || !('id' in args) || typeof args.id !== 'string') return undefined
  return args.id
}

/**
 * Recover the first terminal result of one task, fenced before another authoring task.
 * @param events - durable Session events in sequence order.
 * @param startSeq - owning Creator task's start sequence.
 * @returns the recorded terminal fact or evidence for its first publication; user stops remain resumable.
 */
export function creatorTerminalEvidence(events: readonly SessionEvent[], startSeq: number): BlueprintCreatorAuthoringEnd | undefined {
  const start = events.find(event => event.seq === startSeq)
  if (start?.type !== 'blueprint/creator-authoring') return undefined
  const recorded = events.find(event => event.type === 'blueprint/creator-authoring-ended'
    && event.data.startSeq === startSeq && event.data.routeId === start.data.routeId)
  if (recorded?.type === 'blueprint/creator-authoring-ended') return recorded.data
  const validations = new Map<string, number>()
  for (const event of events) {
    if (event.seq <= startSeq) continue
    if (event.type === 'blueprint/creator-authoring' || event.type === 'blueprint/capability-authoring') break
    const presetId = creatorValidatedPreset(events, event)
    if (presetId !== undefined) validations.set(presetId, event.seq)
    if (event.type !== 'turn/end') continue
    const identity = { routeId: start.data.routeId, startSeq, turnEndSeq: event.seq }
    if (event.data.reason.kind === 'error') return { ...identity, outcome: 'failed' }
    if (event.data.reason.kind !== 'completed' || validations.size !== 1) continue
    const validated = validations.entries().next().value
    if (validated === undefined) continue
    const [targetPresetId, validationSeq] = validated
    return { ...identity, outcome: 'completed', targetPresetId, validationSeq }
  }
  return undefined
}
