# Agent Note: Blueprint geometry follows presentation readiness

Status: implemented

English | [中文](2026-08-28-blueprint-layout-presentation-readiness.zh.md)

## Problem

Blueprint can have projected content while the details store remains closed: its deferred open follows context synchronization, which can reject during cold Session materialization. A Session-change layout effect can also close an already opened panel. Neither failure concerns container measurement. Making geometry depend on content recovery leaves a valid panel clipped to zero width.

## Decision

Blueprint requests details opening when its presentation slot registers. The layout controller retains the latest open/close request until root actions attach, then consumes it once. AppFrame derives widths from the layout store and measured frame only. Session slots still own content isolation; hydration, target recovery and Session selection cannot write widths. This replaces the geometry coupling in the [archived Session details decision](../../archived/bug-fix/2026-07-29-web-details-session-lifecycle.md), while retaining its transient storage and Session-scoped content ownership.

Zero means explicitly closed or a derived narrow-viewport concession, never an unmeasured persisted preference. ResizeObserver ignores zero measurements. Repeated opening preserves the current dragged width; explicit closing remains effective. No persistence, timer, retry or new business readiness state is introduced.

## Alternatives considered

**Delay opening or reload after boot.** Rejected because elapsed time does not establish either root attachment or valid geometry.

**Open after every projection or Session update.** Rejected because content RPC failures would still control geometry and repeated hydration could override explicit closure.

**Persist widths.** Rejected because there is no persisted geometry reader to repair; persistence is a separate feature.

## Consequences

An open shell column can be empty while its Session-scoped content hydrates. It cannot display a different Session's content because slot ownership is unchanged. The former automatic Session-switch closure is removed; explicit closure and viewport concessions remain. Unit tests cover pre-mount requests, hydration, repeated attachment, dragged widths, explicit closure and ignored obsolete storage. The runnable Web example pins Draft and Session-switch geometry in the assembled snapshot. Live context errors remain visible and are not converted into successful business recovery.
