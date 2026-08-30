import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'

it.skipIf(process.env.DSH_EXAMPLE_MODE !== 'lib')('the runnable composition keeps Add capability intent separate from routing guidance', async () => {
  const require = createRequire(import.meta.url)
  const { boot } = require('../../../packages/boot/app-boot/lib/index.js') as typeof import('@deepseek-ai/dsh-app-boot')
  const { default: AgentPresets } = require('../../../packages/preset/agent-presets/lib/index.js') as typeof import('@deepseek-ai/dsh-agent-presets')
  const { default: BlueprintAdapter } = require('../../../packages/preset/blueprint-adapter/lib/index.js') as typeof import('@deepseek-ai/dsh-blueprint-adapter')
  const { SessionId } = require('../../../packages/core/session/lib/index.js') as typeof import('@deepseek-ai/dsh-session')
  const root = await mkdtemp(join(tmpdir(), 'dsh-routing-snapshot-'))
  const presetsRoot = join(root, 'presets')
  await mkdir(join(presetsRoot, 'source'), { recursive: true })
  await writeFile(join(presetsRoot, 'source', 'agent.cordis.yml'), '[]\n')
  const ctx = await boot('routing-snapshot', fileURLToPath(new URL('../../../examples/headless-agent/cordis.yml', import.meta.url)), [
    { id: 'settings', config: { path: join(root, 'settings.yml'), watch: false } },
    { id: 'credentials', config: { path: join(root, 'credentials.yml'), watch: false } },
    { id: 'llm-deepseek', disabled: true },
    { id: 'agent-spine', config: { agents: [], workspaceContext: false, dshHome: root, skills: { filesystem: { agentsHome: join(root, 'skills') } } } },
    { id: 'persistence', config: { root: join(root, 'sessions'), compression: 'none' } },
    { id: 'fs-local', config: { cwd: root } },
  ])
  try {
    await ctx.plugin(AgentPresets, { default: 'source', roots: [{ path: presetsRoot, trust: 'user' }], includeUserRoot: false })
    await ctx.plugin(BlueprintAdapter)
    const request = '增加一个本地 CSV 财务指标处理能力。'
    const adapter = new MockAdapter([
      toolCallResponse('skill-route', 'route_blueprint_capability_authoring', { request, kind: 'skill', reason: 'A reusable CSV processing definition is required.' }),
      toolCallResponse('wrong-create', 'route_blueprint_creator_authoring', { name: 'Wrong Agent', user_intent: request }),
      textResponse('The Skill request remains attached to the current Agent.'),
    ])
    ctx.llm.registerAdapter(['routing-replay'], adapter)
    const agent = (await ctx.agents.create({
      sessionId: SessionId('routing-source'), meta: { cwd: root, agentPreset: 'source' },
      agentOptions: { provider: 'routing-replay', model: 'routing-replay' },
      setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'source') },
    })).agent
    agent.ctx.systemPrompt.context({ name: 'routing-example', order: 119, text: 'Example only: create a new Agent / 创建新的 Agent.' })
    const transcript: string[] = []
    ctx.on('session/event', (session, event: SessionEvent) => {
      if (session.id !== agent.id) return
      if (event.type === 'blueprint/routing-input') transcript.push(`action: ${event.data.uiAction} -> ${event.data.targetPresetId}`)
      if (event.type === 'user/message' && event.data.source.kind === 'user') transcript.push(`user: ${event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')}`)
      if (event.type === 'blueprint/route-decision') transcript.push(`selected: ${event.data.operation}`)
      if (event.type === 'tool/result') transcript.push(`route: ${event.data.message.content[0].isError ? 'rejected' : 'accepted'}`)
      if (event.type === 'blueprint/creator-authoring') transcript.push('ERROR: new Agent handoff')
      if (event.type === 'turn/end') transcript.push(`turn: ${event.data.reason.kind}`)
    }, { global: true })
    const blueprint = await ctx.blueprintAdapter.read('source')
    await ctx.blueprintAdapter.setConversationContext({ sessionId: String(agent.id), presetId: 'source', revision: blueprint.revision,
      capabilityInput: { routeId: 'routing-example', userRequest: request } })
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect((await ctx.agentPresets.list()).map(preset => preset.id)).toEqual(['source'])
    expect(transcript).toMatchInlineSnapshot(`
      [
        "action: add-capability -> source",
        "user: 增加一个本地 CSV 财务指标处理能力。",
        "selected: skill",
        "route: accepted",
        "turn: completed",
      ]
    `)
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
