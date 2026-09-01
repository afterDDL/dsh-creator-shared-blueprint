import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'

// Loader imports the built example plugins; use the same artifact plane for its Host consumers.
it.skipIf(process.env.DSH_EXAMPLE_MODE !== 'lib')('the runnable headless composition transfers execution before Creator continuation', async () => {
  // Native loading shares the Loader's ESM instances rather than Vite's transformed module cache.
  const require = createRequire(import.meta.url)
  const { boot } = require('../../../packages/boot/app-boot/lib/index.js') as typeof import('@deepseek-ai/dsh-app-boot')
  const { default: AgentPresets } = require('../../../packages/preset/agent-presets/lib/index.js') as typeof import('@deepseek-ai/dsh-agent-presets')
  const { default: BlueprintAdapter } = require('../../../packages/bundle/shared-blueprint/lib/index.js') as typeof import('dsh-shared-blueprint')
  const PresetAuthoring = require('../../../packages/preset/tool-agent-preset-authoring/lib/index.js') as typeof import('@deepseek-ai/dsh-tool-agent-preset-authoring')
  const { createUserMessage } = require('../../../packages/llm/llm/lib/index.js') as typeof import('@deepseek-ai/dsh-llm')
  const { SessionId } = require('../../../packages/core/session/lib/index.js') as typeof import('@deepseek-ai/dsh-session')
  const root = await mkdtemp(join(tmpdir(), 'dsh-handoff-snapshot-'))
  for (const id of ['source', 'cordis']) {
    await mkdir(join(root, id))
    await writeFile(join(root, id, 'agent.cordis.yml'), '[]\n')
  }
  const ctx = await boot('handoff-snapshot', fileURLToPath(new URL('../../../examples/headless-agent/cordis.yml', import.meta.url)), [
    { id: 'settings', config: { path: join(root, 'settings.yml'), watch: false } },
    { id: 'credentials', config: { path: join(root, 'credentials.yml'), watch: false } },
    { id: 'llm-deepseek', disabled: true },
    { id: 'agent-spine', config: {
      agents: [], workspaceContext: false, dshHome: root,
      skills: { filesystem: { agentsHome: join(root, 'skills') } },
    } },
    { id: 'persistence', config: { root: join(root, 'sessions'), compression: 'none' } },
    { id: 'fs-local', config: { cwd: root } },
  ])
  try {
    await ctx.plugin(AgentPresets, { default: 'source', roots: [{ path: root, trust: 'user' }], includeUserRoot: false })
    await ctx.plugin(BlueprintAdapter)
    await ctx.plugin(PresetAuthoring)
    const adapter = new MockAdapter([
      toolCallResponse('handoff-route', 'route_blueprint_creator_authoring', {
        name: 'Supplier Review Agent', user_intent: 'Create a new Supplier Review Agent.',
      }),
      toolCallResponse('copy-target', 'preset_copy', { from: 'source', id: 'supplier-review', name: 'Supplier Review Agent' }),
      toolCallResponse('validate-target', 'preset_validate', { id: 'supplier-review' }),
      textResponse('The new Agent is mounted.'),
      textResponse('The original conversation can continue.'),
      textResponse('This is a follow-up about the existing Agent.'),
    ])
    ctx.llm.registerAdapter(['handoff-replay'], adapter)
    const source = (await ctx.agents.create({
      sessionId: SessionId('handoff-source'), meta: { cwd: root, agentPreset: 'source' },
      agentOptions: { provider: 'handoff-replay', model: 'handoff-replay' },
      setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'source') },
    })).agent
    const transcript: string[] = []
    ctx.on('session/event', (session, event: SessionEvent) => {
      const speaker = session.id === source.id ? 'source' : 'creator'
      if (event.type === 'blueprint/creator-authoring') transcript.push(`${speaker}: original request checkpointed`)
      if (event.type === 'tool/result') transcript.push(`${speaker}: route ${event.data.message.content[0].isError ? 'rejected' : 'accepted'}`)
      if (event.type === 'turn/start') transcript.push(`${speaker}: turn started`)
      if (event.type === 'turn/end') transcript.push(`${speaker}: ${event.data.reason.kind}`)
      if (event.type === 'blueprint/creator-authoring-ended') transcript.push(`${speaker}: task ${event.data.outcome}`)
    }, { global: true })
    const blueprint = await ctx.blueprintAdapter.read('source')
    await ctx.blueprintAdapter.setConversationContext({ sessionId: String(source.id), presetId: 'source', revision: blueprint.revision })
    source.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Create a new Supplier Review Agent.' }] }))
    await source.whenIdle()
    const task = source.session.events.find(event => event.type === 'blueprint/creator-authoring')
    if (task?.type !== 'blueprint/creator-authoring' || task.data.handoff === undefined) throw new Error('Missing durable handoff')
    expect(task.data.request).toBe('Create a new Supplier Review Agent.')
    const creator = (await ctx.agents.create({
      sessionId: SessionId(task.data.handoff.targetCreatorSessionId), meta: { cwd: root, agentPreset: 'cordis' },
      agentOptions: { provider: 'handoff-replay', model: 'handoff-replay' },
      setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'cordis') },
    })).agent
    const continuation = { sessionId: String(creator.id), creatorAuthoring: task.data }
    await ctx.blueprintAdapter.setConversationContext(continuation)
    await creator.whenIdle()
    await ctx.blueprintAdapter.setConversationContext(continuation)
    expect(adapter.requests).toHaveLength(4)
    const terminal = creator.session.events.find(event => event.type === 'blueprint/creator-authoring-ended')
    expect(terminal?.data).toMatchObject({ routeId: 'handoff-route', outcome: 'completed', targetPresetId: 'supplier-review' })
    source.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue this conversation without changing anything.' }] }))
    await source.whenIdle()
    expect(adapter.requests).toHaveLength(5)
    creator.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '增加 CSV 能力，但不创建新 Agent。' }] }))
    await creator.whenIdle()
    const recovered = await ctx.blueprintAdapter.setConversationContext({ sessionId: String(creator.id), recoverCreatorAuthoring: true })
    expect(recovered.creatorAuthoring?.terminal).toEqual(terminal?.data)
    await ctx.blueprintAdapter.setConversationContext({ sessionId: String(creator.id), creatorDraft: { name: 'Wrong Agent', status: 'paused' } })
    expect(creator.session.events.filter(event => event.type === 'blueprint/creator-authoring-ended')).toHaveLength(1)
    expect(creator.session.events.filter(event => event.type === 'blueprint/creator-authoring')).toHaveLength(1)
    expect(transcript).toMatchInlineSnapshot(`
      [
        "source: turn started",
        "source: original request checkpointed",
        "source: route accepted",
        "source: aborted",
        "creator: original request checkpointed",
        "creator: turn started",
        "creator: route accepted",
        "creator: route accepted",
        "creator: completed",
        "creator: task completed",
        "source: turn started",
        "source: completed",
        "creator: turn started",
        "creator: completed",
      ]
    `)
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
