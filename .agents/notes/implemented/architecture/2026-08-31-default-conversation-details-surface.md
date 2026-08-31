# Agent Note: Default conversation details surface

Status: implemented

English | [中文](2026-08-31-default-conversation-details-surface.zh.md)

## Problem

A Session-oriented client plugin may need a persistent inspector in the right column while no transient Tool call is selected. Interactive Blueprint added a private default branch to the conversation details shell and depended on an early layout-open request. Without a documented public seat, another inspector would have to replace the complete `details` column or patch Blueprint's panel registration.

## Decision

`@deepseek-ai/dsh-client-ui-conversation` owns the session-scoped single slot `conversation.details.default` and exports `ConversationDefaultDetailsProps` for its standard runtime props. The conversation details shell renders that slot only when its shared selection store has no Tool target. A Tool selection temporarily renders the existing `conversation.details.tool` path; clearing the selection restores the same default slot entry and scoped component state.

The slot is declared by the `details` entry during normal ui-conversation startup. A consumer uses `ctx.slots.inject` so it may start before or after that declaration, and its registration disposer removes only its own surface. A missing or unloaded consumer receives a usable ui-conversation fallback with the ordinary details title, empty state, and close action. The single-slot collision rule rejects two simultaneous default owners rather than choosing by load order.

`@deepseek-ai/dsh-client-ui-layout` owns geometry through `ctx.layout`. `openDetails()` and `closeDetails()` retain only the latest pre-mount request until AppFrame attaches its store actions. This permits a presentation plugin to open its registered surface without depending on React mount order. After attachment, calls act immediately and repeated opens preserve the user's current width.

Neither package persists feature data. The default entry reads durable state through standard Session hooks or its own services and reconstructs that state after refresh or restart. Layout geometry is deliberately transient; a restored consumer may request opening when it registers. Cancellation and unload dispose the slot contribution but do not mutate Session data. Explicit close affects geometry only and does not cancel the consumer lifecycle.

## Blueprint migration

Interactive Blueprint types its right-column panel with `ConversationDefaultDetailsProps`, registers it through `conversation.details.default`, and requests `ctx.layout.openDetails()` after the slot registration becomes live. Tool details still supersede the Blueprint panel and clearing Tool selection restores it. No Blueprint state, selection, RPC, or visible copy changes.

## Alternatives considered

**Expose the complete `details` column.** Rejected because replacing the owner would remove the established Tool details seat, shared selection store, close wiring, and locale assembly.

**Add a Blueprint panel API to layout.** Rejected because layout owns geometry, not the business surface or its data.

**Choose a default surface by plugin load order.** Rejected because two inspectors would produce nondeterministic ownership. The existing single-slot collision is an explicit deployment error.

**Persist panel geometry in the feature plugin.** Rejected because width and open state belong to the shell and feature persistence would create competing authorities.

## Consequences

Any Session inspector can occupy the default details surface without importing Blueprint. The non-Blueprint `external-session-inspector` test starts before ui-conversation, lands after declaration, receives the scoped Session id, requests opening, unloads, and proves the built-in closeable fallback returns.

The seam is presentation-only. It does not add navigation, data loading, cancellation, or Session ownership. A consumer that needs durable state must already own and recover that state independently of the slot registration.
