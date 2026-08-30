# Agent Note: Blueprint routing retains original intent and one operation per interaction

Status: implemented

English | [中文](2026-08-28-blueprint-routing-provenance.zh.md)

## Problem

Add capability appended routing instructions to the user's message. A creation-expression guard treated those instructions as active Creator intent, rejected an existing-Agent proposal, and left new-Agent routing available. A real CSV request consequently copied its current preset into a second top-level Agent. The earlier Creator had already completed; this rejection came from text classification rather than an active lifecycle.

## Decision

The client issues a distinct `routeId` for each Add capability interaction. The Host records that identity with the original text, exact message id, source Session and target in `blueprint/routing-input` before submitting the message. Direct conversation requests use their message id as the interaction identity. Routing guidance is a separate model context contribution. Routing resolves the current human message from durable history and never searches assistant messages, descriptions or prompt instructions for user intent. The typed model still chooses the operation; a new-Agent call must quote current user-authored text, and a capability action rejects that operation regardless of its quote. A later independent human message can request a different goal.

`blueprint/route-decision` reserves the admissible operation synchronously for one `routeId` before asynchronous validation. A different operation cannot compete for that interaction. An in-flight or successful attempt cannot start again; a failed attempt can retry only the same operation. A distinct interaction may choose another operation in the same source turn or against the same target preset. An operation excluded by the UI action is rejected without taking ownership. Add capability also rejects Identity, Purpose, and Behavior approximations before `modify-existing-agent` can reserve the interaction; existing typed capability toggles and Output changes remain admissible proposals. Thus an invalid create-agent or text approximation cannot prevent legitimate Skill or Subagent routing, but an admitted route cannot fail over into another business operation. Durable tool results settle attempts without another scheduler or state store. Successfully validated proposals and capability routes use `concludeTurn()`. Acceptance ends the source turn without another model request; a subsequent user interaction receives a new identity and does not require deletion of the prior decision. Already emitted calls remain subject to the Host duplicate and operation guards, and their rejection remains visible.

If the foreground changes before an admitted typed route executes, the Host retains that source Agent's Blueprint binding until the matching source `turn/end`. Tool registrations remain Agent-scoped, so another Session neither inherits nor disposes the source route.

Proposal Change Sets carry `sourceSessionId` and `routeId`. The Session-scoped Tool row renders a Change Set only when its owner matches the row Session, and Apply sends its receipt to that source Session. Foreground changes therefore cannot reassign a pending Proposal. Capability routes and their Creator lifecycle events carry the same source identity; recovery and observation require the exact route rather than matching only preset and revision. The Creator Session remains a `cordis` authoring executor for the existing target and does not create or copy a second top-level preset.

Actual Creator or capability-authoring bindings retain their proposal guard. Creation words in a user message no longer stand in for active authoring. The [Blueprint adapter](../feature/2026-08-24-interactive-blueprint-preset-adapter.md) retains its projection, proposal and transaction behavior; [exclusive handoff](2026-08-28-blueprint-exclusive-creator-handoff.md) retains execution-transfer ordering.

## Alternatives considered

**Add language-specific creation exclusions.** Keywords cannot establish who authored a sentence and would repeat the defect for another language or instruction example.

**Rely only on routing instructions.** Guidance cannot prevent a second typed call from taking over after rejection. Host arbitration enforces the operation even when the model ignores guidance.

**Store only client selection or an in-memory lock.** Neither reconstructs the exact request and operation after reload. Durable interaction identities, message identities and tool results provide exact ownership.

## Consequences

The model remains responsible for semantic classification; quotation proves provenance, not that arbitrary prose semantically requests creation. Add capability imposes stronger deterministic prohibitions on new-Agent creation and semantic text approximations. Correcting an admitted business operation requires a new interaction, not fallback route fishing within the same identity. Discussion remains tool-free and owns no operation. Direct-edit reconciliation keeps its existing event authorization.

Focused tests exercise guidance contamination, concurrent and settled operation conflicts, independent interactions in one source turn, pre-reservation approximation rejection, Proposal Session ownership, terminal versus active Creator context, and Japanese/Korean capability inputs. A built headless composition proves an accepted Skill route ends before a second model request and retains one target preset; same-response tests retain rejected duplicate and new-Agent calls without allowing them to block the valid route.
