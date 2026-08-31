/** Proposal history is resolved from Host outcomes before checking present-day applicability. */
import type {
  BlueprintApplyReceipt, BlueprintChangeSet, BlueprintProposalCancellation,
} from '@deepseek-ai/dsh-shared-blueprint/contract'
import type { BlueprintUiState } from './controller.ts'

/** User-visible state of one confirmed or still-pending proposal card. */
export type BlueprintProposalStatus = 'applied' | 'pending' | 'stale' | 'canceled' | 'failed' | 'rejected' | 'locked' | 'loading'

function matches(receipt: BlueprintApplyReceipt, changeSet: BlueprintChangeSet): boolean {
  const result = receipt.result
  return receipt.sourceSessionId === changeSet.sourceSessionId && receipt.routeId === changeSet.routeId
    && receipt.presetId === changeSet.presetId && result.sourceSessionId === changeSet.sourceSessionId
    && result.routeId === changeSet.routeId && result.changeSetId === changeSet.changeSetId
    && result.baseRevision === changeSet.revision && result.operations.length === changeSet.proposals.length
    && changeSet.proposals.every(proposal => result.operations.some(operation =>
      operation.targetNodeId === proposal.targetNodeId && operation.operation === proposal.operation
      && operation.expected === proposal.currentValue
      && (operation.operation === 'setCapability'
        ? operation.targetNodeId === `capability:${operation.capability}` && operation.enabled === proposal.proposedValue
        : operation.value === proposal.proposedValue)))
}

function cancellationMatches(
  cancellation: BlueprintProposalCancellation,
  changeSet: BlueprintChangeSet,
): boolean {
  return cancellation.sourceSessionId === changeSet.sourceSessionId
    && cancellation.routeId === changeSet.routeId
    && cancellation.changeSetId === changeSet.changeSetId
    && cancellation.presetId === changeSet.presetId
    && cancellation.baseRevision === changeSet.revision
}

/**
 * Resolve a historical Apply independently of later changes to the same preset.
 * @param changeSet - durable proposal Tool result.
 * @param state - active conversation receipts and current Blueprint projection.
 * @returns successful history first, otherwise a failure or current applicability state.
 */
export function blueprintProposalStatus(changeSet: BlueprintChangeSet, state: BlueprintUiState): BlueprintProposalStatus {
  const receipts = (state.applyReceipts ?? []).filter(receipt => matches(receipt, changeSet))
  if (receipts.some(({ result }) => result.status === 'committed' && result.preflight.ok
    && result.committedRevision !== undefined && result.unexpectedDrift.length === 0)) return 'applied'
  if (state.proposalCancellations.some(cancellation => cancellationMatches(cancellation, changeSet))) {
    return 'canceled'
  }
  if (state.applyReceiptsLoading) return 'loading'
  const failure = receipts.at(-1)?.result
  if (failure !== undefined) return failure.status === 'preflight_failed' || failure.status === 'staging_failed' ? 'rejected' : 'failed'
  if (state.creator !== null && state.creator.status !== 'ready') return 'locked'
  if (state.capabilityHandoff?.status === 'configuring' || state.capabilityHandoff?.status === 'authoring') return 'locked'
  const blueprint = state.blueprint
  if (blueprint === null) return 'loading'
  if (blueprint.preset.id !== changeSet.presetId || blueprint.revision !== changeSet.revision) return 'stale'
  return changeSet.proposals.every((proposal) => {
    const node = blueprint.nodes.find(candidate => candidate.id === proposal.targetNodeId)
    const scalar = typeof node?.value === 'object' && node.value !== null && 'enabled' in node.value
      ? node.value['enabled'] : node?.value
    return node?.editable === true && scalar === proposal.currentValue
  }) ? 'pending' : 'stale'
}
