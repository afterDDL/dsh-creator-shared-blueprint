# Agent Note: Structured Blueprint editing stages a route-owned Change Set

Status: implemented

English | [中文](2026-08-30-blueprint-structured-purpose-edit.zh.md)

## Problem

The first no-write-before-Apply repair staged Purpose but left Identity, Behavior, Output, Web Search, and Web Fetch on single-node write Remotes. The same visual Save gesture therefore had two transaction meanings: Purpose produced a Proposal, while the other controls changed the real preset before confirmation. Failed text submission also closed the editor and lost its draft. Proposal Apply trusted browser-supplied operations, and Cancel was browser-local, so refresh could revive a dismissed card.

## Decision

Every editable Identity, Purpose, Behavior, Output, Web Search, and Web Fetch control submits through one structured interaction. The client captures the committed scalar when the editor or switch opens, creates a new route id, and sends `sourceSessionId + routeId`, node id and type, expected value, and proposed value through conversation-context synchronization. The pre-submission draft is deliberately browser-local because it has not requested a durable business operation; Cancel discards only that draft. Successful submission creates the source-owned durable routing input and later Proposal, whose route, terminal decision, and receipt survive refresh. A failed submission keeps the editor and local draft visible. No structured control calls a single-node write Remote or updates the committed Blueprint store.

The Host reads the committed projection, verifies node identity, editability, scalar type, expected value, and supported operation, then derives deterministic P2 impact candidates. It records a source-owned `blueprint/routing-input`, wakes the same Session with a user-visible interaction, and returns enqueue evidence only after those durable inputs flush. The Client rejects missing or mismatched evidence. The Proposal Tool accepts only `modify-existing-agent`; its first change must exactly equal the structured source edit, while later changes must be distinct admitted candidates with explicit dependencies. The resulting `structured-edit` Change Set requires `sourceSessionId + routeId`, so only its source interaction renders the Proposal and terminal controls. The row additionally binds the Change Set id to its exact Tool call and admits the first structured proposal only when source node id, source type, operation, scalar type, and changed value agree. Proposal presentation admits Identity, Purpose, Behavior, Output, and Web capability source types, derives its title from the source type and label, and rejects Access.

Apply does not treat the browser copy as authorization. The Host locates the source Session's successful Proposal Tool result, validates its Tool call and route decision, reconstructs the exact closed operation list from durable metadata, and compares the request before entering the existing atomic P0 transaction. That comparison preserves operation-array order and checks discriminants, targets, and typed scalar fields without depending on transport object-key insertion order. Apply and Cancel share one per-preset serialized terminal decision: the same decision is idempotent, the opposite decision is rejected, and the resulting receipt or cancellation is appended and flushed before the Remote returns. Runtime validation resolves an optional P0 association from that exact source Session receipt instead of process memory, so a restored Session retains the `sourceSessionId + routeId + changeSetId` join after restart. Try waits for the current source Session's receipt hydration and selects the latest durable Apply terminal whose preset and committed revision match exactly; Proposal order, an in-memory last-Apply cache, and a Session switch cannot authorize P0. Receipt hydration may settle while Creator projection reconciliation is active, so the serialized reconciliation tail also drains observations enqueued while the prior drain finalizes. The validation response must echo the created Trial Session, preset, and expected revision. A post-open P1 failure is published only while that created Trial Session remains current, and a response that cites a third Session cannot redirect it. A successful Apply then causes one final `blueprint.get`; before it, the real preset and main Blueprint remain unchanged.

Capability authoring keeps its own route id and background Creator lifecycle, so a pending or completed structured edit cannot own a later Add capability request. Active capability execution excludes edit, Apply, another Add, and Try. Its durable baseline retains the preset roster and projected target, allowing terminal verification to reject unrelated semantic changes or an extra top-level preset.

## Alternatives considered

**Keep the old single-node Save calls.** Rejected because they write the preset before Proposal confirmation and retain a second mutation path with no durable interaction owner.

**Keep only Purpose staged and treat the other controls as immediate settings.** Rejected because the details panel presents them as one Blueprint editing surface, and every supported change affects later Agent assembly.

**Show the proposed value in the main Blueprint.** Rejected because the Blueprint projects committed Agent state. A draft without explicit pending semantics would misrepresent the real preset.

**Relax Proposal ownership for the structured route.** Rejected because foreground navigation or a later same-target interaction could display or apply another Session's pending edit.

## Consequences

All supported structured controls have the same draft, source-owned Proposal, Apply-or-Cancel terminal, receipt, and reprojection semantics. Editor failures preserve user input, refresh restores both Apply and Cancel, and a stale or foreign browser cannot authorize a preset write. One current owner therefore records the no-write-before-Apply requirement for the complete editable Blueprint surface.
