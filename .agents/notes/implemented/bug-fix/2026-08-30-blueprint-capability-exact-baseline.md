# Agent Note: Capability authoring terminals require exact baselines

Status: implemented

English | [中文](2026-08-30-blueprint-capability-exact-baseline.zh.md)

## Problem

Capability authoring may legitimately change the target while it adds one Skill or delegation, so a changed target revision alone cannot prove the requested delta. Recording only preset ids, Skill names, and delegation row ids, Tools, and providers also omits authoritative content. A Creator could change an existing Skill body, alter hidden delegation options, or rewrite another preset, add one otherwise valid target capability, and still satisfy the former completion checks.

## Decision

The durable `blueprint/capability-authoring` start records the complete committed preset roster before authoring. Each entry retains id, trust, resolved display metadata, discovery health, and the SHA-256 of readable composition text. The target entry must be healthy and its composition digest must equal the routed base revision. Authoring occurs in an isolated clone: candidate verification permits its target composition digest to change, while the formal target, its metadata, and every non-target roster entry remain exact until verified publication.

The same start records every scoped Skill's name, description, invocation policy, scope, provider, source, and definition digest. It records every projected delegation's row id, Tool, provider, mode, availability, enabled state, and a SHA-256 of the complete parsed config. Config serialization recursively sorts object keys, retains arrays in order, and treats Loader `!!js` expressions as their unevaluated `{ __jsExpr }` data. Nested `agentOptions`, `toolFilter`, `maxDepth`, and future JSON-compatible config fields therefore participate without executing expressions or exposing raw config.

Candidate settlement first joins current Skills by name and delegations by row id and requires every baseline summary to remain exact. Skill authoring then admits exactly one new target-owned model-callable Skill and no new delegation. Subagent authoring admits exactly one new enabled, provider-backed delegation and no new Skill before its fresh-Session P1 check. Projected node checks remain an additional guard; they are not the authority for hidden definition or config fields.

Session invariants require distinct complete roster, Skill, and delegation baselines, validate both definition and config digests, require the target roster revision to match the routed base revision, and require the terminal event to copy the exact durable start baseline. This decision replaces the narrower name- and row-id baseline described by the original [Interactive Blueprint decision](../feature/2026-08-24-interactive-blueprint-preset-adapter.md); its projection, routing, and confirmation decisions remain active.

The [capability continuation authority](2026-08-30-blueprint-capability-authoring-authority.md) owns admission, deterministic Creator identity, and explicit-terminal quiescence. This decision begins only after that authority has produced one valid durable start.

## Alternatives considered

**Compare only projected Blueprint nodes.** Skill bodies, child `agentOptions`, Tool filters, depth limits, Loader expressions, and non-target preset contents need not change a projected node.

**Require the whole target composition revision to remain unchanged.** Adding a delegation necessarily changes that revision, while adding a filesystem Skill may not. Exact baseline members plus the admitted addition identify the allowed delta without forbidding both mechanisms.

**Store raw Skill bodies and delegation configs in the Session event.** Durable identity needs equality evidence, not model-visible or client-visible source text. Digest summaries keep the event bounded and avoid evaluating Loader expressions.

## Consequences

A Creator turn that both repairs an existing capability and adds the requested one fails candidate validation; bounded recovery may repair that same candidate, and exhaustion discards it without changing the formal preset. A concurrent edit to another preset or target metadata also conservatively prevents publication. Runtime Session regressions cover an existing Skill body mutation plus one Skill, an existing delegation config mutation containing `!!js` plus one delegation, a non-target preset mutation plus a valid target Skill, and target metadata mutation.
