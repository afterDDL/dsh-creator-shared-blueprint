import { describe, expect, it } from 'vitest'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { validateRuntimeConformance } from '../src/host/conformance.ts'
import {
  BLUEPRINT_CAPABILITY_AUTHORING_TOOL, BLUEPRINT_CONVERSATION_SECTION, BLUEPRINT_PROPOSAL_TOOL,
} from '../src/host/proposal.ts'
import type { Blueprint, BlueprintApplyChangeSetResult } from '../src/contract/types.ts'

const PERSONA = `你是一名保研申请顾问，由 {{model}} 驱动。

你的职责是帮助用户完成国内保研择校与申请管理。工作方式：

1. 按推免政策检查申请资格。

2. 跟踪夏令营报名与入营结果。

3. 管理预推免院校与截止时间。

4. 维护九推候补与录取状态。

5. 交付形式：输出申请进度表、风险摘要与来源。`

const OLD_PERSONA = PERSONA
  .replace('保研申请顾问', '考研择校助手')
  .replace('按推免政策检查申请资格。', '按统考口径检查报考资格。')

const WEB_SEARCH = {
  name: 'web_search',
  description: '搜索最新公开信息。',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
}

const SUBAGENT = {
  name: 'subagent',
  description: '委派独立任务。',
  parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
}

function assembly(persona = PERSONA): PromptAssembly {
  return {
    sections: [
      { name: 'harness:identity', text: 'Harness identity.' },
      { name: 'deployment:persona', text: persona },
    ],
    contexts: [],
    tools: [WEB_SEARCH],
    variables: { model: 'deepseek-chat' },
  }
}

function blueprint(): Blueprint {
  return {
    schemaVersion: 1,
    preset: { id: 'kaoyan-choose', trust: 'user', name: '保研择校' },
    revision: 'revision-after-apply',
    nodes: [
      { id: 'identity:persona', type: 'identity', value: '保研申请顾问', source: 'preset', status: 'active', editable: true, adapterRef: 'identity' },
      { id: 'purpose:persona', type: 'purpose', value: '你的职责是帮助用户完成国内保研择校与申请管理。', source: 'inferred', status: 'active', editable: true, adapterRef: 'purpose' },
      { id: 'behavior:1', type: 'behavior', value: '按推免政策检查申请资格。', source: 'preset', status: 'active', editable: true, adapterRef: 'behavior:1' },
      { id: 'behavior:2', type: 'behavior', value: '跟踪夏令营报名与入营结果。', source: 'preset', status: 'active', editable: true, adapterRef: 'behavior:2' },
      { id: 'behavior:3', type: 'behavior', value: '管理预推免院校与截止时间。', source: 'preset', status: 'active', editable: true, adapterRef: 'behavior:3' },
      { id: 'behavior:4', type: 'behavior', value: '维护九推候补与录取状态。', source: 'preset', status: 'active', editable: true, adapterRef: 'behavior:4' },
      { id: 'output:5', type: 'output', value: '交付形式：输出申请进度表、风险摘要与来源。', source: 'inferred', status: 'active', editable: true, adapterRef: 'output:5' },
      { id: 'capability:web-search', type: 'capability', value: { name: 'Web Search', tool: 'web_search', enabled: true }, source: 'runtime', status: 'active', editable: true, adapterRef: 'search' },
      { id: 'capability:web-fetch', type: 'capability', value: { name: 'Web Fetch', tool: 'web_fetch', enabled: false }, source: 'preset', status: 'inactive', editable: true, adapterRef: 'fetch' },
    ],
    runtime: {
      tools: ['web_search'],
      promptSections: ['harness:identity', 'deployment:persona'],
      skills: [],
      delegations: [],
      permissions: { preset: 'workspace', sandbox: 'workspace-write', approval: 'on-request' },
    },
    mappingGaps: [],
  }
}

function transaction(): BlueprintApplyChangeSetResult {
  return {
    sourceSessionId: 'source-session',
    routeId: 'route-1',
    changeSetId: 'kaoyan-1-plus-4',
    baseRevision: 'revision-before-apply',
    committedRevision: 'revision-after-apply',
    status: 'committed',
    operations: [
      { operation: 'updateIdentity', targetNodeId: 'identity:persona', expected: '考研择校助手', value: '保研申请顾问' },
      { operation: 'updateBehavior', targetNodeId: 'behavior:1', expected: '按统考口径检查报考资格。', value: '按推免政策检查申请资格。' },
    ],
    preflight: { ok: true },
    unexpectedDrift: [],
  }
}

function validate(liveAssembly = assembly(), applied = transaction()) {
  const permissions = { preset: 'workspace', sandbox: 'workspace-write', approval: 'on-request' }
  return validateRuntimeConformance({
    presetId: 'kaoyan-choose',
    sessionId: 'trial-session',
    expectedRevision: 'revision-after-apply',
    expectedBlueprint: blueprint(),
    expectedAssembly: assembly(),
    liveAssembly,
    sessionPresetId: 'kaoyan-choose',
    composedPresetId: 'kaoyan-choose',
    expectedPermissions: permissions,
    livePermissions: permissions,
    liveSkills: [],
    liveDelegationProviders: [],
    transaction: applied,
  })
}

describe('Blueprint runtime conformance', () => {
  it('proves the post-Apply kaoyan Blueprint through live prompt, schema, permission, and preset evidence', () => {
    const result = validate()

    expect(result).toMatchObject({
      valid: true,
      overall: 'pass',
      binding: {
        status: 'pass', sessionPresetId: 'kaoyan-choose', composedPresetId: 'kaoyan-choose',
        strictRevisionBound: false,
      },
      prompt: { status: 'pass' },
      tools: { status: 'pass', missing: [], unexpected: [], schemaMismatches: [] },
      permissions: { status: 'pass' },
      changeReceipt: {
        changeSetId: 'kaoyan-1-plus-4',
        apply: { preflight: 'pass', presetWrite: 'pass', reprojection: 'pass', semanticDrift: 'none' },
        runtime: { prompt: 'pass', tools: 'pass', permissions: 'pass', overall: 'pass' },
      },
    })
    expect(result.prompt.evidence.find(item => item.nodeId === 'identity:persona'))
      .toMatchObject({ status: 'pass', sectionName: 'deployment:persona' })
    expect(result.prompt.evidence.find(item => item.nodeId === 'behavior:1'))
      .toMatchObject({ status: 'pass' })
    expect(result.tools.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'capability:web-search', actualPresent: true, status: 'pass' }),
      expect.objectContaining({ nodeId: 'capability:web-fetch', actualPresent: false, status: 'pass' }),
    ]))
    expect(JSON.stringify(result)).not.toContain(PERSONA)
  })

  it('fails when the section name and tool list match but the live persona text is stale', () => {
    const result = validate(assembly(OLD_PERSONA))

    expect(result.overall).toBe('fail')
    expect(result.prompt.status).toBe('fail')
    expect(result.tools.status).toBe('pass')
    expect(result.prompt.evidence.find(item => item.nodeId === 'identity:persona'))
      .toMatchObject({ status: 'fail', sectionName: 'deployment:persona' })
    expect(result.prompt.evidence.find(item => item.nodeId === 'behavior:1'))
      .toMatchObject({ status: 'fail' })
  })

  it('accepts a committed semantic value that preserves the old value as a substring', () => {
    const applied = transaction()
    applied.operations[0] = {
      operation: 'updateIdentity', targetNodeId: 'identity:persona',
      expected: '保研申请', value: '保研申请顾问',
    }

    const result = validate(assembly(), applied)

    expect(result).toMatchObject({ overall: 'pass', prompt: { status: 'pass' } })
    expect(result.prompt.evidence.find(item => item.nodeId === 'identity:persona'))
      .toMatchObject({ status: 'pass', sectionName: 'deployment:persona' })
  })

  it('excludes Builder conversation context from the target preset runtime', () => {
    const live = assembly()
    live.sections.push({ name: BLUEPRINT_CONVERSATION_SECTION, text: 'Builder-only context.' })
    live.tools.push({ ...WEB_SEARCH, name: BLUEPRINT_PROPOSAL_TOOL })
    live.tools.push({ ...WEB_SEARCH, name: BLUEPRINT_CAPABILITY_AUTHORING_TOOL })

    expect(validate(live)).toMatchObject({ overall: 'pass', tools: { status: 'pass' } })
  })

  it('proves scoped Skill definitions and configured delegation prompt evidence', () => {
    const expectedBlueprint = blueprint()
    expectedBlueprint.nodes.push(
      {
        id: 'capability:skill:source-audit', type: 'capability', source: 'preset', status: 'active',
        editable: false, adapterRef: null,
        value: {
          kind: 'skill', name: 'source-audit', description: '核对来源。', callable: true, scope: 'preset',
          invocation: { modelInvocable: true, userInvocable: true },
        },
      },
      {
        id: 'capability:delegation:tool-subagent', type: 'capability', source: 'preset', status: 'active',
        editable: false, adapterRef: null,
        value: {
          kind: 'delegation', name: 'Collaborating Agent', tool: 'subagent', provider: 'spawn',
          mode: 'continuable', providerAvailable: true, enabled: true,
        },
      },
    )
    expectedBlueprint.runtime.skills = [{
      name: 'source-audit', description: '核对来源。',
      invocation: { modelInvocable: true, userInvocable: true },
      scope: 'preset', provider: 'filesystem', source: 'custom', definitionDigest: 'skill-digest',
    }]
    expectedBlueprint.runtime.delegations = [{
      rowId: 'tool-subagent', tool: 'subagent', provider: 'spawn', mode: 'continuable',
      configDigest: 'a'.repeat(64),
      providerAvailable: true, enabled: true,
    }]
    const expectedAssembly = assembly()
    expectedAssembly.tools.push(SUBAGENT)
    expectedAssembly.sections.push({ name: 'tool:subagent', text: 'Delegate independent work and continue later.' })
    const liveAssembly = structuredClone(expectedAssembly)
    const permissions = { preset: 'workspace', sandbox: 'workspace-write', approval: 'on-request' }
    const input = {
      presetId: 'kaoyan-choose', sessionId: 'trial-session', expectedRevision: expectedBlueprint.revision,
      expectedBlueprint, expectedAssembly, liveAssembly,
      sessionPresetId: 'kaoyan-choose', composedPresetId: 'kaoyan-choose',
      expectedPermissions: permissions, livePermissions: permissions,
      liveSkills: expectedBlueprint.runtime.skills,
      liveDelegationProviders: ['spawn'],
    }

    expect(validateRuntimeConformance(input)).toMatchObject({
      overall: 'pass',
      skills: {
        status: 'pass',
        evidence: [{ nodeId: 'capability:skill:source-audit', actualPresent: true, status: 'pass' }],
      },
      delegations: {
        status: 'pass',
        evidence: [{
          nodeId: 'capability:delegation:tool-subagent', providerAvailable: true,
          sectionName: 'tool:subagent', status: 'pass',
        }],
      },
    })

    const staleSkill = {
      ...input,
      liveSkills: input.liveSkills.map(skill => ({ ...skill, definitionDigest: 'stale-definition' })),
    }
    expect(validateRuntimeConformance(staleSkill)).toMatchObject({
      overall: 'fail', skills: { status: 'fail', evidence: [{ status: 'fail' }] },
    })
  })

  it('accepts a one-shot delegation whose Tool contributes no prompt section', () => {
    const expectedBlueprint = blueprint()
    expectedBlueprint.nodes.push({
      id: 'capability:delegation:industry-research', type: 'capability', source: 'preset', status: 'active',
      editable: false, adapterRef: null,
      value: {
        kind: 'delegation', name: 'Industry Research Collaborating Agent',
        tool: 'subagent_industry_research', provider: 'spawn', mode: 'one-shot',
        providerAvailable: true, enabled: true,
      },
    })
    expectedBlueprint.runtime.delegations = [{
      rowId: 'industry-research', tool: 'subagent_industry_research', provider: 'spawn', mode: 'one-shot',
      configDigest: 'b'.repeat(64),
      providerAvailable: true, enabled: true,
    }]
    const expectedAssembly = assembly()
    expectedAssembly.tools.push({ ...SUBAGENT, name: 'subagent_industry_research' })
    const permissions = { preset: 'workspace', sandbox: 'workspace-write', approval: 'on-request' }

    expect(validateRuntimeConformance({
      presetId: 'kaoyan-choose', sessionId: 'trial-session', expectedRevision: expectedBlueprint.revision,
      expectedBlueprint, expectedAssembly, liveAssembly: structuredClone(expectedAssembly),
      sessionPresetId: 'kaoyan-choose', composedPresetId: 'kaoyan-choose',
      expectedPermissions: permissions, livePermissions: permissions,
      liveSkills: [], liveDelegationProviders: ['spawn'],
    })).toMatchObject({
      overall: 'pass',
      delegations: {
        status: 'pass',
        evidence: [{
          nodeId: 'capability:delegation:industry-research',
          providerAvailable: true,
          status: 'pass',
        }],
      },
    })
  })
})
