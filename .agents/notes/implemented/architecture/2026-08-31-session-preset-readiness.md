# Agent Note: Preset-ready Session creation

Status: implemented

English | [中文](2026-08-31-session-preset-readiness.zh.md)

## Problem

The Host `session.create` protocol already accepts an `agentPreset` and resolves after that composition is mounted and its Agent loop starts. Client Runtime omitted the option from its public Session face. A third-party surface that needed to create a Session for a specific composition therefore had to call the connection transport directly, wait for list addressability itself, and coordinate a separate client-local next-Session intent. That duplicate path could expose a Session before its requested runtime identity was confirmed.

## Decision

`SessionRuntime.create(options)` accepts the protocol's optional `agentPreset`. A successful response must echo the exact requested preset before the method resolves. The Session row and Agent scope are locally addressable at resolution, as for ordinary creation. A missing or different echo raises `SessionPresetReadinessError`; callers must not open that Session or admit a prompt. Host RPC failures retain `SessionCreateError` and its caller-reserved identity.

`WorkspaceRuntime.connectWorkspace(workspaceId, options)` and `startSession(workspaceId, options)` accept the same preset requirement for New Session flows. Reuse is permitted only when an existing blank Workspace member already runs the requested preset. Concurrent connection attempts are coalesced by Workspace plus preset, so incompatible preset requests never share a creation result.

Client Runtime owns this API and installs it during normal client boot before feature plugins that inject `sessions` or `workspaces`. It introduces no registration lifecycle and no second readiness state. The Host response remains the composition and Agent-start commit point. The create RPC has no client cancellation input because publication may already have occurred; response loss is reconciled through the existing preallocated-id and Session-list path. After restart, the durable Session header and log-derived preset return through `session.list`, so the same exact-preset reuse rule applies without restoring client-local intent.

## Migration

Interactive Blueprint now creates preset-bound Creator, verification, and trial Sessions through `ctx.sessions.create`, and its Creator roster entry uses the generic preset-aware New Session action. It no longer calls the connection's Session transport, waits on a private list timer, or consumes `agentPresetSessionIntent`. The agent-preset UI keeps its own ordinary chip staging and blank-Session recompose behavior; no Blueprint behavior is moved into that package.

## Alternatives considered

**Keep a client-local navigation intent.** Rejected because an intent is not the runtime commit point, must be joined with a later Session identity, and cannot serve programmatic Session creation without another coordination path.

**Create under the default preset and switch before the first prompt.** Rejected because preset selection is a second RPC limited to blank Sessions, so prompt admission needs an additional blocking state and can race the recompose.

**Trust successful creation without checking the preset echo.** Rejected because a successful response would then prove only Session publication, not the runtime identity the caller required.

## Consequences

Any client plugin can start a Session for a named agent preset without importing Blueprint or transport internals. Runtime tests use `external-specialist` as a non-Blueprint consumer and prove request forwarding, exact Host confirmation, mismatch rejection before navigation, preset-aware blank reuse, and fresh creation. Blueprint remains only a consumer of the same public Session and Workspace services.
