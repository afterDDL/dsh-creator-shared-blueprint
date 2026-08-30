# Agent Note: Blueprint projects persona semantics from explicit text anchors

Status: implemented

English | [中文](2026-08-27-blueprint-persona-semantic-anchors.zh.md)

## Problem

Interactive Blueprint treated the first non-Identity persona paragraph as Purpose and recognized Output only when a numbered item contained a small set of delivery labels. A copied runtime introduction could therefore appear as the user-facing task, including `{{model}}` and `{{cwd}}`, while a detailed report template remained invisible. The capability summary also suppressed active Web Search and File Read unless a domain rule happened to consume those Tool nodes, so an Agent with real search, file, and delegation support could appear to have only one collaborator capability.

## Decision

This narrows the persona projection rules owned by the [Interactive Blueprint adapter](../feature/2026-08-24-interactive-blueprint-preset-adapter.md). Creator-authored personas keep using ordinary prompt text as the only preset source. They now provide one `角色：…` or `Role: …` line, one `目标：…` or `Purpose: …` line, numbered Behavior items, and exactly one standalone `输出：…` or `Output: …` line. A copied preset is audited for these semantic lines and redundant translated glosses before validation. These are authoring conventions, not a second configuration model.

Purpose projection retains the exact source paragraph, extracts a semantic and display value, records whether the source is explicit or inferred, and exposes write-back only for one unique physical-line replacement span. One explicit marker takes precedence over legacy responsibility clauses; competing explicit markers remain ambiguous. Explicit markers and supported responsibility clauses preserve their prefixes and suffixes during typed writes. Legacy fallback skips headings, Identity introductions, and paragraphs containing runtime-template variables. Exactly one standalone Output line is projected from its explicit marker but remains read-only; an explicitly labeled numbered Output retains the existing ordinal write adapter.

Identity participates in the same durable text-update event as Purpose, Behavior, and Output. The Session invariant checks its semantic values and recorded candidate evidence; Identity candidates remain limited to Purpose, Behavior, and Output peers. Safe role-span, revision, and expected-value checks remain in the authoritative write path. Re-reading the current preset during event replay would incorrectly judge a historical edit against later configuration, so the invariant validates recorded evidence rather than reconstructing that write.

The client derives Agent-specific work only from semantic nodes, while active Web Search and File Read receive separate user-level summaries backed by their real capability node ids. Search may retain Web Fetch as additional evidence. File analysis wording requires both File Read and semantic text that states analysis-like work. Preset-local Skills and provider-backed delegations keep their existing evidence rules, and inherited Skill catalogs remain hidden.

Behavior discovery cannot depend on YAML preserving physical newlines: the Creator can place a rule heading and consecutive numbered lines in a folded scalar. The parsed persona remains authoritative. Explicit rule sections, including `行为规则`, `行为约束`, and `工作方式`, supply source-backed rules even without the existing ordinal write address; those projections are read-only with a mapping diagnostic. Recognized Identity paragraphs end rule sections so trailing runtime introductions cannot contaminate rule evidence. Numbered Output and explicit Output sections remain excluded. The [real folded-rule fixture](../../../../examples/web-blueprint-demo/tests/fixtures/preset/blueprint-adapter/rc1-folded-rules.cordis.yml) and [Creator working-method fixture](../../../../examples/web-blueprint-demo/tests/fixtures/preset/blueprint-adapter/creator-working-method.cordis.yml) preserve this distinction without changing Creator authoring or the other semantic parsers.

## Alternatives considered

A separate semantic metadata file would create another source of truth beside the preset persona. Render-time model summarization would make display unstable and could claim semantics without a write-back address. Both were rejected in favor of explicit lines in the existing persona text and deterministic projection.

Treating every inline number as a rule would consume report structures and arbitrary prose. Requiring a supported rule heading for newly recovered formats retains semantic evidence without a general natural-language classifier. Requiring typed write-back for visibility would discard genuine constraints, so safe display and write authorization remain separate.

## Consequences

- Purpose display and write-back cannot consume the runtime persona introduction.
- Creator-created Agents can project all five user-level sections without adding a new preset field or changing P0, P1, or P2.
- A Purpose edit preserves role and runtime-template text because only the anchored span changes.
- Output remains directly editable only when it has a unique numbered source line; a standalone semantic Output remains selectable and readable.
- Primary runtime capabilities no longer disappear from the semantic summary, but persona claims alone still cannot create them.
- Capability labels follow the Blueprint language choice; technical Tool, Skill, and provider identifiers remain internal.

## Testing

Focused projection tests cover explicit Chinese Purpose extraction beside runtime-template and legacy responsibility paragraphs, unique standalone and numbered Output recognition, ambiguous duplicate anchors, and narrow Purpose replacement that preserves Identity and template variables. Client tests cover six domain-distinct Agent summaries, supplier due-diligence work with real search, file, and delegation evidence, and English capability labels. Package TypeScript checks cover both the Host adapter and Blueprint client.
