import { describe, expect, it } from 'vitest'
import type {
  BlueprintApplyReceipt, BlueprintChangeSet, BlueprintProposalCancellation,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { BlueprintUiState } from '../src/client/controller.ts'
import { blueprintProposalStatus } from '../src/client/proposal-status.ts'

const changeSet: BlueprintChangeSet = {
  changeSetId: 'proposal-a', sourceSessionId: 'conversation-a', routeId: 'route-a',
  presetId: 'research', revision: 'r1', kind: 'direct-request',
  proposals: [{
    proposalId: 'proposal-a', presetId: 'research', revision: 'r1',
    targetNodeId: 'identity:persona', operation: 'updateIdentity',
    currentValue: '角色 A', proposedValue: '角色 B', impact: '修改角色。',
  }],
}
const receipt: BlueprintApplyReceipt = {
  sourceSessionId: 'conversation-a', routeId: 'route-a', proposalResultSeq: 10, terminalSeq: 11,
  presetId: 'research', result: {
    sourceSessionId: 'conversation-a', routeId: 'route-a', changeSetId: 'proposal-a',
    baseRevision: 'r1', committedRevision: 'r2',
    status: 'committed', preflight: { ok: true }, unexpectedDrift: [],
    operations: [{ operation: 'updateIdentity', targetNodeId: 'identity:persona', expected: '角色 A', value: '角色 B' }],
  },
}
function state(value = '角色 A', revision = 'r1'): BlueprintUiState {
  return {
    phase: 'ready', agents: [], presetId: 'research', selectedNodeId: null,
    modal: null, busy: false, error: null, validation: null, proposalCancellations: [],
    creator: null, capabilityHandoff: null,
    blueprint: {
      schemaVersion: 1, preset: { id: 'research', trust: 'user' }, revision, mappingGaps: [],
      nodes: [{ id: 'identity:persona', type: 'identity', value, editable: true, source: 'preset', status: 'active', adapterRef: 'role' }],
      runtime: { tools: [], promptSections: [], skills: [], delegations: [], permissions: null },
    },
  }
}

describe('durable Proposal status precedence', () => {
  it('keeps an applied action after refresh, later edits, target selection, or a failed retry', () => {
    const current = state('角色 C', 'r3')
    current.applyReceipts = JSON.parse(JSON.stringify([receipt])) as BlueprintApplyReceipt[]
    expect(blueprintProposalStatus(changeSet, current)).toBe('applied')
    current.blueprint = null
    current.applyReceiptsLoading = true
    current.applyReceipts = [receipt, { ...receipt, result: { ...receipt.result, status: 'preflight_failed' } }]
    expect(blueprintProposalStatus(changeSet, current)).toBe('applied')
  })

  it('restores an exact durable cancellation after refresh and later preset changes', () => {
    const cancellation: BlueprintProposalCancellation = {
      sourceSessionId: 'conversation-a', routeId: 'route-a', proposalResultSeq: 10,
      changeSetId: 'proposal-a', presetId: 'research', baseRevision: 'r1', status: 'cancelled',
    }
    const current = state('角色 C', 'r3')
    current.proposalCancellations = [cancellation]
    expect(blueprintProposalStatus(changeSet, current)).toBe('canceled')
    current.blueprint = null
    expect(blueprintProposalStatus(changeSet, current)).toBe('canceled')

    const variants: BlueprintProposalCancellation[] = [
      { ...cancellation, sourceSessionId: 'conversation-b' },
      { ...cancellation, routeId: 'route-b' },
      { ...cancellation, changeSetId: 'proposal-b' },
      { ...cancellation, presetId: 'other' },
      { ...cancellation, baseRevision: 'r0' },
    ]
    for (const other of variants) {
      expect(blueprintProposalStatus(changeSet, { ...state(), proposalCancellations: [other] })).toBe('pending')
    }
  })

  it('uses revision and expected values only for unapplied proposals, never text equality as history', () => {
    expect(blueprintProposalStatus(changeSet, state())).toBe('pending')
    expect(blueprintProposalStatus(changeSet, state('角色 B', 'r2'))).toBe('stale')
    expect(blueprintProposalStatus(changeSet, state('角色 B'))).toBe('stale')
    expect(blueprintProposalStatus(changeSet, { ...state(), applyReceiptsLoading: true })).toBe('loading')
  })

  it('locks an unrelated proposal while a capability executor can still write the target', () => {
    const current = state()
    current.capabilityHandoff = {
      sourceSessionId: 'conversation-a', routeId: 'capability-route', targetPresetId: 'research',
      revision: 'r1', request: '创建 CSV Skill', label: 'CSV Skill', status: 'authoring',
      authoringKind: 'skill', creatorSessionId: 'creator-session', startSeq: 10,
    }
    expect(blueprintProposalStatus(changeSet, current)).toBe('locked')
  })

  it.each(['preflight_failed', 'commit_failed', 'reprojection_failed_recovered'] as const)('never labels %s Applied', (status) => {
    const current = { ...state('角色 B', 'r2'), applyReceipts: [{ ...receipt, result: { ...receipt.result, status } }] }
    expect(blueprintProposalStatus(changeSet, current)).toBe(status === 'preflight_failed' ? 'rejected' : 'failed')
  })

  it('does not associate receipts by a shared node or value', () => {
    const variants: BlueprintApplyReceipt[] = [
      { ...receipt, sourceSessionId: 'conversation-b' },
      { ...receipt, routeId: 'route-b' },
      { ...receipt, presetId: 'other' },
      { ...receipt, result: { ...receipt.result, sourceSessionId: 'conversation-b' } },
      { ...receipt, result: { ...receipt.result, routeId: 'route-b' } },
      { ...receipt, result: { ...receipt.result, changeSetId: 'proposal-b' } },
      { ...receipt, result: { ...receipt.result, baseRevision: 'r0' } },
      { ...receipt, result: { ...receipt.result, operations: [] } },
      { ...receipt, result: { ...receipt.result, operations: [{ operation: 'updateIdentity', targetNodeId: 'identity:persona', expected: '角色 A', value: '角色 C' }] } },
    ]
    for (const other of variants) expect(blueprintProposalStatus(changeSet, { ...state(), applyReceipts: [other] })).toBe('pending')
  })
})
