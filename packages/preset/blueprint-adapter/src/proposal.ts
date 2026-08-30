/** Conversation-only Blueprint proposal policy and validation. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import type {
  Blueprint, BlueprintCapabilityAuthoringRoute,
  BlueprintChangeOperation, BlueprintChangeProposal, BlueprintChangeSet, BlueprintChangeSetOperation,
  BlueprintCreatorAuthoringEvent,
  BlueprintCreatorAuthoringRoute, BlueprintNode,
  BlueprintProposalValue, BlueprintStructuredEdit, BlueprintStructuredEditInput,
  BlueprintUserChange, BlueprintUserChangeInput, BlueprintUserChangeOperation,
} from './types.ts'
import { discoverBlueprintImpactCandidates } from './impact.ts'
import { sourceLanguageFromText } from './language.ts'
import { assertBlueprintOperation, type BlueprintRoutingInput } from './routing.ts'

/** Wire name of the model Tool that creates previews but never writes presets. */
export const BLUEPRINT_PROPOSAL_TOOL = 'propose_blueprint_change'

/** Wire name of the model Tool that requests Creator-owned composition authoring. */
export const BLUEPRINT_CAPABILITY_AUTHORING_TOOL = 'route_blueprint_capability_authoring'

/** Wire name of the language-neutral model Tool that continues a request as new-Agent authoring. */
export const BLUEPRINT_CREATOR_AUTHORING_TOOL = 'route_blueprint_creator_authoring'

/** Runtime-context contribution carrying the current optional Blueprint conversation state. */
export const BLUEPRINT_CONVERSATION_SECTION = 'blueprint:conversation'

/** Source summary that identifies the model turn woken by one direct edit. */
const BLUEPRINT_USER_CHANGE_NOTICE = 'Blueprint direct edit'

const HYPOTHETICAL = /(?:如果|假如|假设|会怎样|会怎么样|会有什么|what\s+if|hypothetical)/iu
const EXPLICIT_CHANGE = new RegExp(
  '(?:关掉|关闭|停用|禁用|打开|开启|启用|改成|修改为|改为|换成|增加|添加|加入|删掉|删除|移除|去掉|不再|不要再'
  + '|please\\s+(?:turn|change|update|add|remove|disable|enable)'
  + '|(?:turn|switch)\\s+(?:it\\s+)?(?:off|on)|(?:change|update|add|remove|disable|enable)\\b)',
  'iu',
)
const DEICTIC_TARGET = /(?:这个|它|这一项|该项|那|\bthat\b|\bthis\b|\bit\b)/iu
const NAMED_TARGET = /(?:角色|identity|网页搜索|web\s*search|网页读取|web\s*fetch|输出|output|规则|behavior|purpose|目标|做什么|file\s*read|文件读取)/iu

/** Model arguments accepted by the proposal Tool before Host validation. */
export interface BlueprintProposalArgs {
  target_node_id: string
  operation: BlueprintChangeOperation
  current_value: JsonValue
  proposed_value: JsonValue
  impact: string
  dependency?: string
}

/** Model arguments for one atomic-preview, atomic-apply Change Set. */
export interface BlueprintChangeSetArgs {
  /** Language-neutral model decision selecting the only proposal policy allowed for this turn. */
  intent: 'modify-existing-agent' | 'reconcile-direct-edit'
  changes: readonly BlueprintProposalArgs[]
}

/**
 * Reject an Add capability approximation before it can reserve the existing-edit operation.
 * @param input - original message and Host-owned action provenance.
 * @param args - parsed proposal intent and typed changes.
 */
export function assertBlueprintProposalForRoutingInput(
  input: BlueprintRoutingInput,
  args: BlueprintChangeSetArgs,
): void {
  if (input.provenance !== 'add-capability') return
  if (args.changes.some(change => change.operation !== 'setCapability' && change.operation !== 'updateOutput')) {
    throw new Error('blueprint proposal: Add capability cannot be approximated by Identity, Purpose, or Behavior text; route reusable procedures and collaborators to authoring')
  }
}

/**
 * Validate one browser editor submission against the committed Blueprint without writing it.
 * @param blueprint - authoritative committed projection.
 * @param input - client route, selected node, expected value, and confirmed draft.
 * @returns a typed staged edit with the only nodes eligible for P2 review.
 */
export function createBlueprintStructuredEdit(
  blueprint: Blueprint,
  input: BlueprintStructuredEditInput,
): BlueprintStructuredEdit {
  const node = blueprint.nodes.find(candidate => candidate.id === input.nodeId)
  if (node === undefined || node.type === 'access' || node.type !== input.nodeType || !node.editable) {
    throw new Error('blueprint structured edit: the selected node is not an editable node of the submitted type')
  }
  const operation = structuredEditOperation(node)
  const { current: currentValue, proposed: proposedValue } = scalarValues(node, {
    target_node_id: node.id,
    operation,
    current_value: input.expectedValue,
    proposed_value: input.proposedValue,
    impact: 'structured editor submission',
  })
  if (currentValue === proposedValue) {
    throw new Error('blueprint structured edit: proposed value must differ from the committed value')
  }
  const change = {
    nodeId: node.id,
    nodeType: node.type,
    previousValue: currentValue,
    currentValue: proposedValue,
    operation: typeof proposedValue === 'boolean'
      ? proposedValue ? 'enable' as const : 'disable' as const
      : 'update' as const,
  }
  return {
    nodeId: node.id,
    nodeType: node.type,
    label: blueprintNodeLabel(node),
    operation,
    currentValue,
    proposedValue,
    impactCandidates: discoverBlueprintImpactCandidates(blueprint, change),
  }
}

/**
 * Create the visible user message for a confirmed structured editor submission.
 * @param edit - Host-validated staged semantic edit.
 * @returns one human-owned message whose durable routing event retains the exact typed values.
 */
export function blueprintStructuredEditMessage(edit: BlueprintStructuredEdit): UserMessage {
  return createUserMessage({
    source: { kind: 'user' },
    content: [{
      type: 'text',
      text: typeof edit.proposedValue === 'boolean'
        ? `${edit.proposedValue ? '启用' : '停用'} ${edit.label}`
        : `将 ${edit.label} 修改为：${edit.proposedValue}`,
    }],
  })
}

/**
 * Parse and bind one model routing decision to the current real Blueprint target.
 * @param blueprint - current target projection and revision.
 * @param value - untrusted model Tool arguments.
 * @param ownership - source interaction that receives the accepted route.
 * @returns a typed route bound to the current preset and revision.
 */
export function createBlueprintCapabilityAuthoringRoute(
  blueprint: Blueprint,
  value: JsonValue,
  ownership: Pick<BlueprintCapabilityAuthoringRoute, 'sourceSessionId' | 'routeId'>,
): BlueprintCapabilityAuthoringRoute {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('blueprint capability routing: arguments must be an object')
  }
  const kind = value['kind']
  const request = value['request']
  const reason = value['reason']
  if (kind !== 'skill' && kind !== 'subagent') {
    throw new Error('blueprint capability routing: kind must be skill or subagent')
  }
  if (typeof request !== 'string' || request.trim() === '' || request.trim().length > 500
    || typeof reason !== 'string' || reason.trim() === '' || reason.trim().length > 500) {
    throw new Error('blueprint capability routing: request and reason must be concise non-empty text')
  }
  return {
    ...ownership,
    presetId: blueprint.preset.id,
    revision: blueprint.revision,
    request: request.trim(),
    kind,
    reason: reason.trim(),
  }
}

/**
 * Bind one model routing decision to the exact direct-user request.
 * @param input - original current human message and trusted operation provenance.
 * @param value - untrusted model arguments containing only a user-facing Draft name.
 * @param routeId - durable Tool call identity.
 * @returns a language-neutral create-agent route for the shared Creator executor.
 */
export function createBlueprintCreatorAuthoringRoute(
  input: BlueprintRoutingInput,
  value: JsonValue,
  routeId: string,
): BlueprintCreatorAuthoringRoute {
  assertBlueprintOperation(input, 'create-agent')
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('blueprint Creator routing: arguments must be an object')
  }
  const request = input.userRequest
  const name = value['name']
  const evidence = value['user_intent']
  if (typeof evidence !== 'string' || evidence.trim() === '' || !request.includes(evidence)) {
    throw new Error('blueprint-route-provenance-conflict: user_intent must quote the current original user request, not guidance or an assistant message')
  }
  if (request === '' || request.length > 2_000) {
    throw new Error('blueprint Creator routing: direct user request must be concise non-empty text')
  }
  if (typeof name !== 'string' || name.trim() === '' || name.trim().length > 100 || /[\r\n]/u.test(name)) {
    throw new Error('blueprint Creator routing: name must be one concise non-empty line')
  }
  const sourceLanguage = sourceLanguageFromText(request)
  return {
    operation: 'create-agent',
    routeId,
    request,
    name: name.trim(),
    ...(sourceLanguage === undefined ? {} : { sourceLanguage }),
  }
}

/** Parse the model-owned JSON array before typed Change Set validation. */
export function parseBlueprintChangeSetArgs(value: JsonValue): BlueprintChangeSetArgs {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('blueprint proposal: arguments must be an object')
  }
  const intent = value['intent']
  if (intent !== 'modify-existing-agent' && intent !== 'reconcile-direct-edit') {
    throw new Error('blueprint proposal: intent must be modify-existing-agent or reconcile-direct-edit')
  }
  const changes = value['changes']
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new Error('blueprint proposal: changes must be a non-empty array')
  }
  return {
    intent,
    changes: changes.map((candidate, index): BlueprintProposalArgs => {
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
        throw new Error(`blueprint proposal: changes[${String(index)}] must be an object`)
      }
      const operation = candidate['operation']
      if (operation !== 'updateIdentity' && operation !== 'updatePurpose' && operation !== 'updateBehavior'
        && operation !== 'setCapability' && operation !== 'updateOutput') {
        throw new Error(`blueprint proposal: changes[${String(index)}].operation is unsupported`)
      }
      const targetNodeId = candidate['target_node_id']
      const impact = candidate['impact']
      const dependency = candidate['dependency']
      if (typeof targetNodeId !== 'string' || typeof impact !== 'string'
        || (dependency !== undefined && typeof dependency !== 'string')) {
        throw new Error(`blueprint proposal: changes[${String(index)}] has incompatible text fields`)
      }
      const currentValue = candidate['current_value']
      const proposedValue = candidate['proposed_value']
      if (currentValue === undefined || proposedValue === undefined) {
        throw new Error(`blueprint proposal: changes[${String(index)}] must include current_value and proposed_value`)
      }
      return {
        target_node_id: targetNodeId,
        operation,
        current_value: currentValue,
        proposed_value: proposedValue,
        impact,
        ...(dependency === undefined ? {} : { dependency }),
      }
    }),
  }
}

/**
 * Conservative direct-user intent gate for proposal creation.
 * @param text - latest direct human message.
 * @returns whether the text clearly asks to modify the existing Agent.
 */
export function hasExplicitBlueprintModificationIntent(text: string): boolean {
  const normalized = text.trim()
  return normalized !== '' && !HYPOTHETICAL.test(normalized) && EXPLICIT_CHANGE.test(normalized)
}

function textValue(value: JsonValue, field: string): string {
  if (typeof value !== 'string' || value.trim() === '' || /[\r\n]/u.test(value)) {
    throw new Error(`blueprint proposal: ${field} must be one concise non-empty text value`)
  }
  return value.trim()
}

function booleanValue(value: JsonValue, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`blueprint proposal: ${field} must be boolean`)
  return value
}

function capabilityEnabled(node: BlueprintNode): boolean | undefined {
  if (typeof node.value !== 'object' || node.value === null || Array.isArray(node.value)) return undefined
  const enabled = (node.value as Record<string, unknown>)['enabled']
  return typeof enabled === 'boolean' ? enabled : undefined
}

function expectedNodeType(operation: BlueprintChangeOperation): BlueprintNode['type'] {
  switch (operation) {
    case 'updateIdentity': return 'identity'
    case 'updatePurpose': return 'purpose'
    case 'updateBehavior': return 'behavior'
    case 'setCapability': return 'capability'
    case 'updateOutput': return 'output'
  }
}

function structuredEditOperation(node: BlueprintNode): BlueprintChangeOperation {
  switch (node.type) {
    case 'identity': return 'updateIdentity'
    case 'purpose': return 'updatePurpose'
    case 'behavior': return 'updateBehavior'
    case 'output': return 'updateOutput'
    case 'capability':
      if (node.id !== 'capability:web-search' && node.id !== 'capability:web-fetch') {
        throw new Error(`blueprint structured edit: capability ${JSON.stringify(node.id)} has no independent write-back`)
      }
      return 'setCapability'
    case 'access': throw new Error('blueprint structured edit: access nodes are read-only')
  }
}

function scalarValues(node: BlueprintNode, args: BlueprintProposalArgs): {
  current: BlueprintProposalValue
  proposed: BlueprintProposalValue
} {
  if (args.operation === 'setCapability') {
    if (node.id !== 'capability:web-search' && node.id !== 'capability:web-fetch') {
      throw new Error(`blueprint proposal: capability ${JSON.stringify(node.id)} has no independent write-back`)
    }
    const actual = capabilityEnabled(node)
    if (actual === undefined) throw new Error(`blueprint proposal: capability ${JSON.stringify(node.id)} has no boolean state`)
    const current = booleanValue(args.current_value, 'current_value')
    const proposed = booleanValue(args.proposed_value, 'proposed_value')
    if (current !== actual) throw new Error('blueprint proposal: current_value does not match the projected capability')
    return { current, proposed }
  }
  if (typeof node.value !== 'string') throw new Error(`blueprint proposal: node ${JSON.stringify(node.id)} has no text value`)
  const current = textValue(args.current_value, 'current_value')
  const proposed = textValue(args.proposed_value, 'proposed_value')
  if (current !== node.value) throw new Error('blueprint proposal: current_value does not match the projected text')
  return { current, proposed }
}

/**
 * Validate one model-generated preview against the freshly read Blueprint.
 * @param blueprint - authoritative current projection.
 * @param args - typed model arguments.
 * @param proposalId - durable Tool call identity.
 * @param directUserText - latest direct human message.
 * @param selectedNodeId - optional UI-selected context node.
 * @param typedIntent - language-neutral decision already validated by the Proposal Tool.
 * @returns a typed proposal that still performs no mutation.
 */
export function createBlueprintChangeProposal(
  blueprint: Blueprint,
  args: BlueprintProposalArgs,
  proposalId: string,
  directUserText: string,
  selectedNodeId?: string,
  typedIntent?: 'modify-existing-agent',
): BlueprintChangeProposal {
  if (typedIntent === undefined && !hasExplicitBlueprintModificationIntent(directUserText)) {
    throw new Error('blueprint proposal: the latest user message does not contain an explicit modification request')
  }
  if (selectedNodeId !== undefined && args.target_node_id !== selectedNodeId
    && DEICTIC_TARGET.test(directUserText) && !NAMED_TARGET.test(directUserText)) {
    throw new Error('blueprint proposal: the deictic request must target the selected Blueprint node')
  }
  return validatedProposal(blueprint, args, proposalId)
}

/**
 * Validate one direct conversation request as a single-item Change Set.
 * @param blueprint - authoritative current projection.
 * @param args - typed model arguments containing exactly one change.
 * @param changeSetId - durable Tool call identity.
 * @param directUserText - latest direct human message.
 * @param selectedNodeId - optional UI-selected context node.
 * @param ownership - source interaction that owns the preview.
 * @returns a grouped preview that still performs no mutation.
 */
export function createBlueprintChangeSet(
  blueprint: Blueprint,
  args: BlueprintChangeSetArgs,
  changeSetId: string,
  directUserText: string,
  selectedNodeId: string | undefined,
  ownership: Pick<BlueprintChangeSet, 'sourceSessionId' | 'routeId'>,
): BlueprintChangeSet {
  if (args.intent !== 'modify-existing-agent') {
    throw new Error('blueprint proposal: a direct user request requires modify-existing-agent intent')
  }
  if (args.changes.length !== 1) {
    throw new Error('blueprint proposal: one direct user request must produce exactly one change')
  }
  const [firstChange] = args.changes
  if (firstChange === undefined) throw new Error('blueprint proposal: change is required')
  const proposal = createBlueprintChangeProposal(
    blueprint,
    firstChange,
    changeSetId,
    directUserText,
    selectedNodeId,
    args.intent,
  )
  return {
    ...ownership,
    changeSetId,
    kind: 'direct-request',
    presetId: blueprint.preset.id,
    revision: blueprint.revision,
    proposals: [proposal],
  }
}

/**
 * Validate a structured editor submission and its P2-bounded dependent changes as one staged Change Set.
 * @param blueprint - authoritative committed projection.
 * @param args - model proposals with the exact source edit first.
 * @param changeSetId - durable Tool call identity.
 * @param input - current routing input containing the Host-validated structured edit.
 * @param ownership - source interaction that owns the preview.
 * @returns an atomic preview that performs no preset write.
 */
export function createBlueprintStructuredEditChangeSet(
  blueprint: Blueprint,
  args: BlueprintChangeSetArgs,
  changeSetId: string,
  input: BlueprintRoutingInput,
  ownership: Pick<BlueprintChangeSet, 'sourceSessionId' | 'routeId'>,
): BlueprintChangeSet {
  const edit = input.directEdit
  if (input.provenance !== 'direct-edit' || edit === undefined || args.intent !== 'modify-existing-agent') {
    throw new Error('blueprint structured edit: this Change Set requires the current direct-edit interaction')
  }
  const [source, ...dependent] = args.changes
  if (source === undefined || source.target_node_id !== edit.nodeId || source.operation !== edit.operation
    || source.current_value !== edit.currentValue || source.proposed_value !== edit.proposedValue
    || source.dependency !== undefined) {
    throw new Error('blueprint structured edit: the first change must exactly match the submitted semantic edit')
  }
  const proposals = [validatedProposal(blueprint, source, `${changeSetId}:1`)]
  const candidateIds = new Set(edit.impactCandidates.map(candidate => candidate.nodeId))
  const targets = new Set([edit.nodeId])
  for (const [index, candidate] of dependent.entries()) {
    if (targets.has(candidate.target_node_id)) {
      throw new Error(`blueprint structured edit: duplicate target node ${JSON.stringify(candidate.target_node_id)}`)
    }
    if (!candidateIds.has(candidate.target_node_id)) {
      throw new Error(`blueprint structured edit: target node ${JSON.stringify(candidate.target_node_id)} is outside the deterministic impact candidate set`)
    }
    targets.add(candidate.target_node_id)
    proposals.push(validatedProposal(blueprint, {
      ...candidate,
      dependency: consistencyDependency(candidate.dependency),
    }, `${changeSetId}:${String(index + 2)}`))
  }
  return {
    ...ownership,
    changeSetId,
    kind: 'structured-edit',
    presetId: blueprint.preset.id,
    revision: blueprint.revision,
    sourceNodeId: edit.nodeId,
    sourceNodeType: edit.nodeType,
    sourceLabel: edit.label,
    proposals,
  }
}

/**
 * Validate one consistency Change Set authorized by the direct-edit notice in the current turn.
 * @param blueprint - authoritative current projection.
 * @param args - typed model arguments for every causally related node.
 * @param changeSetId - durable Tool call identity.
 * @param change - committed direct edit that triggered reconciliation.
 * @param ownership - source interaction that owns the preview.
 * @returns a typed grouped preview for different nodes; it still performs no mutation.
 */
export function createBlueprintReconciliationChangeSet(
  blueprint: Blueprint,
  args: BlueprintChangeSetArgs,
  changeSetId: string,
  change: BlueprintUserChange,
  ownership: Pick<BlueprintChangeSet, 'sourceSessionId' | 'routeId'>,
): BlueprintChangeSet {
  if (args.intent !== 'reconcile-direct-edit') {
    throw new Error('blueprint reconciliation: a direct edit requires reconcile-direct-edit intent')
  }
  if (change.presetId !== blueprint.preset.id) {
    throw new Error('blueprint reconciliation: the direct edit targets a different preset')
  }
  if (args.changes.length === 0) {
    throw new Error('blueprint reconciliation: a Change Set must contain at least one related change')
  }
  const candidateIds = new Set(change.impactCandidates.map(candidate => candidate.nodeId))
  const targets = new Set<string>()
  const proposals = args.changes.map((candidate, index) => {
    if (candidate.target_node_id === change.nodeId) {
      throw new Error('blueprint reconciliation: do not propose the direct edit that already succeeded')
    }
    if (targets.has(candidate.target_node_id)) {
      throw new Error(`blueprint reconciliation: duplicate target node ${JSON.stringify(candidate.target_node_id)}`)
    }
    if (!candidateIds.has(candidate.target_node_id)) {
      throw new Error(`blueprint reconciliation: target node ${JSON.stringify(candidate.target_node_id)} is outside the deterministic impact candidate set`)
    }
    targets.add(candidate.target_node_id)
    const dependency = consistencyDependency(candidate.dependency)
    return validatedProposal(blueprint, { ...candidate, dependency }, `${changeSetId}:${String(index + 1)}`)
  })
  return {
    ...ownership,
    changeSetId,
    kind: 'direct-edit-reconciliation',
    presetId: blueprint.preset.id,
    revision: blueprint.revision,
    sourceNodeId: change.nodeId,
    sourceNodeType: change.nodeType,
    sourceLabel: change.label,
    proposals,
  }
}

/**
 * Derive the only Apply batch authorized by one durable Change Set.
 * @param changeSet - durable Proposal content whose scalar operations are authoritative.
 * @returns the canonical transaction operations in Proposal order.
 */
export function blueprintChangeSetOperations(changeSet: BlueprintChangeSet): BlueprintChangeSetOperation[] {
  return changeSet.proposals.map((proposal): BlueprintChangeSetOperation => {
    if (proposal.presetId !== changeSet.presetId || proposal.revision !== changeSet.revision) {
      throw new Error('blueprint proposal authority: proposal target or revision differs from its Change Set')
    }
    if (proposal.operation === 'setCapability') {
      if ((proposal.targetNodeId !== 'capability:web-search' && proposal.targetNodeId !== 'capability:web-fetch')
        || typeof proposal.currentValue !== 'boolean' || typeof proposal.proposedValue !== 'boolean') {
        throw new Error('blueprint proposal authority: capability proposal is not a typed Web transition')
      }
      return {
        operation: 'setCapability',
        targetNodeId: proposal.targetNodeId,
        capability: proposal.targetNodeId === 'capability:web-search' ? 'web-search' : 'web-fetch',
        expected: proposal.currentValue,
        enabled: proposal.proposedValue,
      }
    }
    if (typeof proposal.currentValue !== 'string' || typeof proposal.proposedValue !== 'string') {
      throw new Error('blueprint proposal authority: text proposal does not carry text scalars')
    }
    return {
      operation: proposal.operation,
      targetNodeId: proposal.targetNodeId,
      expected: proposal.currentValue,
      value: proposal.proposedValue,
    }
  })
}

/**
 * Compare two ordered Apply batches by their typed fields.
 * @param left - operation batch received across a transport or read from an event.
 * @param right - canonical operation batch derived from durable Proposal metadata.
 * @returns whether both batches contain the same discriminants and scalar fields in the same array order.
 */
export function sameBlueprintChangeSetOperations(
  left: readonly BlueprintChangeSetOperation[],
  right: readonly BlueprintChangeSetOperation[],
): boolean {
  if (left.length !== right.length) return false
  return left.every((operation, index) => {
    const expected = right[index]
    if (expected === undefined || operation.operation !== expected.operation
      || operation.targetNodeId !== expected.targetNodeId) return false
    if (operation.operation === 'setCapability') {
      return expected.operation === 'setCapability'
        && operation.capability === expected.capability
        && operation.expected === expected.expected
        && operation.enabled === expected.enabled
    }
    return expected.operation !== 'setCapability'
      && operation.expected === expected.expected
      && operation.value === expected.value
  })
}

/** Require an explicit, user-readable causal link for every reconciliation item. */
function consistencyDependency(value: string | undefined): string {
  const dependency = value?.trim() ?? ''
  if (dependency === '' || dependency.length > 240 || /[\r\n]/u.test(dependency)) {
    throw new Error('blueprint reconciliation: dependency must be one non-empty line of at most 240 characters')
  }
  return dependency
}

/** Validate operation, target, current value, replacement, and impact independently of intent source. */
function validatedProposal(
  blueprint: Blueprint,
  args: BlueprintProposalArgs,
  proposalId: string,
): BlueprintChangeProposal {
  const node = blueprint.nodes.find(candidate => candidate.id === args.target_node_id)
  if (node === undefined) throw new Error('这项内容不在当前可调整的 Agent 结构中。')
  if (!node.editable) {
    if (node.type === 'identity') {
      throw new Error('这个角色目前只能查看，你仍然可以选中它继续和用户讨论。')
    }
    throw new Error('这项内容目前不能直接编辑，你仍然可以选中它继续和用户讨论。')
  }
  if (node.type !== expectedNodeType(args.operation)) {
    throw new Error(`blueprint proposal: operation ${args.operation} does not match node type ${node.type}`)
  }
  const { current, proposed } = scalarValues(node, args)
  if (current === proposed) throw new Error('blueprint proposal: proposed_value must differ from current_value')
  const impact = args.impact.trim()
  if (impact === '' || impact.length > 240 || /[\r\n]/u.test(impact)) {
    throw new Error('blueprint proposal: impact must be one non-empty line of at most 240 characters')
  }
  return {
    proposalId,
    presetId: blueprint.preset.id,
    revision: blueprint.revision,
    targetNodeId: node.id,
    operation: args.operation,
    currentValue: current,
    proposedValue: proposed,
    impact,
    ...(args.dependency === undefined ? {} : { dependency: args.dependency }),
  }
}

/**
 * Human-readable label shared by Creator selection and direct-edit events.
 * @param node - projected node whose adapter details must remain hidden.
 * @returns stable product label for conversation context.
 */
export function blueprintNodeLabel(node: BlueprintNode): string {
  if (node.type === 'identity') return '角色'
  if (node.type === 'purpose') return 'Purpose'
  if (node.type === 'behavior') return 'Behavior'
  if (node.type === 'output') return 'Output'
  if (node.id === 'capability:web-search') return 'Web Search'
  if (node.id === 'capability:web-fetch') return 'Web Fetch'
  if (node.id === 'capability:file-read') return 'File Read'
  return node.type === 'capability' ? 'Capability' : node.type
}

/**
 * Derive the durable event from a fresh projection and minimal browser evidence.
 * @param blueprint - fresh projection after the direct write.
 * @param input - edited node and its previous scalar value.
 * @returns a semantic event with Host-derived current value, type, label, and operation.
 */
export function createBlueprintUserChange(
  blueprint: Blueprint,
  input: BlueprintUserChangeInput,
): BlueprintUserChange {
  const node = blueprint.nodes.find(candidate => candidate.id === input.nodeId)
  if (node === undefined) throw new Error('这项内容已不在当前 Agent 结构中，请刷新后重试。')
  if (!node.editable) throw new Error('这项内容目前只能查看，你仍然可以选中它继续讨论。')
  const currentValue = node.type === 'capability' ? capabilityEnabled(node) : node.value
  if (typeof currentValue !== 'string' && typeof currentValue !== 'boolean') {
    throw new Error(`blueprint user change: node ${JSON.stringify(input.nodeId)} has no editable scalar`)
  }
  if (typeof input.previousValue !== typeof currentValue) {
    throw new Error('blueprint user change: previous value has an incompatible type')
  }
  if (input.previousValue === currentValue) {
    throw new Error('blueprint user change: fresh projection did not change the target value')
  }
  const operation: BlueprintUserChangeOperation = typeof currentValue === 'boolean'
    ? currentValue ? 'enable' : 'disable'
    : 'update'
  const change = {
    presetId: blueprint.preset.id,
    nodeId: node.id,
    nodeType: node.type,
    label: blueprintNodeLabel(node),
    previousValue: input.previousValue,
    currentValue,
    operation,
  }
  return {
    ...change,
    impactCandidates: discoverBlueprintImpactCandidates(blueprint, change),
  }
}

/**
 * Build the plugin-authored follow-up that wakes consistency reconciliation.
 * @param change - committed direct edit already recorded in the Session log.
 * @returns model-facing semantic notice with no preset implementation fields.
 */
export function blueprintUserChangeMessage(change: BlueprintUserChange): UserMessage {
  const semanticChange = {
    presetId: change.presetId,
    nodeId: change.nodeId,
    nodeType: change.nodeType,
    label: change.label,
    previousValue: change.previousValue,
    currentValue: change.currentValue,
    operation: change.operation,
    impactCandidates: change.impactCandidates,
  }
  const text = [
    'The user has just completed this direct Blueprint edit:',
    JSON.stringify(semanticChange),
    'The edit already succeeded and the current Blueprint projection includes it. Do not ask whether the user intended it, do not propose the same node again, and do not change any other node automatically.',
    'The Host has deterministically bounded reconciliation to impactCandidates. A tool-reference is a hard literal dependency. removed-literal, purpose-child, and identity-peer evidence only admit a node for semantic review; they do not prove a conflict.',
    'Judge only those candidate node ids. Do not propose any node outside impactCandidates, even if another node in the full Blueprint appears improvable. If the candidate list is empty or none truly conflicts, confirm briefly that no other configuration is affected.',
    `If a candidate clearly conflicts, explain it briefly and call ${BLUEPRINT_PROPOSAL_TOOL} once with only the conflicting candidate changes in one Change Set. For each item, dependency must name the exact inconsistency caused by this edit. The whole set remains a preview until the user clicks Apply all.`,
  ].join('\n')
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin', plugin: 'blueprint-adapter', form: 'notice',
      summary: BLUEPRINT_USER_CHANGE_NOTICE,
    },
  })
}

/**
 * Resolve the direct edit that authorized the current model turn, if any.
 * @param agent - live Agent executing the proposal Tool.
 * @returns the event immediately preceding this turn's Blueprint notice.
 */
export function blueprintUserChangeForCurrentTurn(agent: Agent): BlueprintUserChange | undefined {
  const turnStart = agent.session.events.findLast(event => event.type === 'turn/start')
  if (turnStart === undefined) return undefined
  const notice = agent.session.events.findLast(event => event.type === 'user/message'
    && event.seq > turnStart.seq
    && event.data.source.kind === 'plugin'
    && event.data.source.plugin === 'blueprint-adapter'
    && event.data.source.form === 'notice'
    && event.data.source.summary === BLUEPRINT_USER_CHANGE_NOTICE)
  if (notice?.type !== 'user/message') return undefined
  const change = agent.session.events.findLast(event => event.type === 'blueprint/user-change'
    && event.seq < notice.seq)
  return change?.type === 'blueprint/user-change' ? change.data : undefined
}

/** Prompt-only guidance used while Creator owns the Session lifecycle. */
export function creatorAuthoringGuidance(
  draft: NonNullable<import('./types.ts').BlueprintConversationContextRequest['creatorDraft']>,
  selectedNode?: import('./types.ts').BlueprintNode,
  typed?: BlueprintCreatorAuthoringEvent,
): string {
  const target = draft.targetPresetId === undefined ? [] : [`Associated target preset: ${draft.targetPresetId}.`]
  const selected = selectedNode === undefined
    ? []
    : [
      `Selected Creator Draft node: ${JSON.stringify({
        id: selectedNode.id,
        type: selectedNode.type,
        label: blueprintNodeLabel(selectedNode),
        value: selectedNode.value,
      })}. Selection is context, not mode.`,
      'Answer discussion, explanation, judgment, comparison, and hypothetical questions normally without changing the preset.',
      'When the user explicitly requests an adjustment, treat it as Creator steering for the associated target preset and continue the current authoring workflow. Do not use an existing-Agent proposal or direct Blueprint Host write.',
    ]
  return [
    'Interactive Blueprint Creator authoring context.',
    `Draft Agent: ${draft.name}. Coordinator status: ${draft.status}.`,
    ...(typed === undefined ? [] : [
      'Operation: create-agent.',
      `Original user request: ${typed.request}`,
      `Source language metadata: ${typed.sourceLanguage ?? 'undetermined'}.`,
      'Preserve the primary natural language of the original request in the user-facing Identity, Purpose, Behavior, Output, preset name, and description. When source language metadata is undetermined, infer it from the original request without defaulting to English.',
      'Execute real preset authoring. Do not stop after describing a design or acknowledging this route.',
      'Use the built-in preset_list, preset_read, preset_resolve, preset_copy, and preset_validate authoring Tools directly. Do not search for their implementation or create a temporary probe.',
    ]),
    ...target,
    ...selected,
    'Continue the Creator workflow for a new Agent: clarify requirements, author a new preset, and validate that preset through the normal mount path.',
    'Do not reinterpret this task as changing the existing preset. The previous Blueprint has been cleared and provides no editable target.',
    'Structured answers returned by ask_user_question are normal Creator authoring input. They do not need a separate direct-user modification instruction.',
    `Do not call ${BLUEPRINT_PROPOSAL_TOOL} while Creator authoring is in progress.`,
    'Do not claim completion until a real new preset exists and passes normal mount validation.',
  ].join('\n')
}

/**
 * Prompt-only guidance for Creator authoring against one explicitly bound existing preset.
 * @param context - target, request, and required authoring mechanism.
 * @returns bounded model guidance for the existing-target authoring task.
 */
export function capabilityAuthoringGuidance(
  context: NonNullable<import('./types.ts').BlueprintConversationContextRequest['capabilityAuthoring']>,
): string {
  const skill = context.kind !== 'skill' ? [] : [
    'Operation: add exactly one target-owned filesystem Skill definition to the existing target preset. This is not Create Agent.',
    'Place the Skill in the target preset\'s own skills/ directory. If the baseline already has a top-level @deepseek-ai/dsh-skill-filesystem row, preserve its provider, defaults, and existing roots and append the path rooted from baseUrl to customSkillDirs. Otherwise add one row configured with includeDefaultRoots: false and customSkillDirs containing only that preset-local path, so the new provider does not import ambient project or user Skills.',
    'Keep @deepseek-ai/dsh-tool-skill active so the target Agent can discover and load the mounted Skill.',
    'The mounted catalog delta must contain exactly one new target-owned, model-invocable Skill and no new delegation. Preserve every baseline Skill and delegation exactly.',
    'File existence and Creator prose are not completion evidence. The coordinator performs independent mounted-catalog verification after this turn; do not bypass or approximate that verification.',
  ]
  const subagent = context.kind !== 'subagent' ? [] : [
    'Operation: add one Subagent delegation specification to the existing target composition. This is not Create Agent.',
    'Do not call preset_copy, do not create a top-level preset, and do not change the target preset id.',
    'Add one uniquely identified top-level @deepseek-ai/dsh-tool-subagent row. Use only supported config fields: provider, toolName, enableRunInBackground, backgroundMode, agentOptions, persona, toolFilter, and maxDepth.',
    'Give the row and tool stable unique ids. Start persona with the exact user-facing collaborator name ending in 协作者 or Collaborating Agent, then state responsibilities and explicit exclusions.',
    'For one child level, use maxDepth: 1 or omit maxDepth. maxDepth: 0 disables the first delegation call; use toolFilter to withhold delegation Tools from the child instead.',
    'Author only the delegation row in this Creator Session. Do not edit Identity, Purpose, Behavior, Output, or any persona/report text, including after preset_validate succeeds.',
    'preset_validate proves mountability, not runtime conformance. End this Creator task after the delegation row mounts; the coordinator performs P1 in a new Session, and any related Blueprint text must use the later existing-Agent Proposal path.',
    'Use an already registered provider and a mode that provider supports. A described specification without a real composition row is failure, not completion.',
  ]
  return [
    'Interactive Blueprint capability authoring context for an existing Agent.',
    `Target preset: ${context.targetPresetId}. Required mechanism: ${context.kind}.`,
    `User capability outcome: ${context.request}.`,
    'Edit only this target preset through the normal Creator authoring mechanisms. Do not create or associate a different Agent preset.',
    'Inspect the target before changing it, preserve unrelated composition and persona content, and use the smallest real Skill or Subagent change that implements the outcome.',
    ...skill,
    ...subagent,
    'Validate the target through preset_validate after every settled authoring change. Do not claim success until the target mounts normally.',
    `Do not call ${BLUEPRINT_PROPOSAL_TOOL}; the existing-Agent conversation already determined that typed Blueprint writes are insufficient.`,
  ].join('\n')
}

/**
 * Model guidance for discussion-first, explicit-intent-only proposal generation.
 * @param blueprint - current real preset projection.
 * @param selectedNodeId - optional node selected as conversation context.
 * @returns model-visible guidance and semantic node snapshot.
 */
export function blueprintConversationGuidance(blueprint: Blueprint, selectedNodeId?: string): string {
  const nodes = blueprint.nodes.map(node => ({
    id: node.id,
    type: node.type,
    value: node.value,
    status: node.status,
    editable: node.editable,
  }))
  return [
    'Interactive Blueprint conversation context.',
    `Target preset: ${blueprint.preset.id}. Projection revision: ${blueprint.revision}.`,
    `Selected node: ${selectedNodeId ?? '(none)'}. Selection is context, not mode.`,
    `Current nodes: ${JSON.stringify(nodes)}.`,
    'Answer discussion, explanation, judgment, comparison, and hypothetical questions normally. Do not create a Change Proposal for those requests.',
    `When the user explicitly requests a distinct new Agent, call ${BLUEPRINT_CREATOR_AUTHORING_TOOL}. This typed route preserves the exact request and continues through the Creator lifecycle; do not use capability authoring or an existing-Agent proposal for that request.`,
    `When a requested capability can be implemented by the editable Identity, Purpose, Behavior, Output, Web Search, or Web Fetch nodes already present, keep this as an existing-Agent change and call ${BLUEPRINT_PROPOSAL_TOOL}. Do not enter Creator authoring merely because the request came from Add capability.`,
    `An explicit request to create, add, or mount a Skill or Subagent specifies the required mechanism. Call ${BLUEPRINT_CAPABILITY_AUTHORING_TOOL}; never replace that requested object with approximate Identity, Purpose, Behavior, or Output text merely because existing tools could perform a similar outcome.`,
    `Call ${BLUEPRINT_CAPABILITY_AUTHORING_TOOL} only when the outcome genuinely requires a new Skill definition or Subagent configuration that the supported Blueprint operations cannot express. State the required mechanism and why the existing structure is insufficient. The Host binds the route to this preset and revision; the Tool does not write anything.`,
    `Call ${BLUEPRINT_PROPOSAL_TOOL} when the user explicitly asks to change the existing Agent or when a Blueprint direct-edit notice identifies a clear consistency conflict inside its deterministic impactCandidates. Pass intent=modify-existing-agent for the former and intent=reconcile-direct-edit for the latter, plus changes as an array. A direct conversation request must contain exactly one item; a direct-edit reconciliation may group multiple candidate items. The typed intent is language-neutral. The Tool creates a preview only; it never applies a change.`,
    'Allowed operations are updateIdentity for an editable Identity node, updatePurpose, updateBehavior, setCapability for capability:web-search or capability:web-fetch, and updateOutput for an editable Output node.',
    'Never propose YAML, a composition patch, File Read or Shell Background changes, a new node, or a write to a node whose editable value is false.',
    'If the user explicitly requests an unsupported or read-only change, explain that it is unavailable and do not call the proposal Tool.',
    'When no node is selected, resolve the request against the current nodes. For output requests, prefer the editable node that owns the concrete delivery format.',
    'Preserve existing requirements when the user asks to add something. current_value must exactly equal the current projected scalar. Keep impact short and user-facing. Reconciliation items also require one short dependency that identifies the exact conflict caused by the committed direct edit.',
    'After creating a proposal or Change Set, state that it is waiting for explicit user confirmation. Never claim that the preset changed before Apply succeeds.',
    'Use natural product labels in every reply. Never expose internal node ids, adapter addresses, physical-line details, or anchor terminology to the user.',
  ].join('\n')
}
