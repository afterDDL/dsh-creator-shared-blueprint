# Agent Note: tool-cordis shares Host inspect providers

Status: implemented

English | [中文](2026-08-25-tool-cordis-shares-host-inspect-providers.zh.md)

## Problem

Agent presets mount `tool-cordis` in per-agent contexts, while `cordisInspect` owns one process-global Host provider registry. Registering `Service`, `Event`, `Builtin`, and `Tool` from every toolset instance makes a second live Creator Session fail preset activation because the first Session already owns those provider ids.

## Decision

`tool-cordis` retains one Host provider set per `ctx.root`. The first live instance registers the providers, every additional instance increments the root-scoped reference count, and only the final disposer withdraws the set. The `Tool` provider captures the process-owned tool registry rather than a per-agent Context, so the shared provider remains valid when the instance that created it unloads before another holder.

The Host registry keeps rejecting duplicate ids. Sharing is an ownership rule inside `tool-cordis`, not a general permission for unrelated providers to shadow or replace each other.

## Alternatives considered

**Accept duplicate ids in `CordisInspectRegistryService`.** Rejected because it would hide genuine composition conflicts and make query ownership depend on registration order.

**Move these providers into `cordis-host-runner`.** Rejected because the Service and Event providers depend on the generated API catalog owned by the model-facing tool package; moving them would reverse that ownership and couple the runner to one Consumer's reference data.

## Consequences

Several Creator Sessions can keep the Cordis preset mounted in one DSH process without blocking new Session creation. Unloading one Session does not remove inspect providers still used by another, while unloading the last toolset instance leaves no global registration behind. Focused lifecycle coverage pins sharing, final disposal, idempotent release, and rollback when a genuinely conflicting provider exists.
