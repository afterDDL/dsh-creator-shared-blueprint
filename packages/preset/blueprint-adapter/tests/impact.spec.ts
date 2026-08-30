import { describe, expect, it } from 'vitest'
import type { Blueprint, BlueprintNode } from '../src/types.ts'
import { createBlueprintReconciliationChangeSet, createBlueprintUserChange } from '../src/proposal.ts'

const OWNER = { sourceSessionId: 'source', routeId: 'interaction' }

function node(
  id: string,
  type: BlueprintNode['type'],
  value: BlueprintNode['value'],
  editable = true,
): BlueprintNode {
  return {
    id, type, value, source: type === 'purpose' || type === 'output' ? 'inferred' : 'preset',
    status: 'active', editable, adapterRef: editable ? `preset:persona.config.text#${id}` : null,
  }
}

function blueprint(nodes: BlueprintNode[]): Blueprint {
  return {
    schemaVersion: 1,
    preset: { id: 'impact-agent', trust: 'user' },
    revision: 'after-direct-edit',
    nodes,
    runtime: { tools: [], promptSections: ['deployment:persona'], skills: [], delegations: [], permissions: null },
    mappingGaps: [],
  }
}

describe('deterministic Blueprint impact candidates', () => {
  it('A: admits only prompt nodes that explicitly reference the disabled canonical Tool name', () => {
    const current = blueprint([
      node('purpose:persona', 'purpose', '分析用户提供的材料。'),
      node('behavior:1', 'behavior', '需要最新信息时调用 web_search，并记录查询来源。'),
      node('behavior:2', 'behavior', '维护 web_search_cache 标签，但不调用搜索工具。'),
      node('behavior:3', 'behavior', '只总结用户提供的内容。'),
      node('output:4', 'output', '输出摘要和结论。'),
      node('capability:web-search', 'capability', {
        name: 'Web Search', tool: 'web_search', enabled: false,
      }),
    ])
    const change = createBlueprintUserChange(current, {
      nodeId: 'capability:web-search', previousValue: true,
    })

    expect(change.impactCandidates).toEqual([{
      nodeId: 'behavior:1', evidence: [{ kind: 'tool-reference', value: 'web_search' }],
    }])
    expect(() => createBlueprintReconciliationChangeSet(current, { intent: 'reconcile-direct-edit', changes: [{
      target_node_id: 'behavior:3', operation: 'updateBehavior',
      current_value: '只总结用户提供的内容。', proposed_value: '改写无关规则。',
      impact: '修改无关规则。', dependency: '模型声称它有关联。',
    }] }, 'outside-candidate', change, OWNER)).toThrow(/outside the deterministic impact candidate set/u)
    expect(createBlueprintReconciliationChangeSet(current, { intent: 'reconcile-direct-edit', changes: [{
      target_node_id: 'behavior:1', operation: 'updateBehavior',
      current_value: '需要最新信息时调用 web_search，并记录查询来源。',
      proposed_value: '只使用用户提供的信息，并记录来源。',
      impact: '规则不再依赖已关闭的网页搜索。', dependency: '规则明确调用已关闭的 web_search。',
    }] }, 'hard-dependency', change, OWNER).proposals).toHaveLength(1)
  })

  it('B: bounds a Purpose change to same-persona Identity, Behavior, and Output nodes', () => {
    const current = blueprint([
      node('identity:persona', 'identity', '德国留学选校顾问'),
      node('purpose:persona', 'purpose', '帮助用户完成美国留学选校与申请。'),
      node('behavior:1', 'behavior', '核验 APS 材料要求。'),
      node('behavior:2', 'behavior', '参考 DAAD 院校信息。'),
      node('behavior:3', 'behavior', '检查 TestDaF 或 DSH 成绩。'),
      node('output:4', 'output', '输出德国院校对比表和申请计划。'),
      node('capability:web-search', 'capability', {
        name: 'Web Search', tool: 'web_search', enabled: true,
      }),
      node('access:permission-preset', 'access', { preset: 'workspace' }, false),
    ])
    const change = createBlueprintUserChange(current, {
      nodeId: 'purpose:persona', previousValue: '帮助用户完成德国留学选校与申请。',
    })

    expect(change.impactCandidates.map(candidate => candidate.nodeId)).toEqual([
      'identity:persona', 'behavior:1', 'behavior:2', 'behavior:3', 'output:4',
    ])
    expect(change.impactCandidates.find(candidate => candidate.nodeId === 'identity:persona'))
      .toEqual({
        nodeId: 'identity:persona',
        evidence: [{ kind: 'purpose-child' }, { kind: 'removed-literal', value: '德国' }],
      })
    expect(change.impactCandidates.find(candidate => candidate.nodeId === 'behavior:1'))
      .toEqual({ nodeId: 'behavior:1', evidence: [{ kind: 'purpose-child' }] })
    expect(change.impactCandidates.some(candidate => candidate.nodeId.startsWith('capability:'))).toBe(false)
    expect(change.impactCandidates.some(candidate => candidate.nodeId.startsWith('access:'))).toBe(false)
    expect(() => createBlueprintReconciliationChangeSet(current, { intent: 'reconcile-direct-edit', changes: [{
      target_node_id: 'capability:web-search', operation: 'setCapability',
      current_value: true, proposed_value: false,
      impact: '顺手关闭搜索。', dependency: '模型认为目标变化可能影响搜索。',
    }] }, 'purpose-capability', change, OWNER)).toThrow(/outside the deterministic impact candidate set/u)
  })

  it('does not expand local Behavior or Output edits without an explicit relation rule', () => {
    for (const [nodeId, previousValue] of [
      ['behavior:1', '旧规则。'],
      ['output:2', '旧输出。'],
    ] as const) {
      const type = nodeId.startsWith('behavior:') ? 'behavior' : 'output'
      const current = blueprint([
        node('purpose:persona', 'purpose', '整理资料。'),
        node(nodeId, type, type === 'behavior' ? '新规则。' : '新输出。'),
      ])
      expect(createBlueprintUserChange(current, { nodeId, previousValue }).impactCandidates).toEqual([])
    }
  })

  it('bounds an Identity change to same-persona Purpose, Behavior, and Output nodes', () => {
    const current = blueprint([
      node('identity:persona', 'identity', '美股科技公司研究分析师'),
      node('purpose:persona', 'purpose', '研究上市公司的基本面与估值。'),
      node('behavior:1', 'behavior', '比较上市公司的财务指标。'),
      node('output:2', 'output', '输出上市公司研究报告。'),
      node('capability:web-search', 'capability', { name: 'Web Search', tool: 'web_search', enabled: true }),
    ])
    const change = createBlueprintUserChange(current, {
      nodeId: 'identity:persona', previousValue: '上市公司研究分析师',
    })

    expect(change.impactCandidates.map(candidate => candidate.nodeId)).toEqual([
      'purpose:persona', 'behavior:1', 'output:2',
    ])
    expect(change.impactCandidates[0]?.nodeId).toBe('purpose:persona')
    expect(change.impactCandidates[0]?.evidence[0]).toEqual({ kind: 'identity-peer' })
    expect(change.impactCandidates[0]?.evidence.some(item => item.kind === 'removed-literal')).toBe(true)
    expect(change.impactCandidates.some(candidate => candidate.nodeId.startsWith('capability:'))).toBe(false)
  })
})
