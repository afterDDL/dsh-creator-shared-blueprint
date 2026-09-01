/** Keyless Loader entry exercising authoring terminalization without a browser timeline or model business turn. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { CallId, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from 'dsh-shared-blueprint'

const root = await mkdtemp(join(tmpdir(), 'dsh-subagent-snapshot-'))
process.env.DSH_BLUEPRINT_TEST_PRESETS = root
const composition = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: |
      Role: Research analyst

      Purpose: Compare public industry sources.

      Rules:
      1. Separate evidence from inference.

      Output: Source-linked summary.
`
for (const preset of ['cordis', 'research']) {
  await mkdir(join(root, preset))
  await writeFile(join(root, preset, 'agent.cordis.yml'), composition)
}
const ctx = await boot('subagent-completion', fileURLToPath(new URL('../subagent-completion.cordis.yml', import.meta.url)))
try {
  const baseline = await ctx.blueprintAdapter.read('research', { cwd: root })
  const sourceSessionId = 'subagent-source'
  const routeId = 'subagent-completion-route'
  const request = 'Add industry research collaborator.'
  const source = ctx.sessions.create(SessionId(sourceSessionId))
  source.append('turn/start', { turn: 1 })
  const sourceMessage = createUserMessage({
    source: { kind: 'user' }, content: [{ type: 'text', text: request }],
  })
  source.append('blueprint/routing-input', {
    routeId, sourceSessionId: source.id, messageId: sourceMessage.id, userRequest: request,
    uiAction: 'add-capability', targetPresetId: 'research',
  })
  const sourceUser = source.append('user/message', sourceMessage, { surfaceOp: 'append' })
  const callId = CallId('subagent-completion-call')
  source.append('step/start', { turn: 1, step: 1 })
  source.append('tool/call', {
    turn: 1, step: 1, callId, name: 'route_blueprint_capability_authoring', arguments: '{}',
  })
  source.append('blueprint/route-decision', {
    routeId, sourceSessionId: source.id, userMessageId: sourceMessage.id, userMessageSeq: sourceUser.seq,
    turn: 1, operation: 'subagent', callId, targetPresetId: 'research', provenance: 'add-capability',
  })
  source.append('tool/result', {
    turn: 1, step: 1,
    message: createToolResultMessage({
      callId, content: [{ type: 'text', text: 'Route accepted.' }], isError: false,
    }),
    meta: { blueprintCapabilityAuthoring: {
      routeId, sourceSessionId, presetId: 'research', revision: baseline.revision,
      request, kind: 'subagent', reason: 'A dedicated collaborator definition is required.',
    } },
  }, { surfaceOp: 'append' })
  source.append('step/end', { turn: 1, step: 1 })
  source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const creatorSessionId = `creator-capability-${createHash('sha256')
    .update(JSON.stringify(['blueprint-capability-authoring', sourceSessionId, routeId])).digest('hex')}`
  const { agent } = await ctx.agents.create({ sessionId: SessionId(creatorSessionId), meta: { cwd: root, agentPreset: 'cordis' },
    setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'cordis') } })
  await ctx.blueprintAdapter.setConversationContext({ sessionId: String(agent.id),
    capabilityAuthoring: {
      routeId, sourceSessionId, kind: 'subagent', targetPresetId: 'research',
      baseRevision: baseline.revision, request,
    } })
  agent.session.append('turn/start', { turn: 1 })
  const active = await ctx.blueprintAdapter.setConversationContext({
    sessionId: String(agent.id), recoverCapabilityAuthoring: true,
  })
  await writeFile(join(root, 'research', 'agent.cordis.yml'), `${composition}
- id: industry-research
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: industry_research
    backgroundMode: one-shot
    persona: You are Industry Research. Compare public industry sources.
    maxDepth: 1
    toolFilter:
      allow: []
`)
  const ended = new Promise<void>((resolve) => {
    ctx.on('session/event', (session, event) => {
      if (session.id === agent.id && event.type === 'blueprint/capability-authoring' && event.data.state === 'ended') resolve()
    })
  })
  const verificationSessionIds: string[] = []
  ctx.on('session/created', (session) => {
    if (String(session.id).startsWith('blueprint-subagent-verification-')) {
      verificationSessionIds.push(String(session.id))
    }
  })
  agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await ended
  const [first, duplicate] = await Promise.all([1, 2].map(() => ctx.blueprintAdapter.setConversationContext({
    sessionId: String(agent.id), recoverCapabilityAuthoring: true,
  })))
  const record = first!.capabilityAuthoringRecord!
  const terminalEvent = agent.session.events.find(event => event.type === 'blueprint/capability-authoring'
    && event.data.state === 'ended')
  if (terminalEvent === undefined || record.endSeq === undefined || duplicate?.capabilityAuthoringRecord?.endSeq === undefined) {
    throw new Error('Capability authoring recovery omitted its durable terminal sequence')
  }
  const evidence = record.subagentEvidence
  if (verificationSessionIds.length !== 1) {
    throw new Error(`Expected one durable Subagent verification Session; found ${String(verificationSessionIds.length)}`)
  }
  const verificationSessionId = verificationSessionIds[0]!
  if (evidence?.verification.sessionId !== verificationSessionId) {
    throw new Error('Subagent terminal evidence does not cite its durable verification Session')
  }
  const verificationAgentReleased = ctx.agents.list().every(item => String(item.id) !== verificationSessionId)
  if (!verificationAgentReleased) throw new Error('Subagent verification Agent remained live after terminal settlement')
  const blueprint = await ctx.blueprintAdapter.read('research', { cwd: root })
  process.stdout.write(JSON.stringify({
    activeBeforeCreatorEnd: active.capabilityAuthoringRecord?.state,
    kind: record.kind, target: record.targetPresetId, state: record.state, outcome: record.outcome,
    baseline: record.baselineDelegationRowIds, delta: evidence?.delegations,
    conformance: evidence?.verification.overall, binding: evidence?.verification.binding.status,
    delegationEvidence: evidence?.verification.delegations.evidence,
    projection: blueprint.nodes.filter(node => node.id.startsWith('capability:delegation:')),
    terminalCount: agent.session.events.filter(event => event.type === 'blueprint/capability-authoring' && event.data.state === 'ended').length,
    terminalSeq: terminalEvent.seq, recoveredEndSeq: record.endSeq,
    duplicateSameTerminal: duplicate.capabilityAuthoringRecord.endSeq === record.endSeq
      && record.endSeq === terminalEvent.seq,
    verificationSessionCount: verificationSessionIds.length,
    verificationEvidenceOwnsSession: evidence.verification.sessionId === verificationSessionId,
    verificationAgentReleased,
    businessTurns: ctx.sessions.list().filter(session => session.id !== source.id).flatMap(session => session.events)
      .filter(event => event.type === 'user/message').length,
  }) + '\n')
} finally {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}
