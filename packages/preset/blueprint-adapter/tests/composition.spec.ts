import { describe, expect, it } from 'vitest'
import {
  assertCapabilityCompositionDelta,
  blueprintSourceLanguage,
  compositionRevision,
  configuredBoolean,
  configuredWebFetch,
  hasUniqueTrimmedLine,
  parseComposition,
  personaText,
  projectDelegations,
  projectPersona,
  replaceUniqueTrimmedLine,
  replaceBooleanConfig,
  replaceWebFetch,
  rowById,
} from '../src/composition.ts'

const COMPOSITION = `# retained comment
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      你是一名分析师。

      你的职责是核实竞品事实。工作方式：

      1. 先界定范围。

      2. 输出 Markdown 报告。

- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    search: true
    fetch: true

- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
`

describe('Blueprint composition projection', () => {
  it('uses the Loader dialect and recovers explicit persona structure', () => {
    const rows = parseComposition(COMPOSITION)
    const persona = projectPersona(personaText(rows))

    expect(rowById(rows, 'persona')).toBeDefined()
    expect(persona).toEqual({
      identity: {
        sourceValue: '你是一名分析师。', semanticValue: '分析师', displayValue: '分析师',
        source: 'preset', projectionKind: 'legacy-role-clause', editable: false, writebackMethod: null,
      },
      purpose: {
        sourceValue: '你的职责是核实竞品事实。工作方式：', semanticValue: '核实竞品事实。',
        displayValue: '核实竞品事实。', source: 'inferred', projectionKind: 'purpose-clause',
        editable: true, writebackMethod: 'replace-purpose-span', prefix: '你的职责是', suffix: '工作方式：',
      },
      items: [
        { ordinal: 1, text: '先界定范围。', paragraph: '1. 先界定范围。' },
        { ordinal: 2, text: '输出 Markdown 报告。', paragraph: '2. 输出 Markdown 报告。' },
      ],
    })
    expect(configuredWebFetch(rows)).toBe(true)
    expect(compositionRevision(COMPOSITION)).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('recovers only the role slot from a supported real user-preset identity sentence', () => {
    const persona = projectPersona('你是一名考研择校助手，由 {{model}} 驱动，工作目录是 {{cwd}}。\n\n帮助用户完成国内保研申请。')

    expect(persona).toMatchObject({
      identity: {
        sourceValue: '你是一名考研择校助手，由 {{model}} 驱动，工作目录是 {{cwd}}。',
        semanticValue: '考研择校助手', displayValue: '考研择校助手', source: 'preset',
        projectionKind: 'persona-role-slot', editable: true, writebackMethod: 'replace-role-span',
        prefix: '你是一名', suffix: '，由 {{model}} 驱动，工作目录是 {{cwd}}。',
      },
    })
  })

  it('uses an explicit role line as a stable language-preserving Identity anchor', () => {
    const chinese = projectPersona('角色：上市公司研究分析师\n\n研究公司基本面。').identity
    expect(chinese).toEqual({
      sourceValue: '角色：上市公司研究分析师', semanticValue: '上市公司研究分析师', displayValue: '上市公司研究分析师',
      source: 'preset', projectionKind: 'explicit-role', editable: true, writebackMethod: 'replace-role-span',
      prefix: '角色：', suffix: '',
    })
    expect(projectPersona('Role: listed-company research analyst\n\nResearch company fundamentals.').identity)
      .toMatchObject({ semanticValue: 'listed-company research analyst', projectionKind: 'explicit-role' })
    expect(blueprintSourceLanguage(chinese, 'Listed Company Agent')).toBe('zh')
    expect(blueprintSourceLanguage(
      projectPersona('Role: market research analyst\n\nCompare public companies.').identity,
      'Market Research Agent',
    )).toBeUndefined()
    expect(blueprintSourceLanguage(
      projectPersona('You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.').identity,
      '标准模式',
      '基础预设',
    )).toBeUndefined()
    expect(blueprintSourceLanguage(
      projectPersona('Role: 上場AI企業リサーチアナリスト\n\n公開情報を調査します。').identity,
    )).toBe('ja')
    expect(blueprintSourceLanguage(
      projectPersona('Role: 상장 AI 기업 리서치 애널리스트\n\n공개 정보를 조사합니다.').identity,
    )).toBe('ko')
  })

  it('keeps a Chinese parenthetical role qualifier as part of Identity', () => {
    expect(projectPersona('角色：上市公司公开披露与行业信息研究分析师（注册会计师）').identity)
      .toMatchObject({
        semanticValue: '上市公司公开披露与行业信息研究分析师（注册会计师）',
        displayValue: '上市公司公开披露与行业信息研究分析师（注册会计师）',
        projectionKind: 'explicit-role',
      })
  })

  it('uses an explicit purpose line without leaking the runtime persona template', () => {
    const projection = projectPersona(`角色：供应商尽调分析师

You are a vendor analyst powered by the {{model}} model. Your working directory is {{cwd}}.

Your mandate: preserve a detailed runtime instruction without using it as the user-level Purpose.

目标：整合供应商公开信息和用户文件，识别核心事实与主要风险。

1. 输出结构化供应商尽调报告。`)

    expect(projection.purpose).toEqual({
      sourceValue: '目标：整合供应商公开信息和用户文件，识别核心事实与主要风险。',
      semanticValue: '整合供应商公开信息和用户文件，识别核心事实与主要风险。',
      displayValue: '整合供应商公开信息和用户文件，识别核心事实与主要风险。',
      source: 'preset', projectionKind: 'explicit-purpose', editable: true,
      writebackMethod: 'replace-purpose-span', prefix: '目标：', suffix: '',
    })
    expect(projection.purpose?.displayValue).not.toMatch(/\{\{model\}\}|\{\{cwd\}\}|You are/u)
  })

  it('retains standalone and numbered user-level Output evidence', () => {
    const projection = projectPersona('角色：供应商尽调分析师\n\n目标：核验供应商。\n\n1. 输出结构化报告，包括摘要、事实对比表、风险结论及带日期和来源的证据。')

    expect(projection.items).toEqual([{
      ordinal: 1,
      text: '输出结构化报告，包括摘要、事实对比表、风险结论及带日期和来源的证据。',
      paragraph: '1. 输出结构化报告，包括摘要、事实对比表、风险结论及带日期和来源的证据。',
    }])
    expect(projectPersona('角色：供应商尽调分析师\n\n目标：核验供应商。\n\n输出：结构化报告，包括摘要与来源。').output)
      .toEqual({
        sourceValue: '输出：结构化报告，包括摘要与来源。', semanticValue: '结构化报告，包括摘要与来源。',
        displayValue: '结构化报告，包括摘要与来源。', source: 'preset',
        projectionKind: 'explicit-output', editable: false, writebackMethod: null,
      })
  })

  it('does not project ambiguous duplicate Purpose or Output anchors', () => {
    expect(projectPersona('角色：分析师\n\n目标：核验事实。\n\n目标：评估风险。').purpose).toBeUndefined()
    expect(projectPersona('角色：分析师\n\n目标：核验事实。\n\n输出：摘要。\n\n输出：报告。').output)
      .toBeUndefined()
  })

  it('removes runtime prose and selects embedded Chinese role evidence from a legacy persona sentence', () => {
    const identity = projectPersona(
      'You are a listed-company research analyst（上市公司研究分析师）powered by the {{model}} model. Your working directory is {{cwd}}.',
    ).identity

    expect(identity).toMatchObject({
      semanticValue: '上市公司研究分析师', displayValue: '上市公司研究分析师',
      projectionKind: 'persona-role-slot', editable: true,
    })
    expect(identity?.displayValue).not.toMatch(/You are|\{\{model\}\}|\{\{cwd\}\}/u)
  })

  it('shows a deterministic legacy role clause without granting unsafe write-back', () => {
    expect(projectPersona('You are an archival research assistant. Use only supplied files.').identity)
      .toMatchObject({
        semanticValue: 'archival research assistant', displayValue: 'archival research assistant',
        projectionKind: 'legacy-role-clause', editable: false, writebackMethod: null,
      })
  })

  it('preserves comments and indentation when replacing one semantic line', () => {
    expect(hasUniqueTrimmedLine(COMPOSITION, '1. 先界定范围。')).toBe(true)

    const updated = replaceUniqueTrimmedLine(COMPOSITION, '1. 先界定范围。', '1. 先界定市场与时间窗口。')

    expect(updated).toContain('# retained comment')
    expect(updated).toContain('      1. 先界定市场与时间窗口。')
    expect(updated).not.toContain('1. 先界定范围。')
  })

  it('toggles the real Web Fetch config without reserializing YAML', () => {
    const removed = replaceWebFetch(COMPOSITION, true, false)

    expect(configuredWebFetch(parseComposition(removed))).toBe(false)
    expect(removed).toContain('# retained comment')
    expect(replaceWebFetch(removed, false, true)).toBe(COMPOSITION)
  })

  it('adds an explicit fetch field when tool-web relied on its default', () => {
    const implicit = COMPOSITION.replace('    fetch: true\n', '')
    const removed = replaceWebFetch(implicit, true, false)

    expect(removed).toContain('    fetch: false\n')
    expect(configuredWebFetch(parseComposition(removed))).toBe(false)
  })

  it('toggles another boolean field and inserts config for a row using defaults', () => {
    const searchDisabled = replaceBooleanConfig(COMPOSITION, 'tool-web', 'search', true, false, true)
    const backgroundDisabled = replaceBooleanConfig(
      searchDisabled, 'tool-pwsh', 'enableRunInBackground', true, false, true,
    )

    expect(configuredBoolean(parseComposition(searchDisabled), 'tool-web', 'search', true)).toBe(false)
    expect(backgroundDisabled).toContain('    enableRunInBackground: false\n')
    expect(configuredBoolean(
      parseComposition(backgroundDisabled), 'tool-pwsh', 'enableRunInBackground', true,
    )).toBe(false)
  })

  it('rejects stale or ambiguous narrow writes', () => {
    expect(() => replaceUniqueTrimmedLine(COMPOSITION, 'missing', 'replacement')).toThrow(/found 0/u)
    expect(() => replaceUniqueTrimmedLine(COMPOSITION, '1. 先界定范围。', 'two\nlines')).toThrow(/single physical line/u)
    expect(() => replaceWebFetch(COMPOSITION, false, true)).toThrow(/changed since projection/u)
    expect(() => replaceBooleanConfig(COMPOSITION, 'tool-web', 'search', false, true, true)).toThrow(/changed since projection/u)
    expect(() => rowById([...parseComposition(COMPOSITION), { id: 'persona' }], 'persona')).toThrow(/duplicate/u)
  })

  it('projects only active, literally configured delegation rows', () => {
    const rows = parseComposition(`${COMPOSITION}
- id: tool-subagent
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent
    backgroundMode: continuable
    persona: 负责核对来源并整理证据。
- id: tool-subagent-disabled
  name: '@deepseek-ai/dsh-tool-subagent'
  disabled: true
  config:
    provider: codex
`)

    const result = projectDelegations(rows, new Set(['subagent']), new Set(['spawn']))
    expect(result.delegations[0]?.configDigest).toMatch(/^[0-9a-f]{64}$/u)
    expect(result).toMatchObject({
      delegations: [{
        rowId: 'tool-subagent', tool: 'subagent', provider: 'spawn', mode: 'continuable',
        persona: '负责核对来源并整理证据。', providerAvailable: true, enabled: true,
      }],
      gaps: [],
    })
  })

  it('canonically digests complete delegation config including nested Loader expressions', () => {
    const projection = (expression: string) => projectDelegations(parseComposition(`- id: research
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    toolFilter:
      allow: [web_search, read]
      dynamic: !!js ${expression}
    maxDepth: 2
    agentOptions:
      temperature: 0.2
      provider: deepseek
    backgroundMode: one-shot
    toolName: research
    provider: spawn
`), new Set(['research']), new Set(['spawn'])).delegations[0]?.configDigest

    const baseline = projection('ctx.permissions.allowDelegation')
    expect(baseline).toMatch(/^[0-9a-f]{64}$/u)
    expect(projection('ctx.permissions.allowDelegation')).toBe(baseline)
    expect(projection('ctx.permissions.allowResearch')).not.toBe(baseline)
  })

  it('refuses delegation rows without stable literal identity and configuration', () => {
    const rows = parseComposition(`- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
- id: malformed-subagent
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: 42
`)

    const projected = projectDelegations(rows, new Set(), new Set(['spawn']))
    expect(projected.delegations).toEqual([])
    expect(projected.gaps).toEqual([
      { reason: 'An active tool-subagent row has no stable string id.' },
      {
        rowId: 'malformed-subagent',
        reason: 'The active tool-subagent row does not expose literal provider, toolName, and backgroundMode values.',
      },
    ])
  })

  it('does not project a delegation whose depth policy rejects its first child', () => {
    const rows = parseComposition(`- id: disabled-by-depth
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: industry_research
    maxDepth: 0
`)

    expect(projectDelegations(rows, new Set(['industry_research']), new Set(['spawn']))).toEqual({
      delegations: [],
      gaps: [{
        rowId: 'disabled-by-depth',
        reason: 'The active tool-subagent row sets maxDepth to 0, so its first delegation call cannot start.',
      }],
    })
  })

  it('admits only minimal lane-owned composition additions for capability candidates', () => {
    const baseline = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: baseline
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
`
    expect(() => { assertCapabilityCompositionDelta(baseline, `${baseline}- id: local-skills
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    includeDefaultRoots: false
    customSkillDirs:
      - !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))"
- id: skill
  name: '@deepseek-ai/dsh-tool-skill'
`, 'skill') }).not.toThrow()
    const subagent = assertCapabilityCompositionDelta(baseline, `${baseline}- id: research-child
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: research_child
    backgroundMode: continuable
    maxDepth: 1
`, 'subagent')
    expect(subagent.kind).toBe('subagent')
    if (subagent.kind !== 'subagent') throw new Error('expected Subagent composition evidence')
    expect(subagent.rowId).toBe('research-child')
    expect(subagent.configDigest).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('rejects unrelated row mutation and ambient Skill discovery in a capability candidate', () => {
    const baseline = `- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
  config:
    policy: baseline
`
    const unrelatedMutation = `- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
  config:
    policy: changed
- id: research-child
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: research_child
    backgroundMode: continuable
`
    expect(() => { assertCapabilityCompositionDelta(baseline, unrelatedMutation, 'subagent') })
      .toThrow(/changed, removed, or reordered/u)

    const ambientRoots = `${baseline}- id: local-skills
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    customSkillDirs:
      - !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))"
- id: skill
  name: '@deepseek-ai/dsh-tool-skill'
`
    expect(() => { assertCapabilityCompositionDelta(baseline, ambientRoots, 'skill') })
      .toThrow(/without default roots/u)

    const externalRoot = `${baseline}- id: local-skills
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    includeDefaultRoots: false
    customSkillDirs:
      - C:/shared/skills
- id: skill
  name: '@deepseek-ai/dsh-tool-skill'
`
    expect(() => { assertCapabilityCompositionDelta(baseline, externalRoot, 'skill') })
      .toThrow(/preset-local root/u)
  })

  it('extends the standard preset Skill provider without replacing its baseline roots', () => {
    const baseline = `- id: persona
  name: '@deepseek-ai/dsh-persona'
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
- id: tool-skill
  name: '@deepseek-ai/dsh-tool-skill'
`
    const candidate = `- id: persona
  name: '@deepseek-ai/dsh-persona'
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    customSkillDirs:
      - !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))"
- id: tool-skill
  name: '@deepseek-ai/dsh-tool-skill'
`
    expect(() => { assertCapabilityCompositionDelta(baseline, candidate, 'skill') }).not.toThrow()

    const configuredBaseline = baseline.replace(
      "  name: '@deepseek-ai/dsh-skill-filesystem'\n",
      "  name: '@deepseek-ai/dsh-skill-filesystem'\n  config:\n    customSkillDirs:\n      - C:/baseline/skills\n",
    )
    const configuredCandidate = candidate.replace(
      '    customSkillDirs:\n',
      '    customSkillDirs:\n      - C:/baseline/skills\n',
    )
    expect(() => { assertCapabilityCompositionDelta(configuredBaseline, configuredCandidate, 'skill') }).not.toThrow()

    const removedBaselineRoot = configuredCandidate.replace('      - C:/baseline/skills\n', '')
    expect(() => { assertCapabilityCompositionDelta(configuredBaseline, removedBaselineRoot, 'skill') })
      .toThrow(/append only the preset-local root/u)

    const changedDefaults = candidate.replace(
      '  config:\n',
      '  config:\n    includeDefaultRoots: false\n',
    )
    expect(() => { assertCapabilityCompositionDelta(baseline, changedDefaults, 'skill') })
      .toThrow(/append only the preset-local root/u)

    const duplicateProvider = `${candidate}- id: duplicate-skills
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    includeDefaultRoots: false
    customSkillDirs:
      - !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))"
`
    expect(() => { assertCapabilityCompositionDelta(baseline, duplicateProvider, 'skill') })
      .toThrow(/may add only one skill-filesystem row/u)

    const providerConfiguredBaseline = baseline
      .replace("  name: '@deepseek-ai/dsh-skill-filesystem'\n", "  name: '@deepseek-ai/dsh-skill-filesystem'\n  config:\n    providerName: target-filesystem\n")
      .replace("  name: '@deepseek-ai/dsh-tool-skill'\n", "  name: '@deepseek-ai/dsh-tool-skill'\n  config:\n    catalogDescriptionMaxLength: 80\n")
    const providerConfiguredCandidate = candidate
      .replace("  name: '@deepseek-ai/dsh-skill-filesystem'\n  config:\n", "  name: '@deepseek-ai/dsh-skill-filesystem'\n  config:\n    providerName: target-filesystem\n")
      .replace("  name: '@deepseek-ai/dsh-tool-skill'\n", "  name: '@deepseek-ai/dsh-tool-skill'\n  config:\n    catalogDescriptionMaxLength: 80\n")
    expect(() => {
      assertCapabilityCompositionDelta(providerConfiguredBaseline, providerConfiguredCandidate, 'skill')
    }).not.toThrow()
  })
})
