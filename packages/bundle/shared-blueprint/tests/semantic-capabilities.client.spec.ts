import { describe, expect, it } from 'vitest'
import type { Blueprint, BlueprintNode } from '@deepseek-ai/dsh-shared-blueprint/contract'
import { deriveSemanticCapabilities } from '../src/client/semantic-capabilities.ts'

function node(id: string, type: BlueprintNode['type'], value: BlueprintNode['value']): BlueprintNode {
  return { id, type, value, source: type === 'capability' ? 'runtime' : 'preset', status: 'active', editable: false, adapterRef: null }
}

function blueprint(id: string, purpose: string, behaviors: readonly string[], output: string): Blueprint {
  return {
    schemaVersion: 1,
    sourceLanguage: 'zh',
    preset: { id, trust: 'user' }, revision: 'r1',
    nodes: [
      node('purpose:persona', 'purpose', purpose),
      ...behaviors.map((value, index) => node(`behavior:persona:${String(index + 1)}`, 'behavior', value)),
      node('output:persona:1', 'output', output),
      node('capability:web-search', 'capability', { tool: 'web_search', enabled: true }),
      node('capability:web-fetch', 'capability', { tool: 'web_fetch', enabled: true }),
      node('capability:file-read', 'capability', { tool: 'read', enabled: true }),
      node('capability:skill:shared', 'capability', {
        kind: 'skill', name: 'research-review', description: '分析并复核研究资料。', callable: true,
        scope: 'inherited', invocation: { modelInvocable: true, userInvocable: true },
      }),
      node('capability:delegation:spawn', 'capability', {
        kind: 'delegation', name: 'Collaborator', tool: 'subagent', provider: 'spawn',
        mode: 'continuable', providerAvailable: true, enabled: true,
      }),
    ],
    runtime: { tools: [], promptSections: [], skills: [], delegations: [], permissions: null }, mappingGaps: [],
  }
}

const CASES = [
  blueprint('competitive-research', '开展系统性竞品调研。', ['建立竞品清单：识别直接竞品、间接竞品和替代品。', '多源取证：核实竞品的一手与二手来源。', '竞品对比：整理差异矩阵和 SWOT。'], '输出竞品对比表、SWOT 和来源。'),
  blueprint('qiuzhao-apply', '管理应届秋招求职全流程。', ['职位筛选：按地点和岗位方向建立职位清单。', '投递进度管理：维护每份投递的状态台账。', '申请节点跟踪：记录笔试、面试和 offer 时间。'], '输出职位表、投递台账和待办节点。'),
  blueprint('study-germany', '完成德国留学院校选择与申请管理。', ['院校筛选：比较学校与项目，形成冲刺和保底组合。', '申请材料管理：整理 APS、成绩单和推荐信清单。', '申请时间线跟踪：记录申请截止和入学节点。'], '输出院校比较、材料清单和申请时间线。'),
  blueprint('course-material-org', '整理课程资料。', ['课程资料扫描：读取课件、讲义和作业。', '资料分类归档：按课程和资料类型分类整理文件。', '资料目录整理：生成目录索引和文件清单。'], '输出资料目录、分类结果和缺失清单。'),
  blueprint('interview-summary', '整理用户访谈逐字稿。', ['访谈主题提炼：识别受访者的核心观点和痛点。', '观点聚类归纳：把共同诉求按主题分组。', '访谈结论整理：形成洞察摘要和后续建议。'], '输出主题、观点聚类和访谈结论。'),
  blueprint('pe-analysis', '分析上市公司的 PE 与估值。', ['财务指标提取：从财报整理营收、利润和现金流。', 'PE 与估值分析：计算市盈率和估值倍数。', '公司横向比较：与同业公司进行指标对比。'], '输出财务指标表、估值分析和公司横向比较。'),
] as const

describe('Blueprint capability semantic layer', () => {
  it('shows only a real provider-backed delegation with an explicit collaborator persona', () => {
    const candidate = blueprint('listed-company-research', '研究上市公司。', [], '输出研究结论。')
    candidate.nodes.push(node('capability:delegation:industry-research', 'capability', {
      kind: 'delegation', name: 'Industry Research', tool: 'industry_research', provider: 'spawn',
      mode: 'one-shot', providerAvailable: true, enabled: true,
      responsibility: '你是「行业研究协作者」（Industry Research Collaborator）。负责行业规模、竞争格局和行业趋势。',
    }))

    expect(deriveSemanticCapabilities(candidate)).toContainEqual(expect.objectContaining({
      label: '行业研究协作',
      supportingNodeIds: ['capability:delegation:industry-research'],
    }))
  })

  it('derives distinct repeatable work from six real Agent domains despite shared runtime catalogs', () => {
    const labels = CASES.map(candidate => deriveSemanticCapabilities(candidate).map(capability => capability.label))
    expect(labels).toEqual([
      ['竞品识别与筛选', '竞品信息核验', '竞品对比分析', '搜索公开信息', '读取文件'],
      ['职位筛选', '投递进度管理', '申请节点跟踪', '搜索公开信息', '读取文件'],
      ['院校与项目筛选', '申请材料管理', '申请时间线跟踪', '搜索公开信息', '读取和分析文件'],
      ['课程资料扫描', '资料分类归档', '资料目录整理', '搜索公开信息', '读取和分析文件'],
      ['访谈主题提炼', '观点聚类归纳', '访谈结论整理', '搜索公开信息', '读取文件'],
      ['财务指标提取', 'PE 与估值分析', '公司横向比较', '搜索公开信息', '读取和分析文件'],
    ])
    expect(new Set(labels.map(value => value.join('|'))).size).toBe(CASES.length)
  })

  it('covers real vendor research tools, work semantics, and delegation without inventing capabilities', () => {
    const candidate = blueprint(
      'vendor-due-diligence',
      '对供应商进行结构化尽调，整合公开信息和用户文件。',
      ['核实公司背景、产品与服务、公开经营信息、行业位置和主要风险。'],
      '输出供应商尽调摘要、事实对比表、风险结论及带日期来源的证据。',
    )
    candidate.nodes.push(node('capability:delegation:vendor-research', 'capability', {
      kind: 'delegation', name: 'Vendor Research', tool: 'vendor_research', provider: 'spawn',
      mode: 'one-shot', providerAvailable: true, enabled: true,
      responsibility: '供应商调研协作者：负责公开经营信息和行业位置核验。',
    }))

    const capabilities = deriveSemanticCapabilities(candidate)
    expect(capabilities.map(capability => capability.label)).toEqual([
      '供应商调研协作', '结构化供应商尽调', '搜索公开信息', '读取和分析文件',
    ])
    expect(capabilities.find(capability => capability.id === 'public-information-search')?.supportingNodeIds)
      .toEqual(['capability:web-search', 'capability:web-fetch'])
    expect(capabilities.find(capability => capability.id === 'file-reading')?.supportingNodeIds)
      .toContain('capability:file-read')
  })

  it('uses English capability labels for an English semantic source', () => {
    const candidate = blueprint(
      'vendor-due-diligence-en',
      'Perform structured vendor due diligence using public information and user files.',
      ['Verify the vendor company background, products, services, operating evidence, and risks.'],
      'Output a structured due-diligence report.',
    )
    candidate.sourceLanguage = 'en'

    expect(deriveSemanticCapabilities(candidate).map(capability => capability.label)).toEqual([
      'Structured supplier due diligence', 'Search public information', 'Read and analyze files',
    ])
  })

  it('keeps semantic source nodes and supporting runtime nodes as evidence without presenting the shared catalog', () => {
    const capabilities = deriveSemanticCapabilities(CASES[0])
    expect(capabilities[0]).toMatchObject({
      label: '竞品识别与筛选', primaryNodeId: 'behavior:persona:1',
      supportingNodeIds: ['behavior:persona:1', 'capability:web-search'],
    })
    expect(capabilities.flatMap(capability => capability.supportingNodeIds)).not.toContain('capability:skill:shared')
  })

  it('presents one real preset-local Skill as concrete work without exposing inherited Skills', () => {
    const source = CASES[0]
    const candidate: Blueprint = {
      ...source,
      nodes: [...source.nodes, node('capability:skill:csv-financial-metrics', 'capability', {
        kind: 'skill', name: 'csv-financial-metrics',
        description: '从用户提供的本地 CSV 文件中提取营收、净利润、PE、PB 四项财报指标并输出结构化摘要。',
        callable: true, scope: 'preset', invocation: { modelInvocable: true, userInvocable: true },
      })],
      runtime: { ...source.runtime, skills: [{
        name: 'csv-financial-metrics',
        description: '从用户提供的本地 CSV 文件中提取营收、净利润、PE、PB 四项财报指标并输出结构化摘要。',
        invocation: { modelInvocable: true, userInvocable: true }, scope: 'preset',
        provider: 'filesystem', source: 'custom', definitionDigest: 'digest-csv-financial-metrics',
      }] },
    }

    expect(deriveSemanticCapabilities(candidate)[0]).toEqual({
      id: 'skill-csv-financial-metrics', label: 'CSV 财报指标提取',
      primaryNodeId: 'capability:skill:csv-financial-metrics',
      supportingNodeIds: ['capability:skill:csv-financial-metrics'],
    })
  })
})
