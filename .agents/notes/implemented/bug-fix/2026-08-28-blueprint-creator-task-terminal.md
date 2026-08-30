# Agent Note: Creator terminal tasks cannot own later interactions

Status: implemented

English | [中文](2026-08-28-blueprint-creator-task-terminal.zh.md)

## Problem

A Creator Session can outlive its create-agent task. Reinterpreting every newer message as a new Draft lets incidental creation language replace a Ready target. Recovery from the whole Session's latest turn also confuses later stopped discussion with interrupted authoring.

## Decision

Typed Creator records retain route identity. Free text cannot replace that identity, and Ready ignores nonterminal observations of the same task. The text parser is restricted to histories without typed identity. It evaluates negation at each create-Agent expression, so an unrelated later deferral cannot erase an earlier primary creation request while a locally negated expression still starts no Draft.

The Host records one `blueprint/creator-authoring-ended` fact per task. Completion cites its start, successful mount validation, target preset, and completed authoring turn. Recovery uses that fact before later turns; start-only histories are checkpointed from their first qualifying interval. Another Creator or capability task fences that interval. Multiple validated targets remain unresolved. Error turns produce failure, while user stops without a task terminal remain resumable. Cancellation is a distinct terminal outcome, not a synonym for stopping a turn.

Terminal recovery installs ordinary Blueprint context and refuses stale Draft activation. The [Session foreground decision](2026-08-28-blueprint-creator-foreground-ownership.md) still owns foreign-session and late-response rejection; this decision adds task identity within one Session. Capability routing, semantic projection, and exclusive handoff retain their existing behavior.

## Alternatives considered

**Reject a whole message when it contains negative creation language.** One request may create an Agent while deferring its Skill or Subagent work. Negation applies to its local expression; typed identity and durable outcome still authorize and terminate routed tasks.

**Use the latest Session turn.** Later interactions share the Session but do not belong to its completed creation task.

**Delete paused recovery or history.** Both discard legitimate unfinished authoring. Terminal precedence preserves resumability and append-only history.

## Consequences

Existing logs remain intact; recovery may append one missing terminal fact. Runtime invariants reject terminal rewrites and completion without validation evidence. Controller regressions cover free-text overwrite, local negation, a primary creation request followed by a separate deferral, stale observations, new identities, recovery, and Session switching. The runnable headless snapshot exercises real preset copy and mount validation followed by ordinary conversation and recovery.
