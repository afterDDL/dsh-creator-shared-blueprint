/** User-facing work capabilities derived from the real Blueprint projection. */
import type { Blueprint, BlueprintNode } from '@deepseek-ai/dsh-shared-blueprint/contract'
import { capabilityValue } from './controller.ts'

/** One concise capability with Host-projected nodes retained as internal evidence. */
export interface SemanticCapability {
  /** Stable presentation identity. */
  id: string
  /** User-facing statement of repeatable work the Agent can perform. */
  label: string
  /** Real Blueprint nodes that support this statement. */
  supportingNodeIds: readonly string[]
  /** Real semantic node used when the summary becomes conversation selection context. */
  primaryNodeId: string
}

interface WorkDefinition {
  id: string
  label: string
  priority: number
  /** Every group must match; alternatives inside one group are equivalent. */
  signals: readonly (readonly RegExp[])[]
  toolSupport?: readonly string[]
}

const WORK_DEFINITIONS: readonly WorkDefinition[] = [
  { id: 'job-filtering', label: '职位筛选', priority: 100, signals: [[/岗位|职位/u], [/筛选|搜集|匹配|清单/u]], toolSupport: ['web_search', 'web_fetch'] },
  { id: 'application-tracking', label: '投递进度管理', priority: 99, signals: [[/投递|求职申请/u], [/进度|台账|状态|跟踪|管理/u]] },
  { id: 'recruitment-milestones', label: '申请节点跟踪', priority: 98, signals: [[/笔试|面试|offer|录用/iu], [/节点|时间线|跟踪|提醒|安排/u]] },
  { id: 'school-selection', label: '院校与项目筛选', priority: 100, signals: [[/院校|学校|大学|项目|选校/u], [/筛选|匹配|冲刺|保底|比较|选择/u]], toolSupport: ['web_search', 'web_fetch'] },
  { id: 'application-materials', label: '申请材料管理', priority: 99, signals: [[/申请材料|文书|推荐信|成绩单|APS|uni-assist/iu], [/整理|管理|准备|清单|核对|跟踪/u]], toolSupport: ['read'] },
  { id: 'application-timeline', label: '申请时间线跟踪', priority: 98, signals: [[/院校|留学|签证|入学|学期/u], [/时间线|时间表|节点|截止|跟踪|提醒/u]] },
  { id: 'financial-extraction', label: '财务指标提取', priority: 100, signals: [[/财报|财务|营收|利润|现金流|资产负债/u], [/提取|整理|指标|口径|计算/u]], toolSupport: ['read', 'web_fetch'] },
  { id: 'valuation-analysis', label: 'PE 与估值分析', priority: 99, signals: [[/PE|市盈率|估值|倍数/iu], [/分析|计算|比较|判断/u]] },
  { id: 'company-comparison', label: '公司横向比较', priority: 98, signals: [[/公司|企业|同业|同行/u], [/横向|对比|比较|基准/u]], toolSupport: ['web_search'] },
  { id: 'interview-themes', label: '访谈主题提炼', priority: 100, signals: [[/访谈|逐字稿|受访者/u], [/主题|提炼|观点|痛点|诉求/u]], toolSupport: ['read'] },
  { id: 'viewpoint-clustering', label: '观点聚类归纳', priority: 99, signals: [[/观点|反馈|痛点|诉求/u], [/聚类|归纳|共同|分组|主题/u]] },
  { id: 'interview-findings', label: '访谈结论整理', priority: 98, signals: [[/访谈|逐字稿|受访者/u], [/结论|摘要|洞察|建议|整理/u]] },
  { id: 'course-scan', label: '课程资料扫描', priority: 100, signals: [[/课程|课件|讲义|作业/u], [/扫描|读取|盘点|识别/u]], toolSupport: ['read'] },
  { id: 'material-classification', label: '资料分类归档', priority: 99, signals: [[/资料|文件|课件|讲义/u], [/分类|归档|整理|重命名/u]], toolSupport: ['read'] },
  { id: 'material-indexing', label: '资料目录整理', priority: 98, signals: [[/资料|文件|目录/u], [/索引|目录|清单|整理/u]], toolSupport: ['read'] },
  { id: 'competitor-selection', label: '竞品识别与筛选', priority: 100, signals: [[/竞品|竞争产品|替代品/u], [/识别|筛选|清单|范围/u]], toolSupport: ['web_search'] },
  { id: 'source-verification', label: '竞品信息核验', priority: 99, signals: [[/竞品|竞争对手/u], [/取证|核实|来源|一手|二手/u]], toolSupport: ['web_search', 'web_fetch'] },
  { id: 'competitive-comparison', label: '竞品对比分析', priority: 98, signals: [[/竞品|竞争对手/u], [/对比|差异|SWOT|矩阵|比较/iu]] },
  { id: 'supplier-due-diligence', label: '结构化供应商尽调', priority: 102, signals: [[/供应商|vendor/iu], [/尽调|due[ -]diligence/iu]] },
]

const ENGLISH_WORK_LABELS: Readonly<Record<string, string>> = {
  'job-filtering': 'Job filtering',
  'application-tracking': 'Application progress tracking',
  'recruitment-milestones': 'Recruitment milestone tracking',
  'school-selection': 'School and program selection',
  'application-materials': 'Application material management',
  'application-timeline': 'Application timeline tracking',
  'financial-extraction': 'Financial metric extraction',
  'valuation-analysis': 'PE and valuation analysis',
  'company-comparison': 'Company comparison',
  'interview-themes': 'Interview theme extraction',
  'viewpoint-clustering': 'Viewpoint clustering',
  'interview-findings': 'Interview finding synthesis',
  'course-scan': 'Course material scanning',
  'material-classification': 'Material classification',
  'material-indexing': 'Material indexing',
  'competitor-selection': 'Competitor identification',
  'source-verification': 'Competitor evidence verification',
  'competitive-comparison': 'Competitive comparison',
  'supplier-due-diligence': 'Structured supplier due diligence',
}

interface Candidate {
  definition: WorkDefinition
  semanticNodeIds: string[]
  supportingNodeIds: string[]
}

interface SkillCapabilityValue {
  kind: 'skill'
  name: string
  description: string
  callable: boolean
  scope: 'inherited' | 'preset'
}

interface DelegationCapabilityValue {
  kind: 'delegation'
  displayLabel?: string
  responsibility: string
  enabled: boolean
  providerAvailable: boolean
}

function skillCapabilityValue(node: BlueprintNode): SkillCapabilityValue | undefined {
  if (node.type !== 'capability' || node.status !== 'active' || typeof node.value !== 'object'
    || node.value === null) return undefined
  const value = node.value as Partial<SkillCapabilityValue>
  if (value.kind !== 'skill' || typeof value.name !== 'string' || typeof value.description !== 'string'
    || typeof value.callable !== 'boolean' || (value.scope !== 'inherited' && value.scope !== 'preset')) return undefined
  return value as SkillCapabilityValue
}

function delegationCapabilityValue(node: BlueprintNode): DelegationCapabilityValue | undefined {
  if (node.type !== 'capability' || node.status !== 'active' || typeof node.value !== 'object'
    || node.value === null) return undefined
  const value = node.value as Partial<DelegationCapabilityValue>
  if (value.kind !== 'delegation' || typeof value.responsibility !== 'string'
    || value.enabled !== true || value.providerAvailable !== true) return undefined
  return value as DelegationCapabilityValue
}

function delegationCapabilityLabel(delegation: DelegationCapabilityValue, chinese: boolean): string | undefined {
  const displayLabel = delegation.displayLabel?.trim()
  if (displayLabel !== undefined && displayLabel !== '') return displayLabel
  const firstClause = delegation.responsibility.trim().split(/[：:，,。；;\n]/u, 1)[0]?.trim()
  const collaborator = firstClause
    ?.replace(/^(?:你是|You are (?:an? )?)/iu, '')
    .replace(/[（(][^）)]*[）)]$/u, '')
    .replace(/^[「“"]|[」”"]$/gu, '')
    .trim()
  if (collaborator === undefined || !/(?:协作者|Collaborating Agent)$/iu.test(collaborator)) return undefined
  const subject = collaborator.replace(/(?:协作者|Collaborating Agent)$/iu, '').trim()
  if (subject === '') return undefined
  return chinese || /\p{Script=Han}/u.test(subject) ? `${subject}协作` : `${subject} collaboration`
}

function presetSkillLabel(skill: SkillCapabilityValue): string {
  const explicit = skill.description.match(/^([^：:。；]{3,24})[：:]/u)?.[1]?.trim()
  if (explicit !== undefined) return explicit
  const format = skill.description.match(/\b[A-Z][A-Z0-9-]{1,9}\b/u)?.[0]
  const extractedObject = skill.description.match(/提取[^。；]{0,36}?([\p{Script=Han}]{2,10}指标)/u)?.[1]
    ?.replace(/^[一二三四五六七八九十\d]+项/u, '')
  if (format !== undefined && extractedObject !== undefined) return `${format} ${extractedObject}提取`
  return skill.name.split('-').map(part => part.toUpperCase()).join(' ')
}

function semanticNodes(blueprint: Blueprint): BlueprintNode[] {
  return blueprint.nodes.filter(node => (node.type === 'purpose' || node.type === 'behavior' || node.type === 'output')
    && typeof node.value === 'string' && node.status === 'active')
}

function matchesDefinition(definition: WorkDefinition, text: string): boolean {
  return definition.signals.every(group => group.some(pattern => pattern.test(text)))
}

function runtimeSupportNodes(blueprint: Blueprint, tools: readonly string[]): BlueprintNode[] {
  if (tools.length === 0) return []
  return blueprint.nodes.filter((node) => {
    if (node.type !== 'capability' || node.status !== 'active') return false
    const tool = capabilityValue(node)
    if (tool?.enabled === true && tools.includes(tool.tool)) return true
    return false
  })
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function usesChinese(blueprint: Blueprint): boolean {
  const language = blueprint.sourceLanguage?.toLocaleLowerCase()
  return language === 'zh' || language?.startsWith('zh-') === true
}

function workLabel(definition: WorkDefinition, chinese: boolean): string {
  if (chinese) return definition.label
  return ENGLISH_WORK_LABELS[definition.id]
    ?? definition.id.split('-').map((part, index) => index === 0
      ? part.charAt(0).toLocaleUpperCase() + part.slice(1)
      : part).join(' ')
}

function fallbackHeading(node: BlueprintNode): string | undefined {
  if (node.type !== 'behavior' || typeof node.value !== 'string') return undefined
  const heading = node.value.split(/[：:。；;]/u, 1)[0]?.replace(/^(?:规则|要求|步骤)\s*\d*\s*/u, '').trim()
  if (heading === undefined || heading.length < 4 || heading.length > 16) return undefined
  if (!/筛选|提取|整理|管理|跟踪|分析|比较|核验|归纳|分类|规划|评估|识别|生成|记录|汇总/u.test(heading)) return undefined
  return heading
}

/**
 * Derive concrete, repeatable work from semantic nodes and retain runtime components only as evidence.
 * @param blueprint - current real semantic and runtime projection.
 * @returns up to six Agent-specific capabilities backed by projected node ids.
 */
export function deriveSemanticCapabilities(blueprint: Blueprint): SemanticCapability[] {
  const semantics = semanticNodes(blueprint)
  const chinese = usesChinese(blueprint)
  const candidates: Candidate[] = []
  for (const definition of WORK_DEFINITIONS) {
    const matchingNodes = semantics.filter(node => typeof node.value === 'string'
      && matchesDefinition(definition, node.value))
    if (matchingNodes.length === 0) continue
    const semanticNodeIds = matchingNodes.map(node => node.id)
    const support = runtimeSupportNodes(blueprint, definition.toolSupport ?? [])
    candidates.push({
      definition,
      semanticNodeIds: distinct(semanticNodeIds),
      supportingNodeIds: distinct([...semanticNodeIds, ...support.map(node => node.id)]),
    })
  }

  const representedSemanticNodes = new Set(candidates.flatMap(candidate => candidate.semanticNodeIds))
  for (const node of semantics) {
    const label = fallbackHeading(node)
    if (label === undefined || representedSemanticNodes.has(node.id)
      || candidates.some(candidate => candidate.definition.label === label)) continue
    candidates.push({
      definition: { id: `behavior-${node.id}`, label, priority: 40, signals: [] },
      semanticNodeIds: [node.id],
      supportingNodeIds: [node.id],
    })
  }

  for (const node of blueprint.nodes) {
    const skill = skillCapabilityValue(node)
    const runtimeSkill = skill === undefined
      ? undefined
      : blueprint.runtime.skills.find(candidate => candidate.name === skill.name)
    if (skill === undefined || runtimeSkill?.source !== 'custom' || !skill.callable
      || candidates.some(candidate => candidate.supportingNodeIds.includes(node.id))) continue
    candidates.push({
      definition: { id: `skill-${skill.name}`, label: presetSkillLabel(skill), priority: 110, signals: [] },
      semanticNodeIds: [node.id],
      supportingNodeIds: [node.id],
    })
  }


  for (const node of blueprint.nodes) {
    const delegation = delegationCapabilityValue(node)
    const label = delegation === undefined ? undefined : delegationCapabilityLabel(delegation, chinese)
    if (label === undefined || candidates.some(candidate => candidate.supportingNodeIds.includes(node.id))) continue
    candidates.push({
      definition: { id: `delegation-${node.id}`, label, priority: 108, signals: [] },
      semanticNodeIds: [node.id],
      supportingNodeIds: [node.id],
    })
  }

  const search = runtimeSupportNodes(blueprint, ['web_search'])
  const [searchNode] = search
  if (searchNode !== undefined) {
    const fetch = runtimeSupportNodes(blueprint, ['web_fetch'])
    candidates.push({
      definition: {
        id: 'public-information-search', label: chinese ? '搜索公开信息' : 'Search public information',
        priority: 65, signals: [],
      },
      semanticNodeIds: [searchNode.id],
      supportingNodeIds: distinct([...search, ...fetch].map(node => node.id)),
    })
  }

  const fileRead = runtimeSupportNodes(blueprint, ['read'])
  const [fileReadNode] = fileRead
  if (fileReadNode !== undefined) {
    const fileSemantics = semantics.filter(node => typeof node.value === 'string'
      && /文件|材料|资料|财报|CSV|file|document|material/iu.test(node.value))
    const analytical = fileSemantics.some(node => typeof node.value === 'string'
      && /分析|整理|整合|提取|比较|核验|归纳|尽调|analy[sz]|organize|integrat|extract|compare|verify|due[ -]diligence/iu
        .test(node.value))
    candidates.push({
      definition: {
        id: 'file-reading',
        label: chinese
          ? analytical ? '读取和分析文件' : '读取文件'
          : analytical ? 'Read and analyze files' : 'Read files',
        priority: 64, signals: [],
      },
      semanticNodeIds: [fileReadNode.id, ...fileSemantics.map(node => node.id)],
      supportingNodeIds: distinct([...fileRead.map(node => node.id), ...fileSemantics.map(node => node.id)]),
    })
  }

  return candidates
    .sort((left, right) => right.definition.priority - left.definition.priority
      || left.definition.id.localeCompare(right.definition.id))
    .slice(0, 6)
    .map((candidate) => {
      const [primaryNodeId] = candidate.semanticNodeIds
      if (primaryNodeId === undefined) {
        throw new Error(`ui-blueprint: semantic capability ${candidate.definition.id} has no primary node`)
      }
      return {
        id: candidate.definition.id,
        label: WORK_DEFINITIONS.includes(candidate.definition)
          ? workLabel(candidate.definition, chinese)
          : candidate.definition.label,
        supportingNodeIds: candidate.supportingNodeIds,
        primaryNodeId,
      }
    })
}

/**
 * Find the visible semantic statement backed by one selected real node.
 * @param blueprint - current Agent projection.
 * @param nodeId - selected real node identity.
 * @returns the first derived statement supported by the node, if one exists.
 */
export function semanticCapabilityForNode(
  blueprint: Blueprint,
  nodeId: string,
): SemanticCapability | undefined {
  return deriveSemanticCapabilities(blueprint)
    .find(capability => capability.supportingNodeIds.includes(nodeId))
}
