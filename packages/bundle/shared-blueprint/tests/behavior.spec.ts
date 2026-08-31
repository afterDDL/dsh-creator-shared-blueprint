import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { projectBehaviors } from '../src/host/behavior.ts'
import { parseComposition, personaText, projectPersona } from '../src/host/composition.ts'
import { applyBlueprintOperation, isOutputItem } from '../src/host/writeback.ts'

const REAL = readFileSync('examples/web-blueprint-demo/tests/fixtures/preset/blueprint-adapter/rc1-folded-rules.cordis.yml', 'utf8')
const RULES = [
  '开始研究前，先与用户确认研究对象（公司名称/证券代码）和报告基准日期；信息不足时先提问，不擅自假定。',
  '读取用户提供的本地资料，并搜索公开信息交叉核验。',
  '所有数据必须标注来源与数据口径（报告期、币种、单位、指标计算方式），并区分事实与推断。',
  '缺失信息明确标注为「缺失」，绝不编造数据或来源。',
  '不提供任何买卖建议。',
]

function project(composition: string, writable = true) {
  const text = personaText(parseComposition(composition))
  return projectBehaviors(text, projectPersona(text).items, composition, writable)
}

function literal(text: string): string {
  return `- id: persona\n  config:\n    text: |-\n${text.split('\n').map(line => `      ${line}`).join('\n')}\n`
}

describe('Behavior semantic source discovery', () => {
  it('A: retains all five real RC rules after the Loader folds the heading and list into one paragraph', () => {
    const text = personaText(parseComposition(REAL))!
    const persona = projectPersona(text)
    expect(persona.items).toEqual([])
    const behavior = project(REAL)
    expect(behavior.nodes.map(node => node.value)).toEqual(RULES)
    expect(behavior.semantics).toHaveLength(5)
    for (const rule of behavior.semantics) {
      expect(text).toContain(rule.sourceValue)
      expect(rule.sourceValue).toContain(rule.semanticValue)
      expect(rule).toMatchObject({
        displayValue: rule.semanticValue, projectionKind: 'explicit-behavior',
        source: 'preset', editable: false, writebackMethod: null,
      })
    }
    expect(behavior.gaps).toHaveLength(1)
    expect(behavior.gaps[0]?.field).toBe('behavior')
    expect(behavior.gaps[0]?.reason).toMatch(/read-only/u)
  })

  it('B: preserves the real standard Creator behavior-constraint heading and all five folded rules', () => {
    const composition = readFileSync('examples/web-blueprint-demo/tests/fixtures/preset/blueprint-adapter/creator-folded-constraints.cordis.yml', 'utf8')
    expect(project(composition).nodes.map(node => node.value)).toEqual([
      '开始研究前先确认研究对象和基准日期。',
      '本地资料与公开信息交叉核验。',
      '所有数据标注来源及报告期、币种、单位、计算口径，并区分事实与推断。',
      '缺失信息明确标缺失，绝不编造数据或来源。',
      '不提供买卖建议。',
    ])
  })

  it('retains real Creator working-method rules without absorbing the trailing legacy identity', () => {
    const composition = readFileSync('examples/web-blueprint-demo/tests/fixtures/preset/blueprint-adapter/creator-working-method.cordis.yml', 'utf8')
    const text = personaText(parseComposition(composition))!
    expect(projectPersona(text).items).toEqual([])
    const behavior = project(composition)
    expect(behavior.nodes.map(node => node.value)).toEqual([
      '开始研究前，先确认研究对象与资料日期；日期不明时先询问用户或如实标注缺失。',
      '严格区分事实、推断与缺失数据：本地资料与公开来源中的明确数字记为事实；基于事实的合理判断记为推断并明确标注；无法获取的信息如实标注缺失，绝不编造增长率或其他数据。',
      '只呈现研究事实、指标对比与相关背景，不提供任何买入、卖出、持有等投资建议。',
    ])
    for (const rule of behavior.semantics) {
      expect(text).toContain(rule.sourceValue)
      expect(rule.sourceValue).not.toContain('Your working directory')
      expect(rule).toMatchObject({ editable: false, writebackMethod: null })
    }
    expect(() => applyBlueprintOperation(composition, {
      operation: 'updateBehavior', targetNodeId: behavior.nodes[0]!.id,
      expected: behavior.semantics[0]!.semanticValue, value: '替代规则。',
    })).toThrow(/invalid target/u)
  })

  it.each(['You are a research analyst.', '你是一名研究分析师。'])(
    'keeps a trailing legacy identity outside an explicit rule section: %s', (identity) => {
      expect(project(literal(`Role: analyst\nRules:\n1. Verify sources.\n${identity}`)).nodes.map(node => node.value))
        .toEqual(['Verify sources.'])
    },
  )

  it.each(['行为规则：', '行为约束：', '规则:', '约束：', '## 行为规则', 'Behavior:', 'Rules:', 'Constraints:', '## Behavioral rules'])(
    'C/D: recognizes the explicit heading %s without classifying other numbered prose', (heading) => {
      const behavior = project(literal(`Role: analyst\nPurpose: Verify facts.\n${heading}\n1. Verify sources.\n2. Never invent evidence.\nOutput: Report.`))
      expect(behavior.nodes.map(node => node.value)).toEqual(['Verify sources.', 'Never invent evidence.'])
      expect(behavior.nodes.every(node => node.editable)).toBe(true)
    },
  )

  it.each(['-', '*', '+'])('D/G: displays explicit %s bullets read-only without inventing ordinal writes', (marker) => {
    const behavior = project(literal(`角色：分析师\n目标：核验事实。\n规则：\n${marker} 核实来源。\n${marker} 不编造。\n输出：摘要。`))
    expect(behavior.nodes.map(node => node.value)).toEqual(['核实来源。', '不编造。'])
    expect(behavior.nodes.every(node => !node.editable && node.adapterRef === null)).toBe(true)
  })

  it('D: reads folded English rules and folded bullets under an explicit heading', () => {
    expect(project(literal('Role: analyst\nPurpose: Verify.\nRules: 1. Verify sources. 2. Never invent facts.\nOutput: Report.')).nodes.map(node => node.value))
      .toEqual(['Verify sources.', 'Never invent facts.'])
    expect(project(literal('Role: analyst\nPurpose: Verify.\nBehavior: - Verify sources. - Never invent facts.\nOutput: Report.')).nodes.map(node => node.value))
      .toEqual(['Verify sources.', 'Never invent facts.'])
  })

  it('E/H: keeps Behavior, standalone Output, numbered Output, and Purpose separate', () => {
    const composition = literal('角色：分析师\n目标：核验事实。\n规则：\n1. 核实来源。\n2. Output: dated report.\n输出：摘要。')
    const before = projectPersona(personaText(parseComposition(composition)))
    expect(project(composition).nodes.map(node => node.value)).toEqual(['核实来源。'])
    expect(before.items.filter(item => isOutputItem(item.text)).map(item => item.text)).toEqual(['Output: dated report.'])
    expect(before.output?.semanticValue).toBe('摘要。')
    expect(before.purpose?.semanticValue).toBe('核验事实。')
    expect(before.identity?.semanticValue).toBe('分析师')
    expect(projectPersona(personaText(parseComposition(composition)))).toEqual(before)
  })

  it.each(['## Output', 'Output:', '输出：'])('E/F: does not treat a numbered report structure beneath %s as rules', (heading) => {
    const composition = literal(`Role: analyst\nPurpose: Verify facts.\n${heading}\n1. Summary\n2. Sources`)
    expect(project(composition).nodes).toEqual([])
  })

  it('F: does not fabricate Behavior from an absent scalar, metadata, plain tasks or numbered Output', () => {
    expect(projectBehaviors(undefined, [], '', true)).toEqual({ semantics: [], nodes: [], gaps: [] })
    expect(project(literal('Role: analyst\nPurpose: Verify facts.\nOutput: Report.')).nodes).toEqual([])
    expect(project(literal('Role: analyst\nPurpose: Verify facts.\n1. Output: Report.')).nodes).toEqual([])
    expect(project(literal('Role: analyst\nPurpose: Verify facts.\nExample: 1. A 2. B')).nodes).toEqual([])
  })

  it('G: retains an explicit prose constraint without a numbered write address', () => {
    const behavior = project(literal('Role: analyst\nPurpose: Verify facts.\nBehavior: Never invent facts.\nOutput: Report.'))
    expect(behavior.semantics[0]).toMatchObject({
      sourceValue: 'Behavior: Never invent facts.', semanticValue: 'Never invent facts.',
      displayValue: 'Never invent facts.', projectionKind: 'explicit-behavior', editable: false, writebackMethod: null,
    })
    expect(behavior.nodes[0]).toMatchObject({ editable: false, adapterRef: null })
  })

  it('keeps blank lines and indentation in read-only source evidence', () => {
    const text = '\nRole: analyst\nPurpose: Verify.\n## Rules\n\n  - Verify sources.\n\n  - Never invent facts.\n\nOutput: Report.'
    const behavior = projectBehaviors(text, projectPersona(text).items, '', false)
    expect(behavior.nodes.map(node => node.value)).toEqual(['Verify sources.', 'Never invent facts.'])
    for (const rule of behavior.semantics) expect(text).toContain(rule.sourceValue)
    expect(behavior.semantics[0]?.sourceValue).toContain('\n\n  - Verify sources.')
  })

  it('G: retains repeated numbering as a complete read-only section with a diagnostic', () => {
    const behavior = project(literal('Role: analyst\nPurpose: Verify.\nRules:\n1. Verify.\n1. Do not guess.'))
    expect(behavior.nodes.map(node => node.value)).toEqual(['1. Verify.\n1. Do not guess.'])
    expect(behavior.nodes[0]).toMatchObject({ editable: false, adapterRef: null })
    expect(behavior.gaps.some(gap => /ambiguous/u.test(gap.reason))).toBe(true)
  })

  it('reports an explicit heading with no supported content instead of silently omitting it', () => {
    const behavior = project(literal('Role: analyst\nPurpose: Verify.\nRules:\nOutput: Report.'))
    expect(behavior.nodes).toEqual([])
    expect(behavior.gaps[0]?.field).toBe('behavior')
    expect(behavior.gaps[0]?.reason).toMatch(/no rule content/u)
  })

  it('keeps a rule with an ordinal shared by Output visible without granting a write address', () => {
    const behavior = project(literal('Role: analyst\nPurpose: Verify.\nRules:\n1. Verify sources.\nOutput:\n1. Output: Summary.'))
    expect(behavior.nodes).toMatchObject([{ value: 'Verify sources.', editable: false, adapterRef: null }])
  })

  it('F: projects no Behavior for the real standard preset persona', () => {
    const standard = readFileSync('apps/cli/config/agent-presets/standard/agent.cordis.yml', 'utf8')
    expect(project(standard, false).nodes).toEqual([])
  })

  it('retains existing numbered workflow addresses and rejects writes to newly recovered read-only rules', () => {
    const composition = literal('角色：分析师\n目标：核验。\n## 工作流程\n1. 核实来源。\n2. 不编造。')
    const behavior = project(composition)
    expect(behavior.nodes.map(node => node.id)).toEqual(['behavior:1', 'behavior:2'])
    expect(behavior.semantics[0]).toMatchObject({ editable: true, writebackMethod: 'replace-numbered-line', prefix: '1. ', suffix: '' })
    const changed = applyBlueprintOperation(composition, {
      operation: 'updateBehavior', targetNodeId: 'behavior:1', expected: '核实来源。', value: '核实一手来源。',
    })
    expect(project(changed).nodes[0]?.value).toBe('核实一手来源。')
    expect(project(composition, false).nodes.every(node => !node.editable)).toBe(true)
    expect(() => applyBlueprintOperation(REAL, {
      operation: 'updateBehavior', targetNodeId: project(REAL).nodes[0]!.id, expected: RULES[0]!, value: '替代规则。',
    })).toThrow(/invalid target/u)
  })
})
