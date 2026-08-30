# Agent Note: Creator foreground state belongs to the viewed Session

Status: implemented

English | [中文](2026-08-28-blueprint-creator-foreground-ownership.zh.md)

## Problem

Creator history is Session-scoped, but the Blueprint controller has one foreground store. Recovery and projection responses could finish after navigation and publish a previous Session's paused Draft, target, and roster lock. Capability authoring also reused one Session field for its source conversation and background Creator executor, then stored one global handoff; navigation could therefore expose another source's progress or discard its terminal result. The ownership diagnostic ran after publication. Clearing the visible projection on navigation alone did not exclude these publications or preserve recoverable offscreen state.

## Decision

Foreground Creator ownership requires the viewed Session to equal the observation's owner. A source may stage its own Draft before handoff; a child Creator owns subsequent authoring. Starting that typed continuation creates the reserved child without opening it over the source Session. The source remains foreground while the client observes the child in the background and projects only its route-owned progress or terminal. The Host continues recovering durable context by Session id. Client recovery rechecks the current Session after each asynchronous request, and the controller rejects foreign observations and publications.

Each Session or runtime-preset transition advances a foreground generation. Reads must retain that generation and the Creator observation version before publishing. Generation-scoped load sharing prevents a new Session from joining an older read and excludes stale responses even after A → B → A. A default projection cannot replace a Draft recovered during its read. Interaction locks require an owned, non-Ready Creator state.

Untyped legacy Creator recovery interprets only the latest human input. A later edit or capability request therefore cannot revive an earlier completed creation interaction after refresh or Session navigation.

Capability presentation separates UI ownership (`sourceSessionId` and `routeId`) from execution ownership (`creatorSessionId` and lifecycle `startSeq`). The controller retains the latest capability interaction for each source Session and derives the single rendered handoff from the foreground Session. Background subscriptions observe every active Creator Session and project waits or durable terminal outcomes back to the matching source record. Completion, failure, and cancellation remain visible across navigation and reprojection until another capability request from that source replaces them. Refresh reconstructs those terminals from the Creator lifecycle; it adds no local completion store and copies no Creator timeline messages into the source conversation.

The [Creator task-terminal decision](2026-08-28-blueprint-creator-task-terminal.md) owns which durable task outcome may be projected through this foreground fence. Foreground ownership does not infer task completion from later Session activity.

The [Session readiness decision](2026-08-27-new-session-first-prompt-readiness.md) still owns prompt admission and target precedence; [exclusive handoff](2026-08-28-blueprint-exclusive-creator-handoff.md) still owns executor transfer. Neither execution protocol changes here.

## Alternatives considered

**Clear all Creator history on navigation.** This destroys legitimate refresh and return recovery and does not address in-flight publications.

**Cancel background authoring.** Foreground ownership does not grant cancellation authority; background work must retain its existing execution behavior.

**Check only Session equality.** An old read can still match after leaving and reentering the same Session. A foreground generation distinguishes those visits.

**Key capability presentation by target preset.** Multiple source Sessions may operate on one preset. The target identifies the mutation destination, not the interaction that may display progress or terminal state.

## Consequences

Session-keyed records and durable events remain intact. Offscreen Creator observations update only their source-owned records; reentry renders the current state for that Session. No Host API, Creator Runtime, completion rule, semantic projection, or authoring executor changes are required. Controller tests cover foreign lifecycle states, late reads, revisit generations, source staging, multiple simultaneous source records, durable capability terminals, and refresh recovery. The runnable Web example verifies that a new Session drops the prior Creator interaction lock.
