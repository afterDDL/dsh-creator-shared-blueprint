import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import DynamicCordisRunnerService from '@deepseek-ai/dsh-cordis-host-runner'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { retainHostInspectProviders } from '../src/providers.ts'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(DynamicCordisRunnerService, {})
  return ctx
}

describe('Host inspect provider ownership', () => {
  it('shares one provider set across live tool-cordis instances', async () => {
    const ctx = await setup()
    const first = retainHostInspectProviders(ctx)
    const second = retainHostInspectProviders(ctx)

    expect(ctx.cordisInspect.list().filter(provider => provider.platform === 'host').map(provider => provider.id))
      .toEqual(['Service', 'Event', 'Builtin', 'Tool'])

    first()
    expect(ctx.cordisInspect.list().filter(provider => provider.platform === 'host')).toHaveLength(4)

    second()
    second()
    expect(ctx.cordisInspect.list().filter(provider => provider.platform === 'host')).toEqual([])
  })

  it('rolls back earlier providers when a later registration conflicts', async () => {
    const ctx = await setup()
    const releaseConflict = ctx.cordisInspect.register({
      manifest: { id: 'Event', description: 'conflicting provider', methods: [] },
      query: () => Promise.resolve(null),
    })

    expect(() => retainHostInspectProviders(ctx)).toThrow('Host Cordis inspect provider "Event" is already registered')
    expect(ctx.cordisInspect.list().filter(provider => provider.platform === 'host').map(provider => provider.id))
      .toEqual(['Event'])

    releaseConflict()
  })
})
