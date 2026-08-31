/** Isolated preset candidate storage and crash-recoverable verified directory publication. */

import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, readlink, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { COMPOSITION_FILE, type AgentPreset } from '@deepseek-ai/dsh-agent-presets'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import { assertCapabilityCompositionDelta, compositionRevision } from './composition.ts'
import type {
  BlueprintCapabilityCandidate,
  BlueprintCapabilityCandidateDisposition,
} from '../contract/types.ts'

/* jscpd:ignore-start -- frozen reader for already-durable .blueprint-capability
 * journals intentionally retains the pre-seam filesystem algorithm. New
 * lifecycles use AgentPresets transactions; changing this copy risks making a
 * parked legacy baseline unrecoverable before its compatibility horizon ends. */
const TRANSACTION_PREFIX = '.blueprint-capability-'
const JOURNAL_FILE = 'journal.json'
const SHA256 = /^[0-9a-f]{64}$/u

type CandidatePhase =
  | 'preparing'
  | 'active'
  | 'commit_prepared'
  | 'baseline_parked'
  | 'candidate_published'
  | 'discarded_pending_terminal'

interface CandidateIdentity {
  creatorSessionId: string
  sourceSessionId: string
  routeId: string
  targetPresetId: string
  baseRevision: string
}

interface CandidateJournal extends CandidateIdentity {
  version: 1
  transactionId: string
  targetPath: string
  targetDirectoryName: string
  baselineTreeDigest: string
  candidateTreeDigest?: string
  phase: CandidatePhase
}

interface CandidatePaths {
  transaction: string
  journal: string
  candidate: string
  baseline: string
  target: string
  compositionName: string
}

/** Result of reconstructing one durable candidate transaction after process interruption. */
export type CapabilityCandidateRecovery =
  | { state: 'active' }
  | { state: 'committed'; disposition: BlueprintCapabilityCandidateDisposition }
  | { state: 'discarded'; disposition: BlueprintCapabilityCandidateDisposition }

/** Capability-specific filesystem changes admitted before verified publication. */
export type CapabilityCandidateTreeDelta =
  | { kind: 'subagent'; rowId: string; configDigest: string }
  | { kind: 'skill'; skillName: string }

interface TreeEntry {
  kind: 'directory' | 'file'
  mode: number
  contentDigest?: string
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT'
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

function updateField(hash: ReturnType<typeof createHash>, value: string | Buffer): void {
  const bytes = typeof value === 'string' ? Buffer.from(value) : value
  hash.update(String(bytes.length)).update(':').update(bytes).update(';')
}

function contained(root: string, target: string): boolean {
  const offset = relative(root, target)
  return offset === '' || (!offset.startsWith(`..${sep}`) && offset !== '..' && !isAbsolute(offset))
}

function requireDigest(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`capability candidate: ${label} must be a SHA-256 digest`)
}

function validateTargetPath(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || basename(path) !== COMPOSITION_FILE) {
    throw new Error(`capability candidate: targetPath must be an absolute normalized ${COMPOSITION_FILE} path`)
  }
  const target = dirname(path)
  const root = dirname(target)
  if (target === root || basename(target).length === 0 || join(root, basename(target)) !== target) {
    throw new Error('capability candidate: targetPath must identify one direct preset child of its root')
  }
  return path
}

function validateCandidate(candidate: BlueprintCapabilityCandidate): void {
  requireDigest(candidate.transactionId, 'transactionId')
  requireDigest(candidate.baseRevision, 'baseRevision')
  requireDigest(candidate.baselineTreeDigest, 'baselineTreeDigest')
  validateTargetPath(candidate.targetPath)
}

async function digestEntry(
  hash: ReturnType<typeof createHash>,
  root: string,
  path: string,
  relativePath: string,
): Promise<void> {
  const stat = await lstat(path)
  const stableMode = process.platform === 'win32' ? 0 : stat.mode & 0o7777
  if (stat.isSymbolicLink()) {
    const link = await readlink(path)
    const linked = resolve(dirname(path), link)
    if (!contained(root, linked)) {
      throw new Error(`capability candidate: external symbolic link ${JSON.stringify(relativePath)} is not transaction-safe`)
    }
    updateField(hash, 'symlink')
    updateField(hash, relativePath)
    updateField(hash, String(stableMode))
    updateField(hash, link)
    return
  }
  if (stat.isDirectory()) {
    updateField(hash, 'directory')
    updateField(hash, relativePath)
    updateField(hash, String(stableMode))
    const entries = await readdir(path, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const childRelative = relativePath === '' ? entry.name : `${relativePath}/${entry.name}`
      await digestEntry(hash, root, join(path, entry.name), childRelative)
    }
    return
  }
  if (stat.isFile()) {
    if (stat.nlink !== 1) {
      throw new Error(`capability candidate: hard-linked file ${JSON.stringify(relativePath)} is not transaction-safe`)
    }
    const bytes = await readFile(path)
    updateField(hash, 'file')
    updateField(hash, relativePath)
    updateField(hash, String(stableMode))
    updateField(hash, bytes)
    return
  }
  throw new Error(`capability candidate: unsupported filesystem entry ${JSON.stringify(relativePath)}`)
}

/**
 * Digest a complete preset directory without following links or normalizing bytes.
 * @param directory - absolute preset directory.
 * @returns SHA-256 over sorted relative paths, entry types, stable modes, and contents.
 */
export async function capabilityPresetTreeDigest(directory: string): Promise<string> {
  if (!isAbsolute(directory)) throw new Error('capability candidate: preset directory must be absolute')
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('capability candidate: preset root must be a real directory')
  }
  const hash = createHash('sha256')
  await digestEntry(hash, directory, directory, '')
  return hash.digest('hex')
}

async function manifestEntry(
  manifest: Map<string, TreeEntry>,
  path: string,
  relativePath: string,
): Promise<void> {
  const stat = await lstat(path)
  const mode = process.platform === 'win32' ? 0 : stat.mode & 0o7777
  if (stat.isSymbolicLink()) {
    throw new Error(`capability candidate: symbolic link ${JSON.stringify(relativePath)} is outside the admitted capability delta`)
  }
  if (stat.isDirectory()) {
    manifest.set(relativePath, { kind: 'directory', mode })
    const entries = await readdir(path, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const childRelative = relativePath === '' ? entry.name : `${relativePath}/${entry.name}`
      await manifestEntry(manifest, join(path, entry.name), childRelative)
    }
    return
  }
  if (stat.isFile()) {
    if (stat.nlink !== 1) {
      throw new Error(`capability candidate: hard-linked file ${JSON.stringify(relativePath)} is outside the admitted capability delta`)
    }
    const contentDigest = createHash('sha256').update(await readFile(path)).digest('hex')
    manifest.set(relativePath, { kind: 'file', mode, contentDigest })
    return
  }
  throw new Error(`capability candidate: special entry ${JSON.stringify(relativePath)} is outside the admitted capability delta`)
}

async function treeManifest(directory: string): Promise<Map<string, TreeEntry>> {
  const manifest = new Map<string, TreeEntry>()
  await manifestEntry(manifest, directory, '')
  return manifest
}

function sameTreeEntry(left: TreeEntry, right: TreeEntry): boolean {
  return left.kind === right.kind && left.mode === right.mode && left.contentDigest === right.contentDigest
}

function transactionIdFor(identity: CandidateIdentity): string {
  return createHash('sha256').update(JSON.stringify([
    'blueprint-capability-candidate',
    identity.creatorSessionId,
    identity.sourceSessionId,
    identity.routeId,
    identity.targetPresetId,
    identity.baseRevision,
  ])).digest('hex')
}

function pathsFor(targetPath: string, transactionId: string): CandidatePaths {
  requireDigest(transactionId, 'transactionId')
  const normalizedTargetPath = validateTargetPath(targetPath)
  const target = dirname(normalizedTargetPath)
  const root = dirname(target)
  const transaction = join(root, `${TRANSACTION_PREFIX}${transactionId}`)
  const candidate = join(transaction, 'candidate')
  const baseline = join(transaction, 'baseline')
  if (dirname(transaction) !== root || !contained(root, transaction)
    || !contained(transaction, candidate) || !contained(transaction, baseline)) {
    throw new Error('capability candidate: transaction escaped the preset root')
  }
  return {
    transaction,
    journal: join(transaction, JOURNAL_FILE),
    candidate,
    baseline,
    target,
    compositionName: basename(normalizedTargetPath),
  }
}

function pathsForCandidate(candidate: BlueprintCapabilityCandidate): CandidatePaths {
  validateCandidate(candidate)
  return pathsFor(candidate.targetPath, candidate.transactionId)
}

async function writeJournal(path: string, journal: CandidateJournal): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
}

function parseJournal(value: unknown): CandidateJournal {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('capability candidate: journal must contain an object')
  }
  const record = value as Record<string, unknown>
  const phase = record['phase']
  const candidateDigestRequired = phase === 'commit_prepared' || phase === 'baseline_parked'
    || phase === 'candidate_published' || phase === 'discarded_pending_terminal'
  if (record['version'] !== 1 || typeof record['transactionId'] !== 'string'
    || typeof record['creatorSessionId'] !== 'string' || record['creatorSessionId'].length === 0
    || typeof record['sourceSessionId'] !== 'string' || record['sourceSessionId'].length === 0
    || typeof record['routeId'] !== 'string' || record['routeId'].length === 0
    || typeof record['targetPresetId'] !== 'string' || record['targetPresetId'].length === 0
    || typeof record['baseRevision'] !== 'string' || !SHA256.test(record['baseRevision'])
    || typeof record['targetPath'] !== 'string' || typeof record['targetDirectoryName'] !== 'string'
    || typeof record['baselineTreeDigest'] !== 'string' || !SHA256.test(record['baselineTreeDigest'])
    || !SHA256.test(record['transactionId'])
    || (candidateDigestRequired
      ? typeof record['candidateTreeDigest'] !== 'string' || !SHA256.test(record['candidateTreeDigest'])
      : record['candidateTreeDigest'] !== undefined)
    || (phase !== 'preparing' && phase !== 'active' && phase !== 'commit_prepared'
      && phase !== 'baseline_parked' && phase !== 'candidate_published'
      && phase !== 'discarded_pending_terminal')) {
    throw new Error('capability candidate: journal fields are invalid')
  }
  const targetPath = validateTargetPath(record['targetPath'])
  const targetDirectoryName = basename(dirname(targetPath))
  if (record['targetDirectoryName'] !== targetDirectoryName
    || record['targetPresetId'] !== targetDirectoryName) {
    throw new Error('capability candidate: journal target identity is invalid')
  }
  return record as unknown as CandidateJournal
}

async function readJournal(paths: CandidatePaths): Promise<CandidateJournal> {
  return parseJournal(JSON.parse(await readFile(paths.journal, 'utf8')) as unknown)
}

function assertJournal(journal: CandidateJournal, candidate: BlueprintCapabilityCandidate): void {
  if (journal.transactionId !== candidate.transactionId
    || journal.targetPath !== candidate.targetPath
    || journal.targetDirectoryName !== basename(dirname(candidate.targetPath))
    || journal.baseRevision !== candidate.baseRevision
    || journal.baselineTreeDigest !== candidate.baselineTreeDigest) {
    throw new Error('capability candidate: journal does not match the durable lifecycle')
  }
}

function assertIdentity(journal: CandidateJournal, identity: CandidateIdentity): void {
  if (journal.creatorSessionId !== identity.creatorSessionId
    || journal.sourceSessionId !== identity.sourceSessionId
    || journal.routeId !== identity.routeId
    || journal.targetPresetId !== identity.targetPresetId
    || journal.baseRevision !== identity.baseRevision) {
    throw new Error('capability candidate: existing transaction belongs to a different lifecycle')
  }
}

function assertPreset(preset: AgentPreset, candidate: BlueprintCapabilityCandidate): void {
  if (preset.trust !== 'user' || preset.id !== basename(dirname(candidate.targetPath))
    || resolve(preset.path) !== candidate.targetPath) {
    throw new Error('capability candidate: formal preset does not match the durable targetPath')
  }
}

function presetAt(preset: AgentPreset, path: string): AgentPreset {
  return {
    id: preset.id,
    trust: preset.trust,
    path,
    ...(preset.name === undefined ? {} : { name: preset.name }),
    ...(preset.description === undefined ? {} : { description: preset.description }),
    ...(preset.order === undefined ? {} : { order: preset.order }),
  }
}

async function assertTreeDigest(path: string, expected: string, label: string): Promise<void> {
  if (!await exists(path) || await capabilityPresetTreeDigest(path) !== expected) {
    throw new Error(`capability candidate: ${label} failed complete-tree CAS`)
  }
}

async function assertAbsent(path: string, label: string): Promise<void> {
  if (await exists(path)) throw new Error(`capability candidate: ${label} must be absent`)
}

async function assertCompositionRevision(
  directory: string,
  compositionName: string,
  revision: string,
): Promise<void> {
  const composition = await readFile(join(directory, compositionName), 'utf8')
  if (compositionRevision(composition) !== revision) {
    throw new Error('capability candidate: composition revision differs from the accepted route')
  }
}

function candidateFromJournal(journal: CandidateJournal): BlueprintCapabilityCandidate {
  return {
    version: 1,
    transactionId: journal.transactionId,
    targetPath: journal.targetPath,
    baseRevision: journal.baseRevision,
    baselineTreeDigest: journal.baselineTreeDigest,
  }
}

async function restorePreparingCandidate(
  paths: CandidatePaths,
  candidate: BlueprintCapabilityCandidate,
  journal: CandidateJournal,
): Promise<void> {
  await assertAbsent(paths.baseline, 'parked baseline during preparation')
  await assertTreeDigest(paths.target, candidate.baselineTreeDigest, 'formal baseline during preparation')
  await rm(paths.candidate, { recursive: true, force: true })
  await cp(paths.target, paths.candidate, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    preserveTimestamps: true,
    force: false,
    errorOnExist: true,
  })
  const [formalAfter, candidateDigest] = await Promise.all([
    capabilityPresetTreeDigest(paths.target), capabilityPresetTreeDigest(paths.candidate),
  ])
  if (formalAfter !== candidate.baselineTreeDigest || candidateDigest !== candidate.baselineTreeDigest) {
    throw new Error('capability candidate: baseline changed while the isolated clone was prepared')
  }
  await assertCompositionRevision(paths.candidate, paths.compositionName, candidate.baseRevision)
  await writeJournal(paths.journal, { ...journal, phase: 'active' })
}

async function commitFromJournal(
  candidate: BlueprintCapabilityCandidate,
  candidateTreeDigest: string,
): Promise<BlueprintCapabilityCandidateDisposition> {
  requireDigest(candidateTreeDigest, 'candidateTreeDigest')
  const paths = pathsForCandidate(candidate)
  let journal = await readJournal(paths)
  assertJournal(journal, candidate)
  if (journal.phase === 'preparing' || journal.phase === 'discarded_pending_terminal') {
    throw new Error('capability candidate: transaction is not publishable')
  }
  if (journal.phase === 'active') {
    await assertTreeDigest(paths.target, candidate.baselineTreeDigest, 'formal baseline before commit')
    await assertAbsent(paths.baseline, 'parked baseline before commit')
    await assertTreeDigest(paths.candidate, candidateTreeDigest, 'verified candidate before commit')
    journal = { ...journal, phase: 'commit_prepared', candidateTreeDigest }
    await writeJournal(paths.journal, journal)
  } else if (journal.candidateTreeDigest !== candidateTreeDigest) {
    throw new Error('capability candidate: commit digest differs from the journaled verified candidate')
  }

  if (journal.phase === 'commit_prepared') {
    await assertTreeDigest(paths.candidate, candidateTreeDigest, 'verified candidate before baseline parking')
    if (await exists(paths.target)) {
      await assertAbsent(paths.baseline, 'parked baseline before baseline parking')
      await assertTreeDigest(paths.target, candidate.baselineTreeDigest, 'formal baseline before baseline parking')
      await rename(paths.target, paths.baseline)
    } else {
      await assertTreeDigest(paths.baseline, candidate.baselineTreeDigest, 'parked baseline after interrupted rename')
    }
    journal = { ...journal, phase: 'baseline_parked' }
    await writeJournal(paths.journal, journal)
  }

  if (journal.phase === 'baseline_parked') {
    await assertTreeDigest(paths.baseline, candidate.baselineTreeDigest, 'parked baseline before publication')
    if (await exists(paths.target)) {
      await assertAbsent(paths.candidate, 'candidate after interrupted publication')
      await assertTreeDigest(paths.target, candidateTreeDigest, 'published target after interrupted publication')
    } else {
      await assertTreeDigest(paths.candidate, candidateTreeDigest, 'verified candidate before publication')
      await rename(paths.candidate, paths.target)
    }
    journal = { ...journal, phase: 'candidate_published' }
    await writeJournal(paths.journal, journal)
  }

  if (journal.phase !== 'candidate_published' || journal.candidateTreeDigest !== candidateTreeDigest) {
    throw new Error('capability candidate: publication journal did not settle')
  }
  await assertTreeDigest(paths.target, candidateTreeDigest, 'published candidate')
  await assertTreeDigest(paths.baseline, candidate.baselineTreeDigest, 'retained baseline')
  await assertAbsent(paths.candidate, 'candidate after publication')
  return {
    transactionId: candidate.transactionId,
    candidateTreeDigest,
    finalTreeDigest: candidateTreeDigest,
    disposition: 'committed',
  }
}

async function discardFromJournal(
  candidate: BlueprintCapabilityCandidate,
  candidateTreeDigest: string,
): Promise<BlueprintCapabilityCandidateDisposition> {
  requireDigest(candidateTreeDigest, 'candidateTreeDigest')
  const paths = pathsForCandidate(candidate)
  let journal = await readJournal(paths)
  assertJournal(journal, candidate)
  if (journal.phase !== 'active' && journal.phase !== 'commit_prepared'
    && journal.phase !== 'discarded_pending_terminal') {
    throw new Error('capability candidate: a publishing candidate cannot be discarded')
  }
  if ((journal.phase === 'commit_prepared' || journal.phase === 'discarded_pending_terminal')
    && journal.candidateTreeDigest !== candidateTreeDigest) {
    throw new Error('capability candidate: discard digest differs from the journaled candidate')
  }
  await assertTreeDigest(paths.target, candidate.baselineTreeDigest, 'formal baseline before discard')
  await assertAbsent(paths.baseline, 'parked baseline before discard')
  await assertTreeDigest(paths.candidate, candidateTreeDigest, 'discarded candidate')
  if (journal.phase === 'active' || journal.phase === 'commit_prepared') {
    journal = { ...journal, phase: 'discarded_pending_terminal', candidateTreeDigest }
    await writeJournal(paths.journal, journal)
  }
  return {
    transactionId: candidate.transactionId,
    candidateTreeDigest,
    finalTreeDigest: candidate.baselineTreeDigest,
    disposition: 'discarded',
  }
}

/**
 * Clone the committed preset into a hidden sibling candidate without changing the formal tree.
 * @param preset - writable formal preset selected by the source route.
 * @param identity - durable route and Creator identity.
 * @returns reference stored in the capability lifecycle start event.
 */
export async function prepareCapabilityCandidate(
  preset: AgentPreset,
  identity: CandidateIdentity,
): Promise<BlueprintCapabilityCandidate> {
  if (preset.trust !== 'user' || preset.id !== identity.targetPresetId
    || basename(dirname(resolve(preset.path))) !== preset.id
    || [identity.creatorSessionId, identity.sourceSessionId, identity.routeId].some(value => value.length === 0)) {
    throw new Error('capability candidate: target and lifecycle identity must name the selected writable user preset')
  }
  requireDigest(identity.baseRevision, 'baseRevision')
  const targetPath = validateTargetPath(resolve(preset.path))
  const transactionId = transactionIdFor(identity)
  const paths = pathsFor(targetPath, transactionId)
  if (await exists(paths.transaction)) {
    if (!await exists(paths.journal)) {
      if (await exists(paths.candidate) || await exists(paths.baseline) || !await exists(paths.target)) {
        throw new Error('capability candidate: journal-less transaction contains authoritative tree data')
      }
      await rm(paths.transaction, { recursive: true, force: true })
      return await prepareCapabilityCandidate(preset, identity)
    }
    const journal = await readJournal(paths)
    assertIdentity(journal, identity)
    const candidate = candidateFromJournal(journal)
    const recovery = await recoverCapabilityCandidate(candidate)
    if (recovery.state !== 'active') {
      throw new Error('capability candidate: existing transaction has already entered terminal settlement')
    }
    return candidate
  }

  const baselineTreeDigest = await capabilityPresetTreeDigest(paths.target)
  await assertCompositionRevision(paths.target, paths.compositionName, identity.baseRevision)
  await mkdir(paths.transaction, { mode: 0o700 })
  const journal: CandidateJournal = {
    version: 1,
    transactionId,
    creatorSessionId: identity.creatorSessionId,
    sourceSessionId: identity.sourceSessionId,
    routeId: identity.routeId,
    targetPresetId: identity.targetPresetId,
    targetPath,
    targetDirectoryName: basename(paths.target),
    baseRevision: identity.baseRevision,
    baselineTreeDigest,
    phase: 'preparing',
  }
  await writeJournal(paths.journal, journal)
  const candidate = candidateFromJournal(journal)
  const recovery = await recoverCapabilityCandidate(candidate)
  if (recovery.state !== 'active') {
    throw new Error('capability candidate: newly prepared transaction did not become active')
  }
  return candidate
}

/**
 * Recover a durable candidate by its absolute target path even while the formal directory is parked.
 * @param candidate - durable transaction handle from the lifecycle start event.
 * @returns active editing state or the idempotently completed terminal disposition.
 */
export async function recoverCapabilityCandidate(
  candidate: BlueprintCapabilityCandidate,
): Promise<CapabilityCandidateRecovery> {
  const paths = pathsForCandidate(candidate)
  const journal = await readJournal(paths)
  assertJournal(journal, candidate)
  if (journal.phase === 'preparing') {
    await restorePreparingCandidate(paths, candidate, journal)
    return { state: 'active' }
  }
  if (journal.phase === 'active') {
    await assertTreeDigest(paths.target, candidate.baselineTreeDigest, 'formal baseline during active recovery')
    await assertAbsent(paths.baseline, 'parked baseline during active recovery')
    await capabilityPresetTreeDigest(paths.candidate)
    return { state: 'active' }
  }
  if (journal.phase === 'discarded_pending_terminal') {
    const candidateTreeDigest = journal.candidateTreeDigest
    /* v8 ignore next -- parseJournal requires this digest for every terminal phase */
    if (candidateTreeDigest === undefined) throw new Error('capability candidate: discarded journal lacks its digest')
    return { state: 'discarded', disposition: await discardFromJournal(candidate, candidateTreeDigest) }
  }
  const candidateTreeDigest = journal.candidateTreeDigest
  /* v8 ignore next -- parseJournal requires this digest for every commit phase */
  if (candidateTreeDigest === undefined) throw new Error('capability candidate: commit journal lacks its digest')
  return { state: 'committed', disposition: await commitFromJournal(candidate, candidateTreeDigest) }
}

/**
 * Resolve the candidate as the target id for a Creator-scoped roster overlay.
 * @param preset - current formal preset metadata.
 * @param candidate - durable candidate reference.
 * @returns AgentPreset with only its composition path redirected.
 */
export async function resolveCapabilityCandidatePreset(
  preset: AgentPreset,
  candidate: BlueprintCapabilityCandidate,
): Promise<AgentPreset> {
  assertPreset(preset, candidate)
  const paths = pathsForCandidate(candidate)
  const journal = await readJournal(paths)
  assertJournal(journal, candidate)
  if (journal.phase === 'candidate_published') return presetAt(preset, candidate.targetPath)
  if (journal.phase !== 'active') {
    throw new Error('capability candidate: candidate is not addressable while settlement is in progress')
  }
  if (!await exists(paths.candidate)) throw new Error('capability candidate: isolated candidate directory is missing')
  return presetAt(preset, join(paths.candidate, paths.compositionName))
}

/**
 * Fence one quiescent candidate before validation or publication.
 * @param preset - current formal preset metadata.
 * @param candidate - durable candidate reference.
 * @returns stable complete-tree digest.
 */
export async function fenceCapabilityCandidate(
  preset: AgentPreset,
  candidate: BlueprintCapabilityCandidate,
): Promise<string> {
  assertPreset(preset, candidate)
  const paths = pathsForCandidate(candidate)
  const journal = await readJournal(paths)
  assertJournal(journal, candidate)
  if (journal.phase !== 'active') throw new Error('capability candidate: candidate is not editable')
  const first = await capabilityPresetTreeDigest(paths.candidate)
  const second = await capabilityPresetTreeDigest(paths.candidate)
  if (first !== second) throw new Error('capability candidate: candidate changed while it was fenced')
  return first
}

/* jscpd:ignore-end */

/**
 * Prove a verified candidate changed only files admitted for its capability kind.
 * @param preset - unchanged formal preset providing the baseline tree.
 * @param candidate - active durable candidate reference.
 * @param candidateTreeDigest - digest retained across fresh runtime verification.
 * @param expected - Subagent or Skill delta, including the verified new Skill name.
 */
export async function assertCapabilityCandidateTreeDelta(
  preset: AgentPreset,
  candidate: BlueprintCapabilityCandidate,
  candidateTreeDigest: string,
  expected: CapabilityCandidateTreeDelta,
): Promise<void> {
  assertPreset(preset, candidate)
  const paths = pathsForCandidate(candidate)
  const journal = await readJournal(paths)
  assertJournal(journal, candidate)
  if (journal.phase !== 'active') throw new Error('capability candidate: tree delta requires an active candidate')
  await assertCapabilityPresetTreeDelta(
    preset,
    presetAt(preset, join(paths.candidate, paths.compositionName)),
    candidate,
    candidateTreeDigest,
    expected,
  )
}

/**
 * Prove a projected candidate changed only files admitted by one capability request.
 *
 * The candidate path comes from the AgentPresets transaction service; this
 * adapter owns only Skill/Subagent policy and never derives generic transaction
 * storage paths for newly-created lifecycles.
 * @param preset - unchanged committed preset providing the baseline tree.
 * @param candidatePreset - isolated preset projection returned by AgentPresets.
 * @param transaction - durable transaction evidence retained by the lifecycle.
 * @param candidateTreeDigest - digest retained across fresh runtime verification.
 * @param expected - Subagent or Skill delta supported by verified runtime evidence.
 */
export async function assertCapabilityPresetTreeDelta(
  preset: AgentPreset,
  candidatePreset: AgentPreset,
  transaction: BlueprintCapabilityCandidate,
  candidateTreeDigest: string,
  expected: CapabilityCandidateTreeDelta,
): Promise<void> {
  assertPreset(preset, transaction)
  requireDigest(candidateTreeDigest, 'candidateTreeDigest')
  if (candidatePreset.id !== preset.id || candidatePreset.trust !== preset.trust
    || basename(candidatePreset.path) !== basename(preset.path)) {
    throw new Error('capability candidate: projected preset does not match the committed target')
  }
  if (expected.kind === 'skill' && !isSkillName(expected.skillName)) {
    throw new Error('capability candidate: verified Skill name is invalid')
  }
  const target = dirname(preset.path)
  const authoredDirectory = dirname(candidatePreset.path)
  const compositionName = basename(preset.path)
  await assertTreeDigest(target, transaction.baselineTreeDigest, 'formal baseline before delta proof')
  await assertTreeDigest(authoredDirectory, candidateTreeDigest, 'verified candidate before delta proof')
  const [baseline, authored] = await Promise.all([
    treeManifest(target), treeManifest(authoredDirectory),
  ])
  await assertTreeDigest(target, transaction.baselineTreeDigest, 'formal baseline after delta proof')
  await assertTreeDigest(authoredDirectory, candidateTreeDigest, 'verified candidate after delta proof')
  const [baselineComposition, candidateComposition] = await Promise.all([
    readFile(join(target, compositionName), 'utf8'),
    readFile(join(authoredDirectory, compositionName), 'utf8'),
  ])
  const compositionDelta = assertCapabilityCompositionDelta(
    baselineComposition,
    candidateComposition,
    expected.kind,
  )
  if (expected.kind === 'subagent' && (compositionDelta.kind !== 'subagent'
    || compositionDelta.rowId !== expected.rowId || compositionDelta.configDigest !== expected.configDigest)) {
    throw new Error('capability candidate: Subagent composition differs from verified delegation evidence')
  }

  for (const [path, baselineEntry] of baseline) {
    const authoredEntry = authored.get(path)
    if (authoredEntry === undefined) {
      throw new Error(`capability candidate: baseline entry ${JSON.stringify(path)} was removed`)
    }
    if (path === compositionName) {
      if (baselineEntry.kind !== 'file' || authoredEntry.kind !== 'file'
        || baselineEntry.mode !== authoredEntry.mode) {
        throw new Error('capability candidate: composition entry type or mode changed')
      }
    } else if (!sameTreeEntry(baselineEntry, authoredEntry)) {
      throw new Error(`capability candidate: baseline entry ${JSON.stringify(path)} changed outside the admitted delta`)
    }
  }

  const added = [...authored.keys()].filter(path => !baseline.has(path))
  if (expected.kind === 'subagent') {
    if (added.length > 0) {
      throw new Error(`capability candidate: Subagent authoring added ${JSON.stringify(added[0])}`)
    }
    return
  }

  const skillRoot = `skills/${expected.skillName}`
  if (baseline.has(skillRoot) || authored.get(skillRoot)?.kind !== 'directory'
    || authored.get(`${skillRoot}/SKILL.md`)?.kind !== 'file') {
    throw new Error('capability candidate: Skill authoring must add one new Skill directory with SKILL.md')
  }
  for (const path of added) {
    const allowedContainer = path === 'skills' && authored.get(path)?.kind === 'directory'
    if (!allowedContainer && path !== skillRoot && !path.startsWith(`${skillRoot}/`)) {
      throw new Error(`capability candidate: Skill authoring added ${JSON.stringify(path)} outside its new subtree`)
    }
  }
}

/**
 * Atomically replace the unchanged formal tree with a verified isolated candidate.
 * @param preset - formal preset whose tree must still equal the baseline.
 * @param candidate - durable candidate reference.
 * @param candidateTreeDigest - digest retained across fresh verification.
 * @returns terminal publication evidence; cleanup must wait for the durable terminal.
 */
export async function commitCapabilityCandidate(
  preset: AgentPreset,
  candidate: BlueprintCapabilityCandidate,
  candidateTreeDigest: string,
): Promise<BlueprintCapabilityCandidateDisposition> {
  assertPreset(preset, candidate)
  return await commitFromJournal(candidate, candidateTreeDigest)
}

/**
 * Mark an exhausted or cancelled candidate for deletion while proving the formal tree stayed unchanged.
 * A commit-prepared candidate remains discardable only before baseline parking moves any formal data.
 * @param preset - formal preset that must still be the accepted baseline.
 * @param candidate - durable candidate reference.
 * @param candidateTreeDigest - last stable candidate digest.
 * @returns terminal evidence proving no candidate publication occurred.
 */
export async function discardCapabilityCandidate(
  preset: AgentPreset,
  candidate: BlueprintCapabilityCandidate,
  candidateTreeDigest: string,
): Promise<BlueprintCapabilityCandidateDisposition> {
  assertPreset(preset, candidate)
  return await discardFromJournal(candidate, candidateTreeDigest)
}

/**
 * Remove hidden candidate/baseline data only after its terminal is durable.
 * @param preset - settled formal preset.
 * @param candidate - durable transaction reference.
 */
export async function cleanupCapabilityCandidate(
  preset: AgentPreset,
  candidate: BlueprintCapabilityCandidate,
): Promise<void> {
  assertPreset(preset, candidate)
  const paths = pathsForCandidate(candidate)
  if (!await exists(paths.transaction)) return
  if (!await exists(paths.journal)) {
    if (!await exists(paths.target)) throw new Error('capability candidate: cleanup cannot remove the only remaining tree')
    await rm(paths.transaction, { recursive: true, force: true })
    return
  }
  const journal = await readJournal(paths)
  assertJournal(journal, candidate)
  if (journal.phase !== 'candidate_published' && journal.phase !== 'discarded_pending_terminal') {
    throw new Error('capability candidate: cleanup requires a settled transaction')
  }
  await rm(paths.transaction, { recursive: true, force: true })
}
