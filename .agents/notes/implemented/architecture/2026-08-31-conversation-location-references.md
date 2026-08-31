# Agent Note: Definition-owned conversation Location references

Status: implemented

English | [中文](2026-08-31-conversation-location-references.zh.md)

## Problem

Conversation projection plugins can emit a durable replacement or marker after the source Turn has already closed. Its payload may intentionally omit Turn and Step coordinates because the durable source event already owns them. Client Runtime previously recognized one `user/message` replacement and one presentation metadata value directly, so an out-of-tree projection could not retain source Location across live append, refresh, registry rebuild, or an expanding truncated window without patching Runtime internals.

## Decision

`ConversationNodeDefinition.locationReference(event)` may return one prior durable event `seq` for a Definition-owned projection event. The Location index remains the sole owner of Turn and Step coordinates. It inherits the referenced event's resolved coordinates when that event is loaded, records the projection event under that Location, and uses the same references during complete-window rebuild. A prepend that loads a formerly absent source event corrects the projection Location and replays only Contexts whose Match Location changed.

The hook is current-event-only and follows the existing Definition registration lifetime. A reference must be a non-negative safe integer smaller than the projection event's `seq`. Exactly one Definition may claim an event; competing claims reject rather than making registration order authoritative. The Runtime does not interpret surface replacement ranges, presentation metadata, Blueprint state, or renderer visibility. Those meanings stay with the Definition that owns the durable event.

The ordinary coordinate rules remain the default. Events with explicit Session, Turn, or Step coordinates do not need a reference. A source outside the current history window cannot supply coordinates until prepend loads it; the engine then rebuilds and repairs the affected Match instead of exposing a mutable Location map to plugins.

## Alternatives considered

**Expose the Runtime Location map.** Rejected because plugins could mutate engine-owned hierarchy state and make append and refresh disagree.

**Teach Runtime about replacement surface operations or internal presentation.** Rejected because those are producer and presentation semantics, not generic Location mechanics.

**Put the reference only on the rendered Node.** Rejected because rendering happens after Context matching and cannot repair Match Location, Turn data, or refresh replay.

## Consequences

Any client plugin can project a durable event at a prior event's stable Location without a product-specific Core branch. Runtime tests use a non-Blueprint review projection to prove append, registry rebuild, prepend repair, validation, and collision behavior. UI Conversation uses the hook for internal replacement messages, preserving the existing hidden-Turn result while removing presentation knowledge from Client Runtime.
