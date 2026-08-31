import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import LlmRuntime, { CallId, createToolResultMessage, createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { ToolDispatchExecution, ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as BlueprintAdapterInvariant from '../src/invariant.ts'
import { createBlueprintUserChange } from '../src/host/proposal.ts'
import { compositionRevision } from '../src/host/composition.ts'
import type {
  Blueprint,
  BlueprintCapabilityAuthoringEvent,
  BlueprintSessionValidation,
  BlueprintUserChange,
} from '../src/contract/types.ts'
import { creatorTerminalEvidence } from '../src/host/creator-lifecycle.ts'
import { capabilityAuthoringCreatorSessionId } from '../src/host/capability-authority.ts'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(BlueprintAdapterInvariant)
  return ctx
}

function capabilityBaseline(targetPresetId: string) {
  const baseRevision = compositionRevision(`baseline:${targetPresetId}`)
  return {
    baseRevision,
    baselinePresets: [{ id: targetPresetId, trust: 'user' as const, compositionDigest: baseRevision }],
    baselineNodes: [{
      id: 'purpose:persona', type: 'purpose' as const, value: 'Existing purpose.',
      source: 'preset' as const, status: 'active' as const,
    }],
    baselineSkills: [],
    baselineDelegations: [],
    candidate: {
      version: 1 as const,
      transactionId: compositionRevision(`candidate:${targetPresetId}`),
      targetPath: resolve('fixtures', targetPresetId, 'agent.cordis.yml'),
      baseRevision,
      baselineTreeDigest: compositionRevision(`tree:${targetPresetId}`),
    },
    maxRepairAttempts: 2,
  }
}

function repairMessageId(routeId: string, startSeq: number, attempt: number): string {
  return `blueprint-capability-repair:${createHash('sha256')
    .update(JSON.stringify([routeId, startSeq, attempt])).digest('hex')}`
}

type CapabilityStart = {
  seq: number
  data: Extract<BlueprintCapabilityAuthoringEvent, { state: 'started' }>
}

type CapabilityAuthoringEvent = Extract<SessionEvent, { type: 'blueprint/capability-authoring' }>

function capabilityWakeMessageId(start: CapabilityStart): MessageId {
  return MessageId(`blueprint-capability:${createHash('sha256')
    .update(JSON.stringify([start.data.sourceSessionId, start.data.routeId, start.seq])).digest('hex')}`)
}

function enqueueLegacyCapabilityWake(session: Session, start: CapabilityStart): void {
  session.append('agent/inbox/spliced', {
    target: 'next-turn',
    start: 0,
    inserted: [{
      id: capabilityWakeMessageId(start),
      role: 'user',
      content: [{ type: 'text', text: 'Author the isolated capability candidate.' }],
      source: { kind: 'plugin', plugin: 'blueprint-adapter' },
    }],
  })
}

function claimCapabilityTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn })
  session.append('agent/inbox/spliced', {
    target: 'next-turn', start: 0, removedCount: 1, inserted: [],
  })
}

function settleInitialCapabilityTurn(
  session: Session,
  event: CapabilityAuthoringEvent,
  turn: number,
  reason: Extract<SessionEvent, { type: 'turn/end' }>['data']['reason'],
) {
  if (event.data.state !== 'started') throw new Error('Expected capability authoring start')
  const start: CapabilityStart = { seq: event.seq, data: event.data }
  enqueueLegacyCapabilityWake(session, start)
  claimCapabilityTurn(session, turn)
  return session.append('turn/end', { turn, reason })
}

function skillBaseline(name: string) {
  return {
    name, description: `${name} description`, invocation: { modelInvocable: true, userInvocable: true },
    scope: 'preset' as const, provider: 'fixture', source: 'fixture',
    definitionDigest: compositionRevision(`skill:${name}`),
  }
}

function delegationBaseline(rowId: string) {
  return {
    rowId, tool: 'industry_research', provider: 'spawn', mode: 'one-shot' as const,
    configDigest: compositionRevision(`delegation:${rowId}`), enabled: true, providerAvailable: true,
  }
}

function runtimeVerification(
  presetId: string,
  revision: string,
  sessionId = 'fresh-verification-session',
): BlueprintSessionValidation {
  return {
    sessionId,
    presetId,
    valid: true,
    overall: 'pass' as const,
    binding: {
      status: 'pass' as const,
      sessionPresetId: presetId,
      composedPresetId: presetId,
      expectedRevision: revision,
      projectedRevision: revision,
      strictRevisionBound: false as const,
    },
    prompt: { status: 'pass' as const, evidence: [] },
    tools: { status: 'pass' as const, evidence: [], missing: [], unexpected: [], schemaMismatches: [] },
    skills: { status: 'pass' as const, evidence: [], missing: [], unexpected: [] },
    delegations: { status: 'pass' as const, evidence: [] },
    permissions: { status: 'pass' as const },
  }
}

function committedCandidate(
  start: Pick<BlueprintCapabilityAuthoringEvent, 'candidate'>,
  candidateTreeDigest: string,
) {
  return {
    transactionId: start.candidate.transactionId,
    candidateTreeDigest,
    finalTreeDigest: candidateTreeDigest,
    disposition: 'committed' as const,
  }
}

function discardedCandidate(start: Pick<BlueprintCapabilityAuthoringEvent, 'candidate'>) {
  return {
    transactionId: start.candidate.transactionId,
    candidateTreeDigest: compositionRevision('discarded-candidate'),
    finalTreeDigest: start.candidate.baselineTreeDigest,
    disposition: 'discarded' as const,
  }
}

function verifiedSkillEvidence(presetId: string, turnEndSeq: number, name = 'csv') {
  const revision = compositionRevision(`skill-revision:${name}`)
  const definitionDigest = compositionRevision(`skill-definition:${name}`)
  const verification = runtimeVerification(presetId, revision)
  verification.skills.evidence = [{
    nodeId: `capability:skill:${name}`,
    name,
    actualPresent: true,
    expectedDefinitionDigest: definitionDigest,
    liveDefinitionDigest: definitionDigest,
    status: 'pass' as const,
  }]
  return {
    turnEndSeq,
    revision,
    skills: [{ name, definitionDigest, invocation: { modelInvocable: true, userInvocable: true } }],
    verification,
  }
}

const change = (
  impactCandidates: BlueprintUserChange['impactCandidates'],
  overrides: Partial<BlueprintUserChange> = {},
): BlueprintUserChange => ({
  presetId: 'interview-analysis',
  nodeId: 'purpose:persona',
  nodeType: 'purpose',
  label: 'Purpose',
  previousValue: '快速整理访谈。',
  currentValue: '深度分析访谈。',
  operation: 'update',
  impactCandidates,
  ...overrides,
})

function identityChange(includePeers = true): BlueprintUserChange {
  const blueprint: Blueprint = {
    schemaVersion: 1,
    preset: { id: 'interview-analysis', trust: 'user' },
    revision: compositionRevision('角色：深度访谈分析师'),
    nodes: [
      { id: 'identity:persona', type: 'identity', value: '深度访谈分析师', source: 'preset', status: 'active', editable: true, adapterRef: 'preset:persona.config.text#identity' },
      { id: 'purpose:persona', type: 'purpose', value: '快速整理访谈。', source: 'preset', status: 'active', editable: true, adapterRef: 'preset:persona.config.text#purpose' },
      { id: 'behavior:1', type: 'behavior', value: '提供轻量摘要。', source: 'preset', status: 'active', editable: true, adapterRef: 'preset:persona.config.text#behavior:1' },
      { id: 'output:2', type: 'output', value: '输出摘要和来源。', source: 'preset', status: 'active', editable: true, adapterRef: 'preset:persona.config.text#output:2' },
      { id: 'capability:web-search', type: 'capability', value: { tool: 'web_search', enabled: true }, source: 'runtime', status: 'active', editable: true, adapterRef: 'preset:tool-web.config.search' },
    ],
    runtime: { tools: ['web_search'], promptSections: ['deployment:persona'], skills: [], delegations: [], permissions: null },
    mappingGaps: [],
  }
  if (!includePeers) blueprint.nodes = blueprint.nodes.filter(node => node.type === 'identity')
  return createBlueprintUserChange(blueprint, { nodeId: 'identity:persona', previousValue: '轻量访谈整理员' })
}

// Restored JSON is untyped; exercise the same dispatch observer without coercing it into a valid SessionEvent.
function observeRestoredChange(ctx: Context, data: unknown): void {
  const session = ctx.sessions.create()
  ctx.emit('internal/dispatch', 'emit', 'session/event', [session, {
    type: 'blueprint/user-change', seq: 0, time: 0, data,
  }], ctx)
}

describe('Blueprint Adapter invariants', () => {
  it('requires Proposal terminals to cite one successful source-owned durable result', async () => {
    const ctx = await setup()
    try {
      const session = ctx.sessions.create(SessionId('proposal-owner'))
      session.append('turn/start', { turn: 1 })
      const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Update Purpose.' }] })
      const user = session.append('user/message', message, { surfaceOp: 'append' })
      const callId = CallId('proposal-1')
      session.append('tool/call', { turn: 1, step: 1, callId, name: 'propose_blueprint_change', arguments: '{}' })
      session.append('blueprint/route-decision', {
        routeId: String(message.id), sourceSessionId: session.id, userMessageId: message.id,
        userMessageSeq: user.seq, turn: 1, operation: 'modify-existing-agent', callId,
        targetPresetId: 'research', provenance: 'user-message',
      })
      const changeSet = {
        sourceSessionId: String(session.id), routeId: String(message.id), changeSetId: String(callId),
        kind: 'direct-request' as const, presetId: 'research', revision: 'revision-1',
        proposals: [{
          proposalId: String(callId), presetId: 'research', revision: 'revision-1',
          targetNodeId: 'purpose:persona', operation: 'updatePurpose' as const,
          currentValue: 'Old purpose.', proposedValue: 'New purpose.', impact: 'Purpose changes.',
        }],
      }
      const result = session.append('tool/result', {
        turn: 1, step: 1,
        message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'Proposal created.' }], isError: false }),
        meta: { blueprintChangeSet: changeSet },
      }, { surfaceOp: 'append' })
      const cancellation = {
        sourceSessionId: String(session.id), routeId: String(message.id), changeSetId: String(callId),
        proposalResultSeq: result.seq, presetId: 'research', baseRevision: 'revision-1', status: 'cancelled' as const,
      }
      expect(() => session.append('blueprint/proposal-cancelled', cancellation)).not.toThrow()
      expect(() => session.append('blueprint/proposal-cancelled', cancellation)).toThrow(/immutable/u)

      const foreign = ctx.sessions.create(SessionId('foreign-owner'))
      expect(() => foreign.append('blueprint/proposal-cancelled', {
        ...cancellation, sourceSessionId: String(foreign.id),
      })).toThrow(/earlier successful Tool result/u)
    } finally { await ctx.fiber.dispose() }
  })

  it.each(['valid', 'baseline-row', 'provider', 'wrong-target', 'wrong-revision', 'creator-session', 'failed-p1'])(
    'checks durable Subagent verification evidence: %s', async (scenario) => {
      const ctx = await setup()
      try {
        const session = ctx.sessions.create(SessionId(capabilityAuthoringCreatorSessionId(
          'source-session', 'subagent-route',
        )))
        const start = session.append('blueprint/capability-authoring', {
          routeId: 'subagent-route', sourceSessionId: 'source-session',
          state: 'started', kind: 'subagent', targetPresetId: 'research', request: 'Add industry researcher',
          ...capabilityBaseline('research'),
          baselineDelegations: scenario === 'baseline-row' ? [delegationBaseline('industry')] : [],
        })
        const turn = settleInitialCapabilityTurn(session, start, 1, { kind: 'completed' })
        const revision = compositionRevision('subagent-revision')
        const verification = runtimeVerification(
          scenario === 'wrong-target' ? 'other' : 'research',
          revision,
          scenario === 'creator-session' ? String(session.id) : 'fresh-verification-session',
        )
        verification.valid = scenario !== 'failed-p1'
        verification.binding.projectedRevision = scenario === 'wrong-revision' ? 'other' : revision
        verification.delegations.evidence = [{
          nodeId: 'capability:delegation:industry', rowId: 'industry', tool: 'industry_research',
          provider: 'spawn', providerAvailable: true, status: 'pass' as const,
        }]
        const subagentEvidence = {
          turnEndSeq: turn.seq,
          revision,
          delegations: [{
            rowId: 'industry', tool: 'industry_research', provider: 'spawn', mode: 'one-shot' as const,
            configDigest: compositionRevision('delegation:added'),
            enabled: true, providerAvailable: scenario !== 'provider',
          }],
          verification,
        }
        const candidateTreeDigest = compositionRevision('subagent-candidate')
        const append = () => session.append('blueprint/capability-verified', {
          routeId: start.data.routeId,
          startSeq: start.seq,
          turnEndSeq: turn.seq,
          candidateTreeDigest,
          kind: 'subagent',
          subagentEvidence,
        })
        if (scenario === 'valid') {
          expect(append).not.toThrow()
          const terminal = {
            ...start.data,
            state: 'ended' as const,
            startSeq: start.seq,
            outcome: 'completed' as const,
            subagentEvidence,
            candidateDisposition: committedCandidate(start.data, candidateTreeDigest),
          }
          expect(() => session.append('blueprint/capability-authoring', terminal)).not.toThrow()
          expect(() => session.append('blueprint/capability-authoring', terminal)).toThrow(/active lifecycle/u)
        } else expect(append).toThrow(/verification|Subagent/u)
      } finally { await ctx.fiber.dispose() }
    },
  )

  it('pins completed Creator evidence before unrelated stopped turns and rejects terminal rewrites', async () => {
    const ctx = await setup()
    try {
      const session = ctx.sessions.create(SessionId('terminal-creator'))
      const task = session.append('blueprint/creator-authoring', {
        operation: 'create-agent', routeId: 'task-x', sourceSessionId: 'source', request: 'Create an Agent.', name: 'Research',
      })
      session.append('turn/start', { turn: 1 })
      const callId = CallId('validate-x')
      session.append('tool/call', { turn: 1, step: 1, callId, name: 'preset_validate', arguments: '{"id":"research"}' })
      session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'mounted OK for research' }], isError: false }) }, { surfaceOp: 'append' })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      const terminal = creatorTerminalEvidence(session.events, task.seq)!
      expect(terminal).toMatchObject({ outcome: 'completed', routeId: 'task-x', targetPresetId: 'research' })
      session.append('blueprint/creator-authoring-ended', terminal)
      session.append('turn/start', { turn: 2 })
      session.append('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } })
      expect(creatorTerminalEvidence(session.events, task.seq)).toEqual(terminal)
      expect(() => session.append('blueprint/creator-authoring-ended', terminal)).toThrow(/immutable/u)
    } finally { await ctx.fiber.dispose() }
  })

  it('keeps interrupted unvalidated tasks resumable and refuses completion without mounted evidence', async () => {
    const ctx = await setup()
    try {
      const session = ctx.sessions.create()
      const task = session.append('blueprint/creator-authoring', {
        operation: 'create-agent', routeId: 'task-y', sourceSessionId: 'source', request: 'Create another Agent.', name: 'Other',
      })
      session.append('turn/start', { turn: 1 })
      const end = session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
      expect(creatorTerminalEvidence(session.events, task.seq)).toBeUndefined()
      expect(() => session.append('blueprint/creator-authoring-ended', {
        routeId: 'task-y', startSeq: task.seq, turnEndSeq: end.seq,
        outcome: 'completed', targetPresetId: 'other', validationSeq: task.seq,
      })).toThrow(/successful mounted validation/u)
    } finally { await ctx.fiber.dispose() }
  })
  it('rejects an Add capability decision that creates an Agent or abandons its source evidence', async () => {
    const ctx = await setup()
    try {
      const session = ctx.sessions.create(SessionId('input-owner'))
      const user = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '增加 CSV 处理能力' }] })
      session.append('blueprint/routing-input', {
        routeId: 'capability-route',
        sourceSessionId: session.id, messageId: user.id, userRequest: '增加 CSV 处理能力',
        uiAction: 'add-capability', targetPresetId: 'existing',
      })
      session.append('turn/start', { turn: 1 })
      const event = session.append('user/message', user, { surfaceOp: 'append' })
      const decision = { sourceSessionId: session.id, userMessageId: user.id, userMessageSeq: event.seq,
        routeId: 'capability-route', turn: 1, callId: CallId('route'), targetPresetId: 'existing', provenance: 'add-capability' as const }
      expect(() => session.append('blueprint/route-decision', { ...decision, operation: 'create-agent' })).toThrow(/cannot change its operation domain/u)
      expect(() => session.append('blueprint/route-decision', { ...decision, sourceSessionId: SessionId('other'), operation: 'skill' })).toThrow(/owning Session/u)
      expect(() => session.append('blueprint/route-decision', { ...decision, operation: 'skill' })).not.toThrow()
      expect(() => session.append('blueprint/route-decision', { ...decision, operation: 'subagent' })).toThrow(/mutually exclusive/u)
      expect(() => session.append('blueprint/route-decision', {
        ...decision, routeId: 'capability-route-b', operation: 'subagent',
      })).toThrow(/cannot change its operation domain or target/u)
    } finally {
      await ctx.fiber.dispose()
    }
  })
  it('requires a source-owned direct-edit route and reserves only the existing-Agent operation', async () => {
    const ctx = await setup()
    try {
      const session = ctx.sessions.create(SessionId('purpose-source'))
      const user = createUserMessage({
        source: { kind: 'user' }, content: [{ type: 'text', text: '将 Purpose 修改为：只做基本面研究。' }],
      })
      const routingInput = {
        routeId: 'purpose-route', sourceSessionId: session.id, messageId: user.id,
        userRequest: '将 Purpose 修改为：只做基本面研究。', uiAction: 'direct-edit' as const,
        targetPresetId: 'existing',
        directEdit: {
          nodeId: 'purpose:persona', nodeType: 'purpose' as const, label: 'Purpose',
          operation: 'updatePurpose' as const, currentValue: '比较主要竞品。', proposedValue: '只做基本面研究。',
          impactCandidates: [{ nodeId: 'behavior:1', evidence: [{ kind: 'purpose-child' as const }] }],
        },
      }
      session.append('blueprint/routing-input', routingInput)
      session.append('turn/start', { turn: 1 })
      const message = session.append('user/message', user, { surfaceOp: 'append' })
      const decision = {
        routeId: 'purpose-route', sourceSessionId: session.id, userMessageId: user.id,
        userMessageSeq: message.seq, turn: 1, callId: CallId('proposal'), targetPresetId: 'existing',
        provenance: 'direct-edit' as const,
      }

      expect(() => session.append('blueprint/route-decision', {
        ...decision, operation: 'skill',
      })).toThrow(/cannot change its operation domain/u)
      expect(() => session.append('blueprint/route-decision', {
        ...decision, operation: 'modify-existing-agent',
      })).not.toThrow()
      expect(() => session.append('blueprint/routing-input', {
        ...routingInput, routeId: 'bad-purpose-route',
        directEdit: { ...routingInput.directEdit, proposedValue: routingInput.directEdit.currentValue },
      })).toThrow(/typed semantic change/u)
    } finally {
      await ctx.fiber.dispose()
    }
  })
  it('rejects source model/tool execution after handoff but permits a later user turn', async () => {
    const ctx = await setup()
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(AgentLoop, { agents: [] })
      const { agent } = await ctx.agents.create({ sessionId: SessionId('source') })
      const source = agent.session
      source.append('turn/start', { turn: 1 })
      source.append('blueprint/creator-authoring', {
        operation: 'create-agent', routeId: 'route', sourceSessionId: 'source',
        request: 'Create a new Agent.', name: 'New Agent',
        handoff: { sourceTurn: 1, targetCreatorSessionId: 'creator' },
      })
      source.append('tool/result', {
        turn: 1, step: 1,
        message: createToolResultMessage({ callId: CallId('route'), content: [{ type: 'text', text: 'accepted' }], isError: false }),
      }, { surfaceOp: 'append' })
      expect(() => source.append('step/start', { turn: 1, step: 2 })).toThrow(/source started a model step/u)
      const execution: ToolDispatchExecution = {
        token: Symbol('late-tool') as ToolExecutionToken,
        callId: CallId('late-tool'), rootCallId: CallId('late-tool'), name: 'write', arguments: {},
        signal: new AbortController().signal,
        agent,
      }
      await expect(async () => ctx.waterfall(scopeTarget(ctx.tools, agent), 'tools/execute', execution, (): Promise<ToolExecutionResult> => Promise.resolve({
        content: [], isError: false, value: null,
      }))).rejects.toThrow(/source dispatched a Tool/u)
      source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      source.append('turn/start', { turn: 2 })
      expect(() => source.append('step/start', { turn: 2, step: 1 })).not.toThrow()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects Creator execution before its exact source turn is terminal', async () => {
    const ctx = await setup()
    try {
      const source = ctx.sessions.create(SessionId('source'))
      const creator = ctx.sessions.create(SessionId('creator'))
      source.append('turn/start', { turn: 2 })
      source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      creator.append('blueprint/creator-authoring', {
        operation: 'create-agent', routeId: 'route', sourceSessionId: 'source',
        request: 'Create a new Agent.', name: 'New Agent',
        handoff: { sourceTurn: 2, targetCreatorSessionId: 'creator' },
      })
      expect(() => creator.append('step/start', { turn: 1, step: 1 })).toThrow(/Creator started before source turn ended/u)
      source.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
      expect(() => creator.append('step/start', { turn: 1, step: 1 })).not.toThrow()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('accepts text updates and exact capability transitions', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()

    expect(() => session.append('blueprint/user-change', change([]))).not.toThrow()
    expect(() => session.append('blueprint/user-change', change([], {
      nodeId: 'capability:web-search', nodeType: 'capability', label: 'Web Search',
      previousValue: true, currentValue: false, operation: 'disable',
    }))).not.toThrow()
  })

  it('accepts producer-derived Identity updates with bounded P2 evidence and on replay', async () => {
    const event = identityChange()
    expect(event).toMatchObject({ nodeType: 'identity', operation: 'update' })
    expect(event.impactCandidates).toEqual([
      { nodeId: 'purpose:persona', evidence: [{ kind: 'identity-peer' }, { kind: 'removed-literal', value: '整理' }] },
      { nodeId: 'behavior:1', evidence: [{ kind: 'identity-peer' }, { kind: 'removed-literal', value: '轻量' }] },
      { nodeId: 'output:2', evidence: [{ kind: 'identity-peer' }] },
    ])
    const ctx = await setup()
    try {
      expect(() => { ctx.sessions.create().append('blueprint/user-change', event) }).not.toThrow()
      expect(() => { observeRestoredChange(ctx, event) }).not.toThrow()
      const withoutPeers = identityChange(false)
      expect(withoutPeers.impactCandidates).toEqual([])
      expect(() => { observeRestoredChange(ctx, withoutPeers) }).not.toThrow()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each(['enable', 'disable', 'replace'])('rejects Identity operation %s', async (operation) => {
    const ctx = await setup()
    try {
      expect(() => { observeRestoredChange(ctx, { ...identityChange(), operation }) })
        .toThrow(/Capability boolean transition/u)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects missing candidate evidence and out-of-scope Identity targets', async () => {
    const ctx = await setup()
    const event = identityChange()
    const { impactCandidates, ...withoutCandidates } = event
    expect(impactCandidates).not.toHaveLength(0)
    try {
      expect(() => { observeRestoredChange(ctx, withoutCandidates) }).toThrow(/impactCandidates must be an array/u)
      expect(() => { observeRestoredChange(ctx, { ...event, impactCandidates: [{ nodeId: 'behavior:1' }] }) })
        .toThrow(/non-empty evidence/u)
      expect(() => { observeRestoredChange(ctx, { ...event, impactCandidates: [{ nodeId: 'behavior:1', evidence: [] }] }) })
        .toThrow(/non-empty evidence/u)
      for (const nodeId of ['capability:web-search', 'access:permission-preset', 'identity:persona']) {
        expect(() => {
          observeRestoredChange(ctx, { ...event, impactCandidates: [{ nodeId, evidence: [{ kind: 'identity-peer' }] }] })
        })
          .toThrow(/Identity candidates|edited node/u)
      }
      expect(() => {
        observeRestoredChange(ctx, {
          ...event, impactCandidates: [{ nodeId: 'behavior:1', evidence: [{ kind: 'purpose-child' }] }],
        })
      })
        .toThrow(/Identity candidates/u)
      expect(() => {
        observeRestoredChange(ctx, {
          ...event, impactCandidates: [{ nodeId: 'behavior:1', evidence: [{ kind: 'removed-literal' }] }],
        })
      })
        .toThrow(/non-empty value/u)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps required Identity fields and text transitions checked', async () => {
    const ctx = await setup()
    const event = identityChange()
    try {
      for (const field of ['presetId', 'nodeId', 'label', 'previousValue', 'currentValue']) {
        const malformed: Record<string, unknown> = { ...event }
        Reflect.deleteProperty(malformed, field)
        expect(() => { observeRestoredChange(ctx, malformed) }).toThrow(/non-empty|text values/u)
      }
      expect(() => { observeRestoredChange(ctx, { ...event, currentValue: true }) }).toThrow(/text values/u)
      expect(() => { observeRestoredChange(ctx, { ...event, currentValue: event.previousValue }) }).toThrow(/different values/u)
      expect(() => { observeRestoredChange(ctx, { ...event, nodeType: 'unknown-node' }) }).toThrow(/text values/u)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each(['purpose', 'behavior', 'output'] as const)('retains valid %s update events', async (nodeType) => {
    const ctx = await setup()
    try {
      expect(() => ctx.sessions.create().append('blueprint/user-change', change([], {
        nodeType, nodeId: nodeType === 'purpose' ? 'purpose:persona' : `${nodeType}:1`,
      }))).not.toThrow()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('requires one route-bound normalized candidate and fixed repair budget at lifecycle start', async () => {
    const ctx = await setup()
    try {
      const session = ctx.sessions.create(SessionId(capabilityAuthoringCreatorSessionId(
        'source-session', 'candidate-route',
      )))
      const baseline = capabilityBaseline('research')
      const start = {
        routeId: 'candidate-route', sourceSessionId: 'source-session',
        state: 'started' as const, targetPresetId: 'research', request: 'Add CSV support', kind: 'skill' as const,
        ...baseline,
      }
      expect(() => session.append('blueprint/capability-authoring', {
        ...start,
        candidate: { ...baseline.candidate, transactionId: 'not-a-digest' },
      })).toThrow(/candidate/u)
      expect(() => session.append('blueprint/capability-authoring', {
        ...start,
        candidate: { ...baseline.candidate, targetPath: resolve('fixtures', 'other', 'agent.cordis.yml') },
      })).toThrow(/candidate/u)
      expect(() => session.append('blueprint/capability-authoring', {
        ...start,
        candidate: { ...baseline.candidate, targetPath: resolve('fixtures', 'research', 'preset.yml') },
      })).toThrow(/agent\.cordis\.yml/u)
      expect(() => session.append('blueprint/capability-authoring', {
        ...start,
        maxRepairAttempts: -1,
      })).toThrow(/maxRepairAttempts/u)
      expect(() => session.append('blueprint/capability-authoring', start)).not.toThrow()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('binds monotonic repair checkpoints and verified publication to one active interaction', async () => {
    const ctx = await setup()
    try {
      const routeId = 'repair-route'
      const session = ctx.sessions.create(SessionId(capabilityAuthoringCreatorSessionId(
        'source-session', routeId,
      )))
      const start = session.append('blueprint/capability-authoring', {
        routeId, sourceSessionId: 'source-session', state: 'started', targetPresetId: 'research',
        request: 'Add CSV support', kind: 'skill', ...capabilityBaseline('research'),
      })
      const firstEnd = settleInitialCapabilityTurn(session, start, 1, { kind: 'completed' })
      const candidateTreeDigest = compositionRevision('repair-candidate')
      const repair = {
        routeId,
        startSeq: start.seq,
        turnEndSeq: firstEnd.seq,
        attempt: 1,
        prerequisite: 'runtime_conformance' as const,
        message: 'Fresh Session did not expose the new Skill.',
        candidateTreeDigest,
        repairMessageId: MessageId(repairMessageId(routeId, start.seq, 1)),
      }
      expect(() => session.append('blueprint/capability-repair', {
        ...repair, repairMessageId: MessageId('wrong'),
      })).toThrow(/deterministic evidence/u)
      expect(() => session.append('blueprint/capability-repair', repair)).not.toThrow()
      const repairMessage = {
        id: repair.repairMessageId,
        role: 'user' as const,
        content: [{ type: 'text' as const, text: repair.message }],
        source: {
          kind: 'blueprint-capability-repair' as const,
          routeId,
          startSeq: start.seq,
          attempt: 1,
          prerequisite: repair.prerequisite,
        },
      }
      expect(() => session.append('agent/inbox/spliced', {
        target: 'next-turn', start: 0, inserted: [repairMessage],
      })).not.toThrow()
      expect(() => session.append('agent/inbox/spliced', {
        target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled',
      })).not.toThrow()
      expect(() => session.append('agent/inbox/spliced', {
        target: 'next-turn', start: 0, inserted: [repairMessage],
      })).not.toThrow()
      expect(() => session.append('agent/inbox/spliced', {
        target: 'next-turn', start: 1, inserted: [repairMessage],
      })).toThrow(/duplicate pending/u)
      session.append('turn/start', { turn: 2 })
      expect(() => session.append('agent/inbox/spliced', {
        target: 'next-turn', start: 0, removedCount: 1, inserted: [],
      })).not.toThrow()
      expect(() => session.append('agent/inbox/spliced', {
        target: 'next-turn', start: 0, inserted: [repairMessage],
      })).toThrow(/already claimed/u)
      const repairedEnd = session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
      const skillEvidence = verifiedSkillEvidence('research', repairedEnd.seq)
      const verifiedDigest = compositionRevision('verified-candidate')
      const verified = {
        routeId,
        startSeq: start.seq,
        turnEndSeq: repairedEnd.seq,
        candidateTreeDigest: verifiedDigest,
        kind: 'skill' as const,
        skillEvidence,
      }
      expect(() => session.append('blueprint/capability-verified', verified)).not.toThrow()
      expect(() => session.append('blueprint/capability-repair', {
        ...repair,
        turnEndSeq: repairedEnd.seq,
        attempt: 2,
        repairMessageId: MessageId(repairMessageId(routeId, start.seq, 2)),
      })).toThrow(/sole checkpoint|advance/u)
      expect(() => session.append('blueprint/capability-verified', verified)).toThrow(/sole checkpoint/u)
      expect(() => session.append('blueprint/capability-authoring', {
        ...start.data,
        state: 'ended',
        startSeq: start.seq,
        outcome: 'completed',
        skillEvidence,
        candidateDisposition: committedCandidate(start.data, verifiedDigest),
      })).not.toThrow()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each(['interrupted', 'disposed', 'user'] as const)(
    'admits Host verification only for recoverable non-completed Creator turns: %s',
    async (reason) => {
      const ctx = await setup()
      try {
        const routeId = `verification-${reason}`
        const session = ctx.sessions.create(SessionId(capabilityAuthoringCreatorSessionId(
          'source-session', routeId,
        )))
        const start = session.append('blueprint/capability-authoring', {
          routeId, sourceSessionId: 'source-session', state: 'started', targetPresetId: 'research',
          request: 'Add CSV support', kind: 'skill', ...capabilityBaseline('research'),
        })
        const end = settleInitialCapabilityTurn(session, start, 1, reason === 'interrupted'
          ? { kind: 'interrupted' }
          : { kind: 'aborted', reason: { kind: reason === 'disposed' ? 'disposed' : 'user' } })
        const skillEvidence = verifiedSkillEvidence('research', end.seq, `csv-${reason}`)
        const checkpoint = {
          routeId,
          startSeq: start.seq,
          turnEndSeq: end.seq,
          candidateTreeDigest: compositionRevision(`candidate-${reason}`),
          kind: 'skill' as const,
          skillEvidence,
        }
        if (reason === 'user') {
          expect(() => session.append('blueprint/capability-verified', checkpoint)).toThrow(/Skill verification/u)
        } else expect(() => session.append('blueprint/capability-verified', checkpoint)).not.toThrow()
      } finally {
        await ctx.fiber.dispose()
      }
    },
  )

  it('counts an interrupted-turn validation miss as one deterministic repair attempt', async () => {
    const ctx = await setup()
    try {
      const routeId = 'resume-route'
      const session = ctx.sessions.create(SessionId(capabilityAuthoringCreatorSessionId(
        'source-session', routeId,
      )))
      const start = session.append('blueprint/capability-authoring', {
        routeId, sourceSessionId: 'source-session', state: 'started', targetPresetId: 'research',
        request: 'Add CSV support', kind: 'skill', ...capabilityBaseline('research'),
      })
      const end = settleInitialCapabilityTurn(session, start, 1, { kind: 'interrupted' })
      const repair = {
        routeId,
        startSeq: start.seq,
        turnEndSeq: end.seq,
        attempt: 1,
        prerequisite: 'creator_turn' as const,
        message: 'Recoverable interruption failed Host verification.',
        candidateTreeDigest: compositionRevision('interrupted-candidate'),
        repairMessageId: MessageId(repairMessageId(routeId, start.seq, 1)),
      }
      expect(() => session.append('blueprint/capability-repair', repair)).not.toThrow()
      const message = {
        id: repair.repairMessageId,
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'Repair the interrupted candidate.' }],
        source: {
          kind: 'blueprint-capability-repair' as const,
          routeId,
          startSeq: start.seq,
          attempt: 1,
          prerequisite: 'creator_turn' as const,
        },
      }
      expect(() => session.append('agent/inbox/spliced', {
        target: 'next-turn', start: 0, inserted: [message],
      })).not.toThrow()
      expect(() => session.append('agent/inbox/spliced', {
        target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled',
      })).not.toThrow()
      expect(() => session.append('agent/inbox/spliced', {
        target: 'next-turn', start: 0, inserted: [message],
      })).not.toThrow()
      session.append('turn/start', { turn: 2 })
      expect(() => session.append('agent/inbox/spliced', {
        target: 'next-turn', start: 0, removedCount: 1, inserted: [],
      })).not.toThrow()
      expect(() => session.append('agent/inbox/spliced', {
        target: 'next-turn', start: 0, inserted: [message],
      })).toThrow(/already claimed/u)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('requires exhausted or cancelled lifecycles to discard without a verified checkpoint', async () => {
    const ctx = await setup()
    try {
      const routeId = 'failed-route'
      const session = ctx.sessions.create(SessionId(capabilityAuthoringCreatorSessionId(
        'source-session', routeId,
      )))
      const start = session.append('blueprint/capability-authoring', {
        routeId, sourceSessionId: 'source-session', state: 'started', targetPresetId: 'research',
        request: 'Add CSV support', kind: 'skill', ...capabilityBaseline('research'), maxRepairAttempts: 0,
      })
      const end = settleInitialCapabilityTurn(session, start, 1, { kind: 'completed' })
      const terminal = {
        ...start.data,
        state: 'ended' as const,
        startSeq: start.seq,
        outcome: 'failed' as const,
        capabilityFailure: {
          turnEndSeq: end.seq,
          attempt: 0,
          prerequisite: 'runtime_conformance' as const,
          message: 'Fresh runtime verification remained unsuccessful.',
        },
      }
      expect(() => session.append('blueprint/capability-authoring', terminal)).toThrow(/discard/u)
      expect(() => session.append('blueprint/capability-authoring', {
        ...terminal,
        candidateDisposition: {
          ...discardedCandidate(start.data),
          finalTreeDigest: compositionRevision('changed-formal-tree'),
        },
      })).toThrow(/discard/u)
      expect(() => session.append('blueprint/capability-authoring', {
        ...terminal,
        candidateDisposition: discardedCandidate(start.data),
      })).not.toThrow()
      expect(() => session.append('blueprint/capability-authoring', start.data)).toThrow(/recreate/u)

      const unexhaustedRoute = 'unexhausted-route'
      const unexhausted = ctx.sessions.create(SessionId(capabilityAuthoringCreatorSessionId(
        'source-session', unexhaustedRoute,
      )))
      const unexhaustedStart = unexhausted.append('blueprint/capability-authoring', {
        routeId: unexhaustedRoute, sourceSessionId: 'source-session', state: 'started', targetPresetId: 'research',
        request: 'Add CSV support', kind: 'skill', ...capabilityBaseline('research'),
      })
      const unexhaustedEnd = unexhausted.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      expect(() => unexhausted.append('blueprint/capability-authoring', {
        ...unexhaustedStart.data,
        state: 'ended',
        startSeq: unexhaustedStart.seq,
        outcome: 'failed',
        capabilityFailure: {
          turnEndSeq: unexhaustedEnd.seq,
          attempt: 0,
          prerequisite: 'runtime_conformance',
          message: 'The first verification failed.',
        },
        candidateDisposition: discardedCandidate(unexhaustedStart.data),
      })).toThrow(/private failure evidence/u)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each(['disposed', 'interrupted'] as const)(
    'rejects cancelled capability terminal without explicit user provenance: %s',
    async (provenance) => {
      const ctx = await setup()
      try {
        const routeId = `cancel-${provenance}`
        const session = ctx.sessions.create(SessionId(capabilityAuthoringCreatorSessionId(
          'source-session', routeId,
        )))
        const start = session.append('blueprint/capability-authoring', {
          routeId, sourceSessionId: 'source-session', state: 'started', targetPresetId: 'research',
          request: 'Add CSV support', kind: 'skill', ...capabilityBaseline('research'),
        })
        const end = settleInitialCapabilityTurn(session, start, 1, provenance === 'disposed'
          ? { kind: 'aborted', reason: { kind: 'disposed' } }
          : { kind: 'interrupted' })
        expect(() => session.append('blueprint/capability-authoring', {
          ...start.data,
          state: 'ended',
          startSeq: start.seq,
          outcome: 'cancelled',
          capabilityFailure: {
            turnEndSeq: end.seq,
            attempt: 0,
            prerequisite: 'cancelled',
            message: 'Capability authoring was cancelled.',
          },
          candidateDisposition: discardedCandidate(start.data),
        })).toThrow(/private failure evidence/u)
      } finally {
        await ctx.fiber.dispose()
      }
    },
  )

  it('uses one durable cancellation request as idle authority and rejects every later wake or publication', async () => {
    const ctx = await setup()
    try {
      const routeId = 'idle-cancel-route'
      const session = ctx.sessions.create(SessionId(capabilityAuthoringCreatorSessionId(
        'source-session', routeId,
      )))
      const start = session.append('blueprint/capability-authoring', {
        routeId, sourceSessionId: 'source-session', state: 'started', targetPresetId: 'research',
        request: 'Add CSV support', kind: 'skill', ...capabilityBaseline('research'),
      })
      const wakeId = MessageId(`blueprint-capability:${createHash('sha256')
        .update(JSON.stringify(['source-session', routeId, start.seq])).digest('hex')}`)
      const wake = {
        id: wakeId,
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'Author the capability.' }],
        source: { kind: 'plugin' as const, plugin: 'blueprint-adapter' },
      }
      session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [wake] })
      expect(() => session.append('blueprint/capability-cancel-requested', {
        routeId: 'other-route', startSeq: start.seq,
      })).toThrow(/sole active lifecycle/u)
      const cancellation = session.append('blueprint/capability-cancel-requested', {
        routeId, startSeq: start.seq,
      })
      expect(() => session.append('blueprint/capability-cancel-requested', {
        routeId, startSeq: start.seq,
      })).toThrow(/exactly once/u)
      session.append('agent/inbox/spliced', {
        target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled',
      })
      expect(() => session.append('agent/inbox/spliced', {
        target: 'next-turn', start: 0, inserted: [wake],
      })).toThrow(/active unverified lifecycle/u)
      const end = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      expect(() => session.append('blueprint/capability-repair', {
        routeId, startSeq: start.seq, turnEndSeq: end.seq, attempt: 1,
        prerequisite: 'runtime_conformance', message: 'Must not repair after cancellation.',
        candidateTreeDigest: compositionRevision('cancelled-candidate'),
        repairMessageId: MessageId(repairMessageId(routeId, start.seq, 1)),
      })).toThrow(/advance/u)
      expect(() => session.append('blueprint/capability-authoring', {
        ...start.data,
        state: 'ended', startSeq: start.seq, outcome: 'failed',
        capabilityFailure: {
          turnEndSeq: end.seq, attempt: 0, prerequisite: 'runtime_conformance', message: 'Wrong terminal.',
        },
        candidateDisposition: discardedCandidate(start.data),
      })).toThrow(/another terminal outcome/u)
      expect(cancellation.seq).toBeGreaterThan(start.seq)
      expect(() => session.append('blueprint/capability-authoring', {
        ...start.data,
        state: 'ended', startSeq: start.seq, outcome: 'cancelled',
        capabilityFailure: {
          turnEndSeq: start.seq, attempt: 0, prerequisite: 'cancelled', message: 'User cancelled.',
        },
        candidateDisposition: discardedCandidate(start.data),
      })).not.toThrow()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('accepts one recoverable capability-authoring lifecycle and rejects mismatched endings', async () => {
    const ctx = await setup()
    const arbitrary = ctx.sessions.create(SessionId('arbitrary-capability-child'))
    expect(() => arbitrary.append('blueprint/capability-authoring', {
      routeId: 'skill-route', sourceSessionId: 'source-session',
      state: 'started', targetPresetId: 'competitive-research', request: '解析 CSV 财报', kind: 'skill',
      ...capabilityBaseline('competitive-research'),
    })).toThrow(/source Session or legacy deterministic Creator Session/u)
    const session = ctx.sessions.create(SessionId(capabilityAuthoringCreatorSessionId(
      'source-session', 'skill-route',
    )))
    const started = session.append('blueprint/capability-authoring', {
      routeId: 'skill-route', sourceSessionId: 'source-session',
      state: 'started', targetPresetId: 'competitive-research', request: '解析 CSV 财报', kind: 'skill',
      ...capabilityBaseline('competitive-research'),
    })
    const end = settleInitialCapabilityTurn(session, started, 1, {
      kind: 'aborted', reason: { kind: 'user' },
    })
    expect(() => session.append('blueprint/capability-authoring', {
      ...started.data,
      routeId: 'other-route', state: 'ended',
      startSeq: started.seq, outcome: 'cancelled',
    })).toThrow(/active lifecycle/u)
    expect(() => session.append('blueprint/capability-authoring', {
      ...started.data,
      state: 'ended',
      startSeq: started.seq, outcome: 'cancelled',
      capabilityFailure: {
        turnEndSeq: end.seq, attempt: 0, prerequisite: 'cancelled', message: 'User cancelled capability authoring.',
      },
      candidateDisposition: discardedCandidate(started.data),
    })).not.toThrow()
    expect(() => session.append('blueprint/capability-authoring', {
      routeId: 'skill-route', sourceSessionId: 'source-session',
      state: 'ended', targetPresetId: 'competitive-research', request: '解析 CSV 财报', kind: 'skill',
      ...capabilityBaseline('competitive-research'),
      startSeq: started.seq, outcome: 'failed',
    })).toThrow(/active lifecycle/u)
  })

  it('publishes Skill evidence only after one matching verified checkpoint', async () => {
    const ctx = await setup()
    try {
      const session = ctx.sessions.create(SessionId(capabilityAuthoringCreatorSessionId(
        'source-session', 'skill-route',
      )))
      const data = { routeId: 'skill-route', sourceSessionId: 'source-session',
        targetPresetId: 'research', request: 'CSV Skill', kind: 'skill' as const,
        ...capabilityBaseline('research'), baselineSkills: [skillBaseline('existing')] }
      const start = session.append('blueprint/capability-authoring', { ...data, state: 'started' })
      const end = settleInitialCapabilityTurn(session, start, 1, { kind: 'completed' })
      const terminal = { ...data, state: 'ended' as const, startSeq: start.seq, outcome: 'completed' as const }
      expect(() => session.append('blueprint/capability-authoring', terminal)).toThrow(/verified checkpoint/u)

      const revision = compositionRevision('skill-revision')
      const definitionDigest = compositionRevision('csv')
      const verification = runtimeVerification('research', revision)
      verification.skills.evidence = [{
        nodeId: 'capability:skill:csv', name: 'csv', actualPresent: true,
        expectedDefinitionDigest: definitionDigest, liveDefinitionDigest: definitionDigest, status: 'pass' as const,
      }]
      const skillEvidence = {
        turnEndSeq: end.seq,
        revision,
        skills: [{ name: 'csv', definitionDigest, invocation: { modelInvocable: true, userInvocable: true } }],
        verification,
      }
      const candidateTreeDigest = compositionRevision('skill-candidate')
      expect(() => session.append('blueprint/capability-verified', {
        routeId: data.routeId,
        startSeq: start.seq,
        turnEndSeq: end.seq,
        candidateTreeDigest,
        kind: 'skill',
        skillEvidence: {
          ...skillEvidence,
          skills: [{ ...skillEvidence.skills[0]!, name: 'existing' }],
        },
      })).toThrow(/Skill verification/u)
      expect(() => session.append('blueprint/capability-verified', {
        routeId: data.routeId,
        startSeq: start.seq,
        turnEndSeq: end.seq,
        candidateTreeDigest,
        kind: 'skill',
        skillEvidence,
      })).not.toThrow()
      expect(() => session.append('blueprint/capability-authoring', {
        ...terminal,
        skillEvidence,
      })).toThrow(/committed candidate/u)
      expect(() => session.append('blueprint/capability-authoring', {
        ...terminal,
        skillEvidence,
        candidateDisposition: committedCandidate(start.data, candidateTreeDigest),
      })).not.toThrow()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('accepts one typed Creator route identity and rejects a duplicate in the same Session', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    const event = {
      operation: 'create-agent' as const,
      routeId: 'route-1', sourceSessionId: 'source-1',
      request: 'Create an agent that researches public AI companies.',
      name: 'Public AI Company Research Agent', sourceLanguage: 'fr-FR',
    }
    expect(() => session.append('blueprint/creator-authoring', event)).not.toThrow()
    expect(() => session.append('blueprint/creator-authoring', event)).toThrow(/routeId must be unique/u)
  })

  it('rejects malformed semantic transitions', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()

    expect(() => session.append('blueprint/user-change', change([], { presetId: '' })))
      .toThrow(/must be non-empty/u)
    expect(() => session.append('blueprint/user-change', change([], { currentValue: '快速整理访谈。' })))
      .toThrow(/different values/u)
    expect(() => session.append('blueprint/user-change', change([], {
      nodeType: 'capability', previousValue: false, currentValue: true, operation: 'disable',
    }))).toThrow(/Capability boolean transition/u)
  })

  it('rejects invalid restored state when the companion registers', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.sessions.create().append('blueprint/user-change', change([], {
      nodeType: 'capability', previousValue: true, currentValue: false, operation: 'update',
    }))
    await ctx.plugin(InvariantRegistry, { enabled: true })

    await expect(ctx.plugin(BlueprintAdapterInvariant).then(() => undefined))
      .rejects.toThrow(/text values/u)
  })

  it('ignores unrelated Session events', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    expect(() => session.append('turn/start', { turn: 1 })).not.toThrow()
    expect(() =>{  ctx.emit('session/event', session, {
      type: 'turn/end', seq: 1, time: 1, data: { turn: 1, reason: { kind: 'completed' } },
    } as SessionEvent) }).not.toThrow()
  })
})
