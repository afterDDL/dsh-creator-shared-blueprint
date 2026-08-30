/** Preset composition parsing and comment-preserving narrow rewrites. */

import { createHash } from 'node:crypto'
import { load } from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { canonicalJson } from './canonical-json.ts'
import { sourceLanguageFromText } from './language.ts'

/** Minimal loader row fields the adapter reads. */
export interface CompositionRow {
  id?: unknown
  name?: unknown
  disabled?: unknown
  group?: unknown
  config?: unknown
}

/** Numbered persona item recovered from explicit prose structure. */
export interface PersonaItem {
  ordinal: number
  text: string
  paragraph: string
}

/** Persona fields the adapter can attribute without inventing missing sections. */
export interface PersonaProjection {
  identity?: IdentitySemanticProjection
  purpose?: PurposeSemanticProjection
  output?: OutputSemanticProjection
  items: PersonaItem[]
}

/** Source-backed user-level deliverable recovered from a standalone persona line. */
interface OutputSemanticProjection {
  /** Exact persona paragraph that supplies the deliverable evidence. */
  sourceValue: string
  /** Deliverable meaning used by runtime conformance. */
  semanticValue: string
  /** User-facing deliverable text. */
  displayValue: string
  /** Authoritative owner of the deliverable evidence. */
  source: 'preset'
  /** Deterministic extraction used for this persona. */
  projectionKind: 'explicit-output'
  /** Standalone Output does not use the existing ordinal write address. */
  editable: false
  /** No narrow write is exposed for this projection. */
  writebackMethod: null
}

/** Source-backed task goal recovered from the persona scalar. */
interface PurposeSemanticProjection {
  /** Exact persona paragraph that supplies the task evidence. */
  sourceValue: string
  /** Task meaning used by typed writes and runtime conformance. */
  semanticValue: string
  /** User-facing task text; never includes runtime-template prose. */
  displayValue: string
  /** Authoritative owner of the task evidence. */
  source: 'preset' | 'inferred'
  /** Deterministic extraction used for this persona. */
  projectionKind: 'explicit-purpose' | 'purpose-clause' | 'legacy-purpose-paragraph'
  /** Whether the extraction supplies one deterministic replacement span. */
  editable: boolean
  /** Narrow source rewrite available for this extraction. */
  writebackMethod: 'replace-purpose-span' | null
  /** Text retained before a writable task span. */
  prefix?: string
  /** Text retained after a writable task span. */
  suffix?: string
}

/** Source-backed user-level role recovered from the persona scalar. */
export interface IdentitySemanticProjection {
  /** Exact persona paragraph that supplies the role evidence. */
  sourceValue: string
  /** Role meaning used by typed writes and runtime conformance. */
  semanticValue: string
  /** User-facing role text; never includes runtime-template prose. */
  displayValue: string
  /** Authoritative owner of the role evidence. */
  source: 'preset'
  /** Deterministic extraction used for this persona. */
  projectionKind: 'explicit-role' | 'persona-role-slot' | 'legacy-role-clause'
  /** Whether the extraction supplies one deterministic replacement span. */
  editable: boolean
  /** Narrow source rewrite available for this extraction. */
  writebackMethod: 'replace-role-span' | null
  /** Text retained before a writable role span. */
  prefix?: string
  /** Text retained after a writable role span. */
  suffix?: string
}

/** Safely projected configuration of one active `tool-subagent` row. */
export interface DelegationProjection {
  /** Stable preset composition row id. */
  rowId: string
  /** Model-visible Tool name after plugin defaults. */
  tool: string
  /** Requested Subagent provider. */
  provider: string
  /** Declared child lifecycle mode after plugin defaults. */
  mode: 'one-shot' | 'continuable'
  /** SHA-256 of the complete parsed row config, including unevaluated Loader expressions. */
  configDigest: string
  /** Optional fixed child persona. */
  persona?: string
  /** Whether the provider currently exists. */
  providerAvailable: boolean
  /** Whether the standing Tool assembly exposes this row's Tool. */
  enabled: boolean
}

/** One delegation row that cannot receive a stable Blueprint node. */
export interface DelegationProjectionGap {
  /** Composition row id when one was present. */
  rowId?: string
  /** Complete reason the row is not projected. */
  reason: string
}

interface IdentityAnchor {
  value: string
  prefix: string
  suffix: string
  projectionKind: IdentitySemanticProjection['projectionKind']
}

interface PurposeAnchor {
  value: string
  prefix: string
  suffix: string
  projectionKind: PurposeSemanticProjection['projectionKind']
  source: PurposeSemanticProjection['source']
}

/** Recover a role-only slot from an explicit semantic marker or supported persona sentence. */
function identityAnchor(paragraph: string): IdentityAnchor | undefined {
  const patterns = [
    { pattern: /^(角色[：:]\s*)([^\r\n]+?)()$/u, projectionKind: 'explicit-role' as const },
    { pattern: /^(Role:\s*)([^\r\n]+?)()$/iu, projectionKind: 'explicit-role' as const },
    {
      pattern: /^(你是一(?:名|位))(.+?)(，由 \{\{model\}\} 驱动，工作目录是 \{\{cwd\}\}。)$/u,
      projectionKind: 'persona-role-slot' as const,
    },
    {
      pattern: new RegExp(
        '^(You are (?:an? ))(.+?)( ?powered by the \\{\\{model\\}\\} model'
          + '(?:, running on the DeepSeek Harness)?\\. Your working directory is \\{\\{cwd\\}\\}\\.)$',
        'u',
      ),
      projectionKind: 'persona-role-slot' as const,
    },
  ]
  for (const { pattern, projectionKind } of patterns) {
    const match = pattern.exec(paragraph)
    if (match !== null && match[1] !== undefined && match[2] !== undefined && match[3] !== undefined) {
      const value = semanticRole(match[2])
      if (validRole(value)) return { prefix: match[1], value, suffix: match[3], projectionKind }
    }
  }
  return undefined
}

function semanticRole(value: string): string {
  const trimmed = value.trim()
  const bilingual = /^([^（(]*?)[（(]([^）)]*\p{Script=Han}[^）)]*)[）)]$/u.exec(trimmed)
  const source = bilingual?.[1]?.trim()
  const translation = bilingual?.[2]?.trim()
  return source !== undefined && translation !== undefined && !/\p{Script=Han}/u.test(source)
    ? translation
    : trimmed
}

function validRole(value: string): boolean {
  return value.length > 0 && value.length <= 100 && !/[{}\r\n]/u.test(value)
}

function legacyIdentity(paragraph: string): IdentitySemanticProjection | undefined {
  const patterns = [
    /^(?:你是一名|你是一位|你是)\s*([^，。；！？\r\n]{1,100})/u,
    /^You are (?:an? |the )?(.+?)(?=\s*powered by\b|\s+running (?:on|in)\b|\.\s+Your working directory\b|[.!?]|$)/iu,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(paragraph)
    const value = match?.[1] === undefined ? undefined : semanticRole(match[1])
    if (value !== undefined && validRole(value)) {
      return {
        sourceValue: paragraph,
        semanticValue: value,
        displayValue: value,
        source: 'preset',
        projectionKind: 'legacy-role-clause',
        editable: false,
        writebackMethod: null,
      }
    }
  }
  return undefined
}

function purposeAnchor(paragraph: string): PurposeAnchor | undefined {
  const explicitPatterns = [
    /^(目标[：:]\s*)([^\r\n]+?)()$/u,
    /^(Purpose:\s*)([^\r\n]+?)()$/iu,
  ]
  for (const pattern of explicitPatterns) {
    const match = pattern.exec(paragraph)
    if (match?.[1] !== undefined && match[2] !== undefined && match[3] !== undefined) {
      return {
        prefix: match[1], value: match[2].trim(), suffix: match[3],
        projectionKind: 'explicit-purpose', source: 'preset',
      }
    }
  }
  const clausePatterns = [
    /^(你的职责是\s*)(.+?)(\s*工作方式[:：])?$/u,
    /^(Your mandate:\s*)(.+?)()$/iu,
  ]
  for (const pattern of clausePatterns) {
    const match = pattern.exec(paragraph)
    if (match?.[1] !== undefined && match[2] !== undefined) {
      return {
        prefix: match[1], value: match[2].trim(), suffix: match[3] ?? '',
        projectionKind: 'purpose-clause', source: 'inferred',
      }
    }
  }
  return undefined
}

function purposeProjection(
  paragraphs: readonly string[],
  identityParagraph: string | undefined,
  outputParagraph: string | undefined,
): PurposeSemanticProjection | undefined {
  const candidates = paragraphs.filter(paragraph => paragraph !== identityParagraph
    && paragraph !== outputParagraph
    && !/^\d+\.\s/u.test(paragraph))
  const anchored = candidates.flatMap((paragraph): Array<{ paragraph: string; anchor: PurposeAnchor }> => {
    const anchor = purposeAnchor(paragraph)
    return anchor === undefined || anchor.value.length === 0 ? [] : [{ paragraph, anchor }]
  })
  const explicit = anchored.filter(({ anchor }) => anchor.projectionKind === 'explicit-purpose')
  const selectable = explicit.length === 0 ? anchored : explicit
  if (selectable.length > 1) return undefined
  const match = selectable[0]
  if (match !== undefined) {
    const { paragraph, anchor } = match
    return {
      sourceValue: paragraph,
      semanticValue: anchor.value,
      displayValue: anchor.value,
      source: anchor.source,
      projectionKind: anchor.projectionKind,
      editable: true,
      writebackMethod: 'replace-purpose-span',
      prefix: anchor.prefix,
      suffix: anchor.suffix,
    }
  }
  const paragraph = candidates.find(candidate => !/^#{1,6}\s/u.test(candidate)
    && !/\{\{(?:model|cwd)\}\}/u.test(candidate)
    && !/^(?:You are|你是)/iu.test(candidate))
  if (paragraph === undefined) return undefined
  return {
    sourceValue: paragraph,
    semanticValue: paragraph,
    displayValue: paragraph,
    source: 'inferred',
    projectionKind: 'legacy-purpose-paragraph',
    editable: true,
    writebackMethod: 'replace-purpose-span',
    prefix: '',
    suffix: '',
  }
}

function outputProjection(paragraphs: readonly string[]): OutputSemanticProjection | undefined {
  const matches = paragraphs.flatMap((paragraph): Array<{ paragraph: string; value: string }> => {
    const match = /^(?:输出[：:]\s*|Output:\s*)([^\r\n]+)$/iu.exec(paragraph)
    const value = match?.[1]?.trim()
    return value === undefined || value.length === 0 ? [] : [{ paragraph, value }]
  })
  const match = matches.length === 1 ? matches[0] : undefined
  return match === undefined ? undefined : {
    sourceValue: match.paragraph,
    semanticValue: match.value,
    displayValue: match.value,
    source: 'preset',
    projectionKind: 'explicit-output',
    editable: false,
    writebackMethod: null,
  }
}

/** Determine open source-language metadata from semantic source text, then preset metadata. */
export function blueprintSourceLanguage(
  identity: IdentitySemanticProjection | undefined,
  presetName?: string,
  presetDescription?: string,
): string | undefined {
  if (identity !== undefined) return sourceLanguageFromText(identity.displayValue)
  const metadata = `${presetName ?? ''}\n${presetDescription ?? ''}`
  return sourceLanguageFromText(metadata)
}

/** Stable content revision used by optimistic writes. */
export function compositionRevision(composition: string): string {
  return createHash('sha256').update(composition).digest('hex')
}

/** Digest one delegation row's complete parsed config without evaluating Loader expressions. */
function delegationConfigDigest(config: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(config)).digest('hex')
}

/** Parse with the Loader's `!!js`-aware YAML schema. */
export function parseComposition(composition: string): CompositionRow[] {
  const parsed = load(composition, { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new Error('blueprint-adapter: preset composition is not a top-level row list')
  return parsed as CompositionRow[]
}

function compositionAdditions(
  baseline: readonly CompositionRow[],
  candidate: readonly CompositionRow[],
): CompositionRow[] {
  const additions: CompositionRow[] = []
  let baselineIndex = 0
  for (const row of candidate) {
    const expected = baseline[baselineIndex]
    if (expected !== undefined && canonicalJson(row) === canonicalJson(expected)) {
      baselineIndex += 1
    } else {
      additions.push(row)
    }
  }
  if (baselineIndex !== baseline.length) {
    throw new Error('blueprint-adapter: capability candidate changed, removed, or reordered an existing composition row')
  }
  return additions
}

function assertAuthoringRowFields(row: CompositionRow, label: string): void {
  const fields = Object.keys(row)
  if (typeof row.id !== 'string' || row.id.trim() === ''
    || fields.some(field => !['id', 'name', 'config', 'disabled'].includes(field))) {
    throw new Error(`blueprint-adapter: ${label} must be one minimal, uniquely identified top-level row`)
  }
  if (row.disabled !== undefined && row.disabled !== false) {
    throw new Error(`blueprint-adapter: ${label} must be active`)
  }
}

function recordConfig(row: CompositionRow, label: string): Record<string, unknown> {
  if (typeof row.config !== 'object' || row.config === null || Array.isArray(row.config)) {
    throw new Error(`blueprint-adapter: ${label} requires one literal config object`)
  }
  return row.config as Record<string, unknown>
}

/** Verified capability evidence that constrains the only composition addition. */
export type CapabilityCompositionDelta =
  | { kind: 'skill' }
  | { kind: 'subagent'; rowId: string; configDigest: string }

function assertNewAuthoringRow(
  baseline: readonly CompositionRow[],
  candidate: readonly CompositionRow[],
  row: CompositionRow,
  label: string,
): void {
  assertAuthoringRowFields(row, label)
  const id = row.id as string
  if (rowById(baseline, id) !== undefined || rowById(candidate, id) !== row) {
    throw new Error(`blueprint-adapter: ${label} id must be new and unique across the complete composition`)
  }
}

function activeLiteralRow(row: CompositionRow, name: string): boolean {
  return row.name === name && (row.disabled === undefined || row.disabled === false)
}

const PRESET_SKILL_ROOT_EXPRESSION = {
  __jsExpr: "process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))",
}

function isPresetSkillFilesystemRow(row: CompositionRow): boolean {
  if (!activeLiteralRow(row, '@deepseek-ai/dsh-skill-filesystem')) return false
  const config = typeof row.config === 'object' && row.config !== null && !Array.isArray(row.config)
    ? row.config as Record<string, unknown>
    : undefined
  return config !== undefined
    && Object.keys(config).length === 2
    && config['includeDefaultRoots'] === false
    && Array.isArray(config['customSkillDirs'])
    && config['customSkillDirs'].length === 1
    && canonicalJson(config['customSkillDirs'][0]) === canonicalJson(PRESET_SKILL_ROOT_EXPRESSION)
}

function mountsPresetSkillRoot(row: CompositionRow): boolean {
  if (!activeLiteralRow(row, '@deepseek-ai/dsh-skill-filesystem')) return false
  if (typeof row.config !== 'object' || row.config === null || Array.isArray(row.config)) return false
  const roots = (row.config as Record<string, unknown>)['customSkillDirs']
  return Array.isArray(roots)
    && roots.some(root => canonicalJson(root) === canonicalJson(PRESET_SKILL_ROOT_EXPRESSION))
}

function assertPresetSkillFilesystemExtension(
  baseline: CompositionRow,
  candidate: CompositionRow,
): void {
  const baselineFields = { ...baseline }
  const candidateFields = { ...candidate }
  delete baselineFields.config
  delete candidateFields.config
  if (canonicalJson(candidateFields) !== canonicalJson(baselineFields)) {
    throw new Error('blueprint-adapter: Skill authoring must preserve the existing skill-filesystem row')
  }
  const baselineConfig = baseline.config === undefined
    ? {}
    : recordConfig(baseline, 'Existing Skill filesystem row')
  const baselineRoots = baselineConfig['customSkillDirs']
  if (baselineRoots !== undefined && !Array.isArray(baselineRoots)) {
    throw new Error('blueprint-adapter: existing Skill filesystem customSkillDirs must be a literal array')
  }
  const expectedConfig = {
    ...baselineConfig,
    customSkillDirs: [...(baselineRoots ?? []), PRESET_SKILL_ROOT_EXPRESSION],
  }
  const candidateConfig = recordConfig(candidate, 'Extended Skill filesystem row')
  if (canonicalJson(candidateConfig) !== canonicalJson(expectedConfig)) {
    throw new Error('blueprint-adapter: Skill authoring must append only the preset-local root to the existing skill-filesystem row')
  }
}

function skillCompositionAdditions(
  baseline: readonly CompositionRow[],
  candidate: readonly CompositionRow[],
  filesystemExtension: CompositionRow | undefined,
): CompositionRow[] {
  if (filesystemExtension === undefined) return compositionAdditions(baseline, candidate)
  const additions: CompositionRow[] = []
  let baselineIndex = 0
  let extended = false
  for (const row of candidate) {
    const expected = baseline[baselineIndex]
    if (expected !== undefined && canonicalJson(row) === canonicalJson(expected)) {
      baselineIndex += 1
      continue
    }
    if (expected === filesystemExtension) {
      assertPresetSkillFilesystemExtension(expected, row)
      extended = true
      baselineIndex += 1
      continue
    }
    additions.push(row)
  }
  if (baselineIndex !== baseline.length) {
    throw new Error('blueprint-adapter: capability candidate changed, removed, or reordered an existing composition row')
  }
  if (!extended) {
    throw new Error('blueprint-adapter: Skill authoring must extend the existing skill-filesystem row with the preset-local root')
  }
  return additions
}

function isActiveSkillToolRow(row: CompositionRow): boolean {
  return activeLiteralRow(row, '@deepseek-ai/dsh-tool-skill')
}

function isMinimalSkillToolRow(row: CompositionRow): boolean {
  return isActiveSkillToolRow(row) && row.config === undefined
}

/** Prove existing composition rows are unchanged and only lane-owned top-level rows were added. */
export function assertCapabilityCompositionDelta(
  baselineComposition: string,
  candidateComposition: string,
  kind: CapabilityCompositionDelta['kind'],
): CapabilityCompositionDelta {
  const baseline = parseComposition(baselineComposition)
  const candidate = parseComposition(candidateComposition)
  if (kind === 'subagent') {
    const additions = compositionAdditions(baseline, candidate)
    if (additions.length !== 1 || additions[0]?.name !== '@deepseek-ai/dsh-tool-subagent') {
      throw new Error('blueprint-adapter: Subagent authoring may add only one tool-subagent row')
    }
    const row = additions[0]
    assertNewAuthoringRow(baseline, candidate, row, 'Subagent authoring row')
    const allowed = new Set([
      'provider', 'toolName', 'enableRunInBackground', 'backgroundMode',
      'agentOptions', 'persona', 'toolFilter', 'maxDepth',
    ])
    const config = recordConfig(row, 'Subagent authoring row')
    if (Object.keys(config).some(field => !allowed.has(field))) {
      throw new Error('blueprint-adapter: Subagent authoring row contains a non-delegation config field')
    }
    return { kind, rowId: row.id as string, configDigest: delegationConfigDigest(config) }
  }

  const baselineRows = flattenRows(baseline)
  const alreadyMountsPresetRoot = baselineRows.some(mountsPresetSkillRoot)
  const topLevelFilesystemRows = baseline.filter(row => activeLiteralRow(row, '@deepseek-ai/dsh-skill-filesystem'))
  if (!alreadyMountsPresetRoot && topLevelFilesystemRows.length > 1) {
    throw new Error('blueprint-adapter: baseline has more than one active top-level skill-filesystem row to extend')
  }
  const filesystemExtension = alreadyMountsPresetRoot ? undefined : topLevelFilesystemRows[0]
  const additions = skillCompositionAdditions(baseline, candidate, filesystemExtension)
  const filesystemRows = additions.filter(row => row.name === '@deepseek-ai/dsh-skill-filesystem')
  const toolRows = additions.filter(row => row.name === '@deepseek-ai/dsh-tool-skill')
  const needsFilesystemRow = !alreadyMountsPresetRoot && filesystemExtension === undefined
  const needsToolRow = !baselineRows.some(isActiveSkillToolRow)
  if (filesystemRows.length !== Number(needsFilesystemRow) || toolRows.length !== Number(needsToolRow)
    || additions.length !== filesystemRows.length + toolRows.length) {
    throw new Error('blueprint-adapter: Skill authoring may add only one skill-filesystem row and one tool-skill row')
  }
  for (const row of toolRows) {
    assertNewAuthoringRow(baseline, candidate, row, 'Skill loader row')
    if (!isMinimalSkillToolRow(row)) throw new Error('blueprint-adapter: Skill loader row must not add unrelated config')
  }
  for (const row of filesystemRows) {
    assertNewAuthoringRow(baseline, candidate, row, 'Skill filesystem row')
    if (!isPresetSkillFilesystemRow(row)) {
      throw new Error('blueprint-adapter: Skill filesystem row must mount only one preset-local root without default roots')
    }
  }
  return { kind }
}

/** Flatten group rows while retaining the group rows themselves. */
function flattenRows(rows: readonly CompositionRow[]): CompositionRow[] {
  const flattened: CompositionRow[] = []
  for (const row of rows) {
    flattened.push(row)
    if (row.group === true && Array.isArray(row.config)) {
      flattened.push(...flattenRows(row.config as CompositionRow[]))
    }
  }
  return flattened
}

/** Find exactly one row by id, rejecting an ambiguous preset. */
export function rowById(rows: readonly CompositionRow[], id: string): CompositionRow | undefined {
  const found = flattenRows(rows).filter(row => row.id === id)
  if (found.length > 1) throw new Error(`blueprint-adapter: preset contains duplicate row id ${JSON.stringify(id)}`)
  return found[0]
}

/** Read the persona text from the real persona row. */
export function personaText(rows: readonly CompositionRow[]): string | undefined {
  const row = rowById(rows, 'persona')
  if (row === undefined || typeof row.config !== 'object' || row.config === null || Array.isArray(row.config)) return undefined
  const text = (row.config as Record<string, unknown>)['text']
  return typeof text === 'string' ? text : undefined
}

/** Project only structure explicitly present in the persona prose. */
export function projectPersona(text: string | undefined): PersonaProjection {
  if (text === undefined) return { items: [] }
  const paragraphs = text.split(/\n+/u).map(value => value.trim()).filter(value => value.length > 0)
  const identityParagraph = paragraphs.find(paragraph => !/^\d+\.\s/u.test(paragraph))
  const identitySlot = identityParagraph === undefined ? undefined : identityAnchor(identityParagraph)
  const identity = identityParagraph === undefined
    ? undefined
    : identitySlot === undefined
      ? legacyIdentity(identityParagraph)
      : {
        sourceValue: identityParagraph,
        semanticValue: identitySlot.value,
        displayValue: identitySlot.value,
        source: 'preset' as const,
        projectionKind: identitySlot.projectionKind,
        editable: true,
        writebackMethod: 'replace-role-span' as const,
        prefix: identitySlot.prefix,
        suffix: identitySlot.suffix,
      }
  const output = outputProjection(paragraphs)
  const purpose = purposeProjection(paragraphs, identityParagraph, output?.sourceValue)
  const items = paragraphs.flatMap((paragraph): PersonaItem[] => {
    const match = /^(\d+)\.\s+([\s\S]+)$/u.exec(paragraph)
    if (match === null) return []
    return [{ ordinal: Number(match[1]), text: match[2] ?? '', paragraph }]
  })
  return {
    ...(identity === undefined ? {} : { identity }),
    ...(purpose === undefined ? {} : { purpose }),
    ...(output === undefined ? {} : { output }),
    items,
  }
}

/** Whether a semantic paragraph has one exact physical-line write target. */
export function hasUniqueTrimmedLine(composition: string, value: string): boolean {
  return composition.split(/\r?\n/u).filter(line => line.trim() === value).length === 1
}

/** Replace one exact physical line while retaining its indentation and line endings. */
export function replaceUniqueTrimmedLine(composition: string, expected: string, value: string): string {
  if (/\r|\n/u.test(value)) throw new Error('blueprint-adapter: text writes must be a single physical line')
  const newline = composition.includes('\r\n') ? '\r\n' : '\n'
  const trailing = composition.endsWith('\n')
  const lines = composition.split(/\r?\n/u)
  if (trailing) lines.pop()
  const matches = lines.flatMap((line, index) => line.trim() === expected ? [index] : [])
  if (matches.length !== 1) {
    throw new Error(`blueprint-adapter: expected exactly one writable line ${JSON.stringify(expected)}, found ${String(matches.length)}`)
  }
  const index = matches[0] as number
  const indent = /^\s*/u.exec(lines[index] ?? '')?.[0] ?? ''
  lines[index] = indent + value
  return lines.join(newline) + (trailing ? newline : '')
}

/** Configured Web Fetch value from the real `tool-web` row. */
export function configuredWebFetch(rows: readonly CompositionRow[]): boolean | undefined {
  return configuredBoolean(rows, 'tool-web', 'fetch', true)
}

/** Resolve one defaulted boolean from a uniquely addressed plugin row. */
export function configuredBoolean(
  rows: readonly CompositionRow[],
  rowId: string,
  field: string,
  defaultValue: boolean,
): boolean | undefined {
  const row = rowById(rows, rowId)
  if (row === undefined) return undefined
  if (typeof row.config !== 'object' || row.config === null || Array.isArray(row.config)) return defaultValue
  const value = (row.config as Record<string, unknown>)[field]
  return typeof value === 'boolean' ? value : defaultValue
}

/**
 * Project active delegation rows without evaluating Loader expressions or inventing child Agents.
 * @param rows - parsed preset composition.
 * @param toolNames - actual standing model-visible Tool names.
 * @param providerNames - currently registered Subagent providers.
 * @returns safe delegation records and rows omitted for missing stable identity/configuration.
 */
export function projectDelegations(
  rows: readonly CompositionRow[],
  toolNames: ReadonlySet<string>,
  providerNames: ReadonlySet<string>,
): { delegations: DelegationProjection[]; gaps: DelegationProjectionGap[] } {
  const delegations: DelegationProjection[] = []
  const gaps: DelegationProjectionGap[] = []
  const activeRows = flattenRows(rows)
    .filter(row => row.name === '@deepseek-ai/dsh-tool-subagent' && row.disabled !== true)
  const rowIdCounts = new Map<string, number>()
  for (const row of activeRows) {
    if (typeof row.id === 'string') rowIdCounts.set(row.id, (rowIdCounts.get(row.id) ?? 0) + 1)
  }
  for (const row of activeRows) {
    const rowId = typeof row.id === 'string' && row.id.length > 0 ? row.id : undefined
    if (rowId === undefined) {
      gaps.push({ reason: 'An active tool-subagent row has no stable string id.' })
      continue
    }
    if (rowIdCounts.get(rowId) !== 1) {
      gaps.push({ rowId, reason: 'The active tool-subagent row id is duplicated.' })
      continue
    }
    if (typeof row.config !== 'object' || row.config === null || Array.isArray(row.config)) {
      gaps.push({ rowId, reason: 'The active tool-subagent row has no object config.' })
      continue
    }
    const config = row.config as Record<string, unknown>
    const provider = config['provider']
    const tool = config['toolName'] ?? 'subagent'
    const mode = config['backgroundMode'] ?? 'one-shot'
    if (typeof provider !== 'string' || provider.length === 0
      || typeof tool !== 'string' || tool.length === 0
      || (mode !== 'one-shot' && mode !== 'continuable')) {
      gaps.push({ rowId, reason: 'The active tool-subagent row does not expose literal provider, toolName, and backgroundMode values.' })
      continue
    }
    if (config['maxDepth'] === 0) {
      gaps.push({ rowId, reason: 'The active tool-subagent row sets maxDepth to 0, so its first delegation call cannot start.' })
      continue
    }
    const persona = config['persona']
    delegations.push({
      rowId,
      tool,
      provider,
      mode,
      configDigest: delegationConfigDigest(config),
      ...(typeof persona === 'string' && persona.trim().length > 0
        ? { persona: summarizeDelegationPersona(persona) }
        : {}),
      providerAvailable: providerNames.has(provider),
      enabled: toolNames.has(tool),
    })
  }
  return { delegations, gaps }
}

function summarizeDelegationPersona(persona: string): string {
  const compact = persona.trim().replace(/\s+/gu, ' ')
  return compact.length <= 160 ? compact : compact.slice(0, 159).trimEnd() + '…'
}

/** Set `tool-web.config.fetch` without reserializing the surrounding YAML. */
export function replaceWebFetch(composition: string, expected: boolean, enabled: boolean): string {
  return replaceBooleanConfig(composition, 'tool-web', 'fetch', expected, enabled, true)
}

/** Set one defaulted boolean config field without reserializing the surrounding YAML. */
export function replaceBooleanConfig(
  composition: string,
  rowId: string,
  field: string,
  expected: boolean,
  enabled: boolean,
  defaultValue: boolean,
): string {
  const newline = composition.includes('\r\n') ? '\r\n' : '\n'
  const trailing = composition.endsWith('\n')
  const lines = composition.split(/\r?\n/u)
  if (trailing) lines.pop()
  const escapedRowId = rowId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const rowPattern = new RegExp(`^\\s*-\\s+id:\\s*${escapedRowId}\\s*$`, 'u')
  const rowMatches = lines.flatMap((line, index) => rowPattern.test(line) ? [index] : [])
  if (rowMatches.length !== 1) {
    throw new Error(`blueprint-adapter: expected exactly one ${rowId} row, found ${String(rowMatches.length)}`)
  }
  const start = rowMatches[0] as number
  const rowIndent = /^\s*/u.exec(lines[start] ?? '')?.[0].length ?? 0
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim() === '') continue
    const indent = /^\s*/u.exec(line)?.[0].length ?? 0
    if (indent <= rowIndent && /^\s*-\s+id:/u.test(line)) {
      end = index
      break
    }
  }
  const fieldMatches: { index: number; value: boolean }[] = []
  let configIndex: number | undefined
  let configIndent = rowIndent + 2
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const fieldPattern = new RegExp(`^(\\s*)${escapedField}:\\s*(true|false)\\s*$`, 'u')
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index] ?? ''
    const config = /^(\s*)config:\s*$/u.exec(line)
    if (config !== null && configIndex === undefined) {
      configIndex = index
      configIndent = config[1]?.length ?? configIndent
    }
    const matchedField = fieldPattern.exec(line)
    if (matchedField !== null) fieldMatches.push({ index, value: matchedField[2] === 'true' })
  }
  if (fieldMatches.length > 1) {
    throw new Error(`blueprint-adapter: ${rowId} config contains duplicate ${field} fields`)
  }
  const current = fieldMatches[0]?.value ?? defaultValue
  if (current !== expected) {
    throw new Error(`blueprint-adapter: ${rowId}.${field} changed since projection (expected ${String(expected)}, found ${String(current)})`)
  }
  const rendered = enabled ? 'true' : 'false'
  const match = fieldMatches[0]
  if (match !== undefined) {
    const indent = /^\s*/u.exec(lines[match.index] ?? '')?.[0] ?? ''
    lines[match.index] = `${indent}${field}: ${rendered}`
  } else if (configIndex !== undefined) {
    lines.splice(configIndex + 1, 0, `${' '.repeat(configIndent + 2)}${field}: ${rendered}`)
  } else {
    lines.splice(end, 0, `${' '.repeat(rowIndent + 2)}config:`, `${' '.repeat(rowIndent + 4)}${field}: ${rendered}`)
  }
  return lines.join(newline) + (trailing ? newline : '')
}
