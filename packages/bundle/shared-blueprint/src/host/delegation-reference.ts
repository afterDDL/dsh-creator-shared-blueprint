/** Validation for semantic references to configured delegation capabilities. */

import type { Blueprint, BlueprintChangeSetOperation } from '../contract/types.ts'

const COLLABORATOR_REFERENCE = /(?:协作者|协作\s*Agent|子\s*Agent|\bcollaborator\b|\bsubagent\b)/iu

function delegationLabel(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  if (candidate['kind'] !== 'delegation' || candidate['enabled'] !== true
    || candidate['providerAvailable'] !== true) return undefined
  const responsibility = candidate['responsibility']
  if (typeof responsibility !== 'string') return undefined
  const firstClause = responsibility.trim().split(/[：:，,。；;\n]/u, 1)[0]?.trim()
  if (firstClause === undefined) return undefined
  const label = firstClause
    .replace(/^(?:你是|You are (?:an? )?)/iu, '')
    .replace(/[（(][^）)]*[）)]$/u, '')
    .replace(/^[「“"]|[」”"]$/gu, '')
    .trim()
  return COLLABORATOR_REFERENCE.test(label) ? label : undefined
}

/**
 * Reject text that names a collaborator absent from the mounted, provider-backed projection.
 * @param blueprint - current authoritative preset projection.
 * @param value - proposed Identity, Purpose, Behavior, or Output text.
 */
export function assertMountedDelegationReference(blueprint: Blueprint, value: string): void {
  if (!COLLABORATOR_REFERENCE.test(value)) return
  const labels = blueprint.nodes.flatMap((node) => {
    if (node.type !== 'capability' || node.status !== 'active') return []
    const label = delegationLabel(node.value)
    return label === undefined ? [] : [label]
  })
  if (labels.some(label => value.includes(label))) return
  throw new Error(
    'blueprint delegation reference: text names a collaborator that is not mounted with an available provider',
  )
}

/**
 * Validate every textual operation before a transactional preset write.
 * @param blueprint - current authoritative preset projection.
 * @param operations - closed typed Change Set operations.
 */
export function assertMountedDelegationReferences(
  blueprint: Blueprint,
  operations: readonly BlueprintChangeSetOperation[],
): void {
  for (const operation of operations) {
    if (operation.operation === 'setCapability') continue
    assertMountedDelegationReference(blueprint, operation.value)
  }
}
