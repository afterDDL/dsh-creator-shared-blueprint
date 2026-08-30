# Agent Note: Background Creator interactions remain child-owned

Status: implemented

English | [中文](2026-08-30-blueprint-background-interaction-ownership.zh.md)

## Problem

Interactive Blueprint keeps a source Session in the foreground while a reserved `cordis` child performs Creator authoring in the background. That child can block on a native question or approval. The first bad transition reduced the child's pending observation to a wait kind and source-visible status, discarding the exact `PendingWait`; the source could report that input was required but had no answerable composer interaction.

The violated invariant was that only the exact child carrier authorizes an answer. `PendingWait` retains private RPC correlation, the child Session id, and process-local response behavior. The source is a presentation owner, not a response owner, and neither copied payload fields nor a Host DTO can reconstruct that authority. The [foreground-ownership decision](2026-08-28-blueprint-creator-foreground-ownership.md) governs which source may publish Creator state; this decision governs the pending interaction projected there.

## Decision

The conversation plugin owns a per-source in-memory `ComposerInteractionRegistry` exposed as `ctx.conversation.interactions`. A producer replaces one source Session's exact external carriers. `ConversationRoot` composes the foreground Session's native waits first and appends external waits, suppressing an external wait only when a native wait has the same owning Session and carrier key. The ordinary composer chain therefore remains the single native renderer and answer path.

ui-blueprint retains the exact carrier from the background child observation and selects it only when the current Session owns the Creator or capability route and the carrier belongs to another Session. Its synchronization effect publishes that object to the current source registry. A source switch, resolved wait, lost route, or effect disposal publishes an empty list for the previous source. The source never copies the interaction or answers on the child's behalf; the native question or approval domain responds through the original carrier.

Host conversation-context results continue to carry durable source, route, lifecycle, and terminal facts without `PendingWait`. Refresh uses those facts to identify the child, then obtains a new exact carrier from the child Session's normal pending projection before republishing it to the source composer. Durable context alone never fabricates a response path.

## Alternatives considered

**Render the native controls directly inside Blueprint.** Cross-plugin component value imports violate the Client bundle-purity rule and make a details plugin own composer interaction behavior. The registry preserves plugin direction and the established native chain.

**Copy the wait into a Host DTO and proxy answers through the source.** A serializable copy lacks private RPC correlation and settlement state. Adding a second response protocol would duplicate the pending-interaction transport and blur the child Session's audit ownership.

**Navigate to the Creator child while it waits.** That exposes the interaction but abandons source continuity and makes a background executor responsible for foreground navigation.

## Consequences

The user remains on the source Session while its native composer presents a blocking child question or approval. The child retains response ownership, audit correlation, and settlement; ui-blueprint retains only presentation ownership and lifecycle status.

The registry is deliberately process-local. Refresh requires both durable Creator context and the child Session's replayed pending interaction; no new Host field, Session event, or wire format is introduced. The generic per-source registry can carry another plugin's exact interaction without ui-conversation importing that producer.

## Verification

Registry coverage pins stable per-source stores, exact object identity, replacement, clear, and source-scoped forget. Conversation-root coverage pins native-first ordering and suppression against a native owner-plus-key match. Blueprint controller coverage pins exact-carrier selection for the current Creator or capability source, rejects foreign and same-Session carriers, and clears a settled observation.
