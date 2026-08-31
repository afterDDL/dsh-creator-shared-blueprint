/** React-free object layer for the Interactive Blueprint UI. */

import type {
  Blueprint, BlueprintApplyChangeSetRequest, BlueprintApplyChangeSetResult,
  BlueprintApplyReceipt,
  BlueprintGetRequest,
  BlueprintCapabilityAuthoringRoute,
  BlueprintCreatorAuthoringRoute,
  BlueprintChangeSetOperation,
  BlueprintChangeProposal, BlueprintChangeSet, BlueprintConversationContextRequest, BlueprintConversationContextResult,
  BlueprintNode, BlueprintSessionValidation,
  BlueprintProposalCancellation, BlueprintStructuredEditInput, BlueprintUserChangeInput,
} from '@deepseek-ai/dsh-shared-blueprint/contract'
import {
  createSnapshotStore, type PendingInteraction, type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

/** Preset row shown in the Agent roster. */
export interface BlueprintAgentOption {
  id: string
  label: string
  description?: string
  trust: 'system' | 'user'
  broken?: string
}

/** One roster read plus the caller-owned initial target preference. */
export interface BlueprintAgentCatalogSnapshot {
  agents: readonly BlueprintAgentOption[]
  preferredPresetId?: string
}

/** Agent roster source shared by the real DSH binding and static Demo adapters. */
export interface BlueprintAgentCatalog {
  /** @returns the current detached roster and optional preferred initial target. */
  list(): Promise<BlueprintAgentCatalogSnapshot>
}

/** Durable id-only preference for the last valid Blueprint target. */
export interface BlueprintTargetPreference {
  /** @param sessionId - current Session identity; omitted addresses the no-Session view. @returns its stored preset id, or `null`. */
  read(sessionId?: string): string | null
  /** @param presetId - successfully projected target. @param sessionId - Session that owns the preference. */
  write(presetId: string, sessionId?: string): void
  /** @param sessionId - owner whose target no longer exists or cannot be projected. */
  clear(sessionId?: string): void
}

/** Creator-side Draft lifecycle shown instead of an unrelated preset. */
export interface BlueprintCreatorDraft {
  sessionId: string
  /** Typed task identity; absent only for legacy text-only authoring. */
  routeId?: string
  name: string
  status: 'creating' | 'waiting' | 'paused' | 'ambiguity' | 'ready'
  candidateIds: readonly string[]
  waitingFor: 'question' | 'approval' | null
  /** Exact background interaction retained only in the Client so the source view can answer it. */
  pendingInteraction?: PendingInteraction
  /** Reliably associated authoring target; the Draft may still suppress its copied template projection. */
  targetPresetId?: string
}

/** Structured terminal reason projected from the Creator Session's latest turn. */
export type BlueprintCreatorTurnEndReason =
  | 'completed'
  | 'max-tokens'
  | 'aborted'
  | 'blocked'
  | 'error'
  | 'interrupted'

/** Preset association strategy selected through a Creator-owned native question. */
export type BlueprintCreatorAssociationStrategy =
  | 'undecided'
  | 'reuse-existing'
  | 'enhance-existing'
  | 'new-independent'

/** User-visible capability intent retained while the conversation clarifies it. */
export interface BlueprintCapabilityHandoff {
  /** Existing-Agent conversation that owns this UI projection. */
  sourceSessionId: string
  /** Distinct Add capability interaction; never inferred from the foreground Session. */
  routeId: string
  request: string
  label: string
  targetPresetId: string
  revision: string
  status: 'configuring' | 'proposal' | 'authoring' | 'completed' | 'failed' | 'cancelled'
  /** Native interaction currently blocking Creator authoring. */
  waitingFor?: 'input' | 'approval'
  /** Exact background interaction retained only in the Client so the source view can answer it. */
  pendingInteraction?: PendingInteraction
  /** Typed mechanism retained while the authoring lifecycle owns the target preset. */
  authoringKind?: 'skill' | 'subagent'
  /** Legacy background Creator Session; absent when the source Session owns authoring. */
  creatorSessionId?: string
  /** Source timeline floor used only while routing the interaction. */
  sourceStartSeq?: number
  /** Durable source Tool-result order used to reject older recovered routes. */
  sourceRouteSeq?: number
  /** Durable authoring lifecycle start paired with the source or legacy Creator Session. */
  startSeq?: number
  /** Delegation rows present before a recoverable Subagent task started. */
  baselineDelegationRowIds?: readonly string[]
  proposalTurnEndSeq?: number
  /** Durable terminal projection; absent while the interaction remains active. */
  terminal?: {
    outcome: 'completed' | 'failed' | 'cancelled'
    endSeq: number
    message?: string
  }
}

/** Settled routing and proposal facts projected from one capability conversation. */
export interface BlueprintCapabilityObservation {
  sessionId: string
  running: boolean
  stopped: boolean
  waitingFor: 'question' | 'approval' | null
  /** Exact pending carrier selected by the same approval-first policy as `waitingFor`. */
  pendingInteraction?: PendingInteraction | null
  lastTurnEnd: { seq: number; reason: BlueprintCreatorTurnEndReason } | null
  proposals: readonly { seq: number; presetId: string; sourceSessionId: string; routeId: string }[]
  authoringRoutes: readonly { seq: number; route: BlueprintCapabilityAuthoringRoute }[]
}

/** Source identity returned after queuing one capability request. */
export interface BlueprintCapabilityConversationStart {
  sourceSessionId: string
  sourceStartSeq: number
}

/** Execution identity returned after starting one capability authoring lifecycle. */
export interface BlueprintCapabilityAuthoringStart {
  /** Legacy background Creator Session; absent for source-owned authoring. */
  creatorSessionId?: string
  startSeq: number
  baselineDelegationRowIds?: readonly string[]
}

/** Typed preset copy evidence recovered from one settled Tool call. */
export interface BlueprintCreatorPresetCopy {
  seq: number
  sourcePresetId: string
  targetPresetId: string
}

/** Creator association choice recovered from one settled native question. */
export interface BlueprintCreatorAssociationAnswer {
  seq: number
  strategy: Exclude<BlueprintCreatorAssociationStrategy, 'undecided'>
  existingPresetId: string | null
}

/** Preset path evidence recovered from one settled authoring Tool call. */
export interface BlueprintCreatorAuthoredPreset {
  seq: number
  presetId: string
}

/** Successfully mounted preset named by one settled Creator validation call. */
export interface BlueprintCreatorValidatedPreset {
  seq: number
  presetId: string
}

/** Minimal current-Session facts consumed by the Creator coordinator. */
export interface BlueprintCreatorObservation {
  sessionId: string
  presetId?: string
  running: boolean
  waitingFor: 'question' | 'approval' | null
  /** Exact pending carrier selected by the same approval-first policy as `waitingFor`. */
  pendingInteraction?: PendingInteraction | null
  lastTurnEnd: { seq: number; reason: BlueprintCreatorTurnEndReason } | null
  userMessages: readonly { seq: number; text: string }[]
  presetCopies: readonly BlueprintCreatorPresetCopy[]
  associationAnswers: readonly BlueprintCreatorAssociationAnswer[]
  authoredPresets: readonly BlueprintCreatorAuthoredPreset[]
  validatedPresets: readonly BlueprintCreatorValidatedPreset[]
  /** Durable typed route recovered from this Creator Session, when present. */
  creatorAuthoring?: BlueprintCreatorAuthoringRoute & {
    sourceSessionId: string
    startSeq: number
    terminal?: NonNullable<BlueprintConversationContextResult['creatorAuthoring']>['terminal']
  }
}

/** Modal surface owned by the Builder. */
export type BlueprintModal = 'try' | null

/** One user-level Blueprint target; capability identity retains its real backing node for Host context. */
export type BlueprintSelection = {
  kind: 'node'
  nodeId: string
} | {
  kind: 'capability'
  capabilityId: string
  label: string
  nodeId: string
}

/** Immutable UI projection shared by the Builder's four slot entries. */
export interface BlueprintUiState {
  phase: 'idle' | 'loading' | 'ready' | 'error'
  agents: readonly BlueprintAgentOption[]
  presetId: string
  blueprint: Blueprint | null
  /** Canonical selection used by the panel, composer, and Host context publication. */
  selection?: BlueprintSelection | null
  /** Derived backing node retained for Host publication and legacy recovery. */
  selectedNodeId: string | null
  modal: BlueprintModal
  busy: boolean
  error: string | null
  validation: BlueprintSessionValidation | null
  /** Durable Proposal cancellation facts recovered from the owning Session. */
  proposalCancellations: readonly BlueprintProposalCancellation[]
  /** Host transaction evidence for the active conversation, independent of current preset text. */
  applyReceipts?: readonly BlueprintApplyReceipt[]
  /** Prevent transient stale labels before durable outcomes have been recovered. */
  applyReceiptsLoading?: boolean
  creator: BlueprintCreatorDraft | null
  capabilityHandoff: BlueprintCapabilityHandoff | null
  /** Deterministic local walkthrough state; absent in a real Host-backed assembly. */
  demo?: BlueprintDemoFlowState
}

/** Resolve canonical production selection with legacy fixture compatibility. */
export function blueprintSelection(state: BlueprintUiState): BlueprintSelection | null {
  if (state.selection !== undefined && state.selection !== null) return state.selection
  return state.selectedNodeId === null
    ? null
    : { kind: 'node', nodeId: state.selectedNodeId }
}

/** Real projected node carried by the current user-level selection. */
export function blueprintSelectionNodeId(state: BlueprintUiState): string | null {
  return blueprintSelection(state)?.nodeId ?? null
}

/** Browser-local lifecycle flags for the scripted Blueprint walkthrough. */
export interface BlueprintDemoFlowState {
  phase: 'initial' | 'creating' | 'ready' | 'editing' | 'authoring-skill' | 'authoring-subagent' | 'testing' | 'complete'
  hasModifiedPurpose: boolean
  hasCsvSkill: boolean
  hasIndustrySubagent: boolean
  applyingNodeIds: readonly string[]
  pendingCapability: 'skill' | 'subagent' | null
  testStatus: 'idle' | 'running' | 'verified'
}

/** Generated Blueprint Remote methods used by the controller. */
export interface BlueprintRemote {
  get(request: BlueprintGetRequest): Promise<RemoteResult<Blueprint>>
  applyChangeSet(request: BlueprintApplyChangeSetRequest): Promise<RemoteResult<BlueprintApplyChangeSetResult>>
  setConversationContext(
    request: BlueprintConversationContextRequest,
  ): Promise<RemoteResult<BlueprintConversationContextResult>>
}

/** Expected Blueprint state carried into one newly created trial Session. */
export type BlueprintTrialRequest = {
  /** Preset selected in the visible Blueprint. */
  presetId: string
  /** Revision visible when the trial Session is requested. */
  expectedRevision: string
  /** Keep an internal conformance Session in the background during capability authoring. */
  open?: boolean
} & ({
  /** Source Session that durably owns the matching committed Change Set. */
  sourceSessionId: string
  /** Source interaction route that produced the matching committed Change Set. */
  routeId: string
  /** Matching committed Change Set selected from the latest durable Apply terminal. */
  changeSetId: string
} | {
  sourceSessionId?: never
  routeId?: never
  changeSetId?: never
})

/** Runtime-conformance failure associated with the exact Trial Session that was already opened. */
export class BlueprintTrialValidationError extends Error {
  /** Trial destination that owns the failure presentation. */
  readonly sessionId: string

  /**
   * @param sessionId - Trial Session whose post-readiness validation failed.
   * @param cause - Host or transport failure to normalize for the visible Trial.
   */
  constructor(sessionId: string, cause: unknown) {
    super(messageOf(cause))
    this.name = 'BlueprintTrialValidationError'
    this.sessionId = sessionId
  }
}

const INITIAL: BlueprintUiState = {
  phase: 'idle', agents: [], presetId: '', blueprint: null, selection: null, selectedNodeId: null,
  modal: null, busy: false, error: null, validation: null,
  proposalCancellations: [],
  creator: null,
  capabilityHandoff: null,
}

const TRANSIENT_TARGET_PREFERENCE: BlueprintTargetPreference = {
  read: () => null,
  write: () => {},
  clear: () => {},
}

interface ForegroundOwner {
  sourceSessionId: string | undefined
  generation: number
}

interface CreatorRecord extends Omit<BlueprintCreatorDraft, 'targetPresetId'> {
  executionSessionId: string
  lifecycleVersion: number
  triggerSeq: number
  completionFloorSeq: number
  baselineIds: ReadonlySet<string>
  baselineResolved: boolean
  hasRun: boolean
  authoredPresetIds: ReadonlySet<string>
  validatedPresetIds: ReadonlySet<string>
  copiedPresetIds: ReadonlySet<string>
  presetCopySources: ReadonlyMap<string, string>
  createdPresetIds: ReadonlySet<string>
  associationStrategy: BlueprintCreatorAssociationStrategy
  existingPresetId: string | null
  targetPresetId: string | null
  blueprintRevealed: boolean
  running: boolean
  lastTurnEnd: BlueprintCreatorObservation['lastTurnEnd']
}

function remoteValue<T>(result: RemoteResult<T>, operation: string): T {
  if (!result.ok) throw new Error(`${operation}: ${result.error.message}`)
  return result.value
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function capabilityIntentLabel(request: string): string {
  const normalized = request
    .replace(/^(?:我希望(?:这个 Agent|这个Agent|它)?能?|希望(?:这个 Agent|这个Agent|它)?能?|请|帮我|让(?:这个 Agent|这个Agent|它))\s*/iu, '')
    .replace(/[。！？!?]+$/u, '')
    .trim()
  const label = normalized || request
  return label.length <= 18 ? label : label.slice(0, 17).trimEnd() + '…'
}

function currentTrialReceipt(
  receipts: readonly BlueprintApplyReceipt[],
  sourceSessionId: string | undefined,
  presetId: string,
  committedRevision: string,
): BlueprintApplyReceipt | undefined {
  if (sourceSessionId === undefined) return undefined
  let latest: BlueprintApplyReceipt | undefined
  for (const receipt of receipts) {
    const result = receipt.result
    if (receipt.sourceSessionId !== sourceSessionId || result.sourceSessionId !== sourceSessionId
      || receipt.routeId !== result.routeId || receipt.presetId !== presetId
      || result.status !== 'committed' || result.committedRevision !== committedRevision) continue
    if (latest === undefined || receipt.terminalSeq > latest.terminalSeq) latest = receipt
  }
  return latest
}

/** Coordinates roster reads, optimistic writes, reprojection, and trial Session creation. */
export class BlueprintUiController {
  /** Stable observable consumed through the slots inject hook compartment. */
  readonly store: SnapshotStore<BlueprintUiState> = createSnapshotStore(INITIAL)

  private loadPromise: { generation: number; promise: Promise<void> } | null = null
  private foregroundGeneration = 0
  private readonly creatorRecords = new Map<string, CreatorRecord>()
  private readonly pendingCreatorRoutes = new Map<string, BlueprintCreatorAuthoringRoute>()
  private readonly terminalCreatorTasks = new Map<string, { routeId: string; startSeq: number }>()
  private readonly capabilityHandoffs = new Map<string, BlueprintCapabilityHandoff>()
  private readonly capabilityAuthoringSessions = new Map<string, number | null>()
  private readonly capabilityCancelRequests = new Set<string>()
  private readonly capabilityCancelDispatches = new Set<string>()
  private creatorReconcile: Promise<void> | null = null
  private readonly skillReconciles = new Map<string, Promise<void>>()
  private readonly subagentReconciles = new Map<string, Promise<void>>()
  private readonly pendingCreatorReconciles = new Set<string>()
  private explicitSelectionPresetId: string | null = null
  private explicitSelectionSessionId: string | null = null
  private activeSessionId: string | undefined
  private activeRuntimePresetId: string | undefined
  private projectedSessionId: string | undefined

  /**
   * @param catalog - provider-owned Agent roster and initial target preference.
   * @param remote - generated Blueprint Host Remote.
   * @param reveal - opens the existing details column after a target loads.
   * @param syncConversationContext - scopes the current Blueprint context to the active conversation.
   * @param startTrialSession - creates and validates a new Session using the expected target projection.
   * @param startCapabilityConversation - sends one explicit UI-originated capability intent to a target-bound Session.
   * @param startCapabilityAuthoring - starts source-owned authoring or the legacy worker fallback.
   * @param startDemoTrialSession - optional Demo-only Session handoff that produces no runtime-conformance result.
   * @param cancelCapabilityAuthoring - optional live-turn cancellation for a legacy Creator Session.
   * @param targetPreference - id-only persistence for the last valid ordinary Blueprint target.
   * @param cancelProposalDecision - Host-backed durable Proposal cancellation.
   */
  constructor(
    private readonly catalog: BlueprintAgentCatalog,
    private readonly remote: BlueprintRemote,
    private readonly reveal: () => void,
    private readonly publishConversationContext: (
      sessionId: string | undefined,
      blueprint: Blueprint | null,
      selectedNodeId: string | null,
      creatorDraft?: BlueprintCreatorDraft,
      userChange?: BlueprintUserChangeInput,
      directEditInput?: BlueprintStructuredEditInput,
      isCurrent?: () => boolean,
    ) => Promise<void>,
    private readonly startTrialSession: (request: BlueprintTrialRequest) => Promise<BlueprintSessionValidation>,
    private readonly startCapabilityConversation: (
      handoff: BlueprintCapabilityHandoff,
    ) => Promise<BlueprintCapabilityConversationStart>,
    private readonly startCapabilityAuthoring: (
      route: BlueprintCapabilityAuthoringRoute,
    ) => Promise<BlueprintCapabilityAuthoringStart>,
    private readonly startDemoTrialSession?: (request: BlueprintTrialRequest) => Promise<void>,
    private readonly cancelCapabilityAuthoring?: (sessionId: string) => Promise<void>,
    private readonly targetPreference: BlueprintTargetPreference = TRANSIENT_TARGET_PREFERENCE,
    private readonly cancelProposalDecision?: (
      changeSet: BlueprintChangeSet,
    ) => Promise<RemoteResult<BlueprintProposalCancellation>>,
  ) {}

  /**
   * Make one Session's durable runtime identity the default Blueprint owner.
   * @param sessionId - current Session, absent in the New Session view.
   * @param runtimePresetId - preset echoed by the Host for that Session.
   * @returns completion after the right-hand projection converges.
   */
  async activateSession(sessionId: string | undefined, runtimePresetId: string | undefined): Promise<void> {
    const previousSessionId = this.activeSessionId
    const sessionChanged = sessionId !== previousSessionId
    const runtimeChanged = runtimePresetId !== this.activeRuntimePresetId
    const changed = sessionChanged || runtimeChanged
    this.activeSessionId = sessionId
    this.activeRuntimePresetId = runtimePresetId
    if (changed) {
      this.foregroundGeneration++
      this.explicitSelectionPresetId = null
      this.explicitSelectionSessionId = null
      this.projectedSessionId = undefined
      const creator = sessionId === undefined ? undefined : this.creatorRecords.get(sessionId)
      const pendingCreator = sessionId === undefined ? undefined : this.pendingCreatorRoutes.get(sessionId)
      this.patch({
        phase: 'loading', presetId: '', blueprint: null, selection: null,
        applyReceipts: [], proposalCancellations: [], applyReceiptsLoading: sessionId !== undefined,
        creator: creator === undefined
          ? pendingCreator === undefined || sessionId === undefined
            ? null
            : this.pendingCreatorDraft(sessionId, pendingCreator)
          : this.publicCreator(creator),
        capabilityHandoff: sessionId === undefined ? null : this.capabilityHandoffs.get(sessionId) ?? null,
        busy: false, validation: null, error: null,
      })
    }
    await this.load()
  }

  /**
   * Clear the previous Session projection and target preference while a staged preset is still composing.
   * @param sessionId - newly current blank Session awaiting the Host preset echo.
   */
  awaitSessionPreset(sessionId: string): void {
    this.targetPreference.clear(sessionId)
    this.foregroundGeneration++
    this.activeSessionId = sessionId
    this.activeRuntimePresetId = undefined
    this.explicitSelectionPresetId = null
    this.explicitSelectionSessionId = null
    this.projectedSessionId = undefined
    this.patch({
      phase: 'loading', presetId: '', blueprint: null, selection: null,
      applyReceipts: [], proposalCancellations: [], applyReceiptsLoading: true,
      creator: null, capabilityHandoff: this.capabilityHandoffs.get(sessionId) ?? null,
      busy: false, validation: null, error: null,
    })
  }

  /**
   * Read the real roster, retaining a valid selected target before choosing the initial default.
   * @returns completion after the roster and target Blueprint converge.
   */
  load(): Promise<void> {
    const owner = this.foregroundOwner()
    if (this.loadPromise?.generation === owner.generation) return this.loadPromise.promise
    const promise = this.loadNow(owner).finally(() => {
      if (this.loadPromise?.promise === promise) this.loadPromise = null
    })
    this.loadPromise = { generation: owner.generation, promise }
    return promise
  }

  /**
   * Select an Agent preset and reproject its Blueprint.
   * @param presetId - roster id to project.
   * @returns completion after the projection succeeds or records an error.
   */
  async selectPreset(presetId: string): Promise<void> {
    const owner = this.foregroundOwner()
    const creator = this.store.getSnapshot().creator
    const previous = this.store.getSnapshot()
    if (presetId === '' || previous.busy
      || (creator !== null && creator.status !== 'ready') || this.capabilityExecutionLocked()) return
    this.patch({
      phase: 'loading', presetId, blueprint: null, selection: null,
      capabilityHandoff: this.foregroundCapability(),
      error: null, validation: null,
    })
    try {
      const blueprint = remoteValue(await this.remote.get({ presetId }), 'blueprint.get')
      if (!this.ownsForeground(owner)) return
      this.explicitSelectionPresetId = presetId
      this.explicitSelectionSessionId = owner.sourceSessionId ?? null
      this.targetPreference.write(blueprint.preset.id, owner.sourceSessionId)
      this.patch({ phase: 'ready', blueprint, creator: null })
      this.projectedSessionId = owner.sourceSessionId
      await this.syncConversationContext(this.modelContextBlueprint(blueprint, null), null, undefined, undefined, undefined, owner)
      if (!this.ownsForeground(owner)) return
      this.reveal()
    } catch (error) {
      if (this.ownsForeground(owner)) this.patch({ phase: 'error', error: messageOf(error) })
    }
  }

  /**
   * Select one Blueprint node as optional conversation context.
   * @param nodeId - projected node identity.
   */
  selectNode(nodeId: string): void {
    const owner = this.foregroundOwner()
    const state = this.store.getSnapshot()
    if (state.blueprint?.nodes.some(node => node.id === nodeId) !== true) return
    const current = blueprintSelection(state)
    const selection: BlueprintSelection | null = current?.kind === 'node' && current.nodeId === nodeId
      ? null
      : { kind: 'node', nodeId }
    this.patch({ selection })
    void this.syncConversationContext(
      state.blueprint,
      selection?.nodeId ?? null,
      state.creator?.status === 'ready' ? undefined : state.creator ?? undefined,
      undefined,
      undefined,
      owner,
    ).catch((error: unknown) => {
      if (this.ownsForeground(owner)) this.patch({ error: messageOf(error) })
    })
  }

  /**
   * Select one semantic capability while retaining its real Host-context node.
   * @param capabilityId - stable capability identity used by the Blueprint selection.
   * @param label - user-visible capability label retained by the composer.
   * @param nodeId - projected Host node that owns the capability.
   */
  selectCapability(capabilityId: string, label: string, nodeId: string): void {
    const owner = this.foregroundOwner()
    const state = this.store.getSnapshot()
    if (state.blueprint?.nodes.some(node => node.id === nodeId) !== true) return
    const current = blueprintSelection(state)
    const selection: BlueprintSelection | null = current?.kind === 'capability'
      && current.capabilityId === capabilityId
      ? null
      : { kind: 'capability', capabilityId, label, nodeId }
    this.patch({ selection })
    void this.syncConversationContext(
      state.blueprint,
      selection?.nodeId ?? null,
      state.creator?.status === 'ready' ? undefined : state.creator ?? undefined,
      undefined,
      undefined,
      owner,
    ).catch((error: unknown) => {
      if (this.ownsForeground(owner)) this.patch({ error: messageOf(error) })
    })
  }

  /** Clear the optional conversation context selection. */
  clearSelection(): void {
    const owner = this.foregroundOwner()
    const state = this.store.getSnapshot()
    this.patch({ selection: null })
    void this.syncConversationContext(
      state.blueprint,
      null,
      state.creator?.status === 'ready' ? undefined : state.creator ?? undefined,
      undefined,
      undefined,
      owner,
    ).catch((error: unknown) => {
      if (this.ownsForeground(owner)) this.patch({ error: messageOf(error) })
    })
  }

  /**
   * Hand one user-stated capability goal to the active conversation without choosing its implementation.
   * @param request - plain-language outcome the user wants the Agent to support.
   * @returns completion after the visible user intent is durably queued to the Session.
   */
  async beginCapabilityHandoff(request: string): Promise<void> {
    const owner = this.foregroundOwner()
    const state = this.store.getSnapshot()
    const sourceSessionId = owner.sourceSessionId
    const active = sourceSessionId === undefined ? undefined : this.capabilityHandoffs.get(sourceSessionId)
    if (state.blueprint === null || state.busy || sourceSessionId === undefined
      || this.creatorLocked() || (active !== undefined && active.terminal === undefined)) return
    const normalized = request.trim()
    if (normalized.length === 0) return
    if (normalized.length > 500) {
      this.patch({ error: '请把能力需求控制在 500 个字以内。' })
      return
    }
    const handoff: BlueprintCapabilityHandoff = {
      sourceSessionId,
      routeId: crypto.randomUUID(),
      request: normalized,
      label: capabilityIntentLabel(normalized),
      targetPresetId: state.blueprint.preset.id,
      revision: state.blueprint.revision,
      status: 'configuring',
    }
    this.setCapabilityHandoff(handoff)
    this.patch({ selection: null, error: null })
    try {
      await this.syncConversationContext(
        state.blueprint,
        null,
        state.creator?.status === 'ready' ? undefined : state.creator ?? undefined,
        undefined,
        undefined,
        owner,
      )
      if (!this.ownsForeground(owner)) {
        this.deleteCapabilityHandoff(sourceSessionId, handoff.routeId)
        return
      }
      const started = await this.startCapabilityConversation(handoff)
      if (started.sourceSessionId !== sourceSessionId) {
        throw new Error('Capability request entered a different source Session.')
      }
      if (this.capabilityHandoffIsCurrent(handoff)) {
        this.setCapabilityHandoff({ ...handoff, sourceStartSeq: started.sourceStartSeq })
      }
    } catch (error) {
      this.deleteCapabilityHandoff(sourceSessionId, handoff.routeId)
      if (this.ownsForeground(owner)) this.patch({ error: messageOf(error) })
    }
  }

  /** Clear or durably cancel the active capability-to-conversation handoff. */
  clearCapabilityHandoff(): void {
    const owner = this.foregroundOwner()
    const handoff = this.store.getSnapshot().capabilityHandoff
    if (handoff === null) return
    if (handoff.terminal !== undefined) return
    if (this.store.getSnapshot().blueprint?.preset.id === handoff.targetPresetId) {
      this.targetPreference.write(handoff.targetPresetId, this.activeSessionId)
    }
    if (handoff.status === 'configuring'
      || (handoff.status === 'authoring' && handoff.startSeq === undefined)) {
      this.capabilityCancelRequests.add(this.capabilityLifecycleKey(handoff))
      this.patch({})
      return
    }
    if (handoff.status !== 'authoring') {
      this.deleteCapabilityHandoff(handoff.sourceSessionId, handoff.routeId)
      return
    }
    this.capabilityCancelRequests.add(this.capabilityLifecycleKey(handoff))
    this.dispatchCapabilityCancellation(handoff, owner)
  }

  /**
   * Restore one active capability task from Host-replayed Session evidence.
   * @param executionSessionId - source Session or legacy Creator Session that owns the task.
   * @param recovered - durable target, request, mechanism, and start sequence.
   * @param waitingFor - current native interaction blocking the Session, if any.
   * @param sourceRouteSeq - durable source ordering used to reject older recovered routes.
   * @param pendingInteraction - exact Client carrier for that interaction, if any.
   * @returns completion after task ownership is restored without publishing its unverified candidate.
   */
  async restoreCapabilityAuthoring(
    executionSessionId: string,
    recovered: NonNullable<BlueprintConversationContextResult['capabilityAuthoring']>,
    waitingFor: BlueprintCapabilityObservation['waitingFor'],
    sourceRouteSeq?: number,
    pendingInteraction: BlueprintCapabilityObservation['pendingInteraction'] = null,
  ): Promise<boolean> {
    const handoff: BlueprintCapabilityHandoff = {
      sourceSessionId: recovered.sourceSessionId,
      routeId: recovered.routeId,
      request: recovered.request,
      label: capabilityIntentLabel(recovered.request),
      targetPresetId: recovered.targetPresetId,
      revision: recovered.baseRevision,
      status: 'authoring',
      authoringKind: recovered.kind,
      ...(executionSessionId === recovered.sourceSessionId
        ? {}
        : { creatorSessionId: executionSessionId }),
      startSeq: recovered.startSeq,
      ...(sourceRouteSeq === undefined ? {} : { sourceRouteSeq }),
      baselineDelegationRowIds: recovered.baselineDelegationRowIds,
      ...(waitingFor === 'question' ? { waitingFor: 'input' as const }
        : waitingFor === 'approval' ? { waitingFor: 'approval' as const } : {}),
      ...(pendingInteraction === null ? {} : { pendingInteraction }),
    }
    if (!this.setCapabilityHandoff(handoff)) return false
    this.capabilityAuthoringSessions.set(executionSessionId, null)
    if (executionSessionId !== recovered.sourceSessionId) {
      this.creatorRecords.delete(executionSessionId)
      this.pendingCreatorReconciles.delete(executionSessionId)
    }
    if (this.capabilityCancelRequests.has(this.capabilityLifecycleKey(handoff))) {
      this.dispatchCapabilityCancellation(handoff, this.foregroundOwner())
    }
    const owner = this.foregroundOwner()
    if (owner.sourceSessionId !== recovered.sourceSessionId) return true
    if (executionSessionId !== recovered.sourceSessionId) {
      this.patch({ phase: 'ready', creator: null, error: null })
      if (this.store.getSnapshot().blueprint !== null) this.reveal()
      return true
    }
    try {
      const blueprint = remoteValue(
        await this.remote.get({ presetId: recovered.targetPresetId }),
        'blueprint.get during capability authoring recovery',
      )
      if (!this.ownsForeground(owner)) return true
      this.patch({
        phase: 'ready', presetId: blueprint.preset.id, blueprint, selection: null,
        creator: null, error: null,
      })
      this.targetPreference.write(blueprint.preset.id, owner.sourceSessionId)
      this.reveal()
      return true
    } catch (error) {
      if (this.ownsForeground(owner)) this.patch({ error: messageOf(error) })
      return false
    }
  }

  /**
   * Restore one source-owned terminal projection from its durable lifecycle.
   * @param executionSessionId - source Session or legacy Creator Session whose task ended.
   * @param record - durable owner, route, target, mechanism, and outcome.
   * @param sourceRouteSeq - durable source ordering used to reject older recovered routes.
   * @returns completion after the source terminal is restored and any verified completion is published.
   */
  async restoreTerminalCapabilityAuthoring(
    executionSessionId: string,
    record: NonNullable<BlueprintConversationContextResult['capabilityAuthoringRecord']>,
    sourceRouteSeq?: number,
  ): Promise<boolean> {
    if (record.state !== 'ended' || record.endSeq === undefined || record.outcome === undefined) return false
    const terminal = this.terminalCapabilityHandoff(executionSessionId, record, sourceRouteSeq)
    const current = this.capabilityHandoffs.get(record.sourceSessionId)
    if (current?.routeId === terminal.routeId && current.startSeq === terminal.startSeq
      && current.terminal?.endSeq === terminal.terminal?.endSeq) return true
    if (!this.setCapabilityHandoff(terminal)) return false
    this.capabilityAuthoringSessions.set(executionSessionId, record.endSeq)
    if (executionSessionId !== record.sourceSessionId) {
      this.creatorRecords.delete(executionSessionId)
      this.pendingCreatorReconciles.delete(executionSessionId)
    }
    const owner = this.foregroundOwner()
    if (owner.sourceSessionId !== record.sourceSessionId) return true
    if (record.outcome !== 'completed' && executionSessionId !== record.sourceSessionId) return true
    try {
      const blueprint = remoteValue(
        await this.remote.get({ presetId: record.targetPresetId }),
        'blueprint.get after capability authoring recovery',
      )
      if (!this.ownsForeground(owner)) return true
      this.patch({
        phase: 'ready', presetId: blueprint.preset.id, blueprint, selection: null,
        creator: null, error: null,
      })
      this.targetPreference.write(blueprint.preset.id, owner.sourceSessionId)
      this.reveal()
      return true
    } catch (error) {
      if (this.ownsForeground(owner)) this.patch({ error: messageOf(error) })
      return false
    }
  }

  /**
   * Fold proposal and authoring-route results into the finite capability configuration lifecycle.
   * @param observation - durable facts from the currently observed Session.
   * @returns completion after route handoff or Blueprint refresh.
   */
  async observeCapability(observation: BlueprintCapabilityObservation): Promise<void> {
    let handoff = this.capabilityHandoffForObservation(observation.sessionId)
    if (handoff === undefined) {
      const settledRoute = observation.running || observation.lastTurnEnd === null
        ? undefined
        : observation.authoringRoutes
          .filter(candidate => candidate.route.sourceSessionId === observation.sessionId
            && observation.lastTurnEnd !== null && observation.lastTurnEnd.seq > candidate.seq)
          .at(-1)
      if (settledRoute === undefined) return
      const prior = this.capabilityHandoffs.get(settledRoute.route.sourceSessionId)
      if (prior !== undefined && (prior.terminal === undefined
        || prior.sourceRouteSeq === undefined || prior.sourceRouteSeq >= settledRoute.seq)) return
      handoff = {
        sourceSessionId: settledRoute.route.sourceSessionId,
        routeId: settledRoute.route.routeId,
        request: settledRoute.route.request,
        label: capabilityIntentLabel(settledRoute.route.request),
        targetPresetId: settledRoute.route.presetId,
        revision: settledRoute.route.revision,
        status: 'configuring',
        sourceStartSeq: Math.max(0, settledRoute.seq - 1),
        sourceRouteSeq: settledRoute.seq,
      }
      this.setCapabilityHandoff(handoff)
    }
    if (handoff.status === 'authoring') {
      if (handoff.startSeq === undefined
        || this.capabilityExecutionSessionId(handoff) !== observation.sessionId) return
      if (handoff.authoringKind === 'subagent') await this.reconcileSubagentAuthoring(handoff, observation)
      else await this.reconcileSkillAuthoring(handoff, observation)
      return
    }
    if (observation.stopped) {
      this.deleteCapabilityHandoff(handoff.sourceSessionId, handoff.routeId)
      return
    }
    const startSeq = handoff.sourceStartSeq
    if (startSeq === undefined || handoff.sourceSessionId !== observation.sessionId) return
    const waitingFor = observation.waitingFor === 'question'
      ? 'input' as const
      : observation.waitingFor === 'approval' ? 'approval' as const : undefined
    if (handoff.waitingFor !== waitingFor) {
      handoff = { ...handoff, ...(waitingFor === undefined ? {} : { waitingFor }) }
      if (waitingFor === undefined) delete handoff.waitingFor
      this.setCapabilityHandoff(handoff)
    }
    const route = observation.authoringRoutes
      .filter(candidate => candidate.seq > startSeq
        && candidate.route.routeId === handoff.routeId
        && candidate.route.sourceSessionId === handoff.sourceSessionId
        && candidate.route.presetId === handoff.targetPresetId
        && candidate.route.revision === handoff.revision)
      .at(-1)
    if (route !== undefined) {
      const routeTurnEndSeq = observation.lastTurnEnd?.seq
      if (observation.running || routeTurnEndSeq === undefined || routeTurnEndSeq <= route.seq) return
      const transitioning: BlueprintCapabilityHandoff = {
        ...handoff,
        status: 'authoring', authoringKind: route.route.kind, sourceRouteSeq: route.seq,
      }
      if (!this.setCapabilityHandoff(transitioning)) return
      try {
        const started = await this.startCapabilityAuthoring(route.route)
        const current = this.capabilityHandoffs.get(handoff.sourceSessionId)
        if (current?.routeId === handoff.routeId && current.status === 'authoring') {
          const active = { ...current, ...started }
          this.setCapabilityHandoff(active)
          if (this.capabilityCancelRequests.has(this.capabilityLifecycleKey(active))) {
            this.dispatchCapabilityCancellation(active, this.foregroundOwner())
          }
        }
      } catch (error) {
        this.deleteCapabilityHandoff(handoff.sourceSessionId, handoff.routeId)
        if (this.activeSessionId === handoff.sourceSessionId) this.patch({ error: messageOf(error) })
      }
      return
    }
    if (handoff.status === 'configuring') {
      const proposal = observation.proposals.some(candidate => candidate.seq > startSeq
        && candidate.routeId === handoff.routeId
        && candidate.sourceSessionId === handoff.sourceSessionId
        && candidate.presetId === handoff.targetPresetId)
      if (proposal) {
        if (this.capabilityCancelRequests.has(this.capabilityLifecycleKey(handoff))) {
          this.deleteCapabilityHandoff(handoff.sourceSessionId, handoff.routeId)
          return
        }
        const sourceRouteSeq = observation.proposals
          .filter(candidate => candidate.seq > startSeq
            && candidate.routeId === handoff.routeId
            && candidate.sourceSessionId === handoff.sourceSessionId
            && candidate.presetId === handoff.targetPresetId)
          .at(-1)?.seq
        const proposalTurnEndSeq = observation.running ? undefined : observation.lastTurnEnd?.seq
        this.setCapabilityHandoff({
          ...handoff,
          status: 'proposal',
          ...(sourceRouteSeq === undefined ? {} : { sourceRouteSeq }),
          ...(proposalTurnEndSeq === undefined ? {} : { proposalTurnEndSeq }),
        })
        return
      }
    }
    const end = observation.lastTurnEnd
    if (end === null || end.seq <= startSeq || observation.running) return
    if (end.reason !== 'completed') {
      this.deleteCapabilityHandoff(handoff.sourceSessionId, handoff.routeId)
      return
    }
    if (handoff.status === 'proposal' && handoff.proposalTurnEndSeq === undefined) {
      this.setCapabilityHandoff({ ...handoff, proposalTurnEndSeq: end.seq })
      return
    }
    if (handoff.status === 'proposal' && handoff.proposalTurnEndSeq !== undefined
      && end.seq <= handoff.proposalTurnEndSeq) return
    this.deleteCapabilityHandoff(handoff.sourceSessionId, handoff.routeId)
  }

  /** Publish verified Subagent completion from Host history without requiring the Creator's conversation window. */
  private reconcileSubagentAuthoring(
    handoff: BlueprintCapabilityHandoff,
    observation: BlueprintCapabilityObservation,
  ): Promise<void> {
    return this.reconcileCapabilityAuthoring(
      this.subagentReconciles,
      handoff,
      observation,
      async (isCurrent) => {
        const result = remoteValue(await this.remote.setConversationContext({
          sessionId: observation.sessionId,
          ...(observation.stopped ? { capabilityAuthoringEnd: { outcome: 'cancelled' as const } }
            : { recoverCapabilityAuthoring: true }),
        }), 'blueprint Subagent completion')
        if (!isCurrent()) return
        const record = result.capabilityAuthoringRecord
        if (record === undefined || record.startSeq !== handoff.startSeq
          || record.routeId !== handoff.routeId || record.sourceSessionId !== handoff.sourceSessionId
          || record.targetPresetId !== handoff.targetPresetId) return
        if (record.state !== 'ended') {
          const waitingFor = observation.waitingFor === 'question' ? 'input'
            : observation.waitingFor === 'approval' ? 'approval' : undefined
          if (handoff.waitingFor !== waitingFor
            || handoff.pendingInteraction !== observation.pendingInteraction) {
            const active = { ...handoff }
            if (waitingFor === undefined) delete active.waitingFor
            else active.waitingFor = waitingFor
            if (observation.pendingInteraction === null || observation.pendingInteraction === undefined) {
              delete active.pendingInteraction
            } else {
              active.pendingInteraction = observation.pendingInteraction
            }
            this.setCapabilityHandoff(active)
          }
          return
        }
        if (record.endSeq === undefined) throw new Error('Subagent capability terminal is missing endSeq')
        this.capabilityAuthoringSessions.set(observation.sessionId, record.endSeq)
        if (record.outcome === undefined) throw new Error('Subagent capability terminal is missing outcome')
        this.setCapabilityHandoff(this.terminalCapabilityHandoff(observation.sessionId, record))
        if (record.outcome !== 'completed') return
        const blueprint = remoteValue(await this.remote.get({ presetId: handoff.targetPresetId }),
          'blueprint.get after verified Subagent authoring')
        if (!isCurrent()) return
        if (this.activeSessionId === handoff.sourceSessionId) {
          this.retainTargetPreference(handoff.sourceSessionId, handoff.targetPresetId)
          this.patch({ phase: 'ready', blueprint, error: null,
            validation: record.subagentEvidence?.verification ?? null })
        }
      },
    )
  }

  /** Publish verified Skill completion from Host history without requiring the Creator's conversation window. */
  private reconcileSkillAuthoring(
    handoff: BlueprintCapabilityHandoff,
    observation: BlueprintCapabilityObservation,
  ): Promise<void> {
    return this.reconcileCapabilityAuthoring(
      this.skillReconciles,
      handoff,
      observation,
      async (isCurrent) => {
        const result = remoteValue(await this.remote.setConversationContext({
          sessionId: observation.sessionId,
          ...(observation.stopped ? { capabilityAuthoringEnd: { outcome: 'cancelled' as const } }
            : { recoverCapabilityAuthoring: true }),
        }), 'blueprint capability authoring recovery')
        if (!isCurrent()) return
        const record = result.capabilityAuthoringRecord
        if (record === undefined || record.startSeq !== handoff.startSeq
          || record.routeId !== handoff.routeId || record.sourceSessionId !== handoff.sourceSessionId
          || record.targetPresetId !== handoff.targetPresetId) return
        if (record.state !== 'ended') {
          const current = this.capabilityHandoffs.get(handoff.sourceSessionId)
          if (current?.routeId !== handoff.routeId) return
          const {
            waitingFor: _previousWait,
            pendingInteraction: _previousPendingInteraction,
            ...active
          } = current
          this.setCapabilityHandoff({
            ...active,
            ...(observation.waitingFor === 'approval' ? { waitingFor: 'approval' as const }
              : observation.waitingFor === 'question' ? { waitingFor: 'input' as const } : {}),
            ...(observation.pendingInteraction === null || observation.pendingInteraction === undefined
              ? {}
              : { pendingInteraction: observation.pendingInteraction }),
          })
          return
        }
        if (record.endSeq === undefined) throw new Error('Capability authoring terminal record is missing endSeq')
        this.capabilityAuthoringSessions.set(observation.sessionId, record.endSeq)
        if (record.outcome === undefined) throw new Error('Capability authoring terminal record is missing outcome')
        this.setCapabilityHandoff(this.terminalCapabilityHandoff(observation.sessionId, record))
        if (record.outcome !== 'completed') return
        const blueprint = remoteValue(await this.remote.get({ presetId: handoff.targetPresetId }),
          'blueprint.get after verified Skill authoring')
        if (!isCurrent()) return
        if (this.activeSessionId === handoff.sourceSessionId) {
          this.retainTargetPreference(handoff.sourceSessionId, handoff.targetPresetId)
          this.patch({ phase: 'ready', blueprint, error: null })
        }
      },
    )
  }

  private reconcileCapabilityAuthoring(
    pendingByTask: Map<string, Promise<void>>,
    handoff: BlueprintCapabilityHandoff,
    observation: BlueprintCapabilityObservation,
    operation: (isCurrent: () => boolean) => Promise<void>,
  ): Promise<void> {
    const key = `${observation.sessionId}:${String(handoff.startSeq)}`
    const pending = pendingByTask.get(key)
    if (pending !== undefined) return pending
    const isCurrent = (): boolean => {
      return this.capabilityHandoffIsCurrent(handoff)
    }
    const reconcile = operation(isCurrent).catch((error: unknown) => {
      if (!isCurrent() || this.activeSessionId !== handoff.sourceSessionId) return
      const current = this.capabilityHandoffs.get(handoff.sourceSessionId)
      if (current?.routeId === handoff.routeId && current.status !== 'completed'
        && current.status !== 'failed' && current.status !== 'cancelled') return
      this.patch({ error: messageOf(error) })
    }).finally(() => { pendingByTask.delete(key) })
    pendingByTask.set(key, reconcile)
    return reconcile
  }

  /**
   * Re-apply the current Blueprint context after the active Session changes.
   * @returns whether the exact foreground owner retained a successfully installed context.
   */
  async syncConversation(): Promise<boolean> {
    const owner = this.foregroundOwner()
    const state = this.store.getSnapshot()
    const creatorDraft = state.creator?.status === 'ready' ? undefined : state.creator ?? undefined
    const blueprint = this.modelContextBlueprint(state.blueprint, state.creator)
    try {
      await this.syncConversationContext(
        blueprint,
        blueprint === null ? null : blueprintSelectionNodeId(state),
        creatorDraft,
        undefined,
        undefined,
        owner,
      )
      return this.ownsForeground(owner)
    } catch (error) {
      if (this.ownsForeground(owner)) this.patch({ error: messageOf(error) })
      return false
    }
  }

  /**
   * Clear the old target as soon as a typed new-Agent route enters continuation.
   * @param sourceSessionId - conversation that produced the routing decision.
   * @param route - language-neutral create-agent request accepted by the Host.
   */
  beginCreatorAuthoringRoute(sourceSessionId: string, route: BlueprintCreatorAuthoringRoute): void {
    if (!this.ownsCreatorForeground(sourceSessionId)) return
    this.pendingCreatorRoutes.set(sourceSessionId, route)
    if (this.activeRuntimePresetId !== 'cordis') {
      this.patch({
        phase: 'loading', presetId: '', blueprint: null, selection: null,
        creator: null, capabilityHandoff: null, validation: null, error: null,
      })
      return
    }
    this.patch({
      phase: 'ready', presetId: '', blueprint: null, selection: null, modal: null,
      capabilityHandoff: null, validation: null, error: null,
      creator: {
        sessionId: sourceSessionId,
        routeId: route.routeId,
        name: route.name,
        status: 'creating',
        candidateIds: [],
        waitingFor: null,
      },
    })
    this.reveal()
  }

  /**
   * Restore the source view after its typed Creator continuation cannot start.
   * @param sourceSessionId - Session that initiated the failed handoff.
   * @param error - continuation failure; ignored when its source is no longer foreground.
   */
  failCreatorAuthoringRoute(sourceSessionId: string, error: unknown): void {
    this.pendingCreatorRoutes.delete(sourceSessionId)
    if (!this.ownsCreatorForeground(sourceSessionId)) return
    this.explicitSelectionPresetId = null
    this.patch({ creator: null, error: messageOf(error) })
  }

  /**
   * Fold the current Creator Session into its session-scoped Draft lifecycle.
   * @param observation - current preset, interaction, activity, request, and authored-path facts.
   * @returns completion after any real roster candidates have been validated.
   */
  async observeCreator(observation: BlueprintCreatorObservation): Promise<void> {
    const typedRequest = observation.creatorAuthoring
    const ownerSessionId = typedRequest?.sourceSessionId ?? observation.sessionId
    if (!this.ownsCreatorForeground(ownerSessionId)) return
    const generation = this.foregroundGeneration
    if (observation.presetId !== 'cordis') return
    if (this.explicitSelectionPresetId !== null && this.explicitSelectionPresetId !== 'cordis') return
    const latestUserMessage = observation.userMessages.at(-1)
    const capabilityEndSeq = this.capabilityAuthoringSessions.get(observation.sessionId)
    if (capabilityEndSeq !== undefined) {
      if (capabilityEndSeq === null || latestUserMessage === undefined || latestUserMessage.seq <= capabilityEndSeq) return
      this.capabilityAuthoringSessions.delete(observation.sessionId)
    }
    let record = this.creatorRecords.get(ownerSessionId)
    const ended = this.terminalCreatorTasks.get(ownerSessionId)
    if (ended !== undefined && (typedRequest === undefined || typedRequest.routeId === ended.routeId
      || typedRequest.startSeq <= ended.startSeq)) return
    if (typedRequest !== undefined && record !== undefined
      && (typedRequest.startSeq < record.triggerSeq
        || (typedRequest.routeId === record.routeId && typedRequest.startSeq !== record.triggerSeq))) return
    // A newer message is not a new task. Typed authoring never falls back to Session text scanning.
    const newTypedTask = typedRequest !== undefined && typedRequest.routeId !== record?.routeId
      && (record === undefined || typedRequest.startSeq > record.triggerSeq)
    if (record?.status === 'ready' && !newTypedTask) return
    const request = typedRequest === undefined
      ? record?.routeId === undefined ? latestCreatorRequest(observation.userMessages) : null
      : { seq: typedRequest.startSeq, name: typedRequest.name }
    if (request !== null && (record === undefined || newTypedTask
      || (typedRequest === undefined && record.routeId === undefined && request.seq > record.triggerSeq))) {
      const lifecycleVersion = (record?.lifecycleVersion ?? 0) + 1
      const presetCopies = observation.presetCopies.filter(copy => copy.seq > request.seq)
      const copiedPresetIds = new Set(presetCopies.map(copy => copy.targetPresetId))
      const presetCopySources = copySourceMap(presetCopies)
      const authoredPresetIds = new Set([
        ...observation.authoredPresets.filter(evidence => evidence.seq > request.seq).map(evidence => evidence.presetId),
        ...copiedPresetIds,
      ])
      const validatedPresetIds = new Set(
        observation.validatedPresets.filter(evidence => evidence.seq > request.seq).map(evidence => evidence.presetId),
      )
      const createdPresetIds = recoverCreatedPresetIds(observation, request.seq)
      const agents = this.store.getSnapshot().agents
      const answer = observation.associationAnswers.filter(candidate => candidate.seq > request.seq).at(-1)
      record = {
        lifecycleVersion,
        sessionId: ownerSessionId,
        executionSessionId: observation.sessionId,
        ...(typedRequest === undefined ? {} : { routeId: typedRequest.routeId }),
        name: request.name,
        status: 'creating',
        candidateIds: [],
        waitingFor: observation.waitingFor,
        ...(observation.pendingInteraction === null || observation.pendingInteraction === undefined
          ? {}
          : { pendingInteraction: observation.pendingInteraction }),
        triggerSeq: request.seq,
        completionFloorSeq: request.seq,
        baselineIds: new Set(agents.filter(agent => !createdPresetIds.has(agent.id)).map(agent => agent.id)),
        baselineResolved: agents.length > 0,
        hasRun: observation.running,
        authoredPresetIds,
        validatedPresetIds,
        copiedPresetIds,
        presetCopySources,
        createdPresetIds,
        associationStrategy: answer?.strategy ?? 'undecided',
        existingPresetId: answer?.existingPresetId ?? null,
        targetPresetId: null,
        blueprintRevealed: false,
        running: observation.running,
        lastTurnEnd: observation.lastTurnEnd,
      }
      this.pendingCreatorRoutes.delete(ownerSessionId)
      this.creatorRecords.set(ownerSessionId, record)
      if (typedRequest?.terminal === undefined) this.patch({
        phase: 'ready', presetId: '', blueprint: null, selection: null, modal: null,
        capabilityHandoff: null, validation: null, error: null, creator: this.publicCreator(record),
      })
      if (typedRequest?.terminal === undefined) {
        const owner = { sourceSessionId: ownerSessionId, generation }
        await this.syncConversationContext(
          null, null, this.publicCreator(record), undefined, undefined, owner,
        ).catch((error: unknown) => {
          if (this.ownsCreatorForeground(ownerSessionId, generation)) this.patch({ error: messageOf(error) })
        })
      }
      if (!this.creatorRecordIsCurrent(ownerSessionId, record, generation)) return
      this.reveal()
    }
    if (record === undefined) return

    const terminal = typedRequest?.terminal
    if (terminal !== undefined && terminal.routeId === record.routeId && terminal.startSeq === record.triggerSeq) {
      if (terminal.outcome !== 'completed') {
        this.creatorRecords.delete(ownerSessionId)
        this.pendingCreatorRoutes.delete(ownerSessionId)
        this.terminalCreatorTasks.set(ownerSessionId, { routeId: terminal.routeId, startSeq: terminal.startSeq })
        this.patch({ creator: null })
        return
      }
      record = {
        ...record, targetPresetId: terminal.targetPresetId, candidateIds: [terminal.targetPresetId],
        validatedPresetIds: new Set([...record.validatedPresetIds, terminal.targetPresetId]),
        running: false, waitingFor: null, completionFloorSeq: record.triggerSeq,
        lastTurnEnd: { seq: terminal.turnEndSeq, reason: 'completed' },
      }
      delete record.pendingInteraction
      this.creatorRecords.set(ownerSessionId, record)
      await this.reconcileCreator(ownerSessionId)
      return
    }

    const currentRecord = record
    const answer = observation.associationAnswers.filter(candidate => candidate.seq > currentRecord.triggerSeq).at(-1)
    const presetCopies = observation.presetCopies.filter(copy => copy.seq > currentRecord.triggerSeq)
    const copiedPresetIds = new Set([...currentRecord.copiedPresetIds, ...presetCopies.map(copy => copy.targetPresetId)])
    const presetCopySources = new Map([
      ...currentRecord.presetCopySources,
      ...copySourceMap(presetCopies),
    ])
    const authoredPresetIds = new Set([
      ...currentRecord.authoredPresetIds,
      ...observation.authoredPresets
        .filter(evidence => evidence.seq > currentRecord.triggerSeq)
        .map(evidence => evidence.presetId),
      ...copiedPresetIds,
    ])
    const validatedPresetIds = new Set([
      ...currentRecord.validatedPresetIds,
      ...observation.validatedPresets
        .filter(evidence => evidence.seq > currentRecord.triggerSeq)
        .map(evidence => evidence.presetId),
    ])
    const createdPresetIds = new Set([
      ...currentRecord.createdPresetIds,
      ...recoverCreatedPresetIds(observation, currentRecord.triggerSeq),
    ])
    const interactionFloor = observation.waitingFor === null ? 0 : observation.lastTurnEnd?.seq ?? 0
    const { pendingInteraction: _previousPendingInteraction, ...recordWithoutPendingInteraction } = record
    record = {
      ...recordWithoutPendingInteraction,
      lifecycleVersion: record.lifecycleVersion + 1,
      completionFloorSeq: Math.max(
        record.completionFloorSeq,
        latestUserMessage?.seq ?? 0,
        interactionFloor,
      ),
      hasRun: record.hasRun || observation.running || observation.lastTurnEnd !== null,
      authoredPresetIds,
      validatedPresetIds,
      copiedPresetIds,
      presetCopySources,
      createdPresetIds,
      baselineIds: new Set([...record.baselineIds].filter(presetId => !createdPresetIds.has(presetId))),
      associationStrategy: answer?.strategy ?? record.associationStrategy,
      existingPresetId: answer?.existingPresetId ?? record.existingPresetId,
      waitingFor: observation.waitingFor,
      ...(observation.pendingInteraction === null || observation.pendingInteraction === undefined
        ? {}
        : { pendingInteraction: observation.pendingInteraction }),
      running: observation.running,
      lastTurnEnd: observation.lastTurnEnd,
    }
    if (!associationStillAllowed(record)) {
      record = { ...record, targetPresetId: null, candidateIds: [], blueprintRevealed: false }
      this.patch({ presetId: '', blueprint: null, selection: null })
    }
    const previousStatus = record.status
    if (record.status !== 'ready') record.status = this.nonReadyCreatorStatus(record)
    this.creatorRecords.set(ownerSessionId, record)
    this.patch({ creator: this.publicCreator(record) })
    if (record.status !== previousStatus && record.status !== 'ready') {
      const state = this.store.getSnapshot()
      await this.syncConversationContext(
        state.blueprint,
        blueprintSelectionNodeId(state),
        this.publicCreator(record),
        undefined,
        undefined,
        { sourceSessionId: ownerSessionId, generation },
      ).catch((error: unknown) => {
        if (this.ownsCreatorForeground(ownerSessionId, generation)) this.patch({ error: messageOf(error) })
      })
    }
    if (!this.creatorRecordIsCurrent(ownerSessionId, record, generation)) return
    await this.reconcileCreator(ownerSessionId)
  }

  /** Recheck the current Creator Draft while the model is running or waiting. */
  pollCreator(): Promise<void> {
    const creator = this.store.getSnapshot().creator
    if (creator === null || creator.status === 'ready') return Promise.resolve()
    return this.reconcileCreator(creator.sessionId)
  }

  /**
   * Open one Builder modal.
   * @param modal - trial confirmation.
   */
  openModal(modal: Exclude<BlueprintModal, null>): void {
    if (this.interactionLocked()) return
    this.patch({ modal })
  }

  /** Close the current Builder modal. */
  closeModal(): void {
    this.patch({ modal: null })
  }

  private async enqueueStructuredEdit(
    blueprint: Blueprint,
    directEditInput: BlueprintStructuredEditInput,
    owner: ForegroundOwner,
  ): Promise<void> {
    this.patch({ busy: true, selection: { kind: 'node', nodeId: directEditInput.nodeId }, error: null, validation: null })
    try {
      await this.syncConversationContext(
        blueprint, directEditInput.nodeId, undefined, undefined, directEditInput, owner,
      )
      if (!this.ownsForeground(owner)) {
        throw new Error('修改所属对话已不在前台，请回到原对话后重试。')
      }
      this.patch({ busy: false })
    } catch (error) {
      if (this.ownsForeground(owner)) this.patch({ busy: false, error: messageOf(error) })
      throw error
    }
  }

  /**
   * Submit one editable text draft through the source conversation's structured Proposal path.
   * @param nodeId - editable projected node identity.
   * @param value - replacement single-line text.
   * @param expectedValue - committed value shown when the editor opened.
   * @returns completion after the source Session durably accepts the interaction identity.
   */
  async updateText(nodeId: string, value: string, expectedValue: string): Promise<void> {
    if (this.interactionLocked()) return
    const owner = this.foregroundOwner()
    const state = this.store.getSnapshot()
    const blueprint = state.blueprint
    const node = blueprint?.nodes.find(candidate => candidate.id === nodeId)
    const next = value.trim()
    if (blueprint === null || node === undefined || !node.editable || next === '') return
    if (typeof node.value !== 'string' || expectedValue === next) return
    if (node.value !== expectedValue) {
      const error = new Error('这项内容已发生变化，请重新打开编辑器后再提交。')
      this.patch({ error: error.message })
      throw error
    }
    if (owner.sourceSessionId === undefined) {
      const error = new Error('请先打开一个对话，再提交修改。')
      this.patch({ error: error.message })
      throw error
    }
    if (node.type !== 'identity' && node.type !== 'purpose'
      && node.type !== 'behavior' && node.type !== 'output') return
    const directEditInput: BlueprintStructuredEditInput = {
      sourceSessionId: owner.sourceSessionId,
      routeId: crypto.randomUUID(),
      nodeId: node.id,
      nodeType: node.type,
      expectedValue,
      proposedValue: next,
    }
    await this.enqueueStructuredEdit(blueprint, directEditInput, owner)
  }

  /**
   * Submit one editable Web capability draft through the source conversation's structured Proposal path.
   * @param nodeId - Web Search or Web Fetch node identity.
   * @param enabled - requested runtime visibility.
   * @returns completion after the source Session durably accepts the interaction identity.
   */
  async setCapability(nodeId: string, enabled: boolean): Promise<void> {
    if (this.interactionLocked()) return
    const owner = this.foregroundOwner()
    const blueprint = this.store.getSnapshot().blueprint
    const node = blueprint?.nodes.find(candidate => candidate.id === nodeId)
    const value = node === undefined ? undefined : capabilityValue(node)
    if (blueprint === null || node === undefined || !node.editable || value === undefined || value.enabled === enabled) return
    const capability = node.id === 'capability:web-search'
      ? 'web-search'
      : node.id === 'capability:web-fetch' ? 'web-fetch' : undefined
    if (capability === undefined) return
    if (owner.sourceSessionId === undefined) {
      const error = new Error('请先打开一个对话，再提交修改。')
      this.patch({ error: error.message })
      throw error
    }
    const directEditInput: BlueprintStructuredEditInput = {
      sourceSessionId: owner.sourceSessionId,
      routeId: crypto.randomUUID(),
      nodeId: node.id,
      nodeType: 'capability',
      expectedValue: value.enabled,
      proposedValue: enabled,
    }
    await this.enqueueStructuredEdit(blueprint, directEditInput, owner)
  }

  /**
   * Add one projected disabled Web capability through capability authoring.
   * @param nodeId - editable Web Search or Web Fetch node identity.
   * @returns completion after the source Session accepts the capability-authoring route.
   */
  async addCapability(nodeId: string): Promise<void> {
    if (this.interactionLocked()) return
    const blueprint = this.store.getSnapshot().blueprint
    const node = blueprint?.nodes.find(candidate => candidate.id === nodeId)
    const value = node === undefined ? undefined : capabilityValue(node)
    const capability = node?.id === 'capability:web-search'
      ? 'web-search'
      : node?.id === 'capability:web-fetch' ? 'web-fetch' : undefined
    if (blueprint === null || node === undefined || !node.editable || value === undefined
      || value.enabled || capability === undefined) return
    await this.beginCapabilityHandoff(
      capability === 'web-search' ? '添加网页搜索能力' : '添加网页读取能力',
    )
  }

  /**
   * Apply one user-confirmed Change Set through the adapter-owned preset transaction.
   * @param changeSet - complete closed operation set sharing one preset revision.
   * @returns completion after commit, rejection, or guarded recovery is reflected in UI state.
   */
  async applyChangeSet(changeSet: BlueprintChangeSet): Promise<void> {
    await this.commitChangeSet(changeSet)
  }

  /**
   * Restore Host-recorded outcomes without changing the active Blueprint target.
   * @param sessionId - Session that owns the response; late responses from another Session are ignored.
   * @param receipts - durable outcomes or the just-returned Host transaction result.
   */
  restoreApplyReceipts(sessionId: string, receipts: readonly BlueprintApplyReceipt[]): void {
    if (sessionId !== this.activeSessionId) return
    const known = new Map((this.store.getSnapshot().applyReceipts ?? []).map(receipt => [JSON.stringify(receipt), receipt]))
    for (const receipt of receipts) {
      if (receipt.sourceSessionId === sessionId) known.set(JSON.stringify(receipt), receipt)
    }
    const current = this.store.getSnapshot()
    if (!current.applyReceiptsLoading && known.size === (current.applyReceipts ?? []).length) return
    this.patch({ applyReceipts: [...known.values()], applyReceiptsLoading: false })
  }

  /**
   * Restore Host-recorded Proposal cancellations for the active owning Session.
   * @param sessionId - Session whose durable log was read.
   * @param cancellations - exact source, route, Proposal, and source-result identities.
   */
  restoreProposalCancellations(
    sessionId: string,
    cancellations: readonly BlueprintProposalCancellation[],
  ): void {
    if (sessionId !== this.activeSessionId) return
    const known = new Map(this.store.getSnapshot().proposalCancellations
      .map(cancellation => [JSON.stringify(cancellation), cancellation]))
    for (const cancellation of cancellations) {
      if (cancellation.sourceSessionId === sessionId) {
        known.set(JSON.stringify(cancellation), cancellation)
      }
    }
    this.patch({ proposalCancellations: [...known.values()] })
  }

  private async commitChangeSet(
    changeSet: BlueprintChangeSet,
    userChange?: BlueprintUserChangeInput,
  ): Promise<void> {
    if (this.interactionLocked()) return
    const owner = this.foregroundOwner()
    if (this.store.getSnapshot().busy) return
    const sourceSessionId = changeSet.sourceSessionId
    const routeId = changeSet.routeId
    if (sourceSessionId !== owner.sourceSessionId) return
    const blueprint = this.store.getSnapshot().blueprint
    if (blueprint === null || blueprint.preset.id !== changeSet.presetId) return
    if (blueprint.revision !== changeSet.revision) {
      this.patch({ error: '这条修改建议已经过期，请重新提出。' })
      return
    }
    this.patch({ busy: true, error: null, validation: null })
    try {
      const operations = changeSet.proposals.map(transactionOperation)
      const result = remoteValue(await this.remote.applyChangeSet({
        sourceSessionId,
        routeId,
        changeSetId: changeSet.changeSetId,
        presetId: changeSet.presetId,
        baseRevision: changeSet.revision,
        operations,
      }), 'blueprint.applyChangeSet')
      this.deleteCapabilityDecision(changeSet)
      if (!this.ownsForeground(owner)) return
      if (result.status !== 'committed') {
        const refresh = result.status === 'reprojection_failed_recovered'
          || result.status === 'reprojection_failed_conflict'
          || result.status === 'reprojection_failed_recovery_failed'
        const current = refresh
          ? remoteValue(await this.remote.get({ presetId: changeSet.presetId }), 'blueprint.get after transaction')
          : blueprint
        if (!this.ownsForeground(owner)) return
        this.patch({ busy: false, phase: 'ready', blueprint: current, capabilityHandoff: null, error: transactionFailureMessage(result) })
        await this.syncConversationContext(
          current, blueprintSelectionNodeId(this.store.getSnapshot()), undefined, undefined, undefined, owner,
        )
        return
      }
      const current = remoteValue(
        await this.remote.get({ presetId: changeSet.presetId }),
        'blueprint.get after transaction',
      )
      if (!this.ownsForeground(owner)) return
      this.patch({ busy: false, phase: 'ready', blueprint: current, capabilityHandoff: null })
      await this.syncConversationContext(
        current,
        blueprintSelectionNodeId(this.store.getSnapshot()),
        undefined,
        userChange,
        undefined,
        owner,
      )
    } catch (error) {
      if (this.ownsForeground(owner)) {
        this.patch({ busy: false, capabilityHandoff: null, error: messageOf(error) })
      }
    }
  }

  /**
   * Hide one proposal without changing the preset.
   * @param changeSet - exact source-owned Proposal to dismiss durably.
   */
  async cancelProposal(changeSet: BlueprintChangeSet): Promise<void> {
    const owner = this.foregroundOwner()
    const sourceSessionId = changeSet.sourceSessionId
    if (this.store.getSnapshot().busy || sourceSessionId !== owner.sourceSessionId) return
    if (this.cancelProposalDecision === undefined) {
      throw new Error('当前 Blueprint 运行环境不支持持久化取消修改建议。')
    }
    this.patch({ busy: true, error: null })
    try {
      const cancellation = remoteValue(
        await this.cancelProposalDecision(changeSet),
        'blueprint.cancelChangeSet',
      )
      this.deleteCapabilityDecision(changeSet)
      if (!this.ownsForeground(owner)) return
      this.restoreProposalCancellations(sourceSessionId, [cancellation])
      this.patch({ busy: false })
    } catch (error) {
      if (this.ownsForeground(owner)) this.patch({ busy: false, error: messageOf(error) })
      throw error
    }
  }

  /**
   * Hide one grouped preview without changing the preset.
   * @param changeSet - grouped preview and its exact source interaction identity.
   */
  async cancelChangeSet(changeSet: BlueprintChangeSet): Promise<void> {
    await this.cancelProposal(changeSet)
  }

  /**
   * Wait for current-Session receipt hydration, then create, validate, and open a trial Session.
   * @returns completion after validation or error publication.
   */
  async startTrial(): Promise<void> {
    if (this.interactionLocked()) return
    const owner = this.foregroundOwner()
    if (this.store.getSnapshot().applyReceiptsLoading === true) {
      await this.load()
      if (!this.ownsForeground(owner)) return
    }
    const ready = this.store.getSnapshot()
    const blueprint = ready.blueprint
    if (blueprint === null || ready.busy || ready.applyReceiptsLoading === true) return
    this.patch({ busy: true, error: null, validation: null })
    try {
      const receipt = currentTrialReceipt(
        this.store.getSnapshot().applyReceipts ?? [],
        owner.sourceSessionId,
        blueprint.preset.id,
        blueprint.revision,
      )
      const request: BlueprintTrialRequest = {
        presetId: blueprint.preset.id,
        expectedRevision: blueprint.revision,
        ...(receipt === undefined ? {} : {
          sourceSessionId: receipt.sourceSessionId,
          routeId: receipt.routeId,
          changeSetId: receipt.result.changeSetId,
        }),
      }
      if (this.startDemoTrialSession !== undefined) {
        await this.startDemoTrialSession(request)
        if (!this.ownsForeground(owner)) return
        this.patch({ busy: false, modal: null, validation: null })
        return
      }
      const validation = await this.startTrialSession(request)
      if (!this.ownsForeground(owner) && this.activeSessionId !== validation.sessionId) return
      this.patch({ busy: false, modal: null, validation })
    } catch (error) {
      if (error instanceof BlueprintTrialValidationError) {
        if (this.activeSessionId === error.sessionId) {
          this.patch({
            busy: false,
            validation: null,
            error: `Agent 已打开，但运行时校验未完成：${error.message}`,
          })
        }
      } else if (this.ownsForeground(owner)) {
        this.patch({ busy: false, error: messageOf(error) })
      }
    }
  }

  private async loadNow(owner: ForegroundOwner): Promise<void> {
    this.patch({ phase: 'loading', error: null })
    try {
      const roster = await this.catalog.list()
      if (!this.ownsForeground(owner)) return
      const agents = [...roster.agents]
      const record = this.activeSessionId === undefined ? undefined : this.creatorRecords.get(this.activeSessionId)
      const creator = record === undefined ? null : this.publicCreator(record)
      const pendingRoute = this.activeSessionId === undefined
        ? undefined
        : this.pendingCreatorRoutes.get(this.activeSessionId)
      if (creator === null && pendingRoute !== undefined) {
        const draft = this.pendingCreatorDraft(this.activeSessionId as string, pendingRoute)
        this.patch({ agents, phase: 'ready', presetId: '', blueprint: null, selection: null, creator: draft })
        await this.syncConversationContext(null, null, draft, undefined, undefined, owner)
        return
      }
      if (creator !== null && record !== undefined) {
        const targetPresetId = record.targetPresetId ?? null
        if (targetPresetId === null) {
          this.patch({ agents, phase: 'ready', presetId: '', blueprint: null })
          return
        }
        const blueprint = remoteValue(
          await this.remote.get({ presetId: targetPresetId }),
          'blueprint.get Creator projection',
        )
        if (!this.ownsForeground(owner)) return
        const blueprintRevealed = record.blueprintRevealed
          || await this.creatorProjectionHasSemanticChange(record, blueprint)
        if (!this.creatorRecordIsCurrent(creator.sessionId, record, owner.generation)) return
        const next = blueprintRevealed === record.blueprintRevealed
          ? record
          : { ...record, blueprintRevealed }
        this.creatorRecords.set(creator.sessionId, next)
        const visibleBlueprint = blueprintRevealed ? blueprint : null
        const selection = visibleBlueprint === null ? null : this.retainedSelection(visibleBlueprint)
        this.patch({
          agents, phase: 'ready', presetId: targetPresetId, blueprint: visibleBlueprint, selection,
          creator: this.publicCreator(next),
        })
        await this.syncConversationContext(
          visibleBlueprint, selection?.nodeId ?? null, this.publicCreator(next), undefined, undefined, owner,
        )
        return
      }
      const state = this.store.getSnapshot()
      const current = this.projectedSessionId === this.activeSessionId
        ? agents.find(agent => agent.id === state.presetId)?.id
        : undefined
      const stored = this.targetPreference.read(this.activeSessionId)
      const restored = stored === null ? undefined : agents.find(agent => agent.id === stored)?.id
      if (stored !== null && restored === undefined) this.targetPreference.clear(owner.sourceSessionId)
      const candidates = [...new Set([
        current,
        restored,
        agents.find(agent => agent.id === this.activeRuntimePresetId)?.id,
        agents.find(agent => agent.id === roster.preferredPresetId)?.id,
        agents[0]?.id,
      ].filter((candidate): candidate is string => candidate !== undefined))]
      if (candidates.length === 0) {
        this.patch({ agents, phase: 'ready', presetId: '', blueprint: null })
        return
      }
      if (state.busy && state.blueprint?.preset.id === candidates[0]) {
        this.patch({ agents, phase: 'ready' })
        return
      }
      let lastError: string | null = null
      for (const target of candidates) {
        const result = await this.remote.get({ presetId: target })
        if (!this.ownsForeground(owner)) return
        if (this.activeSessionId !== undefined && this.creatorRecords.has(this.activeSessionId)) return
        if (!result.ok) {
          lastError = result.error.message
          if (stored === target) this.targetPreference.clear(owner.sourceSessionId)
          continue
        }
        const blueprint = result.value
        this.projectedSessionId = this.activeSessionId
        this.patch({
          agents, phase: 'ready', presetId: blueprint.preset.id, blueprint,
          selection: this.retainedSelection(blueprint), error: null,
        })
        const conversationBlueprint = this.modelContextBlueprint(blueprint, null)
        await this.syncConversationContext(
          conversationBlueprint,
          conversationBlueprint === null ? null : blueprintSelectionNodeId(this.store.getSnapshot()),
          undefined,
          undefined,
          undefined,
          owner,
        )
        if (!this.ownsForeground(owner)) return
        this.reveal()
        return
      }
      this.patch({
        agents, phase: 'error', presetId: '', blueprint: null, selection: null,
        error: lastError ?? '没有可用的 Agent。',
      })
    } catch (error) {
      if (this.ownsForeground(owner)) this.patch({ phase: 'error', error: messageOf(error) })
    }
  }

  private reconcileCreator(sessionId: string): Promise<void> {
    this.pendingCreatorReconciles.add(sessionId)
    const run = (this.creatorReconcile ?? Promise.resolve())
      .then(async () => { await this.drainCreatorReconciles() })
    const tail = run.finally(() => {
      if (this.creatorReconcile === tail) this.creatorReconcile = null
    })
    this.creatorReconcile = tail
    return tail
  }

  private async drainCreatorReconciles(): Promise<void> {
    while (this.pendingCreatorReconciles.size > 0) {
      const sessionId = this.pendingCreatorReconciles.values().next().value as string
      this.pendingCreatorReconciles.delete(sessionId)
      await this.reconcileCreatorNow(sessionId)
    }
  }

  private async reconcileCreatorNow(sessionId: string): Promise<void> {
    let record = this.creatorRecords.get(sessionId)
    if (record === undefined || record.status === 'ready' || !this.ownsCreatorForeground(sessionId)) return
    const generation = this.foregroundGeneration
    try {
      const roster = await this.catalog.list()
      if (!this.creatorRecordIsCurrent(sessionId, record, generation)) return
      const agents = [...roster.agents]
      if (!record.baselineResolved) {
        const createdPresetIds = record.createdPresetIds
        record = {
          ...record,
          baselineIds: new Set(agents.filter(agent => !createdPresetIds.has(agent.id)).map(agent => agent.id)),
          baselineResolved: true,
        }
        this.creatorRecords.set(sessionId, record)
      }
      if (record.targetPresetId === null) {
        const unassociated = record
        const candidates = creatorCandidates(agents, unassociated)
        const valid: Array<{ agent: BlueprintAgentOption; blueprint: Blueprint }> = []
        for (const agent of candidates) {
          const result = await this.remote.get({ presetId: agent.id })
          if (!this.creatorRecordIsCurrent(sessionId, record, generation)) return
          if (result.ok) valid.push({ agent, blueprint: result.value })
        }
        const attributed = unassociated.associationStrategy === 'reuse-existing'
          ? valid
          : valid.filter(({ agent }) => unassociated.authoredPresetIds.has(agent.id)
            || exactDraftName(agent, unassociated.name))
        if (attributed.length === 1) {
          const [target] = attributed
          if (target === undefined) return
          let associated: CreatorRecord = {
            ...unassociated,
            targetPresetId: target.agent.id,
            candidateIds: [target.agent.id],
            status: 'creating',
          }
          associated.status = this.nonReadyCreatorStatus(associated)
          associated = {
            ...associated,
            blueprintRevealed: await this.creatorProjectionHasSemanticChange(associated, target.blueprint),
          }
          if (!this.creatorRecordIsCurrent(sessionId, record, generation)) return
          record = associated
          this.creatorRecords.set(sessionId, record)
          const visibleBlueprint = record.blueprintRevealed ? target.blueprint : null
          this.patch({
            agents, phase: 'ready', presetId: target.agent.id, blueprint: visibleBlueprint,
            selection: null, creator: this.publicCreator(record), error: null,
          })
          await this.syncConversationContext(visibleBlueprint, null, this.publicCreator(record))
        } else {
          const candidateIds = valid.map(({ agent }) => agent.id)
          const next: CreatorRecord = {
            ...record,
            candidateIds,
            status: valid.length > 1 || (valid.length === 1 && attributed.length === 0)
              ? 'ambiguity'
              : this.nonReadyCreatorStatus(record),
          }
          this.creatorRecords.set(sessionId, next)
          this.patch({ agents, creator: this.publicCreator(next) })
          if (next.status !== record.status) {
            await this.syncConversationContext(null, null, this.publicCreator(next))
          }
          return
        }
      }

      const targetPresetId = record.targetPresetId as string
      const projection = await this.remote.get({ presetId: targetPresetId })
      if (!this.creatorRecordIsCurrent(sessionId, record, generation)) return
      if (!projection.ok) {
        const next = { ...record, status: this.nonReadyCreatorStatus(record) }
        this.creatorRecords.set(sessionId, next)
        this.patch({ agents, presetId: targetPresetId, blueprint: null, creator: this.publicCreator(next) })
        return
      }
      const completed = record.validatedPresetIds.has(targetPresetId)
        && !record.running
        && record.waitingFor === null
        && record.lastTurnEnd?.reason === 'completed'
        && record.lastTurnEnd.seq > record.completionFloorSeq
      if (!completed) {
        const blueprintRevealed = record.blueprintRevealed
          || await this.creatorProjectionHasSemanticChange(record, projection.value)
        if (!this.creatorRecordIsCurrent(sessionId, record, generation)) return
        const next = { ...record, status: this.nonReadyCreatorStatus(record), blueprintRevealed }
        this.creatorRecords.set(sessionId, next)
        const previousBlueprint = this.store.getSnapshot().blueprint
        const visibleBlueprint = blueprintRevealed ? projection.value : null
        const selection = visibleBlueprint === null ? null : this.retainedSelection(visibleBlueprint)
        this.patch({
          agents, phase: 'ready', presetId: targetPresetId, blueprint: visibleBlueprint,
          selection, creator: this.publicCreator(next), error: null,
        })
        if (next.status !== record.status
          || previousBlueprint?.revision !== visibleBlueprint?.revision
          || (previousBlueprint === null) !== (visibleBlueprint === null)) {
          await this.syncConversationContext(visibleBlueprint, selection?.nodeId ?? null, this.publicCreator(next))
        }
        return
      }

      const finalBlueprint = remoteValue(
        await this.remote.get({ presetId: targetPresetId }),
        'blueprint.get final Creator projection',
      )
      if (!this.creatorRecordIsCurrent(sessionId, record, generation)) return
      if (record.routeId !== undefined) {
        remoteValue(await this.remote.setConversationContext({
          sessionId: record.executionSessionId,
          recoverCreatorAuthoring: true,
        }), 'Creator terminal checkpoint')
        if (!this.creatorRecordIsCurrent(sessionId, record, generation)) return
      }
      const ready: CreatorRecord = { ...record, status: 'ready', candidateIds: [targetPresetId] }
      this.creatorRecords.set(sessionId, ready)
      const selection = this.retainedSelection(finalBlueprint)
      this.patch({
        agents, phase: 'ready', presetId: targetPresetId, blueprint: finalBlueprint,
        selection, creator: this.publicCreator(ready), error: null,
      })
      await this.syncConversationContext(finalBlueprint, selection?.nodeId ?? null)
      if (!this.creatorRecordIsCurrent(sessionId, ready, generation)) return
      this.projectedSessionId = this.activeSessionId
      this.targetPreference.write(finalBlueprint.preset.id, record.sessionId)
      this.reveal()
    } catch (error) {
      if (this.ownsCreatorForeground(sessionId, generation)) this.patch({ error: messageOf(error) })
    }
  }

  /** Derive every non-Ready Creator status from current structured Session state. */
  private nonReadyCreatorStatus(record: CreatorRecord): Exclude<BlueprintCreatorDraft['status'], 'ready'> {
    if (record.targetPresetId === null && record.status === 'ambiguity' && record.candidateIds.length > 0) {
      return 'ambiguity'
    }
    if (record.waitingFor !== null) return 'waiting'
    if (record.running) return 'creating'
    return record.hasRun ? 'paused' : 'creating'
  }

  private publicCreator(record: CreatorRecord): BlueprintCreatorDraft {
    return {
      sessionId: record.sessionId,
      ...(record.routeId === undefined ? {} : { routeId: record.routeId }),
      name: record.name,
      status: record.status,
      candidateIds: record.candidateIds,
      waitingFor: record.waitingFor,
      ...(record.pendingInteraction === undefined ? {} : { pendingInteraction: record.pendingInteraction }),
      ...(record.targetPresetId === null ? {} : { targetPresetId: record.targetPresetId }),
    }
  }

  private pendingCreatorDraft(
    sourceSessionId: string,
    route: BlueprintCreatorAuthoringRoute,
  ): BlueprintCreatorDraft {
    return {
      sessionId: sourceSessionId,
      routeId: route.routeId,
      name: route.name,
      status: 'creating',
      candidateIds: [],
      waitingFor: null,
    }
  }

  /**
   * Decide whether a copied target contains user-level semantics that differ from its source.
   * A target without typed copy evidence is already an authored or reused preset and remains visible.
   */
  private async creatorProjectionHasSemanticChange(
    record: CreatorRecord,
    target: Blueprint,
  ): Promise<boolean> {
    const sourcePresetId = record.presetCopySources.get(target.preset.id)
    if (sourcePresetId === undefined) {
      return record.baselineIds.has(target.preset.id)
        || record.authoredPresetIds.has(target.preset.id)
    }
    const source = await this.remote.get({ presetId: sourcePresetId })
    if (!source.ok) return false
    return semanticBlueprintFingerprint(target) !== semanticBlueprintFingerprint(source.value)
  }

  private ownsCreatorForeground(sessionId: string, generation = this.foregroundGeneration): boolean {
    return generation === this.foregroundGeneration && creatorOwnsForeground(this.activeSessionId, sessionId)
  }

  private creatorRecordIsCurrent(sessionId: string, record: CreatorRecord, generation: number): boolean {
    return this.ownsCreatorForeground(sessionId, generation)
      && this.creatorRecords.get(sessionId)?.lifecycleVersion === record.lifecycleVersion
  }

  private retainedSelection(blueprint: Blueprint): BlueprintSelection | null {
    const selection = blueprintSelection(this.store.getSnapshot())
    return selection !== null && blueprint.nodes.some(node => node.id === selection.nodeId)
      ? selection
      : null
  }

  private patch(patch: Partial<BlueprintUiState>): void {
    // Reject the entire foreign publication, including its target and projection, before notifying UI subscribers.
    if (patch.creator != null && !this.ownsCreatorForeground(patch.creator.sessionId)) return
    const previous = this.store.getSnapshot().creator
    if (previous?.routeId !== undefined && previous.status === 'ready'
      && patch.creator?.sessionId === previous.sessionId && patch.creator.routeId === previous.routeId
      && patch.creator.status !== 'ready') return
    const normalized = patch.selection === undefined
      ? patch
      : { ...patch, selectedNodeId: patch.selection?.nodeId ?? null }
    this.store.set({
      ...this.store.getSnapshot(),
      ...normalized,
      capabilityHandoff: this.foregroundCapability(),
    })
    const state = this.store.getSnapshot()
    const targetPresetId = state.blueprint?.preset.id
    const creatorSessionId = state.creator?.sessionId
    const diagnostic = blueprintSessionLifecycleDiagnostic({
      ...(this.activeSessionId === undefined ? {} : { activeSessionId: this.activeSessionId }),
      ...(this.activeRuntimePresetId === undefined ? {} : { runtimePresetId: this.activeRuntimePresetId }),
      ...(targetPresetId === undefined ? {} : { targetPresetId }),
      ...(creatorSessionId === undefined ? {} : { creatorSessionId }),
      stagedAuthoring: creatorSessionId === this.activeSessionId
        || state.capabilityHandoff?.sourceSessionId === this.activeSessionId,
      sessionOverride: this.explicitSelectionSessionId === this.activeSessionId
        || this.targetPreference.read(this.activeSessionId) === targetPresetId,
    })
    if (diagnostic !== null) console.error(`[ui-blueprint] ${diagnostic}`)
  }

  private async syncConversationContext(
    blueprint: Blueprint | null,
    selectedNodeId: string | null,
    creatorDraft?: BlueprintCreatorDraft,
    userChange?: BlueprintUserChangeInput,
    directEditInput?: BlueprintStructuredEditInput,
    owner: ForegroundOwner = this.foregroundOwner(),
  ): Promise<void> {
    if (!this.ownsForeground(owner)) return
    if (creatorDraft !== undefined && creatorDraft.sessionId !== owner.sourceSessionId) return
    await this.publishConversationContext(
      owner.sourceSessionId,
      blueprint, selectedNodeId, creatorDraft, userChange, directEditInput,
      () => this.ownsForeground(owner),
    )
  }

  private modelContextBlueprint(
    blueprint: Blueprint | null,
    creator: BlueprintCreatorDraft | null,
  ): Blueprint | null {
    if (creator === null && this.activeRuntimePresetId === 'cordis' && blueprint?.preset.id === 'cordis') return null
    return blueprint
  }

  private creatorLocked(): boolean {
    const creator = this.store.getSnapshot().creator
    return creator !== null && this.ownsCreatorForeground(creator.sessionId) && creator.status !== 'ready'
  }

  private foregroundOwner(): ForegroundOwner {
    return { sourceSessionId: this.activeSessionId, generation: this.foregroundGeneration }
  }

  private ownsForeground(owner: ForegroundOwner): boolean {
    return owner.generation === this.foregroundGeneration
      && owner.sourceSessionId === this.activeSessionId
  }

  private capabilityExecutionLocked(): boolean {
    const handoff = this.foregroundCapability()
    return handoff !== null && handoff.terminal === undefined
      && (handoff.status === 'configuring' || handoff.status === 'authoring')
  }

  private interactionLocked(): boolean {
    return this.creatorLocked() || this.capabilityExecutionLocked()
  }

  /**
   * List authoring execution Sessions independently of foreground projection.
   * @returns active source or legacy Creator Session ids.
   */
  capabilityAuthoringSessionIds(): readonly string[] {
    return [...this.capabilityHandoffs.values()]
      .filter(handoff => handoff.status === 'authoring' && handoff.startSeq !== undefined
        && handoff.terminal === undefined)
      .map(handoff => this.capabilityExecutionSessionId(handoff))
  }

  /**
   * Test whether one execution Session still owns an active source interaction.
   * @param sessionId - source or legacy Creator Session to inspect.
   * @returns whether that Session owns an active capability task.
   */
  hasCapabilityAuthoringSession(sessionId: string): boolean {
    return this.capabilityAuthoringSessionIds().includes(sessionId)
  }

  /**
   * List source Sessions whose ordinary composer is reserved by capability configuration.
   * @returns source ids in configuring or authoring state.
   */
  capabilityInputBlockedSessionIds(): readonly string[] {
    return [...this.capabilityHandoffs.values()]
      .filter(handoff => handoff.terminal === undefined
        && (handoff.status === 'configuring' || handoff.status === 'authoring'))
      .map(handoff => handoff.sourceSessionId)
  }

  /**
   * Find the source owner of one active execution Session.
   * @param sessionId - source or legacy Creator execution Session.
   * @returns source owner while the lifecycle remains active.
   */
  capabilityAuthoringSourceSessionId(sessionId: string): string | undefined {
    return [...this.capabilityHandoffs.values()].find(handoff => handoff.terminal === undefined
      && handoff.status === 'authoring'
      && this.capabilityExecutionSessionId(handoff) === sessionId)?.sourceSessionId
  }

  private foregroundCapability(): BlueprintCapabilityHandoff | null {
    return this.activeSessionId === undefined ? null : this.capabilityHandoffs.get(this.activeSessionId) ?? null
  }

  private setCapabilityHandoff(handoff: BlueprintCapabilityHandoff): boolean {
    const current = this.capabilityHandoffs.get(handoff.sourceSessionId)
    if (current?.routeId === handoff.routeId) {
      if (current.terminal !== undefined) return false
      const statusOrder = { configuring: 0, proposal: 1, authoring: 2, completed: 3, failed: 3, cancelled: 3 }
      if (statusOrder[handoff.status] < statusOrder[current.status]) return false
      if (current.startSeq !== undefined && handoff.startSeq !== undefined
        && handoff.startSeq < current.startSeq) return false
    }
    if (current !== undefined && current.routeId !== handoff.routeId) {
      const currentActive = current.terminal === undefined
      const orderedAfter = current.sourceRouteSeq !== undefined && handoff.sourceRouteSeq !== undefined
        && handoff.sourceRouteSeq > current.sourceRouteSeq
      if (currentActive && (handoff.status === 'configuring' || !orderedAfter)) return false
      if (!currentActive && current.sourceRouteSeq !== undefined && handoff.sourceRouteSeq !== undefined
        && handoff.sourceRouteSeq <= current.sourceRouteSeq) return false
      this.clearCapabilityCancellation(current)
    }
    this.capabilityHandoffs.set(handoff.sourceSessionId, handoff)
    if (handoff.terminal !== undefined) this.clearCapabilityCancellation(handoff)
    this.patch({})
    return true
  }

  private deleteCapabilityHandoff(sourceSessionId: string, routeId: string): void {
    const handoff = this.capabilityHandoffs.get(sourceSessionId)
    if (handoff?.routeId !== routeId) return
    this.capabilityHandoffs.delete(sourceSessionId)
    this.clearCapabilityCancellation(handoff)
    this.patch({})
  }

  private capabilityLifecycleKey(handoff: Pick<BlueprintCapabilityHandoff, 'sourceSessionId' | 'routeId'>): string {
    return `${handoff.sourceSessionId}:${handoff.routeId}`
  }

  private clearCapabilityCancellation(
    handoff: Pick<BlueprintCapabilityHandoff, 'sourceSessionId' | 'routeId'>,
  ): void {
    const key = this.capabilityLifecycleKey(handoff)
    this.capabilityCancelRequests.delete(key)
    this.capabilityCancelDispatches.delete(key)
  }

  private dispatchCapabilityCancellation(handoff: BlueprintCapabilityHandoff, owner: ForegroundOwner): void {
    if (handoff.startSeq === undefined) return
    const key = this.capabilityLifecycleKey(handoff)
    if (this.capabilityCancelDispatches.has(key)) return
    this.capabilityCancelDispatches.add(key)
    const executionSessionId = this.capabilityExecutionSessionId(handoff)
    void (async () => {
      if (handoff.creatorSessionId !== undefined && this.cancelCapabilityAuthoring !== undefined) {
        await this.cancelCapabilityAuthoring(executionSessionId)
      }
      remoteValue(await this.remote.setConversationContext({
        sessionId: executionSessionId,
        capabilityAuthoringEnd: { outcome: 'cancelled' },
      }), 'cancel capability authoring lifecycle')
    })().catch((error: unknown) => {
      this.capabilityCancelDispatches.delete(key)
      if (this.ownsForeground(owner) && owner.sourceSessionId === handoff.sourceSessionId) {
        this.patch({ error: messageOf(error) })
      }
    })
  }

  private deleteCapabilityDecision(changeSet: BlueprintChangeSet): void {
    this.deleteCapabilityHandoff(changeSet.sourceSessionId, changeSet.routeId)
  }

  private capabilityHandoffIsCurrent(handoff: BlueprintCapabilityHandoff): boolean {
    const current = this.capabilityHandoffs.get(handoff.sourceSessionId)
    return current?.routeId === handoff.routeId
      && current.creatorSessionId === handoff.creatorSessionId
      && current.startSeq === handoff.startSeq
  }

  private capabilityHandoffForObservation(sessionId: string): BlueprintCapabilityHandoff | undefined {
    return [...this.capabilityHandoffs.values()].find(handoff => handoff.terminal === undefined
      && (handoff.status === 'authoring'
        ? this.capabilityExecutionSessionId(handoff) === sessionId
        : handoff.sourceSessionId === sessionId))
  }

  private capabilityExecutionSessionId(handoff: BlueprintCapabilityHandoff): string {
    return handoff.creatorSessionId ?? handoff.sourceSessionId
  }

  private terminalCapabilityHandoff(
    executionSessionId: string,
    record: NonNullable<BlueprintConversationContextResult['capabilityAuthoringRecord']>,
    sourceRouteSeq?: number,
  ): BlueprintCapabilityHandoff {
    if (record.state !== 'ended' || record.endSeq === undefined || record.outcome === undefined) {
      throw new Error('Capability authoring terminal projection requires a durable outcome and end sequence')
    }
    const current = this.capabilityHandoffs.get(record.sourceSessionId)
    return {
      sourceSessionId: record.sourceSessionId,
      routeId: record.routeId,
      request: record.request,
      label: capabilityIntentLabel(record.request),
      targetPresetId: record.targetPresetId,
      revision: current?.routeId === record.routeId ? current.revision : '',
      status: record.outcome,
      authoringKind: record.kind,
      ...(executionSessionId === record.sourceSessionId
        ? {}
        : { creatorSessionId: executionSessionId }),
      startSeq: record.startSeq,
      ...(current?.routeId === record.routeId && current.sourceRouteSeq !== undefined
        ? { sourceRouteSeq: current.sourceRouteSeq }
        : sourceRouteSeq === undefined ? {} : { sourceRouteSeq }),
      baselineDelegationRowIds: record.baselineDelegationRowIds,
      ...(current?.routeId === record.routeId && current.sourceStartSeq !== undefined
        ? { sourceStartSeq: current.sourceStartSeq } : {}),
      terminal: {
        outcome: record.outcome,
        endSeq: record.endSeq,
      },
    }
  }

  private retainTargetPreference(sourceSessionId: string, presetId: string): void {
    if (this.activeSessionId === sourceSessionId
      && this.store.getSnapshot().blueprint?.preset.id === presetId) {
      this.targetPreference.write(presetId, sourceSessionId)
    }
  }
}

/**
 * Resolve Creator foreground ownership independently of retained history and target ids.
 * A typed source retains foreground ownership while its child Creator executes in the background.
 * @param currentSessionId - currently viewed Session, absent on the no-Session screen.
 * @param ownerSessionId - Session whose Draft or recovered Creator lifecycle is being published.
 * @returns whether this lifecycle may affect the foreground Blueprint and interaction lock.
 */
export function creatorOwnsForeground(currentSessionId: string | undefined, ownerSessionId: string): boolean {
  return currentSessionId !== undefined && currentSessionId === ownerSessionId
}

/**
 * Return one lifecycle contradiction suitable for development diagnostics.
 * @param input - foreground, runtime, target, and authoring ownership state.
 * @returns a diagnostic when the state contradicts lifecycle ownership, otherwise `null`.
 */
export function blueprintSessionLifecycleDiagnostic(input: {
  activeSessionId?: string
  runtimePresetId?: string
  targetPresetId?: string
  creatorSessionId?: string
  stagedAuthoring: boolean
  sessionOverride: boolean
}): string | null {
  if (input.activeSessionId === undefined || input.runtimePresetId === undefined) return null
  if (input.creatorSessionId !== undefined && input.creatorSessionId !== input.activeSessionId) {
    return `Creator state belongs to ${input.creatorSessionId}, current Session is ${input.activeSessionId}.`
  }
  if (input.targetPresetId !== undefined && input.targetPresetId !== input.runtimePresetId
    && !input.stagedAuthoring && !input.sessionOverride) {
    return `Blueprint target ${input.targetPresetId} differs from runtime preset ${input.runtimePresetId} without staged authoring.`
  }
  return null
}

/**
 * Recognize one explicit request to create a new Agent preset.
 * @param text - user-authored message text.
 * @returns inferred Agent label, or null when the message does not request creation.
 */
export function creatorRequest(text: string): string | null {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  const isNegated = (index: number): boolean => {
    const clausePrefix = normalized.slice(0, index).split(/[，。！？；：;,:.!?]/u).at(-1)?.trimEnd() ?? ''
    return /(?:不要|不应|无需|不需要|禁止|别|不想(?:要)?|不)\s*(?:再)?\s*(?:请\s*)?$/u.test(clausePrefix)
      || /(?:do not|don't|must not|without)\s*$/iu.test(clausePrefix)
  }
  for (const candidate of normalized.matchAll(
    /(?:请\s*)?(?:帮我\s*)?(?:创建|新建|搭建|打造|做|弄)\s*(?:一个|个)?\s*[「“"]\s*([^」”"]{1,40}?)\s*(Agent|智能体|助手)\s*[」”"](?=[，。！？：:,.!?]|$)/giu,
  )) {
    const label = candidate.at(1)?.trim()
    if (!isNegated(candidate.index)) return `${label || '新'} Agent`
  }
  for (const candidate of normalized.matchAll(
    /(?:请\s*)?[创新]建\s*(?:一?个)?\s*名为\s*[「“"]\s*([^」”"]{1,40}?)\s*(Agent|智能体|助手)\s*[」”"]\s*的\s*新\s*(Agent|智能体|助手)\s*preset([，。！？：:]|$)/giu,
  )) {
    const label = candidate.at(1)?.trim()
    if (!isNegated(candidate.index)) return `${label || '新'} Agent`
  }
  const chinesePatterns = [
    /(?:我要|我想要|我需要)\s*(?:一个|个)\s*([^，。！？：:]{1,40}?)\s*(?:Agent|智能体|助手)(?:[，。！？：:]|$)/giu,
    /(?:请\s*)?帮我\s*(?:创建|新建|搭建|打造|做|弄)\s*(?:一个|个)?\s*([^，。！？：:]{1,40}?)\s*(?:Agent|智能体|助手)(?:[，。！？：:]|$)/giu,
    /(?:我想|我要|请)?\s*(?:创建|新建|搭建|打造|做|弄)\s*(?:一个|个)?\s*([^，。！？：:]{1,40}?)\s*(?:Agent|智能体|助手)(?:[，。！？：:]|$)/giu,
  ]
  for (const pattern of chinesePatterns) {
    for (const candidate of normalized.matchAll(pattern)) {
      const label = candidate.at(1)?.trim()
      if (!isNegated(candidate.index)) return `${label || '新'} Agent`
    }
  }
  for (const candidate of normalized.matchAll(
    /(?:create|build|make)\s+(?:a|an)?\s*([^.!?:]{1,40}?)\s+agent(?:[.!?:]|$)/giu,
  )) {
    const label = candidate.at(1)?.trim()
    if (!isNegated(candidate.index)) return `${label || 'New'} Agent`
  }
  return null
}

function latestCreatorRequest(
  messages: readonly { seq: number; text: string }[],
): { seq: number; name: string } | null {
  const message = messages.at(-1)
  if (message === undefined) return null
  const name = creatorRequest(message.text)
  return name === null ? null : { seq: message.seq, name }
}

function recoverCreatedPresetIds(
  observation: BlueprintCreatorObservation,
  triggerSeq: number,
): ReadonlySet<string> {
  const answers = observation.associationAnswers.filter(answer => answer.seq > triggerSeq)
  const created = new Set(
    observation.presetCopies
      .filter(copy => copy.seq > triggerSeq)
      .map(copy => copy.targetPresetId),
  )
  for (const evidence of observation.authoredPresets.filter(candidate => candidate.seq > triggerSeq)) {
    const strategy = answers.filter(answer => answer.seq <= evidence.seq).at(-1)?.strategy
    if (strategy === 'new-independent') created.add(evidence.presetId)
  }
  return created
}

function copySourceMap(
  copies: readonly BlueprintCreatorPresetCopy[],
): ReadonlyMap<string, string> {
  return new Map(copies.map(copy => [copy.targetPresetId, copy.sourcePresetId]))
}

function semanticBlueprintFingerprint(blueprint: Blueprint): string {
  const nodes = blueprint.nodes
    .map(node => ({ id: node.id, type: node.type, value: node.value }))
    .sort((left, right) => left.type.localeCompare(right.type) || left.id.localeCompare(right.id))
  return stableJson(nodes)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value !== 'object' || value === null) return JSON.stringify(value)
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`
}

function exactDraftName(agent: BlueprintAgentOption, draftName: string): boolean {
  const normalize = (value: string): string => value.replace(/[\s_-]+/gu, '').replace(/agent$/iu, '').toLocaleLowerCase()
  return normalize(agent.label) === normalize(draftName)
}

function creatorCandidates(
  agents: readonly BlueprintAgentOption[],
  record: CreatorRecord,
): readonly BlueprintAgentOption[] {
  const healthy = agents.filter(agent => agent.broken === undefined)
  switch (record.associationStrategy) {
    case 'reuse-existing':
      return healthy.filter(agent => record.baselineIds.has(agent.id)
        && (record.existingPresetId === null
          ? exactDraftName(agent, record.name)
          : agent.id === record.existingPresetId))
    case 'enhance-existing':
      return healthy.filter(agent => !record.baselineIds.has(agent.id)
        || record.authoredPresetIds.has(agent.id))
    case 'new-independent':
      return healthy.filter(agent => !record.baselineIds.has(agent.id))
    case 'undecided':
      return healthy.filter(agent => !record.baselineIds.has(agent.id)
        || (record.validatedPresetIds.has(agent.id) && exactDraftName(agent, record.name)))
  }
}

function associationStillAllowed(record: CreatorRecord): boolean {
  const target = record.targetPresetId
  if (target === null) return true
  switch (record.associationStrategy) {
    case 'reuse-existing':
      return record.baselineIds.has(target)
        && (record.existingPresetId === null || record.existingPresetId === target)
    case 'enhance-existing':
      return !record.baselineIds.has(target) || record.authoredPresetIds.has(target)
    case 'new-independent':
      return !record.baselineIds.has(target)
    case 'undecided':
      return !record.baselineIds.has(target) || record.validatedPresetIds.has(target)
  }
}

function transactionOperation(proposal: BlueprintChangeProposal): BlueprintChangeSetOperation {
  switch (proposal.operation) {
    case 'updateIdentity':
    case 'updatePurpose':
    case 'updateBehavior':
    case 'updateOutput':
      if (typeof proposal.currentValue !== 'string' || typeof proposal.proposedValue !== 'string') {
        throw new Error('这项文字调整包含不兼容的内容。')
      }
      return {
        operation: proposal.operation,
        targetNodeId: proposal.targetNodeId,
        expected: proposal.currentValue,
        value: proposal.proposedValue,
      }
    case 'setCapability': {
      if (typeof proposal.currentValue !== 'boolean' || typeof proposal.proposedValue !== 'boolean') {
        throw new Error('这项能力调整包含不兼容的内容。')
      }
      const capability = proposal.targetNodeId === 'capability:web-search'
        ? 'web-search'
        : proposal.targetNodeId === 'capability:web-fetch' ? 'web-fetch' : undefined
      if (capability === undefined) throw new Error('这项能力目前没有可用的类型化写入方式。')
      return {
        operation: 'setCapability',
        targetNodeId: proposal.targetNodeId,
        capability,
        expected: proposal.currentValue,
        enabled: proposal.proposedValue,
      }
    }
  }
}

function transactionFailureMessage(result: BlueprintApplyChangeSetResult): string {
  switch (result.status) {
    case 'committed': return '已全部应用。'
    case 'preflight_failed':
    case 'staging_failed':
      return 'Agent 已发生变化，这组调整没有应用，请重新查看。'
    case 'commit_failed':
      return '这组调整未能写入，Agent 未被修改。'
    case 'reprojection_failed_recovered':
      return '调整未能完整应用，已恢复到修改前状态。'
    case 'reprojection_failed_conflict':
      return '调整未能完整验证，且 Agent 已在此期间发生变化；未自动恢复，请重新查看。'
    case 'reprojection_failed_recovery_failed':
      return '调整未能完整验证，自动恢复失败，请立即重新查看 Agent。'
  }
  throw new Error(`Unknown Blueprint transaction status: ${String(result.status)}`)
}

/**
 * Narrow one capability node's JSON value for rendering and writes.
 * @param node - projected capability candidate.
 * @returns typed capability data, or undefined for an incompatible value.
 */
export function capabilityValue(node: BlueprintNode): { name?: string; tool: string; enabled: boolean } | undefined {
  if (typeof node.value !== 'object' || node.value === null || Array.isArray(node.value)) return undefined
  const value = node.value as Record<string, unknown>
  if (typeof value['tool'] !== 'string' || typeof value['enabled'] !== 'boolean') return undefined
  return {
    tool: value['tool'], enabled: value['enabled'],
    ...(typeof value['name'] === 'string' ? { name: value['name'] } : {}),
  }
}

/** Read-only Skill capability data projected from the scoped registry. */
export interface BlueprintSkillValue {
  name: string
  description: string
  callable: boolean
  scope: 'preset' | 'inherited'
  invocation: {
    modelInvocable: boolean
    userInvocable: boolean
  }
}

/**
 * Narrow one read-only Skill capability node for rendering.
 * @param node - projected capability candidate.
 * @returns the recognized Skill value, or `undefined` for another node representation.
 */
export function skillValue(node: BlueprintNode): BlueprintSkillValue | undefined {
  if (typeof node.value !== 'object' || node.value === null || Array.isArray(node.value)) return undefined
  const value = node.value as Record<string, unknown>
  const invocation = value['invocation']
  if (value['kind'] !== 'skill' || typeof value['name'] !== 'string'
    || typeof value['description'] !== 'string' || typeof value['callable'] !== 'boolean'
    || (value['scope'] !== 'preset' && value['scope'] !== 'inherited')
    || typeof invocation !== 'object' || invocation === null || Array.isArray(invocation)) return undefined
  const policy = invocation as Record<string, unknown>
  if (typeof policy['modelInvocable'] !== 'boolean' || typeof policy['userInvocable'] !== 'boolean') return undefined
  return {
    name: value['name'],
    description: value['description'],
    callable: value['callable'],
    scope: value['scope'],
    invocation: {
      modelInvocable: policy['modelInvocable'],
      userInvocable: policy['userInvocable'],
    },
  }
}

/** Read-only delegation capability data projected from one composition row. */
export interface BlueprintDelegationValue {
  name: string
  tool: string
  provider: string
  mode: 'one-shot' | 'continuable'
  providerAvailable: boolean
  enabled: boolean
  responsibility?: string
}

/**
 * Narrow one read-only delegation capability node for rendering.
 * @param node - projected capability candidate.
 * @returns the recognized delegation value, or `undefined` for another node representation.
 */
export function delegationValue(node: BlueprintNode): BlueprintDelegationValue | undefined {
  if (typeof node.value !== 'object' || node.value === null || Array.isArray(node.value)) return undefined
  const value = node.value as Record<string, unknown>
  if (value['kind'] !== 'delegation' || typeof value['name'] !== 'string'
    || typeof value['tool'] !== 'string' || typeof value['provider'] !== 'string'
    || (value['mode'] !== 'one-shot' && value['mode'] !== 'continuable')
    || typeof value['providerAvailable'] !== 'boolean' || typeof value['enabled'] !== 'boolean') return undefined
  return {
    name: value['name'],
    tool: value['tool'],
    provider: value['provider'],
    mode: value['mode'],
    providerAvailable: value['providerAvailable'],
    enabled: value['enabled'],
    ...(typeof value['responsibility'] === 'string' ? { responsibility: value['responsibility'] } : {}),
  }
}
