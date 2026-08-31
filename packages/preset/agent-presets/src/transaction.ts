/** Crash-recoverable isolated transactions for one writable agent preset. */

import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, readlink, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { COMPOSITION_FILE } from './discovery.ts'
import type { AgentPreset } from './preset.ts'

const TRANSACTION_PREFIX = '.agent-preset-transaction-'
const JOURNAL_FILE = 'journal.json'
const SHA256 = /^[0-9a-f]{64}$/u

type TransactionPhase =
  | 'preparing'
  | 'active'
  | 'publish_prepared'
  | 'baseline_parked'
  | 'candidate_published'
  | 'discarded_pending_terminal'

interface TransactionJournal {
  version: 1
  transactionId: string
  presetId: string
  targetPath: string
  targetDirectoryName: string
  baseRevision: string
  baselineTreeDigest: string
  candidateTreeDigest?: string
  phase: TransactionPhase
}

interface TransactionPaths {
  transaction: string
  journal: string
  candidate: string
  baseline: string
  target: string
  compositionName: string
}

/** Options that deterministically adopt or prepare one isolated transaction. */
export interface AgentPresetTransactionOptions {
  /** Stable caller-owned identity for retry and restart adoption. */
  key: string
  /** SHA-256 revision of the committed composition accepted by the caller. */
  expectedRevision: string
}

/** Durable reference to one isolated preset transaction. */
export interface AgentPresetTransaction {
  /** Transaction storage format. */
  readonly version: 1
  /** Domain-separated transaction identity. */
  readonly transactionId: string
  /** Absolute path of the committed preset composition. */
  readonly targetPath: string
  /** Committed composition revision accepted at preparation. */
  readonly baseRevision: string
  /** Complete committed tree digest accepted at preparation. */
  readonly baselineTreeDigest: string
}

/** Complete-tree evidence from publication or safe discard. */
export interface AgentPresetTransactionDisposition {
  /** Settled transaction identity. */
  readonly transactionId: string
  /** Candidate tree retained across validation and settlement. */
  readonly candidateTreeDigest: string
  /** Committed tree after settlement. */
  readonly finalTreeDigest: string
  /** Whether settlement published the candidate. */
  readonly disposition: 'committed' | 'discarded'
}

/** State reconstructed from an isolated transaction journal. */
export type AgentPresetTransactionRecovery =
  | { state: 'active' }
  | { state: 'committed'; disposition: AgentPresetTransactionDisposition }
  | { state: 'discarded'; disposition: AgentPresetTransactionDisposition }

/** Raised when a durable handle does not identify this transaction vocabulary. */
export class AgentPresetTransactionNotFoundError extends Error {
  /** Create an error for one missing transaction. */
  constructor(transactionId: string) {
    super(`agent-presets: transaction ${JSON.stringify(transactionId)} was not found`)
    this.name = 'AgentPresetTransactionNotFoundError'
  }
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
  if (!SHA256.test(value)) throw new Error(`agent-presets: ${label} must be a SHA-256 digest`)
}

function validateTargetPath(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || basename(path) !== COMPOSITION_FILE) {
    throw new Error(`agent-presets: transaction targetPath must be an absolute normalized ${COMPOSITION_FILE} path`)
  }
  const target = dirname(path)
  const root = dirname(target)
  if (target === root || basename(target).length === 0 || join(root, basename(target)) !== target) {
    throw new Error('agent-presets: transaction targetPath must identify one direct preset child of its root')
  }
  return path
}

function validateTransaction(transaction: AgentPresetTransaction): void {
  if (transaction.version !== 1) throw new Error('agent-presets: unsupported transaction version')
  requireDigest(transaction.transactionId, 'transactionId')
  requireDigest(transaction.baseRevision, 'baseRevision')
  requireDigest(transaction.baselineTreeDigest, 'baselineTreeDigest')
  validateTargetPath(transaction.targetPath)
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
      throw new Error(`agent-presets: external symbolic link ${JSON.stringify(relativePath)} is not transaction-safe`)
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
      throw new Error(`agent-presets: hard-linked file ${JSON.stringify(relativePath)} is not transaction-safe`)
    }
    updateField(hash, 'file')
    updateField(hash, relativePath)
    updateField(hash, String(stableMode))
    updateField(hash, await readFile(path))
    return
  }
  throw new Error(`agent-presets: unsupported transaction entry ${JSON.stringify(relativePath)}`)
}

/**
 * Digest one complete preset tree without following links or normalizing bytes.
 * @param directory - absolute preset directory.
 * @returns SHA-256 over sorted paths, entry types, stable modes, and contents.
 */
export async function agentPresetTreeDigest(directory: string): Promise<string> {
  if (!isAbsolute(directory)) throw new Error('agent-presets: preset directory must be absolute')
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('agent-presets: preset transaction root must be a real directory')
  }
  const hash = createHash('sha256')
  await digestEntry(hash, directory, directory, '')
  return hash.digest('hex')
}

function compositionRevision(composition: string): string {
  return createHash('sha256').update(composition).digest('hex')
}

function transactionIdFor(preset: AgentPreset, options: AgentPresetTransactionOptions): string {
  return createHash('sha256').update(JSON.stringify([
    'agent-preset-transaction',
    options.key,
    preset.id,
    options.expectedRevision,
    resolve(preset.path),
  ])).digest('hex')
}

function pathsFor(targetPath: string, transactionId: string): TransactionPaths {
  requireDigest(transactionId, 'transactionId')
  const normalizedTargetPath = validateTargetPath(targetPath)
  const target = dirname(normalizedTargetPath)
  const root = dirname(target)
  const transaction = join(root, `${TRANSACTION_PREFIX}${transactionId}`)
  const candidate = join(transaction, 'candidate')
  const baseline = join(transaction, 'baseline')
  if (dirname(transaction) !== root || !contained(root, transaction)
    || !contained(transaction, candidate) || !contained(transaction, baseline)) {
    throw new Error('agent-presets: transaction escaped the preset root')
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

function pathsForTransaction(transaction: AgentPresetTransaction): TransactionPaths {
  validateTransaction(transaction)
  return pathsFor(transaction.targetPath, transaction.transactionId)
}

async function writeJournal(path: string, journal: TransactionJournal): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
}

function parseJournal(value: unknown): TransactionJournal {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('agent-presets: transaction journal must contain an object')
  }
  const record = value as Record<string, unknown>
  const phase = record['phase']
  const candidateDigestRequired = phase === 'publish_prepared' || phase === 'baseline_parked'
    || phase === 'candidate_published' || phase === 'discarded_pending_terminal'
  if (record['version'] !== 1 || typeof record['transactionId'] !== 'string'
    || typeof record['presetId'] !== 'string' || record['presetId'].length === 0
    || typeof record['baseRevision'] !== 'string' || !SHA256.test(record['baseRevision'])
    || typeof record['targetPath'] !== 'string' || typeof record['targetDirectoryName'] !== 'string'
    || typeof record['baselineTreeDigest'] !== 'string' || !SHA256.test(record['baselineTreeDigest'])
    || !SHA256.test(record['transactionId'])
    || (candidateDigestRequired
      ? typeof record['candidateTreeDigest'] !== 'string' || !SHA256.test(record['candidateTreeDigest'])
      : record['candidateTreeDigest'] !== undefined)
    || (phase !== 'preparing' && phase !== 'active' && phase !== 'publish_prepared'
      && phase !== 'baseline_parked' && phase !== 'candidate_published'
      && phase !== 'discarded_pending_terminal')) {
    throw new Error('agent-presets: transaction journal fields are invalid')
  }
  const targetPath = validateTargetPath(record['targetPath'])
  const targetDirectoryName = basename(dirname(targetPath))
  if (record['targetDirectoryName'] !== targetDirectoryName || record['presetId'] !== targetDirectoryName) {
    throw new Error('agent-presets: transaction journal target identity is invalid')
  }
  return record as unknown as TransactionJournal
}

async function readJournal(paths: TransactionPaths, transactionId: string): Promise<TransactionJournal> {
  try {
    return parseJournal(JSON.parse(await readFile(paths.journal, 'utf8')) as unknown)
  } catch (error) {
    if (isMissing(error)) throw new AgentPresetTransactionNotFoundError(transactionId)
    throw error
  }
}

function assertJournal(journal: TransactionJournal, transaction: AgentPresetTransaction): void {
  if (journal.transactionId !== transaction.transactionId
    || journal.targetPath !== transaction.targetPath
    || journal.targetDirectoryName !== basename(dirname(transaction.targetPath))
    || journal.baseRevision !== transaction.baseRevision
    || journal.baselineTreeDigest !== transaction.baselineTreeDigest) {
    throw new Error('agent-presets: transaction journal does not match its durable handle')
  }
}

function assertPreset(preset: AgentPreset, transaction: AgentPresetTransaction): void {
  if (preset.trust !== 'user' || preset.id !== basename(dirname(transaction.targetPath))
    || resolve(preset.path) !== transaction.targetPath) {
    throw new Error('agent-presets: writable preset does not match the transaction target')
  }
}

function presetAt(preset: AgentPreset, path: string): AgentPreset {
  return { ...preset, path }
}

async function assertTreeDigest(path: string, expected: string, label: string): Promise<void> {
  if (!await exists(path) || await agentPresetTreeDigest(path) !== expected) {
    throw new Error(`agent-presets: ${label} failed complete-tree CAS`)
  }
}

async function assertAbsent(path: string, label: string): Promise<void> {
  if (await exists(path)) throw new Error(`agent-presets: ${label} must be absent`)
}

async function assertCompositionRevision(
  directory: string,
  compositionName: string,
  revision: string,
): Promise<void> {
  if (compositionRevision(await readFile(join(directory, compositionName), 'utf8')) !== revision) {
    throw new Error('agent-presets: committed composition differs from the expected revision')
  }
}

function transactionFromJournal(journal: TransactionJournal): AgentPresetTransaction {
  return {
    version: 1,
    transactionId: journal.transactionId,
    targetPath: journal.targetPath,
    baseRevision: journal.baseRevision,
    baselineTreeDigest: journal.baselineTreeDigest,
  }
}

async function restorePreparing(
  paths: TransactionPaths,
  transaction: AgentPresetTransaction,
  journal: TransactionJournal,
): Promise<void> {
  await assertAbsent(paths.baseline, 'parked baseline during preparation')
  await assertTreeDigest(paths.target, transaction.baselineTreeDigest, 'committed baseline during preparation')
  await rm(paths.candidate, { recursive: true, force: true })
  await cp(paths.target, paths.candidate, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    preserveTimestamps: true,
    force: false,
    errorOnExist: true,
  })
  const [committedAfter, candidateDigest] = await Promise.all([
    agentPresetTreeDigest(paths.target), agentPresetTreeDigest(paths.candidate),
  ])
  if (committedAfter !== transaction.baselineTreeDigest || candidateDigest !== transaction.baselineTreeDigest) {
    throw new Error('agent-presets: baseline changed while the isolated transaction was prepared')
  }
  await assertCompositionRevision(paths.candidate, paths.compositionName, transaction.baseRevision)
  await writeJournal(paths.journal, { ...journal, phase: 'active' })
}

async function publishFromJournal(
  transaction: AgentPresetTransaction,
  candidateTreeDigest: string,
): Promise<AgentPresetTransactionDisposition> {
  requireDigest(candidateTreeDigest, 'candidateTreeDigest')
  const paths = pathsForTransaction(transaction)
  let journal = await readJournal(paths, transaction.transactionId)
  assertJournal(journal, transaction)
  if (journal.phase === 'preparing' || journal.phase === 'discarded_pending_terminal') {
    throw new Error('agent-presets: transaction is not publishable')
  }
  if (journal.phase === 'active') {
    await assertTreeDigest(paths.target, transaction.baselineTreeDigest, 'committed baseline before publication')
    await assertAbsent(paths.baseline, 'parked baseline before publication')
    await assertTreeDigest(paths.candidate, candidateTreeDigest, 'validated candidate before publication')
    journal = { ...journal, phase: 'publish_prepared', candidateTreeDigest }
    await writeJournal(paths.journal, journal)
  } else if (journal.candidateTreeDigest !== candidateTreeDigest) {
    throw new Error('agent-presets: publication digest differs from the journaled candidate')
  }

  if (journal.phase === 'publish_prepared') {
    await assertTreeDigest(paths.candidate, candidateTreeDigest, 'validated candidate before baseline parking')
    if (await exists(paths.target)) {
      await assertAbsent(paths.baseline, 'parked baseline before baseline parking')
      await assertTreeDigest(paths.target, transaction.baselineTreeDigest, 'committed baseline before baseline parking')
      await rename(paths.target, paths.baseline)
    } else {
      await assertTreeDigest(paths.baseline, transaction.baselineTreeDigest, 'parked baseline after interrupted rename')
    }
    journal = { ...journal, phase: 'baseline_parked' }
    await writeJournal(paths.journal, journal)
  }

  if (journal.phase === 'baseline_parked') {
    await assertTreeDigest(paths.baseline, transaction.baselineTreeDigest, 'parked baseline before publication')
    if (await exists(paths.target)) {
      await assertAbsent(paths.candidate, 'candidate after interrupted publication')
      await assertTreeDigest(paths.target, candidateTreeDigest, 'committed target after interrupted publication')
    } else {
      await assertTreeDigest(paths.candidate, candidateTreeDigest, 'validated candidate before publication')
      await rename(paths.candidate, paths.target)
    }
    journal = { ...journal, phase: 'candidate_published' }
    await writeJournal(paths.journal, journal)
  }

  if (journal.phase !== 'candidate_published' || journal.candidateTreeDigest !== candidateTreeDigest) {
    throw new Error('agent-presets: publication journal did not settle')
  }
  await assertTreeDigest(paths.target, candidateTreeDigest, 'published candidate')
  await assertTreeDigest(paths.baseline, transaction.baselineTreeDigest, 'retained baseline')
  await assertAbsent(paths.candidate, 'candidate after publication')
  return {
    transactionId: transaction.transactionId,
    candidateTreeDigest,
    finalTreeDigest: candidateTreeDigest,
    disposition: 'committed',
  }
}

async function discardFromJournal(
  transaction: AgentPresetTransaction,
  candidateTreeDigest: string,
): Promise<AgentPresetTransactionDisposition> {
  requireDigest(candidateTreeDigest, 'candidateTreeDigest')
  const paths = pathsForTransaction(transaction)
  let journal = await readJournal(paths, transaction.transactionId)
  assertJournal(journal, transaction)
  if (journal.phase !== 'active' && journal.phase !== 'publish_prepared'
    && journal.phase !== 'discarded_pending_terminal') {
    throw new Error('agent-presets: a publishing transaction cannot be discarded')
  }
  if ((journal.phase === 'publish_prepared' || journal.phase === 'discarded_pending_terminal')
    && journal.candidateTreeDigest !== candidateTreeDigest) {
    throw new Error('agent-presets: discard digest differs from the journaled candidate')
  }
  await assertTreeDigest(paths.target, transaction.baselineTreeDigest, 'committed baseline before discard')
  await assertAbsent(paths.baseline, 'parked baseline before discard')
  await assertTreeDigest(paths.candidate, candidateTreeDigest, 'discarded candidate')
  if (journal.phase === 'active' || journal.phase === 'publish_prepared') {
    journal = { ...journal, phase: 'discarded_pending_terminal', candidateTreeDigest }
    await writeJournal(paths.journal, journal)
  }
  return {
    transactionId: transaction.transactionId,
    candidateTreeDigest,
    finalTreeDigest: transaction.baselineTreeDigest,
    disposition: 'discarded',
  }
}

/**
 * Prepare or re-adopt one isolated transaction for a writable preset.
 * @param preset - committed writable preset to clone.
 * @param options - stable request key and accepted composition revision.
 * @returns durable isolated transaction handle.
 */
export async function prepareAgentPresetTransaction(
  preset: AgentPreset,
  options: AgentPresetTransactionOptions,
): Promise<AgentPresetTransaction> {
  if (preset.trust !== 'user' || basename(dirname(resolve(preset.path))) !== preset.id || options.key.length === 0) {
    throw new Error('agent-presets: transaction requires a writable preset and a non-empty stable key')
  }
  requireDigest(options.expectedRevision, 'expectedRevision')
  const targetPath = validateTargetPath(resolve(preset.path))
  const transactionId = transactionIdFor(preset, options)
  const paths = pathsFor(targetPath, transactionId)
  if (await exists(paths.transaction)) {
    if (!await exists(paths.journal)) {
      if (await exists(paths.candidate) || await exists(paths.baseline) || !await exists(paths.target)) {
        throw new Error('agent-presets: journal-less transaction contains authoritative tree data')
      }
      await rm(paths.transaction, { recursive: true, force: true })
      return await prepareAgentPresetTransaction(preset, options)
    }
    const journal = await readJournal(paths, transactionId)
    if (journal.presetId !== preset.id || journal.baseRevision !== options.expectedRevision) {
      throw new Error('agent-presets: existing transaction belongs to a different request')
    }
    const transaction = transactionFromJournal(journal)
    const recovery = await recoverAgentPresetTransaction(transaction)
    if (recovery.state !== 'active') throw new Error('agent-presets: transaction has already settled')
    return transaction
  }

  const baselineTreeDigest = await agentPresetTreeDigest(paths.target)
  await assertCompositionRevision(paths.target, paths.compositionName, options.expectedRevision)
  await mkdir(paths.transaction, { mode: 0o700 })
  const journal: TransactionJournal = {
    version: 1,
    transactionId,
    presetId: preset.id,
    targetPath,
    targetDirectoryName: basename(paths.target),
    baseRevision: options.expectedRevision,
    baselineTreeDigest,
    phase: 'preparing',
  }
  await writeJournal(paths.journal, journal)
  const transaction = transactionFromJournal(journal)
  if ((await recoverAgentPresetTransaction(transaction)).state !== 'active') {
    throw new Error('agent-presets: newly prepared transaction did not become active')
  }
  return transaction
}

/**
 * Recover interrupted preparation, publication, or discard idempotently.
 * @param transaction - durable transaction handle.
 * @returns reconstructed active or terminal state.
 */
export async function recoverAgentPresetTransaction(
  transaction: AgentPresetTransaction,
): Promise<AgentPresetTransactionRecovery> {
  const paths = pathsForTransaction(transaction)
  const journal = await readJournal(paths, transaction.transactionId)
  assertJournal(journal, transaction)
  if (journal.phase === 'preparing') {
    await restorePreparing(paths, transaction, journal)
    return { state: 'active' }
  }
  if (journal.phase === 'active') {
    await assertTreeDigest(paths.target, transaction.baselineTreeDigest, 'committed baseline during recovery')
    await assertAbsent(paths.baseline, 'parked baseline during recovery')
    await agentPresetTreeDigest(paths.candidate)
    return { state: 'active' }
  }
  if (journal.phase === 'discarded_pending_terminal') {
    const digest = journal.candidateTreeDigest
    /* v8 ignore next -- journal validation requires the digest in every settled phase */
    if (digest === undefined) throw new Error('agent-presets: discarded transaction lacks its digest')
    return { state: 'discarded', disposition: await discardFromJournal(transaction, digest) }
  }
  const digest = journal.candidateTreeDigest
  /* v8 ignore next -- journal validation requires the digest in every publication phase */
  if (digest === undefined) throw new Error('agent-presets: publishing transaction lacks its digest')
  return { state: 'committed', disposition: await publishFromJournal(transaction, digest) }
}

/**
 * Resolve the isolated candidate using the committed preset's display metadata.
 * @param preset - committed preset metadata.
 * @param transaction - active transaction handle.
 * @returns preset metadata redirected to the isolated candidate.
 */
export async function resolveAgentPresetTransaction(
  preset: AgentPreset,
  transaction: AgentPresetTransaction,
): Promise<AgentPreset> {
  assertPreset(preset, transaction)
  const paths = pathsForTransaction(transaction)
  const journal = await readJournal(paths, transaction.transactionId)
  assertJournal(journal, transaction)
  if (journal.phase === 'candidate_published') return presetAt(preset, transaction.targetPath)
  if (journal.phase !== 'active') throw new Error('agent-presets: transaction is not addressable during settlement')
  if (!await exists(paths.candidate)) throw new Error('agent-presets: isolated candidate directory is missing')
  return presetAt(preset, join(paths.candidate, paths.compositionName))
}

/**
 * Return a stable complete-tree digest for validation or settlement.
 * @param preset - committed preset metadata.
 * @param transaction - active transaction handle.
 * @returns stable candidate tree digest.
 */
export async function fenceAgentPresetTransaction(
  preset: AgentPreset,
  transaction: AgentPresetTransaction,
): Promise<string> {
  assertPreset(preset, transaction)
  const paths = pathsForTransaction(transaction)
  const journal = await readJournal(paths, transaction.transactionId)
  assertJournal(journal, transaction)
  if (journal.phase !== 'active') throw new Error('agent-presets: transaction is not editable')
  const first = await agentPresetTreeDigest(paths.candidate)
  const second = await agentPresetTreeDigest(paths.candidate)
  if (first !== second) throw new Error('agent-presets: candidate changed while it was fenced')
  return first
}

/**
 * Publish one validated candidate against its unchanged committed baseline.
 * @param transaction - active or interrupted publishing transaction.
 * @param candidateTreeDigest - digest retained across external validation.
 * @returns durable publication evidence.
 */
export async function publishAgentPresetTransaction(
  transaction: AgentPresetTransaction,
  candidateTreeDigest: string,
): Promise<AgentPresetTransactionDisposition> {
  return await publishFromJournal(transaction, candidateTreeDigest)
}

/**
 * Record a safe no-publication settlement against the unchanged baseline.
 * @param transaction - active or publish-prepared transaction.
 * @param candidateTreeDigest - stable candidate tree being abandoned.
 * @returns durable discard evidence.
 */
export async function discardAgentPresetTransaction(
  transaction: AgentPresetTransaction,
  candidateTreeDigest: string,
): Promise<AgentPresetTransactionDisposition> {
  return await discardFromJournal(transaction, candidateTreeDigest)
}

/**
 * Delete transaction storage only after its terminal disposition is durable.
 * @param transaction - settled transaction handle.
 */
export async function cleanupAgentPresetTransaction(transaction: AgentPresetTransaction): Promise<void> {
  const paths = pathsForTransaction(transaction)
  if (!await exists(paths.transaction)) return
  if (!await exists(paths.journal)) {
    if (!await exists(paths.target)) throw new Error('agent-presets: cleanup cannot remove the only remaining tree')
    await rm(paths.transaction, { recursive: true, force: true })
    return
  }
  const journal = await readJournal(paths, transaction.transactionId)
  assertJournal(journal, transaction)
  if (journal.phase !== 'candidate_published' && journal.phase !== 'discarded_pending_terminal') {
    throw new Error('agent-presets: cleanup requires a settled transaction')
  }
  await rm(paths.transaction, { recursive: true, force: true })
}
