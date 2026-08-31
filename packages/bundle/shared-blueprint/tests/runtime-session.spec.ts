import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import * as Persona from '../../../preset/persona/src/index.ts'
import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool, TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import BlueprintAdapter, {
  BLUEPRINT_CAPABILITY_AUTHORING_TOOL,
  BLUEPRINT_CONVERSATION_SECTION,
  BLUEPRINT_PROPOSAL_TOOL,
} from '../src/host/index.ts'
import { capabilityAuthoringCreatorSessionId } from '../src/host/capability-authority.ts'
import { prepareCapabilityCandidate, resolveCapabilityCandidatePreset } from '../src/host/capability-candidate.ts'
import { blueprintChangeSetOperations } from '../src/host/proposal.ts'
import type {
  Blueprint,
  BlueprintApplyChangeSetRequest,
  BlueprintChangeSet,
  BlueprintChangeSetOperation,
  BlueprintValidateSessionRequest,
} from '../src/contract/types.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as ToolSubagent from '../../../subagent/tool-subagent/src/index.ts'
import * as Spawn from '../../../subagent/subagent-spawn-in-process/src/index.ts'
import * as SkillFilesystem from '../../../skill/skill-filesystem/src/index.ts'
import * as ToolSkill from '../../../skill/tool-skill/src/index.ts'
import JsonlSessionPersistence from '../../../session/session-persistence-jsonl/src/index.ts'

const FIXTURE_PLUGIN = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'runtime.js')

type LoaderInternal = NonNullable<Context['loader']['internal']>

const fixtureImports = new WeakMap<LoaderInternal, {
  original: LoaderInternal['import']
  users: number
}>()

function installFixtureImports(loader: LoaderInternal): () => void {
  const existing = fixtureImports.get(loader)
  if (existing !== undefined) {
    existing.users += 1
    return () => {
      existing.users -= 1
      if (existing.users === 0) {
        loader.import = existing.original
        fixtureImports.delete(loader)
      }
    }
  }
  const original = loader.import
  loader.import = (...args: Parameters<LoaderInternal['import']>) => (
    args[0] === '@deepseek-ai/dsh-skill-filesystem' ? Promise.resolve(SkillFilesystem)
      : args[0] === '@deepseek-ai/dsh-tool-skill' ? Promise.resolve(ToolSkill)
        : args[0] === '@deepseek-ai/dsh-tool-subagent' ? Promise.resolve(ToolSubagent)
          : Reflect.apply(original, loader, args) as Promise<unknown>
  )
  fixtureImports.set(loader, { original, users: 1 })
  return () => {
    const installed = fixtureImports.get(loader)
    if (installed === undefined) return
    installed.users -= 1
    if (installed.users === 0) {
      loader.import = installed.original
      fixtureImports.delete(loader)
    }
  }
}

const OLD_BEHAVIORS = [
  '按统考口径检查报考资格。',
  '跟踪统考报名与初试结果。',
  '管理复试院校与截止时间。',
  '维护调剂候补与录取状态。',
]

const NEW_BEHAVIORS = [
  '按推免政策检查申请资格。',
  '跟踪夏令营报名与入营结果。',
  '管理预推免院校与截止时间。',
  '维护九推候补与录取状态。',
]

function composition(): string {
  const plugin = pathToFileURL(FIXTURE_PLUGIN).href
  return `- id: persona
  name: '${plugin}'
  config:
    text: >-
      你是一名考研择校助手，由 {{model}} 驱动，工作目录是 {{cwd}}。

      你的职责是帮助用户完成国内保研择校与申请管理。工作方式：

      1. ${OLD_BEHAVIORS[0]}

      2. ${OLD_BEHAVIORS[1]}

      3. ${OLD_BEHAVIORS[2]}

      4. ${OLD_BEHAVIORS[3]}

      5. 交付形式：输出申请进度表、风险摘要与来源。
    skill:
      name: source-audit
      description: 核对申请信息来源。
      content: 只接受可核实的院校官方来源。
      invocation:
        modelInvocable: true
        userInvocable: true
- id: tool-web
  name: '${plugin}'
  config:
    search: true
    fetch: false
`
}

function filesystemSkillCompositionRows(): string {
  return `- id: skill-filesystem-candidate
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    includeDefaultRoots: false
    customSkillDirs:
      - !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))"
- id: tool-skill-candidate
  name: '@deepseek-ai/dsh-tool-skill'
`
}

function standardFilesystemSkillCompositionRows(candidate: boolean): string {
  return `- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
${candidate ? `  config:
    customSkillDirs:
      - !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))"
` : ''}- id: tool-skill
  name: '@deepseek-ai/dsh-tool-skill'
`
}

function filesystemSkillDefinition(name: string, callable = true): string {
  return `---
name: ${name}
description: Read CSV financial metrics from supplied files.
${callable ? '' : 'disable-model-invocation: true\nuser-invocable: false\n'}---

Read the requested CSV columns and return a structured comparison.
`
}

async function candidatePresetPath(
  ctx: Context,
  agent: import('@deepseek-ai/dsh-agent').Agent,
  presetId: string,
): Promise<string> {
  return (await ctx.agentPresets.resolveFor(agent.ctx, presetId)).path
}

function delegationCompositionRow(
  rowId: string,
  toolName: string,
  agentProviderExpression = '"deepseek"',
): string {
  return `- id: ${rowId}
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: ${toolName}
    backgroundMode: one-shot
    persona: 你是来源核验协作者。核对公开来源并报告冲突。
    agentOptions:
      provider: !!js '${agentProviderExpression}'
      model: deepseek-chat
      maxTokens: 512
    toolFilter:
      allow: [web_search]
      deny: [read]
    maxDepth: 2
`
}

function recordDurableProposal(
  agent: import('@deepseek-ai/dsh-agent').Agent,
  blueprint: Blueprint,
  changeSetId: string,
  operations: BlueprintChangeSetOperation[],
): BlueprintApplyChangeSetRequest {
  const turn = 1 + (agent.session.events.findLast(event => event.type === 'turn/start')?.data.turn ?? 0)
  agent.session.append('turn/start', { turn })
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Apply this exact Blueprint change.' }] })
  const user = agent.session.append('user/message', message, { surfaceOp: 'append' })
  const callId = CallId(changeSetId)
  agent.session.append('tool/call', { turn, step: 1, callId, name: 'propose_blueprint_change', arguments: '{}' })
  agent.session.append('blueprint/route-decision', {
    routeId: String(message.id), sourceSessionId: agent.session.id,
    userMessageId: message.id, userMessageSeq: user.seq, turn,
    operation: 'modify-existing-agent', callId, targetPresetId: blueprint.preset.id,
    provenance: 'user-message',
  })
  const changeSet: BlueprintChangeSet = {
    sourceSessionId: String(agent.session.id), routeId: String(message.id), changeSetId,
    kind: 'direct-request', presetId: blueprint.preset.id, revision: blueprint.revision,
    proposals: operations.map((operation, index) => ({
      proposalId: operations.length === 1 ? changeSetId : `${changeSetId}:${String(index + 1)}`,
      presetId: blueprint.preset.id, revision: blueprint.revision,
      targetNodeId: operation.targetNodeId, operation: operation.operation,
      currentValue: operation.expected,
      proposedValue: operation.operation === 'setCapability' ? operation.enabled : operation.value,
      impact: `Apply ${operation.targetNodeId}.`,
    })),
  }
  const durableChangeSet = snapshotJsonValue<unknown>(changeSet)
  if (durableChangeSet === undefined) throw new Error('test Change Set must be lossless JSON')
  agent.session.append('tool/result', {
    turn, step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'Proposal created.' }], isError: false }),
    meta: { blueprintChangeSet: durableChangeSet as JsonValue },
  }, { surfaceOp: 'append' })
  return {
    sourceSessionId: String(agent.session.id), routeId: String(message.id), changeSetId,
    presetId: blueprint.preset.id, baseRevision: blueprint.revision,
    operations: blueprintChangeSetOperations(changeSet),
  }
}

interface DurableCapabilityRouteFixture {
  sourceSessionId: string
  routeId: string
  target: Blueprint
  request: string
  kind: 'skill' | 'subagent'
  resultIsError?: boolean
  omitCall?: boolean
  omitDecision?: boolean
  routeOverrides?: Partial<{
    routeId: string
    sourceSessionId: string
    presetId: string
    revision: string
    request: string
    kind: 'skill' | 'subagent'
    reason: string
  }>
}

const heldCapabilityAgents = new WeakSet<Agent>()

function holdCapabilityFollowups(agent: Agent): void {
  if (heldCapabilityAgents.has(agent)) return
  heldCapabilityAgents.add(agent)
  vi.spyOn(agent, 'followup').mockImplementation((message) => {
    agent.send(message, 'next-turn', false)
  })
}

function claimCapabilityInput(agent: Agent, turn: number): void {
  agent.session.append('turn/start', { turn })
  if (agent.inbox.claim('next-turn', turn).length === 0) {
    throw new Error(`test expected one pending capability input for turn ${String(turn)}`)
  }
}

function recordDurableCapabilityRoute(
  ctx: Context,
  fixture: DurableCapabilityRouteFixture,
): NonNullable<import('../src/contract/types.ts').BlueprintConversationContextRequest['capabilityAuthoring']> {
  const authoring = ctx.agents.get(SessionId(fixture.sourceSessionId))
    ?? ctx.agents.get(SessionId(capabilityAuthoringCreatorSessionId(fixture.sourceSessionId, fixture.routeId)))
  if (authoring !== undefined) holdCapabilityFollowups(authoring)
  const source = ctx.sessions.get(SessionId(fixture.sourceSessionId))
    ?? ctx.sessions.create(SessionId(fixture.sourceSessionId))
  const turn = 1 + (source.events.findLast(event => event.type === 'turn/start')?.data.turn ?? 0)
  source.append('turn/start', { turn })
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: fixture.request }] })
  source.append('blueprint/routing-input', {
    routeId: fixture.routeId, sourceSessionId: source.id, messageId: message.id,
    userRequest: fixture.request, uiAction: 'add-capability', targetPresetId: fixture.target.preset.id,
  })
  const user = source.append('user/message', message, { surfaceOp: 'append' })
  const callId = CallId(`${fixture.routeId}:call`)
  if (fixture.omitCall !== true) {
    source.append('tool/call', {
      turn, step: 1, callId, name: 'route_blueprint_capability_authoring', arguments: '{}',
    })
  }
  if (fixture.omitDecision !== true) {
    source.append('blueprint/route-decision', {
      routeId: fixture.routeId, sourceSessionId: source.id,
      userMessageId: message.id, userMessageSeq: user.seq, turn,
      operation: fixture.kind, callId, targetPresetId: fixture.target.preset.id,
      provenance: 'add-capability',
    })
  }
  const route = {
    routeId: fixture.routeId,
    sourceSessionId: fixture.sourceSessionId,
    presetId: fixture.target.preset.id,
    revision: fixture.target.revision,
    request: fixture.request,
    kind: fixture.kind,
    reason: 'The requested capability requires a real target-scoped definition.',
    ...fixture.routeOverrides,
  }
  const durableRoute = snapshotJsonValue<unknown>(route)
  if (durableRoute === undefined) throw new Error('test capability route must be lossless JSON')
  source.append('tool/result', {
    turn, step: 1,
    message: createToolResultMessage({
      callId, content: [{ type: 'text', text: fixture.resultIsError === true ? 'Route rejected.' : 'Route accepted.' }],
      isError: fixture.resultIsError === true,
    }),
    meta: { blueprintCapabilityAuthoring: durableRoute as JsonValue },
  }, { surfaceOp: 'append' })
  source.append('turn/end', { turn, reason: { kind: 'completed' } })
  return {
    routeId: fixture.routeId,
    sourceSessionId: fixture.sourceSessionId,
    targetPresetId: fixture.target.preset.id,
    request: fixture.request,
    kind: fixture.kind,
    baseRevision: fixture.target.revision,
  }
}

async function harness(
  root: string,
  capabilityRepairAttempts?: number,
  sessionPersistenceRoot?: string,
): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins['skill-filesystem'] = SkillFilesystem
  ctx.loader.builtins['tool-skill'] = ToolSkill
  const uninstallFixtureImports = installFixtureImports(ctx.loader.internal!)
  ctx.effect(() => uninstallFixtureImports, 'blueprint runtime fixture: package imports')
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SkillRegistry)
  ctx.skills.register({
    name: 'global-review', description: '全局复核说明。', content: '执行全局复核。', source: 'runtime',
  })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  if (sessionPersistenceRoot !== undefined) {
    await ctx.plugin(JsonlSessionPersistence, { root: sessionPersistenceRoot, compression: 'none' })
  }
  await ctx.plugin(AgentPresets, {
    default: 'kaoyan-choose',
    roots: [{ path: root, trust: 'user' }],
    includeUserRoot: false,
  })
  await ctx.plugin(BlueprintAdapter, capabilityRepairAttempts === undefined ? {} : { capabilityRepairAttempts })
  return ctx
}

describe('Blueprint runtime conformance through a real mounted Session', () => {
  it.each(['mounted', 'multiple', 'no-delta', 'provider-missing', 'depth-zero', 'broken-mount',
    'existing-config-mutated', 'cancelled'] as const)(
    'settles unopened Subagent authoring using a real mounted verification Session: %s', async (scenario) => {
      const root = await mkdtemp(join(tmpdir(), 'dsh-subagent-terminal-'))
      for (const presetId of ['cordis', 'kaoyan-choose']) {
        await mkdir(join(root, presetId))
        await writeFile(join(root, presetId, 'agent.cordis.yml'), presetId === 'kaoyan-choose'
          && scenario === 'existing-config-mutated'
          ? composition() + delegationCompositionRow('source-review', 'source_review')
          : composition())
      }
      const ctx = await harness(root, 0)
      try {
        await ctx.plugin(Spawn, { providerName: 'spawn' })
        const sourceSessionId = `source-subagent-${scenario}`
        const routeId = `subagent-${scenario}`
        const { agent } = await ctx.agents.create({
          sessionId: SessionId(capabilityAuthoringCreatorSessionId(sourceSessionId, routeId)),
          meta: { agentPreset: 'cordis', cwd: root },
          setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'cordis') },
        })
        const target = await ctx.blueprintAdapter.read('kaoyan-choose', { cwd: root })
        const request = { sessionId: String(agent.id), recoverCapabilityAuthoring: true }
        await ctx.blueprintAdapter.setConversationContext({
          sessionId: String(agent.id),
          capabilityAuthoring: recordDurableCapabilityRoute(ctx, {
            routeId, sourceSessionId, target, kind: 'subagent', request: '新增行业研究协作者',
          }),
        })
        const candidatePath = await candidatePresetPath(ctx, agent, 'kaoyan-choose')
        claimCapabilityInput(agent, 1)
        expect((await ctx.blueprintAdapter.setConversationContext(request)).capabilityAuthoringRecord?.state).toBe('active')
        if (scenario !== 'no-delta' && scenario !== 'cancelled') {
          await writeFile(candidatePath, scenario === 'broken-mount' ? 'invalid: [' : `${composition()}${scenario === 'existing-config-mutated'
            ? delegationCompositionRow('source-review', 'source_review', '"mock"') : ''}
- id: industry-research
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: ${scenario === 'provider-missing' ? 'missing' : 'spawn'}
    toolName: industry_research
    backgroundMode: one-shot
    persona: 你是行业研究协作者。核验行业趋势与公开来源。
    maxDepth: ${scenario === 'depth-zero' ? 0 : 1}
    toolFilter:
      allow: [web_search]
${scenario === 'multiple' ? `- id: policy-research
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: policy_research
    backgroundMode: one-shot
    persona: 你是政策研究协作者。核验政策与公开来源。
    maxDepth: 1
    toolFilter:
      allow: [web_search]
` : ''}
`)
        }
        const verifications: string[] = []
        ctx.on('session/created', (session) => {
          if (String(session.id).startsWith('blueprint-subagent-verification-')) verifications.push(String(session.id))
        })
        const end = agent.session.append('turn/end', { turn: 1, reason: scenario === 'cancelled'
          ? { kind: 'aborted', reason: { kind: 'user' } } : { kind: 'completed' } })
        await vi.waitFor(() => {
          expect(agent.session.events.filter(event => event.type === 'blueprint/capability-authoring'
            && event.data.state === 'ended')).toHaveLength(1)
        })
        const results = await Promise.all([1, 2].map(() => ctx.blueprintAdapter.setConversationContext(request)))
        const outcome = scenario === 'mounted' ? 'completed' : scenario === 'cancelled' ? 'cancelled' : 'failed'
        expect(results[0]?.capabilityAuthoringRecord, JSON.stringify(results[0]?.capabilityAuthoringRecord))
          .toMatchObject({ kind: 'subagent', state: 'ended', outcome })
        expect(agent.session.events.filter(event => event.type === 'blueprint/capability-authoring'
          && event.data.state === 'ended')).toHaveLength(1)
        expect(ctx.agents.list().filter(item => String(item.id).startsWith('blueprint-subagent-verification-'))).toHaveLength(0)
        if (scenario === 'mounted') {
          expect(verifications).toHaveLength(1)
          expect(results[0]?.capabilityAuthoringRecord?.subagentEvidence).toMatchObject({
            turnEndSeq: end.seq,
            delegations: [{ rowId: 'industry-research', provider: 'spawn', enabled: true, providerAvailable: true }],
            verification: { valid: true, presetId: 'kaoyan-choose', delegations: { status: 'pass' } },
          })
        } else if (outcome === 'failed') {
          const terminal = agent.session.events.find(event => event.type === 'blueprint/capability-authoring'
            && event.data.state === 'ended')
          if (terminal?.type !== 'blueprint/capability-authoring' || terminal.data.state !== 'ended') {
            throw new Error('Missing exhausted Subagent terminal')
          }
          expect(terminal.data.capabilityFailure).toMatchObject({
            attempt: 0,
            prerequisite: 'candidate_delta',
          })
          expect(terminal.data.candidateDisposition).toMatchObject({ disposition: 'discarded' })
          expect(terminal.data.candidateDisposition?.finalTreeDigest).toMatch(/^[0-9a-f]{64}$/u)
          expect(results[0]?.capabilityAuthoringRecord).not.toHaveProperty('capabilityFailure')
          expect(results[0]?.capabilityAuthoringRecord).not.toHaveProperty('candidateDisposition')
        }
        expect((await ctx.blueprintAdapter.setConversationContext({
          sessionId: String(agent.id), capabilityAuthoringEnd: { outcome: 'completed' },
        })).capabilityAuthoringRecord?.outcome).toBe(outcome)
      } finally {
        await ctx.fiber.dispose()
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it('projects the real RC folded rule source through the Loader without changing other semantic nodes', async () => {
    const fixture = await readFile('examples/web-blueprint-demo/tests/fixtures/preset/blueprint-adapter/rc1-folded-rules.cordis.yml', 'utf8')
    const root = await mkdtemp(join(tmpdir(), 'dsh-folded-behavior-'))
    await mkdir(join(root, 'kaoyan-choose'))
    await writeFile(join(root, 'kaoyan-choose', 'agent.cordis.yml'), fixture.replace('@deepseek-ai/dsh-persona', 'cordis:persona') + `
- id: tool-web
  name: '${pathToFileURL(FIXTURE_PLUGIN).href}'
  config:
    search: true
    fetch: false
`)
    const ctx = await harness(root)
    try {
      ctx.loader.builtins.persona = Persona
      const agent = (await ctx.agents.create({
        sessionId: SessionId('folded-behavior'), meta: { agentPreset: 'kaoyan-choose', cwd: root },
        setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'kaoyan-choose'),
      })).agent
      const blueprint = await ctx.blueprintAdapter.read('kaoyan-choose', { agent })
      const rules = blueprint.nodes.filter(node => node.type === 'behavior')
      expect(rules).toHaveLength(5)
      expect(rules.every(node => !node.editable && node.adapterRef === null)).toBe(true)
      expect(rules[0]?.value).toBe('开始研究前，先与用户确认研究对象（公司名称/证券代码）和报告基准日期；信息不足时先提问，不擅自假定。')
      expect(rules[4]?.value).toBe('不提供任何买卖建议。')
      expect(blueprint.nodes.filter(node => node.type !== 'behavior')).toMatchObject([
        { id: 'identity:persona', value: '上市公司研究分析师', editable: true },
        { id: 'purpose:persona', value: '读取本地资料并搜索公开信息，对比公司营收、净利润、PE 和 PB，区分事实、推断与缺失，不提供买卖建议。', editable: true },
        { id: 'output:persona', value: '中文摘要、指标对比表和有来源日期的结论。', editable: false },
        { id: 'capability:web-search', value: { enabled: true } },
        { id: 'capability:web-fetch', value: { enabled: false } },
        { id: 'capability:skill:global-review', source: 'inherited', editable: false },
      ])
      expect(blueprint.runtime.promptSections).toContain('deployment:persona')
      expect(blueprint.mappingGaps.some(gap => gap.field === 'behavior' && /read-only/u.test(gap.reason))).toBe(true)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('records a real Identity direct edit through proposal event production and the invariant', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-identity-invariant-'))
    await mkdir(join(root, 'kaoyan-choose'))
    await writeFile(join(root, 'kaoyan-choose', 'agent.cordis.yml'), composition())
    const ctx = await harness(root)
    try {
      const adapter = new MockAdapter([textResponse('角色已更新；相关调整仍需确认。')])
      ctx.llm.registerAdapter(['mock'], adapter)
      const source = (await ctx.agents.create({
        sessionId: SessionId('identity-edit-source'), meta: { agentPreset: 'kaoyan-choose', cwd: root },
        agentOptions: { provider: 'mock', model: 'mock' },
        setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'kaoyan-choose'),
      })).agent
      const before = await ctx.blueprintAdapter.read('kaoyan-choose')
      const after = await ctx.blueprintAdapter.updateIdentity({
        presetId: 'kaoyan-choose', revision: before.revision, nodeId: 'identity:persona',
        expected: '考研择校助手', value: '保研申请顾问',
      })
      expect(after.revision).not.toBe(before.revision)
      expect(after.nodes.find(node => node.type === 'identity')).toMatchObject({ value: '保研申请顾问', editable: true })
      await ctx.blueprintAdapter.setConversationContext({
        sessionId: String(source.id), presetId: 'kaoyan-choose', revision: after.revision,
        userChange: { nodeId: 'identity:persona', previousValue: '考研择校助手' },
      })
      await source.whenIdle()
      const events = source.session.events.filter(event => event.type === 'blueprint/user-change')
      expect(events).toHaveLength(1)
      expect(events[0]?.data).toMatchObject({
        presetId: 'kaoyan-choose', nodeId: 'identity:persona', nodeType: 'identity',
        previousValue: '考研择校助手', currentValue: '保研申请顾问', operation: 'update',
      })
      expect(events[0]?.data.impactCandidates.map(candidate => candidate.nodeId)).toEqual([
        'purpose:persona', 'behavior:1', 'behavior:2', 'behavior:3', 'behavior:4', 'output:5',
      ])
      expect(adapter.requests).toHaveLength(1)
      const trial = await ctx.agents.create({
        sessionId: SessionId('identity-edit-trial'), meta: { agentPreset: 'kaoyan-choose', cwd: root },
        setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'kaoyan-choose'),
      })
      const validation = await ctx.blueprintAdapter.validateSession({
        sessionId: String(trial.agent.id), presetId: 'kaoyan-choose', expectedRevision: after.revision,
      })
      expect(validation.overall).toBe('pass')
      expect(validation.prompt.evidence.find(item => item.nodeId === 'identity:persona')).toMatchObject({ status: 'pass' })
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['skill', 'subagent'] as const)('owns a target-bound %s route despite injected new-Agent guidance and route fishing', async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-routing-provenance-'))
    await mkdir(join(root, 'kaoyan-choose'))
    await writeFile(join(root, 'kaoyan-choose', 'agent.cordis.yml'), composition())
    const ctx = await harness(root)
    const userRequest = kind === 'skill' ? '增加一个本地 CSV 财务指标处理能力。' : '增加一个行业研究协作者。'
    try {
      const adapter = new MockAdapter([
        [
          ...[
            toolCallResponse('wrong-edit', 'propose_blueprint_change', {
              intent: 'modify-existing-agent', changes: [{
                target_node_id: 'purpose:persona', operation: 'updatePurpose',
                current_value: '帮助用户完成国内保研择校与申请管理。',
                proposed_value: '增加能力。', impact: '近似描述能力。',
              }],
            }),
            toolCallResponse('wrong-write', 'write_probe', {}),
            toolCallResponse('capability', 'route_blueprint_capability_authoring', {
              request: 'model paraphrase', kind, reason: 'Requires an authored definition.',
            }),
            toolCallResponse('duplicate', 'route_blueprint_capability_authoring', {
              request: 'model paraphrase', kind, reason: 'Requires an authored definition.',
            }),
            toolCallResponse('wrong-new', 'route_blueprint_creator_authoring', {
              name: 'Wrong Agent', user_intent: userRequest,
            }),
          ].flatMap((chunks, index) => chunks.filter(chunk => chunk.type !== 'finish' && chunk.type !== 'usage')
            .map(chunk => 'index' in chunk ? { ...chunk, index } : chunk)),
          { type: 'finish', reason: { kind: 'tool-calls' } },
        ],
        textResponse('Keep the requested capability on the current Agent.'),
      ])
      ctx.llm.registerAdapter(['mock'], adapter)
      const agent = (await ctx.agents.create({
        sessionId: SessionId(`routing-${kind}`), meta: { agentPreset: 'kaoyan-choose', cwd: root },
        agentOptions: { provider: 'mock', model: 'mock' },
        setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'kaoyan-choose'),
      })).agent
      let writes = 0
      agent.ctx.tools.register(defineTool({
        name: 'write_probe', description: 'Detect a formal write attempted during routing.', parameters: {},
        output: { schema: { type: 'json' }, render: () => [] },
        execute: () => { writes += 1; return Promise.resolve(true) },
      }))
      agent.ctx.systemPrompt.context({ name: 'contaminating-guidance', order: 119, text: 'create a new Agent / 创建新的 Agent' })
      const blueprint = await ctx.blueprintAdapter.read('kaoyan-choose')
      await ctx.blueprintAdapter.setConversationContext({
        sessionId: String(agent.id), presetId: blueprint.preset.id, revision: blueprint.revision,
        capabilityInput: { routeId: `capability-${kind}`, userRequest },
      })
      await agent.whenIdle()
      const human = agent.session.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
      expect(human).toHaveLength(1)
      expect(human[0]?.data).toMatchObject({ content: [{ type: 'text', text: userRequest }] })
      const results = agent.session.events.filter(event => event.type === 'tool/result')
      expect(results.map(event => event.data.message.content[0].isError)).toEqual([true, true, false, true, true])
      expect(JSON.stringify(results[0]?.data.message)).toContain('cannot be approximated')
      expect(JSON.stringify(results[1]?.data.message)).toContain('must settle through one typed Blueprint route')
      expect(JSON.stringify(results[3]?.data.message)).toContain('blueprint-route-already-owned')
      expect(writes).toBe(0)
      expect(adapter.requests).toHaveLength(1)
      expect(results[2]?.data.meta).toMatchObject({ blueprintCapabilityAuthoring: {
        kind, presetId: 'kaoyan-choose', request: userRequest,
        routeId: `capability-${kind}`, sourceSessionId: `routing-${kind}`,
      } })
      expect(agent.session.events.filter(event => event.type === 'blueprint/creator-authoring')).toHaveLength(0)
      expect(agent.session.events.filter(event => event.type === 'blueprint/route-decision').map(event => (
        { routeId: event.data.routeId, operation: event.data.operation }
      ))).toEqual([{ routeId: `capability-${kind}`, operation: kind }])
      expect((await ctx.agentPresets.list()).map(preset => preset.id)).toEqual(['kaoyan-choose'])
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('stages a route-owned Purpose edit before Apply, then records the committed receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-purpose-structured-edit-'))
    await mkdir(join(root, 'kaoyan-choose'))
    await writeFile(join(root, 'kaoyan-choose', 'agent.cordis.yml'), composition())
    const ctx = await harness(root)
    const currentPurpose = '帮助用户完成国内保研择校与申请管理。'
    const proposedPurpose = '不提供投资建议，只做公司基本面、行业和估值研究。'
    try {
      const adapter = new MockAdapter([toolCallResponse('purpose-proposal', 'propose_blueprint_change', {
        intent: 'modify-existing-agent', changes: [{
          target_node_id: 'purpose:persona', operation: 'updatePurpose',
          current_value: currentPurpose, proposed_value: proposedPurpose,
          impact: '将 Agent 的目标收窄到公司基本面、行业和估值研究。',
        }],
      })])
      ctx.llm.registerAdapter(['mock'], adapter)
      const agent = (await ctx.agents.create({
        sessionId: SessionId('purpose-edit-source'), meta: { agentPreset: 'kaoyan-choose', cwd: root },
        agentOptions: { provider: 'mock', model: 'mock' },
        setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'kaoyan-choose'),
      })).agent
      const before = await ctx.blueprintAdapter.read('kaoyan-choose')

      const submitted = await ctx.blueprintAdapter.setConversationContext({
        sessionId: String(agent.id), presetId: before.preset.id, revision: before.revision,
        selectedNodeId: 'purpose:persona', directEditInput: {
          sourceSessionId: String(agent.id), routeId: 'purpose-route', nodeId: 'purpose:persona', nodeType: 'purpose',
          expectedValue: currentPurpose, proposedValue: proposedPurpose,
        },
      })
      expect(submitted.directEditEnqueue).toMatchObject({
        routeId: 'purpose-route', sourceSessionId: 'purpose-edit-source',
      })
      expect(typeof submitted.directEditEnqueue?.routingInputSeq).toBe('number')
      expect(typeof submitted.directEditEnqueue?.messageId).toBe('string')
      await agent.whenIdle()

      const staged = agent.session.events.find(event => event.type === 'blueprint/routing-input')
      expect(staged?.data).toMatchObject({
        routeId: 'purpose-route', sourceSessionId: 'purpose-edit-source', uiAction: 'direct-edit',
        targetPresetId: 'kaoyan-choose',
        directEdit: { nodeId: 'purpose:persona', currentValue: currentPurpose, proposedValue: proposedPurpose },
      })
      const toolResult = agent.session.events.find(event => event.type === 'tool/result')
      expect(toolResult?.data.meta).toMatchObject({ blueprintChangeSet: {
        changeSetId: 'purpose-proposal', kind: 'structured-edit',
        sourceSessionId: 'purpose-edit-source', routeId: 'purpose-route',
        presetId: 'kaoyan-choose', revision: before.revision,
        proposals: [{
          targetNodeId: 'purpose:persona', operation: 'updatePurpose',
          currentValue: currentPurpose, proposedValue: proposedPurpose,
        }],
      } })
      expect(agent.session.events.filter(event => event.type === 'blueprint/route-decision').map(event => event.data))
        .toEqual([expect.objectContaining({
          routeId: 'purpose-route', operation: 'modify-existing-agent', provenance: 'direct-edit',
        })])
      expect((await ctx.blueprintAdapter.read('kaoyan-choose')).revision).toBe(before.revision)
      expect((await ctx.blueprintAdapter.read('kaoyan-choose')).nodes.find(node => node.id === 'purpose:persona')?.value)
        .toBe(currentPurpose)

      const applied = await ctx.blueprintAdapter.applyChangeSet({
        sourceSessionId: String(agent.id), routeId: 'purpose-route',
        changeSetId: 'purpose-proposal', presetId: 'kaoyan-choose',
        baseRevision: before.revision,
        operations: [{
          operation: 'updatePurpose', targetNodeId: 'purpose:persona', expected: currentPurpose, value: proposedPurpose,
        }],
      })
      expect(applied.status).toBe('committed')
      expect((await ctx.blueprintAdapter.read('kaoyan-choose')).nodes.find(node => node.id === 'purpose:persona')?.value)
        .toBe(proposedPurpose)
      const applyTerminalSeq = agent.session.events.find(event => event.type === 'blueprint/apply-result'
        && event.data.routeId === 'purpose-route')?.seq
      expect(applyTerminalSeq).toEqual(expect.any(Number))
      const receipts = (await ctx.blueprintAdapter.setConversationContext({ sessionId: String(agent.id) })).applyReceipts
      expect(receipts).toHaveLength(1)
      const receipt = receipts?.[0]
      expect(receipt).toMatchObject({
        sourceSessionId: String(agent.id), routeId: 'purpose-route',
        terminalSeq: applyTerminalSeq, presetId: 'kaoyan-choose', result: applied,
      })
      expect(typeof receipt?.proposalResultSeq).toBe('number')
      expect((await ctx.agentPresets.list()).map(preset => preset.id)).toEqual(['kaoyan-choose'])
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('enqueues Identity, Purpose, Behavior, Output, and Web edits without writing before Apply', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-structured-zero-write-'))
    await mkdir(join(root, 'kaoyan-choose'))
    await writeFile(join(root, 'kaoyan-choose', 'agent.cordis.yml'), composition())
    const ctx = await harness(root)
    const cases: Array<
      { nodeId: string; nodeType: 'identity' | 'purpose' | 'behavior' | 'output'; expectedValue: string; proposedValue: string }
      | { nodeId: string; nodeType: 'capability'; expectedValue: boolean; proposedValue: boolean }
    > = [
      { nodeId: 'identity:persona', nodeType: 'identity', expectedValue: '考研择校助手', proposedValue: '保研申请顾问' },
      { nodeId: 'purpose:persona', nodeType: 'purpose', expectedValue: '帮助用户完成国内保研择校与申请管理。', proposedValue: '只整理保研申请资料。' },
      { nodeId: 'behavior:1', nodeType: 'behavior', expectedValue: OLD_BEHAVIORS[0]!, proposedValue: '按推免政策检查申请资格。' },
      { nodeId: 'output:5', nodeType: 'output', expectedValue: '输出申请进度表、风险摘要与来源。', proposedValue: '输出申请清单、风险和来源。' },
      { nodeId: 'capability:web-search', nodeType: 'capability', expectedValue: true, proposedValue: false },
    ]
    try {
      ctx.llm.registerAdapter(['mock'], new MockAdapter(cases.map(item => textResponse(`Queued ${item.nodeType}.`))))
      for (const [index, item] of cases.entries()) {
        const handle = await ctx.agents.create({
          sessionId: SessionId(`zero-write-${item.nodeType}`),
          meta: { agentPreset: 'kaoyan-choose', cwd: root },
          agentOptions: { provider: 'mock', model: 'mock' },
          setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'kaoyan-choose'),
        })
        const before = await ctx.blueprintAdapter.read('kaoyan-choose')
        const node = before.nodes.find(candidate => candidate.id === item.nodeId)!
        const routeId = `zero-write-${String(index)}`
        const directEditInput = item.nodeType === 'capability'
          ? { ...item, expectedValue: (node.value as { enabled: boolean }).enabled,
            sourceSessionId: String(handle.agent.id), routeId }
          : { ...item, expectedValue: node.value as string,
            sourceSessionId: String(handle.agent.id), routeId }
        const result = await ctx.blueprintAdapter.setConversationContext({
          sessionId: String(handle.agent.id), presetId: before.preset.id, revision: before.revision,
          selectedNodeId: item.nodeId,
          directEditInput,
        })
        await handle.agent.whenIdle()
        const after = await ctx.blueprintAdapter.read('kaoyan-choose')
        expect(result.directEditEnqueue).toMatchObject({ routeId, sourceSessionId: String(handle.agent.id) })
        expect(after.revision).toBe(before.revision)
        const routingInput = handle.agent.session.events.find(event => event.type === 'blueprint/routing-input')
        expect(routingInput?.type).toBe('blueprint/routing-input')
        if (routingInput?.type !== 'blueprint/routing-input') throw new Error('Expected structured routing input')
        expect(routingInput.data).toMatchObject({ routeId, sourceSessionId: handle.agent.id })
        if (routingInput.data.uiAction !== 'direct-edit') throw new Error('Expected direct-edit routing input')
        expect(routingInput.data.directEdit).toMatchObject({ nodeId: item.nodeId, nodeType: item.nodeType })
      }
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('G: completed Creator history does not block current edits; active Creator context still rejects stale Proposal calls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-routing-guard-'))
    for (const id of ['kaoyan-choose', 'cordis']) {
      await mkdir(join(root, id))
      await writeFile(join(root, id, 'agent.cordis.yml'), composition())
    }
    const ctx = await harness(root)
    try {
      const adapter = new MockAdapter([])
      ctx.llm.registerAdapter(['mock'], adapter)
      const agent = (await ctx.agents.create({
        sessionId: SessionId('guard-creator'), meta: { agentPreset: 'cordis' },
        agentOptions: { provider: 'mock', model: 'mock' },
        setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'cordis'),
      })).agent
      agent.session.append('blueprint/creator-authoring', {
        operation: 'create-agent', routeId: 'old-route', sourceSessionId: 'old-source', request: '创建一个新 Agent', name: 'Agent',
      })
      agent.session.append('turn/start', { turn: 1 })
      agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      const blueprint = await ctx.blueprintAdapter.read('kaoyan-choose')
      await ctx.blueprintAdapter.setConversationContext({
        sessionId: String(agent.id), presetId: blueprint.preset.id, revision: blueprint.revision,
      })
      const tool = agent.ctx.tools.get('propose_blueprint_change', agent)!
      const purpose = blueprint.nodes.find(node => node.type === 'purpose' && node.editable)!
      const args = { intent: 'modify-existing-agent', changes: [{
        target_node_id: purpose.id, operation: 'updatePurpose', current_value: purpose.value,
        proposed_value: '只做公司基本面、行业和估值研究。', impact: '收窄研究目标。',
      }] }
      agent.session.append('turn/start', { turn: 2 })
      const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '不要给投资建议，只做公司基本面、行业和估值研究。' }] })
      agent.session.append('user/message', message, { surfaceOp: 'append' })
      const concludeTurn = vi.fn()
      const exec = { agent, callId: CallId('proposal'), concludeTurn } as unknown as Parameters<typeof tool.execute>[1]
      await expect(tool.execute(args, exec)).resolves.toMatchObject({
        kind: 'direct-request', sourceSessionId: 'guard-creator', routeId: String(message.id),
        presetId: 'kaoyan-choose', revision: blueprint.revision,
        proposals: [{ targetNodeId: purpose.id, operation: 'updatePurpose', currentValue: purpose.value }],
      })
      expect(concludeTurn).toHaveBeenCalledTimes(1)
      expect((await ctx.blueprintAdapter.read('kaoyan-choose')).revision).toBe(blueprint.revision)
      await ctx.blueprintAdapter.setConversationContext({
        sessionId: String(agent.id), creatorDraft: { name: 'Authoring Agent', status: 'creating' },
      })
      expect(agent.ctx.tools.get('propose_blueprint_change', agent)).toBeUndefined()
      await expect(tool.execute(args, { ...exec, callId: CallId('stale') })).rejects.toThrow('creator-authoring-in-progress')
      agent.session.append('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } })
      await ctx.blueprintAdapter.setConversationContext({
        sessionId: String(agent.id), presetId: blueprint.preset.id, revision: blueprint.revision,
      })
      expect(agent.ctx.tools.get('route_blueprint_capability_authoring', agent)).toBeDefined()
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([false, true])('exclusively hands off a real source turn and admits one durable Creator (sibling Tool: %s)', async (sibling) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-blueprint-handoff-'))
    for (const id of ['kaoyan-choose', 'cordis']) {
      await mkdir(join(root, id))
      await writeFile(join(root, id, 'agent.cordis.yml'), composition(), 'utf8')
    }
    const ctx = await harness(root)
    try {
      const routeResponse = toolCallResponse('route-one', 'route_blueprint_creator_authoring', {
        name: '供应商尽调 Agent', user_intent: '创建一个新的供应商尽调 Agent。',
      })
      if (sibling) {
        routeResponse.splice(routeResponse.length - 2, 0,
          { type: 'block-start', index: 1, blockType: 'tool-call' },
          { type: 'block-end', index: 1, block: { type: 'tool-call', id: CallId('late-write'), name: 'write_probe', arguments: '{}' } },
        )
      }
      const adapter = new MockAdapter([routeResponse, textResponse('Creator completed.'), textResponse('Original conversation still works.')])
      ctx.llm.registerAdapter(['mock'], adapter)
      const source = (await ctx.agents.create({
        sessionId: SessionId('handoff-source'), meta: { agentPreset: 'kaoyan-choose', cwd: root },
        agentOptions: { provider: 'mock', model: 'mock' },
        setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'kaoyan-choose'),
      })).agent
      let writes = 0
      source.ctx.tools.register(defineTool({ name: 'write_probe', description: 'Detect dispatch after handoff.', parameters: {},
        output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        execute: () => { writes += 1; return Promise.resolve(true) } }))
      const blueprint = await ctx.blueprintAdapter.read('kaoyan-choose')
      await ctx.blueprintAdapter.setConversationContext({
        sessionId: String(source.id), presetId: blueprint.preset.id, revision: blueprint.revision,
      })
      const flushed: string[] = []
      ctx.on('session/flush', (session) => { flushed.push(String(session.id)) })
      source.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '创建一个新的供应商尽调 Agent。' }] }))
      await source.whenIdle()
      expect(adapter.requests, JSON.stringify(source.session.events.filter(event => event.type === 'turn/end'))).toHaveLength(1)
      expect(writes).toBe(0)
      const prepared = source.session.events.find(event => event.type === 'blueprint/creator-authoring')!
      if (prepared.type !== 'blueprint/creator-authoring') throw new Error('missing task')
      const accepted = source.session.events.find(event => event.type === 'tool/result' && event.data.message.source.callId === 'route-one')!
      const terminal = source.session.events.find(event => event.type === 'turn/end')!
      expect(prepared.seq).toBeLessThan(accepted.seq)
      expect(accepted.seq).toBeLessThan(terminal.seq)
      expect(flushed).toContain(String(source.id))
      expect(source.session.events.filter(event => event.seq > accepted.seq && event.type === 'step/start')).toHaveLength(0)
      const laterCalls = source.session.events.filter(event => event.seq > accepted.seq && event.type === 'tool/call')
      expect(laterCalls).toHaveLength(sibling ? 1 : 0)
      if (sibling) expect(source.session.events.some(event => event.type === 'tool/result'
        && event.data.message.source.callId === 'late-write' && event.data.error?.code === TOOL_ABORTED_BEFORE_DISPATCH)).toBe(true)
      // A failed Creator allocation must leave a retryable durable request, not a locked source Session.
      await expect(ctx.blueprintAdapter.setConversationContext({
        sessionId: prepared.data.handoff!.targetCreatorSessionId, creatorAuthoring: prepared.data,
      })).rejects.toThrow('not found')
      expect(source.status).toBe('idle')
      const creator = (await ctx.agents.create({
        sessionId: SessionId(prepared.data.handoff!.targetCreatorSessionId), meta: { agentPreset: 'cordis', cwd: root },
        agentOptions: { provider: 'mock', model: 'mock' },
        setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'cordis'),
      })).agent
      const request = { sessionId: String(creator.id), creatorAuthoring: prepared.data }
      const sourceEvents = source.session.events
      const unfinished = vi.spyOn(source.session, 'events', 'get').mockReturnValue(sourceEvents.filter(event => event.type !== 'turn/end'))
      const cancellation = vi.spyOn(source, 'cancel').mockImplementation(() => { throw new Error('injected termination failure') })
      await expect(ctx.blueprintAdapter.setConversationContext(request)).rejects.toThrow('injected termination failure')
      expect(creator.session.events.some(event => event.type === 'turn/start')).toBe(false)
      expect(adapter.requests).toHaveLength(1)
      cancellation.mockRestore()
      unfinished.mockRestore()
      const idle = vi.spyOn(source, 'whenIdle').mockRejectedValueOnce(new Error('injected quiescence failure'))
      await expect(ctx.blueprintAdapter.setConversationContext(request)).rejects.toThrow('injected quiescence failure')
      expect(creator.session.events.some(event => event.type === 'turn/start')).toBe(false)
      idle.mockRestore()
      await Promise.all([ctx.blueprintAdapter.setConversationContext(request), ctx.blueprintAdapter.setConversationContext(request)])
      await creator.whenIdle()
      await ctx.blueprintAdapter.setConversationContext(request)
      expect(adapter.requests).toHaveLength(2)
      expect(creator.session.events.filter(event => event.type === 'blueprint/creator-authoring')).toHaveLength(1)
      expect(creator.session.events.filter(event => event.type === 'turn/start')).toHaveLength(1)
      expect(creator.session.events.find(event => event.type === 'blueprint/creator-authoring')?.data).toEqual(prepared.data)
      const recovered = await ctx.blueprintAdapter.setConversationContext({ sessionId: String(creator.id), recoverCreatorAuthoring: true })
      expect(recovered.creatorAuthoring?.handoff).toEqual(prepared.data.handoff)
      source.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '继续讨论，不修改。' }] }))
      await source.whenIdle()
      expect(adapter.requests).toHaveLength(3)
      expect(source.session.events.filter(event => event.type === 'turn/end')).toHaveLength(2)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('accepts wire-key order, records exact confirmed outcomes, and recovers them after later preset edits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-blueprint-receipts-'))
    const presetDir = join(root, 'kaoyan-choose')
    await mkdir(presetDir)
    await writeFile(join(presetDir, 'agent.cordis.yml'), composition(), 'utf8')
    const ctx = await harness(root)
    try {
      const handle = await ctx.agents.create({
        sessionId: SessionId('receipt-conversation'), meta: { agentPreset: 'kaoyan-choose' },
        setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'kaoyan-choose'),
      })
      const sessionId = String(handle.agent.session.id)
      let flushes = 0
      ctx.on('session/flush', () => { flushes += 1 })
      const before = await ctx.blueprintAdapter.read('kaoyan-choose')
      const request = recordDurableProposal(handle.agent, before, 'confirmed-a', [
        { operation: 'updateIdentity', targetNodeId: 'identity:persona', expected: '考研择校助手', value: '保研申请顾问' },
      ])
      const operation = request.operations[0]!
      if (operation.operation === 'setCapability') throw new Error('test requires one text operation')
      const applied = await ctx.blueprintAdapter.applyChangeSet({
        ...request,
        operations: [{
          targetNodeId: operation.targetNodeId,
          expected: operation.expected,
          value: operation.value,
          operation: operation.operation,
        }],
      })
      expect(applied.status).toBe('committed')
      expect(flushes).toBe(2)
      expect(await ctx.blueprintAdapter.applyChangeSet(request)).toEqual(applied)
      const staleRequest = recordDurableProposal(handle.agent, before, 'stale-proposal', [
        { operation: 'updatePurpose', targetNodeId: 'purpose:persona', expected: '帮助用户完成国内保研择校与申请管理。', value: '只整理公开申请资料。' },
      ])
      const failed = await ctx.blueprintAdapter.applyChangeSet(staleRequest)
      expect(failed.status).toBe('preflight_failed')
      await ctx.blueprintAdapter.updateIdentity({
        presetId: 'kaoyan-choose', nodeId: 'identity:persona', revision: applied.committedRevision!, expected: '保研申请顾问', value: '申请研究顾问',
      })
      const recovered = await ctx.blueprintAdapter.setConversationContext({ sessionId })
      const terminalSeqs = handle.agent.session.events.flatMap(event => event.type === 'blueprint/apply-result'
        ? [event.seq]
        : [])
      expect(recovered.applyReceipts).toEqual([
        expect.objectContaining({
          sourceSessionId: sessionId, routeId: request.routeId, terminalSeq: terminalSeqs[0], result: applied,
        }),
        expect.objectContaining({
          sourceSessionId: sessionId, routeId: staleRequest.routeId, terminalSeq: terminalSeqs[1], result: failed,
        }),
      ])
      await expect(ctx.blueprintAdapter.applyChangeSet({ ...request, routeId: 'foreign-route' }))
        .rejects.toThrow('owner, route')
      await expect(ctx.blueprintAdapter.applyChangeSet({ ...request, operations: [{
        operation: 'updateIdentity', targetNodeId: 'identity:persona', expected: '考研择校助手', value: '手造内容',
      }] })).rejects.toThrow('content differs')
      await expect(ctx.blueprintAdapter.applyChangeSet({ ...request, sourceSessionId: 'missing' }))
        .rejects.toThrow('source Session')
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('persists Proposal cancellation and serializes it against Apply', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-blueprint-cancel-'))
    await mkdir(join(root, 'kaoyan-choose'))
    await writeFile(join(root, 'kaoyan-choose', 'agent.cordis.yml'), composition())
    const ctx = await harness(root)
    try {
      const handle = await ctx.agents.create({
        sessionId: SessionId('cancel-conversation'), meta: { agentPreset: 'kaoyan-choose' },
        setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'kaoyan-choose'),
      })
      const before = await ctx.blueprintAdapter.read('kaoyan-choose')
      const apply = recordDurableProposal(handle.agent, before, 'cancel-me', [{
        operation: 'updateOutput', targetNodeId: 'output:5',
        expected: '输出申请进度表、风险摘要与来源。', value: '输出申请清单、风险和来源。',
      }])
      const cancelRequest = {
        sourceSessionId: apply.sourceSessionId, routeId: apply.routeId, changeSetId: apply.changeSetId,
      }
      const cancellation = await ctx.blueprintAdapter.cancelChangeSet(cancelRequest)
      expect(await ctx.blueprintAdapter.cancelChangeSet(cancelRequest)).toEqual(cancellation)
      await expect(ctx.blueprintAdapter.applyChangeSet(apply)).rejects.toThrow('already cancelled')
      expect((await ctx.blueprintAdapter.read('kaoyan-choose')).revision).toBe(before.revision)
      expect((await ctx.blueprintAdapter.setConversationContext({ sessionId: String(handle.agent.id) })).proposalCancellations)
        .toEqual([cancellation])

      const raced = recordDurableProposal(handle.agent, before, 'raced-terminal', [{
        operation: 'updateBehavior', targetNodeId: 'behavior:1',
        expected: OLD_BEHAVIORS[0]!, value: '按推免政策检查申请资格。',
      }])
      const race = await Promise.allSettled([
        ctx.blueprintAdapter.applyChangeSet(raced),
        ctx.blueprintAdapter.cancelChangeSet({
          sourceSessionId: raced.sourceSessionId, routeId: raced.routeId, changeSetId: raced.changeSetId,
        }),
      ])
      expect(race.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(race.filter(result => result.status === 'rejected')).toHaveLength(1)
      expect(handle.agent.session.events.filter(event => (event.type === 'blueprint/apply-result'
        && event.data.result.changeSetId === raced.changeSetId) || (event.type === 'blueprint/proposal-cancelled'
        && event.data.changeSetId === raced.changeSetId))).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('recovers open source-language metadata and legacy language events in the same Creator Session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-blueprint-creator-route-'))
    const presetDir = join(root, 'cordis')
    await mkdir(presetDir)
    await writeFile(join(presetDir, 'agent.cordis.yml'), composition(), 'utf8')
    const ctx = await harness(root)
    try {
      const handle = await ctx.agents.create({
        sessionId: SessionId('typed-creator-authoring'),
        meta: { agentPreset: 'cordis', cwd: root },
        setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'cordis'),
      })
      const request = {
        routeId: 'route-en-1',
        sourceSessionId: 'source-conversation',
        request: 'Create an agent that researches public AI companies.',
        name: 'Public AI Company Research Agent',
        sourceLanguage: 'ja',
      }
      const started = await ctx.blueprintAdapter.setConversationContext({
        sessionId: String(handle.agent.session.id), creatorAuthoring: request,
      })
      expect(started.creatorAuthoring).toEqual({
        operation: 'create-agent', ...request, startSeq: 0,
      })
      expect(handle.agent.session.events.some(event => event.type === 'blueprint/creator-authoring'
        && event.data.routeId === 'route-en-1' && event.data.sourceLanguage === 'ja')).toBe(true)

      const recovered = await ctx.blueprintAdapter.setConversationContext({
        sessionId: String(handle.agent.session.id), recoverCreatorAuthoring: true,
      })
      expect(recovered.creatorAuthoring).toEqual(started.creatorAuthoring)
      expect(handle.agent.session.events.filter(event => event.type === 'blueprint/creator-authoring'))
        .toHaveLength(1)

      const legacy = await ctx.agents.create({
        sessionId: SessionId('legacy-creator-authoring'),
        meta: { agentPreset: 'cordis' },
        setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'cordis'),
      })
      legacy.agent.session.append('blueprint/creator-authoring', {
        operation: 'create-agent', routeId: 'legacy-route', sourceSessionId: 'legacy-source',
        request: 'Create a market research agent.', name: 'Market Research Agent', language: 'en',
      })
      const recoveredLegacy = await ctx.blueprintAdapter.setConversationContext({
        sessionId: String(legacy.agent.session.id), recoverCreatorAuthoring: true,
      })
      expect(recoveredLegacy.creatorAuthoring).toMatchObject({
        routeId: 'legacy-route', sourceLanguage: 'en', startSeq: 0,
      })
      expect(recoveredLegacy.creatorAuthoring).not.toHaveProperty('language')
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rebuilds target-bound capability authoring from the Creator Session log', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-blueprint-authoring-recovery-'))
    for (const presetId of ['competitive-research', 'cordis', 'kaoyan-choose']) {
      const presetDir = join(root, presetId)
      await mkdir(presetDir)
      await writeFile(join(presetDir, 'agent.cordis.yml'), composition(), 'utf8')
    }
    const ctx = await harness(root)
    try {
      const sourceSessionId = 'capability-source'
      const routeId = 'capability-route'
      const handle = await ctx.agents.create({
        sessionId: SessionId(capabilityAuthoringCreatorSessionId(sourceSessionId, routeId)),
        meta: { agentPreset: 'cordis' },
        setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'cordis'),
      })
      const target = await ctx.blueprintAdapter.read('competitive-research')
      const started = await ctx.blueprintAdapter.setConversationContext({
        sessionId: String(handle.agent.session.id),
        capabilityAuthoring: recordDurableCapabilityRoute(ctx, {
          routeId, sourceSessionId, target, kind: 'skill', request: '创建 CSV 财报指标提取 Skill',
        }),
      })
      expect(started.capabilityAuthoring).toMatchObject({
        targetPresetId: 'competitive-research', kind: 'skill', startSeq: 0,
      })
      expect(started.capabilityAuthoringRecord).toMatchObject({
        targetPresetId: 'competitive-research', kind: 'skill', startSeq: 0, state: 'active',
      })
      const authoring = handle.agent.session.events.find(event => event.type === 'blueprint/capability-authoring')
      expect(authoring?.type).toBe('blueprint/capability-authoring')
      if (authoring?.type !== 'blueprint/capability-authoring') throw new Error('Expected capability authoring event')
      expect(authoring.data).toMatchObject({ state: 'started', targetPresetId: 'competitive-research' })
      expect(await candidatePresetPath(ctx, handle.agent, 'competitive-research'))
        .toContain(`.agent-preset-transaction-${authoring.data.candidate.transactionId}`)

      const staleNormalRoute = await ctx.blueprintAdapter.setConversationContext({
        sessionId: String(handle.agent.session.id),
        presetId: 'competitive-research',
        revision: target.revision,
      })
      expect(staleNormalRoute.capabilityAuthoring).toEqual(started.capabilityAuthoring)

      const recovered = await ctx.blueprintAdapter.setConversationContext({
        sessionId: String(handle.agent.session.id), recoverCapabilityAuthoring: true,
      })
      expect(recovered.capabilityAuthoring).toEqual(started.capabilityAuthoring)

      const cancelled = await ctx.blueprintAdapter.setConversationContext({
        sessionId: String(handle.agent.session.id),
        capabilityAuthoringEnd: { outcome: 'cancelled' },
      })
      const cancellationSeq = cancelled.capabilityAuthoringRecord?.endSeq
      expect(cancellationSeq).toEqual(expect.any(Number))
      expect(await ctx.blueprintAdapter.setConversationContext({
        sessionId: String(handle.agent.session.id), recoverCapabilityAuthoring: true,
      })).toEqual({
        sessionId: String(handle.agent.session.id),
        active: false,
        capabilityAuthoringRecord: {
          routeId: 'capability-route',
          sourceSessionId: 'capability-source',
          targetPresetId: 'competitive-research',
          request: '创建 CSV 财报指标提取 Skill',
          kind: 'skill', baseRevision: target.revision, baselineDelegationRowIds: [],
          startSeq: 0, state: 'ended', endSeq: cancellationSeq, outcome: 'cancelled',
        },
      })

      handle.agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: '我要一个上市公司研究 Agent' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      expect(await ctx.blueprintAdapter.setConversationContext({
        sessionId: String(handle.agent.session.id), recoverCapabilityAuthoring: true,
      })).toMatchObject({
        sessionId: String(handle.agent.session.id), active: false,
        capabilityAuthoringRecord: {
          routeId: 'capability-route', sourceSessionId: 'capability-source',
          startSeq: 0, state: 'ended', endSeq: cancellationSeq, outcome: 'cancelled',
        },
      })
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('recovers an already-durable background Creator candidate through the legacy reader only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-blueprint-legacy-candidate-recovery-'))
    for (const presetId of ['cordis', 'kaoyan-choose']) {
      const presetDir = join(root, presetId)
      await mkdir(presetDir)
      await writeFile(join(presetDir, 'agent.cordis.yml'), composition(), 'utf8')
    }
    const ctx = await harness(root)
    try {
      const seed = await ctx.agents.create({
        sessionId: SessionId('legacy-candidate-seed'),
        meta: { agentPreset: 'cordis' },
        setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'cordis'),
      })
      const target = await ctx.blueprintAdapter.read('kaoyan-choose')
      await ctx.blueprintAdapter.setConversationContext({
        sessionId: String(seed.agent.id),
        capabilityAuthoring: recordDurableCapabilityRoute(ctx, {
          routeId: 'generic-seed-route',
          sourceSessionId: String(seed.agent.id),
          target,
          kind: 'skill',
          request: 'seed lifecycle metadata',
        }),
      })
      const seedStart = seed.agent.session.events.find(event => event.type === 'blueprint/capability-authoring'
        && event.data.state === 'started')
      if (seedStart?.type !== 'blueprint/capability-authoring' || seedStart.data.state !== 'started') {
        throw new Error('Expected generic seed capability lifecycle')
      }
      await ctx.blueprintAdapter.setConversationContext({
        sessionId: String(seed.agent.id),
        capabilityAuthoringEnd: { outcome: 'cancelled' },
      })

      const legacySourceSessionId = 'legacy-capability-source'
      const legacyRouteId = 'legacy-capability-route'
      const legacy = await ctx.agents.create({
        sessionId: SessionId(capabilityAuthoringCreatorSessionId(legacySourceSessionId, legacyRouteId)),
        meta: { agentPreset: 'cordis' },
        setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'cordis'),
      })
      const formal = await ctx.agentPresets.resolve('kaoyan-choose')
      const candidate = await prepareCapabilityCandidate(formal, {
        creatorSessionId: String(legacy.agent.id),
        sourceSessionId: legacySourceSessionId,
        routeId: legacyRouteId,
        targetPresetId: 'kaoyan-choose',
        baseRevision: target.revision,
      })
      legacy.agent.session.append('blueprint/capability-authoring', {
        ...seedStart.data,
        routeId: legacyRouteId,
        sourceSessionId: legacySourceSessionId,
        request: 'resume an existing legacy candidate',
        candidate,
      })

      const recovered = await ctx.blueprintAdapter.setConversationContext({
        sessionId: String(legacy.agent.id),
        recoverCapabilityAuthoring: true,
      })
      expect(recovered.capabilityAuthoringRecord).toMatchObject({
        routeId: legacyRouteId, state: 'active', targetPresetId: 'kaoyan-choose',
      })
      expect((await resolveCapabilityCandidatePreset(formal, candidate)).path)
        .toContain(`.blueprint-capability-${candidate.transactionId}`)
      await ctx.blueprintAdapter.setConversationContext({
        sessionId: String(legacy.agent.id),
        capabilityAuthoringEnd: { outcome: 'cancelled' },
      })
      await expect(resolveCapabilityCandidatePreset(formal, candidate)).rejects.toThrow()
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('admits capability continuation only from exact durable source authority into one clean cordis child', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-blueprint-authoring-authority-'))
    for (const presetId of ['cordis', 'kaoyan-choose']) {
      const presetDir = join(root, presetId)
      await mkdir(presetDir)
      await writeFile(join(presetDir, 'agent.cordis.yml'), composition(), 'utf8')
    }
    const ctx = await harness(root)
    const createChild = async (sessionId: string, presetId = 'cordis') => (await ctx.agents.create({
      sessionId: SessionId(sessionId), meta: { agentPreset: presetId, cwd: root },
      setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, presetId),
    })).agent
    const contextNames = async (agent: import('@deepseek-ai/dsh-agent').Agent) => (
      await ctx.systemPrompt.assemble(assembleContextFor(agent))
    ).contexts.map(context => context.name)
    const expectNoAdoption = async (
      agent: import('@deepseek-ai/dsh-agent').Agent,
      request: NonNullable<import('../src/contract/types.ts').BlueprintConversationContextRequest['capabilityAuthoring']>,
    ) => {
      const before = await contextNames(agent)
      await expect(ctx.blueprintAdapter.setConversationContext({
        sessionId: String(agent.id), capabilityAuthoring: request,
      })).rejects.toThrow()
      expect(await contextNames(agent)).toEqual(before)
      expect(agent.session.events.filter(event => event.type === 'blueprint/capability-authoring')).toEqual([])
    }
    try {
      const target = await ctx.blueprintAdapter.read('kaoyan-choose', { cwd: root })

      const missing = {
        routeId: 'missing-route', sourceSessionId: 'missing-source', targetPresetId: target.preset.id,
        request: '新增 CSV Skill', kind: 'skill' as const, baseRevision: target.revision,
      }
      await expectNoAdoption(
        await createChild(capabilityAuthoringCreatorSessionId(missing.sourceSessionId, missing.routeId)), missing,
      )

      for (const fixture of [
        { sourceSessionId: 'failed-source', routeId: 'failed-route', resultIsError: true },
        { sourceSessionId: 'missing-call-source', routeId: 'missing-call-route', omitCall: true },
        { sourceSessionId: 'missing-decision-source', routeId: 'missing-decision-route', omitDecision: true },
        {
          sourceSessionId: 'foreign-result-source', routeId: 'foreign-result-route',
          routeOverrides: { sourceSessionId: 'foreign-owner' },
        },
      ] as const) {
        const request = recordDurableCapabilityRoute(ctx, {
          ...fixture, target, request: '新增 CSV Skill', kind: 'skill',
        })
        const child = await createChild(capabilityAuthoringCreatorSessionId(request.sourceSessionId, request.routeId))
        await expectNoAdoption(child, request)
      }

      const wrongIdRequest = recordDurableCapabilityRoute(ctx, {
        sourceSessionId: 'wrong-id-source', routeId: 'wrong-id-route', target,
        request: '新增 CSV Skill', kind: 'skill',
      })
      const wrongId = await createChild('forged-capability-child')
      await ctx.blueprintAdapter.setConversationContext({
        sessionId: String(wrongId.id), presetId: target.preset.id, revision: target.revision,
      })
      expect(await contextNames(wrongId)).toContain(BLUEPRINT_CONVERSATION_SECTION)
      await expectNoAdoption(wrongId, wrongIdRequest)

      const wrongPresetRequest = recordDurableCapabilityRoute(ctx, {
        sourceSessionId: 'wrong-preset-source', routeId: 'wrong-preset-route', target,
        request: '新增 CSV Skill', kind: 'skill',
      })
      await expectNoAdoption(
        await createChild(
          capabilityAuthoringCreatorSessionId(wrongPresetRequest.sourceSessionId, wrongPresetRequest.routeId),
          'kaoyan-choose',
        ),
        wrongPresetRequest,
      )

      const contaminatedRequest = recordDurableCapabilityRoute(ctx, {
        sourceSessionId: 'contaminated-source', routeId: 'contaminated-route', target,
        request: '新增 CSV Skill', kind: 'skill',
      })
      const contaminated = await createChild(capabilityAuthoringCreatorSessionId(
        contaminatedRequest.sourceSessionId, contaminatedRequest.routeId,
      ))
      contaminated.session.append('turn/start', { turn: 1 })
      contaminated.session.append('user/message', createUserMessage({
        source: { kind: 'user' }, content: [{ type: 'text', text: 'Unrelated prior child history.' }],
      }), { surfaceOp: 'append' })
      await expectNoAdoption(contaminated, contaminatedRequest)

      const duplicateInitializationRequest = recordDurableCapabilityRoute(ctx, {
        sourceSessionId: 'duplicate-initialization-source', routeId: 'duplicate-initialization-route', target,
        request: '新增 CSV Skill', kind: 'skill',
      })
      const duplicateInitialization = await createChild(capabilityAuthoringCreatorSessionId(
        duplicateInitializationRequest.sourceSessionId,
        duplicateInitializationRequest.routeId,
      ))
      duplicateInitialization.session.append('permission/preset', { preset: 'workspace-write' })
      duplicateInitialization.session.append('permission/preset', { preset: 'workspace-write' })
      await expectNoAdoption(duplicateInitialization, duplicateInitializationRequest)

      const exact = recordDurableCapabilityRoute(ctx, {
        sourceSessionId: 'exact-source', routeId: 'exact-route', target,
        request: '新增 CSV Skill', kind: 'skill',
      })
      const exactChild = await createChild(capabilityAuthoringCreatorSessionId(exact.sourceSessionId, exact.routeId))
      exactChild.session.append('permission/preset', { preset: 'workspace-write' })
      exactChild.session.append('sandbox/mode', { mode: 'workspace-write' })
      exactChild.session.append('approval/policy', { policy: 'ask' })
      for (const mutation of [
        { ...exact, targetPresetId: 'cordis' },
        { ...exact, baseRevision: '0'.repeat(64) },
        { ...exact, request: '改写后的浏览器请求' },
        { ...exact, kind: 'subagent' as const },
      ]) {
        await expectNoAdoption(exactChild, mutation)
      }

      const started = await ctx.blueprintAdapter.setConversationContext({
        sessionId: String(exactChild.id), capabilityAuthoring: exact,
      })
      expect(started.capabilityAuthoringRecord).toMatchObject({
        routeId: exact.routeId, sourceSessionId: exact.sourceSessionId, state: 'active',
      })
      expect(await contextNames(exactChild)).toContain(BLUEPRINT_CONVERSATION_SECTION)
      const retried = await ctx.blueprintAdapter.setConversationContext({
        sessionId: String(exactChild.id), capabilityAuthoring: exact,
      })
      expect(retried.capabilityAuthoring).toEqual(started.capabilityAuthoring)
      expect(exactChild.session.events.filter(event => event.type === 'blueprint/capability-authoring'
        && event.data.state === 'started')).toHaveLength(1)

      await ctx.blueprintAdapter.setConversationContext({
        sessionId: String(exactChild.id), capabilityAuthoringEnd: { outcome: 'cancelled' },
      })
      await expect(ctx.blueprintAdapter.setConversationContext({
        sessionId: String(exactChild.id), capabilityAuthoring: exact,
      })).rejects.toThrow('already adopted and settled')
      expect(exactChild.session.events.filter(event => event.type === 'blueprint/capability-authoring'
        && event.data.state === 'started')).toHaveLength(1)
      expect(await contextNames(exactChild)).not.toContain(BLUEPRINT_CONVERSATION_SECTION)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps consecutive capability routes in one cordis source with internal lifecycle-scoped wakes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-blueprint-same-source-routes-'))
    for (const presetId of ['cordis', 'kaoyan-choose']) {
      await mkdir(join(root, presetId))
      await writeFile(join(root, presetId, 'agent.cordis.yml'), composition(), 'utf8')
    }
    const ctx = await harness(root)
    try {
      const sourceSessionId = 'same-source-capability-authoring'
      const { agent } = await ctx.agents.create({
        sessionId: SessionId(sourceSessionId),
        meta: { agentPreset: 'cordis', cwd: root },
        setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'cordis'),
      })

      for (const routeId of ['same-source-route-1', 'same-source-route-2']) {
        const target = await ctx.blueprintAdapter.read('kaoyan-choose', { cwd: root })
        const started = await ctx.blueprintAdapter.setConversationContext({
          sessionId: sourceSessionId,
          capabilityAuthoring: recordDurableCapabilityRoute(ctx, {
            sourceSessionId, routeId, target, request: `新增 ${routeId} Skill`, kind: 'skill',
          }),
        })
        expect(started.capabilityAuthoringRecord).toMatchObject({ routeId, state: 'active' })
        expect(agent.session.events.filter(event => event.type === 'turn/end')).toHaveLength(
          routeId.endsWith('1') ? 1 : 2,
        )
        expect(agent.session.events.filter(event => event.type === 'blueprint/capability-authoring'
          && event.data.state === 'ended')).toHaveLength(routeId.endsWith('1') ? 0 : 1)
        expect(agent.inbox.nextTurn).toHaveLength(1)
        expect(agent.inbox.nextTurn[0]?.source).toEqual({
          kind: 'blueprint-capability-authoring', routeId,
          startSeq: started.capabilityAuthoringRecord?.startSeq,
          presentation: 'internal',
        })

        const cancelled = await ctx.blueprintAdapter.setConversationContext({
          sessionId: sourceSessionId, capabilityAuthoringEnd: { outcome: 'cancelled' },
        })
        expect(cancelled.capabilityAuthoringRecord).toMatchObject({ routeId, state: 'ended', outcome: 'cancelled' })
        expect(agent.inbox.nextTurn).toEqual([])
      }

      expect(agent.session.events.flatMap(event => event.type === 'blueprint/capability-authoring'
        && event.data.state === 'started' ? [event.data.routeId] : [])).toEqual([
        'same-source-route-1', 'same-source-route-2',
      ])
      expect(agent.session.events.flatMap(event => event.type === 'blueprint/capability-authoring'
        && event.data.state === 'ended' ? [event.data.routeId] : [])).toEqual([
        'same-source-route-1', 'same-source-route-2',
      ])
      expect(ctx.agents.get(SessionId(capabilityAuthoringCreatorSessionId(
        sourceSessionId, 'same-source-route-1',
      )))).toBeUndefined()
      expect(ctx.agents.get(SessionId(capabilityAuthoringCreatorSessionId(
        sourceSessionId, 'same-source-route-2',
      )))).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('retires settled same-source authoring history and fail-closes the next capability routing turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-blueprint-same-source-history-'))
    for (const presetId of ['cordis', 'kaoyan-choose']) {
      await mkdir(join(root, presetId))
      await writeFile(join(root, presetId, 'agent.cordis.yml'), composition(), 'utf8')
    }
    const ctx = await harness(root, 0)
    const sourceSessionId = 'same-source-history'
    const firstRouteId = 'same-source-history-route-1'
    const secondRouteId = 'same-source-history-route-2'
    const firstRequest = '增加一个 JSON 参数归一化 Skill。'
    const secondRequest = '增加一个 CSV 参数对比 Skill。'
    const internalMarker = 'INTERNAL_AUTHORING_IMPLEMENTATION_MARKER'
    try {
      for (const name of ['read', 'write', 'edit', 'preset_resolve', 'preset_validate']) {
        ctx.tools.register(defineTool({
          name,
          description: `Inherited ${name} probe.`,
          parameters: {},
          output: { schema: { type: 'json' }, render: () => [] },
          execute: () => Promise.resolve(true),
        }))
      }
      const adapter = new MockAdapter([
        toolCallResponse('same-source-route-call-1', 'route_blueprint_capability_authoring', {
          request: firstRequest, kind: 'skill', reason: 'Requires a reusable Skill definition.',
        }),
        textResponse(internalMarker),
        toolCallResponse('same-source-route-call-2', 'route_blueprint_capability_authoring', {
          request: secondRequest, kind: 'skill', reason: 'Requires a reusable Skill definition.',
        }),
      ])
      ctx.llm.registerAdapter(['mock'], adapter)
      const { agent } = await ctx.agents.create({
        sessionId: SessionId(sourceSessionId),
        meta: { agentPreset: 'cordis', cwd: root },
        agentOptions: { provider: 'mock', model: 'mock' },
        setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'cordis'),
      })
      const baselineText = await readFile(join(root, 'kaoyan-choose', 'agent.cordis.yml'), 'utf8')
      const baseline = await ctx.blueprintAdapter.read('kaoyan-choose', { cwd: root })

      await ctx.blueprintAdapter.setConversationContext({
        sessionId: sourceSessionId, presetId: baseline.preset.id, revision: baseline.revision,
        capabilityInput: { routeId: firstRouteId, userRequest: firstRequest },
      })
      await agent.whenIdle()
      expect(agent.session.events.filter(event => event.type === 'blueprint/capability-authoring')).toEqual([])
      expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining([
        BLUEPRINT_CAPABILITY_AUTHORING_TOOL, BLUEPRINT_PROPOSAL_TOOL,
        'read', 'write', 'edit', 'preset_resolve', 'preset_validate',
      ]))

      await ctx.blueprintAdapter.setConversationContext({
        sessionId: sourceSessionId,
        capabilityAuthoring: {
          routeId: firstRouteId, sourceSessionId, targetPresetId: baseline.preset.id,
          request: firstRequest, kind: 'skill', baseRevision: baseline.revision,
        },
      })
      await agent.whenIdle()
      await vi.waitFor(() => {
        expect(agent.session.events.filter(event => event.type === 'blueprint/capability-authoring'
          && event.data.state === 'ended')).toHaveLength(1)
      })
      expect(adapter.requests[1]?.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining([
        'read', 'write', 'edit', 'preset_resolve', 'preset_validate',
      ]))
      expect(JSON.stringify(agent.session.events)).toContain(internalMarker)
      expect(JSON.stringify(agent.session.deriveMessages())).not.toContain(internalMarker)
      expect(JSON.stringify(agent.session.deriveMessages())).toContain('A prior internal capability-configuration turn is closed.')
      expect(await readFile(join(root, 'kaoyan-choose', 'agent.cordis.yml'), 'utf8')).toBe(baselineText)

      await Promise.all([1, 2].map(() => ctx.blueprintAdapter.setConversationContext({
        sessionId: sourceSessionId, recoverCapabilityAuthoring: true,
      })))
      expect(agent.session.events.filter(event => event.type === 'user/message'
        && event.data.source.kind === 'blueprint-capability-terminal')).toHaveLength(1)

      await ctx.blueprintAdapter.setConversationContext({
        sessionId: sourceSessionId, presetId: baseline.preset.id, revision: baseline.revision,
        capabilityInput: { routeId: secondRouteId, userRequest: secondRequest },
      })
      await agent.whenIdle()
      expect(adapter.requests).toHaveLength(3)
      expect(JSON.stringify(adapter.requests[2]?.messages)).not.toContain(internalMarker)
      expect(JSON.stringify(adapter.requests[2]?.messages)).toContain(secondRequest)
      expect(adapter.requests[2]?.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining([
        BLUEPRINT_CAPABILITY_AUTHORING_TOOL, BLUEPRINT_PROPOSAL_TOOL,
        'read', 'write', 'edit', 'preset_resolve', 'preset_validate',
      ]))
      expect(agent.session.events.filter(event => event.type === 'blueprint/route-decision')
        .map(event => event.data.routeId)).toEqual([firstRouteId, secondRouteId])
      expect(ctx.agents.get(SessionId(capabilityAuthoringCreatorSessionId(
        sourceSessionId, firstRouteId,
      )))).toBeUndefined()
      expect(await readFile(join(root, 'kaoyan-choose', 'agent.cordis.yml'), 'utf8')).toBe(baselineText)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('guards only the claimed Add capability routing turn across a context refresh', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-blueprint-routing-turn-guard-'))
    for (const presetId of ['cordis', 'kaoyan-choose']) {
      await mkdir(join(root, presetId))
      await writeFile(join(root, presetId, 'agent.cordis.yml'), composition(), 'utf8')
    }
    const ctx = await harness(root)
    try {
      const sourceSessionId = 'routing-turn-guard-source'
      const { agent } = await ctx.agents.create({
        sessionId: SessionId(sourceSessionId),
        meta: { agentPreset: 'cordis', cwd: root },
        setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'cordis'),
      })
      holdCapabilityFollowups(agent)
      let writes = 0
      ctx.tools.register(defineTool({
        name: 'write_probe', description: 'Detect routing-turn construction writes.', parameters: {},
        output: { schema: { type: 'json' }, render: () => [] },
        execute: () => { writes += 1; return Promise.resolve(true) },
      }))
      const executeWrite = (callId: string) => ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId(callId), name: 'write_probe', arguments: {}, agent,
      })
      const target = await ctx.blueprintAdapter.read('kaoyan-choose', { cwd: root })

      agent.session.append('turn/start', { turn: 1 })
      await ctx.blueprintAdapter.setConversationContext({
        sessionId: sourceSessionId, presetId: target.preset.id, revision: target.revision,
        capabilityInput: { routeId: 'routing-turn-guard-route', userRequest: '增加 CSV Skill。' },
      })
      expect((await executeWrite('unrelated-turn-write')).isError).toBe(false)
      expect(writes).toBe(1)
      agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

      agent.session.append('turn/start', { turn: 2 })
      const [routingMessage] = agent.inbox.claim('next-turn', 2)
      if (routingMessage === undefined) throw new Error('Missing queued Add capability input')
      agent.session.append('step/start', { turn: 2, step: 1 })
      agent.session.append('user/message', routingMessage, { surfaceOp: 'append' })
      expect((await executeWrite('claimed-route-write')).isError).toBe(true)
      expect(writes).toBe(1)

      await ctx.blueprintAdapter.setConversationContext({
        sessionId: sourceSessionId, presetId: target.preset.id, revision: target.revision,
      })
      expect((await executeWrite('refreshed-route-write')).isError).toBe(true)
      expect(writes).toBe(1)
      agent.session.append('step/end', { turn: 2, step: 1 })
      agent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

      expect((await executeWrite('settled-route-write')).isError).toBe(false)
      expect(writes).toBe(2)
      expect(agent.session.events.filter(event => event.type === 'blueprint/capability-authoring')).toEqual([])
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps an in-flight source route executable while another Session takes foreground context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-blueprint-routing-session-switch-'))
    for (const presetId of ['cordis', 'kaoyan-choose']) {
      await mkdir(join(root, presetId))
      await writeFile(join(root, presetId, 'agent.cordis.yml'), composition(), 'utf8')
    }
    const ctx = await harness(root)
    try {
      const sourceSessionId = 'routing-switch-source'
      const foregroundSessionId = 'routing-switch-foreground'
      const { agent: source } = await ctx.agents.create({
        sessionId: SessionId(sourceSessionId),
        meta: { agentPreset: 'cordis', cwd: root },
        setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'cordis'),
      })
      const { agent: foreground } = await ctx.agents.create({
        sessionId: SessionId(foregroundSessionId),
        meta: { agentPreset: 'cordis', cwd: root },
        setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'cordis'),
      })
      holdCapabilityFollowups(source)
      const target = await ctx.blueprintAdapter.read('kaoyan-choose', { cwd: root })
      const routeId = 'routing-switch-route'
      const request = '增加一个证据核验 Subagent。'
      await ctx.blueprintAdapter.setConversationContext({
        sessionId: sourceSessionId,
        presetId: target.preset.id,
        revision: target.revision,
        capabilityInput: { routeId, userRequest: request },
      })
      source.session.append('turn/start', { turn: 1 })
      const [routingMessage] = source.inbox.claim('next-turn', 1)
      if (routingMessage === undefined) throw new Error('Missing queued Add Subagent input')
      source.session.append('step/start', { turn: 1, step: 1 })
      source.session.append('user/message', routingMessage, { surfaceOp: 'append' })

      expect(await ctx.blueprintAdapter.setConversationContext({ sessionId: sourceSessionId })).toMatchObject({
        sessionId: sourceSessionId,
        active: true,
        presetId: target.preset.id,
      })
      await ctx.blueprintAdapter.setConversationContext({
        sessionId: foregroundSessionId,
        presetId: target.preset.id,
        revision: target.revision,
      })
      expect(source.ctx.tools.get(BLUEPRINT_CAPABILITY_AUTHORING_TOOL, source)).toBeDefined()
      expect(foreground.ctx.tools.get(BLUEPRINT_CAPABILITY_AUTHORING_TOOL, foreground)).toBeDefined()

      const routed = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId('routing-switch-call'),
        name: BLUEPRINT_CAPABILITY_AUTHORING_TOOL,
        arguments: {
          request,
          kind: 'subagent',
          reason: 'The requested evidence review requires a dedicated collaborator.',
        },
        agent: source,
      })
      expect(routed).toMatchObject({
        isError: false,
        value: {
          routeId,
          sourceSessionId,
          presetId: target.preset.id,
          revision: target.revision,
          request,
          kind: 'subagent',
        },
      })
      expect(source.session.events.filter(event => event.type === 'blueprint/route-decision')).toHaveLength(1)
      expect(foreground.session.events.filter(event => event.type === 'blueprint/route-decision')).toEqual([])

      source.session.append('step/end', { turn: 1, step: 1 })
      source.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await vi.waitFor(() => {
        expect(source.ctx.tools.get(BLUEPRINT_CAPABILITY_AUTHORING_TOOL, source)).toBeUndefined()
      })
      expect(foreground.ctx.tools.get(BLUEPRINT_CAPABILITY_AUTHORING_TOOL, foreground)).toBeDefined()
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('anchors terminal replacement after an authoring pre-step rewrites older model history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-blueprint-authoring-history-anchor-'))
    for (const presetId of ['cordis', 'kaoyan-choose']) {
      await mkdir(join(root, presetId))
      await writeFile(join(root, presetId, 'agent.cordis.yml'), composition(), 'utf8')
    }
    const ctx = await harness(root, 0)
    const sourceSessionId = 'same-source-history-anchor'
    const routeId = 'same-source-history-anchor-route'
    const internalMarker = 'INTERNAL_TURN_MUST_BE_RETIRED'
    const retainedMarker = 'OLDER_VISIBLE_HISTORY_MUST_REMAIN'
    try {
      const { agent } = await ctx.agents.create({
        sessionId: SessionId(sourceSessionId),
        meta: { agentPreset: 'cordis', cwd: root },
        setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'cordis'),
      })
      const baselineText = await readFile(join(root, 'kaoyan-choose', 'agent.cordis.yml'), 'utf8')
      const target = await ctx.blueprintAdapter.read('kaoyan-choose', { cwd: root })
      const authoring = recordDurableCapabilityRoute(ctx, {
        sourceSessionId, routeId, target, request: '增加一个 CSV Skill。', kind: 'skill',
      })
      await ctx.blueprintAdapter.setConversationContext({ sessionId: sourceSessionId, capabilityAuthoring: authoring })

      agent.session.append('turn/start', { turn: 2 })
      const [wake] = agent.inbox.claim('next-turn', 2)
      if (wake === undefined) throw new Error('Missing same-source capability wake')
      const oldNodes = [...agent.session.surface.nodes]
      const oldStart = oldNodes[0]
      const oldEnd = oldNodes.at(-1)
      if (oldStart === undefined || oldEnd === undefined) throw new Error('Missing older routing surface')
      agent.session.append('user/message', createUserMessage({
        source: { kind: 'plugin', plugin: 'history-anchor-test' },
        content: [{ type: 'text', text: retainedMarker }],
      }), {
        surfaceOp: { op: 'replace', start: oldStart, end: oldEnd },
        sourceEventSeqs: oldNodes,
      })
      agent.session.append('step/start', { turn: 2, step: 1 })
      agent.session.append('user/message', wake, { surfaceOp: 'append' })
      agent.session.append('assistant/message', {
        turn: 2,
        step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text: internalMarker }],
          source: { provider: 'mock', model: 'mock' },
        }),
      }, { surfaceOp: 'append' })
      agent.session.append('step/end', { turn: 2, step: 1 })
      agent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

      await vi.waitFor(() => {
        expect(agent.session.events.filter(event => event.type === 'blueprint/capability-authoring'
          && event.data.state === 'ended')).toHaveLength(1)
      })
      const derived = JSON.stringify(agent.session.deriveMessages())
      expect(derived).toContain(retainedMarker)
      expect(derived).not.toContain(internalMarker)
      expect(derived).toContain('A prior internal capability-configuration turn is closed.')
      expect(JSON.stringify(agent.session.events)).toContain(internalMarker)
      expect(await readFile(join(root, 'kaoyan-choose', 'agent.cordis.yml'), 'utf8')).toBe(baselineText)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('replays one same-source terminal replacement after a clean Host restart without duplicating it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-blueprint-authoring-surface-restart-'))
    const persistenceRoot = await mkdtemp(join(tmpdir(), 'dsh-blueprint-authoring-surface-restart-sessions-'))
    for (const presetId of ['cordis', 'kaoyan-choose']) {
      await mkdir(join(root, presetId))
      await writeFile(join(root, presetId, 'agent.cordis.yml'), composition(), 'utf8')
    }
    const sourceSessionId = 'same-source-surface-restart'
    const routeId = 'same-source-surface-restart-route'
    const internalMarker = 'INTERNAL_SURFACE_RESTART_MARKER'
    const first = await harness(root, 0, persistenceRoot)
    let firstDisposed = false
    let second: Context | undefined
    try {
      const handle = await first.agents.create({
        sessionId: SessionId(sourceSessionId),
        meta: { agentPreset: 'cordis', cwd: root },
        setup: async agentCtx => void await first.agentPresets.mount(agentCtx, 'cordis'),
      })
      const { agent } = handle
      const target = await first.blueprintAdapter.read('kaoyan-choose', { cwd: root })
      await first.blueprintAdapter.setConversationContext({
        sessionId: sourceSessionId,
        capabilityAuthoring: recordDurableCapabilityRoute(first, {
          sourceSessionId, routeId, target, request: '增加 CSV Skill。', kind: 'skill',
        }),
      })
      agent.session.append('turn/start', { turn: 2 })
      const [wake] = agent.inbox.claim('next-turn', 2)
      if (wake === undefined) throw new Error('Missing persisted same-source wake')
      agent.session.append('step/start', { turn: 2, step: 1 })
      agent.session.append('user/message', wake, { surfaceOp: 'append' })
      agent.session.append('assistant/message', {
        turn: 2, step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text: internalMarker }],
          source: { provider: 'mock', model: 'mock' },
        }),
      }, { surfaceOp: 'append' })
      agent.session.append('step/end', { turn: 2, step: 1 })
      agent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
      await vi.waitFor(() => {
        expect(agent.session.events.filter(event => event.type === 'blueprint/capability-authoring'
          && event.data.state === 'ended')).toHaveLength(1)
      })
      await first.sessions.flush(agent.session)
      const beforeRestart = agent.session.deriveMessages()
      expect(JSON.stringify(beforeRestart)).not.toContain(internalMarker)
      expect(agent.session.events.filter(event => event.type === 'user/message'
        && event.data.source.kind === 'blueprint-capability-terminal')).toHaveLength(1)

      await handle.dispose()
      await first.fiber.dispose()
      firstDisposed = true

      second = await harness(root, 0, persistenceRoot)
      const resumed = (await second.agents.resume({
        resumeSessionId: SessionId(sourceSessionId),
        setup: async agentCtx => void await second!.agentPresets.mount(agentCtx, 'cordis'),
      })).agent
      expect(resumed.session.deriveMessages()).toEqual(beforeRestart)
      expect(JSON.stringify(resumed.session.deriveMessages())).not.toContain(internalMarker)
      await Promise.all([1, 2].map(() => second!.blueprintAdapter.setConversationContext({
        sessionId: sourceSessionId, recoverCapabilityAuthoring: true,
      })))
      expect(resumed.session.events.filter(event => event.type === 'user/message'
        && event.data.source.kind === 'blueprint-capability-terminal')).toHaveLength(1)
    } finally {
      await second?.fiber.dispose()
      if (!firstDisposed) await first.fiber.dispose()
      await rm(root, { recursive: true, force: true })
      await rm(persistenceRoot, { recursive: true, force: true })
    }
  })

  it.each([
    {
      label: 'Skill', kind: 'skill' as const, request: '增加 CSV 财报 Skill', publishedNodeId: 'capability:skill:csv-metrics',
    },
    {
      label: 'Subagent', kind: 'subagent' as const, request: '增加行业研究 Subagent',
      publishedNodeId: 'capability:delegation:industry-research',
    },
  ])('repairs one isolated $label candidate in its source Session before publishing it', async (lane) => {
    const root = await mkdtemp(join(tmpdir(), `dsh-blueprint-${lane.kind}-repair-`))
    for (const presetId of ['cordis', 'kaoyan-choose']) {
      await mkdir(join(root, presetId))
      await writeFile(join(root, presetId, 'agent.cordis.yml'), composition(), 'utf8')
    }
    const ctx = await harness(root, 1)
    const sourceSessionId = `${lane.kind}-repair-source`
    const routeId = `${lane.kind}-repair-route`
    try {
      if (lane.kind === 'subagent') {
        await ctx.plugin(Spawn, { providerName: 'spawn' })
      }
      const { agent } = await ctx.agents.create({
        sessionId: SessionId(sourceSessionId),
        meta: { agentPreset: 'cordis', cwd: root },
        setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'cordis'),
      })
      const formalComposition = await readFile(join(root, 'kaoyan-choose', 'agent.cordis.yml'), 'utf8')
      const baseline = await ctx.blueprintAdapter.read('kaoyan-choose', { cwd: root })
      const started = await ctx.blueprintAdapter.setConversationContext({
        sessionId: String(agent.id),
        capabilityAuthoring: recordDurableCapabilityRoute(ctx, {
          routeId, sourceSessionId, target: baseline, kind: lane.kind, request: lane.request,
        }),
      })
      expect(started.capabilityAuthoringRecord).toMatchObject({ state: 'active' })
      expect(typeof started.capabilityAuthoringRecord?.startSeq).toBe('number')
      const candidatePath = await candidatePresetPath(ctx, agent, 'kaoyan-choose')
      const candidateRoot = dirname(candidatePath)
      expect(candidatePath).not.toBe(join(root, 'kaoyan-choose', 'agent.cordis.yml'))
      if (lane.kind === 'skill') {
        const skillRoot = join(candidateRoot, 'skills', 'csv-metrics')
        await mkdir(skillRoot, { recursive: true })
        await writeFile(join(skillRoot, 'SKILL.md'), filesystemSkillDefinition('csv-metrics'))
      }
      await writeFile(candidatePath, composition())

      agent.session.append('turn/start', { turn: 2 })
      const [initialWake] = agent.inbox.claim('next-turn', 2)
      expect(initialWake?.source).toEqual({
        kind: 'blueprint-capability-authoring', routeId,
        startSeq: started.capabilityAuthoringRecord?.startSeq,
        presentation: 'internal',
      })
      if (initialWake === undefined) throw new Error(`Missing initial ${lane.label} authoring wake`)
      const initialMarker = `INTERNAL_${lane.kind.toUpperCase()}_INITIAL_AUTHORING`
      agent.session.append('step/start', { turn: 2, step: 1 })
      agent.session.append('user/message', initialWake, { surfaceOp: 'append' })
      agent.session.append('assistant/message', {
        turn: 2, step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text: initialMarker }],
          source: { provider: 'mock', model: 'mock' },
        }),
      }, { surfaceOp: 'append' })
      agent.session.append('step/end', { turn: 2, step: 1 })
      agent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
      await vi.waitFor(() => {
        expect(agent.session.events.filter(event => event.type === 'blueprint/capability-repair')).toHaveLength(1)
        expect(agent.inbox.nextTurn.some(message => message.source.kind === 'blueprint-capability-repair')).toBe(true)
      })

      const repair = agent.session.events.find(event => event.type === 'blueprint/capability-repair')
      if (repair?.type !== 'blueprint/capability-repair') throw new Error(`Missing first ${lane.label} repair checkpoint`)
      expect(repair.data).toMatchObject({
        routeId, startSeq: started.capabilityAuthoring?.startSeq,
        attempt: 1, prerequisite: 'candidate_delta',
      })
      expect(repair.data.candidateTreeDigest).toMatch(/^[0-9a-f]{64}$/u)
      expect(agent.session.events.filter(event => event.type === 'blueprint/capability-authoring'
        && event.data.state === 'ended')).toEqual([])
      expect(await readFile(join(root, 'kaoyan-choose', 'agent.cordis.yml'), 'utf8')).toBe(formalComposition)
      const duringRepair = await ctx.blueprintAdapter.read('kaoyan-choose', { cwd: root })
      expect(duringRepair.revision).toBe(baseline.revision)
      expect(duringRepair.nodes.some(node => node.id === 'capability:skill:csv-metrics')).toBe(false)

      const recoverRequest = { sessionId: String(agent.id), recoverCapabilityAuthoring: true as const }
      const recovered = await Promise.all([1, 2, 3].map(() => (
        ctx.blueprintAdapter.setConversationContext(recoverRequest)
      )))
      expect(recovered.every(result => result.capabilityAuthoringRecord?.state === 'active')).toBe(true)
      const repairInsertions = agent.session.events.filter(event => event.type === 'agent/inbox/spliced'
        && event.data.inserted.some(message => message.id === repair.data.repairMessageId))
      expect(repairInsertions).toHaveLength(1)
      expect(await candidatePresetPath(ctx, agent, 'kaoyan-choose')).toBe(candidatePath)

      await writeFile(candidatePath, lane.kind === 'skill'
        ? `${composition()}${filesystemSkillCompositionRows()}`
        : `${composition()}${delegationCompositionRow('industry-research', 'industry_research')}`)
      agent.session.append('turn/start', { turn: 3 })
      const [repairWake] = agent.inbox.claim('next-turn', 3)
      expect(repairWake).toMatchObject({
        id: repair.data.repairMessageId,
        source: {
          kind: 'blueprint-capability-repair', routeId, attempt: 1, presentation: 'internal',
        },
      })
      if (repairWake === undefined) throw new Error(`Missing ${lane.label} repair wake`)
      const repairMarker = `INTERNAL_${lane.kind.toUpperCase()}_REPAIR_AUTHORING`
      agent.session.append('step/start', { turn: 3, step: 1 })
      agent.session.append('user/message', repairWake, { surfaceOp: 'append' })
      agent.session.append('assistant/message', {
        turn: 3, step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text: repairMarker }],
          source: { provider: 'mock', model: 'mock' },
        }),
      }, { surfaceOp: 'append' })
      agent.session.append('step/end', { turn: 3, step: 1 })
      agent.session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
      await vi.waitFor(() => {
        expect(agent.session.events.filter(event => event.type === 'blueprint/capability-authoring'
          && event.data.state === 'ended')).toHaveLength(1)
      }, { timeout: 10_000 })

      const terminal = agent.session.events.find(event => event.type === 'blueprint/capability-authoring'
        && event.data.state === 'ended')
      if (terminal?.type !== 'blueprint/capability-authoring' || terminal.data.state !== 'ended') {
        throw new Error(`Missing repaired ${lane.label} terminal`)
      }
      expect(terminal.data.capabilityFailure).toBeUndefined()
      expect(terminal.data).toMatchObject(lane.kind === 'skill' ? {
        routeId, outcome: 'completed', skillEvidence: { skills: [{ name: 'csv-metrics' }] },
        candidateDisposition: { disposition: 'committed' },
      } : {
        routeId, outcome: 'completed',
        subagentEvidence: { delegations: [{ rowId: 'industry-research', provider: 'spawn' }] },
        candidateDisposition: { disposition: 'committed' },
      })
      expect(terminal.data).not.toHaveProperty('capabilityFailure')
      const verification = terminal.data.kind === 'skill'
        ? terminal.data.skillEvidence?.verification
        : terminal.data.subagentEvidence?.verification
      expect(verification).toMatchObject({ presetId: 'kaoyan-choose', valid: true, overall: 'pass' })
      expect(verification?.sessionId).not.toBe(sourceSessionId)
      expect(agent.session.events.filter(event => event.type === 'blueprint/capability-repair')).toHaveLength(1)
      expect(JSON.stringify(agent.session.events)).toContain(initialMarker)
      expect(JSON.stringify(agent.session.events)).toContain(repairMarker)
      expect(JSON.stringify(agent.session.deriveMessages())).not.toContain(initialMarker)
      expect(JSON.stringify(agent.session.deriveMessages())).not.toContain(repairMarker)
      expect(agent.session.events.filter(event => event.type === 'user/message'
        && event.data.source.kind === 'blueprint-capability-terminal')).toHaveLength(2)
      expect(agent.inbox.hasPending).toBe(false)
      const published = await ctx.blueprintAdapter.read('kaoyan-choose', { cwd: root })
      expect(published.nodes).toContainEqual(expect.objectContaining({
        id: lane.publishedNodeId, source: 'preset', status: 'active',
      }))
      expect(published.revision).not.toBe(baseline.revision)
      if (lane.kind === 'skill') {
        const nextRouteId = 'subagent-after-published-skill'
        const nextRequest = '增加一个行业研究 Subagent'
        await ctx.blueprintAdapter.setConversationContext({
          sessionId: sourceSessionId, presetId: published.preset.id, revision: published.revision,
          capabilityInput: { routeId: nextRouteId, userRequest: nextRequest },
        })
        agent.session.append('turn/start', { turn: 4 })
        const [routingInput] = agent.inbox.claim('next-turn', 4)
        if (routingInput === undefined) throw new Error('Missing post-publication Add Subagent input')
        agent.session.append('step/start', { turn: 4, step: 1 })
        agent.session.append('user/message', routingInput, { surfaceOp: 'append' })

        const lateRecovery = await ctx.blueprintAdapter.setConversationContext({
          sessionId: sourceSessionId, recoverCapabilityAuthoring: true,
        })
        expect(lateRecovery.active).toBe(false)
        const routed = await ctx.tools.execute({
          signal: new AbortController().signal,
          callId: CallId('subagent-after-published-skill-call'),
          name: BLUEPRINT_CAPABILITY_AUTHORING_TOOL,
          arguments: {
            request: nextRequest, kind: 'subagent', reason: 'Requires a dedicated research collaborator.',
          },
          agent,
        })
        expect(routed.isError).toBe(false)
        expect(agent.session.events.filter(event => event.type === 'blueprint/route-decision')
          .map(event => event.data.routeId)).toEqual([routeId, nextRouteId])
        agent.session.append('step/end', { turn: 4, step: 1 })
        agent.session.append('turn/end', { turn: 4, reason: { kind: 'completed' } })
      }
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a forbidden candidate row before creating a fresh verification Agent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-blueprint-authority-first-'))
    for (const presetId of ['cordis', 'kaoyan-choose']) {
      await mkdir(join(root, presetId))
      await writeFile(join(root, presetId, 'agent.cordis.yml'), composition(), 'utf8')
    }
    const ctx = await harness(root, 1)
    let restoreFollowup: (() => void) | undefined
    let restoreVerificationSpies: (() => void) | undefined
    try {
      const sourceSessionId = 'authority-first-source'
      const routeId = 'authority-first-route'
      const { agent } = await ctx.agents.create({
        sessionId: SessionId(capabilityAuthoringCreatorSessionId(sourceSessionId, routeId)),
        meta: { agentPreset: 'cordis', cwd: root },
        setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'cordis'),
      })
      const followup = vi.spyOn(agent, 'followup').mockImplementation((message) => {
        agent.send(message, 'next-turn', false)
      })
      restoreFollowup = () => { followup.mockRestore() }
      const baseline = await ctx.blueprintAdapter.read('kaoyan-choose', { cwd: root })
      await ctx.blueprintAdapter.setConversationContext({
        sessionId: String(agent.id),
        capabilityAuthoring: recordDurableCapabilityRoute(ctx, {
          routeId, sourceSessionId, target: baseline, kind: 'skill', request: '增加 CSV 财报 Skill',
        }),
      })
      const candidatePath = await candidatePresetPath(ctx, agent, 'kaoyan-choose')
      await writeFile(candidatePath, `${composition()}- id: forbidden-capability-row
  name: '${pathToFileURL(FIXTURE_PLUGIN).href}'
  config:
    search: false
`)
      const create = vi.spyOn(ctx.agents, 'create')
      const mount = vi.spyOn(ctx.agentPresets, 'mount')
      restoreVerificationSpies = () => {
        create.mockRestore()
        mount.mockRestore()
      }

      agent.session.append('turn/start', { turn: 1 })
      expect(agent.inbox.claim('next-turn', 1)).toHaveLength(1)
      agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await vi.waitFor(() => {
        expect(agent.session.events.filter(event => event.type === 'blueprint/capability-repair')).toHaveLength(1)
        expect(agent.inbox.nextTurn.some(message => message.source.kind === 'blueprint-capability-repair')).toBe(true)
      })
      const repair = agent.session.events.find(event => event.type === 'blueprint/capability-repair')
      expect(repair?.data).toMatchObject({ routeId, attempt: 1, prerequisite: 'candidate_delta' })
      expect(repair?.data.message).toContain('Skill authoring may add only one skill-filesystem row and one tool-skill row')
      expect(create).not.toHaveBeenCalled()
      expect(mount).not.toHaveBeenCalled()
      expect(agent.session.events.filter(event => event.type === 'blueprint/capability-authoring'
        && event.data.state === 'ended')).toEqual([])
    } finally {
      restoreVerificationSpies?.()
      restoreFollowup?.()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    { label: 'one transient failure', failedCalls: [1], outcome: 'completed' as const },
    { label: 'exhausted failures', failedCalls: [1, 2], outcome: 'failed' as const },
  ])('bounds verified candidate publication after $label', async ({ failedCalls, outcome }) => {
    const root = await mkdtemp(join(tmpdir(), `dsh-blueprint-publication-${outcome}-`))
    for (const presetId of ['cordis', 'kaoyan-choose']) {
      await mkdir(join(root, presetId))
      await writeFile(join(root, presetId, 'agent.cordis.yml'), composition(), 'utf8')
    }
    const ctx = await harness(root, 1)
    let restoreFollowup: (() => void) | undefined
    let restorePublication: (() => void) | undefined
    try {
      const sourceSessionId = `publication-${outcome}-source`
      const routeId = `publication-${outcome}-route`
      const { agent } = await ctx.agents.create({
        sessionId: SessionId(capabilityAuthoringCreatorSessionId(sourceSessionId, routeId)),
        meta: { agentPreset: 'cordis', cwd: root },
        setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'cordis'),
      })
      const followup = vi.spyOn(agent, 'followup').mockImplementation((message) => {
        agent.send(message, 'next-turn', false)
      })
      restoreFollowup = () => { followup.mockRestore() }
      const formalComposition = await readFile(join(root, 'kaoyan-choose', 'agent.cordis.yml'), 'utf8')
      const baseline = await ctx.blueprintAdapter.read('kaoyan-choose', { cwd: root })
      await ctx.blueprintAdapter.setConversationContext({
        sessionId: String(agent.id),
        capabilityAuthoring: recordDurableCapabilityRoute(ctx, {
          routeId, sourceSessionId, target: baseline, kind: 'skill', request: '增加 CSV 财报 Skill',
        }),
      })
      const candidatePath = await candidatePresetPath(ctx, agent, 'kaoyan-choose')
      const skillRoot = join(dirname(candidatePath), 'skills', 'csv-metrics')
      await mkdir(skillRoot, { recursive: true })
      await writeFile(join(skillRoot, 'SKILL.md'), filesystemSkillDefinition('csv-metrics'))
      await writeFile(candidatePath, `${composition()}${filesystemSkillCompositionRows()}`)
      const originalPublishTransaction = ctx.agentPresets.publishTransaction.bind(ctx.agentPresets)
      let publicationCalls = 0
      const publication = vi.spyOn(ctx.agentPresets, 'publishTransaction').mockImplementation((transaction, digest) => {
        publicationCalls += 1
        if (failedCalls.includes(publicationCalls)) return Promise.reject(new Error('injected publication failure'))
        return originalPublishTransaction(transaction, digest)
      })
      restorePublication = () => { publication.mockRestore() }

      agent.session.append('turn/start', { turn: 1 })
      expect(agent.inbox.claim('next-turn', 1)).toHaveLength(1)
      agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await vi.waitFor(() => {
        expect(agent.session.events.filter(event => event.type === 'blueprint/capability-authoring'
          && event.data.state === 'ended')).toHaveLength(1)
      })
      const verified = agent.session.events.filter(event => event.type === 'blueprint/capability-verified')
      expect(verified).toHaveLength(1)
      expect(agent.session.events.filter(event => event.type === 'blueprint/capability-repair')).toEqual([])
      const terminal = agent.session.events.find(event => event.type === 'blueprint/capability-authoring'
        && event.data.state === 'ended')
      expect(terminal?.data).toMatchObject({ routeId, outcome })
      const publicResult = await ctx.blueprintAdapter.setConversationContext({
        sessionId: String(agent.id), recoverCapabilityAuthoring: true,
      })
      expect(publicResult.active).toBe(false)
      const publicRecord = publicResult.capabilityAuthoringRecord
      expect(publicRecord).toMatchObject({ routeId, state: 'ended', outcome })
      expect(publicRecord).not.toHaveProperty('capabilityFailure')
      expect(publicRecord).not.toHaveProperty('candidateDisposition')
      if (outcome === 'completed') {
        expect(publicationCalls).toBe(2)
        expect((await ctx.blueprintAdapter.read('kaoyan-choose', { cwd: root })).nodes).toContainEqual(
          expect.objectContaining({ id: 'capability:skill:csv-metrics', status: 'active' }),
        )
      } else {
        expect(publicationCalls).toBe(2)
        expect(await readFile(join(root, 'kaoyan-choose', 'agent.cordis.yml'), 'utf8')).toBe(formalComposition)
        const unchanged = await ctx.blueprintAdapter.read('kaoyan-choose', { cwd: root })
        expect(unchanged.revision).toBe(baseline.revision)
        expect(unchanged.nodes.some(node => node.id === 'capability:skill:csv-metrics')).toBe(false)
      }
    } finally {
      restorePublication?.()
      restoreFollowup?.()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform === 'win32')(
    'fails safely when a Windows handle blocks a commit-prepared preset rename',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'dsh-blueprint-publication-locked-'))
      for (const presetId of ['cordis', 'kaoyan-choose']) {
        await mkdir(join(root, presetId))
        await writeFile(join(root, presetId, 'agent.cordis.yml'), composition(), 'utf8')
      }
      const ctx = await harness(root, 1)
      let restoreFollowup: (() => void) | undefined
      let lock: Awaited<ReturnType<typeof open>> | undefined
      try {
        const sourceSessionId = 'publication-locked-source'
        const routeId = 'publication-locked-route'
        const { agent } = await ctx.agents.create({
          sessionId: SessionId(capabilityAuthoringCreatorSessionId(sourceSessionId, routeId)),
          meta: { agentPreset: 'cordis', cwd: root },
          setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'cordis'),
        })
        const followup = vi.spyOn(agent, 'followup').mockImplementation((message) => {
          agent.send(message, 'next-turn', false)
        })
        restoreFollowup = () => { followup.mockRestore() }
        const formalPath = join(root, 'kaoyan-choose', 'agent.cordis.yml')
        const formalComposition = await readFile(formalPath, 'utf8')
        const baseline = await ctx.blueprintAdapter.read('kaoyan-choose', { cwd: root })
        await ctx.blueprintAdapter.setConversationContext({
          sessionId: String(agent.id),
          capabilityAuthoring: recordDurableCapabilityRoute(ctx, {
            routeId, sourceSessionId, target: baseline, kind: 'skill', request: '增加 CSV 财报 Skill',
          }),
        })
        const candidatePath = await candidatePresetPath(ctx, agent, 'kaoyan-choose')
        const skillRoot = join(dirname(candidatePath), 'skills', 'csv-metrics')
        await mkdir(skillRoot, { recursive: true })
        await writeFile(join(skillRoot, 'SKILL.md'), filesystemSkillDefinition('csv-metrics'))
        await writeFile(candidatePath, `${composition()}${filesystemSkillCompositionRows()}`)
        lock = await open(formalPath, 'r')

        agent.session.append('turn/start', { turn: 1 })
        expect(agent.inbox.claim('next-turn', 1)).toHaveLength(1)
        agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
        await vi.waitFor(() => {
          expect(agent.session.events.filter(event => event.type === 'blueprint/capability-authoring'
            && event.data.state === 'ended')).toHaveLength(1)
        })

        const terminal = agent.session.events.find(event => event.type === 'blueprint/capability-authoring'
          && event.data.state === 'ended')
        expect(agent.session.events.filter(event => event.type === 'blueprint/capability-verified')).toHaveLength(1)
        expect(terminal?.data).toMatchObject({
          routeId,
          outcome: 'failed',
          candidateDisposition: { disposition: 'discarded' },
          capabilityFailure: { prerequisite: 'commit' },
        })
        expect(await readFile(formalPath, 'utf8')).toBe(formalComposition)
        const unchanged = await ctx.blueprintAdapter.read('kaoyan-choose', { cwd: root })
        expect(unchanged.revision).toBe(baseline.revision)
        expect(unchanged.nodes.some(node => node.id === 'capability:skill:csv-metrics')).toBe(false)
        const publicResult = await ctx.blueprintAdapter.setConversationContext({
          sessionId: String(agent.id), recoverCapabilityAuthoring: true,
        })
        expect(publicResult.capabilityAuthoringRecord).toMatchObject({
          routeId,
          state: 'ended',
          outcome: 'failed',
        })
        expect(publicResult.capabilityAuthoringRecord).not.toHaveProperty('capabilityFailure')
        expect(publicResult.capabilityAuthoringRecord).not.toHaveProperty('candidateDisposition')
      } finally {
        await lock?.close()
        restoreFollowup?.()
        await ctx.fiber.dispose()
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it.each(['disposed', 'interrupted'] as const)(
    'resumes one interrupted candidate from one deterministic repair after a clean restart: %s',
    async (interruption) => {
      const root = await mkdtemp(join(tmpdir(), `dsh-blueprint-${interruption}-resume-`))
      const persistenceRoot = await mkdtemp(join(tmpdir(), `dsh-blueprint-${interruption}-sessions-`))
      for (const presetId of ['cordis', 'kaoyan-choose']) {
        await mkdir(join(root, presetId))
        await writeFile(join(root, presetId, 'agent.cordis.yml'), composition(), 'utf8')
      }
      const sourceSessionId = `${interruption}-source`
      const routeId = `${interruption}-route`
      const creatorSessionId = SessionId(capabilityAuthoringCreatorSessionId(sourceSessionId, routeId))
      const first = await harness(root, 1, persistenceRoot)
      let second: Context | undefined
      let restoreFirstFollowup: (() => void) | undefined
      let restoreSecondFollowup: (() => void) | undefined
      try {
        const handle = await first.agents.create({
          sessionId: creatorSessionId,
          meta: { agentPreset: 'cordis', cwd: root },
          setup: async agentCtx => void await first.agentPresets.mount(agentCtx, 'cordis'),
        })
        const { agent } = handle
        const followup = vi.spyOn(agent, 'followup').mockImplementation((message) => {
          agent.send(message, 'next-turn', false)
        })
        restoreFirstFollowup = () => { followup.mockRestore() }
        const formalComposition = await readFile(join(root, 'kaoyan-choose', 'agent.cordis.yml'), 'utf8')
        const baseline = await first.blueprintAdapter.read('kaoyan-choose', { cwd: root })
        const started = await first.blueprintAdapter.setConversationContext({
          sessionId: String(agent.id),
          capabilityAuthoring: recordDurableCapabilityRoute(first, {
            routeId, sourceSessionId, target: baseline, kind: 'skill', request: '增加 CSV 财报 Skill',
          }),
        })
        const startSeq = started.capabilityAuthoringRecord?.startSeq
        expect(startSeq).toEqual(expect.any(Number))
        const candidatePath = await candidatePresetPath(first, agent, 'kaoyan-choose')
        const skillRoot = join(dirname(candidatePath), 'skills', 'csv-metrics')
        await mkdir(skillRoot, { recursive: true })
        await writeFile(join(skillRoot, 'SKILL.md'), filesystemSkillDefinition('csv-metrics'))
        await writeFile(candidatePath, composition())

        agent.session.append('turn/start', { turn: 1 })
        expect(agent.inbox.claim('next-turn', 1)).toHaveLength(1)
        agent.session.append('turn/end', {
          turn: 1,
          reason: interruption === 'disposed'
            ? { kind: 'aborted', reason: { kind: 'disposed' } }
            : { kind: 'interrupted' },
        })
        await vi.waitFor(() => {
          expect(agent.session.events.filter(event => event.type === 'blueprint/capability-repair')).toHaveLength(1)
          expect(agent.inbox.nextTurn.some(message => message.source.kind === 'blueprint-capability-repair')).toBe(true)
        })
        const repair = agent.session.events.find(event => event.type === 'blueprint/capability-repair')
        if (repair?.type !== 'blueprint/capability-repair') throw new Error('Missing interrupted repair checkpoint')
        expect(repair.data).toMatchObject({ routeId, startSeq, attempt: 1 })
        expect(agent.session.events.filter(event => event.type === 'blueprint/capability-authoring'
          && event.data.state === 'ended')).toEqual([])
        expect(await readFile(join(root, 'kaoyan-choose', 'agent.cordis.yml'), 'utf8')).toBe(formalComposition)
        expect((await first.blueprintAdapter.read('kaoyan-choose', { cwd: root })).revision).toBe(baseline.revision)
        await first.sessions.flush(agent.session)

        restoreFirstFollowup()
        restoreFirstFollowup = undefined
        await handle.dispose()
        await first.fiber.dispose()

        second = await harness(root, 1, persistenceRoot)
        const resumedHandle = await second.agents.resume({
          resumeSessionId: creatorSessionId,
          setup: async agentCtx => void await second!.agentPresets.mount(agentCtx, 'cordis'),
        })
        const resumed = resumedHandle.agent
        const resumedFollowup = vi.spyOn(resumed, 'followup').mockImplementation((message) => {
          resumed.send(message, 'next-turn', false)
        })
        restoreSecondFollowup = () => { resumedFollowup.mockRestore() }
        const recovery = await Promise.all([1, 2, 3].map(() => second!.blueprintAdapter.setConversationContext({
          sessionId: String(resumed.id), recoverCapabilityAuthoring: true,
        })))
        expect(recovery.every(result => result.capabilityAuthoringRecord?.state === 'active')).toBe(true)
        expect(recovery.every(result => result.capabilityAuthoringRecord?.startSeq === startSeq)).toBe(true)
        const repairInsertions = resumed.session.events.filter(event => event.type === 'agent/inbox/spliced'
          && event.data.inserted.some(message => message.id === repair.data.repairMessageId))
        expect(repairInsertions).toHaveLength(2)
        expect(resumed.inbox.nextTurn.filter(message => message.id === repair.data.repairMessageId)).toHaveLength(1)
        expect(resumed.session.events.filter(event => event.type === 'blueprint/capability-repair')).toHaveLength(1)
        expect(await candidatePresetPath(second, resumed, 'kaoyan-choose')).toBe(candidatePath)

        await writeFile(candidatePath, `${composition()}${filesystemSkillCompositionRows()}`)
        resumed.session.append('turn/start', { turn: 2 })
        const [repairWake] = resumed.inbox.claim('next-turn', 2)
        expect(repairWake?.id).toBe(repair.data.repairMessageId)
        resumed.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
        await vi.waitFor(() => {
          expect(resumed.session.events.filter(event => event.type === 'blueprint/capability-authoring'
            && event.data.state === 'ended')).toHaveLength(1)
        })
        const terminal = resumed.session.events.find(event => event.type === 'blueprint/capability-authoring'
          && event.data.state === 'ended')
        expect(terminal?.data).toMatchObject({
          routeId, startSeq, outcome: 'completed', candidateDisposition: { disposition: 'committed' },
        })
        expect(resumed.session.events.filter(event => event.type === 'blueprint/capability-repair')).toHaveLength(1)
        expect((await second.blueprintAdapter.read('kaoyan-choose', { cwd: root })).nodes).toContainEqual(
          expect.objectContaining({ id: 'capability:skill:csv-metrics', status: 'active' }),
        )
      } finally {
        restoreFirstFollowup?.()
        restoreSecondFollowup?.()
        await second?.fiber.dispose()
        if (first.fiber.uid !== null) await first.fiber.dispose()
        await rm(root, { recursive: true, force: true })
        await rm(persistenceRoot, { recursive: true, force: true })
      }
    },
  )

  it('re-inserts one durably cancelled repair wake exactly once after recreation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-blueprint-repair-replay-'))
    const persistenceRoot = await mkdtemp(join(tmpdir(), 'dsh-blueprint-repair-replay-sessions-'))
    for (const presetId of ['cordis', 'kaoyan-choose']) {
      await mkdir(join(root, presetId))
      await writeFile(join(root, presetId, 'agent.cordis.yml'), composition(), 'utf8')
    }
    const sourceSessionId = 'repair-replay-source'
    const routeId = 'repair-replay-route'
    const creatorSessionId = SessionId(capabilityAuthoringCreatorSessionId(sourceSessionId, routeId))
    const first = await harness(root, 1, persistenceRoot)
    let second: Context | undefined
    let restoreFirstFollowup: (() => void) | undefined
    let restoreSecondFollowup: (() => void) | undefined
    try {
      const handle = await first.agents.create({
        sessionId: creatorSessionId,
        meta: { agentPreset: 'cordis', cwd: root },
        setup: async agentCtx => void await first.agentPresets.mount(agentCtx, 'cordis'),
      })
      const { agent } = handle
      const followup = vi.spyOn(agent, 'followup').mockImplementation((message) => {
        agent.send(message, 'next-turn', false)
      })
      restoreFirstFollowup = () => { followup.mockRestore() }
      const baseline = await first.blueprintAdapter.read('kaoyan-choose', { cwd: root })
      const started = await first.blueprintAdapter.setConversationContext({
        sessionId: String(agent.id),
        capabilityAuthoring: recordDurableCapabilityRoute(first, {
          routeId, sourceSessionId, target: baseline, kind: 'skill', request: '增加 CSV 财报 Skill',
        }),
      })
      const candidatePath = await candidatePresetPath(first, agent, 'kaoyan-choose')
      const skillRoot = join(dirname(candidatePath), 'skills', 'csv-metrics')
      await mkdir(skillRoot, { recursive: true })
      await writeFile(join(skillRoot, 'SKILL.md'), filesystemSkillDefinition('csv-metrics'))
      await writeFile(candidatePath, composition())
      agent.session.append('turn/start', { turn: 1 })
      expect(agent.inbox.claim('next-turn', 1)).toHaveLength(1)
      agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await vi.waitFor(() => {
        expect(agent.session.events.filter(event => event.type === 'blueprint/capability-repair')).toHaveLength(1)
        expect(agent.inbox.nextTurn.some(message => message.source.kind === 'blueprint-capability-repair')).toBe(true)
      })
      const repair = agent.session.events.find(event => event.type === 'blueprint/capability-repair')
      if (repair?.type !== 'blueprint/capability-repair') throw new Error('Missing repair replay checkpoint')
      expect(agent.inbox.nextTurn.filter(message => message.id === repair.data.repairMessageId)).toHaveLength(1)
      await first.sessions.flush(agent.session)

      restoreFirstFollowup()
      restoreFirstFollowup = undefined
      await handle.dispose()
      await first.fiber.dispose()

      second = await harness(root, 1, persistenceRoot)
      const resumedHandle = await second.agents.resume({
        resumeSessionId: creatorSessionId,
        setup: async agentCtx => void await second!.agentPresets.mount(agentCtx, 'cordis'),
      })
      const resumed = resumedHandle.agent
      const resumedFollowup = vi.spyOn(resumed, 'followup').mockImplementation((message) => {
        resumed.send(message, 'next-turn', false)
      })
      restoreSecondFollowup = () => { resumedFollowup.mockRestore() }
      const recovered = await Promise.all([1, 2, 3].map(() => second!.blueprintAdapter.setConversationContext({
        sessionId: String(resumed.id), recoverCapabilityAuthoring: true,
      })))
      expect(recovered.every(result => result.capabilityAuthoringRecord?.state === 'active')).toBe(true)
      expect(resumed.session.events.filter(event => event.type === 'blueprint/capability-authoring'
        && event.data.state === 'started')).toHaveLength(1)
      expect(resumed.session.events.filter(event => event.type === 'blueprint/capability-repair')).toHaveLength(1)
      expect(resumed.session.events.filter(event => event.type === 'agent/inbox/spliced'
        && event.data.inserted.some(message => message.id === repair.data.repairMessageId))).toHaveLength(2)
      expect(resumed.session.events.filter(event => event.type === 'agent/inbox/spliced'
        && event.data.outcome === 'canceled')).toHaveLength(1)
      expect(resumed.inbox.nextTurn.filter(message => message.id === repair.data.repairMessageId)).toHaveLength(1)
      expect(await candidatePresetPath(second, resumed, 'kaoyan-choose')).toBe(candidatePath)

      await writeFile(candidatePath, `${composition()}${filesystemSkillCompositionRows()}`)
      resumed.session.append('turn/start', { turn: 2 })
      const [repairWake] = resumed.inbox.claim('next-turn', 2)
      expect(repairWake?.id).toBe(repair.data.repairMessageId)
      resumed.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
      await vi.waitFor(() => {
        expect(resumed.session.events.filter(event => event.type === 'blueprint/capability-authoring'
          && event.data.state === 'ended')).toHaveLength(1)
      })
      expect(resumed.session.events.find(event => event.type === 'blueprint/capability-authoring'
        && event.data.state === 'ended')?.data).toMatchObject({
        routeId, startSeq: started.capabilityAuthoringRecord?.startSeq, outcome: 'completed',
      })
    } finally {
      restoreFirstFollowup?.()
      restoreSecondFollowup?.()
      await second?.fiber.dispose()
      if (first.fiber.uid !== null) await first.fiber.dispose()
      await rm(root, { recursive: true, force: true })
      await rm(persistenceRoot, { recursive: true, force: true })
    }
  })

  it('cancels only lifecycle work while unrelated maintenance and inbox input remain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-blueprint-authoring-cancel-'))
    for (const presetId of ['cordis', 'kaoyan-choose']) {
      const presetDir = join(root, presetId)
      await mkdir(presetDir)
      await writeFile(join(presetDir, 'agent.cordis.yml'), composition(), 'utf8')
    }
    const ctx = await harness(root)
    try {
      const sourceSessionId = 'cancel-source'
      const routeId = 'cancel-route'
      const { agent } = await ctx.agents.create({
        sessionId: SessionId(capabilityAuthoringCreatorSessionId(sourceSessionId, routeId)),
        meta: { agentPreset: 'cordis' },
        setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'cordis'),
      })
      const target = await ctx.blueprintAdapter.read('kaoyan-choose')
      await ctx.blueprintAdapter.setConversationContext({
        sessionId: String(agent.id),
        capabilityAuthoring: recordDurableCapabilityRoute(ctx, {
          routeId, sourceSessionId, target, kind: 'skill', request: '新增 CSV Skill',
        }),
      })
      const release = Promise.withResolvers<undefined>()
      let aborted = false
      const writer = agent.runMaintenance(async (signal) => {
        signal.addEventListener('abort', () => { aborted = true }, { once: true })
        await release.promise
      })
      const unrelated = createUserMessage({
        source: { kind: 'user' }, content: [{ type: 'text', text: 'Keep this unrelated queued input.' }],
      })
      agent.send(unrelated, 'next-turn', false)

      const result = await ctx.blueprintAdapter.setConversationContext({
        sessionId: String(agent.id), capabilityAuthoringEnd: { outcome: 'cancelled' },
      })
      expect(aborted).toBe(false)
      expect(agent.inbox.nextTurn).toEqual([unrelated])
      expect(result.capabilityAuthoringRecord).toMatchObject({
        routeId: 'cancel-route', sourceSessionId: 'cancel-source', state: 'ended', outcome: 'cancelled',
      })
      release.resolve(undefined)
      await writer
      expect(agent.session.events.filter(event => event.type === 'blueprint/capability-authoring'
        && event.data.state === 'ended')).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['initial-wake', 'repair-wake'] as const)(
    'durably cancels an idle capability lifecycle without replaying its pending %s',
    async (pending) => {
      const root = await mkdtemp(join(tmpdir(), `dsh-blueprint-idle-cancel-${pending}-`))
      for (const presetId of ['cordis', 'kaoyan-choose']) {
        await mkdir(join(root, presetId))
        await writeFile(join(root, presetId, 'agent.cordis.yml'), composition(), 'utf8')
      }
      const ctx = await harness(root, 2)
      let restoreFollowup: (() => void) | undefined
      try {
        const sourceSessionId = `idle-cancel-source-${pending}`
        const routeId = `idle-cancel-route-${pending}`
        const { agent } = await ctx.agents.create({
          sessionId: SessionId(capabilityAuthoringCreatorSessionId(sourceSessionId, routeId)),
          meta: { agentPreset: 'cordis', cwd: root },
          setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'cordis'),
        })
        const followup = vi.spyOn(agent, 'followup').mockImplementation((message) => {
          agent.send(message, 'next-turn', false)
        })
        restoreFollowup = () => { followup.mockRestore() }
        const baselineText = await readFile(join(root, 'kaoyan-choose', 'agent.cordis.yml'), 'utf8')
        const target = await ctx.blueprintAdapter.read('kaoyan-choose', { cwd: root })
        const started = await ctx.blueprintAdapter.setConversationContext({
          sessionId: String(agent.id),
          capabilityAuthoring: recordDurableCapabilityRoute(ctx, {
            routeId, sourceSessionId, target, kind: 'skill', request: '新增 CSV Skill',
          }),
        })
        const startSeq = started.capabilityAuthoringRecord?.startSeq
        expect(startSeq).toEqual(expect.any(Number))
        expect(agent.inbox.nextTurn).toHaveLength(1)

        if (pending === 'repair-wake') {
          agent.session.append('turn/start', { turn: 1 })
          expect(agent.inbox.claim('next-turn', 1)).toHaveLength(1)
          agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
          await vi.waitFor(() => {
            expect(agent.session.events.filter(event => event.type === 'blueprint/capability-repair')).toHaveLength(1)
            expect(agent.inbox.nextTurn.some(message => message.source.kind === 'blueprint-capability-repair')).toBe(true)
          })
        }

        const result = await ctx.blueprintAdapter.setConversationContext({
          sessionId: String(agent.id), capabilityAuthoringEnd: { outcome: 'cancelled' },
        })
        expect(result.capabilityAuthoringRecord).toMatchObject({
          routeId, sourceSessionId, startSeq, state: 'ended', outcome: 'cancelled',
        })
        expect(agent.inbox.nextTurn).toEqual([])
        expect(agent.inbox.nextStep).toEqual([])
        const cancellation = agent.session.events.find(event => event.type === 'blueprint/capability-cancel-requested')
        const terminal = agent.session.events.find(event => event.type === 'blueprint/capability-authoring'
          && event.data.state === 'ended')
        expect(cancellation?.data).toEqual({ routeId, startSeq })
        expect(terminal?.data).toMatchObject({
          routeId, startSeq, outcome: 'cancelled',
          candidateDisposition: { disposition: 'discarded' },
        })
        expect(cancellation?.seq).toBeLessThan(terminal?.seq ?? 0)
        expect(agent.session.events.filter(event => event.type === 'blueprint/capability-verified')).toEqual([])
        expect(agent.session.events.filter(event => event.type === 'agent/inbox/spliced'
          && event.seq > (cancellation?.seq ?? Number.MAX_SAFE_INTEGER)
          && event.data.inserted.some(message => String(message.id).startsWith('blueprint-capability')))).toEqual([])
        expect(await readFile(join(root, 'kaoyan-choose', 'agent.cordis.yml'), 'utf8')).toBe(baselineText)

        const recovered = await Promise.all([1, 2].map(() => ctx.blueprintAdapter.setConversationContext({
          sessionId: String(agent.id), recoverCapabilityAuthoring: true,
        })))
        expect(recovered.every(item => item.capabilityAuthoringRecord?.outcome === 'cancelled')).toBe(true)
        expect(agent.session.events.filter(event => event.type === 'blueprint/capability-cancel-requested')).toHaveLength(1)
        expect(agent.session.events.filter(event => event.type === 'blueprint/capability-authoring'
          && event.data.state === 'ended')).toHaveLength(1)
      } finally {
        restoreFollowup?.()
        await ctx.fiber.dispose()
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it('finishes a checkpointed idle cancellation after a clean restart without recreating its interaction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-blueprint-cancel-restart-'))
    const persistenceRoot = await mkdtemp(join(tmpdir(), 'dsh-blueprint-cancel-restart-sessions-'))
    for (const presetId of ['cordis', 'kaoyan-choose']) {
      await mkdir(join(root, presetId))
      await writeFile(join(root, presetId, 'agent.cordis.yml'), composition(), 'utf8')
    }
    const sourceSessionId = 'cancel-restart-source'
    const routeId = 'cancel-restart-route'
    const creatorSessionId = SessionId(capabilityAuthoringCreatorSessionId(sourceSessionId, routeId))
    const first = await harness(root, 2, persistenceRoot)
    let second: Context | undefined
    let restoreFirstFollowup: (() => void) | undefined
    let restoreSecondFollowup: (() => void) | undefined
    try {
      const handle = await first.agents.create({
        sessionId: creatorSessionId,
        meta: { agentPreset: 'cordis', cwd: root },
        setup: async agentCtx => void await first.agentPresets.mount(agentCtx, 'cordis'),
      })
      const { agent } = handle
      const firstFollowup = vi.spyOn(agent, 'followup').mockImplementation((message) => {
        agent.send(message, 'next-turn', false)
      })
      restoreFirstFollowup = () => { firstFollowup.mockRestore() }
      const baselineText = await readFile(join(root, 'kaoyan-choose', 'agent.cordis.yml'), 'utf8')
      const target = await first.blueprintAdapter.read('kaoyan-choose', { cwd: root })
      const started = await first.blueprintAdapter.setConversationContext({
        sessionId: String(agent.id),
        capabilityAuthoring: recordDurableCapabilityRoute(first, {
          routeId, sourceSessionId, target, kind: 'skill', request: '新增 CSV Skill',
        }),
      })
      const startSeq = started.capabilityAuthoringRecord?.startSeq
      expect(agent.inbox.nextTurn).toHaveLength(1)
      agent.session.append('blueprint/capability-cancel-requested', { routeId, startSeq: startSeq! })
      await first.sessions.flush(agent.session)
      expect(agent.session.events.filter(event => event.type === 'blueprint/capability-authoring'
        && event.data.state === 'ended')).toEqual([])

      restoreFirstFollowup()
      restoreFirstFollowup = undefined
      await handle.dispose()
      await first.fiber.dispose()

      second = await harness(root, 2, persistenceRoot)
      const resumedHandle = await second.agents.resume({
        resumeSessionId: creatorSessionId,
        setup: async agentCtx => void await second!.agentPresets.mount(agentCtx, 'cordis'),
      })
      const resumed = resumedHandle.agent
      const secondFollowup = vi.spyOn(resumed, 'followup').mockImplementation((message) => {
        resumed.send(message, 'next-turn', false)
      })
      restoreSecondFollowup = () => { secondFollowup.mockRestore() }
      const recovered = await Promise.all([1, 2, 3].map(() => second!.blueprintAdapter.setConversationContext({
        sessionId: String(resumed.id), recoverCapabilityAuthoring: true,
      })))
      expect(recovered.every(item => item.capabilityAuthoringRecord?.outcome === 'cancelled')).toBe(true)
      const cancellation = resumed.session.events.find(event => event.type === 'blueprint/capability-cancel-requested')
      const terminal = resumed.session.events.filter(event => event.type === 'blueprint/capability-authoring'
        && event.data.state === 'ended')
      expect(cancellation?.data).toEqual({ routeId, startSeq })
      expect(terminal).toHaveLength(1)
      expect(terminal[0]?.data).toMatchObject({
        routeId, startSeq, outcome: 'cancelled', candidateDisposition: { disposition: 'discarded' },
      })
      expect(resumed.session.events.filter(event => event.type === 'blueprint/capability-cancel-requested')).toHaveLength(1)
      expect(resumed.session.events.filter(event => event.type === 'agent/inbox/spliced'
        && event.seq > (cancellation?.seq ?? Number.MAX_SAFE_INTEGER)
        && event.data.inserted.some(message => String(message.id).startsWith('blueprint-capability')))).toEqual([])
      expect(resumed.session.events.filter(event => event.type === 'blueprint/capability-repair'
        || event.type === 'blueprint/capability-verified')).toEqual([])
      expect(await readFile(join(root, 'kaoyan-choose', 'agent.cordis.yml'), 'utf8')).toBe(baselineText)
    } finally {
      restoreFirstFollowup?.()
      restoreSecondFollowup?.()
      await second?.fiber.dispose()
      if (first.fiber.uid !== null) await first.fiber.dispose()
      await rm(root, { recursive: true, force: true })
      await rm(persistenceRoot, { recursive: true, force: true })
    }
  })

  it('rejects a client-authored capability failure while the Host lifecycle remains active', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-blueprint-authoring-host-failure-'))
    for (const presetId of ['cordis', 'kaoyan-choose']) {
      const presetDir = join(root, presetId)
      await mkdir(presetDir)
      await writeFile(join(presetDir, 'agent.cordis.yml'), composition(), 'utf8')
    }
    const ctx = await harness(root)
    let restoreFollowup: (() => void) | undefined
    try {
      const sourceSessionId = 'host-failure-source'
      const routeId = 'host-failure-route'
      const { agent } = await ctx.agents.create({
        sessionId: SessionId(capabilityAuthoringCreatorSessionId(sourceSessionId, routeId)),
        meta: { agentPreset: 'cordis', cwd: root },
        setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'cordis'),
      })
      const followup = vi.spyOn(agent, 'followup').mockImplementation((message) => {
        agent.send(message, 'next-turn', false)
      })
      restoreFollowup = () => { followup.mockRestore() }
      const target = await ctx.blueprintAdapter.read('kaoyan-choose')
      await ctx.blueprintAdapter.setConversationContext({
        sessionId: String(agent.id),
        capabilityAuthoring: recordDurableCapabilityRoute(ctx, {
          routeId, sourceSessionId, target, kind: 'skill', request: '新增 CSV Skill',
        }),
      })
      await expect(ctx.blueprintAdapter.setConversationContext({
        sessionId: String(agent.id), capabilityAuthoringEnd: { outcome: 'failed' },
      })).rejects.toThrow('internal capability failures are Host-owned')
      expect(agent.session.events.filter(event => event.type === 'blueprint/capability-authoring'
        && event.data.state === 'ended')).toEqual([])
      expect((await ctx.blueprintAdapter.setConversationContext({
        sessionId: String(agent.id), recoverCapabilityAuthoring: true,
      })).capabilityAuthoringRecord).toMatchObject({
        routeId, sourceSessionId, state: 'active',
      })
    } finally {
      restoreFollowup?.()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['mounted', 'standard-mounted', 'multiple', 'no-delta', 'file-only', 'inherited-only', 'not-callable', 'broken-mount',
    'existing-definition-mutated', 'non-target-mutated', 'target-metadata-mutated', 'cancelled'] as const)(
    'settles background Skill authoring from durable evidence: %s', async (scenario) => {
      const root = await mkdtemp(join(tmpdir(), 'dsh-skill-terminal-'))
      const presetIds = scenario === 'non-target-mutated'
        ? ['cordis', 'kaoyan-choose', 'unrelated-agent'] : ['cordis', 'kaoyan-choose']
      for (const presetId of presetIds) {
        await mkdir(join(root, presetId))
        const baseline = scenario === 'standard-mounted' && presetId === 'kaoyan-choose'
          ? `${composition()}${standardFilesystemSkillCompositionRows(false)}`
          : composition()
        await writeFile(join(root, presetId, 'agent.cordis.yml'), baseline)
      }
      if (scenario === 'standard-mounted') {
        const baselineSkill = join(root, '.agents', 'skills', 'baseline-local')
        await mkdir(baselineSkill, { recursive: true })
        await writeFile(join(baselineSkill, 'SKILL.md'), filesystemSkillDefinition('baseline-local'))
      }
      const ctx = await harness(root, 0)
      try {
        const sourceSessionId = `source-skill-${scenario}`
        const routeId = `skill-${scenario}`
        const { agent } = await ctx.agents.create({
          sessionId: SessionId(capabilityAuthoringCreatorSessionId(sourceSessionId, routeId)),
          meta: { agentPreset: 'cordis', cwd: root },
          setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'cordis'),
        })
        const target = await ctx.blueprintAdapter.read('kaoyan-choose', { cwd: root })
        await ctx.blueprintAdapter.setConversationContext({
          sessionId: String(agent.id),
          capabilityAuthoring: recordDurableCapabilityRoute(ctx, {
            routeId, sourceSessionId, target, kind: 'skill', request: '增加 CSV 财报 Skill',
          }),
        })
        const candidatePath = await candidatePresetPath(ctx, agent, 'kaoyan-choose')
        const candidateRoot = dirname(candidatePath)
        const start = agent.session.events.find(event => event.type === 'blueprint/capability-authoring')!
        const baselineSkillNames = start.data.baselineSkills.map(skill => skill.name)
        if (scenario === 'standard-mounted') {
          expect(baselineSkillNames).toEqual(expect.arrayContaining([
            'baseline-local', 'global-review', 'source-audit',
          ]))
        } else {
          expect(baselineSkillNames).toEqual(['global-review', 'source-audit'])
        }
        claimCapabilityInput(agent, 1)
        const active = await ctx.blueprintAdapter.setConversationContext({
          sessionId: String(agent.id), recoverCapabilityAuthoring: true,
        })
        expect(active.capabilityAuthoringRecord?.state).toBe('active')
        if (scenario === 'mounted' || scenario === 'standard-mounted' || scenario === 'multiple' || scenario === 'not-callable'
          || scenario === 'existing-definition-mutated' || scenario === 'non-target-mutated'
          || scenario === 'target-metadata-mutated') {
          const base = scenario === 'existing-definition-mutated'
            ? composition().replace('只接受可核实的院校官方来源。', '接受未经核验的第三方来源。')
            : scenario === 'standard-mounted'
              ? `${composition()}${standardFilesystemSkillCompositionRows(true)}`
              : composition()
          await writeFile(candidatePath, scenario === 'standard-mounted'
            ? base
            : `${base}${filesystemSkillCompositionRows()}`)
          const csvSkill = join(candidateRoot, 'skills', 'csv-metrics')
          await mkdir(csvSkill, { recursive: true })
          await writeFile(join(csvSkill, 'SKILL.md'), filesystemSkillDefinition(
            'csv-metrics', scenario !== 'not-callable',
          ))
          if (scenario === 'multiple') {
            const ratioSkill = join(candidateRoot, 'skills', 'ratio-metrics')
            await mkdir(ratioSkill, { recursive: true })
            await writeFile(join(ratioSkill, 'SKILL.md'), filesystemSkillDefinition('ratio-metrics'))
          }
          if (scenario === 'non-target-mutated') {
            await writeFile(join(root, 'unrelated-agent', 'agent.cordis.yml'), composition()
              .replace(OLD_BEHAVIORS[0]!, '改写非目标 Agent 的既有规则。'))
          }
          if (scenario === 'target-metadata-mutated') {
            await writeFile(join(candidateRoot, 'preset.yml'), 'name: 改写后的目标 Agent\n')
          }
        } else if (scenario === 'file-only') {
          await writeFile(join(candidateRoot, 'SKILL.md'), '# CSV metrics\nRead CSV.\n')
        } else if (scenario === 'inherited-only') {
          ctx.skills.register({ name: 'csv-metrics', description: 'Read CSV', content: 'Read CSV', source: 'runtime' })
        } else if (scenario === 'broken-mount') {
          await writeFile(candidatePath, 'invalid: [')
        }
        const read = vi.spyOn(ctx.blueprintAdapter, 'read')
        const end = agent.session.append('turn/end', { turn: 1, reason: scenario === 'cancelled'
          ? { kind: 'aborted', reason: { kind: 'user' } } : { kind: 'completed' } })
        // No browser or conversation window is involved; the Host listener owns settlement.
        await vi.waitFor(() => {
          expect(agent.session.events.filter(event => (
            event.type === 'blueprint/capability-authoring' && event.data.state === 'ended'
          ))).toHaveLength(1)
        })
        const readsAtSettlement = read.mock.calls.length
        const recovered = await Promise.all([1, 2].map(() => ctx.blueprintAdapter.setConversationContext({
          sessionId: String(agent.id), recoverCapabilityAuthoring: true,
        })))
        const outcome = scenario === 'mounted' || scenario === 'standard-mounted'
          ? 'completed'
          : scenario === 'cancelled' ? 'cancelled' : 'failed'
        expect(recovered[0]?.capabilityAuthoringRecord).toMatchObject({
          targetPresetId: 'kaoyan-choose', state: 'ended', outcome,
        })
        expect(recovered[0]?.capabilityAuthoring).toBeUndefined()
        expect(read).toHaveBeenCalledTimes(readsAtSettlement)
        const terminal = agent.session.events.filter(event => event.type === 'blueprint/capability-authoring'
          && event.data.state === 'ended')
        expect(terminal).toHaveLength(1)
        if (scenario === 'mounted' || scenario === 'standard-mounted') {
          const event = terminal[0]
          if (event?.type !== 'blueprint/capability-authoring' || event.data.state !== 'ended') {
            throw new Error('Missing Skill terminal event')
          }
          const evidence = event.data.skillEvidence
          expect(evidence?.turnEndSeq).toBe(end.seq)
          expect(evidence?.skills).toHaveLength(1)
          expect(evidence?.skills[0]).toMatchObject({ name: 'csv-metrics', invocation: { modelInvocable: true } })
          expect(evidence?.skills[0]?.definitionDigest).toMatch(/^[0-9a-f]{64}$/u)
          if (scenario === 'standard-mounted') {
            expect(evidence?.verification).toMatchObject({
              presetId: 'kaoyan-choose', valid: true, overall: 'pass',
            })
            expect(evidence?.verification.sessionId).not.toBe(sourceSessionId)
            expect((await ctx.blueprintAdapter.read('kaoyan-choose', { cwd: root })).runtime.skills
              .map(skill => skill.name).sort()).toEqual([...baselineSkillNames, 'csv-metrics'].sort())
          }
        } else {
          expect(terminal[0]?.data).not.toHaveProperty('skillEvidence')
          if (outcome === 'failed') {
            const event = terminal[0]
            if (event?.type !== 'blueprint/capability-authoring' || event.data.state !== 'ended') {
              throw new Error('Missing exhausted Skill terminal event')
            }
            expect(event.data.capabilityFailure).toMatchObject({ attempt: 0 })
            expect(typeof event.data.capabilityFailure?.message).toBe('string')
            expect(event.data.candidateDisposition).toMatchObject({ disposition: 'discarded' })
            expect(recovered[0]?.capabilityAuthoringRecord).not.toHaveProperty('capabilityFailure')
            expect(recovered[0]?.capabilityAuthoringRecord).not.toHaveProperty('candidateDisposition')
            expect(await readFile(join(root, 'kaoyan-choose', 'agent.cordis.yml'), 'utf8')).toBe(composition())
          } else {
            const event = terminal[0]
            if (event?.type !== 'blueprint/capability-authoring' || event.data.state !== 'ended') {
              throw new Error('Missing explicitly cancelled Skill terminal event')
            }
            expect(event.data).toMatchObject({
              routeId, outcome: 'cancelled',
              capabilityFailure: { turnEndSeq: end.seq, attempt: 0, prerequisite: 'cancelled' },
              candidateDisposition: { disposition: 'discarded' },
            })
            expect(agent.session.events.filter(candidate => candidate.type === 'blueprint/capability-repair')).toEqual([])
            expect(await readFile(join(root, 'kaoyan-choose', 'agent.cordis.yml'), 'utf8')).toBe(composition())
          }
        }
        const conflictingEnd = await ctx.blueprintAdapter.setConversationContext({
          sessionId: String(agent.id), capabilityAuthoringEnd: { outcome: 'completed' },
        })
        expect(conflictingEnd.capabilityAuthoringRecord?.outcome).toBe(outcome)
      } finally {
        await ctx.fiber.dispose()
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it('recovers one durable successful Change Set into a restarted kaoyan-choose Agent assembly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-blueprint-conformance-'))
    const presetDir = join(root, 'kaoyan-choose')
    await mkdir(presetDir)
    await writeFile(join(presetDir, 'agent.cordis.yml'), composition(), 'utf8')
    const ctx = await harness(root)
    let restarted: Context | undefined
    try {
      const before = await ctx.blueprintAdapter.read('kaoyan-choose')
      expect(before.nodes).toContainEqual(expect.objectContaining({
        id: 'capability:skill:source-audit', source: 'preset', editable: false,
      }))
      expect(before.nodes).toContainEqual(expect.objectContaining({
        id: 'capability:skill:global-review', source: 'inherited', editable: false,
      }))
      const confirmation = await ctx.agents.create({
        sessionId: SessionId('kaoyan-confirmation'), meta: { agentPreset: 'kaoyan-choose' },
        setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'kaoyan-choose'),
      })
      const result = await ctx.blueprintAdapter.applyChangeSet(recordDurableProposal(
        confirmation.agent,
        before,
        'kaoyan-runtime',
        [
          {
            operation: 'updateIdentity', targetNodeId: 'identity:persona',
            expected: '考研择校助手', value: '保研申请顾问',
          },
          ...OLD_BEHAVIORS.map((expected, index) => ({
            operation: 'updateBehavior' as const,
            targetNodeId: `behavior:${String(index + 1)}`,
            expected,
            value: NEW_BEHAVIORS[index]!,
          })),
        ],
      ))
      expect(result.status).toBe('committed')
      expect(result.committedRevision).toBeDefined()

      restarted = await harness(root)
      restarted.sessions.create(SessionId(result.sourceSessionId), {
        seed: structuredClone(confirmation.agent.session.events),
        meta: { agentPreset: 'kaoyan-choose' },
      })
      const handle = await restarted.agents.create({
        sessionId: SessionId('kaoyan-trial'),
        meta: { agentPreset: 'kaoyan-choose' },
        setup: async agentCtx => void await restarted!.agentPresets.mount(agentCtx, 'kaoyan-choose'),
      })
      const validation = await restarted.blueprintAdapter.validateSession({
        sessionId: String(handle.agent.session.id),
        presetId: 'kaoyan-choose',
        expectedRevision: result.committedRevision!,
        sourceSessionId: result.sourceSessionId,
        routeId: result.routeId,
        changeSetId: result.changeSetId,
      })

      expect(validation).toMatchObject({
        valid: true,
        overall: 'pass',
        binding: {
          status: 'pass',
          sessionPresetId: 'kaoyan-choose',
          composedPresetId: 'kaoyan-choose',
          strictRevisionBound: false,
        },
        prompt: { status: 'pass' },
        tools: { status: 'pass', missing: [], unexpected: [], schemaMismatches: [] },
        skills: { status: 'pass', missing: [], unexpected: [] },
        delegations: { status: 'pass', evidence: [] },
        permissions: { status: 'pass' },
        changeReceipt: {
          changeSetId: 'kaoyan-runtime',
          runtime: {
            prompt: 'pass', tools: 'pass', skills: 'pass', delegations: 'pass',
            permissions: 'pass', overall: 'pass',
          },
        },
      })
      expect(validation.prompt.evidence.filter(item => item.nodeType === 'behavior'))
        .toHaveLength(4)
      expect(validation.prompt.evidence.find(item => item.nodeId === 'identity:persona'))
        .toMatchObject({ status: 'pass' })
      expect(validation.tools.evidence).toEqual(expect.arrayContaining([
        expect.objectContaining({ nodeId: 'capability:web-search', actualPresent: true, status: 'pass' }),
        expect.objectContaining({ nodeId: 'capability:web-fetch', actualPresent: false, status: 'pass' }),
      ]))
      const foreignReceipt = await restarted.blueprintAdapter.validateSession({
        sessionId: String(handle.agent.session.id),
        presetId: 'kaoyan-choose',
        expectedRevision: result.committedRevision!,
        sourceSessionId: 'foreign-source-session',
        routeId: result.routeId,
        changeSetId: result.changeSetId,
      })
      expect(foreignReceipt.changeReceipt).toBeUndefined()
      await expect(restarted.blueprintAdapter.validateSession({
        sessionId: String(handle.agent.session.id),
        presetId: 'kaoyan-choose',
        expectedRevision: result.committedRevision!,
        changeSetId: result.changeSetId,
      } as unknown as BlueprintValidateSessionRequest)).rejects.toThrow(/requires sourceSessionId, routeId, and changeSetId together/u)
    } finally {
      await restarted?.fiber.dispose()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
