/** Package-owned invariant companion for `dsh-shared-blueprint`. */

/* jscpd:ignore-start */
import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { COMPOSITION_FILE } from '@deepseek-ai/dsh-agent-presets'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { creatorValidatedPreset } from './creator-lifecycle.ts'
import { capabilityAuthoringCreatorSessionId } from './capability-authority.ts'
import { canonicalJson } from './canonical-json.ts'
import {
  blueprintChangeSetOperations,
  BLUEPRINT_CAPABILITY_AUTHORING_TOOL,
  BLUEPRINT_PROPOSAL_TOOL,
  sameBlueprintChangeSetOperations,
} from './proposal.ts'
import type {
  BlueprintCapabilityAuthoringEvent,
  BlueprintCapabilityVerifiedEvent,
  BlueprintChangeSet,
} from '../contract/types.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
}

function capabilityRepairMessageId(routeId: string, startSeq: number, attempt: number): string {
  return `blueprint-capability-repair:${createHash('sha256')
    .update(JSON.stringify([routeId, startSeq, attempt])).digest('hex')}`
}

function capabilityWakeMessageId(sourceSessionId: string, routeId: string, startSeq: number): string {
  return `blueprint-capability:${createHash('sha256')
    .update(JSON.stringify([sourceSessionId, routeId, startSeq])).digest('hex')}`
}

function validCapabilityTargetPath(path: unknown): path is string {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || basename(path) !== COMPOSITION_FILE) {
    return false
  }
  const target = dirname(path)
  const root = dirname(target)
  return target !== root && basename(target).length > 0 && join(root, basename(target)) === target
}

function isCapabilityRepairPrerequisite(value: unknown): boolean {
  return value === 'creator_turn' || value === 'candidate_delta' || value === 'fresh_mount'
    || value === 'runtime_conformance' || value === 'projection' || value === 'commit'
}

/** Check durable candidate evidence without re-reading a preset that may have changed since the event. */
function validateImpactCandidates(change: Record<string, unknown>, fail: InvariantFailure): void {
  const candidates = change['impactCandidates']
  if (!Array.isArray(candidates)) fail('blueprint/user-change impactCandidates must be an array')
  const targets = new Set<string>()
  for (const candidate of candidates) {
    if (!isRecord(candidate) || typeof candidate['nodeId'] !== 'string' || candidate['nodeId'].trim() === ''
      || candidate['nodeId'] === change['nodeId'] || targets.has(candidate['nodeId'])) {
      fail('blueprint/user-change impactCandidates must name distinct non-empty targets other than the edited node')
    }
    targets.add(candidate['nodeId'])
    const evidence = candidate['evidence']
    if (!Array.isArray(evidence) || evidence.length === 0) {
      fail('blueprint/user-change impactCandidates require non-empty evidence')
    }
    for (const item of evidence) {
      if (!isRecord(item)) fail('blueprint/user-change impact evidence must be an object')
      if (item['kind'] === 'tool-reference' || item['kind'] === 'removed-literal') {
        if (typeof item['value'] !== 'string' || item['value'].trim() === '') {
          fail('blueprint/user-change literal impact evidence requires a non-empty value')
        }
      } else if (item['kind'] !== 'purpose-child' && item['kind'] !== 'identity-peer') {
        fail('blueprint/user-change impact evidence kind is unknown')
      }
    }
    if (change['nodeType'] === 'identity') {
      if (!/^(?:purpose:persona|(?:behavior|output):[1-9]\d*)$/u.test(candidate['nodeId'])
        || !evidence.some(item => isRecord(item) && item['kind'] === 'identity-peer')
        || evidence.some(item => !isRecord(item) || (item['kind'] !== 'identity-peer' && item['kind'] !== 'removed-literal'))) {
        fail('blueprint/user-change Identity candidates require identity-peer evidence for Purpose, Behavior, or Output')
      }
    }
  }
}

/** Validate the semantic fields of one direct-edit event imported from or appended to a Session log. */
function validateUserChange(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type !== 'blueprint/user-change') return
  const change: unknown = event.data
  if (!isRecord(change)) fail('blueprint/user-change must carry an object')
  const presetId = change['presetId']
  const nodeId = change['nodeId']
  const label = change['label']
  const nodeType = change['nodeType']
  const previousValue = change['previousValue']
  const currentValue = change['currentValue']
  const operation = change['operation']
  if (typeof presetId !== 'string' || presetId.trim() === ''
    || typeof nodeId !== 'string' || nodeId.trim() === ''
    || typeof label !== 'string' || label.trim() === '') {
    fail('blueprint/user-change presetId, nodeId, and label must be non-empty')
  }
  if (previousValue === currentValue) {
    fail('blueprint/user-change must record two different values')
  }
  if (operation === 'update') {
    if ((nodeType !== 'identity' && nodeType !== 'purpose' && nodeType !== 'behavior' && nodeType !== 'output')
      || typeof previousValue !== 'string' || typeof currentValue !== 'string') {
      fail('blueprint/user-change update must carry text values for Identity, Purpose, Behavior, or Output')
    }
    validateImpactCandidates(change, fail)
    return
  }
  if (nodeType !== 'capability'
    || typeof previousValue !== 'boolean' || typeof currentValue !== 'boolean'
    || (operation === 'enable' && (previousValue || !currentValue))
    || (operation === 'disable' && (!previousValue || currentValue))
    || (operation !== 'enable' && operation !== 'disable')) {
    fail('blueprint/user-change enable/disable must carry the corresponding Capability boolean transition')
  }
  validateImpactCandidates(change, fail)
}

/** Validate durable capability-authoring association and terminal markers. */
function validateCapabilityAuthoring(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type !== 'blueprint/capability-authoring') return
  const data = event.data
  if (data.routeId.trim() === '' || data.sourceSessionId.trim() === ''
    || data.targetPresetId.trim() === '' || data.request.trim() === '') {
    fail('blueprint/capability-authoring routeId, sourceSessionId, targetPresetId, and request must be non-empty')
  }
  const kind: unknown = data.kind
  if (kind !== 'skill' && kind !== 'subagent') {
    fail('blueprint/capability-authoring kind must be skill or subagent')
  }
  if (!isDigest(data.baseRevision)) fail('blueprint/capability-authoring baseRevision must be a SHA-256 digest')
  if (!Array.isArray(data.baselinePresets)
    || new Set(data.baselinePresets.map(preset => preset.id)).size !== data.baselinePresets.length
    || data.baselinePresets.some(preset => typeof preset.id !== 'string' || preset.id.trim() === ''
      || ((preset.trust as unknown) !== 'system' && (preset.trust as unknown) !== 'user')
      || (preset.name !== undefined && (typeof preset.name !== 'string' || preset.name.trim() === ''))
      || (preset.description !== undefined && (typeof preset.description !== 'string' || preset.description.trim() === ''))
      || (preset.order !== undefined && (typeof preset.order !== 'number' || !Number.isFinite(preset.order)))
      || (preset.broken !== undefined && (typeof preset.broken !== 'string' || preset.broken.trim() === ''))
      || (preset.compositionDigest !== null && !isDigest(preset.compositionDigest))
      || (preset.compositionDigest === null && preset.broken === undefined))) {
    fail('blueprint/capability-authoring preset baseline must contain distinct exact roster entries')
  }
  const targetPreset = data.baselinePresets.find(preset => preset.id === data.targetPresetId)
  if (targetPreset === undefined || targetPreset.broken !== undefined
    || targetPreset.compositionDigest !== data.baseRevision) {
    fail('blueprint/capability-authoring preset baseline must contain the exact healthy target revision')
  }
  if (!Array.isArray(data.baselineNodes) || data.baselineNodes.length === 0
    || data.baselineNodes.some(node => typeof node.id !== 'string' || node.id.trim() === '')
    || new Set(data.baselineNodes.map(node => node.id)).size !== data.baselineNodes.length) {
    fail('blueprint/capability-authoring node baseline must contain distinct projected nodes')
  }
  if (!Array.isArray(data.baselineSkills)
    || new Set(data.baselineSkills.map(skill => skill.name)).size !== data.baselineSkills.length
    || data.baselineSkills.some(skill => typeof skill.name !== 'string' || skill.name.trim() === ''
      || typeof skill.description !== 'string' || skill.description.trim() === ''
      || ((skill.scope as unknown) !== 'preset' && (skill.scope as unknown) !== 'inherited')
      || typeof skill.provider !== 'string' || skill.provider.trim() === ''
      || typeof skill.source !== 'string' || skill.source.trim() === ''
      || !isDigest(skill.definitionDigest)
      || typeof (skill.invocation as { modelInvocable?: unknown } | undefined)?.modelInvocable !== 'boolean'
      || typeof skill.invocation.userInvocable !== 'boolean')) {
    fail('blueprint/capability-authoring Skill baseline must contain distinct complete definitions')
  }
  if (!Array.isArray(data.baselineDelegations)
    || new Set(data.baselineDelegations.map(row => row.rowId)).size !== data.baselineDelegations.length
    || data.baselineDelegations.some(row => typeof row.rowId !== 'string' || row.rowId.trim() === ''
      || typeof row.tool !== 'string' || row.tool.trim() === ''
      || typeof row.provider !== 'string' || row.provider.trim() === ''
      || ((row.mode as unknown) !== 'one-shot' && (row.mode as unknown) !== 'continuable') || !isDigest(row.configDigest)
      || typeof row.providerAvailable !== 'boolean' || typeof row.enabled !== 'boolean')) {
    fail('blueprint/capability-authoring delegation baseline must contain distinct complete configs')
  }
  const candidate: unknown = data.candidate
  if (!isRecord(candidate) || candidate['version'] !== 1
    || !isDigest(candidate['transactionId']) || !validCapabilityTargetPath(candidate['targetPath'])
    || basename(dirname(candidate['targetPath'])) !== data.targetPresetId
    || candidate['baseRevision'] !== data.baseRevision || !isDigest(candidate['baselineTreeDigest'])) {
    fail(`blueprint/capability-authoring candidate must retain one normalized ${COMPOSITION_FILE} target and exact baseline digests`)
  }
  if (!Number.isSafeInteger(data.maxRepairAttempts) || data.maxRepairAttempts < 0) {
    fail('blueprint/capability-authoring maxRepairAttempts must be a non-negative safe integer')
  }
  if (data.state === 'ended' && (!Number.isSafeInteger(data.startSeq) || data.startSeq < 0)) {
    fail('blueprint/capability-authoring ended event must cite a non-negative startSeq')
  }
}

/** Validate one typed new-Agent task retained by its Creator Session. */
function validateCreatorAuthoring(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type !== 'blueprint/creator-authoring') return
  const data = event.data
  if ((data.operation as unknown) !== 'create-agent') {
    fail('blueprint/creator-authoring operation must be create-agent')
  }
  if (data.routeId.trim() === '' || data.sourceSessionId.trim() === ''
    || data.request.trim() === '' || data.name.trim() === '') {
    fail('blueprint/creator-authoring routeId, sourceSessionId, request, and name must be non-empty')
  }
  if (data.sourceLanguage !== undefined
    && (typeof data.sourceLanguage !== 'string' || data.sourceLanguage.trim() === '')) {
    fail('blueprint/creator-authoring sourceLanguage must be a non-empty string when present')
  }
  if (data.language !== undefined && (typeof data.language !== 'string' || data.language.trim() === '')) {
    fail('blueprint/creator-authoring legacy language must be a non-empty string when present')
  }
}

function validateCreatorAuthoringLog(session: Session, fail: InvariantFailure): void {
  const routeIds = new Set<string>()
  for (const event of session.events) {
    if (event.type !== 'blueprint/creator-authoring') continue
    if (routeIds.has(event.data.routeId)) {
      fail('blueprint/creator-authoring routeId must be unique within one Creator Session')
    }
    routeIds.add(event.data.routeId)
  }
}

/** Terminal facts cite one task and its own result; they cannot be replaced by later turns. */
function validateCreatorTerminal(session: Session, event: SessionEvent, fail: InvariantFailure): void {
  if (event.type !== 'blueprint/creator-authoring-ended') return
  const data = event.data
  const prior = session.events.filter(candidate => candidate.seq < event.seq)
  const start = prior.find(candidate => candidate.seq === data.startSeq)
  const turn = prior.find(candidate => candidate.seq === data.turnEndSeq)
  if (start?.type !== 'blueprint/creator-authoring' || start.data.routeId !== data.routeId
    || (start.data.handoff !== undefined && start.data.handoff.targetCreatorSessionId !== session.id)
    || turn?.type !== 'turn/end' || turn.seq <= start.seq) {
    fail('Creator terminal evidence must cite its owning task and authoring turn')
  }
  if (prior.some(candidate => candidate.type === 'blueprint/creator-authoring-ended'
    && candidate.data.routeId === data.routeId)) {
    fail('Creator task terminal outcome is immutable')
  }
  if (data.outcome === 'completed') {
    const validation = prior.find(candidate => candidate.seq === data.validationSeq)
    if (turn.data.reason.kind !== 'completed' || validation === undefined
      || validation.seq <= start.seq || validation.seq >= turn.seq
      || creatorValidatedPreset(prior, validation) !== data.targetPresetId) {
      fail('Creator completion requires successful mounted validation before its completed turn')
    }
  } else if ((data.outcome === 'failed' && turn.data.reason.kind !== 'error')
    || (data.outcome === 'cancelled' && turn.data.reason.kind !== 'aborted')) {
    fail('Creator failure or cancellation must cite its corresponding authoring turn outcome')
  }
}

type CapabilityStartData = Extract<BlueprintCapabilityAuthoringEvent, { state: 'started' }>
type CapabilityTerminalData = Extract<BlueprintCapabilityAuthoringEvent, { state: 'ended' }>
type CapabilitySkillEvidence = NonNullable<CapabilityTerminalData['skillEvidence']>
type CapabilitySubagentEvidence = NonNullable<CapabilityTerminalData['subagentEvidence']>

interface CapabilityStartRecord {
  seq: number
  data: CapabilityStartData
}

interface CapabilityRepairRecord {
  seq: number
  data: Extract<SessionEvent, { type: 'blueprint/capability-repair' }>['data']
}

interface CapabilityCancelRequestedRecord {
  seq: number
  data: Extract<SessionEvent, { type: 'blueprint/capability-cancel-requested' }>['data']
}

interface CapabilityVerifiedRecord {
  seq: number
  data: BlueprintCapabilityVerifiedEvent
}

interface CapabilityClaimRecord {
  seq: number
  turn: number
}

function capabilityTurnSupportsVerification(
  events: readonly SessionEvent[],
  startSeq: number,
  turnEndSeq: number,
  beforeSeq: number,
  claim: CapabilityClaimRecord | undefined,
): boolean {
  const turn = events.find(candidate => candidate.seq === turnEndSeq)
  return turn?.type === 'turn/end'
    && claim !== undefined && turn.data.turn === claim.turn && turn.seq > claim.seq
    && (turn.data.reason.kind === 'completed' || turn.data.reason.kind === 'interrupted'
      || (turn.data.reason.kind === 'aborted' && turn.data.reason.reason.kind === 'disposed'))
    && turn.seq > startSeq && turn.seq < beforeSeq
}

function validateCapabilityVerificationBinding(
  sessionId: string,
  start: CapabilityStartRecord,
  evidence: CapabilitySkillEvidence | CapabilitySubagentEvidence,
  fail: InvariantFailure,
): void {
  const verification = evidence.verification
  if (!isDigest(evidence.revision) || verification.sessionId.trim() === ''
    || verification.sessionId === sessionId || verification.presetId !== start.data.targetPresetId
    || !verification.valid || verification.overall !== 'pass'
    || verification.binding.status !== 'pass'
    || verification.binding.sessionPresetId !== start.data.targetPresetId
    || verification.binding.composedPresetId !== start.data.targetPresetId
    || verification.binding.expectedRevision !== evidence.revision
    || verification.binding.projectedRevision !== evidence.revision
    || verification.prompt.status !== 'pass' || verification.tools.status !== 'pass'
    || verification.skills.status !== 'pass' || verification.delegations.status !== 'pass'
    || verification.permissions.status !== 'pass') {
    fail('Capability verification requires fresh target-bound runtime conformance evidence')
  }
}

function validateSkillVerification(
  sessionId: string,
  events: readonly SessionEvent[],
  start: CapabilityStartRecord,
  checkpoint: CapabilityVerifiedRecord,
  evidence: CapabilitySkillEvidence,
  claim: CapabilityClaimRecord | undefined,
  fail: InvariantFailure,
): void {
  validateCapabilityVerificationBinding(sessionId, start, evidence, fail)
  if (evidence.turnEndSeq !== checkpoint.data.turnEndSeq
    || !capabilityTurnSupportsVerification(events, start.seq, evidence.turnEndSeq, checkpoint.seq, claim)
    || evidence.skills.length === 0
    || evidence.skills.some(skill => start.data.baselineSkills.some(baseline => baseline.name === skill.name)
      || !isDigest(skill.definitionDigest)
      || (!skill.invocation.modelInvocable && !skill.invocation.userInvocable)
      || !evidence.verification.skills.evidence.some(item => item.name === skill.name
        && item.actualPresent && item.expectedDefinitionDigest === skill.definitionDigest
        && item.liveDefinitionDigest === skill.definitionDigest && item.status === 'pass'))) {
    fail('Skill verification requires a completed Creator turn and new callable mounted definitions')
  }
}

function validateSubagentVerification(
  sessionId: string,
  events: readonly SessionEvent[],
  start: CapabilityStartRecord,
  checkpoint: CapabilityVerifiedRecord,
  evidence: CapabilitySubagentEvidence,
  claim: CapabilityClaimRecord | undefined,
  fail: InvariantFailure,
): void {
  validateCapabilityVerificationBinding(sessionId, start, evidence, fail)
  if (evidence.turnEndSeq !== checkpoint.data.turnEndSeq
    || !capabilityTurnSupportsVerification(events, start.seq, evidence.turnEndSeq, checkpoint.seq, claim)
    || evidence.delegations.length === 0
    || evidence.delegations.some(row => start.data.baselineDelegations.some(baseline => baseline.rowId === row.rowId)
      || !isDigest(row.configDigest) || !row.enabled || !row.providerAvailable
      || !evidence.verification.delegations.evidence.some(item => item.rowId === row.rowId
        && item.tool === row.tool && item.provider === row.provider
        && item.providerAvailable && item.status === 'pass'))) {
    fail('Subagent verification requires a completed Creator turn and matching non-baseline delegation evidence')
  }
}

function validateCapabilityVerified(
  sessionId: string,
  events: readonly SessionEvent[],
  start: CapabilityStartRecord,
  checkpoint: CapabilityVerifiedRecord,
  claim: CapabilityClaimRecord | undefined,
  fail: InvariantFailure,
): void {
  const data = checkpoint.data
  if (data.routeId !== start.data.routeId || data.startSeq !== start.seq
    || data.kind !== start.data.kind || !isDigest(data.candidateTreeDigest)) {
    fail('blueprint/capability-verified must bind the active lifecycle, lane, and candidate digest')
  }
  if (data.kind === 'skill') {
    validateSkillVerification(sessionId, events, start, checkpoint, data.skillEvidence, claim, fail)
  } else {
    validateSubagentVerification(sessionId, events, start, checkpoint, data.subagentEvidence, claim, fail)
  }
}

function sameCapabilityStart(start: CapabilityStartRecord, terminal: CapabilityTerminalData): boolean {
  return terminal.startSeq === start.seq
    && terminal.routeId === start.data.routeId
    && terminal.sourceSessionId === start.data.sourceSessionId
    && terminal.targetPresetId === start.data.targetPresetId
    && terminal.request === start.data.request
    && terminal.kind === start.data.kind
    && terminal.baseRevision === start.data.baseRevision
    && terminal.maxRepairAttempts === start.data.maxRepairAttempts
    && canonicalJson(terminal.candidate) === canonicalJson(start.data.candidate)
    && canonicalJson(terminal.baselinePresets) === canonicalJson(start.data.baselinePresets)
    && canonicalJson(terminal.baselineNodes) === canonicalJson(start.data.baselineNodes)
    && canonicalJson(terminal.baselineSkills) === canonicalJson(start.data.baselineSkills)
    && canonicalJson(terminal.baselineDelegations) === canonicalJson(start.data.baselineDelegations)
}

function validCandidateDisposition(
  value: unknown,
  start: CapabilityStartRecord,
  disposition: 'committed' | 'discarded',
  candidateTreeDigest?: string,
): boolean {
  if (!isRecord(value) || value['transactionId'] !== start.data.candidate.transactionId
    || value['disposition'] !== disposition || !isDigest(value['candidateTreeDigest'])
    || !isDigest(value['finalTreeDigest'])) return false
  if (candidateTreeDigest !== undefined && value['candidateTreeDigest'] !== candidateTreeDigest) return false
  return disposition === 'committed'
    ? value['finalTreeDigest'] === value['candidateTreeDigest']
    : value['finalTreeDigest'] === start.data.candidate.baselineTreeDigest
}

function validateCapabilityTerminal(
  events: readonly SessionEvent[],
  start: CapabilityStartRecord,
  repairs: readonly CapabilityRepairRecord[],
  verified: CapabilityVerifiedRecord | undefined,
  cancelRequested: CapabilityCancelRequestedRecord | undefined,
  claim: CapabilityClaimRecord | undefined,
  event: Extract<SessionEvent, { type: 'blueprint/capability-authoring' }>,
  fail: InvariantFailure,
): void {
  if (event.data.state !== 'ended' || !sameCapabilityStart(start, event.data)) {
    fail('blueprint/capability-authoring ended event must cite the active lifecycle')
  }
  const data = event.data
  if (cancelRequested !== undefined && data.outcome !== 'cancelled') {
    fail('durably cancelled capability authoring cannot publish another terminal outcome')
  }
  if (data.outcome === 'completed') {
    if (verified === undefined || data.capabilityFailure !== undefined
      || !validCandidateDisposition(data.candidateDisposition, start, 'committed', verified.data.candidateTreeDigest)
      || (verified.data.kind === 'skill'
        ? data.subagentEvidence !== undefined
          || canonicalJson(data.skillEvidence) !== canonicalJson(verified.data.skillEvidence)
        : data.skillEvidence !== undefined
          || canonicalJson(data.subagentEvidence) !== canonicalJson(verified.data.subagentEvidence))) {
      fail('completed capability authoring must cite its unique verified checkpoint and committed candidate')
    }
    return
  }
  const failure: unknown = data.capabilityFailure
  const failureTurn = isRecord(failure) && typeof failure['turnEndSeq'] === 'number'
    ? events.find(candidate => candidate.seq === failure['turnEndSeq'])
    : undefined
  const validSettledTurn = failureTurn?.type === 'turn/end'
    && claim !== undefined && failureTurn.data.turn === claim.turn && failureTurn.seq > claim.seq
    && failureTurn.seq > start.seq && failureTurn.seq < event.seq
  const durableCancellation = data.outcome === 'cancelled' && cancelRequested !== undefined
    && cancelRequested.seq > start.seq && cancelRequested.seq < event.seq
  const validTurn = data.outcome === 'cancelled'
    ? (validSettledTurn && failureTurn.data.reason.kind === 'aborted'
        && failureTurn.data.reason.reason.kind === 'user')
      || (durableCancellation && isRecord(failure)
        && (failure['turnEndSeq'] === start.seq || validSettledTurn))
    : validSettledTurn
  const prerequisite = isRecord(failure) ? failure['prerequisite'] : undefined
  const verifiedPublicationFailure = data.outcome === 'failed' && verified !== undefined && prerequisite === 'commit'
  const verifiedCancellation = durableCancellation && verified !== undefined
  const validFailurePrerequisite = data.outcome === 'cancelled'
    ? prerequisite === 'cancelled'
    : verifiedPublicationFailure || isCapabilityRepairPrerequisite(prerequisite)
  if ((verified !== undefined && !verifiedPublicationFailure && !verifiedCancellation)
    || data.skillEvidence !== undefined || data.subagentEvidence !== undefined
    || !validCandidateDisposition(
      data.candidateDisposition,
      start,
      'discarded',
      verifiedPublicationFailure || verifiedCancellation ? verified.data.candidateTreeDigest : undefined,
    )
    || !isRecord(failure) || !validTurn
    || failure['attempt'] !== repairs.length || !Number.isSafeInteger(failure['attempt'])
    || (data.outcome === 'failed' && !verifiedPublicationFailure && repairs.length !== start.data.maxRepairAttempts)
    || typeof failure['message'] !== 'string' || failure['message'].trim() === ''
    || !validFailurePrerequisite) {
    fail('failed or cancelled capability authoring must discard its candidate with exact private failure evidence')
  }
}

function validateCapabilityInboxInsertion(
  sessionId: string,
  active: CapabilityStartRecord | undefined,
  verified: CapabilityVerifiedRecord | undefined,
  cancelRequested: CapabilityCancelRequestedRecord | undefined,
  repairByMessageId: ReadonlyMap<string, CapabilityRepairRecord>,
  wakeByMessageId: ReadonlyMap<string, CapabilityStartRecord>,
  inboxes: Record<'next-turn' | 'next-step', string[]>,
  delivery: Map<string, 'pending' | 'canceled' | 'claimed'>,
  claims: Map<string, CapabilityClaimRecord>,
  openTurn: number | undefined,
  event: Extract<SessionEvent, { type: 'agent/inbox/spliced' }>,
  fail: InvariantFailure,
): void {
  const inbox = inboxes[event.data.target]
  const removed = inbox.slice(event.data.start, event.data.start + (event.data.removedCount ?? 0))
  inbox.splice(
    event.data.start,
    event.data.removedCount ?? 0,
    ...event.data.inserted.map(message => String(message.id)),
  )
  for (const messageId of removed) {
    if (!delivery.has(messageId)) continue
    if (event.data.outcome === 'canceled') {
      delivery.set(messageId, 'canceled')
      claims.delete(messageId)
    } else {
      if (openTurn === undefined) fail('capability authoring input must be claimed inside its durable turn')
      delivery.set(messageId, 'claimed')
      claims.set(messageId, { seq: event.seq, turn: openTurn })
    }
  }
  for (const message of event.data.inserted) {
    const messageId = String(message.id)
    const repair = repairByMessageId.get(messageId)
    const wake = wakeByMessageId.get(messageId)
    const internalPluginId = messageId.startsWith('blueprint-capability:')
    if (repair === undefined && wake === undefined && message.source.kind !== 'blueprint-capability-repair'
      && message.source.kind !== 'blueprint-capability-authoring' && !internalPluginId) continue
    const priorDelivery = delivery.get(messageId)
    if (priorDelivery === 'pending' || priorDelivery === 'claimed') {
      fail('capability authoring interaction cannot duplicate pending or already claimed work')
    }
    delivery.set(messageId, 'pending')
    const sameSource = active !== undefined && active.data.sourceSessionId === sessionId
    const validRepairSource = repair !== undefined && message.source.kind === 'blueprint-capability-repair'
      && message.source.routeId === repair.data.routeId && message.source.startSeq === repair.data.startSeq
      && message.source.attempt === repair.data.attempt && message.source.prerequisite === repair.data.prerequisite
      && (!sameSource || message.source.presentation === 'internal')
    const validWakeSource = wake !== undefined && active !== undefined && active.seq === wake.seq
      && (message.source.kind === 'blueprint-capability-authoring'
        ? message.source.routeId === wake.data.routeId && message.source.startSeq === wake.seq
          && message.source.presentation === 'internal'
        : !sameSource && message.source.kind === 'plugin' && message.source.plugin === 'blueprint-adapter')
    if ((message.source.kind === 'blueprint-capability-repair' && repair === undefined)
      || (message.source.kind === 'blueprint-capability-authoring' && wake === undefined)
      || active === undefined || verified !== undefined || cancelRequested !== undefined
      || (repair !== undefined && !validRepairSource)
      || (repair !== undefined && (active.seq !== repair.data.startSeq || active.data.routeId !== repair.data.routeId))
      || (wake !== undefined && !validWakeSource)
      || (internalPluginId && wake === undefined)) {
      fail('capability authoring interaction must bind one active unverified lifecycle checkpoint')
    }
  }
}

function capabilityWorkMessageId(
  active: CapabilityStartRecord,
  repairs: readonly CapabilityRepairRecord[],
): string {
  return String(repairs.at(-1)?.data.repairMessageId
    ?? capabilityWakeMessageId(active.data.sourceSessionId, active.data.routeId, active.seq))
}

function acceptedSameSourceRoutingTurnEnded(
  events: readonly SessionEvent[],
  start: CapabilityStartRecord,
): boolean {
  const prior = events.filter(event => event.seq < start.seq)
  return prior.some((decision) => {
    if (decision.type !== 'blueprint/route-decision' || decision.data.routeId !== start.data.routeId
      || decision.data.sourceSessionId !== start.data.sourceSessionId
      || decision.data.targetPresetId !== start.data.targetPresetId || decision.data.operation !== start.data.kind) return false
    const call = prior.find(event => event.type === 'tool/call'
      && event.data.callId === decision.data.callId && event.data.turn === decision.data.turn
      && event.data.name === BLUEPRINT_CAPABILITY_AUTHORING_TOOL)
    if (call?.type !== 'tool/call') return false
    const result = prior.find(event => event.type === 'tool/result' && event.seq > decision.seq
      && event.data.turn === decision.data.turn && event.data.step === call.data.step
      && event.data.message.source.callId === decision.data.callId && !event.data.message.content[0].isError)
    if (result?.type !== 'tool/result') return false
    const route = (result.data.meta as Record<string, unknown> | undefined)?.['blueprintCapabilityAuthoring']
    if (!isRecord(route) || route['routeId'] !== start.data.routeId
      || route['sourceSessionId'] !== start.data.sourceSessionId || route['presetId'] !== start.data.targetPresetId
      || route['revision'] !== start.data.baseRevision || route['request'] !== start.data.request
      || route['kind'] !== start.data.kind) return false
    return prior.some(event => event.type === 'turn/end' && event.data.turn === decision.data.turn
      && event.seq > result.seq)
  })
}

function validateCapabilityAuthoringEvents(
  sessionId: string,
  events: readonly SessionEvent[],
  fail: InvariantFailure,
): void {
  let active: CapabilityStartRecord | undefined
  let repairs: CapabilityRepairRecord[] = []
  let verified: CapabilityVerifiedRecord | undefined
  let cancelRequested: CapabilityCancelRequestedRecord | undefined
  const startedRoutes = new Set<string>()
  const repairByMessageId = new Map<string, CapabilityRepairRecord>()
  const wakeByMessageId = new Map<string, CapabilityStartRecord>()
  const inboxes: Record<'next-turn' | 'next-step', string[]> = { 'next-turn': [], 'next-step': [] }
  const delivery = new Map<string, 'pending' | 'canceled' | 'claimed'>()
  const claims = new Map<string, CapabilityClaimRecord>()
  let openTurn: number | undefined
  for (const event of events) {
    if (event.type === 'turn/start') {
      openTurn = event.data.turn
      continue
    }
    if (event.type === 'turn/end') {
      if (openTurn === event.data.turn) openTurn = undefined
      continue
    }
    if (event.type === 'blueprint/capability-authoring') {
      if (event.data.state === 'started') {
        const sameSource = sessionId === event.data.sourceSessionId
        const legacyCreator = sessionId === capabilityAuthoringCreatorSessionId(
          event.data.sourceSessionId,
          event.data.routeId,
        )
        if (!sameSource && !legacyCreator) {
          fail('blueprint/capability-authoring start must use its source Session or legacy deterministic Creator Session')
        }
        const candidateStart = { seq: event.seq, data: event.data }
        if (sameSource && !acceptedSameSourceRoutingTurnEnded(events, candidateStart)) {
          fail('same-source capability authoring must start after its accepted routing turn durably ends')
        }
        if (active !== undefined) fail('blueprint/capability-authoring cannot start while another lifecycle is active')
        if (startedRoutes.has(event.data.routeId)) {
          fail('blueprint/capability-authoring cannot recreate the same interaction lifecycle')
        }
        active = { seq: event.seq, data: event.data }
        repairs = []
        verified = undefined
        cancelRequested = undefined
        startedRoutes.add(event.data.routeId)
        wakeByMessageId.set(capabilityWakeMessageId(event.data.sourceSessionId, event.data.routeId, event.seq), active)
      } else {
        if (active === undefined) fail('blueprint/capability-authoring ended event must cite the active lifecycle')
        const claim = claims.get(capabilityWorkMessageId(active, repairs))
        validateCapabilityTerminal(events, active, repairs, verified, cancelRequested, claim, event, fail)
        active = undefined
        repairs = []
        verified = undefined
        cancelRequested = undefined
      }
      continue
    }
    if (event.type === 'blueprint/capability-cancel-requested') {
      const data = event.data
      if (active === undefined || cancelRequested !== undefined
        || data.routeId.trim() === '' || data.routeId !== active.data.routeId
        || data.startSeq !== active.seq || !Number.isSafeInteger(data.startSeq)) {
        fail('blueprint/capability-cancel-requested must bind the sole active lifecycle exactly once')
      }
      cancelRequested = { seq: event.seq, data }
      continue
    }
    if (event.type === 'blueprint/capability-repair') {
      const data = event.data
      const previous = repairs.at(-1)
      const claim = active === undefined ? undefined : claims.get(capabilityWorkMessageId(active, repairs))
      if (active === undefined || verified !== undefined || cancelRequested !== undefined
        || data.routeId !== active.data.routeId
        || data.startSeq !== active.seq || data.attempt !== repairs.length + 1
        || data.attempt > active.data.maxRepairAttempts
        || !Number.isSafeInteger(data.attempt) || !isDigest(data.candidateTreeDigest)
        || !isCapabilityRepairPrerequisite(data.prerequisite)
        || typeof data.message !== 'string' || data.message.trim() === ''
        || String(data.repairMessageId) !== capabilityRepairMessageId(data.routeId, data.startSeq, data.attempt)
        || !events.some(candidate => candidate.seq === data.turnEndSeq && candidate.type === 'turn/end'
          && claim !== undefined && candidate.data.turn === claim.turn && candidate.seq > claim.seq
          && candidate.seq > (previous?.seq ?? data.startSeq) && candidate.seq < event.seq
          && (candidate.data.reason.kind !== 'aborted' || candidate.data.reason.reason.kind !== 'user'))) {
        fail('blueprint/capability-repair must advance the active lifecycle from its settled turn with deterministic evidence')
      }
      const repair = { seq: event.seq, data }
      repairs.push(repair)
      repairByMessageId.set(String(data.repairMessageId), repair)
      continue
    }
    if (event.type === 'blueprint/capability-verified') {
      if (active === undefined || verified !== undefined || cancelRequested !== undefined
        || event.data.turnEndSeq <= (repairs.at(-1)?.seq ?? active.seq)) {
        fail('blueprint/capability-verified must be the sole checkpoint after the latest active Creator turn')
      }
      const checkpoint = { seq: event.seq, data: event.data }
      const claim = claims.get(capabilityWorkMessageId(active, repairs))
      validateCapabilityVerified(sessionId, events, active, checkpoint, claim, fail)
      verified = checkpoint
      continue
    }
    if (event.type === 'agent/inbox/spliced') {
      validateCapabilityInboxInsertion(
        sessionId, active, verified, cancelRequested, repairByMessageId, wakeByMessageId,
        inboxes, delivery, claims, openTurn, event, fail,
      )
    }
  }
}

function validateCapabilityAuthoringLog(session: Session, fail: InvariantFailure): void {
  validateCapabilityAuthoringEvents(String(session.id), session.events, fail)
}

/** Apply and Cancel cite one successful source-owned Proposal result and retain its exact content. */
function validateProposalTerminal(session: Session, event: SessionEvent, fail: InvariantFailure): void {
  if (event.type !== 'blueprint/apply-result' && event.type !== 'blueprint/proposal-cancelled') return
  const resultSeq = event.data.proposalResultSeq
  const proposalResult = session.events.flatMap(candidate => candidate.type === 'tool/result' ? [candidate] : [])
    .find(candidate => candidate.seq === resultSeq && candidate.seq < event.seq)
  if (proposalResult === undefined
    || (proposalResult.data.message.content as readonly { isError?: boolean }[])[0]?.isError === true) {
    fail('Blueprint Proposal terminal must cite one earlier successful Tool result')
  }
  const changeSetId = event.type === 'blueprint/apply-result' ? event.data.result.changeSetId : event.data.changeSetId
  const sourceSessionId = event.data.sourceSessionId
  const routeId = event.data.routeId
  const call = session.events.find(candidate => candidate.seq < proposalResult.seq && candidate.type === 'tool/call'
    && String(candidate.data.callId) === changeSetId && candidate.data.name === BLUEPRINT_PROPOSAL_TOOL)
  const decision = session.events.find(candidate => candidate.seq < proposalResult.seq
    && candidate.type === 'blueprint/route-decision' && candidate.data.sourceSessionId === session.id
    && candidate.data.routeId === routeId && String(candidate.data.callId) === changeSetId
    && candidate.data.operation === 'modify-existing-agent')
  const meta = (proposalResult.data.meta as Record<string, unknown> | undefined)?.['blueprintChangeSet']
  if (sourceSessionId !== session.id || call === undefined || decision === undefined || !isRecord(meta)
    || meta['sourceSessionId'] !== sourceSessionId || meta['routeId'] !== routeId
    || meta['changeSetId'] !== changeSetId || meta['presetId'] !== event.data.presetId) {
    fail('Blueprint Proposal terminal must match its source Session, route, Tool call, and durable Change Set')
  }
  if (event.type === 'blueprint/proposal-cancelled') {
    if ((event.data.status as unknown) !== 'cancelled' || meta['revision'] !== event.data.baseRevision) {
      fail('Blueprint cancellation must retain the durable Proposal target revision')
    }
    return
  }
  if (event.data.result.sourceSessionId !== sourceSessionId || event.data.result.routeId !== routeId
    || event.data.result.baseRevision !== meta['revision']) {
    fail('Blueprint Apply result must retain its Proposal owner, route, and revision')
  }
  let durableOperations: ReturnType<typeof blueprintChangeSetOperations>
  try {
    durableOperations = blueprintChangeSetOperations(meta as unknown as BlueprintChangeSet)
  } catch {
    fail('Blueprint Apply result must cite a structurally valid durable Change Set')
  }
  if (!sameBlueprintChangeSetOperations(event.data.result.operations, durableOperations)) {
    fail('Blueprint Apply result operations must equal its durable Proposal content')
  }
}

function validateProposalTerminalLog(session: Session, fail: InvariantFailure): void {
  const terminalChangeSets = new Set<string>()
  for (const event of session.events) {
    if (event.type !== 'blueprint/apply-result' && event.type !== 'blueprint/proposal-cancelled') continue
    const changeSetId = event.type === 'blueprint/apply-result' ? event.data.result.changeSetId : event.data.changeSetId
    if (terminalChangeSets.has(changeSetId)) fail('Blueprint Proposal terminal decision is immutable')
    terminalChangeSets.add(changeSetId)
  }
}

function validateCapabilityAuthoringAppend(
  session: Session,
  event: SessionEvent,
  fail: InvariantFailure,
): void {
  if (event.type !== 'blueprint/capability-authoring' && event.type !== 'blueprint/capability-repair'
    && event.type !== 'blueprint/capability-cancel-requested'
    && event.type !== 'blueprint/capability-verified' && event.type !== 'agent/inbox/spliced') return
  const prior = session.events.filter(candidate => candidate.seq < event.seq)
  validateCapabilityAuthoringEvents(String(session.id), [...prior, event], fail)
}

function acceptedSourceRoute(session: Session, turn: number): boolean {
  return session.events.some(event => event.type === 'blueprint/creator-authoring'
    && event.data.sourceSessionId === session.id && event.data.handoff?.sourceTurn === turn
    && session.events.some(result => result.type === 'tool/result' && result.data.turn === turn
      && result.data.message.source.callId === event.data.routeId && !result.data.message.content[0].isError))
}

function validateRoutingInput(session: Session, event: SessionEvent, fail: InvariantFailure): void {
  if (event.type !== 'blueprint/routing-input') return
  const input = event.data
  if (input.sourceSessionId !== session.id || input.routeId.trim() === ''
    || input.userRequest.trim() === '' || input.targetPresetId.trim() === '') {
    fail('blueprint routing input requires one non-empty source-owned interaction')
  }
  if (input.uiAction !== 'direct-edit') return
  const edit = input.directEdit
  const scalarInvalid = edit.nodeType === 'capability'
    ? typeof edit.currentValue !== 'boolean' || typeof edit.proposedValue !== 'boolean'
    : typeof edit.currentValue !== 'string' || edit.currentValue.trim() === ''
      || typeof edit.proposedValue !== 'string' || edit.proposedValue.trim() === ''
  if (edit.nodeId.trim() === '' || !structuredOperationMatches(edit.nodeType, edit.operation)
    || scalarInvalid
    || edit.currentValue === edit.proposedValue
    || edit.impactCandidates.some(candidate => candidate.nodeId === edit.nodeId)) {
    fail('blueprint structured-edit routing input must retain one typed semantic change and exclude it from P2 candidates')
  }
}

function structuredOperationMatches(nodeType: string, operation: string): boolean {
  return (nodeType === 'identity' && operation === 'updateIdentity')
    || (nodeType === 'purpose' && operation === 'updatePurpose')
    || (nodeType === 'behavior' && operation === 'updateBehavior')
    || (nodeType === 'output' && operation === 'updateOutput')
    || (nodeType === 'capability' && operation === 'setCapability')
}

function validateRoutingDecision(session: Session, event: SessionEvent, fail: InvariantFailure): void {
  if (event.type !== 'blueprint/route-decision') return
  const decision = event.data
  const prior = session.events.filter(candidate => candidate.seq < event.seq)
  const user = prior.find(candidate => candidate.seq === decision.userMessageSeq && candidate.type === 'user/message')
  if (decision.sourceSessionId !== session.id || user?.type !== 'user/message'
    || user.data.source.kind !== 'user' || user.data.id !== decision.userMessageId) {
    fail('blueprint route decision must cite its owning Session human message')
  }
  const action = prior.find(candidate => candidate.type === 'blueprint/routing-input' && candidate.data.messageId === decision.userMessageId)
  if (action?.type === 'blueprint/routing-input'
    && (decision.provenance !== action.data.uiAction || action.data.routeId !== decision.routeId
      || action.data.targetPresetId !== decision.targetPresetId
      || (action.data.uiAction === 'add-capability' && decision.operation === 'create-agent')
      || (action.data.uiAction === 'direct-edit' && decision.operation !== 'modify-existing-agent'))) {
    fail('Blueprint UI routing cannot change its operation domain or target without a new user message')
  }
  if (action === undefined && decision.routeId !== String(decision.userMessageId)) {
    fail('direct Blueprint interaction identity must equal its owning human message id')
  }
  if (prior.some(candidate => candidate.type === 'blueprint/route-decision' && candidate.data.routeId === decision.routeId
    && candidate.data.operation !== decision.operation)) {
    fail('one Blueprint interaction cannot select mutually exclusive operations')
  }
}

/**
 * Install Shared Blueprint durable lifecycle invariants.
 * @param ctx - Cordis context carrying Session state and dispatch events.
 * @param fail - bound invariant failure reporter.
 * @returns nothing; the owning companion controls the registered listeners.
 */
export const installBlueprintInvariants: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const seed = (session: Session): void => {
    for (const event of session.events) {
      validateUserChange(event, fail)
      validateCapabilityAuthoring(event, fail)
      validateCreatorAuthoring(event, fail)
      validateCreatorTerminal(session, event, fail)
      validateRoutingInput(session, event, fail)
      validateRoutingDecision(session, event, fail)
      validateProposalTerminal(session, event, fail)
    }
    validateCapabilityAuthoringLog(session, fail)
    validateCreatorAuthoringLog(session, fail)
    validateProposalTerminalLog(session, fail)
  }
  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName === 'tools/execute') {
      const exec = args[0] as ToolExecution
      const source = exec.agent?.session
      const turn = source?.events.findLast(event => event.type === 'turn/start')
      if (source !== undefined && turn?.type === 'turn/start' && acceptedSourceRoute(source, turn.data.turn)) {
        fail('create-agent exclusive handoff: source dispatched a Tool after route acceptance')
      }
      return
    }
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type === 'step/start') {
      if (acceptedSourceRoute(session, event.data.turn)) {
        fail('create-agent exclusive handoff: source started a model step after route acceptance')
      }
      const task = session.events.findLast(candidate => candidate.type === 'blueprint/creator-authoring'
        && candidate.data.handoff?.targetCreatorSessionId === session.id)
      if (task?.type === 'blueprint/creator-authoring') {
        const handoff = task.data.handoff
        const source = ctx.sessions.get(task.data.sourceSessionId as SessionId)
        if (handoff !== undefined && source !== undefined
          && !source.events.some(candidate => candidate.type === 'turn/end'
            && candidate.data.turn === handoff.sourceTurn)) {
          fail('create-agent exclusive handoff: Creator started before source turn ended')
        }
      }
    }
    validateUserChange(event, fail)
    validateCapabilityAuthoring(event, fail)
    validateCreatorAuthoring(event, fail)
    validateCreatorTerminal(session, event, fail)
    validateCapabilityAuthoringAppend(args[0] as Session, event, fail)
    validateRoutingInput(args[0] as Session, event, fail)
    validateRoutingDecision(args[0] as Session, event, fail)
    validateProposalTerminal(args[0] as Session, event, fail)
    if ((event.type === 'blueprint/apply-result' || event.type === 'blueprint/proposal-cancelled')
      && (args[0] as Session).events.some(candidate => candidate.seq < event.seq
        && (candidate.type === 'blueprint/apply-result' || candidate.type === 'blueprint/proposal-cancelled')
        && (candidate.type === 'blueprint/apply-result' ? candidate.data.result.changeSetId : candidate.data.changeSetId)
          === (event.type === 'blueprint/apply-result' ? event.data.result.changeSetId : event.data.changeSetId))) {
      fail('Blueprint Proposal terminal decision is immutable')
    }
    if (event.type === 'blueprint/creator-authoring'
      && (args[0] as Session).events.some(candidate => candidate.seq < event.seq
        && candidate.type === 'blueprint/creator-authoring'
        && candidate.data.routeId === event.data.routeId)) {
      fail('blueprint/creator-authoring routeId must be unique within one Creator Session')
    }
  }, { global: true })
}, { inject: ['sessions'] })

/* jscpd:ignore-end */
