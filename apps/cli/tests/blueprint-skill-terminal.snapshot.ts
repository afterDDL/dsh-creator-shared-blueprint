import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { MockAdapter, textResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'

// The Loader and its consumers share the built module instances, as in the handoff snapshot.
it.skipIf(process.env.DSH_EXAMPLE_MODE !== 'lib')('settles mounted Skill authoring in the runnable app without a browser', async () => {
  const require = createRequire(import.meta.url)
  const { boot } = require('../../../packages/boot/app-boot/lib/index.js') as typeof import('@deepseek-ai/dsh-app-boot')
  const { default: AgentPresets } = require('../../../packages/preset/agent-presets/lib/index.js') as typeof import('@deepseek-ai/dsh-agent-presets')
  const { default: BlueprintAdapter } = require('../../../packages/bundle/shared-blueprint/lib/index.js') as typeof import('@deepseek-ai/dsh-shared-blueprint')
  const { CallId, createToolResultMessage, createUserMessage } = require('../../../packages/llm/llm/lib/index.js') as typeof import('@deepseek-ai/dsh-llm')
  const { decodeStorageRecord, SessionId } = require('../../../packages/core/session/lib/index.js') as typeof import('@deepseek-ai/dsh-session')
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-terminal-snapshot-'))
  for (const id of ['research', 'cordis']) {
    await mkdir(join(root, id))
    await writeFile(join(root, id, 'agent.cordis.yml'), '[]\n')
  }
  const ctx = await boot('skill-terminal-snapshot', fileURLToPath(new URL('../../../examples/headless-agent/cordis.yml', import.meta.url)), [
    { id: 'settings', config: { path: join(root, 'settings.yml'), watch: false } },
    { id: 'credentials', config: { path: join(root, 'credentials.yml'), watch: false } },
    { id: 'llm-deepseek', disabled: true },
    { id: 'agent-spine', config: {
      agents: [], workspaceContext: false, dshHome: root,
      skills: { filesystem: { agentsHome: join(root, 'skills'), includeDefaultRoots: false } },
    } },
    { id: 'persistence', config: { root: join(root, 'sessions'), compression: 'none' } },
    { id: 'fs-local', config: { cwd: root } },
  ])
  try {
    await ctx.plugin(AgentPresets, { default: 'research', roots: [{ path: root, trust: 'user' }], includeUserRoot: false })
    await ctx.plugin(BlueprintAdapter)
    ctx.llm.registerAdapter(['skill-replay'], new MockAdapter([textResponse('The CSV Skill is mounted on the existing Agent.')]))
    const baseline = await ctx.blueprintAdapter.read('research', { cwd: root })
    const sourceSessionId = 'skill-source'
    const routeId = 'skill-terminal-route'
    const request = 'Add a CSV financial metrics Skill.'
    const source = ctx.sessions.create(SessionId(sourceSessionId))
    source.append('turn/start', { turn: 1 })
    const sourceMessage = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: request }] })
    source.append('blueprint/routing-input', {
      routeId, sourceSessionId: source.id, messageId: sourceMessage.id, userRequest: request,
      uiAction: 'add-capability', targetPresetId: 'research',
    })
    const sourceUser = source.append('user/message', sourceMessage, { surfaceOp: 'append' })
    const callId = CallId('skill-terminal-call')
    source.append('step/start', { turn: 1, step: 1 })
    source.append('tool/call', {
      turn: 1, step: 1, callId, name: 'route_blueprint_capability_authoring', arguments: '{}',
    })
    source.append('blueprint/route-decision', {
      routeId, sourceSessionId: source.id, userMessageId: sourceMessage.id, userMessageSeq: sourceUser.seq,
      turn: 1, operation: 'skill', callId, targetPresetId: 'research', provenance: 'add-capability',
    })
    source.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'Route accepted.' }], isError: false }),
      meta: { blueprintCapabilityAuthoring: {
        routeId, sourceSessionId, presetId: 'research', revision: baseline.revision, request, kind: 'skill',
        reason: 'A reusable CSV Skill definition is required.',
      } },
    }, { surfaceOp: 'append' })
    source.append('step/end', { turn: 1, step: 1 })
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const creatorSessionId = `creator-capability-${createHash('sha256')
      .update(JSON.stringify(['blueprint-capability-authoring', sourceSessionId, routeId])).digest('hex')}`
    const { agent } = await ctx.agents.create({
      sessionId: SessionId(creatorSessionId), meta: { cwd: root, agentPreset: 'cordis' },
      agentOptions: { provider: 'skill-replay', model: 'skill-replay' },
      setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'cordis') },
    })
    const transcript: string[] = []
    let resolveTerminal!: () => void
    const terminal = new Promise<void>((resolve) => { resolveTerminal = resolve })
    ctx.on('session/event', (_session, event: SessionEvent) => {
      if (event.type === 'blueprint/capability-authoring') {
        transcript.push(`skill authoring: ${event.data.state === 'started' ? 'started with baseline' : event.data.outcome}`)
        if (event.data.state === 'ended') resolveTerminal()
      }
      if (event.type === 'turn/start') transcript.push('creator: turn started')
      if (event.type === 'assistant/message') transcript.push('creator: mounted Skill reported')
      if (event.type === 'turn/end') transcript.push(`creator: ${event.data.reason.kind}`)
    }, { global: true })
    await ctx.blueprintAdapter.setConversationContext({
      sessionId: String(agent.id), capabilityAuthoring: {
        routeId, sourceSessionId, kind: 'skill', targetPresetId: 'research',
        baseRevision: baseline.revision, request,
      },
    })
    const skillRoot = join(root, 'research', 'skills')
    await mkdir(join(skillRoot, 'csv-metrics'), { recursive: true })
    await writeFile(join(skillRoot, 'csv-metrics', 'SKILL.md'), '---\nname: csv-metrics\ndescription: Extract revenue and net income from local CSV.\n---\nRead only the requested CSV columns.\n')
    const provider = pathToFileURL(require.resolve('../../../packages/skill/skill-filesystem/lib/index.js')).href
    await writeFile(join(root, 'research', 'agent.cordis.yml'), JSON.stringify([{
      id: 'csv-skills', name: provider,
      config: { providerName: 'csv-local', includeDefaultRoots: false, customSkillDirs: [skillRoot], watch: false },
    }]))
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Confirm the CSV Skill is mounted.' }] }))
    await agent.whenIdle()
    await terminal
    const recovery = await ctx.blueprintAdapter.setConversationContext({ sessionId: String(agent.id), recoverCapabilityAuthoring: true })
    const recoveredRecord = recovery.capabilityAuthoringRecord
    if (recoveredRecord?.state !== 'ended' || recoveredRecord.endSeq === undefined) {
      throw new Error('Skill authoring recovery omitted its durable terminal sequence')
    }
    expect(recoveredRecord).toMatchObject({ state: 'ended', outcome: 'completed', targetPresetId: 'research' })
    const projected = await ctx.blueprintAdapter.read('research', { cwd: root })
    expect(projected.nodes).toContainEqual(expect.objectContaining({ id: 'capability:skill:csv-metrics', source: 'preset', status: 'active' }))
    const location = ctx.sessionPersistence.locate(agent.session.header)
    if (location === undefined) throw new Error('Missing durable Session location')
    const persisted = (await readFile(location.path, 'utf8')).trim().split('\n')
      .flatMap(line => decodeStorageRecord(JSON.parse(line) as unknown))
    const terminalEvents = persisted.filter(event => event.type === 'blueprint/capability-authoring' && event.data.state === 'ended')
    expect(terminalEvents).toHaveLength(1)
    const terminalEvent = terminalEvents[0]
    if (terminalEvent === undefined || terminalEvent.type !== 'blueprint/capability-authoring'
      || terminalEvent.data.state !== 'ended') throw new Error('Missing durable Skill authoring terminal')
    expect(recoveredRecord.endSeq).toBe(terminalEvent.seq)
    const skillEvidence = terminalEvent.data.skillEvidence
    if (skillEvidence === undefined) throw new Error('Completed Skill authoring omitted mounted catalog evidence')
    const citedTurnEnd = persisted.find(event => event.seq === skillEvidence.turnEndSeq)
    if (citedTurnEnd?.type !== 'turn/end' || citedTurnEnd.data.reason.kind !== 'completed') {
      throw new Error('Skill authoring evidence does not cite its completed Creator turn')
    }
    expect(skillEvidence).toEqual({
      turnEndSeq: citedTurnEnd.seq, revision: projected.revision,
      skills: [{
        name: 'csv-metrics',
        definitionDigest: '74ba9d970d41541106ee1cf25048971c3117abe824de4ed311a137f75ba29d23',
        invocation: { modelInvocable: true, userInvocable: true },
      }],
    })
    expect(transcript).toMatchInlineSnapshot(`
      [
        "skill authoring: started with baseline",
        "creator: turn started",
        "creator: mounted Skill reported",
        "creator: completed",
        "skill authoring: completed",
      ]
    `)
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
