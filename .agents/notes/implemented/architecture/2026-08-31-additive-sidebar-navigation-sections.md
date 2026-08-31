# Agent Note: Additive sidebar navigation sections

Status: implemented

English | [中文](2026-08-31-additive-sidebar-navigation-sections.zh.md)

## Problem

An external client plugin may need a persistent navigation or roster surface above the Workspace and Session browser. Interactive Blueprint added a single `sidebar.agents` seat whose name and ownership assumed its Agent roster. That prevented unrelated advanced plugins from sharing the position and made the Core patch describe one consumer rather than a Sidebar capability.

## Decision

`@deepseek-ai/dsh-client-ui-sidebar` owns the ordered root-scoped list slot `sidebar.navigation.section`. Every registration supplies a stable `id` and optional `order`; the slot ledger rejects duplicate ids and orders independent sections deterministically. A section receives `SidebarNavigationSectionProps`, including the shell's settled `wide` state and `expandSidebar()`. The callback expands only from the rail, so a wide section cannot accidentally collapse the column.

The shell renders the list between New Session and `sidebar.workspaces`. The workspace browser remains the flex-filling scrolling region and Settings remains bottom-pinned. Section components stay mounted across collapse and choose whether to render a rail control or nothing when `wide` is false. The shell does not infer business data, selection, badges, or navigation behavior.

The slot is declared with the sidebar shell. A plugin uses `ctx.slots.inject` to start before or after that declaration; registration and removal are ordinary effects. Disposing one plugin removes only its ids and leaves sibling sections, the Workspace browser, and shell controls intact. The slot persists no data. On refresh or restart, a restored plugin re-registers and obtains its own durable state through its services. Closing or expanding the sidebar affects layout only and does not cancel a section's business lifecycle.

## Blueprint migration

Interactive Blueprint registers its Agent roster as `id: 'blueprint-agents'` in `sidebar.navigation.section` and types the component with `SidebarNavigationSectionProps`. It retains `order: 0` and continues to return nothing on the rail. Agent selection, roster loading, and visible copy do not change.

## Alternatives considered

**Keep `sidebar.agents` as a single slot.** Rejected because Agent presentation is one consumer and a second navigation feature would have to replace it or patch another position.

**Let plugins replace the complete `sidebar` owner.** Rejected because replacement removes New Session, Workspace browsing, Settings, collapse choreography, and every child seat.

**Put feature rows inside `sidebar.workspaces`.** Rejected because ui-workspace owns browsing, search, grouping, and dialogs; unrelated navigation state would couple to that package.

**Hide every contribution when collapsed.** Rejected because a generic plugin may have a meaningful rail control. The entry owns that presentation choice through `wide`.

## Consequences

Any client plugin can add an ordered sidebar navigation section without importing Blueprint. The non-Blueprint `external-navigation-sections` test starts before the shell declaration, registers project-index and runtime-monitor sections, proves order, and disposes both without changing the Workspace or Settings seats. Sidebar DOM tests prove every section receives the wide state and rail-only expansion action.

The list does not arbitrate scarce vertical space. Consumers must keep sections compact, provide stable ids, and avoid duplicating controls already owned by the shell or Workspace browser.
