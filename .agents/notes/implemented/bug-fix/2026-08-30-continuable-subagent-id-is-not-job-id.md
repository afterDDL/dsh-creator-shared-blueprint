# Agent Note: Continuable subagent ids are not background Job ids

Status: implemented

English | [中文](2026-08-30-continuable-subagent-id-is-not-job-id.zh.md)

## Problem

A continuable delegation returns a durable child-session id while one-shot background work returns a generic Job id. When both delegation and Job controls are model-visible, the terse `started subagent <id>` result does not state which control protocol owns the value. A model can pass the child-session id to `job_list` or `job_output`; the Job registry correctly rejects it, but the failed collection can trigger duplicate delegations even though the original child remains live and later reports normally.

## Decision

The continuable start result identifies the lifecycle as `started continuable subagent <id>` and immediately states that the id is not a background Job id, cannot be passed to `job_*`, and is completed through the runtime settlement notice. The canonical tool value remains `{ kind: 'continuable', subagentId }`; one-shot background rendering and Job registration remain unchanged.

The exact rendered distinction is model-visible and logged. A continuable child still owns its durable Session and independent turns, while `ctx.jobs` remains authoritative only for work that explicitly returns a Job id.

## Alternatives considered

**Register every continuable child as a generic Job.** This would add a second lifecycle owner and collection record beside the continuation manager, split cancellation and settlement authority, and erase the durable-conversation distinction that `subagentId` represents.

**Remove Job controls from generated presets that use continuable children.** The same Agent can legitimately need Jobs for background shell commands or one-shot providers, so hiding the generic controls removes unrelated capability instead of disambiguating the returned identifier.

**Rely on the tool schema's `kind` field.** The model consumes the rendered tool result, and the ambiguous text is the transition that caused the duplicate work. Keeping the structured value without correcting its presentation leaves the user path unreliable.

## Consequences

The start acknowledgement is longer, but it makes control ownership explicit at the moment the id enters model context. Package coverage pins the rendered text and the absence of a Job record; the keyless assembled `subagent-settlement` snapshot pins the same result followed by the manager-owned notice. Real-browser Blueprint release-candidate coverage verifies that one delegation reaches one child result and parent consumption without `job_*` retries.
