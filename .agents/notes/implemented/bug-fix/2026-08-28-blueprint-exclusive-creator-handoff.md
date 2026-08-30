# Agent Note: Exclusive Creator handoff stops the source turn

Status: implemented

English | [中文](2026-08-28-blueprint-exclusive-creator-handoff.zh.md)

## Problem

A successful routing Tool result does not transfer execution ownership. The source agent can continue calling Tools while a separate Creator authors the same request. The [Blueprint adapter decision](../feature/2026-08-24-interactive-blueprint-preset-adapter.md) retains its authoring and projection semantics; this decision owns only executor transfer.

## Decision

The exclusive route checkpoints `blueprint/creator-authoring` in the source Session before returning success. It retains the original request, language metadata, source turn, route id, and a deterministic distinct Creator Session id. A successful result marks the turn terminal and synchronously cancels its driver at result publication. Cancellation preserves the inbox because publication cannot reenter Session append. Already planned sibling calls may receive synthetic aborted results, but their bodies do not execute.

The Client uses the reserved id with normal Session creation. The Host installs and checkpoints Creator context, requires an accepted source result, awaits `whenIdle()`, verifies that exact turn's durable end and idle status, then delivers one plugin continuation. The destination's durable inbox insertion is its delivery receipt; serialized context updates prevent duplicate delivery across clients and refresh. A failed allocation or termination leaves the request retryable without starting Creator. Source history and later turns remain usable.

## Alternatives considered

**Prompt-only stopping or `concludeTurn()` alone.** Neither prevents every sibling Tool or racing steering path. Synchronous cancellation closes that execution window.

**Start Creator before cancellation settles.** A cancellation acknowledgment is not quiescence and permits overlapping executors.

**Client-only route deduplication.** An in-memory set cannot survive refresh or coordinate two windows. Destination identity and delivery receipts live in Session history.

## Consequences

Source termination precedes target allocation, so allocation failure ends this turn but neither destroys nor locks its Session. Recovery can retry the recorded request. The Host requires the source Session to be live for admission; an unloaded source must be reopened. Ordinary proposals and capability authoring keep their existing execution semantics. No Agent Loop, Session, Preset, or Creator implementation changes are required.
