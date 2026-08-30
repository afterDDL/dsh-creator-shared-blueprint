# Agent Note: Creator uses a fixed preset-authoring Consumer

Status: implemented

English | [中文](2026-08-30-creator-only-preset-authoring-consumer.zh.md)

## Problem

Creator reached preset validation by mounting a temporary plugin that registered `preset_check` during an active Session. The Tool appeared only after a later model request rebuilt its schema catalog, so the current model could continue without seeing it. Repeating the probe also allowed its name and input schema to drift between Sessions. Preset discovery, reading, copying, path resolution, and validation need one stable authoring interface from Creator's first request without exposing those operations to ordinary Agent Sessions.

## Decision

`@deepseek-ai/dsh-tool-agent-preset-authoring` is a fixed Consumer of `agentPresets` and `tools`. Only the `cordis` preset mounts it. Creator's first model request therefore contains `preset_list`, `preset_read`, `preset_resolve`, `preset_copy`, and `preset_validate`; ordinary Agent presets contain none of them.

Each Tool delegates to the corresponding roster operation without adding a service, realm, authoring format, or policy. `preset_validate` calls `standingKeyFor(id)` and returns its mount result without translating failures. The [mount-validation decision](2026-08-11-preset-authoring-agent-validates-its-own-composition.md) continues to own why discovery health is insufficient and why validation uses the same standing mount as a real Session. This decision supersedes only that Note's temporary self-mounted probe.

`preset_copy` is the only composition-creation operation. The Host validates both ids, refuses a target supplied by any root, rolls back a failed copy, rewrites the copied `preset.yml`, and never accepts YAML text or a filesystem path from the model. `preset_resolve` returns the roster-owned path for later file operations. The [copy-only authoring decision](../simplification/2026-08-08-copy-only-preset-authoring.md) continues to own the browser and Host write restriction.

## Verification

The first assembled Creator request contains all five fixed schemas and no `preset_check`. The real composition path exercises `preset_list` → `preset_read` or `preset_resolve` → `preset_copy` → `preset_validate`; copying creates one user preset, a repeated target id is rejected, and validation reports success only after the standing mount succeeds. A `standard` Session exposes none of the five Tools. The generated Tool catalog records the stable names and schemas.

## Alternatives considered

**Keep the temporary `cordis_mount` probe.** Dynamic registration cannot put a Tool into the model request already in flight. Re-reading the registry does not update a model that retains its earlier schema set, and repeated snippets can drift.

**Mount the fixed Consumer for every Agent preset.** Preset discovery, path resolution, copying, and validation are authoring authority. Ordinary Agent Sessions do not need them and must not pay their schema cost or receive that authority.

**Restore a browser YAML editor or accept composition text in a Tool.** This would recreate the arbitrary composition-write capability removed by copy-only authoring. The fixed Consumer exposes roster operations, not composition text.

## Consequences

Creator requests pay the fixed token cost of five schemas from their first model header. In exchange, the authoring Tool prefix is stable across the Session and every Creator uses the same names and validation semantics. The package adds no new composition format or validation rule; changes to roster operations remain owned by `agentPresets`, while their model-facing schemas and Creator-only mounting are verified together.
