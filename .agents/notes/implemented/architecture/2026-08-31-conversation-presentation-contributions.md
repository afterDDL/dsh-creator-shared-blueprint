# Agent Note: Conversation presentation contributions

Status: implemented

English | [中文](2026-08-31-conversation-presentation-contributions.zh.md)

## Problem

An external workflow plugin can run implementation work inside a user-facing Session while preserving the ordinary conversation around that work. It must hide internal context and Tool calls, retain assistant questions and answers, and replace the generic reasoning activity with a workflow-specific status. Interactive Blueprint encoded these choices in ad hoc Chat Node fields whose names described its Creator and configuration behavior. Another plugin could reproduce the behavior only by copying those private field values.

## Decision

`@deepseek-ai/dsh-client-ui-conversation` owns a generic `ConversationTurnPresentationData` contribution. A plugin declaration-merges a typed Chat Node, registers its node definition through `ctx.conversationEvents`, and projects one of three turn-wide visibility directives from durable evidence: `hidden`, `human-input-only`, or `hide-context-and-tools`. The snapshot builder combines every directive in a Turn with a fixed strongest-wins order. Incremental append, paged prepend, and full rebuild therefore produce the same visible nodes independently of plugin registration order.

The `activity: 'consumer-owned'` directive transfers only the user-facing running indicator for the open Turn. ChatView suppresses its generic `Deep diving...` indicator, while the producer supplies a localized status through `ctx.conversation.blocks` with `activityPresentation: 'consumer-owned'`. The Session log and reasoning data remain intact. A producer that hides transcript without claiming activity still receives the generic running indicator.

A durable context source carrying `presentation: 'internal'` remains a producer-independent instruction to hide the complete Turn. That marker survives refresh and plugin removal because the base conversation projection understands it directly. Custom turn directives are derived from the producer's durable events; a removed plugin no longer contributes its optional projection but cannot erase or corrupt the underlying log.

Registration follows the existing Conversation Node lifecycle. Node definitions are effects, become available when the contributing client plugin starts, and disappear when its context is disposed. There is no separate startup registry or persisted UI schema. On restart or refresh, the producer's durable Session events reconstruct its Chat Node and directive. Cancellation belongs to the producer lifecycle: it records or observes its terminal event, clears any composer block or external interaction, and lets projection recompute. UI code never forces `turn/end`.

## Blueprint migration

Interactive Blueprint maps its durable Creator evidence to `hide-context-and-tools`, so normal Think and assistant conversation remain visible while internal context and Tool calls stay hidden. Capability routing and repair map to `human-input-only` plus consumer-owned activity, while their existing composer block presents the localized configuring state. The existing external `PendingInteraction` registry continues to carry assistant questions back to the source Session without changing response ownership.

No capability transaction, Source Creator topology, event vocabulary, or user-visible wording changes. The migration renames only the generic presentation data consumed by `ui-conversation`.

## Alternatives considered

**Keep Blueprint-specific marker fields.** Rejected because another workflow would need to depend on Blueprint vocabulary or copy undocumented structural checks.

**Filter DOM elements after rendering.** Rejected because incremental and refresh projections could disagree, hidden nodes would still affect grouping and locations, and accessibility output would retain implementation content.

**Hide all assistant output for implementation Turns.** Rejected because it removes user-facing questions and ordinary assistant conversation together with internal work.

**End the Turn when the workflow asks a question or changes status.** Rejected because presentation does not own runtime settlement and forcing a terminal would break same-Session continuation.

## Consequences

Any client plugin can control transcript projection and running-status ownership without importing Blueprint. Core tests register an `external-workflow-presentation` dummy Chat Node, prove visibility convergence across incremental and refreshed snapshots, and prove the generic running indicator yields to an external workflow status while pending questions remain visible.

The contribution is intentionally presentation-only. The plugin must keep its durable lifecycle authoritative, restore any in-memory interaction or composer block from that lifecycle, and clear them on settlement or cancellation. `ui-conversation` does not infer workflow success, retry, or ownership from the directive.
