/** Deterministic Demo orchestration kept outside the production UI components. */
import type { BlueprintChangeSet } from '@deepseek-ai/dsh-shared-blueprint/contract'
import type { ClientContext, ConversationSnapshot, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  BlueprintCreatorObservation, BlueprintDemoFlowState, BlueprintTrialRequest,
} from './controller.ts'
import type { BlueprintUiController } from './controller.ts'
import type { BlueprintDemoSeed, InMemoryBlueprintDemoAdapter } from './demo-adapter.ts'

/** Browser fixture hooks that complete scripted Session-side milestones. */
export interface BlueprintDemoFixtureBridge {
  completePurpose(sessionId: string): void
  setCapabilities(value: { csvSkill: boolean; industrySubagent: boolean }): void
}

/** Scenario state that is independent from the Blueprint and conversation renderers. */
export interface DemoScenarioState {
  lifecycle: 'idle' | 'creating' | 'ready' | 'applying' | 'authoring' | 'testing' | 'complete'
  creator: {
    sessionId: SessionId | null
    projection: 'absent' | 'identity-purpose' | 'without-output' | 'complete'
  }
  blueprint: { presetId: string; selectedNodeId: string | null }
  proposal: { status: 'idle' | 'presented' | 'applying' | 'applied'; applyingNodeIds: readonly string[] }
  capabilityAuthoring: {
    active: 'skill' | 'subagent' | null
    publishing: 'skill' | 'subagent' | null
    installed: { skill: boolean; subagent: boolean }
  }
  testSession: { sessionId: SessionId | null; status: 'idle' | 'running' | 'verified' }
}

/** External operations retained by the Web assembly while the scenario controller owns sequencing. */
export interface DemoScenarioDependencies {
  ctx: ClientContext
  blueprint: BlueprintUiController
  adapter: InMemoryBlueprintDemoAdapter
  creatorScenario: BlueprintDemoSeed
  createSession(presetId: string, open?: boolean): Promise<SessionId>
  observeCreator(sessionId: SessionId, presetId: string | undefined, snapshot: ConversationSnapshot): BlueprintCreatorObservation
  fixtureBridge(): BlueprintDemoFixtureBridge | undefined
}

const CREATOR_PROMPT = '我要一个上市公司研究 Agent。它需要研究公司的业务、财务表现和行业竞争，能搜索公开资料、读取我提供的财报，最后输出结构化研究报告。'
const PURPOSE_PROMPT = '不要给投资建议，只做公司研究和估值分析。'
const SKILL_PROMPT = '输入本地 CSV，提取营收、净利润、PE、PB，输出结构化摘要。'
const SUBAGENT_PROMPT = '让它负责行业研究，包括市场规模、主要玩家和竞争格局，主 Agent 继续负责公司和财务分析。'
const TEST_PROMPT = '分析 NVIDIA 最近一年的业务、财务表现和行业竞争情况。'
const SUBAGENT_REQUEST = /协作 Agent|行业竞争分析协作者|让它负责行业研究|市场规模.*主要玩家.*竞争格局/u

function initialState(presetId: string): DemoScenarioState {
  return {
    lifecycle: 'idle',
    creator: { sessionId: null, projection: 'absent' },
    blueprint: { presetId, selectedNodeId: null },
    proposal: { status: 'idle', applyingNodeIds: [] },
    capabilityAuthoring: {
      active: null, publishing: null,
      installed: { skill: false, subagent: false },
    },
    testSession: { sessionId: null, status: 'idle' },
  }
}

function flowState(state: DemoScenarioState): BlueprintDemoFlowState {
  const phase: BlueprintDemoFlowState['phase'] = state.lifecycle === 'idle' ? 'initial'
    : state.lifecycle === 'applying' ? 'editing'
      : state.lifecycle === 'authoring'
        ? state.capabilityAuthoring.active === 'skill' ? 'authoring-skill' : 'authoring-subagent'
        : state.lifecycle
  return {
    phase,
    hasModifiedPurpose: state.proposal.status === 'applied',
    hasCsvSkill: state.capabilityAuthoring.installed.skill,
    hasIndustrySubagent: state.capabilityAuthoring.installed.subagent,
    applyingNodeIds: state.proposal.applyingNodeIds,
    pendingCapability: state.capabilityAuthoring.active,
    testStatus: state.testSession.status,
  }
}

/**
 * Owns the scripted walkthrough state and translates Session observations into existing UI state.
 * It does not decide product behavior; each transition is replaceable when final Host behavior is available.
 */
export class DemoScenarioController {
  private state: DemoScenarioState
  private boundSessionId: SessionId | undefined
  private stopSession = (): void => {}
  private stopList = (): void => {}
  private initialDraftTimer: number | undefined
  private initialSessionStarting = false
  private observationUpdate: Promise<void> = Promise.resolve()

  constructor(private readonly deps: DemoScenarioDependencies) {
    this.state = initialState(deps.creatorScenario.agent.id)
  }

  /**
   * Read a detached scenario state for conformance tests and diagnostics.
   * @returns the current scenario state.
   */
  snapshot(): DemoScenarioState {
    return structuredClone(this.state)
  }

  /** Start Session observation and project the initial Demo state. */
  start(): void {
    this.syncView()
    void this.deps.blueprint.load().catch(() => undefined)
    this.stopList = this.deps.ctx.sessions.list.subscribe(() => { this.attachCurrentSession() })
    this.attachCurrentSession()
    this.initialDraftTimer = window.setInterval(() => { this.ensureInitialDraft() }, 250)
  }

  /** Stop timers and subscriptions owned by this controller. */
  dispose(): void {
    if (this.initialDraftTimer !== undefined) window.clearInterval(this.initialDraftTimer)
    this.stopList()
    this.stopSession()
  }

  /**
   * Select one real Blueprint node and route the scripted Purpose request through conversation.
   * @param nodeId - stable Blueprint node identity to select.
   */
  selectNode(nodeId: string): void {
    this.deps.blueprint.selectNode(nodeId)
    this.update({ blueprint: { ...this.state.blueprint, selectedNodeId: nodeId } })
    if (nodeId !== 'purpose:persona' || this.state.lifecycle === 'creating') return
    void this.prefillPurpose()
  }

  /**
   * Apply the currently presented Change Set without embedding timing in a React component.
   * @param changeSet - exact presented Change Set to apply.
   */
  async applyChangeSet(changeSet: BlueprintChangeSet): Promise<void> {
    this.update({
      lifecycle: 'applying',
      proposal: { status: 'applying', applyingNodeIds: changeSet.proposals.map(proposal => proposal.targetNodeId) },
    })
    await new Promise(resolve => window.setTimeout(resolve, 2_600))
    await this.deps.blueprint.applyChangeSet(changeSet)
    this.update({ lifecycle: 'ready', proposal: { status: 'applied', applyingNodeIds: [] } })
    const current = this.deps.ctx.sessions.list.getSnapshot().current
    if (current !== undefined) this.deps.fixtureBridge()?.completePurpose(current)
  }

  /**
   * Begin a scripted Skill or Subagent authoring Session.
   * @param kind - capability mechanism to author.
   */
  async startCapability(kind: 'skill' | 'subagent'): Promise<void> {
    this.update({
      lifecycle: 'authoring',
      capabilityAuthoring: { ...this.state.capabilityAuthoring, active: kind },
    })
    const sessionId = await this.deps.createSession('cordis')
    this.prefill(sessionId, kind === 'skill' ? SKILL_PROMPT : SUBAGENT_PROMPT)
  }

  /**
   * Create the scripted test Session and leave execution to the real conversation components.
   * @param request - exact preset and revision selected for the trial.
   */
  async startTrial(request: BlueprintTrialRequest): Promise<void> {
    const sessionId = await this.deps.createSession(request.presetId)
    this.prefill(sessionId, TEST_PROMPT)
    this.deps.ctx.layout.openDetails()
    this.update({ lifecycle: 'testing', testSession: { sessionId, status: 'running' } })
    this.syncFixtureCapabilities()
  }

  /** Reset remains a page reload because every fixture subsystem owns browser-local state. */
  reset(): void {
    location.reload()
  }

  private update(patch: Partial<DemoScenarioState>): void {
    this.state = { ...this.state, ...patch }
    this.syncView()
  }

  private syncView(): void {
    const current = this.deps.blueprint.store.getSnapshot()
    this.deps.blueprint.store.set({ ...current, demo: flowState(this.state) })
  }

  private prefill(sessionId: SessionId, text: string): void {
    const actx = this.deps.ctx.sessions.scope(sessionId)
    if (actx !== undefined) this.deps.ctx.conversation.input.for(actx).setDraft(text)
  }

  private async prefillPurpose(): Promise<void> {
    const list = this.deps.ctx.sessions.list.getSnapshot()
    const current = list.current
    const sessionId = current !== undefined && list.byId[current]?.agentPreset === this.state.blueprint.presetId
      ? current
      : await this.deps.createSession(this.state.blueprint.presetId)
    this.prefill(sessionId, PURPOSE_PROMPT)
  }

  private async currentSeed(): Promise<BlueprintDemoSeed> {
    const result = await this.deps.adapter.get({ presetId: this.state.blueprint.presetId })
    if (!result.ok) throw new Error(result.error.message)
    return { agent: this.deps.creatorScenario.agent, blueprint: result.value }
  }

  private clearCapabilityPublishing(): void {
    if (this.state.capabilityAuthoring.publishing === null) return
    this.update({
      capabilityAuthoring: { ...this.state.capabilityAuthoring, publishing: null },
    })
  }

  private async publishCapability(kind: 'skill' | 'subagent'): Promise<void> {
    if (this.state.capabilityAuthoring.publishing !== null) return
    this.update({
      capabilityAuthoring: { ...this.state.capabilityAuthoring, publishing: kind },
    })
    try {
      const current = await this.currentSeed()
      const revisionNumber = Number(current.blueprint.revision.match(/(\d+)$/u)?.[1] ?? 1) + 1
      const blueprint = structuredClone(current.blueprint)
      blueprint.revision = `demo-r${String(revisionNumber)}`
      if (kind === 'skill' && !blueprint.nodes.some(node => node.id === 'capability:skill:csv-financial-metrics')) {
        const description = 'CSV 财报指标提取：读取本地 CSV，提取营收、净利润、PE、PB，并输出结构化摘要。'
        blueprint.nodes.push({
          id: 'capability:skill:csv-financial-metrics', type: 'capability', source: 'preset', status: 'active', editable: false, adapterRef: null,
          value: { kind: 'skill', name: 'csv-financial-metrics', description, callable: true, scope: 'preset', invocation: { modelInvocable: true, userInvocable: true } },
        })
        blueprint.runtime.skills.push({ name: 'csv-financial-metrics', description, invocation: { modelInvocable: true, userInvocable: true }, scope: 'preset', provider: 'filesystem', source: 'custom', definitionDigest: 'demo-csv-financial-metrics' })
      }
      if (kind === 'subagent' && !blueprint.nodes.some(node => node.id === 'capability:delegation:industry-competition')) {
        blueprint.nodes.push({
          id: 'capability:delegation:industry-competition', type: 'capability', source: 'preset', status: 'active', editable: false, adapterRef: null,
          value: { kind: 'delegation', name: 'Industry Competition Researcher', displayLabel: '行业研究协作 Agent', tool: 'industry_competition_research', provider: 'spawn', mode: 'one-shot', providerAvailable: true, enabled: true, responsibility: '负责市场规模、主要玩家和竞争格局研究。' },
        })
        blueprint.runtime.delegations.push({
          rowId: 'industry-competition', tool: 'industry_competition_research', provider: 'spawn', mode: 'one-shot',
          configDigest: '9d1eb8ab111984253a3cd5e26787d4521ac1eb7ace52eb9163152f970c4d2904',
          providerAvailable: true, enabled: true,
        })
      }
      this.deps.adapter.replaceScenario({ agent: current.agent, blueprint })
      await this.deps.blueprint.selectPreset(current.agent.id)
      this.update({
        lifecycle: 'ready',
        capabilityAuthoring: {
          active: null,
          publishing: null,
          installed: { ...this.state.capabilityAuthoring.installed, [kind]: true },
        },
      })
      this.syncFixtureCapabilities()
    } finally {
      this.clearCapabilityPublishing()
    }
  }

  private syncFixtureCapabilities(): void {
    this.deps.fixtureBridge()?.setCapabilities({
      csvSkill: this.state.capabilityAuthoring.installed.skill,
      industrySubagent: this.state.capabilityAuthoring.installed.subagent,
    })
  }

  private attachCurrentSession(): void {
    const list = this.deps.ctx.sessions.list.getSnapshot()
    const current = list.current
    if (current === this.boundSessionId) return
    this.stopSession()
    this.stopSession = (): void => {}
    this.boundSessionId = current
    void this.deps.blueprint.activateSession(current, current === undefined ? undefined : list.byId[current]?.agentPreset)
    if (current === undefined) return
    // The in-memory Demo has no Host receipt history to hydrate for a newly selected Session.
    this.deps.blueprint.restoreApplyReceipts(current, [])
    const binding = this.deps.ctx.sessions.binding(current)
    if (binding === undefined) return
    const observe = (): void => { this.observeSession(current, binding.session.getSnapshot()) }
    observe()
    this.stopSession = binding.session.subscribe(observe)
    if (list.byId[current]?.agentPreset === 'cordis' && this.state.creator.sessionId === null) {
      this.prefill(current, CREATOR_PROMPT)
    }
  }

  private observeSession(sessionId: SessionId, snapshot: ConversationSnapshot): void {
    const summary = this.deps.ctx.sessions.list.getSnapshot().byId[sessionId]
    const userMessages = snapshot.nodes.filter(node => node.kind === 'user' || node.kind === 'steering')
    const userText = userMessages.flatMap(node => node.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
    const toolNames = new Set(snapshot.nodes.flatMap(node => node.kind === 'tool-result' && node.call !== null ? [node.call.name] : []))
    if (this.state.creator.sessionId === null && summary?.agentPreset === 'cordis' && userMessages.length > 0
      && !/CSV|财务指标提取/iu.test(userText) && !SUBAGENT_REQUEST.test(userText)) {
      this.state = { ...this.state, creator: { ...this.state.creator, sessionId } }
    }
    if (sessionId === this.state.creator.sessionId) {
      this.observeCreatorSession(sessionId, snapshot, toolNames)
      return
    }
    if (toolNames.has('propose_blueprint_change') && this.state.proposal.status === 'idle') {
      this.update({ proposal: { status: 'presented', applyingNodeIds: [] } })
    }
    if (toolNames.has('preset_validate') && /CSV|财务指标提取/iu.test(userText)
      && !this.state.capabilityAuthoring.installed.skill) void this.publishCapability('skill')
    else if (toolNames.has('preset_validate') && SUBAGENT_REQUEST.test(userText)
      && !this.state.capabilityAuthoring.installed.subagent) void this.publishCapability('subagent')
    if (/NVIDIA|英伟达/iu.test(userText)
      && this.deps.observeCreator(sessionId, summary?.agentPreset, snapshot).lastTurnEnd !== null
      && this.state.testSession.status === 'running') {
      this.update({ lifecycle: 'complete', testSession: { ...this.state.testSession, status: 'verified' } })
    }
  }

  private observeCreatorSession(
    sessionId: SessionId,
    snapshot: ConversationSnapshot,
    toolNames: ReadonlySet<string>,
  ): void {
    const observation = this.deps.observeCreator(sessionId, 'cordis', snapshot)
    this.observationUpdate = this.observationUpdate.catch(() => undefined).then(async () => {
      await this.deps.blueprint.observeCreator(observation)
      const creator = this.deps.blueprint.store.getSnapshot().creator
      if (creator === null || creator.sessionId !== sessionId) return
      if (this.state.creator.projection === 'absent') {
        this.deps.adapter.installScenario({
          agent: this.deps.creatorScenario.agent,
          blueprint: {
            ...this.deps.creatorScenario.blueprint,
            nodes: this.deps.creatorScenario.blueprint.nodes.filter(node => node.type === 'identity' || node.type === 'purpose'),
          },
        })
        this.update({
          lifecycle: 'creating',
          creator: { sessionId, projection: 'identity-purpose' },
        })
      }
      if (toolNames.has('preset_copy') && this.state.creator.projection === 'identity-purpose') {
        this.deps.adapter.replaceScenario({
          agent: this.deps.creatorScenario.agent,
          blueprint: { ...this.deps.creatorScenario.blueprint, nodes: this.deps.creatorScenario.blueprint.nodes.filter(node => node.type !== 'output') },
        })
        this.update({ creator: { sessionId, projection: 'without-output' } })
      }
      if (toolNames.has('write') && this.state.creator.projection !== 'complete') {
        this.deps.adapter.replaceScenario(this.deps.creatorScenario)
        this.update({ creator: { sessionId, projection: 'complete' } })
      }
      await this.deps.blueprint.pollCreator()
      if (this.deps.blueprint.store.getSnapshot().creator?.status === 'ready') this.update({ lifecycle: 'ready' })
    })
  }

  private ensureInitialDraft(): void {
    if (this.state.creator.sessionId !== null) {
      if (this.initialDraftTimer !== undefined) window.clearInterval(this.initialDraftTimer)
      return
    }
    const list = this.deps.ctx.sessions.list.getSnapshot()
    const current = list.current
    if (current === undefined || list.byId[current]?.agentPreset !== 'cordis') {
      if (this.initialSessionStarting) return
      this.initialSessionStarting = true
      void this.deps.createSession('cordis').then((sessionId) => {
        this.prefill(sessionId, CREATOR_PROMPT)
      }).finally(() => { this.initialSessionStarting = false })
      return
    }
    this.prefill(current, CREATOR_PROMPT)
    const actx = this.deps.ctx.sessions.scope(current)
    if (actx !== undefined && this.deps.ctx.conversation.input.for(actx).state.getSnapshot().draft === CREATOR_PROMPT
      && this.initialDraftTimer !== undefined) window.clearInterval(this.initialDraftTimer)
  }
}
