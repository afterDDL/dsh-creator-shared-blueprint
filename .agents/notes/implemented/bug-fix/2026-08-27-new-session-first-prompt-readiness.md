# Agent Note: New Sessions admit prompts only after their selected composition is ready

Status: implemented

English | [中文](2026-08-27-new-session-first-prompt-readiness.zh.md)

## Problem

The Web client exposed two new-Session paths before all client-owned initialization had settled. The new-session preset seat called `agentPresets.select` asynchronously while the composer remained able to call `Session.prompt`; a quick Enter could make the Session non-blank before the preset recompose committed. Try Agent opened its newly composed Session before installing Blueprint conversation context, so its first prompt could run without the target-bound context even though the Host composition itself was complete. Interactive Blueprint also retained one global projected target while Session runtime identity, Creator mode, and composer copy were derived independently. Selecting Creator could therefore leave the live Session on an ordinary preset while the details panel or composer claimed Creator state, and an asynchronously queued context update could apply a new target to the previously current Session.

Refresh concealed both symptoms. A committed preset selection was reconstructed from the durable `agent-preset/selected` event, and the Blueprint controller installed conversation context again when the restored Session became current. That convergence did not make the first prompt safe.

## Decision

Runtime readiness uses the commit points the existing APIs already provide. `sessions.create` returns only after preset mount, Agent setup, publication, and loop start; its echoed `agentPreset` must equal the Try Agent target. `agentPresets.select` returns only after the blank Session has recomposed and appended `agent-preset/selected`. No additional Host lifecycle state or timer is introduced.

The preset seat raises a session-scoped `ctx.conversation.blocks` entry before awaiting `agentPresets.select`, clears it after the committed identity returns, and replaces it with a retryable failure block when selection fails. `ConversationController` enforces every composer block before attachment serialization and `Session.prompt`, in addition to rendering a disabled composer. This closes the browser-event gap between the state change and React repaint. The existing InputHub rejection path restores untouched draft text and attachments.

Try Agent waits for the Host-created Session to become addressable in the client runtime, records the echoed preset, and installs Blueprint conversation context before opening it. Runtime conformance remains the stronger P1 verification performed after the Session is ready; it is not the prompt-admission signal. The P1 result may publish after the intentional navigation only when the current Session is the exact Session named by that result. A rejected P1 request is normalized as incomplete verification under the same destination identity. A different current Session proves that the user navigated again, so either late outcome is discarded.

No pending-message queue is added. Input stays in the existing per-session draft machine until readiness, so there is no automatic dispatch to deduplicate or persist. A refresh before dispatch cannot replay a message. Already-running Sessions have no initialization block and pay no additional readiness request.

The current Session and its Host-echoed `agentPreset` are the source of truth for runtime and the default Blueprint target. Creator selection is a seat-owned next-Session intent; the UI does not enter Creator mode until a current Session echoes `cordis`. Blueprint preferences and explicit selections are keyed by Session, and only same-Session Creator or capability-authoring records may override the runtime target. Every Session or runtime-preset transition clears the previous projection before loading the new precedence chain, including a blank Session id reused for a different composition. Conversation-context publication rechecks the current Session inside its serialized queue and drops work whose intended Session no longer matches. A baseline `cordis` Blueprint may remain visible before a creation request, but it clears ordinary existing-Agent model context instead of installing Proposal or new-Agent routing instructions. Creator wording is derived from the same runtime preset. Creator completion retains its validated target for that Creator Session, while opening another Session restores that Session's own runtime target. Recovery reads the latest turn that has a durable end rather than assuming the final hydrated turn slot is terminal.

A durable typed create-agent route is idempotent across client remounts. Before starting a continuation, the client recovers existing `cordis` authoring context and matches both source Session id and route id; a match consumes the route without creating, opening, or prompting another Creator Session.

## Alternatives considered

**Hide the baseline `cordis` projection.** The projection is useful UI and does not cause the routing defect. Only publishing it as ordinary existing-Agent model context is unsafe.

**Keep ordinary Blueprint context and rely on the model not to route.** That context explicitly advertises Proposal and new-Agent routing behavior. A direct Creator runtime does not provide the route Tool, so model discretion cannot make the first prompt reliable.

## Consequences

- A quick or repeated Enter cannot cross a pending preset recompose; the send path rejects it before any Host prompt admission and restores the draft.
- A failed preset switch produces no model turn and leaves that Session blocked until the user retries a selection.
- Switching to another Session cannot retarget a draft or completion callback because blocks and drafts are keyed by Session id, and Try Agent navigation is conditional on the originating selection remaining current.
- A Creator entry cannot relabel or retarget the old Session. The first Creator prompt is admitted only after the new Session has echoed `cordis`, its standard Creator tools and Skill catalog are assembled, and any preset-seat block has cleared. Its baseline projection remains UI-only until that prompt establishes a Draft, so no existing-Agent route can run first.
- A same-Session explicit Agent selection remains possible, but its preference cannot cross a Session boundary. The controller emits a development diagnostic if Creator state belongs to another Session or a target/runtime split has no same-Session selection or authoring record.
- The existing five-second client-addressability timeout remains a failure bound only. It never resolves readiness and introduces no delay on a successful event-driven path.

## Testing

Focused client tests prove composer blocks prevent both public send paths from reaching `Session.prompt`, a duplicated preset-seat apply makes one Host call, readiness publishes `pending` before and `ready` after the commit, failures remain blocked, and Try Agent orders create, addressability, preset identity, context installation, open, then P1. Session-lifecycle tests prove Creator staging leaves the old Session untouched, a pending new Session hides the old Blueprint, per-Session target preferences restore only to their owner, a baseline Creator projection clears ordinary model context, runtime preset determines blank-composer copy, and the contradiction diagnostic rejects an unexplained target/runtime split. Negative cases cover preset-identity mismatch, context failure, navigation changed during initialization, exact-Trial publication of a rejected P1 request, third-Session suppression of that failure, and legacy global target preference leakage.
