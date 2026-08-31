# Agent Note: Required session-event vocabulary from third-party plugins

Status: implemented

English | [中文](2026-08-31-third-party-session-event-vocabulary.zh.md)

## Problem

`SessionEventMap` is merge-extensible, but persistence previously recognized required event types only through the repository-generated `KNOWN_SESSION_EVENT_TYPES`. An out-of-tree plugin could type and append an event, yet the next restart refused its intact log even when the same plugin was installed. Accepting every string or silently skipping unknown required events would instead reconstruct Sessions without semantics their producers declared necessary.

## Decision

`SessionStore` owns `eventTypes`, a runtime registry for required durable event types supplied outside the first-party build. A plugin declaration-merges its event payload and registers `{ type, owner }` during application. The generated first-party vocabulary records each declaring npm package: that package may register the same owner so one startup path works both in-build and out of tree, while another owner rejects. The registration follows the plugin fiber through its disposer; persistence accepts a required event only when its type belongs to the generated first-party set or a currently live registration.

Persistence remains fail-closed. A plugin must register before any Session carrying its event is inspected, loaded, or resumed. The decode check itself enforces that ordering: missing or late registration returns `SessionFormatUnsupportedError` before Session construction. Restart requires registration again, plugin removal makes later reads refuse, and concurrent ownership collisions reject instead of choosing one interpretation.

Registration carries no plugin version. A plugin version that registers an existing type asserts compatibility with that type's durable payload and semantics. An incompatible revision uses a new event type; adding an unverifiable version string beside an unchanged event envelope would not make old payloads interpretable.

This partially supersedes the deferred runtime-registration alternative in [Session log versioning](2026-08-10-session-log-version-mechanism.md): the generated set remains the uniform vocabulary for first-party builds, while runtime registration is limited to out-of-tree required events whose absence is intentionally composition-dependent and fails loudly.

## Alternatives considered

**Accept arbitrary event-type strings.** This removes the only read-side proof that required event semantics are present and can silently reconstruct an invalid Session.

**Persist plugin package versions in every event or Session header.** A version label does not define payload compatibility, couples core storage to package managers, and expands the wire format before a real migration relation exists.

**Generate the vocabulary from installed packages before every boot.** That adds package scanning and a second manifest protocol while still needing lifecycle ownership for HMR and removal. The runtime registry is the smaller current requirement.

## Consequences

Out-of-tree plugins can now own required durable events without a core patch. They must register during startup and keep old type semantics readable across compatible releases. A missing plugin, a plugin that deliberately stops registering an incompatible old type, or an event-type collision prevents resume rather than weakening durability safety. Core contract tests pin registration disposal and collisions; a non-Blueprint dummy plugin persists its custom event, proves refusal without the plugin, and proves successful reload after registration on a fresh runtime.
