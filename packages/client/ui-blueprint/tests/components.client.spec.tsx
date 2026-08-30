// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type {
  Blueprint, BlueprintChangeProposal, BlueprintChangeSet, BlueprintSessionValidation,
} from '@deepseek-ai/dsh-api-remotes/client'
import {
  createSnapshotStore, SlotRegistry, type RunningToolCall, type ToolResultNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  BlueprintPanel, BlueprintProposalRow, BlueprintSelectedContext,
} from '../src/client/BlueprintUi.tsx'
import { BlueprintRouteRow, registerBlueprintRouteToolViews } from '../src/client/BlueprintRouteRow.tsx'
import type { BlueprintUiState } from '../src/client/controller.ts'
import type {
  BlueprintPanelProps, BlueprintProposalRowProps, BlueprintRouteRowProps, BlueprintSelectedContextProps,
} from '../src/client/slots.ts'

afterEach(cleanup)

const BLUEPRINT: Blueprint = {
  schemaVersion: 1,
  sourceLanguage: 'zh-CN',
  preset: { id: 'competitive-research', trust: 'user', name: '竞品研究' },
  revision: 'r1',
  nodes: [
    { id: 'identity:persona', type: 'identity', value: '竞品研究分析师', source: 'preset', status: 'active', editable: true, adapterRef: 'identity' },
    { id: 'purpose:persona', type: 'purpose', value: '比较竞品。', source: 'inferred', status: 'active', editable: true, adapterRef: 'purpose' },
    { id: 'behavior:1', type: 'behavior', value: '只采用可核实的竞品事实。', source: 'preset', status: 'active', editable: true, adapterRef: 'behavior:1' },
    { id: 'output:2', type: 'output', value: '摘要、对比表、结论和来源。', source: 'inferred', status: 'active', editable: false, adapterRef: null },
    { id: 'capability:web-search', type: 'capability', value: { name: 'Web Search', tool: 'web_search', enabled: true }, source: 'runtime', status: 'active', editable: true, adapterRef: 'search' },
    { id: 'capability:web-fetch', type: 'capability', value: { name: 'Web Fetch', tool: 'web_fetch', enabled: true }, source: 'runtime', status: 'active', editable: true, adapterRef: 'fetch' },
    { id: 'capability:file-read', type: 'capability', value: { name: 'File Read', tool: 'read', enabled: true }, source: 'runtime', status: 'active', editable: false, adapterRef: null },
    {
      id: 'capability:skill:source-audit', type: 'capability', source: 'preset', status: 'active',
      editable: false, adapterRef: null,
      value: {
        kind: 'skill', name: 'source-audit', description: '核对公开信息的来源与日期。',
        invocation: { modelInvocable: true, userInvocable: true }, callable: true, scope: 'preset',
      },
    },
    {
      id: 'capability:delegation:tool-subagent', type: 'capability', source: 'preset', status: 'active',
      editable: false, adapterRef: null,
      value: {
        kind: 'delegation', name: 'Collaborating Agent', tool: 'subagent', provider: 'spawn',
        mode: 'continuable', providerAvailable: true, enabled: true,
        responsibility: '并行核对竞品公开资料。',
      },
    },
  ],
  runtime: {
    tools: ['web_search', 'web_fetch', 'read', 'subagent'], promptSections: ['deployment:persona', 'tool:subagent'],
    skills: [{
      name: 'source-audit', description: '核对公开信息的来源与日期。',
      invocation: { modelInvocable: true, userInvocable: true }, scope: 'preset',
      provider: 'filesystem', source: 'custom', definitionDigest: 'skill-digest',
    }],
    delegations: [{
      rowId: 'tool-subagent', tool: 'subagent', provider: 'spawn', mode: 'continuable',
      providerAvailable: true, enabled: true,
      configDigest: 'a90316cc3a7985bdb318ec70a4d7a8342eaeef7f74a587e0349795f54c6b86f0',
    }],
    permissions: null,
  },
  mappingGaps: [],
}

const CAPABILITY_OWNER = { routeId: 'capability-route', sourceSessionId: 'capability-session' } as const

function props(selectedNodeId: string | null = null, blueprint: Blueprint = BLUEPRINT) {
  const store = createSnapshotStore<BlueprintUiState>({
    phase: 'ready', agents: [], presetId: 'competitive-research', blueprint,
    selectedNodeId, modal: null, busy: false, error: null, validation: null,
    proposalCancellations: [], creator: null, capabilityHandoff: null,
  })
  const useBlueprintUi = <T,>(selector: (state: BlueprintUiState) => T): T =>
    useSyncExternalStore(() => store.subscribe(() => undefined), () => selector(store.getSnapshot()))
  return {
    useBlueprintUi,
    load: vi.fn(() => Promise.resolve()),
    selectPreset: vi.fn(() => Promise.resolve()),
    selectNode: vi.fn(),
    clearSelection: vi.fn(),
    updateText: vi.fn(() => Promise.resolve()),
    setCapability: vi.fn(() => Promise.resolve()),
    addCapability: vi.fn(() => Promise.resolve()),
    beginCapabilityHandoff: vi.fn(() => Promise.resolve()),
    clearCapabilityHandoff: vi.fn(),
    openModal: vi.fn(),
    closeModal: vi.fn(),
    startTrial: vi.fn(() => Promise.resolve()),
    cancelProposal: vi.fn(),
    applyChangeSet: vi.fn<(changeSet: BlueprintChangeSet) => Promise<void>>(() => Promise.resolve()),
    cancelChangeSet: vi.fn(),
  }
}

function proposalBlock(): ToolResultNode & { meta: { blueprintChangeSet: BlueprintChangeSet } } {
  return {
    kind: 'tool-result', seq: 10, time: 2_000, callId: 'proposal-1',
    call: { name: 'propose_blueprint_change', argsRaw: '{}' }, callTime: 1_000,
    content: [{ type: 'text', text: 'Proposal created; no preset mutation was performed.' }],
    isError: false,
    meta: { blueprintChangeSet: {
      changeSetId: 'proposal-1', sourceSessionId: 'conversation-a', routeId: 'interaction-a',
      kind: 'direct-request', presetId: 'competitive-research', revision: 'r1',
      proposals: [{
        proposalId: 'proposal-1', presetId: 'competitive-research', revision: 'r1',
        targetNodeId: 'capability:web-search', operation: 'setCapability',
        currentValue: true, proposedValue: false,
        impact: 'Agent 将不再主动搜索最新公开信息。',
      }],
    } },
    callView: { card: 'generic', title: 'Propose Blueprint change', kind: 'other' },
    resultView: null, subCalls: [],
  }
}

function runningRoute(toolName: string, args: object): RunningToolCall {
  return {
    callId: 'route-1', name: toolName, argsRaw: JSON.stringify(args), turn: 1, step: 1, time: 1_000,
    callView: null, subCalls: [],
  }
}

function settledRoute(toolName: string, args: object, content: string, isError = false): ToolResultNode {
  return {
    kind: 'tool-result', seq: 10, time: 2_000, callId: 'route-1',
    call: { name: toolName, argsRaw: JSON.stringify(args) }, callTime: 1_000,
    content: [{ type: 'text', text: content }], isError,
    callView: null, resultView: null, subCalls: [],
  }
}

function routeRowProps(toolName: string, block: RunningToolCall | ToolResultNode): BlueprintRouteRowProps {
  return {
    sessionId: 'conversation-a', callId: block.callId, toolName, block, openFile: vi.fn(),
  } as unknown as BlueprintRouteRowProps
}

function reconciliationBlock(): ToolResultNode {
  return {
    kind: 'tool-result', seq: 11, time: 2_100, callId: 'reconcile-1',
    call: { name: 'propose_blueprint_change', argsRaw: '{}' }, callTime: 1_100,
    content: [{ type: 'text', text: 'Change Set created.' }], isError: false,
    meta: { blueprintChangeSet: {
      changeSetId: 'reconcile-1', kind: 'direct-edit-reconciliation',
      sourceSessionId: 'conversation-a', routeId: 'interaction-a',
      presetId: 'competitive-research', revision: 'r1',
      sourceNodeId: 'purpose:persona', sourceNodeType: 'purpose', sourceLabel: 'Purpose',
      proposals: [
        {
          proposalId: 'reconcile-1:1', presetId: 'competitive-research', revision: 'r1',
          targetNodeId: 'behavior:1', operation: 'updateBehavior',
          currentValue: '只采用可核实的竞品事实。', proposedValue: '优先采用美国院校官网和官方申请渠道。',
          impact: '规则将切换到美国留学口径。', dependency: '原规则仍引用德国 APS 与 uni-assist。',
        },
        {
          proposalId: 'reconcile-1:2', presetId: 'competitive-research', revision: 'r1',
          targetNodeId: 'identity:persona', operation: 'updateIdentity',
          currentValue: '竞品研究分析师', proposedValue: '美国留学申请顾问',
          impact: '角色将切换到美国留学申请。', dependency: '旧角色与新的美国留学目标不一致。',
        },
      ],
    } },
    callView: { card: 'generic', title: 'Propose Blueprint change', kind: 'other' },
    resultView: null, subCalls: [],
  }
}

function structuredEditBlock(): ToolResultNode {
  return {
    kind: 'tool-result', seq: 12, time: 2_200, callId: 'purpose-edit-1',
    call: { name: 'propose_blueprint_change', argsRaw: '{}' }, callTime: 1_200,
    content: [{ type: 'text', text: 'Change Set created.' }], isError: false,
    meta: { blueprintChangeSet: {
      changeSetId: 'purpose-edit-1', kind: 'structured-edit',
      sourceSessionId: 'conversation-a', routeId: 'purpose-route-a',
      presetId: 'competitive-research', revision: 'r1',
      sourceNodeId: 'purpose:persona', sourceNodeType: 'purpose', sourceLabel: 'Purpose',
      proposals: [
        {
          proposalId: 'purpose-edit-1:1', presetId: 'competitive-research', revision: 'r1',
          targetNodeId: 'purpose:persona', operation: 'updatePurpose',
          currentValue: '比较竞品。', proposedValue: '只比较公开可核实的竞品信息。',
          impact: '收窄 Agent 的研究目标。',
        },
        {
          proposalId: 'purpose-edit-1:2', presetId: 'competitive-research', revision: 'r1',
          targetNodeId: 'behavior:1', operation: 'updateBehavior',
          currentValue: '只采用可核实的竞品事实。', proposedValue: '只采用公开且可核实的竞品事实。',
          impact: '规则与新目标保持一致。', dependency: '旧规则没有限定公开来源。',
        },
      ],
    } },
    callView: { card: 'generic', title: 'Propose Blueprint change', kind: 'other' },
    resultView: null, subCalls: [],
  }
}

function structuredEditVariantBlock(input: {
  changeSetId: string
  sourceNodeId: string
  sourceNodeType: Extract<BlueprintChangeSet, { kind: 'structured-edit' }>['sourceNodeType']
  sourceLabel: string
  operation: BlueprintChangeProposal['operation']
  currentValue: string | boolean
  proposedValue: string | boolean
  impact: string
}): ToolResultNode {
  return {
    kind: 'tool-result', seq: 13, time: 2_300, callId: input.changeSetId,
    call: { name: 'propose_blueprint_change', argsRaw: '{}' }, callTime: 1_300,
    content: [{ type: 'text', text: 'Change Set created.' }], isError: false,
    meta: { blueprintChangeSet: {
      changeSetId: input.changeSetId, kind: 'structured-edit',
      sourceSessionId: 'conversation-a', routeId: `route:${input.changeSetId}`,
      presetId: 'competitive-research', revision: 'r1',
      sourceNodeId: input.sourceNodeId, sourceNodeType: input.sourceNodeType,
      sourceLabel: input.sourceLabel,
      proposals: [{
        proposalId: `${input.changeSetId}:1`, presetId: 'competitive-research', revision: 'r1',
        targetNodeId: input.sourceNodeId, operation: input.operation,
        currentValue: input.currentValue, proposedValue: input.proposedValue, impact: input.impact,
      }],
    } },
    callView: { card: 'generic', title: 'Propose Blueprint change', kind: 'other' },
    resultView: null, subCalls: [],
  }
}

function creatorState(
  status: 'creating' | 'waiting' | 'paused' | 'ambiguity' | 'ready',
  waitingFor: 'question' | 'approval' | null,
): BlueprintUiState {
  return {
    phase: 'ready', agents: [], presetId: 'course-material-test',
    blueprint: {
      ...BLUEPRINT,
      preset: { id: 'course-material-test', trust: 'user', name: '课程资料整理测试 Agent' },
    },
    selectedNodeId: null, modal: null, busy: false, error: null, validation: null,
    proposalCancellations: [], capabilityHandoff: null,
    creator: {
      sessionId: 'creator-1', name: '课程资料整理测试 Agent', status,
      candidateIds: ['course-material-test'], waitingFor,
    },
  }
}

describe('Interactive Blueprint presentation', () => {
  it.each([
    [
      'route_blueprint_creator_authoring',
      { user_intent: '创建一个研究 Agent', name: '研究 Agent' },
      '正在确认创建请求…',
      '正在创建 Agent…',
    ],
    [
      'route_blueprint_capability_authoring',
      { request: '添加 CSV Skill', kind: 'skill', reason: '需要复用 CSV 处理流程' },
      '正在确认能力请求…',
      '正在配置能力…',
    ],
  ] as const)('shows user-facing progress for %s without exposing its arguments', (toolName, args, running, accepted) => {
    const view = render(<BlueprintRouteRow {...routeRowProps(toolName, runningRoute(toolName, args))} />)

    expect(screen.getByText(running)).toBeTruthy()
    expect(document.body.textContent).not.toContain(toolName)
    expect(document.body.textContent).not.toContain(Object.values(args)[0])

    view.rerender(<BlueprintRouteRow {...routeRowProps(toolName, settledRoute(toolName, args, 'accepted'))} />)
    expect(screen.getByText(accepted)).toBeTruthy()
    expect(document.body.textContent).not.toContain('accepted')
  })

  it.each([
    [
      'new-Agent',
      'route_blueprint_creator_authoring',
      { user_intent: '创建研究 Agent', name: '研究 Agent' },
      '正在重新确认创建请求…',
    ],
    [
      'skill',
      'route_blueprint_capability_authoring',
      { request: '添加 skill', kind: 'skill', reason: '需要新的能力定义' },
      '正在重新确认能力请求…',
    ],
    [
      'subagent',
      'route_blueprint_capability_authoring',
      { request: '添加 subagent', kind: 'subagent', reason: '需要新的能力定义' },
      '正在重新确认能力请求…',
    ],
  ] as const)('keeps an internal %s provenance miss user-safe while the route retries', (_kind, toolName, args, message) => {
    const raw = 'Error: blueprint-route-provenance-conflict: user_intent must quote the current original user request'
    render(<BlueprintRouteRow {...routeRowProps(toolName, settledRoute(toolName, args, raw, true))} />)

    const retrying = screen.getByText(message).parentElement
    expect(retrying?.getAttribute('data-state')).toBe('retrying')
    expect(retrying?.hasAttribute('data-error')).toBe(false)
    expect(document.body.textContent).not.toMatch(/blueprint-route-provenance-conflict|user_intent|Tool call Error/iu)
  })

  it.each([
    ['route_blueprint_creator_authoring', { name: '研究 Agent' }, '暂时无法开始创建，请重新尝试。'],
    ['route_blueprint_capability_authoring', { kind: 'skill' }, '暂时无法配置这项能力，请重新尝试。'],
  ] as const)('keeps a terminal %s failure visible without its implementation error', (toolName, args, message) => {
    render(<BlueprintRouteRow {...routeRowProps(
      toolName,
      settledRoute(toolName, args, 'Error: internal route storage unavailable', true),
    )} />)

    const failure = screen.getByText(message).parentElement
    expect(failure?.getAttribute('data-state')).toBe('failed')
    expect(failure?.hasAttribute('data-error')).toBe(true)
    expect(document.body.textContent).not.toMatch(/internal route storage unavailable|Tool call Error/iu)
  })

  it('registers the shared route row for both typed Blueprint routing Tools', async () => {
    const ctx = new Context()
    const slots = new SlotRegistry(ctx)
    slots.register({
      name: 'root',
      children: { 'tool.call.toolview': { kind: 'keyed', scope: 'session' } },
    } as never, () => null)
    const fiber = ctx.plugin({
      inject: ['slots'],
      apply(inner) {
        registerBlueprintRouteToolViews(inner as Parameters<typeof registerBlueprintRouteToolViews>[0])
      },
    })
    await fiber.await()

    const entries = slots.entries('tool.call.toolview')
    expect(entries.map(entry => entry.options.key)).toEqual([
      'route_blueprint_creator_authoring',
      'route_blueprint_capability_authoring',
    ])
    expect(entries.every(entry => entry.component === BlueprintRouteRow)).toBe(true)

    await fiber.dispose()
  })

  it('offers edits only where the projected node says editable', () => {
    const actions = props()
    render(<BlueprintPanel {...(actions as unknown as BlueprintPanelProps)} />)

    expect(screen.getAllByText('编辑')).toHaveLength(3)
    expect(screen.getByRole('button', { name: '选择做什么' }).querySelector('button')?.textContent).toBe('编辑')
    expect(screen.getByText('角色')).toBeTruthy()
    expect(screen.getByText('竞品研究分析师')).toBeTruthy()
    expect(screen.getByText('摘要、对比表、结论、来源').parentElement?.parentElement?.textContent).not.toContain('编辑')
    expect(screen.queryByText('摘要、对比表、结论和来源。')).toBeNull()
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('summarizes concrete Agent work instead of the shared Tool, Skill, and delegation catalog', () => {
    const actions = props()
    render(<BlueprintPanel {...(actions as unknown as BlueprintPanelProps)} />)

    expect(screen.getByText('竞品信息核验')).toBeTruthy()
    expect(screen.getByText('竞品对比分析')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/工具|技能|source-audit|spawn|provider|inherited/iu)

    fireEvent.click(screen.getByText('竞品信息核验'))
    expect(actions.selectNode).toHaveBeenCalledWith('behavior:1')
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('hands one plain-language capability goal to the conversation without technical choices', () => {
    const actions = props()
    render(<BlueprintPanel {...(actions as unknown as BlueprintPanelProps)} />)
    fireEvent.click(screen.getByRole('button', { name: '＋ 添加能力' }))

    expect(screen.getByText('你希望这个 Agent 还能做什么？')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/使用已有能力|GitHub|创建技能|Subagent|协作 Agent/u)
    fireEvent.change(screen.getByPlaceholderText('例如：帮我分析上市公司财报'), {
      target: { value: '我希望它能分析上市公司财报' },
    })
    fireEvent.click(screen.getByRole('button', { name: '交给 AI' }))

    expect(actions.beginCapabilityHandoff).toHaveBeenCalledWith('我希望它能分析上市公司财报')
    expect(actions.addCapability).not.toHaveBeenCalled()
    expect(actions.setCapability).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toMatch(/已安装|已创建|创建成功/u)
  })

  it('offers a safe same-request retry without exposing internal capability diagnostics', () => {
    const actions = props()
    const failedActions = {
      ...actions,
      useBlueprintUi: <T,>(selector: (value: BlueprintUiState) => T): T => selector({
        phase: 'ready', agents: [], presetId: 'competitive-research', blueprint: BLUEPRINT,
        selectedNodeId: null, modal: null, busy: false, error: null, validation: null,
        proposalCancellations: [], creator: null,
        capabilityHandoff: {
          ...CAPABILITY_OWNER,
          request: '创建 CSV 财报指标提取 Skill', label: 'CSV 财报指标提取',
          targetPresetId: 'competitive-research', revision: 'r1', status: 'failed',
          authoringKind: 'skill', creatorSessionId: 'creator-session', startSeq: 40,
          terminal: {
            outcome: 'failed', endSeq: 46,
            message: 'mount verification failed: tool-skill catalog delta missing',
          },
        },
      }),
    }

    render(<BlueprintPanel {...(failedActions as unknown as BlueprintPanelProps)} />)

    expect(screen.getByText('CSV 财报指标提取 · 这项能力暂时没配置好')).toBeTruthy()
    expect(screen.getByText('原有 Agent 设置没有受到影响，可以重新尝试。')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/mount|verification|tool-skill|catalog delta/iu)
    fireEvent.click(screen.getByRole('button', { name: '重新尝试' }))
    expect(actions.beginCapabilityHandoff).toHaveBeenCalledWith('创建 CSV 财报指标提取 Skill')
  })

  it('reduces runtime conformance to safe user-facing status copy', () => {
    const actions = props()
    const validation: BlueprintSessionValidation = {
      sessionId: 'trial', presetId: 'competitive-research', valid: true, overall: 'pass',
      binding: {
        status: 'pass', sessionPresetId: 'competitive-research', composedPresetId: 'competitive-research',
        expectedRevision: 'r1', projectedRevision: 'r1', strictRevisionBound: false,
      },
      prompt: { status: 'pass', evidence: [] },
      tools: { status: 'pass', evidence: [], missing: [], unexpected: [], schemaMismatches: [] },
      skills: { status: 'pass', evidence: [], missing: [], unexpected: [] },
      delegations: { status: 'pass', evidence: [] },
      permissions: { status: 'pass' },
    }
    const validatedActions = {
      ...actions,
      useBlueprintUi: <T,>(selector: (value: BlueprintUiState) => T): T => selector({
        phase: 'ready', agents: [], presetId: 'competitive-research', blueprint: BLUEPRINT,
        selectedNodeId: null, modal: null, busy: false, error: null, validation,
        proposalCancellations: [], creator: null, capabilityHandoff: null,
      }),
    }

    const view = render(<BlueprintPanel {...(validatedActions as unknown as BlueprintPanelProps)} />)
    expect(screen.getByText('运行配置验证通过，Blueprint 与当前 Agent 组装结果一致。')).toBeTruthy()
    expect(document.body.textContent).not.toContain('已应用')
    expect(document.body.textContent).not.toMatch(/digest|revision|adapterRef/iu)

    validation.valid = false
    validation.overall = 'fail'
    validation.prompt.status = 'fail'
    view.rerender(<BlueprintPanel {...(validatedActions as unknown as BlueprintPanelProps)} />)
    expect(screen.getByText('运行配置验证未通过，当前 Agent 尚不可安全试用。')).toBeTruthy()
    expect(document.body.textContent).not.toContain('修改已保存')
  })

  it('edits Identity from its first-level role section without exposing its internal id', () => {
    const actions = props()
    render(<BlueprintPanel {...(actions as unknown as BlueprintPanelProps)} />)
    const roleRow = screen.getByText('竞品研究分析师').parentElement
    const editButton = roleRow?.querySelector('button')

    expect(editButton).not.toBeNull()
    if (editButton !== null && editButton !== undefined) fireEvent.click(editButton)
    fireEvent.change(screen.getByRole('textbox', { name: '编辑角色' }), { target: { value: '保研申请顾问' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(actions.updateText).toHaveBeenCalledWith('identity:persona', '保研申请顾问', '竞品研究分析师')
    expect(document.body.textContent).not.toContain('identity:persona')
  })

  it('shows the full committed Purpose without a summary ellipsis', () => {
    const actions = props()
    const value = '研究不同 AI 产品的核心能力、定价、目标用户与市场定位，输出结构化竞品报告，并根据竞品差异给出产品优化优先级建议。'
    const longPurposeActions = {
      ...actions,
      useBlueprintUi: <T,>(selector: (state: BlueprintUiState) => T): T => selector({
        phase: 'ready', agents: [], presetId: 'competitive-research',
        blueprint: { ...BLUEPRINT, nodes: BLUEPRINT.nodes.map(node => node.type === 'purpose' ? { ...node, value } : node) },
        selectedNodeId: null, modal: null, busy: false, error: null, validation: null,
        proposalCancellations: [], creator: null, capabilityHandoff: null,
      }),
    }
    render(<BlueprintPanel {...(longPurposeActions as unknown as BlueprintPanelProps)} />)

    expect(screen.getByText(value)).toBeTruthy()
    expect(screen.queryByText(/产品优化优先级建…/u)).toBeNull()
  })

  it('edits Purpose in place, cancels without submission, then submits the confirmed draft', () => {
    const actions = props()
    render(<BlueprintPanel {...(actions as unknown as BlueprintPanelProps)} />)

    const purposeRow = screen.getByRole('button', { name: '选择做什么' })
    const editButton = purposeRow.querySelector('button')
    expect(editButton?.textContent).toBe('编辑')
    if (editButton !== null) fireEvent.click(editButton)

    const editor = screen.getByRole('textbox', { name: '编辑做什么' })
    expect(editor.getAttribute('value') ?? (editor as HTMLTextAreaElement).value).toBe('比较竞品。')
    fireEvent.change(editor, { target: { value: '不会提交的草稿。' } })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(actions.updateText).not.toHaveBeenCalled()
    expect(screen.getByText('比较竞品。')).toBeTruthy()

    const reopened = screen.getByRole('button', { name: '选择做什么' }).querySelector('button')
    if (reopened !== null) fireEvent.click(reopened)
    fireEvent.change(screen.getByRole('textbox', { name: '编辑做什么' }), {
      target: { value: '只比较公开可核实的竞品信息。' },
    })
    fireEvent.click(screen.getByRole('button', { name: '提交修改' }))

    expect(actions.updateText).toHaveBeenCalledWith('purpose:persona', '只比较公开可核实的竞品信息。', '比较竞品。')
  })

  it('keeps a failed edit open with its draft and an actionable error', async () => {
    const actions = props()
    actions.updateText.mockRejectedValueOnce(new Error('Preset revision changed; reopen the editor.'))
    render(<BlueprintPanel {...(actions as unknown as BlueprintPanelProps)} />)

    const purposeRow = screen.getByRole('button', { name: '选择做什么' })
    const editButton = purposeRow.querySelector('button')
    if (editButton !== null) fireEvent.click(editButton)
    fireEvent.change(screen.getByRole('textbox', { name: '编辑做什么' }), {
      target: { value: '保留这个失败草稿。' },
    })
    fireEvent.click(screen.getByRole('button', { name: '提交修改' }))

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Preset revision changed')
    })
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '编辑做什么' }).value).toBe('保留这个失败草稿。')
    expect(actions.updateText).toHaveBeenCalledWith('purpose:persona', '保留这个失败草稿。', '比较竞品。')
  })

  it.each([
    ['capability:skill:source-audit', 'source-audit', '核对公开信息的来源与日期。', ['Skill', 'preset', '可调用']],
    ['capability:delegation:tool-subagent', 'Collaborating Agent', '并行核对竞品公开资料。', ['协作 Agent', 'subagent', 'spawn', 'continuable', '可用']],
  ] as const)('derives %s details from the committed capability projection', (nodeId, title, description, details) => {
    const actions = props(nodeId)
    render(<BlueprintPanel {...(actions as unknown as BlueprintPanelProps)} />)

    expect(screen.getByText(title)).toBeTruthy()
    expect(screen.getByText(description)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看技术详情' }))
    for (const detail of details) expect(screen.getByText(detail)).toBeTruthy()
    expect(document.body.textContent).not.toContain('CSV 财报指标提取')
    expect(document.body.textContent).not.toContain('Revenue · Net Profit · PE · PB')
    expect(document.body.textContent).not.toContain('行业研究协作 Agent')
  })

  it('blocks edits, another Add, and Try while one capability executor is active', () => {
    const actions = props()
    const lockedActions = {
      ...actions,
      useBlueprintUi: <T,>(selector: (value: BlueprintUiState) => T): T => selector({
        phase: 'ready', agents: [], presetId: 'competitive-research', blueprint: BLUEPRINT,
        selectedNodeId: null, modal: null, busy: false, error: null, validation: null,
        proposalCancellations: [], creator: null,
        capabilityHandoff: {
          ...CAPABILITY_OWNER,
          request: '创建 CSV Skill', label: 'CSV Skill', targetPresetId: 'competitive-research',
          revision: 'r1', status: 'authoring', authoringKind: 'skill',
          creatorSessionId: 'creator-session', startSeq: 40,
        },
      }),
    }

    render(<BlueprintPanel {...(lockedActions as unknown as BlueprintPanelProps)} />)

    expect(screen.getByRole('button', { name: '试用 Agent' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '＋ 添加能力' }).hasAttribute('disabled')).toBe(true)
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()
  })

  it('routes Demo adjustments through conversation and shows the next intended action', () => {
    const actions = props()
    const demoActions = {
      ...actions,
      startDemoCapability: vi.fn(() => Promise.resolve()),
      resetDemo: vi.fn(),
      useBlueprintUi: <T,>(selector: (value: BlueprintUiState) => T): T => selector({
        phase: 'ready', agents: [], presetId: 'competitive-research', blueprint: BLUEPRINT,
        selectedNodeId: null, modal: null, busy: false, error: null, validation: null,
        proposalCancellations: [], capabilityHandoff: null,
        creator: {
          sessionId: 'creator-1', name: '竞品研究', status: 'ready',
          candidateIds: ['competitive-research'], waitingFor: null,
        },
        demo: {
          phase: 'ready', hasModifiedPurpose: false, hasCsvSkill: false,
          hasIndustrySubagent: false, applyingNodeIds: [], pendingCapability: null,
          testStatus: 'idle',
        },
      }),
    }

    render(<BlueprintPanel {...(demoActions as unknown as BlueprintPanelProps)} />)

    expect(screen.getByText('可试用 · 下一步：调整「做什么」')).toBeTruthy()
    expect(screen.getByText('点击「调整」，左侧会预填修改要求；发送后再应用提案。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()

    const purposeRow = screen.getByRole('button', { name: '选择做什么' })
    const adjustButton = purposeRow.querySelector('button')
    expect(adjustButton?.textContent).toBe('调整')
    if (adjustButton !== null) fireEvent.click(adjustButton)

    expect(actions.selectNode).toHaveBeenCalledWith('purpose:persona')
    expect(screen.queryByRole('textbox', { name: '编辑做什么' })).toBeNull()
  })

  it('keeps an unmapped Identity selectable and routes adjustment to conversation', () => {
    const actions = props()
    const readonlyBlueprint: Blueprint = {
      ...BLUEPRINT,
      nodes: BLUEPRINT.nodes.map(node => node.type === 'identity'
        ? { ...node, editable: false, adapterRef: null }
        : node),
    }
    const readonlyActions = {
      ...actions,
      useBlueprintUi: <T,>(selector: (value: BlueprintUiState) => T): T => selector({
        phase: 'ready', agents: [], presetId: 'competitive-research', blueprint: readonlyBlueprint,
        selectedNodeId: null, modal: null, busy: false, error: null, validation: null,
        proposalCancellations: [], creator: null, capabilityHandoff: null,
      }),
    }

    render(<BlueprintPanel {...(readonlyActions as unknown as BlueprintPanelProps)} />)

    const identityRow = screen.getByRole('button', { name: '选择角色' })
    const adjustButton = identityRow.querySelector('button')
    if (adjustButton !== null) fireEvent.click(adjustButton)
    expect(actions.selectNode).toHaveBeenCalledWith('identity:persona')
    fireEvent.click(screen.getByText('竞品研究分析师'))
    expect(actions.selectNode).toHaveBeenCalledWith('identity:persona')
    expect(document.body.textContent).not.toMatch(/identity:persona|locked node|adapterRef/iu)
  })

  it('keeps an English semantic Blueprint in English without translating technical ids', () => {
    const actions = props()
    const englishBlueprint = {
      ...BLUEPRINT,
      sourceLanguage: 'en-US',
      preset: { ...BLUEPRINT.preset, name: 'Market Research Agent' },
      nodes: BLUEPRINT.nodes.map(node => node.type === 'identity'
        ? { ...node, value: 'market research analyst' }
        : node.type === 'purpose' ? { ...node, value: 'Compare public market information.' } : node),
    }
    const englishActions = {
      ...actions,
      useBlueprintUi: <T,>(selector: (value: BlueprintUiState) => T): T => selector({
        phase: 'ready', agents: [], presetId: 'market-research', blueprint: englishBlueprint,
        selectedNodeId: null, modal: null, busy: false, error: null, validation: null,
        proposalCancellations: [], creator: null, capabilityHandoff: null,
      }),
    }

    render(<BlueprintPanel {...(englishActions as unknown as BlueprintPanelProps)} />)

    expect(screen.getByText('Role')).toBeTruthy()
    expect(screen.getByText('Purpose')).toBeTruthy()
    expect(screen.getByText('Capabilities')).toBeTruthy()
    expect(screen.getByText('Rules')).toBeTruthy()
    expect(screen.getByText('Output')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Try Agent' })).toBeTruthy()
    expect(document.body.textContent).toContain('market research analyst')
  })

  it('falls back only fixed UI labels for a Japanese semantic Blueprint', () => {
    const actions = props()
    const japaneseBlueprint = {
      ...BLUEPRINT,
      sourceLanguage: 'ja-JP',
      preset: { ...BLUEPRINT.preset, name: '上場AI企業リサーチ Agent' },
      nodes: BLUEPRINT.nodes.map(node => node.type === 'identity'
        ? { ...node, value: '上場AI企業リサーチアナリスト' }
        : node.type === 'purpose' ? { ...node, value: '上場AI企業の公開情報を調査する。' } : node),
    }
    const japaneseActions = {
      ...actions,
      useBlueprintUi: <T,>(selector: (value: BlueprintUiState) => T): T => selector({
        phase: 'ready', agents: [], presetId: 'ja-research', blueprint: japaneseBlueprint,
        selectedNodeId: null, modal: null, busy: false, error: null, validation: null,
        proposalCancellations: [], creator: null, capabilityHandoff: null,
      }),
    }

    render(<BlueprintPanel {...(japaneseActions as unknown as BlueprintPanelProps)} />)

    expect(screen.getByText('Role')).toBeTruthy()
    expect(screen.getByText('Purpose')).toBeTruthy()
    expect(screen.getByText('上場AI企業リサーチアナリスト')).toBeTruthy()
    expect(screen.getByText('上場AI企業の公開情報を調査する。')).toBeTruthy()
    expect(document.body.textContent).not.toContain('上市公司研究')
  })

  it('keeps raw Output prompt text behind an explicit details expansion', () => {
    const actions = props()
    render(<BlueprintPanel {...(actions as unknown as BlueprintPanelProps)} />)

    expect(screen.getByText('当前 Agent 的结构摘要')).toBeTruthy()
    expect(screen.queryByText('摘要、对比表、结论和来源。')).toBeNull()

    fireEvent.click(screen.getAllByRole('button', { name: '展开' }).at(-1)!)

    expect(screen.getByText('摘要、对比表、结论和来源。')).toBeTruthy()
  })

  it('shows Creator lifecycle copy without leaking the previous Blueprint', () => {
    const actions = props()
    const draftActions = {
      ...actions,
      useBlueprintUi: <T,>(selector: (value: BlueprintUiState) => T): T => selector({
        phase: 'ready', agents: [], presetId: '', blueprint: null, selectedNodeId: null,
        modal: null, busy: false, error: null, validation: null, proposalCancellations: [],
        capabilityHandoff: null,
        creator: {
          sessionId: 'creator-1', name: '秋招投递 Agent', status: 'waiting', candidateIds: [], waitingFor: 'question',
        },
      }),
    }

    render(<BlueprintPanel {...(draftActions as unknown as BlueprintPanelProps)} />)

    expect(screen.getByRole('heading', { name: '秋招投递 Agent' })).toBeTruthy()
    expect(screen.getByText('等待你补充信息')).toBeTruthy()
    expect(screen.getByText('正在根据你的需求生成 Agent 结构…')).toBeTruthy()
    expect(screen.queryByText('比较竞品。')).toBeNull()
    expect(screen.queryByText('网页搜索')).toBeNull()
  })

  it('distinguishes a native approval wait from a Creator question', () => {
    const actions = props()
    const approvalActions = {
      ...actions,
      useBlueprintUi: <T,>(selector: (value: BlueprintUiState) => T): T => selector({
        phase: 'ready', agents: [], presetId: 'course-materials', blueprint: null, selectedNodeId: null,
        modal: null, busy: false, error: null, validation: null, proposalCancellations: [],
        capabilityHandoff: null,
        creator: {
          sessionId: 'creator-1', name: '课程资料整理测试 Agent', status: 'waiting',
          candidateIds: ['course-materials'], waitingFor: 'approval',
        },
      }),
    }

    render(<BlueprintPanel {...(approvalActions as unknown as BlueprintPanelProps)} />)

    expect(screen.getByText('等待你授权')).toBeTruthy()
    expect(screen.queryByText('可试用')).toBeNull()
  })

  it('keeps an associated Creator target selectable while routing adjustments to conversation', () => {
    const actions = props()
    const readonlyActions = {
      ...actions,
      useBlueprintUi: <T,>(selector: (value: BlueprintUiState) => T): T =>
        selector(creatorState('waiting', 'question')),
    }

    render(<>
      <div data-composer-card><textarea aria-label="Creator composer" /></div>
      <BlueprintPanel {...(readonlyActions as unknown as BlueprintPanelProps)} />
    </>)

    expect(screen.getByRole('heading', { name: '课程资料整理测试 Agent' })).toBeTruthy()
    expect(screen.getByText('等待你补充信息')).toBeTruthy()
    expect(screen.queryByText('正在读取 Agent…')).toBeNull()
    expect(screen.getByText('比较竞品。')).toBeTruthy()
    expect(screen.getByText('竞品信息核验')).toBeTruthy()
    expect(screen.getByText('只采用可核实的竞品事实。')).toBeTruthy()
    expect(screen.getByText('课程资料整理测试报告')).toBeTruthy()
    expect(screen.queryByText('编辑')).toBeNull()
    expect(screen.getAllByText('调整')).toHaveLength(3)
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.getByRole('button', { name: '＋ 添加能力' })).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '试用 Agent' }).disabled).toBe(true)

    fireEvent.click(screen.getByText('比较竞品。'))
    expect(actions.selectNode).toHaveBeenCalledWith('purpose:persona')
    fireEvent.click(screen.getByText('竞品信息核验'))
    expect(actions.selectNode).toHaveBeenCalledWith('behavior:1')
    fireEvent.click(screen.getByText('竞品研究分析师'))
    expect(actions.selectNode).toHaveBeenCalledWith('identity:persona')

    fireEvent.click(screen.getAllByRole('button', { name: '调整' })[0]!)
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Creator composer' }))
  })

  it('labels an associated running Creator target as adjusting instead of loading', () => {
    const actions = props()
    const adjustingActions = {
      ...actions,
      useBlueprintUi: <T,>(selector: (value: BlueprintUiState) => T): T =>
        selector(creatorState('creating', null)),
    }

    render(<BlueprintPanel {...(adjustingActions as unknown as BlueprintPanelProps)} />)

    expect(screen.getByText('正在调整')).toBeTruthy()
    expect(screen.getByText('比较竞品。')).toBeTruthy()
    expect(screen.queryByText('正在搭建')).toBeNull()
  })

  it('selects a Blueprint item as optional chat context without entering edit mode', () => {
    const actions = props()
    render(<BlueprintPanel {...(actions as unknown as BlueprintPanelProps)} />)

    fireEvent.click(screen.getByText('比较竞品。'))

    expect(actions.selectNode).toHaveBeenCalledWith('purpose:persona')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('shows and clears the selected context chip in the conversation dock', () => {
    const actions = props('capability:web-search')
    render(<BlueprintSelectedContext {...(actions as unknown as BlueprintSelectedContextProps)} />)

    expect(screen.getByText('已选：')).toBeTruthy()
    expect(screen.getByText('竞品信息核验')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '清除已选 Blueprint 上下文' }))

    expect(actions.clearSelection).toHaveBeenCalledTimes(1)
  })

  it('keeps the selected context chip visible before Creator Ready', () => {
    const actions = props()
    const state = { ...creatorState('creating', null), selectedNodeId: 'capability:web-search' }
    const creatorActions = {
      ...actions,
      useBlueprintUi: <T,>(selector: (value: BlueprintUiState) => T): T => selector(state),
    }

    render(<BlueprintSelectedContext {...(creatorActions as unknown as BlueprintSelectedContextProps)} />)

    expect(screen.getByText('已选：')).toBeTruthy()
    expect(screen.getByText('竞品信息核验')).toBeTruthy()
  })

  it('shows and clears a capability handoff in the conversation dock', () => {
    const actions = props()
    const handoffActions = {
      ...actions,
      useBlueprintUi: <T,>(selector: (value: BlueprintUiState) => T): T => selector({
        phase: 'ready', agents: [], presetId: 'competitive-research', blueprint: BLUEPRINT,
        selectedNodeId: null, modal: null, busy: false, error: null, validation: null,
        proposalCancellations: [], creator: null,
        capabilityHandoff: {
          ...CAPABILITY_OWNER,
          request: '我希望它能分析上市公司财报', label: '分析上市公司财报',
          targetPresetId: 'competitive-research', revision: 'r1', status: 'configuring',
        },
      }),
    }

    render(<BlueprintSelectedContext {...(handoffActions as unknown as BlueprintSelectedContextProps)} />)

    expect(screen.getByText('正在判断能力 · 分析上市公司财报')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '取消添加能力上下文' }))
    expect(actions.clearCapabilityHandoff).toHaveBeenCalledTimes(1)
  })

  it('shows a recovered capability approval wait in the conversation dock', () => {
    const actions = props()
    const handoffActions = {
      ...actions,
      useBlueprintUi: <T,>(selector: (value: BlueprintUiState) => T): T => selector({
        phase: 'ready', agents: [], presetId: 'competitive-research', blueprint: BLUEPRINT,
        selectedNodeId: null, modal: null, busy: false, error: null, validation: null,
        proposalCancellations: [], creator: null,
        capabilityHandoff: {
          ...CAPABILITY_OWNER,
          request: '创建 CSV 财报指标提取 Skill', label: 'CSV 财报指标提取',
          targetPresetId: 'competitive-research', revision: 'r1', status: 'authoring',
          waitingFor: 'approval', authoringKind: 'skill', creatorSessionId: 'creator-session', startSeq: 40,
        },
      }),
    }

    render(<BlueprintSelectedContext {...(handoffActions as unknown as BlueprintSelectedContextProps)} />)

    expect(screen.getByText('等待授权 · CSV 财报指标提取')).toBeTruthy()
  })

  it.each([
    ['completed', '✓ CSV 财报指标提取已加入'],
    ['failed', '这项能力暂时没配置好 · CSV 财报指标提取'],
    ['cancelled', '配置已取消 · CSV 财报指标提取'],
  ] as const)('shows a stable %s capability terminal without an active cancellation control', (status, text) => {
    const actions = props()
    const terminalActions = {
      ...actions,
      useBlueprintUi: <T,>(selector: (value: BlueprintUiState) => T): T => selector({
        phase: 'ready', agents: [], presetId: 'competitive-research', blueprint: BLUEPRINT,
        selectedNodeId: null, modal: null, busy: false, error: null, validation: null,
        proposalCancellations: [], creator: null,
        capabilityHandoff: {
          ...CAPABILITY_OWNER,
          request: '创建 CSV 财报指标提取 Skill', label: 'CSV 财报指标提取',
          targetPresetId: 'competitive-research', revision: 'r2', status,
          authoringKind: 'skill', creatorSessionId: 'creator-session', startSeq: 40,
          terminal: {
            outcome: status, endSeq: 46,
            ...(status === 'failed' ? { message: '挂载验证失败' } : {}),
          },
        },
      }),
    }

    render(<BlueprintSelectedContext {...(terminalActions as unknown as BlueprintSelectedContextProps)} />)

    expect(screen.getByText(text)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '取消添加能力上下文' })).toBeNull()
    if (status === 'failed') {
      expect(document.body.textContent).not.toContain('挂载验证失败')
      fireEvent.click(screen.getByRole('button', { name: '重新尝试添加：CSV 财报指标提取' }))
      expect(actions.beginCapabilityHandoff).toHaveBeenCalledWith('创建 CSV 财报指标提取 Skill')
    } else {
      expect(screen.queryByText('重新尝试')).toBeNull()
    }
  })

  it('shows a human proposal preview and waits for Apply before writing', () => {
    const actions = props()
    const block = proposalBlock()
    const changeSet = block.meta?.blueprintChangeSet
    if (changeSet === undefined) throw new Error('proposal fixture is missing its Change Set')
    render(<BlueprintProposalRow {...({
      ...actions, sessionId: 'conversation-a', callId: 'proposal-1', toolName: 'propose_blueprint_change',
      block, openFile: vi.fn(),
    } as unknown as BlueprintProposalRowProps)} />)

    expect(screen.getByText('将关闭网页搜索')).toBeTruthy()
    expect(screen.getByText('Agent 将不再主动搜索最新公开信息。')).toBeTruthy()
    expect(screen.queryByText('setCapability')).toBeNull()
    expect(actions.applyChangeSet).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '应用' }))
    expect(actions.applyChangeSet).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(actions.cancelProposal).toHaveBeenCalledWith(changeSet)
  })

  it('groups reconciliation proposals behind one explicit Apply-all action', () => {
    const actions = props()
    render(<BlueprintProposalRow {...({
      ...actions, sessionId: 'conversation-a', callId: 'reconcile-1', toolName: 'propose_blueprint_change',
      block: reconciliationBlock(), openFile: vi.fn(),
    } as unknown as BlueprintProposalRowProps)} />)

    expect(screen.getByText('为了让 Agent 与新目标保持一致，建议同步调整 2 项配置')).toBeTruthy()
    expect(screen.queryByText('原规则仍引用德国 APS 与 uni-assist。')).toBeNull()
    expect(actions.applyChangeSet).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '查看调整' }))
    expect(screen.getByText('原规则仍引用德国 APS 与 uni-assist。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '全部应用' }))
    const [applied] = actions.applyChangeSet.mock.calls
    expect(applied?.[0].changeSetId).toBe('reconcile-1')
    expect(applied?.[0].proposals.some(proposal => proposal.targetNodeId === 'behavior:1')).toBe(true)
  })

  it('renders a structured Purpose edit and its P2 dependencies only in the owner Session', () => {
    const actions = props()
    const view = render(<BlueprintProposalRow {...({
      ...actions, sessionId: 'conversation-a', callId: 'purpose-edit-1', toolName: 'propose_blueprint_change',
      block: structuredEditBlock(), openFile: vi.fn(),
    } as unknown as BlueprintProposalRowProps)} />)

    expect(screen.getByText('将更新 Agent 的目标，并建议同步调整 1 项配置')).toBeTruthy()
    expect(screen.getByText('只比较公开可核实的竞品信息。')).toBeTruthy()
    expect(screen.queryByText('旧规则没有限定公开来源。')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '查看关联调整' }))
    expect(screen.getByText('旧规则没有限定公开来源。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '全部应用' }))
    expect(actions.applyChangeSet).toHaveBeenCalledWith(expect.objectContaining({
      changeSetId: 'purpose-edit-1', sourceSessionId: 'conversation-a', routeId: 'purpose-route-a',
    }))

    view.unmount()
    render(<BlueprintProposalRow {...({
      ...actions, sessionId: 'conversation-b', callId: 'purpose-edit-1', toolName: 'propose_blueprint_change',
      block: structuredEditBlock(), openFile: vi.fn(),
    } as unknown as BlueprintProposalRowProps)} />)
    expect(screen.queryByText('只比较公开可核实的竞品信息。')).toBeNull()
  })

  it.each([
    [{
      changeSetId: 'identity-edit', sourceNodeId: 'identity:persona', sourceNodeType: 'identity',
      sourceLabel: '角色', operation: 'updateIdentity', currentValue: '竞品研究分析师',
      proposedValue: 'AI 产品竞品研究顾问', impact: '角色定位更具体。',
    }, '将更新 Agent 的角色定位'],
    [{
      changeSetId: 'behavior-edit', sourceNodeId: 'behavior:1', sourceNodeType: 'behavior',
      sourceLabel: 'Behavior', operation: 'updateBehavior', currentValue: '只采用可核实的竞品事实。',
      proposedValue: '优先采用官方来源。', impact: '调整研究规则。',
    }, '将更新 Agent 的规则'],
    [{
      changeSetId: 'output-edit', sourceNodeId: 'output:2', sourceNodeType: 'output',
      sourceLabel: 'Output', operation: 'updateOutput', currentValue: '摘要、对比表、结论和来源。',
      proposedValue: '输出带引用的结构化对比报告。', impact: '明确输出格式。',
    }, '将更新 Agent 的输出要求'],
    [{
      changeSetId: 'web-search-edit', sourceNodeId: 'capability:web-search', sourceNodeType: 'capability',
      sourceLabel: 'Web Search', operation: 'setCapability', currentValue: true,
      proposedValue: false, impact: '关闭网页搜索。',
    }, '将关闭网页搜索'],
  ] as const)('renders a source-accurate structured %s Proposal card and actions', (input, title) => {
    const editableBlueprint: Blueprint = {
      ...BLUEPRINT,
      nodes: BLUEPRINT.nodes.map(node => node.id === input.sourceNodeId ? { ...node, editable: true } : node),
    }
    const actions = props(null, editableBlueprint)
    render(<BlueprintProposalRow {...({
      ...actions, sessionId: 'conversation-a', callId: input.changeSetId,
      toolName: 'propose_blueprint_change', block: structuredEditVariantBlock(input), openFile: vi.fn(),
    } as unknown as BlueprintProposalRowProps)} />)

    expect(screen.getByText(title)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '应用' }))
    expect(actions.applyChangeSet).toHaveBeenCalledWith(expect.objectContaining({
      changeSetId: input.changeSetId, sourceNodeType: input.sourceNodeType,
    }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(actions.cancelProposal).toHaveBeenCalledWith(expect.objectContaining({
      changeSetId: input.changeSetId, sourceNodeType: input.sourceNodeType,
    }))
  })

  it.each([
    ['a different Tool call', (_changeSet: Record<string, unknown>) => {}, 'other-call'],
    ['a source-node target mismatch', (changeSet: Record<string, unknown>) => {
      const [source] = changeSet['proposals'] as Record<string, unknown>[]
      source!['targetNodeId'] = 'behavior:1'
    }, 'purpose-edit-1'],
    ['a source-type operation mismatch', (changeSet: Record<string, unknown>) => {
      const [source] = changeSet['proposals'] as Record<string, unknown>[]
      source!['operation'] = 'updateIdentity'
    }, 'purpose-edit-1'],
    ['an operation/scalar mismatch', (changeSet: Record<string, unknown>) => {
      const [source] = changeSet['proposals'] as Record<string, unknown>[]
      source!['currentValue'] = true
      source!['proposedValue'] = false
    }, 'purpose-edit-1'],
    ['an unchanged proposed scalar', (changeSet: Record<string, unknown>) => {
      const [source] = changeSet['proposals'] as Record<string, unknown>[]
      source!['proposedValue'] = source!['currentValue']
    }, 'purpose-edit-1'],
  ] as const)('rejects structured metadata associated with %s', (_name, mutate, callId) => {
    const actions = props()
    const block = structuredEditBlock()
    const meta = block.meta as { blueprintChangeSet: Record<string, unknown> }
    mutate(meta.blueprintChangeSet)

    render(<BlueprintProposalRow {...({
      ...actions, sessionId: 'conversation-a', callId,
      toolName: 'propose_blueprint_change', block, openFile: vi.fn(),
    } as unknown as BlueprintProposalRowProps)} />)

    expect(screen.getByText('未生成可应用的修改建议')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '应用' })).toBeNull()
    expect(screen.queryByRole('button', { name: '全部应用' })).toBeNull()
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull()
  })

  it('rejects an access node masquerading as a structured edit', () => {
    const actions = props()
    const block = structuredEditVariantBlock({
      changeSetId: 'access-edit', sourceNodeId: 'access:permissions', sourceNodeType: 'purpose',
      sourceLabel: 'Access', operation: 'updatePurpose', currentValue: 'restricted',
      proposedValue: 'open', impact: '扩大权限。',
    })
    const meta = block.meta as { blueprintChangeSet: Record<string, unknown> }
    meta.blueprintChangeSet['sourceNodeType'] = 'access'

    render(<BlueprintProposalRow {...({
      ...actions, sessionId: 'conversation-a', callId: 'access-edit',
      toolName: 'propose_blueprint_change', block, openFile: vi.fn(),
    } as unknown as BlueprintProposalRowProps)} />)

    expect(screen.getByText('未生成可应用的修改建议')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '应用' })).toBeNull()
  })

  it('reports a committed reconciliation transaction without obsolete per-item read wording', () => {
    const actions = props()
    const appliedBlueprint: Blueprint = {
      ...BLUEPRINT,
      nodes: BLUEPRINT.nodes.map((node) => {
        if (node.id === 'behavior:1') {
          return { ...node, value: '优先采用美国院校官网和官方申请渠道。' }
        }
        if (node.id === 'identity:persona') {
          return { ...node, value: '美国留学申请顾问' }
        }
        return node
      }),
    }
    const appliedActions = {
      ...actions,
      useBlueprintUi: <T,>(selector: (value: BlueprintUiState) => T): T => selector({
        phase: 'ready', agents: [], presetId: 'competitive-research', blueprint: appliedBlueprint,
        selectedNodeId: null, modal: null, busy: false, error: null, validation: null,
        proposalCancellations: [], creator: null, capabilityHandoff: null,
        applyReceipts: [{
          sourceSessionId: 'conversation-a', routeId: 'interaction-a', proposalResultSeq: 11, terminalSeq: 12,
          presetId: 'competitive-research', result: {
            sourceSessionId: 'conversation-a', routeId: 'interaction-a',
            changeSetId: 'reconcile-1', baseRevision: 'r1', committedRevision: 'r2', status: 'committed',
            preflight: { ok: true }, unexpectedDrift: [], operations: [
              { operation: 'updateBehavior', targetNodeId: 'behavior:1', expected: '只采用可核实的竞品事实。', value: '优先采用美国院校官网和官方申请渠道。' },
              { operation: 'updateIdentity', targetNodeId: 'identity:persona', expected: '竞品研究分析师', value: '美国留学申请顾问' },
            ],
          },
        }],
      }),
    }
    render(<BlueprintProposalRow {...({
      ...appliedActions, sessionId: 'conversation-a', callId: 'reconcile-1', toolName: 'propose_blueprint_change',
      block: reconciliationBlock(), openFile: vi.fn(),
    } as unknown as BlueprintProposalRowProps)} />)

    expect(screen.getByText('已全部应用')).toBeTruthy()
    expect(screen.queryByText('已全部应用并逐项重新读取 Blueprint')).toBeNull()
  })

  it('keeps a persisted proposal non-applicable while Creator authoring is active', () => {
    const actions = props()
    const lockedState = {
      ...creatorState('waiting', 'question'),
      presetId: 'competitive-research',
      blueprint: BLUEPRINT,
    }
    const lockedActions = {
      ...actions,
      useBlueprintUi: <T,>(selector: (value: BlueprintUiState) => T): T => selector(lockedState),
    }
    render(<BlueprintProposalRow {...({
      ...lockedActions, sessionId: 'conversation-a', callId: 'proposal-1', toolName: 'propose_blueprint_change',
      block: proposalBlock(), openFile: vi.fn(),
    } as unknown as BlueprintProposalRowProps)} />)

    expect(screen.getByText('Creator 正在调整 Agent，完成后才能应用。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '应用' })).toBeNull()
    expect(actions.applyChangeSet).not.toHaveBeenCalled()
  })

  it('does not render a proposal in a different foreground Session', () => {
    const actions = props()
    render(<BlueprintProposalRow {...({
      ...actions, sessionId: 'capability-session-b', callId: 'proposal-1', toolName: 'propose_blueprint_change',
      block: proposalBlock(), openFile: vi.fn(),
    } as unknown as BlueprintProposalRowProps)} />)

    expect(screen.queryByText('将关闭网页搜索')).toBeNull()
    expect(actions.applyChangeSet).not.toHaveBeenCalled()
  })
})
