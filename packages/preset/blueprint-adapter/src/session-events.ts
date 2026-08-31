/** Runtime ownership of Interactive Blueprint's durable Session events. */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEventType } from '@deepseek-ai/dsh-session'

/** npm package identity used by the durable event registry. */
export const BLUEPRINT_SESSION_EVENT_OWNER = '@deepseek-ai/dsh-blueprint-adapter'

/** Durable event types whose payload semantics are implemented by this plugin. */
export const BLUEPRINT_SESSION_EVENT_TYPES = [
  'blueprint/apply-result',
  'blueprint/capability-authoring',
  'blueprint/capability-cancel-requested',
  'blueprint/capability-repair',
  'blueprint/capability-verified',
  'blueprint/creator-authoring',
  'blueprint/creator-authoring-ended',
  'blueprint/proposal-cancelled',
  'blueprint/route-decision',
  'blueprint/routing-input',
  'blueprint/user-change',
] as const satisfies readonly SessionEventType[]

/**
 * Register every required Blueprint event for one plugin lifetime.
 * @param ctx - plugin context carrying the Session event registry.
 * @returns an idempotent disposer for the complete registration batch.
 */
export function registerBlueprintSessionEventTypes(ctx: Context): () => void {
  const disposers: (() => void)[] = []
  try {
    for (const type of BLUEPRINT_SESSION_EVENT_TYPES) {
      disposers.push(ctx.sessions.eventTypes.register({ type, owner: BLUEPRINT_SESSION_EVENT_OWNER }))
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  let active = true
  return () => {
    if (!active) return
    active = false
    for (const dispose of disposers.reverse()) dispose()
  }
}
