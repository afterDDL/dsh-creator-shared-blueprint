/** Non-Blueprint external plugin used to prove durable event registration. */

import type { Context } from '@deepseek-ai/cordis'

/** Required durable event type owned by this dummy plugin. */
export const DUMMY_SESSION_EVENT_TYPE = 'dummy/checkpoint' as const

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /** Test-only checkpoint with no core interpretation. */
    'dummy/checkpoint': { readonly label: string }
  }
}

/** Cordis plugin name. */
export const name = 'dummy-session-events'

/** Required services. */
export const inject = ['sessions']

/**
 * Register the dummy event vocabulary for this plugin fiber.
 * @param ctx - context carrying the Session store.
 */
export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.sessions.eventTypes.register({
      type: DUMMY_SESSION_EVENT_TYPE,
      owner: 'dummy-session-events',
    }),
    'dummy-session-events: durable vocabulary',
  )
}
