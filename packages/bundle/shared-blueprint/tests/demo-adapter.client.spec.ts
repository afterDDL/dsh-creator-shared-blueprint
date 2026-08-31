import { describe, expect, it } from 'vitest'
import type { Blueprint, BlueprintApplyChangeSetResult } from '@deepseek-ai/dsh-shared-blueprint/contract'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import {
  InMemoryBlueprintDemoAdapter, type BlueprintDemoSeed,
} from '../src/client/demo-adapter.ts'

function blueprint(): Blueprint {
  return {
    schemaVersion: 1,
    preset: { id: 'demo-agent', trust: 'user', name: '演示 Agent' },
    revision: 'seed-r1',
    nodes: [
      { id: 'identity:persona', type: 'identity', value: '研究助手', source: 'preset', status: 'active', editable: true, adapterRef: 'identity' },
      { id: 'purpose:persona', type: 'purpose', value: '整理材料。', source: 'inferred', status: 'active', editable: true, adapterRef: 'purpose' },
      { id: 'behavior:1', type: 'behavior', value: '先核实事实。', source: 'preset', status: 'active', editable: true, adapterRef: 'behavior:1' },
      { id: 'output:2', type: 'output', value: '输出结构化摘要。', source: 'inferred', status: 'active', editable: true, adapterRef: 'output:2' },
      { id: 'capability:web-search', type: 'capability', value: { name: 'Web Search', tool: 'web_search', enabled: true }, source: 'runtime', status: 'active', editable: true, adapterRef: 'search' },
      { id: 'capability:web-fetch', type: 'capability', value: { name: 'Web Fetch', tool: 'web_fetch', enabled: false }, source: 'runtime', status: 'inactive', editable: true, adapterRef: 'fetch' },
      { id: 'capability:file-read', type: 'capability', value: { name: 'File Read', tool: 'read', enabled: true }, source: 'runtime', status: 'active', editable: false, adapterRef: null },
    ],
    runtime: {
      tools: ['web_search', 'read'], promptSections: ['deployment:persona'], skills: [], delegations: [],
      permissions: null,
    },
    mappingGaps: [],
  }
}

function seed(): BlueprintDemoSeed {
  return {
    agent: { id: 'demo-agent', label: '演示 Agent', trust: 'user' },
    blueprint: blueprint(),
  }
}

function value<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

function changedSeed(change: (value: Blueprint) => void): BlueprintDemoSeed {
  const next = seed()
  change(next.blueprint)
  return next
}

async function rejectedChange(
  adapter: InMemoryBlueprintDemoAdapter,
  operations: Parameters<InMemoryBlueprintDemoAdapter['applyChangeSet']>[0]['operations'],
): Promise<BlueprintApplyChangeSetResult> {
  return value(await adapter.applyChangeSet({
    sourceSessionId: 'demo-session', routeId: 'route:rejected',
    changeSetId: 'rejected', presetId: 'demo-agent', baseRevision: 'seed-r1', operations,
  }))
}

describe('in-memory Blueprint Demo adapter', () => {
  it('accepts caller-owned scenarios and returns detached roster and projection snapshots', async () => {
    const adapter = new InMemoryBlueprintDemoAdapter([seed()], { preferredPresetId: 'demo-agent' })

    const roster = await adapter.list()
    expect(roster).toEqual({
      agents: [{ id: 'demo-agent', label: '演示 Agent', trust: 'user' }],
      preferredPresetId: 'demo-agent',
    })
    ;(roster.agents[0] as { label: string }).label = '外部修改'
    const projected = value(await adapter.get({ presetId: 'demo-agent' }))
    projected.nodes[0]!.value = '外部修改'

    expect((await adapter.list()).agents[0]?.label).toBe('演示 Agent')
    expect(value(await adapter.get({ presetId: 'demo-agent' })).nodes[0]?.value).toBe('研究助手')
  })

  it('publishes a caller-owned scenario only when the scripted journey reaches it', async () => {
    const adapter = new InMemoryBlueprintDemoAdapter([])
    const scenario = seed()

    expect(await adapter.list()).toEqual({ agents: [] })
    adapter.installScenario(scenario)
    scenario.agent.label = '外部修改'
    scenario.blueprint.nodes[0]!.value = '外部修改'

    expect(await adapter.list()).toEqual({
      agents: [{ id: 'demo-agent', label: '演示 Agent', trust: 'user' }],
    })
    expect(value(await adapter.get({ presetId: 'demo-agent' })).nodes[0]?.value).toBe('研究助手')
    expect(() => { adapter.installScenario(seed()) }).toThrow('Duplicate Blueprint Demo preset')
  })

  it('replaces a published milestone projection without changing its reset seed', async () => {
    const adapter = new InMemoryBlueprintDemoAdapter([seed()])
    const milestone = changedSeed((next) => {
      next.revision = 'demo-r4'
      next.nodes[0]!.value = '上市公司研究分析师'
    })

    adapter.replaceScenario(milestone)
    milestone.blueprint.nodes[0]!.value = '外部修改'
    const projected = value(await adapter.get({ presetId: 'demo-agent' }))
    expect(projected.revision).toBe('demo-r4')
    expect(projected.nodes[0]?.value).toBe('上市公司研究分析师')

    adapter.reset('demo-agent')
    expect(value(await adapter.get({ presetId: 'demo-agent' }))).toEqual(blueprint())
    expect(() => { adapter.replaceScenario({ ...seed(), agent: { ...seed().agent, id: 'missing' } }) })
      .toThrow('Unknown Blueprint Demo preset')
  })

  it('preflights a complete Change Set before one atomic in-memory commit', async () => {
    const adapter = new InMemoryBlueprintDemoAdapter([seed()])
    const rejected = value(await adapter.applyChangeSet({
      sourceSessionId: 'demo-session', routeId: 'route:stale',
      changeSetId: 'stale', presetId: 'demo-agent', baseRevision: 'stale-r1',
      operations: [{
        operation: 'updatePurpose', targetNodeId: 'purpose:persona',
        expected: '整理材料。', value: '不会写入。',
      }],
    }))

    expect(rejected).toMatchObject({ status: 'preflight_failed', preflight: { ok: false } })
    expect(value(await adapter.get({ presetId: 'demo-agent' })).nodes[1]?.value).toBe('整理材料。')

    const committed = value(await adapter.applyChangeSet({
      sourceSessionId: 'demo-session', routeId: 'route:change-1',
      changeSetId: 'change-1', presetId: 'demo-agent', baseRevision: 'seed-r1',
      operations: [
        {
          operation: 'updatePurpose', targetNodeId: 'purpose:persona',
          expected: '整理材料。', value: '只整理指定材料。',
        },
        {
          operation: 'setCapability', targetNodeId: 'capability:web-search', capability: 'web-search',
          expected: true, enabled: false,
        },
      ],
    }))

    expect(committed).toMatchObject({
      status: 'committed', baseRevision: 'seed-r1', committedRevision: 'demo:demo-agent:1',
      preflight: { ok: true }, unexpectedDrift: [],
    })
    const projected = value(await adapter.get({ presetId: 'demo-agent' }))
    expect(projected.nodes[1]?.value).toBe('只整理指定材料。')
    expect(projected.runtime.tools).toEqual(['read'])
  })

  it('acknowledges UI-only conversation context without claiming a runtime Session', async () => {
    const adapter = new InMemoryBlueprintDemoAdapter([seed()])

    expect(value(await adapter.setConversationContext({
      sessionId: 'demo-session', presetId: 'demo-agent', revision: 'seed-r1', selectedNodeId: 'purpose:persona',
    }))).toEqual({
      sessionId: 'demo-session', active: true, presetId: 'demo-agent', selectedNodeId: 'purpose:persona',
    })
    expect(value(await adapter.setConversationContext({ sessionId: 'demo-session' })))
      .toEqual({ sessionId: 'demo-session', active: false })
    expect(value(await adapter.setConversationContext({
      sessionId: 'creator-session',
      creatorDraft: { name: 'Draft', status: 'creating' },
    }))).toMatchObject({ active: true })
    expect(value(await adapter.setConversationContext({
      sessionId: 'authoring-session',
      capabilityAuthoring: {
        routeId: 'capability-route', sourceSessionId: 'source-session',
        targetPresetId: 'demo-agent', request: '增加能力', baseRevision: 'seed-r1', kind: 'skill',
      },
    }))).toMatchObject({ active: true })
  })

  it('fails loud for inconsistent scenario setup and unknown projections', async () => {
    expect(() => new InMemoryBlueprintDemoAdapter([seed(), seed()])).toThrow('Duplicate Blueprint Demo preset')
    expect(() => new InMemoryBlueprintDemoAdapter([{
      ...seed(), agent: { ...seed().agent, id: 'other' },
    }])).toThrow('projects preset')
    expect(() => new InMemoryBlueprintDemoAdapter([{
      ...seed(), agent: { ...seed().agent, trust: 'system' },
    }])).toThrow('inconsistent trust')
    expect(() => new InMemoryBlueprintDemoAdapter([seed()], { preferredPresetId: 'missing' }))
      .toThrow('Unknown preferred')

    const adapter = new InMemoryBlueprintDemoAdapter([seed()])
    expect(await adapter.get({ presetId: 'missing' })).toMatchObject({ ok: false })
    expect(value(await adapter.get({ presetId: 'demo-agent' }))).toEqual(blueprint())
    expect(() => { adapter.reset('missing') }).toThrow('Unknown Blueprint Demo preset')
  })

  it('rejects a transaction for an unknown Demo target', async () => {
    const empty = new InMemoryBlueprintDemoAdapter([])
    expect(await empty.list()).toEqual({ agents: [] })
    expect(await empty.applyChangeSet({
      sourceSessionId: 'demo-session', routeId: 'route:missing',
      changeSetId: 'missing', presetId: 'missing', baseRevision: 'r1', operations: [],
    })).toMatchObject({ ok: false, error: { code: 'demo-preset-not-found' } })
  })

  it('reports each Change Set preflight failure and never publishes a partial result', async () => {
    const cases: Array<Parameters<typeof rejectedChange>[1]> = [
      [],
      [
        { operation: 'updatePurpose', targetNodeId: 'purpose:persona', expected: '整理材料。', value: 'A' },
        { operation: 'updatePurpose', targetNodeId: 'purpose:persona', expected: '整理材料。', value: 'B' },
      ],
      [{ operation: 'updatePurpose', targetNodeId: 'missing', expected: 'old', value: 'new' }],
      [{ operation: 'updatePurpose', targetNodeId: 'capability:file-read', expected: 'old', value: 'new' }],
      [{ operation: 'setCapability', targetNodeId: 'identity:persona', capability: 'web-search', expected: true, enabled: false }],
      [{ operation: 'setCapability', targetNodeId: 'capability:web-search', capability: 'web-fetch', expected: true, enabled: false }],
      [{ operation: 'setCapability', targetNodeId: 'capability:web-search', capability: 'web-search', expected: false, enabled: false }],
      [{ operation: 'updatePurpose', targetNodeId: 'identity:persona', expected: '研究助手', value: 'new' }],
      [{ operation: 'updatePurpose', targetNodeId: 'purpose:persona', expected: 'changed', value: 'new' }],
      [{ operation: 'updatePurpose', targetNodeId: 'purpose:persona', expected: '整理材料。', value: '' }],
      [{ operation: 'updatePurpose', targetNodeId: 'purpose:persona', expected: '整理材料。', value: 'a\nb' }],
      [{ operation: 'updatePurpose', targetNodeId: 'purpose:persona', expected: '整理材料。', value: 'a\rb' }],
    ]
    for (const operations of cases) {
      const adapter = new InMemoryBlueprintDemoAdapter([seed()])
      expect(await rejectedChange(adapter, operations)).toMatchObject({ status: 'preflight_failed' })
      expect(value(await adapter.get({ presetId: 'demo-agent' }))).toEqual(blueprint())
    }
  })

  it('stages every admitted text operation and one capability operation in a single revision', async () => {
    const adapter = new InMemoryBlueprintDemoAdapter([seed()])
    const committed = value(await adapter.applyChangeSet({
      sourceSessionId: 'demo-session', routeId: 'route:all-types',
      changeSetId: 'all-types', presetId: 'demo-agent', baseRevision: 'seed-r1',
      operations: [
        { operation: 'updateIdentity', targetNodeId: 'identity:persona', expected: '研究助手', value: '资料研究助手' },
        { operation: 'updatePurpose', targetNodeId: 'purpose:persona', expected: '整理材料。', value: '整理指定材料。' },
        { operation: 'updateBehavior', targetNodeId: 'behavior:1', expected: '先核实事实。', value: '标注证据来源。' },
        { operation: 'updateOutput', targetNodeId: 'output:2', expected: '输出结构化摘要。', value: '输出证据摘要。' },
        { operation: 'setCapability', targetNodeId: 'capability:web-fetch', capability: 'web-fetch', expected: false, enabled: true },
      ],
    }))

    expect(committed).toMatchObject({ status: 'committed', committedRevision: 'demo:demo-agent:1' })
    expect(value(await adapter.get({ presetId: 'demo-agent' })).runtime.tools)
      .toEqual(['web_search', 'read', 'web_fetch'])
  })
})
