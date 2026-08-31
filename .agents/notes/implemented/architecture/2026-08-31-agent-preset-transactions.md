# Agent Note: Isolated AgentPresets transactions

Status: implemented

English | [中文](2026-08-31-agent-preset-transactions.zh.md)

## Problem

An external plugin that edits a preset must keep unverified files invisible to committed readers, validate an exact candidate, publish only if the committed baseline is unchanged, and recover a process interruption between directory renames. Interactive Blueprint implemented those filesystem guarantees inside its adapter and asked AgentPresets only to exclude readers around an arbitrary publication callback. That made correctness depend on a Blueprint-owned hidden-directory vocabulary and left another plugin unable to obtain the same guarantees without copying the implementation.

## Decision

`AgentPresets` owns a generic isolated transaction lifecycle for writable preset directories. `prepareTransaction(id, { key, expectedRevision })` resolves the committed preset under the roster gates, verifies the exact composition revision, records a complete-tree baseline digest, and clones the directory under `.agent-preset-transaction-<sha256>`. The returned `AgentPresetTransaction` is the durable handle; the caller's stable `key` makes retry and restart adopt the same transaction without exposing caller-specific identities in the journal.

`resolveTransaction()` returns an `AgentPreset` whose path addresses only the isolated candidate. `registerScopedOverlay()` can make that preset visible through one agent scope's contextual authoring tools, and `mountIsolated()` can compose it for a fresh validation agent. Ordinary `list()`, `resolve()`, `read()`, standing mounts, and projection snapshots continue to address only the committed directory.

The consuming plugin owns semantic validation. It calls `fenceTransaction()` before and after validation and retains the complete-tree digest across any external conformance check. `publishTransaction()` accepts only that digest, compares the formal directory with the preparation baseline, completes the crash-recoverable rename sequence under the roster and target-preset gates, and clears the standing pointer before readers resume. Existing agents retain their mounted generation; future agents receive the published one. AgentPresets does not know whether the candidate adds a Skill, delegation, workflow, or another feature.

Transaction storage is a journaled filesystem resource rather than a service-local promise. Preparation, publication, and discard phases are idempotently reconstructed by `recoverTransaction()` after restart. Cancellation is consumer-owned: fence the candidate, call `discardTransaction()`, durably record the returned disposition, then call `cleanupTransaction()`. Cleanup is intentionally later than settlement so a durable terminal can prove what happened before hidden evidence disappears.

The service registers during normal Host composition before consumers that inject `agentPresets`; transactions add no startup registry. A removed or missing consumer cannot cause an unverified candidate to become committed because only `publishTransaction()` crosses the formal path. Its hidden directory may remain until an operator or restored plugin handles it. `runLegacyPublication()` remains an internal migration hook solely for plugins that already persisted a different rename journal; new transaction creation cannot use it.

## Blueprint migration

Interactive Blueprint creates every new capability lifecycle through `prepareTransaction()`, uses the generic resolve, fence, recover, publish, discard, cleanup, scoped overlay, and isolated mount methods, and keeps only its Skill/Subagent tree-delta policy in the adapter. The durable Blueprint candidate and disposition fields remain structurally compatible with the generic handle and evidence, so the product event schema does not change.

Already-persisted `.blueprint-capability-*` records remain recoverable without teaching AgentPresets that directory format. The adapter first uses the generic service and enters its legacy reader only when `AgentPresetTransactionNotFoundError` proves that the generic journal is absent. New lifecycles never call the legacy preparer. Both cleanup readers are idempotent, allowing a settled record from either vocabulary to remove only its own hidden directory.

## Alternatives considered

**Publicize Blueprint's complete candidate module.** Rejected because its journal contains source, route, and Creator identities and its admitted-delta logic names Skill and Subagent behavior. Those are consumer policy, not AgentPresets filesystem semantics.

**Expose only a publication mutex.** Rejected because a callback does not define candidate isolation, complete-tree comparison, crash phases, restart adoption, or cleanup ordering. Every consumer would still need to invent the correctness-critical transaction.

**Put candidate validation in AgentPresets.** Rejected because preset contents are an open plugin composition. AgentPresets can prove bytes and mountability, but only the consuming feature can decide which semantic delta is permitted and what runtime evidence is sufficient.

**Delete the legacy reader immediately.** Rejected because a durable Blueprint lifecycle may restart with its formal directory parked inside the old journal. Removing that reader could strand the only authoritative tree. The compatibility path reads existing data only and has no creation entry point.

## Consequences

Any third-party Host plugin can prepare, inspect, validate, publish, cancel, and restart-recover a preset candidate without importing Blueprint. Core tests install an `ExternalPresetPublisher` dummy plugin and prove committed isolation, expected-baseline rejection, standing-generation refresh, safe discard, cleanup, and restart publication. Blueprint tests prove new transactions use the generic directory vocabulary and an already-durable background Creator record still recovers through the legacy reader.

The generic package now owns complete-tree hashing and the filesystem journal, which increases its security-sensitive surface. It rejects external symbolic links, hard-linked files, special entries, paths outside configured writable roots, digest mismatches, and publication after concurrent committed edits. The consumer must still persist its handle and terminal disposition, bound repair attempts, and decide when semantic validation has passed.
