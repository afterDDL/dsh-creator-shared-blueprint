# Agent Note: Capability authoring continuation is source-authorized

Status: implemented

English | [中文](2026-08-30-blueprint-capability-authoring-authority.zh.md)

## Problem

An accepted capability route and a browser request previously carried the same fields, but the Host treated only the browser copy as input when starting Creator. A loopback caller could therefore invent a source, modify the target or request, or send one source route to several random Creator Sessions. The first bad transition cleared the proposed child's current conversation binding before any durable source evidence was checked, then appended a lifecycle start from untrusted content. A second race allowed the client to report `failed` after a prompt response was lost while the accepted Creator run could still write.

The [routing provenance decision](2026-08-28-blueprint-routing-provenance.md) owns source interaction arbitration, and [exact capability baselines](2026-08-30-blueprint-capability-exact-baseline.md) own terminal delta verification. This decision owns admission and explicit-terminal quiescence between them.

## Decision

One successful `route_blueprint_capability_authoring` Tool result in the source Session is the sole continuation-content authority. Admission requires its earlier matching Tool call and source-owned `blueprint/route-decision`, then reconstructs the route id, source Session, target preset, revision, original request, and authoring kind from result metadata. The browser DTO may only reproduce those values exactly.

A domain-separated SHA-256 of the source Session id and route id derives the only Creator Session that may adopt the route. The Host independently requires that live Agent to have the mounted `cordis` composition. First adoption permits only the at-most-once `permission/preset`, `sandbox/mode`, and `approval/policy` facts written during fresh Session initialization and rejects all prior task or authoring history; the resulting `blueprint/capability-authoring` start is the durable adoption receipt. An exact active retry reuses it. A foreign id, wrong composition, prior child history, failed or incomplete source result, modified DTO, different lifecycle, or settled replay is rejected before clearing a binding, registering model context, or appending a lifecycle event. Recovery may trust the validated child start without reopening the source.

The client cannot publish a `failed` capability terminal. Validation failures belong to the Host recovery lifecycle. A user cancellation first appends and flushes `blueprint/capability-cancel-requested`, then stops the active Creator, awaits `whenIdle()`, clears pending capability input, and discards the unpublished candidate. Settlement and process recovery recognize that checkpoint before any wake or verification, so cancellation cannot race a repaired turn into publication or recreate the interaction after restart.

## Alternatives considered

**Trust the loopback browser because it received the Tool result.** Loopback limits network reach; it does not make a second DTO a durable authority or coordinate retries and multiple windows.

**Allocate a random child and scan existing Sessions for duplicates.** Load order is not durable ownership. A deterministic destination makes the relationship independent of which Sessions are currently open.

**Add another source-side adoption event.** The accepted source Tool result already owns exact content, and the deterministic child start already records adoption. A third fact would duplicate those responsibilities without closing another transition.

**Let the client publish failure when one Creator observation fails.** A rejected or dropped response does not prove that no run was accepted, and one validation miss belongs to the recoverable configuration lifecycle. Only the Host may publish a failure after its repair budget is exhausted.

## Consequences

New admission requires the source Session to be loaded; refresh recovery of an already adopted child does not. Pre-release capability histories created under random child ids are rejected rather than silently upgraded. A predictable-id collision is safe only when the existing Agent is an empty `cordis` Session and the exact source route is valid; a wrong-preset or contaminated Session is rejected. The Session-create response's optional preset echo is not authority because the Host verifies the mounted composition. The cancellation checkpoint adds a known Session event without changing the Session envelope format. No Agent Loop or Creator runtime change is required.
