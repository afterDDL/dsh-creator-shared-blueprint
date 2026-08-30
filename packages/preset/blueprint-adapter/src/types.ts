/** JSON vocabulary emitted by the Interactive Blueprint adapter. */

import type { JsonValue, SessionId } from '@deepseek-ai/dsh-session/types'
import type { CallId, MessageId } from '@deepseek-ai/dsh-llm'

/** Blueprint sections supported by the first adapter. */
export type BlueprintNodeType = 'purpose' | 'identity' | 'capability' | 'behavior' | 'output' | 'access'

/** Provenance of one projected value. */
export type BlueprintSource = 'preset' | 'runtime' | 'inherited' | 'inferred'

/** Whether one projected value currently participates in the assembled agent. */
export type BlueprintStatus = 'active' | 'inactive' | 'unmapped'

/** One Blueprint value with its provenance and write-back address. */
export interface BlueprintNode {
  /** Stable id within one preset projection. */
  id: string
  /** Semantic section this value belongs to. */
  type: BlueprintNodeType
  /** JSON-serializable projected value. */
  value: JsonValue
  /** Authoritative source of the projected value. */
  source: BlueprintSource
  /** Whether the value participates in the current runtime assembly. */
  status: BlueprintStatus
  /** Whether this adapter accepts a write for the node. */
  editable: boolean
  /** Adapter-owned address for a write, or null for read-only values. */
  adapterRef: string | null
}

/** A field the adapter observed but cannot map in both directions. */
export interface BlueprintMappingGap {
  /** Stable field or mechanism name. */
  field: string
  /** Why the adapter cannot provide a stronger mapping. */
  reason: string
}

/** Runtime facts captured from the same prompt assembly and permission service as the nodes. */
export interface BlueprintRuntimeSnapshot {
  /** Model-facing tool names in assembly order. */
  tools: string[]
  /** Named prompt sections in assembly order. */
  promptSections: string[]
  /** Skill definitions visible through the target preset's scoped registry. */
  skills: BlueprintRuntimeSkill[]
  /** Delegation rows resolved from the preset composition and provider registry. */
  delegations: BlueprintRuntimeDelegation[]
  /** Permission preset and resolved knobs for the target session or a future session default. */
  permissions: {
    preset: string
    sandbox?: string
    approval?: string
  } | null
}

/** Digest-only runtime identity of one scoped Skill. */
export interface BlueprintRuntimeSkill {
  /** Kebab-case Skill identity. */
  name: string
  /** Routing description from the winning scoped definition. */
  description: string
  /** Resolved model and user invocation policy. */
  invocation: {
    modelInvocable: boolean
    userInvocable: boolean
  }
  /** Whether the winning definition comes from the preset layer or a parent layer. */
  scope: 'preset' | 'inherited'
  /** Provider identity retained for conformance evidence. */
  provider: string
  /** Provider-defined discovery source retained for conformance evidence. */
  source: string
  /** SHA-256 of the loaded Skill body; the body never crosses the Remote. */
  definitionDigest: string
}

/** Runtime and composition identity of one configured delegation capability. */
export interface BlueprintRuntimeDelegation {
  /** Stable preset composition row id. */
  rowId: string
  /** Model-visible delegation Tool name. */
  tool: string
  /** Registered Subagent provider requested by the row. */
  provider: string
  /** Declared child lifecycle mode. */
  mode: 'one-shot' | 'continuable'
  /** SHA-256 of the complete parsed row config, including unevaluated `!!js` nodes. */
  configDigest: string
  /** Whether the requested provider currently exists. */
  providerAvailable: boolean
  /** Whether the standing assembly exposes the configured Tool. */
  enabled: boolean
}

/** One real preset projected into the first Interactive Blueprint schema. */
export interface Blueprint {
  /** Blueprint JSON format version. */
  schemaVersion: 1
  /** Open language metadata derived from the preset's authored semantic text when its script is recognized. */
  sourceLanguage?: string
  /** Preset identity and trust resolved by the preset roster. */
  preset: {
    id: string
    trust: 'system' | 'user'
    name?: string
    description?: string
  }
  /** SHA-256 of the composition text used for projection and optimistic writes. */
  revision: string
  /** Projected semantic and runtime values. */
  nodes: BlueprintNode[]
  /** Runtime facts used to validate the projection. */
  runtime: BlueprintRuntimeSnapshot
  /** Known fields that cannot be mapped in both directions. */
  mappingGaps: BlueprintMappingGap[]
}

/** Host Remote request for one preset Blueprint projection. */
export interface BlueprintGetRequest {
  /** Preset id resolved by the real roster. */
  presetId: string
}

/** Optimistic text write shared by Identity, Purpose, Behavior, and Output updates. */
export interface BlueprintTextWrite {
  /** Preset id to update. */
  presetId: string
  /** Blueprint revision the editor started from. */
  revision: string
  /** Exact projected value the editor replaces. */
  expected: string
  /** New single-line value. */
  value: string
}

/** Identity update addressed to one safely recognized persona role slot. */
export interface BlueprintIdentityWrite extends BlueprintTextWrite {
  /** Stable Identity node selected by the editor. */
  nodeId: string
}

/** Behavior update addressed by the numbered persona item. */
export interface BlueprintBehaviorWrite extends BlueprintTextWrite {
  /** Number in the persona's explicit numbered list. */
  ordinal: number
}

/** Web Fetch enablement update addressed to the real `tool-web` preset row. */
export interface BlueprintCapabilityWrite {
  /** Preset id to update. */
  presetId: string
  /** Blueprint revision the editor started from. */
  revision: string
  /** Current enablement expected by the editor. */
  expected: boolean
  /** Requested enablement. */
  enabled: boolean
  /** Capability whose typed preset field should change. */
  capability: 'web-search' | 'web-fetch'
}

/** Output update addressed by the inferred numbered persona item. */
export interface BlueprintOutputWrite extends BlueprintTextWrite {
  /** Number in the persona's explicit numbered list. */
  ordinal: number
}

/** One typed text replacement inside an atomic Blueprint Change Set. */
export type BlueprintChangeSetTextOperation = {
  /** Stable projected node addressed by this operation. */
  targetNodeId: string
  /** Exact projected value the transaction must still observe. */
  expected: string
  /** Replacement single-line value. */
  value: string
} & ({
  /** Replace one safely recognized Identity role slot. */
  operation: 'updateIdentity'
} | {
  /** Replace the inferred Purpose paragraph. */
  operation: 'updatePurpose'
} | {
  /** Replace one numbered Behavior item. */
  operation: 'updateBehavior'
} | {
  /** Replace one safely inferred numbered Output item. */
  operation: 'updateOutput'
})

/** One typed Web capability replacement inside an atomic Blueprint Change Set. */
export interface BlueprintChangeSetCapabilityOperation {
  /** Set one admitted Web capability. */
  operation: 'setCapability'
  /** Stable capability node addressed by this operation. */
  targetNodeId: string
  /** Capability whose explicit preset field owns the write. */
  capability: 'web-search' | 'web-fetch'
  /** Exact projected enablement the transaction must still observe. */
  expected: boolean
  /** Requested enablement. */
  enabled: boolean
}

/** Closed operation set accepted by transactional Blueprint Apply. */
export type BlueprintChangeSetOperation =
  | BlueprintChangeSetTextOperation
  | BlueprintChangeSetCapabilityOperation

/** Host request to apply one confirmed Change Set as one preset transaction. */
export interface BlueprintApplyChangeSetRequest {
  /** Conversation whose durable Proposal authorizes this transaction. */
  sourceSessionId: string
  /** Interaction that owns the Proposal and the user's terminal decision. */
  routeId: string
  /** Tool-call identity of the confirmed Change Set. */
  changeSetId: string
  /** User preset whose composition receives the transaction. */
  presetId: string
  /** Projection revision against which every operation was proposed. */
  baseRevision: string
  /** Distinct typed operations staged before any preset write. */
  operations: BlueprintChangeSetOperation[]
}

/** Terminal state of one transactional Blueprint Apply attempt. */
export type BlueprintApplyChangeSetStatus =
  | 'committed'
  | 'preflight_failed'
  | 'staging_failed'
  | 'commit_failed'
  | 'reprojection_failed_recovered'
  | 'reprojection_failed_conflict'
  | 'reprojection_failed_recovery_failed'

/** Lightweight evidence returned by one transactional Blueprint Apply attempt. */
export interface BlueprintApplyChangeSetResult {
  /** Conversation whose durable Proposal authorized this attempt. */
  sourceSessionId: string
  /** Interaction whose terminal decision produced this attempt. */
  routeId: string
  /** Tool-call identity supplied by the confirmed Change Set. */
  changeSetId: string
  /** Projection revision checked before staging. */
  baseRevision: string
  /** Revision produced by the staged composition when a commit was attempted. */
  committedRevision?: string
  /** Terminal transaction outcome. */
  status: BlueprintApplyChangeSetStatus
  /** Operations admitted by the closed batch API. */
  operations: BlueprintChangeSetOperation[]
  /** Whether every operation passed the no-write validation phase. */
  preflight: { ok: true } | { ok: false; reason: string }
  /** Non-target semantic nodes changed by post-write reprojection. */
  unexpectedDrift: string[]
  /** Internal failure summary; the Client maps statuses to product copy. */
  failure?: string
}

/** Durable transaction outcome stored in the source Session event log. */
export interface BlueprintApplyResultEvent {
  /** Session whose user confirmed the Change Set. */
  sourceSessionId: string
  /** Interaction whose Proposal received the terminal Apply decision. */
  routeId: string
  /** Durable successful Proposal Tool result that authorized this terminal. */
  proposalResultSeq: number
  /** Exact preset addressed by the transaction. */
  presetId: string
  /** Complete typed operation identity and terminal P0 evidence, not current-value inference. */
  result: BlueprintApplyChangeSetResult
}

/** Host-projected Apply outcome with its authoritative terminal event order. */
export interface BlueprintApplyReceipt extends BlueprintApplyResultEvent {
  /** Sequence of the durable `blueprint/apply-result` event in the source Session. */
  terminalSeq: number
}

/** Host request to durably dismiss one exact Proposal without writing its preset. */
export interface BlueprintCancelChangeSetRequest {
  /** Conversation whose durable Proposal receives the decision. */
  sourceSessionId: string
  /** Interaction that owns the Proposal. */
  routeId: string
  /** Tool-call identity of the Proposal to dismiss. */
  changeSetId: string
}

/** Durable terminal fact that one exact Proposal was dismissed. */
export interface BlueprintProposalCancellation {
  /** Conversation that owns the Proposal. */
  sourceSessionId: string
  /** Interaction that owns the Proposal. */
  routeId: string
  /** Durable successful Proposal Tool result that authorized this terminal. */
  proposalResultSeq: number
  /** Tool-call identity of the dismissed Proposal. */
  changeSetId: string
  /** Preset the dismissed Proposal would have changed. */
  presetId: string
  /** Projection revision retained by the dismissed Proposal. */
  baseRevision: string
  /** Fixed terminal state for client recovery. */
  status: 'cancelled'
}

/** Host Remote request to validate a live Session against its preset projection. */
export type BlueprintValidateSessionRequest = {
  /** Live Session id. */
  sessionId: string
  /** Preset the Session is expected to run. */
  presetId: string
  /** Blueprint revision shown when the trial Session was created. */
  expectedRevision: string
} & ({
  /** Source Session that durably owns the matching committed Change Set. */
  sourceSessionId: string
  /** Source interaction route that produced the matching committed Change Set. */
  routeId: string
  /** Matching committed Change Set selected from the latest durable Apply terminal. */
  changeSetId: string
} | {
  /** Receipt identity is omitted as one unit when no P0 evidence is requested. */
  sourceSessionId?: never
  /** Receipt identity is omitted as one unit when no P0 evidence is requested. */
  routeId?: never
  /** Receipt identity is omitted as one unit when no P0 evidence is requested. */
  changeSetId?: never
})

/** Pass/fail state of one runtime conformance category. */
export type BlueprintConformanceStatus = 'pass' | 'fail'

/** Prompt evidence for one projected Identity, Purpose, Behavior, or Output node. */
export interface BlueprintPromptEvidence {
  /** Stable Blueprint node matched against assembled section text. */
  nodeId: string
  /** Semantic prompt node category. */
  nodeType: 'identity' | 'purpose' | 'behavior' | 'output'
  /** Expected section that owns the node text, when one exists. */
  sectionName?: string
  /** SHA-256 of the expected section text; no prompt content crosses the Remote. */
  expectedSectionDigest?: string
  /** SHA-256 of the live section text with the same name. */
  liveSectionDigest?: string
  /** Whether the current node value occurs in the live owning section. */
  status: BlueprintConformanceStatus
}

/** Tool-schema evidence for one projected capability. */
export interface BlueprintToolEvidence {
  /** Stable capability node. */
  nodeId: string
  /** Model-visible tool name. */
  tool: string
  /** Enablement projected to the user. */
  expectedEnabled: boolean
  /** Whether the live scoped assembly exposes the tool. */
  actualPresent: boolean
  /** SHA-256 of the expected model-visible schema when enabled. */
  expectedSchemaDigest?: string
  /** SHA-256 of the live model-visible schema when present. */
  liveSchemaDigest?: string
  /** Presence and schema comparison result. */
  status: BlueprintConformanceStatus
}

/** Runtime catalog evidence for one projected Skill capability. */
export interface BlueprintSkillEvidence {
  /** Stable Skill capability node. */
  nodeId: string
  /** Kebab-case Skill identity. */
  name: string
  /** Whether the live scoped registry contains the Skill. */
  actualPresent: boolean
  /** Expected loaded-definition digest. */
  expectedDefinitionDigest: string
  /** Live loaded-definition digest when present. */
  liveDefinitionDigest?: string
  /** Identity, invocation policy, scope ownership, and definition comparison result. */
  status: BlueprintConformanceStatus
}

/** Tool, prompt, and provider evidence for one projected delegation capability. */
export interface BlueprintDelegationEvidence {
  /** Stable delegation capability node. */
  nodeId: string
  /** Stable composition row id. */
  rowId: string
  /** Model-visible delegation Tool name. */
  tool: string
  /** Configured provider name. */
  provider: string
  /** Whether provider availability matches the projection. */
  providerAvailable: boolean
  /** Optional prompt section contributed by delegation modes that add runtime guidance. */
  sectionName?: string
  /** SHA-256 of the expected delegation prompt section. */
  expectedSectionDigest?: string
  /** SHA-256 of the live delegation prompt section. */
  liveSectionDigest?: string
  /** Provider, Tool schema, and delegation prompt comparison result. */
  status: BlueprintConformanceStatus
}

/** Session preset identity and revision-equivalence evidence. */
export interface BlueprintSessionBindingEvidence {
  /** Overall preset identity and expected-revision check. */
  status: BlueprintConformanceStatus
  /** Preset recorded durably in the Session header. */
  sessionPresetId?: string
  /** Preset generation joined by the live Agent scope. */
  composedPresetId?: string
  /** Revision shown when the trial Session was requested. */
  expectedRevision: string
  /** Revision reprojected from current preset text during validation. */
  projectedRevision: string
  /** Current implementation proves runtime content equivalence, not a generation's source hash. */
  strictRevisionBound: false
}

/** Evidence chain joining one durable successful Apply transaction to runtime validation. */
export interface BlueprintChangeReceipt {
  /** Confirmed Change Set identity. */
  changeSetId: string
  /** Revision the transaction preflighted. */
  baseRevision: string
  /** Revision published and reprojected by the transaction. */
  committedRevision: string
  /** P0 transaction stages recovered from the exact source Session receipt. */
  apply: {
    preflight: 'pass'
    presetWrite: 'pass'
    reprojection: 'pass'
    semanticDrift: 'none'
  }
  /** P1 runtime stages from the newly created live Session. */
  runtime: {
    prompt: BlueprintConformanceStatus
    tools: BlueprintConformanceStatus
    skills: BlueprintConformanceStatus
    delegations: BlueprintConformanceStatus
    permissions: BlueprintConformanceStatus
    overall: BlueprintConformanceStatus
  }
}

/** Content-level conformance of one live Session against the expected Blueprint. */
export interface BlueprintSessionValidation {
  /** Validated Session id. */
  sessionId: string
  /** Validated preset id. */
  presetId: string
  /** True only when binding, prompt content, schemas, and permissions all pass. */
  valid: boolean
  /** Same state as `valid`, expressed for the evidence categories. */
  overall: BlueprintConformanceStatus
  /** Session target and current expected-revision evidence. */
  binding: BlueprintSessionBindingEvidence
  /** Content-level evidence without raw prompt text. */
  prompt: {
    status: BlueprintConformanceStatus
    evidence: BlueprintPromptEvidence[]
  }
  /** Tool presence and full model-visible schema evidence. */
  tools: {
    status: BlueprintConformanceStatus
    evidence: BlueprintToolEvidence[]
    missing: string[]
    unexpected: string[]
    /** Present tools whose model-visible JSON schema differs. */
    schemaMismatches: string[]
  }
  /** Scoped Skill identity, policy, and definition evidence. */
  skills: {
    status: BlueprintConformanceStatus
    evidence: BlueprintSkillEvidence[]
    missing: string[]
    unexpected: string[]
  }
  /** Configured delegation provider and prompt evidence. */
  delegations: {
    status: BlueprintConformanceStatus
    evidence: BlueprintDelegationEvidence[]
  }
  /** Effective permission comparison. */
  permissions: {
    status: BlueprintConformanceStatus
  }
  /** Matching durable P0 receipt associated through the source Session log. */
  changeReceipt?: BlueprintChangeReceipt
}

/** Operations the model may propose without mutating a preset. */
export type BlueprintChangeOperation = 'updateIdentity' | 'updatePurpose' | 'updateBehavior' | 'setCapability' | 'updateOutput'

/** Scalar values admitted by the current write-back adapter. */
export type BlueprintProposalValue = string | boolean

/** Semantic operation recorded after one direct Blueprint edit commits. */
export type BlueprintUserChangeOperation = 'update' | 'enable' | 'disable'

/** Deterministic reason one node may be affected by a committed direct edit. */
export type BlueprintImpactEvidence = {
  /** Exact canonical Tool name referenced by the candidate text. */
  kind: 'tool-reference'
  /** Canonical model-visible Tool name. */
  value: string
} | {
  /** Literal present in the old Purpose and candidate, but absent from the new Purpose. */
  kind: 'removed-literal'
  /** Exact shared literal. */
  value: string
} | {
  /** Editable Identity, Behavior, or Output node owned by the same persona as Purpose. */
  kind: 'purpose-child'
} | {
  /** Editable Purpose, Behavior, or Output node owned by the same persona as Identity. */
  kind: 'identity-peer'
}

/** One Host-discovered node the model may judge during reconciliation. */
export interface BlueprintImpactCandidate {
  /** Stable candidate node id. */
  nodeId: string
  /** Deterministic evidence that admitted the node to the bounded candidate set. */
  evidence: BlueprintImpactEvidence[]
}

/** Minimal browser evidence attached only after write-back and reprojection succeed. */
export interface BlueprintUserChangeInput {
  /** Edited node in the freshly projected Blueprint. */
  nodeId: string
  /** Scalar value replaced by the direct edit. */
  previousValue: BlueprintProposalValue
}

/** Durable semantic fact that one user completed a direct Blueprint edit. */
export interface BlueprintUserChange {
  /** Real preset changed by the user. */
  presetId: string
  /** Stable projected node identity. */
  nodeId: string
  /** Semantic Blueprint section containing the node. */
  nodeType: BlueprintNodeType
  /** Human-readable node label without adapter details. */
  label: string
  /** Scalar value before the committed direct edit. */
  previousValue: BlueprintProposalValue
  /** Scalar value in the successful fresh projection. */
  currentValue: BlueprintProposalValue
  /** Semantic edit kind derived from the two values. */
  operation: BlueprintUserChangeOperation
  /** Bounded Host-discovered nodes the model may consider for related proposals. */
  impactCandidates: BlueprintImpactCandidate[]
}

/** Durable, typed preview produced by the model-facing proposal Tool. */
export interface BlueprintChangeProposal {
  /** Tool-call identity used by the UI to address this proposal. */
  proposalId: string
  /** Real preset the proposal targets. */
  presetId: string
  /** Projection revision against which the proposal was validated. */
  revision: string
  /** Exact projected node selected by the proposal. */
  targetNodeId: string
  /** Existing typed Host operation to call only after user confirmation. */
  operation: BlueprintChangeOperation
  /** Exact current scalar value validated by the Host. */
  currentValue: BlueprintProposalValue
  /** Replacement scalar value proposed by the model. */
  proposedValue: BlueprintProposalValue
  /** Short user-facing effect summary written by the model. */
  impact: string
  /** Exact consistency dependency on the committed direct edit, when one authorized this proposal. */
  dependency?: string
}

/** Durable grouped preview returned by one proposal Tool call. */
export type BlueprintChangeSet = {
  /** Tool-call identity used by the UI to confirm or dismiss the whole set. */
  changeSetId: string
  /** Conversation Session whose interaction produced this preview. */
  sourceSessionId: string
  /** Interaction identity that owns this preview and its operation decision. */
  routeId: string
  /** Real preset every proposal targets. */
  presetId: string
  /** Projection revision against which every proposal was first validated. */
  revision: string
  /** Individually typed and validated writes; Apply stages the whole set as one preset transaction. */
  proposals: readonly BlueprintChangeProposal[]
} & ({
  /** A direct conversation request authorizes exactly one proposed write. */
  kind: 'direct-request'
} | {
  /** A structured editor submission stages its source write and any P2-bounded dependent writes together. */
  kind: 'structured-edit'
  /** Node edited in the Blueprint panel without changing the committed projection. */
  sourceNodeId: string
  /** Semantic section of the staged source node. */
  sourceNodeType: Exclude<BlueprintNodeType, 'access'>
  /** Human-readable label of the staged source node. */
  sourceLabel: string
} | {
  /** A committed direct edit authorizes only causally related reconciliation writes. */
  kind: 'direct-edit-reconciliation'
  /** Node whose successful direct edit caused the consistency check. */
  sourceNodeId: string
  /** Semantic section of the directly edited node. */
  sourceNodeType: BlueprintNodeType
  /** Human-readable label of the directly edited node. */
  sourceLabel: string
})

/** Browser-submitted semantic edit that must become a Proposal before any preset write. */
export type BlueprintStructuredEditInput = {
  /** Conversation that owns this editor interaction. */
  sourceSessionId: string
  /** Client-issued identity for this editor interaction. */
  routeId: string
  /** Exact editable node selected in the committed projection. */
  nodeId: string
} & ({
  /** Editable text node type displayed when the editor opened. */
  nodeType: 'identity' | 'purpose' | 'behavior' | 'output'
  /** Committed text displayed when the editor opened. */
  expectedValue: string
  /** User-confirmed editor draft to stage in the Proposal. */
  proposedValue: string
} | {
  /** Independently writable Web capability displayed when the editor opened. */
  nodeType: 'capability'
  /** Committed enablement displayed when the editor opened. */
  expectedValue: boolean
  /** User-confirmed enablement to stage in the Proposal. */
  proposedValue: boolean
})

/** Browser-to-Host synchronization of one conversation's Blueprint context. */
export interface BlueprintConversationContextRequest {
  /** Live conversation Session receiving context and, for a preset target, the proposal Tool. */
  sessionId: string
  /** Target preset; omit with no Creator Draft to clear the Session's Blueprint context. */
  presetId?: string
  /** Exact target projection revision; required when presetId is present. */
  revision?: string
  /** Optional selected node; absence keeps the whole Blueprint as context. */
  selectedNodeId?: string
  /** Successful direct edit to record and reconcile after this projection installs. */
  userChange?: BlueprintUserChangeInput
  /** Structured semantic edit to submit as a source-owned Proposal without writing the preset. */
  directEditInput?: BlueprintStructuredEditInput
  /** Submit the original Add capability request after installing target context; guidance is not user text. */
  capabilityInput?: {
    /** Client-issued identity for this interaction. */
    routeId: string
    /** Exact user request submitted by the capability entry. */
    userRequest: string
  }
  /** Creator Draft context; mutually exclusive with the top-level preset fields. */
  creatorDraft?: {
    /** Human-facing Agent name derived from the explicit creation request. */
    name: string
    /** Coordinator lifecycle before a real target preset becomes Ready. */
    status: 'creating' | 'waiting' | 'paused' | 'ambiguity'
    /** Reliably associated preset whose current projection may be discussed while Creator owns writes. */
    targetPresetId?: string
    /** Optional node selected from the associated target's current real projection. */
    selectedNodeId?: string
  }
  /** Typed new-Agent authoring continuation; mutually exclusive with every existing-target field. */
  creatorAuthoring?: {
    /** Stable Tool-call identity linking the routing decision to this Creator Session. */
    routeId: string
    /** Conversation Session in which the user requested the new Agent. */
    sourceSessionId: string
    /** Exact direct-user request retained for Creator steering and recovery. */
    request: string
    /** User-facing Draft name chosen by the typed routing decision. */
    name: string
    /** Open language metadata for the original request when its script is recognized. */
    sourceLanguage?: string
    /** Host-issued source-turn fence and unique Creator destination. */
    handoff?: NonNullable<BlueprintCreatorAuthoringRoute['handoff']>
  }
  /** Reinstall a typed new-Agent authoring context from this Creator Session's durable event. */
  recoverCreatorAuthoring?: boolean
  /** Existing-preset capability authoring context; mutually exclusive with every other target field. */
  capabilityAuthoring?: {
    /** Interaction identity inherited from the accepted route. */
    routeId: string
    /** Existing-Agent conversation that owns the route. */
    sourceSessionId: string
    /** Existing preset that Creator may edit but must never copy over or replace implicitly. */
    targetPresetId: string
    /** Plain-language capability outcome carried from the Builder. */
    request: string
    /** Target projection revision on which the route was accepted. */
    baseRevision: string
    /** Concrete authoring mechanism selected by the existing-Agent conversation. */
    kind: BlueprintCapabilityAuthoringKind
  }
  /** Reinstall an active capability-authoring context from this Session's durable lifecycle event. */
  recoverCapabilityAuthoring?: boolean
  /** End the active capability-authoring lifecycle and remove its scoped context. */
  capabilityAuthoringEnd?: {
    /** Terminal outcome retained so a reload cannot resurrect settled work. */
    outcome: 'completed' | 'failed' | 'cancelled'
  }
}

/** Authoring mechanisms that require Creator-owned preset composition changes. */
export type BlueprintCapabilityAuthoringKind = 'skill' | 'subagent'

/** Durable identity and content summary of one preset roster entry. */
export interface BlueprintCapabilityPresetBaseline {
  /** Stable preset directory id. */
  id: string
  /** Trust inherited from the winning configured preset root. */
  trust: 'system' | 'user'
  /** Display name resolved from preset metadata. */
  name?: string
  /** Display description resolved from preset metadata. */
  description?: string
  /** Display order resolved from preset metadata. */
  order?: number
  /** Discovery reason when the roster entry cannot mount. */
  broken?: string
  /** SHA-256 of the exact composition text, or null when discovery could not read it. */
  compositionDigest: string | null
}

/** Durable reference to one hidden, route-owned preset candidate. */
export interface BlueprintCapabilityCandidate {
  /** Candidate storage format. */
  version: 1
  /** Domain-separated transaction identity used only as a hidden sibling directory name. */
  transactionId: string
  /** Absolute formal composition path; remains locatable while its directory is parked during commit. */
  targetPath: string
  /** Formal composition revision accepted by the source route. */
  baseRevision: string
  /** Digest of the complete formal preset tree before candidate creation. */
  baselineTreeDigest: string
}

/** Complete-tree evidence recorded when a candidate is committed or safely discarded. */
export interface BlueprintCapabilityCandidateDisposition {
  /** Candidate transaction named by the matching lifecycle start. */
  transactionId: string
  /** Stable candidate tree observed across the final verification. */
  candidateTreeDigest: string
  /** Formal preset tree after settlement. */
  finalTreeDigest: string
  /** Verified publication or no-publication cleanup. */
  disposition: 'committed' | 'discarded'
}

/** Durable start or terminal marker for existing-preset capability authoring. */
export type BlueprintCapabilityAuthoringEvent = {
  /** Interaction identity inherited from the accepted capability route. */
  routeId: string
  /** Existing-Agent conversation that owns the accepted route. */
  sourceSessionId: string
  /** Existing preset whose composition Creator owns for this lifecycle. */
  targetPresetId: string
  /** Original user outcome retained without implementation fields. */
  request: string
  /** Authoring mechanism chosen by the typed route. */
  kind: BlueprintCapabilityAuthoringKind
  /** Target projection revision on which the source route was accepted. */
  baseRevision: string
  /** Exact preset roster, composition digests, and display metadata before authoring. */
  baselinePresets: BlueprintCapabilityPresetBaseline[]
  /** Exact projected nodes before authoring, used to admit only the selected capability delta. */
  baselineNodes: Pick<BlueprintNode, 'id' | 'type' | 'value' | 'source' | 'status'>[]
  /** Complete scoped Skill summaries before authoring, including definition digests. */
  baselineSkills: BlueprintRuntimeSkill[]
  /** Complete projected delegation summaries before authoring, including config digests. */
  baselineDelegations: BlueprintRuntimeDelegation[]
  /** Isolated candidate whose path is visible only inside the owning Creator scope. */
  candidate: BlueprintCapabilityCandidate
  /** Configured repair budget fixed when the route is adopted. */
  maxRepairAttempts: number
} & ({
  /** Opens one recoverable lifecycle in the owning Creator Session. */
  state: 'started'
} | {
  /** Closes the exact lifecycle identified by its start event sequence. */
  state: 'ended'
  /** Sequence number of the matching started event. */
  startSeq: number
  /** Reason the client must not restore this lifecycle. */
  outcome: 'completed' | 'failed' | 'cancelled'
  /** Fresh mounted projection supporting a successful Skill lifecycle, without Skill body text. */
  skillEvidence?: {
    turnEndSeq: number
    revision: string
    skills: Pick<BlueprintRuntimeSkill, 'name' | 'definitionDigest' | 'invocation'>[]
    verification: BlueprintSessionValidation
  }
  /** New mounted rows and the existing P1 result from a dedicated, non-business verification Session. */
  subagentEvidence?: {
    turnEndSeq: number
    revision: string
    delegations: BlueprintRuntimeDelegation[]
    verification: BlueprintSessionValidation
  }
  /** Exhausted or cancelled internal prerequisite; source presentation never exposes its message. */
  capabilityFailure?: {
    turnEndSeq: number
    attempt: number
    prerequisite: 'creator_turn' | 'candidate_delta' | 'fresh_mount' | 'runtime_conformance' | 'projection' | 'commit' | 'cancelled'
    message: string
  }
  /** Complete-tree proof that only a verified candidate was published. */
  candidateDisposition?: BlueprintCapabilityCandidateDisposition
})

/** Durable first authoring input hidden from Chat and retired from later model history at terminal settlement. */
export interface BlueprintCapabilityAuthoringSource {
  kind: 'blueprint-capability-authoring'
  routeId: string
  startSeq: number
  presentation: 'internal'
}

/** Model-visible, durable internal repair input sent only to the owning authoring lifecycle. */
export interface BlueprintCapabilityRepairSource {
  kind: 'blueprint-capability-repair'
  routeId: string
  startSeq: number
  attempt: number
  prerequisite: 'creator_turn' | 'candidate_delta' | 'fresh_mount' | 'runtime_conformance' | 'projection' | 'commit'
  /** Omitted only by legacy background-Creator records written before same-source authoring. */
  presentation?: 'internal'
}

/** Durable replacement summary that closes one internal same-source authoring transcript. */
export interface BlueprintCapabilityTerminalSource {
  kind: 'blueprint-capability-terminal'
  /** Route whose internal authoring turns no longer authorize work. */
  routeId: string
  /** Started event closed by the terminal. */
  startSeq: number
  /** Durable lifecycle outcome retained without replaying Creator implementation details. */
  outcome: Extract<BlueprintCapabilityAuthoringEvent, { state: 'ended' }>['outcome']
  /** Ordinary Chat never presents this model-history replacement as user content. */
  presentation: 'internal'
}

/** Durable internal validation miss that may schedule one same-route Creator repair turn. */
export interface BlueprintCapabilityRepairEvent {
  /** Route retained from the owning lifecycle. */
  routeId: string
  /** Started event receiving this attempt. */
  startSeq: number
  /** Creator turn whose isolated candidate failed verification. */
  turnEndSeq: number
  /** One-based automatic repair attempt. */
  attempt: number
  /** Failed prerequisite passed privately to Creator. */
  prerequisite: BlueprintCapabilityRepairSource['prerequisite']
  /** Exact Host diagnostic retained outside source presentation. */
  message: string
  /** Stable complete candidate tree handed from the failed verifier to the repair turn. */
  candidateTreeDigest: string
  /** Deterministic plugin-message identity used to recover enqueue exactly once. */
  repairMessageId: MessageId
}

/** Durable user cancellation intent for one active capability-authoring lifecycle. */
export interface BlueprintCapabilityCancelRequestedEvent {
  /** Route retained from the owning lifecycle. */
  routeId: string
  /** Started event that must stop without publishing its candidate. */
  startSeq: number
}

/** Durable pre-publication proof used to finish commit after a Host or client restart. */
export type BlueprintCapabilityVerifiedEvent = {
  /** Route retained from the owning lifecycle. */
  routeId: string
  /** Started event whose isolated candidate passed. */
  startSeq: number
  /** Creator turn followed by fresh runtime verification. */
  turnEndSeq: number
  /** Complete candidate tree proven stable across verification. */
  candidateTreeDigest: string
} & ({
  /** Skill lane publishes only this verified evidence. */
  kind: 'skill'
  skillEvidence: NonNullable<Extract<BlueprintCapabilityAuthoringEvent, { state: 'ended' }>['skillEvidence']>
} | {
  /** Subagent lane publishes only this verified evidence. */
  kind: 'subagent'
  subagentEvidence: NonNullable<Extract<BlueprintCapabilityAuthoringEvent, { state: 'ended' }>['subagentEvidence']>
})

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'blueprint-capability-authoring': BlueprintCapabilityAuthoringSource
    'blueprint-capability-repair': BlueprintCapabilityRepairSource
    'blueprint-capability-terminal': BlueprintCapabilityTerminalSource
  }
}

/** Structured result that hands one existing-preset capability gap to Creator. */
export interface BlueprintCapabilityAuthoringRoute {
  /** Interaction identity that selected this authoring route. */
  routeId: string
  /** Existing-Agent conversation that owns the interaction. */
  sourceSessionId: string
  /** Existing Blueprint target. */
  presetId: string
  /** Projection revision on which the routing decision was made. */
  revision: string
  /** User outcome Creator must preserve. */
  request: string
  /** Required preset authoring mechanism. */
  kind: BlueprintCapabilityAuthoringKind
  /** Concise reason the existing Blueprint operations cannot implement the request. */
  reason: string
}

/** Structured decision that continues one direct request as new-Agent Creator authoring. */
export interface BlueprintCreatorAuthoringRoute {
  /** Fixed operation consumed by the Creator executor. */
  operation: 'create-agent'
  /** Stable Tool-call identity used to deduplicate the durable Creator continuation. */
  routeId: string
  /** Exact direct-user request, never a model-authored paraphrase. */
  request: string
  /** User-facing Draft name selected by the model. */
  name: string
  /** Open language metadata for the original request when its script is recognized. */
  sourceLanguage?: string
  /** Present on live exclusive routes; absent on historical routes. */
  handoff?: {
    /** Exact source turn whose execution must settle before Creator starts. */
    sourceTurn: number
    /** Deterministic, distinct Creator Session identity reserved for this route. */
    targetCreatorSessionId: string
  }
}

/** Durable new-Agent task: prepared in the source log, then adopted by its distinct Creator. */
export interface BlueprintCreatorAuthoringEvent extends BlueprintCreatorAuthoringRoute {
  /** Conversation Session that produced the typed routing decision. */
  sourceSessionId: string
  /** Legacy persisted source-language key; new events write sourceLanguage instead. */
  language?: string
}

/** Task-scoped terminal fact; later Session turns cannot reopen this route. */
export type BlueprintCreatorAuthoringEnd = {
  routeId: string
  startSeq: number
  turnEndSeq: number
} & ({
  outcome: 'completed'
  targetPresetId: string
  validationSeq: number
} | {
  outcome: 'failed' | 'cancelled'
})

/** Host-validated structured edit retained with its deterministic P2 candidate set. */
export interface BlueprintStructuredEdit {
  /** Exact committed node staged by the editor. */
  nodeId: string
  /** Semantic type of the selected editable node. */
  nodeType: Exclude<BlueprintNodeType, 'access'>
  /** Human-readable semantic label. */
  label: string
  /** Typed write that Apply may execute. */
  operation: BlueprintChangeOperation
  /** Committed value that must remain current through Apply preflight. */
  currentValue: BlueprintProposalValue
  /** Staged value visible only in the Proposal before Apply. */
  proposedValue: BlueprintProposalValue
  /** Only nodes the model may inspect for dependent P2 changes. */
  impactCandidates: BlueprintImpactCandidate[]
}

/** Host-owned provenance for one explicit Blueprint UI interaction. */
export type BlueprintRoutingInputEvent = {
  routeId: string
  sourceSessionId: SessionId
  messageId: MessageId
  userRequest: string
  targetPresetId: string
} & ({
  uiAction: 'add-capability'
} | {
  uiAction: 'direct-edit'
  directEdit: BlueprintStructuredEdit
})

/** One admitted top-level operation attempt; its existing tool/result records acceptance or failure. */
export interface BlueprintRouteDecision {
  routeId: string
  sourceSessionId: SessionId
  userMessageId: MessageId
  userMessageSeq: number
  turn: number
  operation: 'create-agent' | 'modify-existing-agent' | 'skill' | 'subagent'
  callId: CallId
  targetPresetId: string
  provenance: 'user-message' | 'add-capability' | 'direct-edit'
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Binds an explicit Blueprint UI action to its original admitted user message.
     * @param routeId - distinct interaction identity issued for this action.
     * @param sourceSessionId - Session receiving the request.
     * @param messageId - exact submitted message identity.
     * @param userRequest - original user text, excluding routing guidance.
     * @param uiAction - UI operation constraint.
     * @param targetPresetId - existing Agent addressed by the action.
     * @param directEdit - exact staged source edit and P2 candidates for a direct-edit action.
     */
    'blueprint/routing-input': BlueprintRoutingInputEvent
    /**
     * Reserves one top-level operation per interaction before asynchronous route validation.
     * @param routeId - interaction whose operation is reserved.
     * @param sourceSessionId - operation-owning Session.
     * @param userMessageId - current real user input identity.
     * @param userMessageSeq - current real user event sequence.
     * @param turn - source turn retained for terminal evidence.
     * @param operation - model-classified operation admitted by Host provenance checks.
     * @param callId - attempt whose tool/result determines acceptance.
     * @param targetPresetId - current Blueprint target.
     * @param provenance - direct message, target-bound capability action, or structured edit action.
     */
    'blueprint/route-decision': BlueprintRouteDecision
    /**
     * Retains one dismissed Proposal as an immutable source-and-route terminal.
     * @param sourceSessionId - conversation that owns the Proposal.
     * @param routeId - source interaction identity.
     * @param changeSetId - Proposal Tool call identity.
     * @param presetId - Proposal target.
     * @param baseRevision - Proposal projection revision.
     * @param status - fixed cancelled terminal state.
     */
    'blueprint/proposal-cancelled': BlueprintProposalCancellation
    /**
     * Retains a confirmed Blueprint transaction outcome without waking the model.
     * @param sourceSessionId - conversation owning the confirmation.
     * @param routeId - interaction whose Proposal was confirmed.
     * @param proposalResultSeq - successful Proposal Tool result that authorized the transaction.
     * @param presetId - preset addressed by the transaction.
     * @param result - terminal P0 outcome and exact typed operations.
     */
    'blueprint/apply-result': BlueprintApplyResultEvent
    /**
     * Retains existing-preset capability authoring across client reloads.
     * @param routeId - source interaction identity.
     * @param sourceSessionId - existing-Agent conversation that owns the route.
     * @param targetPresetId - existing preset Creator may modify.
     * @param request - original capability outcome.
     * @param kind - typed authoring mechanism.
     * @param baselinePresets - exact roster content and metadata before authoring started.
     * @param baselineSkills - exact scoped Skill definitions before authoring started.
     * @param baselineDelegations - exact delegation rows and config digests before authoring started.
     * @param state - lifecycle start or end marker.
     */
    'blueprint/capability-authoring': BlueprintCapabilityAuthoringEvent
    /**
     * Records one internal candidate validation miss before the same Creator is resumed.
     * @param routeId - owning capability route.
     * @param startSeq - owning lifecycle start.
     * @param turnEndSeq - failed Creator turn.
     * @param attempt - one-based repair attempt.
     * @param prerequisite - failed internal validation category.
     * @param message - exact private diagnostic.
     * @param repairMessageId - deterministic follow-up message identity.
     */
    'blueprint/capability-repair': BlueprintCapabilityRepairEvent
    /**
     * Checkpoints user cancellation before pending Creator work is retracted.
     * @param routeId - owning capability route.
     * @param startSeq - owning lifecycle start.
     */
    'blueprint/capability-cancel-requested': BlueprintCapabilityCancelRequestedEvent
    /**
     * Checkpoints fresh candidate verification before the filesystem publication transaction.
     * @param routeId - owning capability route.
     * @param startSeq - owning lifecycle start.
     * @param turnEndSeq - verified Creator turn.
     * @param candidateTreeDigest - stable complete candidate tree.
     * @param kind - verified Skill or Subagent lane.
     */
    'blueprint/capability-verified': BlueprintCapabilityVerifiedEvent
    /**
     * Retains one typed new-Agent request in the Creator Session that executes it.
     * @param operation - fixed create-agent operation.
     * @param routeId - routing Tool call identity.
     * @param sourceSessionId - conversation that requested the new Agent.
     * @param request - exact original user request.
     * @param name - user-facing Draft name.
     * @param sourceLanguage - optional open language metadata for authored semantic fields.
     */
    'blueprint/creator-authoring': BlueprintCreatorAuthoringEvent
    /**
     * Closes one Creator task without changing its start or subsequent Session history.
     * @param routeId - task identity from the accepted create-agent route.
     * @param startSeq - owning Creator start event.
     * @param turnEndSeq - authoring turn that supplied the terminal result.
     * @param outcome - completed, failed, or explicitly cancelled task.
     */
    'blueprint/creator-authoring-ended': BlueprintCreatorAuthoringEnd
    /**
     * Records a committed direct Blueprint edit before its plugin follow-up wakes the model.
     * @param presetId - real preset changed by the user.
     * @param nodeId - stable projected node identity.
     * @param nodeType - semantic Blueprint section containing the node.
     * @param label - human-readable node label.
     * @param previousValue - scalar value before the direct edit.
     * @param currentValue - scalar value in the fresh projection.
     * @param operation - semantic update, enable, or disable operation.
     * @param impactCandidates - deterministic nodes admitted for reconciliation.
     */
    'blueprint/user-change': BlueprintUserChange
  }
}

/** Result of synchronizing one Session's optional Blueprint context. */
export interface BlueprintConversationContextResult {
  /** Transaction outcomes recovered with their authoritative durable terminal order. */
  applyReceipts?: BlueprintApplyReceipt[]
  /** Dismissed Proposals recovered from this Session's durable log. */
  proposalCancellations?: BlueprintProposalCancellation[]
  /** Live Session whose scoped registrations were updated. */
  sessionId: string
  /** Whether the Session now carries Blueprint or Creator Draft conversation context. */
  active: boolean
  /** Target preset when normal Blueprint context is active. */
  presetId?: string
  /** Selected node when one is active. */
  selectedNodeId?: string
  /**
   * Durable enqueue evidence for a structured semantic submission.
   * Present only after the matching routing input and user message have been flushed.
   */
  directEditEnqueue?: {
    /** Client-issued interaction identity echoed by the Host. */
    routeId: string
    /** Session that durably owns the submitted interaction. */
    sourceSessionId: string
    /** Durable sequence of the matching `blueprint/routing-input` event. */
    routingInputSeq: number
    /** User message queued to wake the owning Session. */
    messageId: MessageId
  }
  /** Recovered or newly installed typed new-Agent Creator task. */
  creatorAuthoring?: BlueprintCreatorAuthoringEvent & {
    /** Durable event sequence used as the Creator lifecycle trigger. */
    startSeq: number
    /** Task terminal evidence, independent of later Session turns. */
    terminal?: BlueprintCreatorAuthoringEnd
  }
  /** Recovered or newly installed existing-preset capability authoring context. */
  capabilityAuthoring?: {
    routeId: string
    sourceSessionId: string
    /** Existing preset bound to the Creator Session. */
    targetPresetId: string
    /** Original user capability request. */
    request: string
    /** Typed authoring mechanism. */
    kind: BlueprintCapabilityAuthoringKind
    /** Target revision on which the source route was accepted. */
    baseRevision: string
    /** Durable lifecycle start sequence used to classify later Session events. */
    startSeq: number
    /** Delegation rows present before this task started. */
    baselineDelegationRowIds: string[]
  }
  /** Latest durable capability-authoring lifecycle owned by this Creator Session. */
  capabilityAuthoringRecord?: {
    routeId: string
    sourceSessionId: string
    targetPresetId: string
    request: string
    kind: BlueprintCapabilityAuthoringKind
    baseRevision: string
    startSeq: number
    baselineDelegationRowIds: string[]
    state: 'active' | 'ended'
    /** Terminal event sequence; present only for an ended lifecycle. */
    endSeq?: number
    outcome?: 'completed' | 'failed' | 'cancelled'
    skillEvidence?: Extract<BlueprintCapabilityAuthoringEvent, { state: 'ended' }>['skillEvidence']
    subagentEvidence?: Extract<BlueprintCapabilityAuthoringEvent, { state: 'ended' }>['subagentEvidence']
  }
}
