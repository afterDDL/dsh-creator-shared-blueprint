/** Source-backed Behavior discovery; numbered Output and other persona projections remain separate. */

import type { PersonaItem } from './composition.ts'
import { hasUniqueTrimmedLine, projectPersona } from './composition.ts'
import { isOutputItem } from './writeback.ts'
import type { BlueprintMappingGap, BlueprintNode } from './types.ts'

/** One real rule with source evidence and the existing ordinal write address, when available. */
export interface BehaviorSemanticProjection {
  /** Stable Blueprint id; section ids do not imply an ordinal write address. */
  id: string
  /** Exact parsed persona text supplying this rule. */
  sourceValue: string
  /** Rule text used for runtime conformance. */
  semanticValue: string
  /** User-facing rule text, without an added interpretation. */
  displayValue: string
  /** Authoritative rule owner. */
  source: 'preset'
  /** Explicit section discovery or the existing numbered workflow representation. */
  projectionKind: 'explicit-behavior' | 'numbered-behavior'
  /** Whether the existing single-line ordinal writer can address this rule. */
  editable: boolean
  /** Safe existing rewrite, or null for source-backed read-only rules. */
  writebackMethod: 'replace-numbered-line' | null
  /** Number and spacing retained by the existing ordinal writer. */
  prefix?: string
  /** Trailing text retained around a writable rule. */
  suffix?: string
}

interface Section {
  kind: 'behavior' | 'other'
  heading: string
  lines: string[]
  sourceLines: string[]
}

const BEHAVIOR_HEADING = /^(?:#{1,6}\s+)?(?:行为规则|行为约束|工作方式|规则|约束|Behavior(?:al\s+rules)?|Rules|Constraints)(?:\s*[：:]\s*(.*)|\s*)$/iu
const OTHER_HEADING = /^(?:#{1,6}\s+|(?:角色|目标|输出|交付形式|Role|Purpose|Output(?:\s+format)?|Deliverable)[：:])/iu

function sections(text: string): Section[] {
  const result: Section[] = []
  let current: Section | undefined
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0) {
      current?.sourceLines.push(rawLine)
      continue
    }
    const heading = BEHAVIOR_HEADING.exec(line)
    if (heading !== null) {
      current = { kind: 'behavior', heading: line, lines: heading[1] ? [heading[1]] : [], sourceLines: [rawLine] }
      result.push(current)
    } else if (OTHER_HEADING.test(line) || projectPersona(line).identity !== undefined) {
      current = { kind: 'other', heading: line, lines: [], sourceLines: [rawLine] }
      result.push(current)
    } else {
      current?.lines.push(line)
      current?.sourceLines.push(rawLine)
    }
  }
  return result
}

/** Split only an explicitly identified rule section, including YAML-folded numbered or bullet lists. */
function sectionRules(section: Section): { values: string[]; ambiguous: boolean } {
  const body = section.lines.join('\n')
  if (body.length === 0) return { values: [], ambiguous: false }
  const numbered = /^\d+\.\s/u.test(body)
  const bullet = /^[-*+]\s/u.test(body)
  if (!numbered && !bullet) return { values: [body], ambiguous: false }
  const markers = [...body.matchAll(numbered ? /(?:^|\s)(\d+)\.\s+/gu : /(?:^|\s)[-*+]\s+/gu)]
  if (numbered && markers.some((marker, index) => Number(marker[1]) !== Number.parseInt(body, 10) + index)) {
    return { values: [body], ambiguous: true }
  }
  return {
    values: markers.map((marker, index) => body.slice(
      marker.index + marker[0].length, markers[index + 1]?.index ?? body.length,
    ).trim()).filter(Boolean),
    ambiguous: false,
  }
}

/**
 * Discover rules only in the real persona scalar, retaining existing numbered workflow items.
 * Explicit rule headings admit folded lists and bullets; a recognized role paragraph ends the section.
 * @param text - Loader-parsed persona.config.text, never another prompt section or preset metadata.
 * @param items - existing numbered persona items, including separately classified Output.
 * @param composition - original YAML used solely to verify existing physical write anchors.
 * @param writable - whether the preset has user trust.
 * @returns semantic evidence, renderable nodes, and diagnostics for unsupported or read-only sources.
 */
export function projectBehaviors(
  text: string | undefined,
  items: readonly PersonaItem[],
  composition: string,
  writable: boolean,
): { semantics: BehaviorSemanticProjection[]; nodes: BlueprintNode[]; gaps: BlueprintMappingGap[] } {
  const semantics: BehaviorSemanticProjection[] = []
  const gaps: BlueprintMappingGap[] = []
  const sourceSections = sections(text ?? '')
  const ruleSections = sourceSections.filter(section => section.kind === 'behavior')
  const consumed = new Set<PersonaItem>()
  const appendNumbered = (item: PersonaItem, explicit: boolean): void => {
    consumed.add(item)
    const editable = writable && item.ordinal > 0
      && items.filter(candidate => candidate.ordinal === item.ordinal).length === 1
      && hasUniqueTrimmedLine(composition, item.paragraph)
    semantics.push({
      id: `behavior:${String(item.ordinal)}`, sourceValue: item.paragraph,
      semanticValue: item.text, displayValue: item.text, source: 'preset',
      projectionKind: explicit ? 'explicit-behavior' : 'numbered-behavior', editable,
      writebackMethod: editable ? 'replace-numbered-line' : null,
      ...(editable ? { prefix: `${String(item.ordinal)}. `, suffix: '' } : {}),
    })
  }
  for (const [sectionIndex, section] of ruleSections.entries()) {
    const rules = sectionRules(section)
    if (rules.values.length === 0) {
      gaps.push({ field: 'behavior', reason: `The explicit rule heading ${JSON.stringify(section.heading)} has no rule content.` })
    }
    if (rules.ambiguous) {
      gaps.push({ field: 'behavior', reason: 'Rule numbering is ambiguous; the complete explicit section remains read-only.' })
    }
    for (const [index, value] of rules.values.entries()) {
      if (isOutputItem(value)) continue
      const matches = items.filter(item => !isOutputItem(item.text) && item.text === value
        && section.lines.includes(item.paragraph))
      const item = matches.length === 1 ? matches[0] : undefined
      if (item !== undefined && !consumed.has(item)
        && items.filter(candidate => candidate.ordinal === item.ordinal).length === 1) {
        appendNumbered(item, true)
      } else {
        const sourceValue = section.sourceLines.join('\n')
        semantics.push({
          id: `behavior:section:${String(sectionIndex)}:${String(index)}`,
          sourceValue, semanticValue: value, displayValue: value, source: 'preset',
          projectionKind: 'explicit-behavior', editable: false, writebackMethod: null,
        })
      }
    }
    for (const item of items) {
      if (section.lines.includes(item.paragraph)) consumed.add(item)
    }
  }
  for (const item of items) {
    if (isOutputItem(item.text) || consumed.has(item)) continue
    const owner = sourceSections.find(section => section.lines.includes(item.paragraph))
    // Existing numbered workflows remain supported; explicit non-rule sections cannot supply new rules.
    if (owner?.kind === 'other'
      && /^(?:#{1,6}\s+)?(?:输出|交付形式|Output|Deliverable)(?:[：:]|\s|$)/iu.test(owner.heading)) continue
    appendNumbered(item, false)
  }
  if (semantics.some(rule => !rule.editable)) {
    gaps.push({ field: 'behavior', reason: 'Real rules without a unique supported ordinal write anchor are projected read-only.' })
  }
  return {
    semantics,
    nodes: semantics.map(rule => ({
      id: rule.id, type: 'behavior', value: rule.displayValue, source: rule.source, status: 'active',
      editable: rule.editable,
      adapterRef: rule.editable ? `preset:persona.config.text#${rule.id}` : null,
    })),
    gaps,
  }
}
