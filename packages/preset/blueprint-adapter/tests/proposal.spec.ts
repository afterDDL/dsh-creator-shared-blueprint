import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Blueprint, BlueprintStructuredEditInput } from '../src/types.ts'
import {
  blueprintUserChangeForCurrentTurn, blueprintUserChangeMessage, createBlueprintChangeProposal,
  createBlueprintChangeSet, createBlueprintStructuredEdit, createBlueprintStructuredEditChangeSet,
  createBlueprintCapabilityAuthoringRoute,
  createBlueprintCreatorAuthoringRoute,
  createBlueprintReconciliationChangeSet, createBlueprintUserChange,
  blueprintConversationGuidance, capabilityAuthoringGuidance, creatorAuthoringGuidance,
  hasExplicitBlueprintModificationIntent,
  parseBlueprintChangeSetArgs,
  type BlueprintProposalArgs,
} from '../src/proposal.ts'
import type { BlueprintRoutingInput } from '../src/routing.ts'

function routingInput(userRequest: string): BlueprintRoutingInput {
  return { routeId: 'interaction', userRequest, sourceSessionId: SessionId('source'), userMessageId: MessageId('user'),
    userMessageSeq: 2, turn: 1, targetPresetId: 'competitive-research', provenance: 'user-message' }
}

const BLUEPRINT: Blueprint = {
  schemaVersion: 1,
  preset: { id: 'competitive-research', trust: 'user', name: '竞品研究' },
  revision: 'revision-1',
  nodes: [
    { id: 'identity:persona', type: 'identity', value: '竞品研究分析师', source: 'preset', status: 'active', editable: true, adapterRef: 'identity' },
    { id: 'purpose:persona', type: 'purpose', value: '比较主要竞品。', source: 'inferred', status: 'active', editable: true, adapterRef: 'purpose' },
    { id: 'behavior:1', type: 'behavior', value: '优先采用可靠来源。', source: 'preset', status: 'active', editable: true, adapterRef: 'behavior:1' },
    { id: 'output:2', type: 'output', value: '输出摘要、结论和来源。', source: 'inferred', status: 'active', editable: true, adapterRef: 'output:2' },
    { id: 'capability:web-search', type: 'capability', value: { name: 'Web Search', tool: 'web_search', enabled: true }, source: 'runtime', status: 'active', editable: true, adapterRef: 'search' },
    { id: 'capability:web-fetch', type: 'capability', value: { name: 'Web Fetch', tool: 'web_fetch', enabled: true }, source: 'runtime', status: 'active', editable: true, adapterRef: 'fetch' },
    { id: 'capability:file-read', type: 'capability', value: { name: 'File Read', tool: 'read', enabled: true }, source: 'runtime', status: 'active', editable: false, adapterRef: null },
  ],
  runtime: { tools: ['web_search', 'web_fetch', 'read'], promptSections: ['deployment:persona'], skills: [], delegations: [], permissions: null },
  mappingGaps: [],
}

const OWNER = { sourceSessionId: 'source', routeId: 'interaction' }

function proposal(args: BlueprintProposalArgs, userText: string, selectedNodeId?: string) {
  return createBlueprintChangeProposal(BLUEPRINT, args, 'call-1', userText, selectedNodeId)
}

function purposeChange(previousValue: string, currentValue: string, blueprint = BLUEPRINT) {
  const changed: Blueprint = {
    ...blueprint,
    nodes: blueprint.nodes.map(node => node.id === 'purpose:persona'
      ? { ...node, value: currentValue }
      : node),
  }
  return createBlueprintUserChange(changed, { nodeId: 'purpose:persona', previousValue })
}

describe('conversation-driven Blueprint proposal policy', () => {
  it('binds genuine capability authoring to the current preset and rejects untyped routes', () => {
    expect(createBlueprintCapabilityAuthoringRoute(BLUEPRINT, {
      request: '解析私有课程包格式', kind: 'skill', reason: '当前没有这种格式的解析定义。',
    }, { routeId: 'interaction', sourceSessionId: 'source' })).toEqual({
      routeId: 'interaction', sourceSessionId: 'source',
      presetId: 'competitive-research', revision: 'revision-1',
      request: '解析私有课程包格式', kind: 'skill', reason: '当前没有这种格式的解析定义。',
    })
    expect(() => createBlueprintCapabilityAuthoringRoute(BLUEPRINT, {
      request: '解析私有课程包格式', kind: 'plugin', reason: '需要任意插件。',
    }, { routeId: 'interaction', sourceSessionId: 'source' })).toThrow(/kind must be skill or subagent/u)
    expect(createBlueprintCapabilityAuthoringRoute(BLUEPRINT, {
      request: 'ローカルCSV解析スキルを追加してください。',
      kind: 'skill', reason: '現在の構成にはCSV解析定義がありません。',
    }, { routeId: 'interaction', sourceSessionId: 'source' })).toMatchObject({ kind: 'skill', request: 'ローカルCSV解析スキルを追加してください。' })
    expect(createBlueprintCapabilityAuthoringRoute(BLUEPRINT, {
      request: '산업 구조를 분석하는 협업 에이전트를 추가해 주세요.',
      kind: 'subagent', reason: '현재 구성에는 해당 위임 역할이 없습니다.',
    }, { routeId: 'interaction', sourceSessionId: 'source' })).toMatchObject({ kind: 'subagent', request: '산업 구조를 분석하는 협업 에이전트를 추가해 주세요.' })
  })

  it('binds multilingual new-Agent decisions to the exact direct request without language fallback routing', () => {
    const english = 'Create an agent that researches public AI companies and produces concise reports.'
    expect(createBlueprintCreatorAuthoringRoute(routingInput(english), {
      user_intent: english,
      name: 'Public AI Company Research Agent',
    }, 'call-en')).toEqual({
      operation: 'create-agent',
      routeId: 'call-en',
      request: english,
      name: 'Public AI Company Research Agent',
    })
    const chinese = '我要一个上市公司研究 Agent。'
    expect(createBlueprintCreatorAuthoringRoute(routingInput(chinese), {
      user_intent: chinese,
      name: '上市公司研究 Agent',
    }, 'call-zh')).toMatchObject({
      operation: 'create-agent', request: chinese, sourceLanguage: 'zh',
    })
    const japanese = '上場AI企業を調査するエージェントを作ってください。'
    expect(createBlueprintCreatorAuthoringRoute(routingInput(japanese), {
      user_intent: japanese,
      name: '上場AI企業リサーチ Agent',
    }, 'call-ja')).toMatchObject({
      operation: 'create-agent', request: japanese, sourceLanguage: 'ja',
    })
    const korean = '상장 AI 기업을 조사하는 에이전트를 만들어 주세요.'
    expect(createBlueprintCreatorAuthoringRoute(routingInput(korean), {
      user_intent: korean,
      name: '상장 AI 기업 리서치 Agent',
    }, 'call-ko')).toMatchObject({
      operation: 'create-agent', request: korean, sourceLanguage: 'ko',
    })
  })

  it('does not accept new-Agent evidence quoted from guidance instead of the original request', () => {
    expect(() => createBlueprintCreatorAuthoringRoute(routingInput('增加 CSV 处理能力'), {
      name: 'Wrong Agent', user_intent: 'create a new Agent',
    }, 'route')).toThrow(/provenance-conflict/u)
  })

  it('preserves an explicitly requested Skill mechanism instead of approximating it with text nodes', () => {
    const guidance = blueprintConversationGuidance(BLUEPRINT)

    expect(guidance).toContain('explicit request to create, add, or mount a Skill')
    expect(guidance).toContain('never replace that requested object')
    expect(guidance).toContain('route_blueprint_capability_authoring')
    expect(guidance).toContain('route_blueprint_creator_authoring')
    expect(guidance).toContain('distinct new Agent')
  })

  it('limits Subagent Creator authoring to one mounted delegation row', () => {
    const guidance = capabilityAuthoringGuidance({
      sourceSessionId: 'source-1',
      routeId: 'route-1',
      targetPresetId: 'competitive-research',
      baseRevision: 'revision-1',
      request: '添加行业研究协作者',
      kind: 'subagent',
    })

    expect(guidance).toContain('Do not call preset_copy')
    expect(guidance).toContain('Author only the delegation row')
    expect(guidance).toContain('Do not edit Identity, Purpose, Behavior, Output')
    expect(guidance).toContain('preset_validate proves mountability, not runtime conformance')
    expect(guidance).toContain('existing-Agent Proposal path')
  })

  it('isolates a target-owned filesystem Skill from ambient catalog roots', () => {
    const guidance = capabilityAuthoringGuidance({
      sourceSessionId: 'source-1',
      routeId: 'route-1',
      targetPresetId: 'competitive-research',
      baseRevision: 'revision-1',
      request: '添加 CSV 财务指标提取 Skill',
      kind: 'skill',
    })

    expect(guidance).toContain('add exactly one target-owned filesystem Skill definition')
    expect(guidance).toContain('@deepseek-ai/dsh-skill-filesystem')
    expect(guidance).toContain('preserve its provider, defaults, and existing roots')
    expect(guidance).toContain('append the path rooted from baseUrl to customSkillDirs')
    expect(guidance).toContain('includeDefaultRoots: false')
    expect(guidance).toContain('customSkillDirs containing only that preset-local path')
    expect(guidance).toContain('does not import ambient project or user Skills')
    expect(guidance).toContain('exactly one new target-owned, model-invocable Skill and no new delegation')
    expect(guidance).toContain('independent mounted-catalog verification')
  })

  it('steers typed Creator authoring from open source-language metadata without an English fallback', () => {
    const guidance = creatorAuthoringGuidance({
      name: 'Public AI Company Research Agent', status: 'creating',
    }, undefined, {
      operation: 'create-agent', routeId: 'route-1', sourceSessionId: 'source-1',
      request: '上場AI企業を調査するエージェントを作ってください。',
      name: '上場AI企業リサーチ Agent', sourceLanguage: 'ja',
    })

    expect(guidance).toContain('Operation: create-agent')
    expect(guidance).toContain('Original user request: 上場AI企業を調査するエージェントを作ってください。')
    expect(guidance).toContain('Source language metadata: ja')
    expect(guidance).toContain('without defaulting to English')
    expect(guidance).toContain('Execute real preset authoring')
    expect(guidance).toContain('Use the built-in preset_list, preset_read, preset_resolve, preset_copy, and preset_validate')
  })

  it('records one Host-derived direct edit without implementation fields', () => {
    const changed: Blueprint = {
      ...BLUEPRINT,
      revision: 'revision-2',
      nodes: BLUEPRINT.nodes.map(node => node.id === 'purpose:persona'
        ? { ...node, value: '深度分析用户访谈。' }
        : node),
    }

    const event = createBlueprintUserChange(changed, {
      nodeId: 'purpose:persona', previousValue: '比较主要竞品。',
    })
    const message = blueprintUserChangeMessage(event)
    const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')

    expect(event).toMatchObject({
      presetId: 'competitive-research', nodeId: 'purpose:persona', nodeType: 'purpose',
      label: 'Purpose', previousValue: '比较主要竞品。', currentValue: '深度分析用户访谈。',
      operation: 'update',
    })
    expect(event.impactCandidates.map(candidate => candidate.nodeId))
      .toEqual(['identity:persona', 'behavior:1', 'output:2'])
    expect(message.source).toMatchObject({ kind: 'plugin', plugin: 'blueprint-adapter' })
    expect(text).toContain('already succeeded')
    expect(text).not.toMatch(/revision|adapterRef|ya?ml/iu)
  })

  it('stages one structured Purpose edit against the committed projection and bounds P2 candidates', () => {
    const edit = createBlueprintStructuredEdit(BLUEPRINT, {
      sourceSessionId: 'source', routeId: 'purpose-route', nodeId: 'purpose:persona', nodeType: 'purpose',
      expectedValue: '比较主要竞品。', proposedValue: '只做公司基本面、行业和估值研究。',
    })
    const input: BlueprintRoutingInput = {
      ...routingInput('将 Purpose 修改为：只做公司基本面、行业和估值研究。'),
      routeId: 'purpose-route', provenance: 'direct-edit', directEdit: edit,
    }
    const args = { intent: 'modify-existing-agent' as const, changes: [{
      target_node_id: 'purpose:persona', operation: 'updatePurpose' as const,
      current_value: '比较主要竞品。', proposed_value: '只做公司基本面、行业和估值研究。',
      impact: '收窄 Agent 的研究目标。',
    }, {
      target_node_id: 'behavior:1', operation: 'updateBehavior' as const,
      current_value: '优先采用可靠来源。', proposed_value: '只分析公司基本面、行业和估值，不给出投资建议。',
      impact: '使执行规则与收窄后的目标一致。', dependency: '当前规则没有明确排除投资建议。',
    }] }

    expect(edit).toMatchObject({
      nodeId: 'purpose:persona', operation: 'updatePurpose', currentValue: '比较主要竞品。',
      proposedValue: '只做公司基本面、行业和估值研究。',
    })
    expect(edit.impactCandidates.map(candidate => candidate.nodeId))
      .toEqual(['identity:persona', 'behavior:1', 'output:2'])
    expect(createBlueprintStructuredEditChangeSet(BLUEPRINT, args, 'purpose-change-set', input, {
      sourceSessionId: 'source', routeId: 'purpose-route',
    })).toMatchObject({
      kind: 'structured-edit', changeSetId: 'purpose-change-set', sourceSessionId: 'source',
      routeId: 'purpose-route', sourceNodeId: 'purpose:persona', revision: 'revision-1',
      proposals: [
        { targetNodeId: 'purpose:persona', operation: 'updatePurpose' },
        { targetNodeId: 'behavior:1', operation: 'updateBehavior', dependency: '当前规则没有明确排除投资建议。' },
      ],
    })
    expect(BLUEPRINT.nodes.find(node => node.id === 'purpose:persona')?.value).toBe('比较主要竞品。')
  })

  it.each([
    { input: { sourceSessionId: 'source', routeId: 'route:identity:persona', nodeId: 'identity:persona', nodeType: 'identity', expectedValue: '竞品研究分析师', proposedValue: '行业研究顾问' }, operation: 'updateIdentity' },
    { input: { sourceSessionId: 'source', routeId: 'route:purpose:persona', nodeId: 'purpose:persona', nodeType: 'purpose', expectedValue: '比较主要竞品。', proposedValue: '只比较公开市场竞品。' }, operation: 'updatePurpose' },
    { input: { sourceSessionId: 'source', routeId: 'route:behavior:1', nodeId: 'behavior:1', nodeType: 'behavior', expectedValue: '优先采用可靠来源。', proposedValue: '只采用可核实的一手来源。' }, operation: 'updateBehavior' },
    { input: { sourceSessionId: 'source', routeId: 'route:output:2', nodeId: 'output:2', nodeType: 'output', expectedValue: '输出摘要、结论和来源。', proposedValue: '输出结论、证据和来源。' }, operation: 'updateOutput' },
    { input: { sourceSessionId: 'source', routeId: 'route:capability:web-search', nodeId: 'capability:web-search', nodeType: 'capability', expectedValue: true, proposedValue: false }, operation: 'setCapability' },
  ] satisfies readonly { input: BlueprintStructuredEditInput; operation: string }[])(
    'derives a typed zero-write structured edit for $input.nodeId', ({ input, operation }) => {
      const before = JSON.stringify(BLUEPRINT)
      expect(createBlueprintStructuredEdit(BLUEPRINT, input)).toMatchObject({
        nodeId: input.nodeId, nodeType: input.nodeType, operation,
        currentValue: input.expectedValue, proposedValue: input.proposedValue,
      })
      expect(JSON.stringify(BLUEPRINT)).toBe(before)
    },
  )

  it('rejects structured Purpose proposals that replace the source edit or escape the P2 candidate set', () => {
    const edit = createBlueprintStructuredEdit(BLUEPRINT, {
      sourceSessionId: 'source', routeId: 'purpose-route', nodeId: 'purpose:persona', nodeType: 'purpose',
      expectedValue: '比较主要竞品。', proposedValue: '只做公司基本面研究。',
    })
    const input: BlueprintRoutingInput = {
      ...routingInput('将 Purpose 修改为：只做公司基本面研究。'),
      routeId: 'purpose-route', provenance: 'direct-edit', directEdit: edit,
    }
    const source = {
      target_node_id: 'purpose:persona', operation: 'updatePurpose' as const,
      current_value: '比较主要竞品。', proposed_value: '只做公司基本面研究。', impact: '收窄研究目标。',
    }

    expect(() => createBlueprintStructuredEditChangeSet(BLUEPRINT, {
      intent: 'modify-existing-agent', changes: [{ ...source, proposed_value: '模型自行改写的目标。' }],
    }, 'wrong-source', input, OWNER)).toThrow(/first change must exactly match/u)
    expect(() => createBlueprintStructuredEditChangeSet(BLUEPRINT, {
      intent: 'modify-existing-agent', changes: [source, {
        target_node_id: 'capability:web-search', operation: 'setCapability',
        current_value: true, proposed_value: false, impact: '无关地关闭搜索。', dependency: '无关依赖。',
      }],
    }, 'outside-candidates', input, OWNER)).toThrow(/outside the deterministic impact candidate set/u)
  })

  it('derives enable and disable operations from a fresh capability projection', () => {
    const disabled: Blueprint = {
      ...BLUEPRINT,
      revision: 'revision-2',
      nodes: BLUEPRINT.nodes.map(node => node.id === 'capability:web-search'
        ? { ...node, value: { ...node.value as object, enabled: false } }
        : node),
    }

    expect(createBlueprintUserChange(disabled, {
      nodeId: 'capability:web-search', previousValue: true,
    })).toMatchObject({
      label: 'Web Search', previousValue: true, currentValue: false, operation: 'disable',
    })
    expect(createBlueprintUserChange(BLUEPRINT, {
      nodeId: 'capability:web-search', previousValue: false,
    })).toMatchObject({ currentValue: true, operation: 'enable' })
  })

  it('recognizes only the plugin notice that opened the current reconciliation turn', () => {
    const session = Session.create(SessionId('blueprint-reconciliation'))
    const change = createBlueprintUserChange({
      ...BLUEPRINT,
      revision: 'revision-2',
      nodes: BLUEPRINT.nodes.map(node => node.id === 'purpose:persona'
        ? { ...node, value: '深度分析用户访谈。' }
        : node),
    }, { nodeId: 'purpose:persona', previousValue: '比较主要竞品。' })
    session.append('blueprint/user-change', change)
    session.append('turn/start', { turn: 1 })
    session.append('user/message', blueprintUserChangeMessage(change), { surfaceOp: 'append' })

    expect(blueprintUserChangeForCurrentTurn({ session } as Agent)).toEqual(change)

    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '普通后续。' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(blueprintUserChangeForCurrentTurn({ session } as Agent)).toBeUndefined()
  })

  it('groups causally related reconciliation proposals and rejects the edited node', () => {
    const change = purposeChange('快速整理访谈。', '深度分析访谈。')

    expect(createBlueprintReconciliationChangeSet(BLUEPRINT, { intent: 'reconcile-direct-edit', changes: [{
      target_node_id: 'behavior:1', operation: 'updateBehavior',
      current_value: '优先采用可靠来源。', proposed_value: '提炼需求、痛点和产品机会。',
      impact: '规则会与深度访谈分析目标保持一致。',
      dependency: '当前规则没有覆盖新目标要求的需求、痛点和产品机会分析。',
    }] }, 'reconcile-1', change, OWNER)).toMatchObject({
      changeSetId: 'reconcile-1', kind: 'direct-edit-reconciliation',
      proposals: [{ targetNodeId: 'behavior:1', operation: 'updateBehavior' }],
    })
    expect(() => createBlueprintReconciliationChangeSet(BLUEPRINT, { intent: 'reconcile-direct-edit', changes: [{
      target_node_id: 'purpose:persona', operation: 'updatePurpose',
      current_value: '比较主要竞品。', proposed_value: '深度分析访谈。',
      impact: '重复修改目标。', dependency: '重复修改已完成的目标。',
    }] }, 'reconcile-2', change, OWNER)).toThrow(/already succeeded/u)
  })

  it('admits an editable Identity as a causal Purpose reconciliation item', () => {
    const change = purposeChange('考研统考择校。', '帮助用户完成国内保研申请。')

    expect(createBlueprintReconciliationChangeSet(BLUEPRINT, { intent: 'reconcile-direct-edit', changes: [{
      target_node_id: 'identity:persona', operation: 'updateIdentity',
      current_value: '竞品研究分析师', proposed_value: '保研申请顾问',
      impact: 'Agent 将以保研申请顾问的角色工作。',
      dependency: '当前角色仍是旧任务定位，与新的保研申请目标直接冲突。',
    }] }, 'identity-reconcile', change, OWNER)).toMatchObject({
      proposals: [{ targetNodeId: 'identity:persona', operation: 'updateIdentity', proposedValue: '保研申请顾问' }],
    })
  })

  it('validates one Identity plus six related Behavior updates as one inert Change Set', () => {
    const rules = Array.from({ length: 6 }, (_, index) => ({
      id: `behavior:${String(index + 1)}`,
      type: 'behavior' as const,
      value: `统考规则 ${String(index + 1)}`,
      source: 'preset' as const,
      status: 'active' as const,
      editable: true,
      adapterRef: `behavior:${String(index + 1)}`,
    }))
    const kaoyanBlueprint: Blueprint = {
      ...BLUEPRINT,
      nodes: [...BLUEPRINT.nodes.filter(node => node.type !== 'behavior'), ...rules],
    }
    const changes = [
      {
        target_node_id: 'identity:persona', operation: 'updateIdentity' as const,
        current_value: '竞品研究分析师', proposed_value: '保研申请顾问',
        impact: '角色切换为保研申请顾问。', dependency: '旧角色与保研申请目标直接冲突。',
      },
      ...rules.map((rule, index) => ({
        target_node_id: rule.id, operation: 'updateBehavior' as const,
        current_value: rule.value, proposed_value: `推免规则 ${String(index + 1)}`,
        impact: `第 ${String(index + 1)} 条规则切换到推免口径。`,
        dependency: `第 ${String(index + 1)} 条规则仍使用统考口径。`,
      })),
    ]

    const result = createBlueprintReconciliationChangeSet(
      kaoyanBlueprint,
      { intent: 'reconcile-direct-edit', changes },
      'kaoyan-set',
      purposeChange('考研统考择校。', '帮助用户完成国内保研申请。', kaoyanBlueprint),
      OWNER,
    )

    expect(result.proposals).toHaveLength(7)
    expect(result.proposals[0]).toMatchObject({ operation: 'updateIdentity', proposedValue: '保研申请顾问' })
    expect(BLUEPRINT.nodes.find(node => node.id === 'identity:persona')?.value).toBe('竞品研究分析师')
  })

  it('requires an explicit dependency and unique targets in a reconciliation Change Set', () => {
    const change = purposeChange('留学德国。', '留学美国。')
    const item = {
      target_node_id: 'behavior:1', operation: 'updateBehavior' as const,
      current_value: '优先采用可靠来源。', proposed_value: '优先采用美国院校官方来源。',
      impact: '规则将改用美国留学口径。', dependency: '原规则仍以德国 APS 与 uni-assist 为依据。',
    }

    const { dependency, ...withoutDependency } = item
    expect(dependency).not.toBe('')
    expect(() => createBlueprintReconciliationChangeSet(BLUEPRINT, {
      intent: 'reconcile-direct-edit',
      changes: [withoutDependency],
    }, 'missing-dependency', change, OWNER)).toThrow(/dependency/u)
    expect(() => createBlueprintReconciliationChangeSet(BLUEPRINT, {
      intent: 'reconcile-direct-edit',
      changes: [item, item],
    }, 'duplicate-target', change, OWNER)).toThrow(/duplicate target/u)
  })

  it('does not infer active Creator state from an editable sentence mentioning new-Agent creation', () => {
    const text = '把目标中的创建新的 Agent 改成整理课程资料。'
    expect(proposal({
      target_node_id: 'purpose:persona', operation: 'updatePurpose',
      current_value: '比较主要竞品。', proposed_value: '整理课程资料。',
      impact: 'Agent 将改为整理课程资料。',
    }, text).proposedValue).toBe('整理课程资料。')
  })

  it('A: treats a question about the selected Web Search node as discussion only', () => {
    const text = '这个需要一直开着吗？'

    expect(hasExplicitBlueprintModificationIntent(text)).toBe(false)
    expect(() => proposal({
      target_node_id: 'capability:web-search', operation: 'setCapability',
      current_value: true, proposed_value: false, impact: 'Agent 将不再主动搜索最新信息。',
    }, text, 'capability:web-search')).toThrow(/explicit modification/u)
  })

  it('B: creates a typed disable proposal for an explicit follow-up without mutating state', () => {
    const result = proposal({
      target_node_id: 'capability:web-search', operation: 'setCapability',
      current_value: true, proposed_value: false, impact: 'Agent 将不再主动搜索最新公开信息。',
    }, '那关掉吧。', 'capability:web-search')

    expect(result).toEqual({
      proposalId: 'call-1', presetId: 'competitive-research', revision: 'revision-1',
      targetNodeId: 'capability:web-search', operation: 'setCapability',
      currentValue: true, proposedValue: false, impact: 'Agent 将不再主动搜索最新公开信息。',
    })
    expect((BLUEPRINT.nodes.find(node => node.id === 'capability:web-search')?.value as { enabled: boolean }).enabled).toBe(true)
  })

  it('C: proposes replacing the selected editable Behavior', () => {
    expect(proposal({
      target_node_id: 'behavior:1', operation: 'updateBehavior',
      current_value: '优先采用可靠来源。',
      proposed_value: '优先官网、官方文档和公司公告。',
      impact: '研究会优先引用一手官方来源。',
    }, '改成优先官网、官方文档和公司公告。', 'behavior:1')).toMatchObject({
      targetNodeId: 'behavior:1', operation: 'updateBehavior',
      proposedValue: '优先官网、官方文档和公司公告。',
    })
  })

  it('proposes replacing the selected editable Identity', () => {
    expect(proposal({
      target_node_id: 'identity:persona', operation: 'updateIdentity',
      current_value: '竞品研究分析师', proposed_value: '保研申请顾问',
      impact: 'Agent 将以保研申请顾问的角色工作。',
    }, '把角色改成保研申请顾问。', 'identity:persona')).toMatchObject({
      targetNodeId: 'identity:persona', operation: 'updateIdentity', proposedValue: '保研申请顾问',
    })
  })

  it('D: locates an editable Output without a selected node and preserves existing requirements', () => {
    expect(proposal({
      target_node_id: 'output:2', operation: 'updateOutput',
      current_value: '输出摘要、结论和来源。',
      proposed_value: '输出摘要、价格对比表、结论和来源。',
      impact: '交付物会新增价格对比表，并保留摘要、结论和来源。',
    }, '输出里增加价格对比表。')).toMatchObject({
      targetNodeId: 'output:2', operation: 'updateOutput',
      proposedValue: '输出摘要、价格对比表、结论和来源。',
    })
  })

  it('accepts a language-neutral typed existing-Agent decision for a Japanese imperative', () => {
    const args = parseBlueprintChangeSetArgs({
      intent: 'modify-existing-agent',
      changes: [{
        target_node_id: 'output:2', operation: 'updateOutput',
        current_value: '输出摘要、结论和来源。',
        proposed_value: 'Lead with a concise decision summary, then give evidence and sources.',
        impact: 'The report becomes shorter and decision-oriented.',
      }],
    })

    expect(createBlueprintChangeSet(
      BLUEPRINT,
      args,
      'japanese-direct-edit',
      '最終レポートを短くして、意思決定を重視してください。',
      undefined,
      OWNER,
    )).toMatchObject({
      kind: 'direct-request',
      proposals: [{ targetNodeId: 'output:2', operation: 'updateOutput' }],
    })
  })

  it('requires the typed proposal intent independently of the request language', () => {
    expect(() => parseBlueprintChangeSetArgs({ changes: [{
      target_node_id: 'output:2', operation: 'updateOutput',
      current_value: '输出摘要、结论和来源。', proposed_value: 'Short report.', impact: 'Shorter.',
    }] })).toThrow(/intent/u)
  })

  it('E: refuses File Read and cannot redirect a deictic request to another capability', () => {
    expect(() => proposal({
      target_node_id: 'capability:file-read', operation: 'setCapability',
      current_value: true, proposed_value: false, impact: 'Agent 将不能读取文件。',
    }, '把它关掉。', 'capability:file-read')).toThrow(/不能直接编辑/u)

    expect(() => proposal({
      target_node_id: 'capability:web-search', operation: 'setCapability',
      current_value: true, proposed_value: false, impact: 'Agent 将不再搜索网页。',
    }, '把它关掉。', 'capability:file-read')).toThrow(/must target the selected/u)
  })

  it('F: treats a hypothetical disable question as discussion only', () => {
    const text = '如果关掉网页搜索会怎样？'

    expect(hasExplicitBlueprintModificationIntent(text)).toBe(false)
    expect(() => proposal({
      target_node_id: 'capability:web-search', operation: 'setCapability',
      current_value: true, proposed_value: false, impact: 'Agent 将不再搜索网页。',
    }, text, 'capability:web-search')).toThrow(/explicit modification/u)
  })

  it('rejects stale current values and unsupported targets supplied by the model', () => {
    expect(() => proposal({
      target_node_id: 'capability:web-fetch', operation: 'setCapability',
      current_value: false, proposed_value: true, impact: 'Agent 将可以读取网页。',
    }, '打开网页读取。')).toThrow(/does not match/u)
    expect(() => proposal({
      target_node_id: 'capability:new', operation: 'setCapability',
      current_value: false, proposed_value: true, impact: '新增能力。',
    }, '增加这个能力。')).toThrow(/不在当前可调整/u)
  })
})
