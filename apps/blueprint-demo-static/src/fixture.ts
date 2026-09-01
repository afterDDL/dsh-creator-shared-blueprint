/** Blueprint-only in-memory carrier used by the static public Demo. */
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  ClientRequest, ClientResponse, HostFrame, ModelProviderGroup, ModelSelection, MuxFrame,
  RpcReceipt, RpcRequest, RpcResponse, ServerResponse, SessionSummary,
  WorkspaceId, WorkspaceView,
} from '../../../packages/client/connection/src/client/api.ts'
import { AbstractApiClient, RpcId } from '../../../packages/client/connection/src/client/api.ts'
import type { RequestPayload, ResponseValue, RpcMethodMap } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ClientConnectionRpc } from '../../../packages/client/connection/src/rpc.ts'
import {
  BlueprintDemoSessionPlayer, creatorEventFixtures, creatorInteractionFixtures, toolStep,
} from '../../../packages/client/connection/src/client/blueprint-demo-events.ts'
import type { SessionEventFixture } from '../../../packages/client/connection/src/client/blueprint-demo-events.ts'

const DEMO_CWD = '/workspace'

function sid(value: string): SessionId {
  return value as SessionId
}

function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/** One abort-aware in-memory stream queue. */
class FrameQueue<Frame> {
  private readonly frames: RpcRequest<Frame>[] = []
  private wake: (() => void) | undefined

  push(frame: RpcRequest<Frame>): void {
    this.frames.push(frame)
    this.wake?.()
  }

  async *drain(signal: AbortSignal): AsyncGenerator<RpcRequest<Frame>> {
    const wake = (): void => { this.wake?.() }
    signal.addEventListener('abort', wake)
    try {
      while (!signal.aborted) {
        while (this.frames.length > 0) yield this.frames.shift() as RpcRequest<Frame>
        if (signal.aborted) break
        await new Promise<void>((resolve) => { this.wake = resolve })
        this.wake = undefined
      }
    } finally {
      signal.removeEventListener('abort', wake)
    }
  }
}

interface DemoQuestion {
  rpcId: RpcId
  sessionId: SessionId
  turn: number
  step: number
  callId: string
  questions: Extract<MuxFrame, { type: 'question/requested' }>['questions']
  resolve(answer: unknown): void
}

const MODEL_GROUPS: ModelProviderGroup[] = [{
  id: 'deepseek-official',
  name: 'DeepSeek',
  models: [{
    id: 'deepseek-v4-flash',
    name: 'DeepSeek-V4-Flash',
    description: '快速响应',
    reasoning: {
      efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }],
      defaultEffort: 'high',
    },
  }],
}]

/** Minimal static carrier containing only the accepted Blueprint Demo sessions and scripts. */
export class FixtureApiClient extends AbstractApiClient {
  private nextRpc = 1
  private nextSession = 1
  private attachedSessions = 0
  private readonly sessionSummaries: SessionSummary[] = []
  private readonly logs = new Map<SessionId, SessionEvent[]>()
  private readonly models = new Map<SessionId, ModelSelection>()
  private readonly muxQueues = new Set<FrameQueue<MuxFrame>>()
  private readonly hostQueues = new Set<FrameQueue<HostFrame>>()
  private readonly questions = new Map<string, DemoQuestion>()
  private readonly player = new BlueprintDemoSessionPlayer((sessionId, event) => {
    this.appendFixture(sessionId, event)
  })
  private capabilities = { csvSkill: false, industrySubagent: false }
  private readonly workspaceView: WorkspaceView = {
    workspaceId: 'blueprint-demo' as WorkspaceId,
    path: DEMO_CWD,
    title: 'fixture',
    sessionIds: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }

  /** Remote channels are deliberately absent from the static Demo assembly. */
  readonly rpc: ClientConnectionRpc = {
    call: (_channel, endpoint) => endpoint === 'commands/list'
      ? Promise.resolve({ ok: true, value: { commands: [] } })
      : Promise.reject(new Error(`static Blueprint Demo Remote endpoint is unavailable: ${endpoint}`)),
  }

  constructor() {
    super()
    const initialSessionId = sid('blueprint-demo-0')
    this.sessionSummaries.push({
      sessionId: initialSessionId,
      updatedAt: Date.now(),
      running: false,
      blank: true,
      cwd: DEMO_CWD,
      agentPreset: 'cordis',
    })
    this.logs.set(initialSessionId, [
      { seq: 0, time: Date.now(), type: 'permission/preset', data: { preset: 'danger-full-access' } },
      { seq: 1, time: Date.now(), type: 'sandbox/mode', data: { mode: 'danger-full-access' } },
      { seq: 2, time: Date.now(), type: 'approval/policy', data: { policy: 'never' } },
    ] as SessionEvent[])
    this.models.set(initialSessionId, {
      provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high',
    })
    this.workspaceView.sessionIds = [initialSessionId]
    this.attachedSessions = 1
    globalThis.__dshBlueprintDemoFixture = {
      completePurpose: (sessionId) => { this.completePurpose(sid(sessionId)) },
      setCapabilities: (value) => { this.capabilities = { ...value } },
    }
  }

  protected doFetch(): Promise<Response> {
    throw new Error('static Blueprint Demo has no fetch transport')
  }

  private mint(): RpcId {
    return RpcId(`blueprint-static-${String(this.nextRpc++)}`)
  }

  private request<Payload>(payload: Payload): RpcRequest<Payload> {
    return { rpcId: this.mint(), payload }
  }

  private ok<Payload, Value>(request: RpcRequest<Payload>, value: Value): Promise<RpcResponse<Value>> {
    return Promise.resolve({ rpcId: request.rpcId, result: { ok: true, value } })
  }

  private error<Payload, Value>(request: RpcRequest<Payload>, code: 'session-not-found' | 'internal', message: string): Promise<RpcResponse<Value>> {
    return Promise.resolve({ rpcId: request.rpcId, result: { ok: false, error: { code, message, details: {} } } })
  }

  private emitMux(payload: MuxFrame, rpcId = this.mint()): void {
    for (const queue of this.muxQueues) queue.push({ rpcId, payload })
  }

  private emitHost(payload: HostFrame): void {
    for (const queue of this.hostQueues) queue.push({ rpcId: this.mint(), payload })
  }

  private summary(sessionId: SessionId): SessionSummary | undefined {
    return this.sessionSummaries.find(candidate => candidate.sessionId === sessionId)
  }

  private setRunning(sessionId: SessionId, running: boolean): void {
    const summary = this.summary(sessionId)
    if (summary === undefined || summary.running === running) return
    summary.running = running
    this.emitHost({ type: 'host/session-status', sessionId, running })
  }

  private append(sessionId: SessionId, value: Omit<SessionEvent, 'seq' | 'time'>): void {
    const log = this.logs.get(sessionId) ?? []
    if (!this.logs.has(sessionId)) this.logs.set(sessionId, log)
    const event = { ...value, seq: log.length, time: Date.now() } as SessionEvent
    log.push(event)
    this.emitMux({ type: 'session/event', sessionId, event })
  }

  private appendFixture(sessionId: SessionId, event: SessionEventFixture): void {
    this.append(sessionId, event as Omit<SessionEvent, 'seq' | 'time'>)
  }

  private assistant(sessionId: SessionId, turn: number, step: number, content: ContentBlock[]): void {
    this.appendFixture(sessionId, creatorEventFixtures.stepStart(turn, step))
    this.appendFixture(sessionId, creatorEventFixtures.assistant(turn, step, content))
  }

  private tool(
    sessionId: SessionId,
    turn: number,
    step: number,
    name: string,
    args: Record<string, unknown>,
    result: string,
    meta?: unknown,
  ): void {
    for (const item of toolStep(0, turn, step, name, args, result, meta)) {
      this.appendFixture(sessionId, item.event)
    }
  }

  private finish(sessionId: SessionId, turn: number, step: number, body: string): void {
    this.assistant(sessionId, turn, step, text(body))
    this.appendFixture(sessionId, creatorEventFixtures.stepEnd(turn, step))
    this.appendFixture(sessionId, creatorEventFixtures.turnEnd(turn, { kind: 'completed' }))
    this.setRunning(sessionId, false)
  }

  private startCreator(sessionId: SessionId, turn: number): void {
    this.assistant(sessionId, turn, 0, [{ type: 'reasoning', text: '先把需求拆成角色、研究目标、资料能力、工作规则与输出结构，再创建独立 preset。' }])
    this.appendFixture(sessionId, creatorEventFixtures.stepEnd(turn, 0))
    this.player.schedule(1_000, () => {
      this.tool(sessionId, turn, 1, 'preset_copy', { from: 'standard', id: 'listed-company-research' }, '已建立上市公司研究 Agent 的独立结构。')
    })
    this.player.schedule(2_200, () => {
      const questions = [{
        id: 'research-use', header: '用途', question: '你希望研究结果更偏向哪种用途？',
        options: [
          { label: '公司基本面研究 (Recommended)', description: '聚焦业务、财务、估值和风险因素。' },
          { label: '行业比较', description: '重点对比主要玩家与竞争格局。' },
          { label: '投资研究', description: '加强估值情景与风险观察。' },
        ],
      }]
      const step = 2
      const callId = `blueprint-${String(turn)}-${String(step)}-ask_user_question`
      const args = { questions }
      this.assistant(sessionId, turn, step, [{ type: 'tool-call', id: callId, name: 'ask_user_question', arguments: JSON.stringify(args) } as ContentBlock])
      this.appendFixture(sessionId, creatorEventFixtures.toolCall(turn, step, callId, 'ask_user_question', args))
      const rpcId = this.mint()
      this.questions.set(String(rpcId), {
        rpcId, sessionId, turn, step, callId, questions,
        resolve: (answer) => {
          this.assistant(sessionId, turn, 3, text('已记下你的选择。我会继续补全研究能力、执行规则和结构化输出。'))
          this.appendFixture(sessionId, creatorEventFixtures.stepEnd(turn, 3))
          this.player.schedule(1_500, () => { this.tool(sessionId, turn, 4, 'cordis_define', { type: 'agent-preset', id: 'listed-company-research', answer }, '已定义公开资料检索、财报读取和研究规则。') })
          this.player.schedule(3_500, () => { this.tool(sessionId, turn, 5, 'write', { file_path: '.agent-presets/listed-company-research/cordis.yml', content: 'purpose, behaviors, outputs' }, '已补全目标、规则与输出结构。') })
          this.player.schedule(5_000, () => { this.tool(sessionId, turn, 6, 'preset_validate', { id: 'listed-company-research' }, '验证通过。') })
          this.player.schedule(6_500, () => { this.finish(sessionId, turn, 7, '上市公司研究 Agent 已创建完成。你可以在右侧继续调整目标、添加专用 Skill 或协作 Agent，也可以直接试用。') })
        },
      })
      this.emitMux(creatorInteractionFixtures.questionRequested(sessionId, questions), rpcId)
    })
  }

  private startPurpose(sessionId: SessionId, turn: number): void {
    this.assistant(sessionId, turn, 0, text('明白。我会把“不提供投资建议”设为明确边界，并同步检查规则和输出，避免只修改一句目标后留下冲突。'))
    this.appendFixture(sessionId, creatorEventFixtures.stepEnd(turn, 0))
    this.player.schedule(1_600, () => {
      const changeSetId = `blueprint-${String(turn)}-1-propose_blueprint_change`
      const blueprintChangeSet = {
        sourceSessionId: sessionId, routeId: `blueprint-purpose-${String(turn)}`, changeSetId,
        kind: 'direct-edit-reconciliation', presetId: 'listed-company-research', revision: 'demo-r1',
        sourceNodeId: 'purpose:persona', sourceNodeType: 'purpose', sourceLabel: '做什么',
        proposals: [
          { proposalId: 'demo-purpose-1', presetId: 'listed-company-research', revision: 'demo-r1', targetNodeId: 'purpose:persona', operation: 'updatePurpose', currentValue: '研究上市公司的业务、财务表现、估值与行业竞争，并基于公开资料和用户提供的财报形成结构化研究报告。', proposedValue: '研究上市公司的业务、财务表现、估值与行业竞争；仅提供公司研究和估值分析，不提供投资建议。', impact: '明确研究边界，排除投资建议。' },
          { proposalId: 'demo-purpose-2', presetId: 'listed-company-research', revision: 'demo-r1', targetNodeId: 'behavior:3', operation: 'updateBehavior', currentValue: '区分事实、推断和结论，重要判断给出来源。', proposedValue: '区分事实、推断和结论，重要判断给出来源；不得给出买入、卖出或持有建议。', impact: '把边界落实到执行规则。', dependency: '依赖新目标的“不提供投资建议”约束。' },
          { proposalId: 'demo-purpose-3', presetId: 'listed-company-research', revision: 'demo-r1', targetNodeId: 'output:1', operation: 'updateOutput', currentValue: '输出包含公司概览、业务分析、财务分析、估值分析、行业竞争与风险因素的结构化研究报告。', proposedValue: '输出包含公司概览、业务分析、财务分析、估值分析、行业竞争、风险因素与免责声明的结构化研究报告。', impact: '在报告中增加明确免责声明。', dependency: '与新目标和行为规则保持一致。' },
        ],
      }
      this.tool(sessionId, turn, 1, 'propose_blueprint_change', { presetId: 'listed-company-research' }, '已生成 3 项关联调整。', { blueprintChangeSet })
    })
    this.player.schedule(2_000, () => {
      this.appendFixture(sessionId, creatorEventFixtures.turnEnd(turn, { kind: 'completed' }))
      this.setRunning(sessionId, false)
    })
  }

  private startSkill(sessionId: SessionId, turn: number): void {
    this.assistant(sessionId, turn, 0, text('正在判断能力需求，并为当前 Agent 配置 CSV 财务数据分析。'))
    this.appendFixture(sessionId, creatorEventFixtures.stepEnd(turn, 0))
    this.player.schedule(3_000, () => { this.finish(sessionId, turn, 1, 'CSV 财务数据分析已配置完成，现在可以在研究任务中使用。') })
  }

  private startSubagent(sessionId: SessionId, turn: number): void {
    this.assistant(sessionId, turn, 0, text('正在判断能力需求，并为当前 Agent 配置行业研究协作 Agent。'))
    this.appendFixture(sessionId, creatorEventFixtures.stepEnd(turn, 0))
    this.player.schedule(3_000, () => { this.finish(sessionId, turn, 1, '行业研究协作 Agent 已配置完成。主 Agent 可以在研究任务中按需委派。') })
  }

  private startTrial(sessionId: SessionId, turn: number): void {
    this.assistant(sessionId, turn, 0, [{ type: 'reasoning', text: '先检索公开资料并读取财务数据，再按当前 Blueprint 的研究边界形成简短报告。' }])
    this.appendFixture(sessionId, creatorEventFixtures.stepEnd(turn, 0))
    this.player.schedule(1_200, () => { this.tool(sessionId, turn, 1, 'web_search', { query: 'NVIDIA latest annual report business segments revenue public sources' }, '找到 NVIDIA 年报与投资者关系公开资料。') })
    this.player.schedule(2_400, () => { this.tool(sessionId, turn, 2, 'read', { file_path: 'uploads/NVIDIA-annual-report.pdf' }, '已读取用户提供的 NVIDIA 财报摘录。') })
    if (this.capabilities.csvSkill) this.player.schedule(3_600, () => { this.tool(sessionId, turn, 3, 'csv_financial_metrics', { source: 'NVIDIA financial table' }, '已提取营收、净利润、PE 与 PB 指标。') })
    if (this.capabilities.industrySubagent) this.player.schedule(4_800, () => { this.tool(sessionId, turn, 4, 'delegate_industry_research', { company: 'NVIDIA' }, '行业研究协作 Agent 已返回竞争格局摘要。') })
    this.player.schedule(6_500, () => { this.finish(sessionId, turn, 5, '## NVIDIA 简要研究\n\n- **业务**：核心增长由数据中心与加速计算需求驱动，业务集中度较高。\n- **财务**：公开财报显示营收与利润快速增长，但需关注周期性、供给约束与客户集中。\n- **行业竞争**：竞争来自专用加速器、云厂商自研芯片及其他 GPU 供应商。\n- **估值观察**：可结合增长持续性、利润率与资本开支周期进行情景分析。\n\n以上仅用于公司研究和估值分析，不构成任何投资建议。') })
  }

  private completePurpose(sessionId: SessionId): void {
    const log = this.logs.get(sessionId) ?? []
    const turn = log.reduce((maximum, event) => event.type === 'turn/start' ? Math.max(maximum, event.data.turn + 1) : maximum, 0)
    this.append(sessionId, { type: 'turn/start', data: { turn } })
    this.finish(sessionId, turn, 0, '已应用这 3 项修改。目标、执行规则和报告输出现在都明确排除了投资建议。')
  }

  protected override async callUnary<Key extends keyof RpcMethodMap>(
    method: Key,
    payload: RequestPayload<Key>,
    _signal?: AbortSignal,
  ): Promise<RpcResponse<ResponseValue<Key>>> {
    const request = this.request(payload)
    const outgoing: ClientRequest = { type: 'client-request', rpcId: request.rpcId, method, payload }
    this.onEnvelope(outgoing)
    const response = await this.dispatch(method, request as RpcRequest<never>) as RpcResponse<ResponseValue<Key>>
    const incoming: ServerResponse = { type: 'server-response', rpcId: response.rpcId, result: response.result }
    this.onEnvelope(incoming)
    return response
  }

  private dispatch(method: keyof RpcMethodMap, request: RpcRequest<never>): Promise<RpcResponse<unknown>> {
    switch (method) {
      case 'session.list': return this.ok(request, { items: [...this.sessionSummaries].sort((left, right) => right.updatedAt - left.updatedAt) })
      case 'session.search': return this.ok(request, { items: [], hasMore: false })
      case 'session.create': {
        const payload = request.payload as { sessionId?: SessionId; agentPreset?: string }
        const existing = payload.sessionId === undefined ? undefined : this.summary(payload.sessionId)
        if (existing !== undefined) {
          return this.ok(request, {
            sessionId: existing.sessionId,
            ...(existing.agentPreset === undefined ? {} : { agentPreset: existing.agentPreset }),
          })
        }
        const sessionId = payload.sessionId ?? sid(`blueprint-demo-${String(this.nextSession++)}`)
        const summary: SessionSummary = {
          sessionId, updatedAt: Date.now(), running: false, blank: true, cwd: DEMO_CWD,
          ...(payload.agentPreset === undefined ? {} : { agentPreset: payload.agentPreset }),
        }
        this.sessionSummaries.push(summary)
        this.models.set(sessionId, { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' })
        this.logs.set(sessionId, [
          { seq: 0, time: Date.now(), type: 'permission/preset', data: { preset: 'danger-full-access' } },
          { seq: 1, time: Date.now(), type: 'sandbox/mode', data: { mode: 'danger-full-access' } },
          { seq: 2, time: Date.now(), type: 'approval/policy', data: { policy: 'never' } },
        ] as SessionEvent[])
        this.workspaceView.sessionIds = [sessionId, ...this.workspaceView.sessionIds]
        this.attachedSessions += 1
        this.emitHost({ type: 'host/session-added', sessionId, blank: true, cwd: DEMO_CWD })
        this.emitHost({ type: 'host/workspace-changed', workspace: { ...this.workspaceView } })
        return this.ok(request, { sessionId, ...(payload.agentPreset === undefined ? {} : { agentPreset: payload.agentPreset }) })
      }
      case 'session.history': {
        const payload = request.payload as { sessionId: SessionId }
        const events = this.logs.get(payload.sessionId) ?? []
        return this.ok(request, {
          events: events.map(event => ({ event })),
          hasMore: false,
          projections: {
            asOfSeq: events.length - 1,
            values: {
              todos: null,
              permissions: {
                options: [
                  { value: 'workspace-write', name: 'workspace-write', description: 'Write inside the workspace and ask before wider access.' },
                  { value: 'danger-full-access', name: 'danger-full-access', description: 'Full file access without approval prompts.' },
                ],
                currentValue: 'danger-full-access',
              },
              plan: { active: false, pending: false },
              goal: null,
              tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
              contextPressure: {},
              contextBreakdown: { systemTokens: 0, toolsTokens: 0, messageTokens: 0 },
              sessionStats: { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 },
              imageLimits: {
                maxImageBytes: 5 * 1024 * 1024,
                maxImagesPerMessage: 20,
                maxMessageImageBytes: 100 * 1024 * 1024,
                maxImagePixels: 40_000_000,
                mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
              },
            },
          },
        })
      }
      case 'session.models': {
        const payload = request.payload as { sessionId: SessionId }
        return this.ok(request, {
          current: this.models.get(payload.sessionId) ?? {
            provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high',
          },
          routable: true,
          groups: MODEL_GROUPS,
          failures: [],
        })
      }
      case 'session.selectModel': {
        const payload = request.payload as {
          sessionId: SessionId
          provider: string
          model: string
          reasoningEffort?: string
        }
        const selected = {
          provider: payload.provider,
          model: payload.model,
          ...(payload.reasoningEffort === undefined ? {} : { reasoningEffort: payload.reasoningEffort }),
        }
        this.models.set(payload.sessionId, selected)
        return this.ok(request, { selected })
      }
      case 'session.prompt': {
        const payload = request.payload as { sessionId: SessionId; content: ContentBlock[] }
        const summary = this.summary(payload.sessionId)
        if (summary === undefined) return this.error(request, 'session-not-found', `Unknown Demo Session ${payload.sessionId}`)
        const log = this.logs.get(payload.sessionId) ?? []
        const turn = log.reduce((maximum, event) => event.type === 'turn/start' ? Math.max(maximum, event.data.turn + 1) : maximum, 0)
        this.append(payload.sessionId, { type: 'turn/start', data: { turn } })
        this.append(payload.sessionId, { type: 'user/message', surfaceOp: 'append', data: createUserMessage({ content: payload.content, source: { kind: 'user' } }) })
        summary.blank = false
        summary.running = true
        summary.updatedAt = Date.now()
        this.emitHost({ type: 'host/session-status', sessionId: payload.sessionId, running: true })
        const userText = payload.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
        if (/不(?:希望它)?给投资建议|不提供投资建议/u.test(userText)) this.startPurpose(payload.sessionId, turn)
        else if (/CSV.*财务数据|财务数据.*PE.*PB/iu.test(userText)) this.startSkill(payload.sessionId, turn)
        else if (/协作 Agent|行业竞争分析协作者|行业和竞争格局研究|市场规模.*主要玩家.*竞争格局/u.test(userText)) this.startSubagent(payload.sessionId, turn)
        else if (/NVIDIA|英伟达/iu.test(userText)) this.startTrial(payload.sessionId, turn)
        else this.startCreator(payload.sessionId, turn)
        return this.ok(request, { accepted: true })
      }
      case 'session.cancel': return this.ok(request, { accepted: true })
      case 'session.updateQueue': return this.ok(request, { accepted: true })
      case 'session.rename': return this.ok(request, { title: (request.payload as { title: string }).title, seq: 0 })
      case 'session.fork': return this.error(request, 'internal', 'Fork is unavailable in the static Demo')
      case 'session.attachment': return this.error(request, 'internal', 'Attachments are unavailable in the static Demo')
      case 'subagent.list': return this.ok(request, { entries: [], parentAvailable: true })
      case 'subagent.history': return this.ok(request, { events: [], hasMore: false })
      case 'subagent.prompt': return this.error(request, 'internal', 'Subagent prompting is unavailable in the static Demo')
      case 'subagent.interrupt': return this.ok(request, { accepted: true })
      case 'host.describe': return this.ok(request, { version: 'static-demo', cwd: DEMO_CWD, attachedSessions: this.attachedSessions, canOpenPath: false })
      case 'host.pickDirectory': return this.ok(request, { path: null })
      case 'host.listDirectory': return this.ok(request, { path: DEMO_CWD, home: DEMO_CWD, crumbs: [{ name: 'workspace', path: DEMO_CWD, hidden: false }], entries: [], truncated: false })
      case 'host.createDirectory': return this.error(request, 'internal', 'Directory writes are unavailable in the static Demo')
      case 'host.openPath': return this.error(request, 'internal', 'Path opening is unavailable in the static Demo')
      case 'workspace.list': return this.ok(request, { items: [{ ...this.workspaceView }], archivedSessionIds: [] })
      case 'workspace.create': return this.ok(request, { workspace: { ...this.workspaceView }, created: false })
      case 'workspace.rename': return this.ok(request, { workspace: { ...this.workspaceView } })
      case 'workspace.delete': return this.ok(request, { deleted: true })
      case 'workspace.insertBefore': return this.ok(request, { workspaceIds: [this.workspaceView.workspaceId] })
      case 'workspace.insertSessionBefore': return this.ok(request, { workspace: { ...this.workspaceView } })
      case 'workspace.archiveSession': return this.ok(request, { archivedSessionIds: [] })
      case 'skill.list': return this.ok(request, { skills: [] })
      case 'agentPreset.list': return this.ok(request, { presets: [
        { id: 'cordis', trust: 'system', isDefault: true },
        { id: 'listed-company-research', name: '上市公司研究 Agent', trust: 'user', isDefault: false },
      ], authorable: false, hasDocument: false })
      case 'agentPreset.select': return this.ok(request, { agentPreset: (request.payload as { agentPreset: string }).agentPreset })
      case 'agentPreset.read': return this.ok(request, { agentPreset: (request.payload as { agentPreset: string }).agentPreset, trust: 'user', content: '' })
      case 'agentPreset.copy': return this.error(request, 'internal', 'Preset authoring is unavailable in the static Demo')
      case 'agentPreset.openDocument': return this.error(request, 'internal', 'Preset documents are unavailable in the static Demo')
      case 'agentPreset.remove': return this.error(request, 'internal', 'Preset removal is unavailable in the static Demo')
      case 'goal.create': case 'goal.edit': case 'goal.pause': case 'goal.resume': case 'goal.complete': case 'goal.clear':
        return this.error(request, 'internal', 'Goals are unavailable in the static Demo')
      case 'settings.describe': return this.ok(request, { writable: false, hasDocument: false, namespaces: [{ ns: 'ui-onboarding', schema: {}, value: { welcomeNoticeVersion: '2026-08-13.1' }, applies: 'live', secrets: [], revision: 0 }] })
      case 'settings.openDocument': return this.error(request, 'internal', 'Settings documents are unavailable in the static Demo')
      case 'settings.update': case 'settings.replace': case 'settings.mutate': return this.error(request, 'internal', 'Settings writes are unavailable in the static Demo')
      case 'credentials.describe': return this.ok(request, { credentials: {} })
      case 'credentials.set': case 'credentials.unset': return this.error(request, 'internal', 'Credentials are unavailable in the static Demo')
      case 'llm.providers': return this.ok(request, { providers: [] })
      case 'llm.models': return this.ok(request, { groups: MODEL_GROUPS, failures: [] })
      case 'llm.discoverModels': return this.ok(request, { models: MODEL_GROUPS[0]?.models ?? [] })
    }
  }

  protected override openMux(
    _payload: { since?: Record<SessionId, number> },
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    const queue = new FrameQueue<MuxFrame>()
    this.muxQueues.add(queue)
    onOpen?.()
    const source = queue.drain(signal)
    const queues = this.muxQueues
    return (async function* (): AsyncGenerator<RpcRequest<MuxFrame>> {
      try { yield* source } finally { queues.delete(queue) }
    })()
  }

  protected override openHost(
    _payload: Record<never, never>,
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    const queue = new FrameQueue<HostFrame>()
    this.hostQueues.add(queue)
    onOpen?.()
    const source = queue.drain(signal)
    const queues = this.hostQueues
    return (async function* (): AsyncGenerator<RpcRequest<HostFrame>> {
      try { yield* source } finally { queues.delete(queue) }
    })()
  }

  override respond(message: ClientResponse): Promise<RpcReceipt> {
    this.onEnvelope(message)
    const question = this.questions.get(String(message.rpcId))
    if (question === undefined) return Promise.resolve({ accepted: false, reason: 'not-pending' })
    const submitted = message.result.ok ? (message.result.value as { answer?: unknown }).answer : undefined
    const answer = submitted ?? { answers: [{ id: 'research-use', selected: ['公司基本面研究 (Recommended)'] }] }
    this.emitMux(creatorInteractionFixtures.questionResolved(
      question.sessionId,
      question.rpcId,
      message.result.ok ? 'answered' : 'cancelled',
    ))
    this.appendFixture(question.sessionId, creatorEventFixtures.toolResult(
      question.turn, question.step, question.callId, JSON.stringify(answer),
    ))
    this.appendFixture(question.sessionId, creatorEventFixtures.stepEnd(question.turn, question.step))
    question.resolve(answer)
    this.questions.delete(String(message.rpcId))
    return Promise.resolve({ accepted: true })
  }
}

declare global {
  // The static fixture owns this Demo-only bridge; no runtime service is exposed.
  var __dshBlueprintDemoFixture: {
    completePurpose(sessionId: string): void
    setCapabilities(value: { csvSkill: boolean; industrySubagent: boolean }): void
  } | undefined
}
