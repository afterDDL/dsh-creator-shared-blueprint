# @deepseek-ai/dsh-tool-agent-preset-authoring

English | [中文](README.zh.md)

Creator-only model tools over the existing `ctx.agentPresets` service. The package contributes no service, authoring format, sandbox bypass, or isolate realm; a composition chooses which Agent scopes receive its five tool registrations.

## Tools

- `preset_list` returns the authoritative preset roster.
- `preset_read` returns one stored composition by id.
- `preset_resolve` returns one preset's roster metadata and composition path.
- `preset_copy` creates a new user preset from an existing preset directory and refuses an existing id.
- `preset_validate` calls `standingKeyFor(id)` and reports success only after the preset mounts through the normal standing composition path.

Every operation delegates directly to `ctx.agentPresets`. The preset service therefore remains the owner of user-root selection, shipped-preset protection, id validation, copy rollback, refusal to overwrite, and mount validation.

## Composition scope

The shipped `cordis` preset mounts this package as `tool-agent-preset-authoring`, so a Creator model receives all five schemas on its first request. Ordinary presets do not mount it and cannot see or call these tools.

## Model Experience

### Tool schemas

#### What the model sees

The model sees the generated [`preset_list`, `preset_read`, `preset_resolve`, `preset_copy`, and `preset_validate` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-agent-preset-authoring) only when its preset mounts this Consumer.

#### Token effect

Five fixed schemas add a fixed token cost to each Creator request. Calls retain their arguments and rendered results until compaction.

#### KV Cache effect

The five schemas form a stable request prefix while the package version and preset composition are unchanged. Direct availability from the first request avoids request-to-request schema insertion caused by temporary tool registration.

## Known Limitations and Deferred Work

- **Copy is the only write** — the package cannot edit, delete, or overwrite a preset; subsequent composition edits continue through the existing File and Shell sandbox and approval paths.
- **Validation proves composition mounting only** — `preset_validate` does not run a model turn or assert the new Agent's task quality.
- **Exposure is composition-owned** — mounting this package in another preset would intentionally expose the same roster read and user-preset copy operations there; shipped composition keeps it Creator-only.
