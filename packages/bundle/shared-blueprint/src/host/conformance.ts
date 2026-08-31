/** Content-level runtime conformance over expected and live prompt assemblies. */

import { createHash } from 'node:crypto'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type {
  Blueprint,
  BlueprintApplyChangeSetResult,
  BlueprintChangeReceipt,
  BlueprintConformanceStatus,
  BlueprintPromptEvidence,
  BlueprintRuntimeSkill,
  BlueprintRuntimeSnapshot,
  BlueprintSessionValidation,
  BlueprintToolEvidence,
} from '../contract/types.ts'
import { canonicalJson } from './canonical-json.ts'
import {
  BLUEPRINT_CAPABILITY_AUTHORING_TOOL, BLUEPRINT_CONVERSATION_SECTION,
  BLUEPRINT_CREATOR_AUTHORING_TOOL, BLUEPRINT_PROPOSAL_TOOL,
} from './proposal.ts'

/** Inputs owned by `validateSession` after it resolves the expected and live assemblies. */
export interface BlueprintConformanceInput {
  /** Target preset requested by the trial flow. */
  presetId: string
  /** Newly created live Session identity. */
  sessionId: string
  /** Revision shown by the UI when it requested the Session. */
  expectedRevision: string
  /** Fresh projection of current preset text and standing assembly. */
  expectedBlueprint: Blueprint
  /** Standing assembly for the expected preset generation. */
  expectedAssembly: PromptAssembly
  /** Assembly read through the live Agent scope. */
  liveAssembly: PromptAssembly
  /** Preset recorded in the Session header. */
  sessionPresetId?: string
  /** Preset joined by the live Agent scope. */
  composedPresetId?: string
  /** Effective permissions projected from the expected standing state. */
  expectedPermissions: BlueprintRuntimeSnapshot['permissions']
  /** Effective permissions resolved from the live Session log. */
  livePermissions: BlueprintRuntimeSnapshot['permissions']
  /** Skill definitions resolved through the live Agent scope. */
  liveSkills: BlueprintRuntimeSkill[]
  /** Subagent providers registered while the live assembly is validated. */
  liveDelegationProviders: string[]
  /** Optional durable P0 transaction result matching this trial. */
  transaction?: BlueprintApplyChangeSetResult
}

/**
 * Compare user-visible semantic nodes with the actual live assembly.
 * @param input - expected preset projection, live assembly, binding, and optional P0 receipt.
 * @returns digest-only evidence; raw prompt and tool schema content never leaves the Host.
 */
export function validateRuntimeConformance(input: BlueprintConformanceInput): BlueprintSessionValidation {
  const promptEvidence = promptEvidenceFor(input)
  const promptStatus = categoryStatus(promptEvidence.every(item => item.status === 'pass'))
  const toolResult = toolEvidenceFor(input)
  const skillResult = skillEvidenceFor(input)
  const delegationResult = delegationEvidenceFor(input, toolResult.evidence)
  const permissionsStatus = categoryStatus(sameJson(input.expectedPermissions, input.livePermissions))
  const binding = {
    status: categoryStatus(
      input.sessionPresetId === input.presetId
      && input.composedPresetId === input.presetId
      && input.expectedBlueprint.revision === input.expectedRevision,
    ),
    ...(input.sessionPresetId === undefined ? {} : { sessionPresetId: input.sessionPresetId }),
    ...(input.composedPresetId === undefined ? {} : { composedPresetId: input.composedPresetId }),
    expectedRevision: input.expectedRevision,
    projectedRevision: input.expectedBlueprint.revision,
    strictRevisionBound: false as const,
  }
  const overall = categoryStatus(
    binding.status === 'pass'
    && promptStatus === 'pass'
    && toolResult.status === 'pass'
    && skillResult.status === 'pass'
    && delegationResult.status === 'pass'
    && permissionsStatus === 'pass',
  )
  const changeReceipt = receiptFor(input.transaction, input.expectedRevision, {
    prompt: promptStatus,
    tools: toolResult.status,
    skills: skillResult.status,
    delegations: delegationResult.status,
    permissions: permissionsStatus,
    overall,
  })
  return {
    sessionId: input.sessionId,
    presetId: input.presetId,
    valid: overall === 'pass',
    overall,
    binding,
    prompt: { status: promptStatus, evidence: promptEvidence },
    tools: toolResult,
    skills: skillResult,
    delegations: delegationResult,
    permissions: { status: permissionsStatus },
    ...(changeReceipt === undefined ? {} : { changeReceipt }),
  }
}

function skillEvidenceFor(input: BlueprintConformanceInput): BlueprintSessionValidation['skills'] {
  const expected = new Map(input.expectedBlueprint.runtime.skills.map(skill => [skill.name, skill]))
  const live = new Map(input.liveSkills.map(skill => [skill.name, skill]))
  const missing = [...expected.keys()].filter(name => !live.has(name)).sort()
  const unexpected = [...live.keys()].filter(name => !expected.has(name)).sort()
  const evidence = [...expected.values()].map((skill) => {
    const actual = live.get(skill.name)
    return {
      nodeId: `capability:skill:${skill.name}`,
      name: skill.name,
      actualPresent: actual !== undefined,
      expectedDefinitionDigest: skill.definitionDigest,
      ...(actual === undefined ? {} : { liveDefinitionDigest: actual.definitionDigest }),
      status: categoryStatus(actual !== undefined
        && actual.description === skill.description
        && actual.provider === skill.provider
        && actual.source === skill.source
        && actual.scope === skill.scope
        && sameJson(actual.invocation, skill.invocation)
        && actual.definitionDigest === skill.definitionDigest),
    }
  })
  return {
    status: categoryStatus(missing.length === 0 && unexpected.length === 0
      && evidence.every(item => item.status === 'pass')),
    evidence,
    missing,
    unexpected,
  }
}

function delegationEvidenceFor(
  input: BlueprintConformanceInput,
  tools: BlueprintToolEvidence[],
): BlueprintSessionValidation['delegations'] {
  const liveProviders = new Set(input.liveDelegationProviders)
  const evidence = input.expectedBlueprint.runtime.delegations.map((delegation) => {
    const nodeId = `capability:delegation:${delegation.rowId}`
    const tool = tools.find(item => item.nodeId === nodeId)
    const sectionName = `tool:${delegation.tool}`
    const expectedSection = input.expectedAssembly.sections.find(section => section.name === sectionName)
    const liveSection = input.liveAssembly.sections
      .filter(section => section.name !== BLUEPRINT_CONVERSATION_SECTION)
      .find(section => section.name === sectionName)
    const promptMatches = expectedSection === undefined
      ? liveSection === undefined
      : liveSection !== undefined && digest(expectedSection.text) === digest(liveSection.text)
    const providerAvailable = liveProviders.has(delegation.provider)
    return {
      nodeId,
      rowId: delegation.rowId,
      tool: delegation.tool,
      provider: delegation.provider,
      providerAvailable,
      ...(expectedSection === undefined ? {} : {
        sectionName,
        expectedSectionDigest: digest(expectedSection.text),
      }),
      ...(liveSection === undefined ? {} : { liveSectionDigest: digest(liveSection.text) }),
      status: categoryStatus(
        providerAvailable === delegation.providerAvailable
        && tool?.status === 'pass'
        && promptMatches,
      ),
    }
  })
  return {
    status: categoryStatus(evidence.every(item => item.status === 'pass')),
    evidence,
  }
}

function promptEvidenceFor(input: BlueprintConformanceInput): BlueprintPromptEvidence[] {
  return input.expectedBlueprint.nodes.flatMap((node): BlueprintPromptEvidence[] => {
    if (node.type !== 'identity' && node.type !== 'purpose'
      && node.type !== 'behavior' && node.type !== 'output') return []
    if (typeof node.value !== 'string') return [{ nodeId: node.id, nodeType: node.type, status: 'fail' }]
    const value = node.value
    const expectedSections = input.expectedAssembly.sections.filter(section => section.text.includes(value))
    const expectedSection = expectedSections.find(section => input.liveAssembly.sections.some(live => (
      live.name !== BLUEPRINT_CONVERSATION_SECTION
      && live.name === section.name
      && live.text.includes(value)
    ))) ?? expectedSections[0]
    if (expectedSection === undefined) return [{ nodeId: node.id, nodeType: node.type, status: 'fail' }]
    const liveSection = input.liveAssembly.sections
      .filter(section => section.name !== BLUEPRINT_CONVERSATION_SECTION)
      .find(section => section.name === expectedSection.name)
    const status = categoryStatus(liveSection?.text.includes(value) === true)
    return [{
      nodeId: node.id,
      nodeType: node.type,
      sectionName: expectedSection.name,
      expectedSectionDigest: digest(expectedSection.text),
      ...(liveSection === undefined ? {} : { liveSectionDigest: digest(liveSection.text) }),
      status,
    }]
  })
}

function toolEvidenceFor(input: BlueprintConformanceInput): BlueprintSessionValidation['tools'] {
  const expected = new Map(input.expectedAssembly.tools
    .filter(tool => tool.name !== BLUEPRINT_PROPOSAL_TOOL
      && tool.name !== BLUEPRINT_CAPABILITY_AUTHORING_TOOL
      && tool.name !== BLUEPRINT_CREATOR_AUTHORING_TOOL)
    .map(tool => [tool.name, tool]))
  const live = new Map(input.liveAssembly.tools
    .filter(tool => tool.name !== BLUEPRINT_PROPOSAL_TOOL
      && tool.name !== BLUEPRINT_CAPABILITY_AUTHORING_TOOL
      && tool.name !== BLUEPRINT_CREATOR_AUTHORING_TOOL)
    .map(tool => [tool.name, tool]))
  const missing = [...expected.keys()].filter(name => !live.has(name)).sort()
  const unexpected = [...live.keys()].filter(name => !expected.has(name)).sort()
  const schemaMismatches = [...expected.keys()].filter((name) => {
    const actual = live.get(name)
    const expectedTool = expected.get(name)
    return actual !== undefined && expectedTool !== undefined && schemaDigest(expectedTool) !== schemaDigest(actual)
  }).sort()
  const evidence = input.expectedBlueprint.nodes.flatMap((node): BlueprintToolEvidence[] => {
    if (node.type !== 'capability' || typeof node.value !== 'object'
      || node.value === null || Array.isArray(node.value)) return []
    const value = node.value as Record<string, unknown>
    if (typeof value['tool'] !== 'string' || typeof value['enabled'] !== 'boolean') return []
    const expectedSchema = expected.get(value['tool'])
    const liveSchema = live.get(value['tool'])
    const expectedEnabled = value['enabled']
    const actualPresent = liveSchema !== undefined
    const status = categoryStatus(expectedEnabled === actualPresent
      && (!expectedEnabled || (expectedSchema !== undefined && liveSchema !== undefined
        && schemaDigest(expectedSchema) === schemaDigest(liveSchema))))
    return [{
      nodeId: node.id,
      tool: value['tool'],
      expectedEnabled,
      actualPresent,
      ...(expectedSchema === undefined ? {} : { expectedSchemaDigest: schemaDigest(expectedSchema) }),
      ...(liveSchema === undefined ? {} : { liveSchemaDigest: schemaDigest(liveSchema) }),
      status,
    }]
  })
  return {
    status: categoryStatus(missing.length === 0 && unexpected.length === 0
      && schemaMismatches.length === 0 && evidence.every(item => item.status === 'pass')),
    evidence,
    missing,
    unexpected,
    schemaMismatches,
  }
}

function receiptFor(
  transaction: BlueprintApplyChangeSetResult | undefined,
  expectedRevision: string,
  runtime: BlueprintChangeReceipt['runtime'],
): BlueprintChangeReceipt | undefined {
  if (transaction?.status !== 'committed' || transaction.committedRevision !== expectedRevision) return undefined
  return {
    changeSetId: transaction.changeSetId,
    baseRevision: transaction.baseRevision,
    committedRevision: transaction.committedRevision,
    apply: {
      preflight: 'pass',
      presetWrite: 'pass',
      reprojection: 'pass',
      semanticDrift: 'none',
    },
    runtime,
  }
}

function schemaDigest(value: { name: string; description: string; parameters: Record<string, unknown> }): string {
  return digest(canonicalJson(value))
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function categoryStatus(pass: boolean): BlueprintConformanceStatus {
  return pass ? 'pass' : 'fail'
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}
