/** Shared pure transforms for single-node and transactional Blueprint writes. */

import type { BlueprintChangeSetOperation, BlueprintNodeType, BlueprintProposalValue } from '../contract/types.ts'
import {
  configuredBoolean,
  hasUniqueTrimmedLine,
  parseComposition,
  personaText,
  projectPersona,
  replaceBooleanConfig,
  replaceUniqueTrimmedLine,
} from './composition.ts'

const OUTPUT_ITEM = /^(?:输出|交付形式|deliverable|output(?:\s+format)?)(?:\s|[：:])/iu

/** Whether one numbered persona item is explicitly labeled as Output. */
export function isOutputItem(text: string): boolean {
  return OUTPUT_ITEM.test(text)
}

/** Semantic node type admitted by one typed transaction operation. */
export function operationNodeType(operation: BlueprintChangeSetOperation): Exclude<BlueprintNodeType, 'access'> {
  switch (operation.operation) {
    case 'updateIdentity': return 'identity'
    case 'updatePurpose': return 'purpose'
    case 'updateBehavior': return 'behavior'
    case 'updateOutput': return 'output'
    case 'setCapability': return 'capability'
  }
}

/** Scalar value an operation requires before staging. */
export function operationExpected(operation: BlueprintChangeSetOperation): BlueprintProposalValue {
  return operation.expected
}

/** Scalar value an operation requires after staging. */
export function operationProposed(operation: BlueprintChangeSetOperation): BlueprintProposalValue {
  return operation.operation === 'setCapability' ? operation.enabled : operation.value
}

/** Exact adapter-owned physical reference admitted by one operation. */
export function operationAdapterRef(operation: BlueprintChangeSetOperation): string {
  switch (operation.operation) {
    case 'updateIdentity': return 'preset:persona.config.text#identity'
    case 'updatePurpose': return 'preset:persona.config.text#purpose'
    case 'updateBehavior': {
      const ordinal = operationOrdinal(operation.targetNodeId, 'behavior')
      return `preset:persona.config.text#behavior:${String(ordinal)}`
    }
    case 'updateOutput': {
      const ordinal = operationOrdinal(operation.targetNodeId, 'output')
      return `preset:persona.config.text#output:${String(ordinal)}`
    }
    case 'setCapability': {
      const field = operation.capability === 'web-search' ? 'search' : 'fetch'
      return `preset:tool-web.config.${field}`
    }
  }
}

/** Apply one already typed operation to an in-memory composition without publishing it. */
export function applyBlueprintOperation(
  composition: string,
  operation: BlueprintChangeSetOperation,
): string {
  const persona = projectPersona(personaText(parseComposition(composition)))
  switch (operation.operation) {
    case 'updateIdentity': {
      if (operation.targetNodeId !== 'identity:persona') {
        throw new Error('blueprint-adapter: Identity update requires the projected Identity node')
      }
      if (operation.value.trim() === '' || operation.value !== operation.value.trim()
        || /[\r\n]/u.test(operation.value)) {
        throw new Error('blueprint-adapter: Identity must be one non-empty role name without surrounding whitespace')
      }
      if (persona.identity?.semanticValue !== operation.expected
        || !persona.identity.editable
        || persona.identity.writebackMethod !== 'replace-role-span'
        || persona.identity.prefix === undefined
        || persona.identity.suffix === undefined
        || !hasUniqueTrimmedLine(composition, persona.identity.sourceValue)) {
        throw new Error('blueprint-adapter: Identity changed or has no unique safe role slot')
      }
      return replaceUniqueTrimmedLine(
        composition,
        persona.identity.sourceValue,
        `${persona.identity.prefix}${operation.value}${persona.identity.suffix}`,
      )
    }
    case 'updatePurpose': {
      if (operation.targetNodeId !== 'purpose:persona') {
        throw new Error('blueprint-adapter: Purpose update requires the projected Purpose node')
      }
      if (persona.purpose?.semanticValue !== operation.expected
        || !persona.purpose.editable
        || persona.purpose.writebackMethod !== 'replace-purpose-span'
        || persona.purpose.prefix === undefined
        || persona.purpose.suffix === undefined
        || !hasUniqueTrimmedLine(composition, persona.purpose.sourceValue)) {
        throw new Error('blueprint-adapter: Purpose changed or has no unique safe task slot')
      }
      return replaceUniqueTrimmedLine(
        composition,
        persona.purpose.sourceValue,
        `${persona.purpose.prefix}${operation.value}${persona.purpose.suffix}`,
      )
    }
    case 'updateBehavior': {
      const ordinal = operationOrdinal(operation.targetNodeId, 'behavior')
      const item = persona.items.find(candidate => candidate.ordinal === ordinal)
      if (item === undefined || item.text !== operation.expected || isOutputItem(item.text)) {
        throw new Error(`blueprint-adapter: Behavior ${String(ordinal)} changed, is missing, or is classified as Output`)
      }
      return replaceUniqueTrimmedLine(composition, item.paragraph, `${String(ordinal)}. ${operation.value}`)
    }
    case 'updateOutput': {
      const ordinal = operationOrdinal(operation.targetNodeId, 'output')
      const item = persona.items.find(candidate => candidate.ordinal === ordinal)
      if (item === undefined || item.text !== operation.expected || !isOutputItem(item.text)) {
        throw new Error(`blueprint-adapter: Output ${String(ordinal)} changed, is missing, or has no safe inferred anchor`)
      }
      return replaceUniqueTrimmedLine(composition, item.paragraph, `${String(ordinal)}. ${operation.value}`)
    }
    case 'setCapability': {
      const expectedNodeId = `capability:${operation.capability}`
      if (operation.targetNodeId !== expectedNodeId) {
        throw new Error('blueprint-adapter: capability operation does not match its projected node')
      }
      const field = operation.capability === 'web-search' ? 'search' : 'fetch'
      const configured = configuredBoolean(parseComposition(composition), 'tool-web', field, true)
      if (configured === undefined) throw new Error('blueprint-adapter: preset has no tool-web row')
      return replaceBooleanConfig(composition, 'tool-web', field, operation.expected, operation.enabled, true)
    }
  }
}

/** Read one operation's scalar from staged composition semantics. */
export function stagedOperationValue(
  composition: string,
  operation: BlueprintChangeSetOperation,
): BlueprintProposalValue | undefined {
  const rows = parseComposition(composition)
  const persona = projectPersona(personaText(rows))
  switch (operation.operation) {
    case 'updateIdentity': return persona.identity?.semanticValue
    case 'updatePurpose': return persona.purpose?.semanticValue
    case 'updateBehavior': {
      const item = persona.items.find(candidate =>
        candidate.ordinal === operationOrdinal(operation.targetNodeId, 'behavior'))
      return item === undefined || isOutputItem(item.text) ? undefined : item.text
    }
    case 'updateOutput': {
      const item = persona.items.find(candidate =>
        candidate.ordinal === operationOrdinal(operation.targetNodeId, 'output'))
      return item !== undefined && isOutputItem(item.text) ? item.text : undefined
    }
    case 'setCapability': {
      const field = operation.capability === 'web-search' ? 'search' : 'fetch'
      return configuredBoolean(rows, 'tool-web', field, true)
    }
  }
}

function operationOrdinal(nodeId: string, type: 'behavior' | 'output'): number {
  const match = new RegExp(`^${type}:(\\d+)$`, 'u').exec(nodeId)
  const ordinal = Number(match?.[1])
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    throw new Error(`blueprint-adapter: ${type} operation has an invalid target node`)
  }
  return ordinal
}
