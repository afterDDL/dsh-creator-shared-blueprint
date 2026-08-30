# Agent Note: Capability additions publish only after recoverable verification

Status: implemented

English | [中文](2026-08-30-blueprint-capability-verified-publication.zh.md)

## Problem

Capability Creator previously edited the formal preset before Host validation. A completed Creator could therefore leave a new Skill row and files in committed state even when fresh mount verification failed. `blueprint.get` then projected that unverified state while the source published a failure terminal. The first bad transition was the formal preset write before authority and runtime proof; the violated invariant was that committed Blueprint capabilities must come from one successfully verified preset generation.

One failed Creator turn or one failed mount also ended the user request immediately. That exposed internal plugin names and verification stages as product errors even when the same Creator could repair its candidate.

## Decision

One admitted capability route holds an exclusive target lease and clones the complete formal preset directory into a hidden sibling candidate. The Creator receives a scoped roster overlay and write guard that expose only that candidate plus the minimum non-delegating authoring Tools. Formal preset files, committed Blueprint projection, and running Sessions remain unchanged throughout authoring and repair.

The Host validates composition authority before creating a verification Session. Skill candidates may add only one exact local Skill wiring and one new target-owned callable Skill; ambient default Skill roots are disabled. Subagent candidates may add only one active `tool-subagent` row whose identity and complete config digest bind the later evidence. Both lanes then use a fresh isolated Session to prove mounted runtime conformance, active Blueprint projection, and the requested lane-specific behavior. Complete-tree digests fence the candidate before composition parsing, after authority validation, after runtime verification, and at publication.

A failed check appends a private `blueprint/capability-repair` record with the exact prerequisite, diagnostic, turn, attempt, and candidate digest. The Host sends that diagnostic to the same deterministic Creator under the same source Session and route. Skill and Subagent share this bounded repair lifecycle. The source remains in configuring state and never receives an intermediate failure terminal or implementation diagnostic. Process restart reconstructs the latest undelivered repair input from its durable message id without creating another interaction.

A successful check appends and flushes `blueprint/capability-verified` before any formal directory move. Publication uses the preset publication gate and a crash-recoverable full-directory journal, then invalidates the standing pointer so only future Sessions join the new generation. The completed terminal is published only after that transaction is committed. A Host read without a live Agent captures metadata, composition text, and one standing key under the same publication exclusion, so `blueprint.get` cannot mix formal text from one generation with Skill registrations from another.

Publication retries are bounded. If validation or publication cannot succeed within the configured budget, the Host proves that the formal tree still matches its baseline, records discard evidence, and publishes one failed terminal without the private diagnostic. The client presents a temporary, retryable message and retains the previous committed Blueprint. Retrying starts a new route; it never relabels the rejected candidate as verified. A user cancellation is durably checkpointed before Creator cancellation and candidate discard, and recovery completes that cancellation without replaying authoring input.

## Alternatives considered

**Write the formal preset and roll it back after verification.** Formal projection, standing mounts, and concurrent readers can observe the unverified interval. A rollback also cannot prove that it is not overwriting a concurrent edit.

**Treat file existence or Creator prose as success.** Neither proves Loader resolution, scoped Skill discovery, Tool loading, provider availability, or fresh-Session conformance.

**End the route after its first failed verification.** A validation diagnostic is actionable input for the reserved Creator, not yet proof that the user's request cannot be completed.

**Maintain separate Skill and Subagent recovery flows.** Their lane evidence differs, but isolation, retry ownership, publication, cancellation, and user-visible states have the same obligations. Separate lifecycle state machines would allow them to drift again.

## Consequences

Capability authoring uses hidden disk space and one fresh Session per verification attempt. Both costs are bounded by the configured repair count, and terminal cleanup removes the candidate transaction after its disposition is durable. Running Sessions keep their joined generation; committed publication affects only later Sessions.

`blueprint/capability-repair`, `blueprint/capability-verified`, and `blueprint/capability-cancel-requested` are known Session events. They do not change the Session envelope format. Pre-release histories that lack candidate authority cannot be treated as verified publication. No Agent Loop change is required.

## Verification

Runtime coverage includes first-failure/second-success repair for both lanes, formal-baseline preservation during failure, authority rejection before verification Session creation, actual Skill loading, fresh delegation conformance, exhausted repair, bounded publication retry, durable cancellation, and clean-restart recovery without duplicate interaction. Projection coverage forces a publication between assembly and Skill reads and proves one result remains entirely on its captured generation.
