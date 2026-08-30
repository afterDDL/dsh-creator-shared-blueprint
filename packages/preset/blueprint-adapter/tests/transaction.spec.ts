import { describe, expect, it, vi } from 'vitest'
import { compositionRevision, configuredBoolean, parseComposition, personaText, projectPersona } from '../src/composition.ts'
import {
  executeBlueprintTransaction,
  stageBlueprintChangeSet,
} from '../src/transaction.ts'
import { isOutputItem } from '../src/writeback.ts'
import type {
  Blueprint,
  BlueprintApplyChangeSetRequest,
  BlueprintChangeSetOperation,
} from '../src/types.ts'

const BASE_COMPOSITION = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      你是一名考研择校助手，由 {{model}} 驱动，工作目录是 {{cwd}}。

      你的职责是帮用户完成国内保研的择校全流程管理工作方式：

      1. 统考规则 1

      2. 统考规则 2

      3. 统考规则 3

      4. 统考规则 4

      5. 统考规则 5

      6. 统考规则 6

      7. 交付形式：输出择校摘要与来源。
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    search: true
    fetch: true
`

function projection(composition: string): Blueprint {
  const rows = parseComposition(composition)
  const persona = projectPersona(personaText(rows))
  const nodes: Blueprint['nodes'] = []
  if (persona.identity !== undefined) {
    nodes.push({
      id: 'identity:persona', type: 'identity', value: persona.identity.displayValue,
      source: 'preset', status: 'active', editable: true, adapterRef: 'preset:persona.config.text#identity',
    })
  }
  if (persona.purpose !== undefined) {
    nodes.push({
      id: 'purpose:persona', type: 'purpose', value: persona.purpose.displayValue,
      source: persona.purpose.source, status: 'active', editable: true,
      adapterRef: 'preset:persona.config.text#purpose',
    })
  }
  for (const item of persona.items) {
    const output = isOutputItem(item.text)
    nodes.push({
      id: `${output ? 'output' : 'behavior'}:${String(item.ordinal)}`,
      type: output ? 'output' : 'behavior', value: item.text,
      source: output ? 'inferred' : 'preset', status: 'active', editable: true,
      adapterRef: `preset:persona.config.text#${output ? 'output' : 'behavior'}:${String(item.ordinal)}`,
    })
  }
  const search = configuredBoolean(rows, 'tool-web', 'search', true)
  const fetch = configuredBoolean(rows, 'tool-web', 'fetch', true)
  if (search !== undefined) {
    nodes.push({
      id: 'capability:web-search', type: 'capability',
      value: { name: 'Web Search', tool: 'web_search', enabled: search },
      source: search ? 'runtime' : 'preset', status: search ? 'active' : 'inactive',
      editable: true, adapterRef: 'preset:tool-web.config.search',
    })
  }
  if (fetch !== undefined) {
    nodes.push({
      id: 'capability:web-fetch', type: 'capability',
      value: { name: 'Web Fetch', tool: 'web_fetch', enabled: fetch },
      source: fetch ? 'runtime' : 'preset', status: fetch ? 'active' : 'inactive',
      editable: true, adapterRef: 'preset:tool-web.config.fetch',
    })
  }
  nodes.push({
    id: 'capability:file-read', type: 'capability',
    value: { name: 'File Read', tool: 'read', enabled: true },
    source: 'runtime', status: 'active', editable: false, adapterRef: null,
  })
  return {
    schemaVersion: 1,
    preset: { id: 'kaoyan-choose', trust: 'user', name: '考研择校' },
    revision: compositionRevision(composition),
    nodes,
    runtime: {
      tools: [
        ...(search === true ? ['web_search'] : []),
        ...(fetch === true ? ['web_fetch'] : []),
        'read',
      ],
      promptSections: ['deployment:persona'],
      skills: [],
      delegations: [],
      permissions: null,
    },
    mappingGaps: [],
  }
}

function sevenOperations(): BlueprintChangeSetOperation[] {
  return [
    {
      operation: 'updateIdentity', targetNodeId: 'identity:persona',
      expected: '考研择校助手', value: '保研申请顾问',
    },
    ...Array.from({ length: 6 }, (_, index): BlueprintChangeSetOperation => ({
      operation: 'updateBehavior', targetNodeId: `behavior:${String(index + 1)}`,
      expected: `统考规则 ${String(index + 1)}`, value: `推免规则 ${String(index + 1)}`,
    })),
  ]
}

function request(operations = sevenOperations(), composition = BASE_COMPOSITION): BlueprintApplyChangeSetRequest {
  return {
    sourceSessionId: 'source-session',
    routeId: 'route-1',
    changeSetId: 'kaoyan-1-plus-6',
    presetId: 'kaoyan-choose',
    baseRevision: compositionRevision(composition),
    operations,
  }
}

function bench(input: {
  composition?: string
  operations?: BlueprintChangeSetOperation[]
  beforeBlueprint?: Blueprint
  stage?: () => string
  reproject?: (disk: string) => Blueprint | Promise<Blueprint>
} = {}) {
  const before = input.composition ?? BASE_COMPOSITION
  const transaction = request(input.operations ?? sevenOperations(), before)
  let disk = before
  const commits: string[] = []
  const commit = vi.fn(async (composition: string) => {
    commits.push(composition)
    disk = composition
  })
  const run = async () => await executeBlueprintTransaction(
    transaction,
    input.beforeBlueprint ?? projection(before),
    before,
    {
      stage: input.stage ?? (() => stageBlueprintChangeSet(before, transaction.operations)),
      commit,
      reproject: async () => await (input.reproject?.(disk) ?? projection(disk)),
      readCurrentComposition: async () => disk,
    },
  )
  return { run, transaction, commit, commits, disk: () => disk, setDisk: (value: string) => { disk = value } }
}

describe('Blueprint transactional Apply', () => {
  it('commits Identity plus six Behaviors with one preset write and no non-target drift', async () => {
    const fixture = bench()
    const result = await fixture.run()

    expect(result).toMatchObject({ status: 'committed', preflight: { ok: true }, unexpectedDrift: [] })
    expect(fixture.commit).toHaveBeenCalledTimes(1)
    const persona = projectPersona(personaText(parseComposition(fixture.disk())))
    expect(persona).toMatchObject({
      identity: { semanticValue: '保研申请顾问', displayValue: '保研申请顾问' },
      purpose: { semanticValue: '帮用户完成国内保研的择校全流程管理' },
    })
    expect(persona.items.slice(0, 6)).toMatchObject(Array.from({ length: 6 }, (_, index) => ({
      ordinal: index + 1, text: `推免规则 ${String(index + 1)}`,
    })))
    expect(persona.items[6]).toMatchObject({ ordinal: 7, text: '交付形式：输出择校摘要与来源。' })
    expect(configuredBoolean(parseComposition(fixture.disk()), 'tool-web', 'search', true)).toBe(true)
    expect(configuredBoolean(parseComposition(fixture.disk()), 'tool-web', 'fetch', true)).toBe(true)
  })

  it('commits a Chinese parenthetical Identity qualifier without changing its projected value', async () => {
    const explicit = BASE_COMPOSITION.replace(
      '你是一名考研择校助手，由 {{model}} 驱动，工作目录是 {{cwd}}。',
      '角色：上市公司公开披露与行业信息研究分析师',
    )
    const operations: BlueprintChangeSetOperation[] = [{
      operation: 'updateIdentity', targetNodeId: 'identity:persona',
      expected: '上市公司公开披露与行业信息研究分析师',
      value: '上市公司公开披露与行业信息研究分析师（注册会计师）',
    }]
    const fixture = bench({ composition: explicit, operations })

    expect(await fixture.run()).toMatchObject({ status: 'committed', unexpectedDrift: [] })
    expect(fixture.commit).toHaveBeenCalledTimes(1)
    expect(projectPersona(personaText(parseComposition(fixture.disk()))).identity).toMatchObject({
      semanticValue: '上市公司公开披露与行业信息研究分析师（注册会计师）',
      displayValue: '上市公司公开披露与行业信息研究分析师（注册会计师）',
    })
  })

  it('writes only the explicit Purpose span and preserves Identity and runtime template text', async () => {
    const explicit = BASE_COMPOSITION.replace(
      '你的职责是帮用户完成国内保研的择校全流程管理工作方式：',
      '目标：帮助用户完成国内保研的择校全流程管理。',
    )
    const operations: BlueprintChangeSetOperation[] = [{
      operation: 'updatePurpose', targetNodeId: 'purpose:persona',
      expected: '帮助用户完成国内保研的择校全流程管理。',
      value: '帮助用户完成推免院校筛选与申请管理。',
    }]
    const fixture = bench({ composition: explicit, operations })

    expect(await fixture.run()).toMatchObject({ status: 'committed', unexpectedDrift: [] })
    expect(fixture.commit).toHaveBeenCalledTimes(1)
    expect(fixture.disk()).toContain('目标：帮助用户完成推免院校筛选与申请管理。')
    expect(fixture.disk()).toContain('你是一名考研择校助手，由 {{model}} 驱动，工作目录是 {{cwd}}。')
  })

  it('rejects a stale fourth expected value before all writes', async () => {
    const operations = sevenOperations()
    operations[3] = { ...operations[3]!, expected: '外部改过的规则' } as BlueprintChangeSetOperation
    const fixture = bench({ operations })

    expect(await fixture.run()).toMatchObject({ status: 'preflight_failed' })
    expect(fixture.commit).not.toHaveBeenCalled()
    expect(fixture.disk()).toBe(BASE_COMPOSITION)
  })

  it('rejects a non-unique fourth write anchor before all writes', async () => {
    const duplicated = BASE_COMPOSITION.replace('      5. 统考规则 5', '      4. 统考规则 4\n\n      5. 统考规则 5')
    const fixture = bench({ composition: duplicated })

    expect(await fixture.run()).toMatchObject({ status: 'preflight_failed' })
    expect(fixture.commit).not.toHaveBeenCalled()
    expect(fixture.disk()).toBe(duplicated)
  })

  it('rejects duplicate target nodes before all writes', async () => {
    const operations = sevenOperations()
    operations.push({ ...operations[1]! })
    const fixture = bench({ operations })

    expect(await fixture.run()).toMatchObject({ status: 'preflight_failed' })
    expect(fixture.commit).not.toHaveBeenCalled()
  })

  it('rejects a read-only node before all writes', async () => {
    const operations: BlueprintChangeSetOperation[] = [{
      operation: 'updateBehavior', targetNodeId: 'capability:file-read',
      expected: 'read', value: 'disabled',
    }]
    const fixture = bench({ operations })

    expect(await fixture.run()).toMatchObject({ status: 'preflight_failed' })
    expect(fixture.commit).not.toHaveBeenCalled()
  })

  it('rejects a Behavior that names an unmounted collaborator with zero writes', async () => {
    const operations: BlueprintChangeSetOperation[] = [{
      operation: 'updateBehavior', targetNodeId: 'behavior:1',
      expected: '统考规则 1', value: '把行业研究委托给行业研究协作者。',
    }]
    const fixture = bench({ operations })

    const outcome = await fixture.run()
    expect(outcome.status).toBe('preflight_failed')
    expect(outcome.preflight.ok).toBe(false)
    if (outcome.preflight.ok) throw new Error('Expected delegation preflight failure')
    expect(outcome.preflight.reason).toContain('not mounted')
    expect(fixture.commit).not.toHaveBeenCalled()
    expect(fixture.disk()).toBe(BASE_COMPOSITION)
  })

  it('admits the exact label of a mounted provider-backed collaborator', async () => {
    const operations: BlueprintChangeSetOperation[] = [{
      operation: 'updateBehavior', targetNodeId: 'behavior:1',
      expected: '统考规则 1', value: '把行业研究委托给行业研究协作者。',
    }]
    const withDelegation = (composition: string): Blueprint => {
      const result = projection(composition)
      result.nodes.push({
        id: 'capability:delegation:industry-research', type: 'capability', source: 'preset',
        status: 'active', editable: false, adapterRef: null,
        value: {
          kind: 'delegation', name: 'Industry Research', enabled: true, providerAvailable: true,
          responsibility: '你是「行业研究协作者」（Industry Research Collaborator）。负责行业规模与竞争格局。',
        },
      })
      return result
    }
    const fixture = bench({
      operations,
      beforeBlueprint: withDelegation(BASE_COMPOSITION),
      reproject: withDelegation,
    })

    expect(await fixture.run()).toMatchObject({ status: 'committed' })
    expect(fixture.commit).toHaveBeenCalledTimes(1)
  })

  it('returns staging failure with zero writes when staged YAML cannot be reparsed', async () => {
    const fixture = bench({ stage: () => '- id: persona\n  config: [invalid' })

    expect(await fixture.run()).toMatchObject({ status: 'staging_failed', preflight: { ok: true } })
    expect(fixture.commit).not.toHaveBeenCalled()
    expect(fixture.disk()).toBe(BASE_COMPOSITION)
  })

  it('restores the before composition when post-write reprojection fails without a concurrent edit', async () => {
    const fixture = bench({ reproject: () => { throw new Error('projection failed') } })

    expect(await fixture.run()).toMatchObject({ status: 'reprojection_failed_recovered' })
    expect(fixture.commit).toHaveBeenCalledTimes(2)
    expect(fixture.disk()).toBe(BASE_COMPOSITION)
  })

  it('does not restore over an external revision that appears before recovery', async () => {
    const external = `${BASE_COMPOSITION}\n# external edit\n`
    const fixture = bench({
      reproject: () => {
        fixture.setDisk(external)
        throw new Error('projection failed after concurrent edit')
      },
    })

    expect(await fixture.run()).toMatchObject({ status: 'reprojection_failed_conflict' })
    expect(fixture.commit).toHaveBeenCalledTimes(1)
    expect(fixture.disk()).toBe(external)
  })

  it('detects non-target semantic drift and recovers instead of committing it', async () => {
    const fixture = bench({
      reproject: (disk) => {
        const projected = projection(disk)
        return {
          ...projected,
          nodes: projected.nodes.map(node => node.id === 'purpose:persona'
            ? { ...node, value: '意外变化的 Purpose' }
            : node),
        }
      },
    })

    expect(await fixture.run()).toMatchObject({
      status: 'reprojection_failed_recovered',
      unexpectedDrift: ['purpose:persona'],
    })
    expect(fixture.commit).toHaveBeenCalledTimes(2)
    expect(fixture.disk()).toBe(BASE_COMPOSITION)
  })
})
