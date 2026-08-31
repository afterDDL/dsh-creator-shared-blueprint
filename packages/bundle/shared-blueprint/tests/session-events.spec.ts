import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import {
  BLUEPRINT_SESSION_EVENT_OWNER,
  BLUEPRINT_SESSION_EVENT_TYPES,
  registerBlueprintSessionEventTypes,
} from '../src/host/session-events.ts'

describe('Blueprint durable Session event registration', () => {
  it('owns the complete vocabulary for one plugin lifetime', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const plugin = await ctx.plugin(Object.assign((pluginCtx: Context) => {
      pluginCtx.effect(
        () => registerBlueprintSessionEventTypes(pluginCtx),
        'test Blueprint event vocabulary',
      )
    }, { inject: ['sessions'] }))

    for (const type of BLUEPRINT_SESSION_EVENT_TYPES) {
      expect(() => ctx.sessions.eventTypes.register({ type, owner: BLUEPRINT_SESSION_EVENT_OWNER }))
        .toThrow(new RegExp(`already registered by ${JSON.stringify(BLUEPRINT_SESSION_EVENT_OWNER)}`))
    }

    await plugin.dispose()
    const disposers = BLUEPRINT_SESSION_EVENT_TYPES.map(type => (
      ctx.sessions.eventTypes.register({ type, owner: BLUEPRINT_SESSION_EVENT_OWNER })
    ))
    for (const dispose of disposers) dispose()
  })

  it('rolls back earlier registrations when one event collides', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const conflict = BLUEPRINT_SESSION_EVENT_TYPES[1]
    const disposeConflict = ctx.sessions.eventTypes.register({ type: conflict, owner: BLUEPRINT_SESSION_EVENT_OWNER })

    expect(() => registerBlueprintSessionEventTypes(ctx)).toThrow(/already registered by/)
    const disposeFirst = ctx.sessions.eventTypes.register({
      type: BLUEPRINT_SESSION_EVENT_TYPES[0],
      owner: BLUEPRINT_SESSION_EVENT_OWNER,
    })

    disposeFirst()
    disposeConflict()
  })
})
