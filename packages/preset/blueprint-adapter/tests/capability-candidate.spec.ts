import { link, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentPreset } from '@deepseek-ai/dsh-agent-presets'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertCapabilityCandidateTreeDelta,
  capabilityPresetTreeDigest,
  cleanupCapabilityCandidate,
  commitCapabilityCandidate,
  discardCapabilityCandidate,
  fenceCapabilityCandidate,
  prepareCapabilityCandidate,
  recoverCapabilityCandidate,
  resolveCapabilityCandidatePreset,
} from '../src/capability-candidate.ts'
import { assertCapabilityCompositionDelta, compositionRevision } from '../src/composition.ts'
import type { BlueprintCapabilityCandidate } from '../src/types.ts'

const BASE_COMPOSITION = '- id: persona\n  name: preset-persona\n  config:\n    text: baseline\n'
const EDITED_COMPOSITION = '- id: persona\n  name: preset-persona\n  config:\n    text: candidate\n'
const SUBAGENT_COMPOSITION = `${BASE_COMPOSITION}- id: research-child
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: research_child
    backgroundMode: continuable
`
const SKILL_COMPOSITION = `${BASE_COMPOSITION}- id: local-skills
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    includeDefaultRoots: false
    customSkillDirs:
      - !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))"
- id: skill
  name: '@deepseek-ai/dsh-tool-skill'
`

function subagentDelta(): { kind: 'subagent'; rowId: string; configDigest: string } {
  const delta = assertCapabilityCompositionDelta(BASE_COMPOSITION, SUBAGENT_COMPOSITION, 'subagent')
  if (delta.kind !== 'subagent') throw new Error('expected Subagent composition evidence')
  return delta
}

interface Fixture {
  root: string
  preset: AgentPreset
  identity: {
    creatorSessionId: string
    sourceSessionId: string
    routeId: string
    targetPresetId: string
    baseRevision: string
  }
}

interface TransactionPaths {
  transaction: string
  journal: string
  candidate: string
  baseline: string
  target: string
}

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true })
  }))
})

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-capability-candidate-'))
  roots.push(root)
  const target = join(root, 'laptop-research')
  await mkdir(join(target, 'assets'), { recursive: true })
  await writeFile(join(target, 'agent.cordis.yml'), BASE_COMPOSITION)
  await writeFile(join(target, 'assets', 'baseline.txt'), 'preserve exactly\n')
  return {
    root,
    preset: {
      id: 'laptop-research',
      trust: 'user',
      path: join(target, 'agent.cordis.yml'),
      name: 'Laptop research',
    },
    identity: {
      creatorSessionId: 'creator-1',
      sourceSessionId: 'source-1',
      routeId: 'route-1',
      targetPresetId: 'laptop-research',
      baseRevision: compositionRevision(BASE_COMPOSITION),
    },
  }
}

function transactionPaths(candidate: BlueprintCapabilityCandidate): TransactionPaths {
  const target = dirname(candidate.targetPath)
  const transaction = join(dirname(target), `.blueprint-capability-${candidate.transactionId}`)
  return {
    transaction,
    journal: join(transaction, 'journal.json'),
    candidate: join(transaction, 'candidate'),
    baseline: join(transaction, 'baseline'),
    target,
  }
}

async function journalAt(paths: TransactionPaths): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(paths.journal, 'utf8')) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid test journal')
  return parsed as Record<string, unknown>
}

async function patchJournal(paths: TransactionPaths, patch: Record<string, unknown>): Promise<void> {
  await writeFile(paths.journal, `${JSON.stringify({ ...await journalAt(paths), ...patch }, null, 2)}\n`)
}

async function prepared(): Promise<Fixture & {
  candidate: BlueprintCapabilityCandidate
  paths: TransactionPaths
  candidatePath: string
}> {
  const seeded = await fixture()
  const candidate = await prepareCapabilityCandidate(seeded.preset, seeded.identity)
  const candidatePreset = await resolveCapabilityCandidatePreset(seeded.preset, candidate)
  return { ...seeded, candidate, paths: transactionPaths(candidate), candidatePath: candidatePreset.path }
}

describe('isolated capability candidate lifecycle', () => {
  it('keeps formal files unchanged and re-adopts edited active work', async () => {
    const seeded = await prepared()
    await writeFile(seeded.candidatePath, EDITED_COMPOSITION)
    await writeFile(join(dirname(seeded.candidatePath), 'draft.txt'), 'route-private\n')

    const resumed = await prepareCapabilityCandidate(seeded.preset, seeded.identity)

    expect(resumed).toEqual(seeded.candidate)
    expect(await readFile(seeded.preset.path, 'utf8')).toBe(BASE_COMPOSITION)
    expect(await readFile(seeded.candidatePath, 'utf8')).toBe(EDITED_COMPOSITION)
    expect(await readFile(join(dirname(seeded.candidatePath), 'draft.txt'), 'utf8')).toBe('route-private\n')
    expect(seeded.candidate.targetPath).toBe(seeded.preset.path)
  })

  it('commits once, recovers the terminal idempotently, and cleans only after settlement', async () => {
    const seeded = await prepared()
    await writeFile(seeded.candidatePath, EDITED_COMPOSITION)
    const digest = await fenceCapabilityCandidate(seeded.preset, seeded.candidate)

    const first = await commitCapabilityCandidate(seeded.preset, seeded.candidate, digest)
    const second = await commitCapabilityCandidate(seeded.preset, seeded.candidate, digest)
    const recovered = await recoverCapabilityCandidate(seeded.candidate)

    expect(first).toEqual(second)
    expect(recovered).toEqual({ state: 'committed', disposition: first })
    expect(await readFile(seeded.preset.path, 'utf8')).toBe(EDITED_COMPOSITION)
    expect(await capabilityPresetTreeDigest(seeded.paths.baseline)).toBe(seeded.candidate.baselineTreeDigest)

    await cleanupCapabilityCandidate(seeded.preset, seeded.candidate)
    await cleanupCapabilityCandidate(seeded.preset, seeded.candidate)
    await expect(readFile(seeded.paths.journal, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(seeded.preset.path, 'utf8')).toBe(EDITED_COMPOSITION)
  })

  it('discards idempotently without publishing and recovers its pending terminal', async () => {
    const seeded = await prepared()
    await writeFile(seeded.candidatePath, EDITED_COMPOSITION)
    const digest = await fenceCapabilityCandidate(seeded.preset, seeded.candidate)

    const first = await discardCapabilityCandidate(seeded.preset, seeded.candidate, digest)
    const second = await discardCapabilityCandidate(seeded.preset, seeded.candidate, digest)
    const recovered = await recoverCapabilityCandidate(seeded.candidate)

    expect(first).toEqual(second)
    expect(first.disposition).toBe('discarded')
    expect(recovered).toEqual({ state: 'discarded', disposition: first })
    expect(await readFile(seeded.preset.path, 'utf8')).toBe(BASE_COMPOSITION)
    expect(await readFile(seeded.candidatePath, 'utf8')).toBe(EDITED_COMPOSITION)

    await cleanupCapabilityCandidate(seeded.preset, seeded.candidate)
    expect(await readFile(seeded.preset.path, 'utf8')).toBe(BASE_COMPOSITION)
  })

  it('discards a commit-prepared candidate only while the formal baseline has not moved', async () => {
    const seeded = await prepared()
    await writeFile(seeded.candidatePath, EDITED_COMPOSITION)
    const digest = await fenceCapabilityCandidate(seeded.preset, seeded.candidate)
    await patchJournal(seeded.paths, { phase: 'commit_prepared', candidateTreeDigest: digest })

    const discarded = await discardCapabilityCandidate(seeded.preset, seeded.candidate, digest)

    expect(discarded).toMatchObject({ disposition: 'discarded', candidateTreeDigest: digest })
    expect((await journalAt(seeded.paths))['phase']).toBe('discarded_pending_terminal')
    expect(await readFile(seeded.preset.path, 'utf8')).toBe(BASE_COMPOSITION)
    expect(await readFile(seeded.candidatePath, 'utf8')).toBe(EDITED_COMPOSITION)
    await expect(readFile(seeded.paths.baseline, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(recoverCapabilityCandidate(seeded.candidate))
      .resolves.toEqual({ state: 'discarded', disposition: discarded })
  })

  it('never rolls back a candidate after baseline parking or publication', async () => {
    const parked = await prepared()
    await writeFile(parked.candidatePath, EDITED_COMPOSITION)
    const parkedDigest = await fenceCapabilityCandidate(parked.preset, parked.candidate)
    await patchJournal(parked.paths, { phase: 'baseline_parked', candidateTreeDigest: parkedDigest })
    await rename(parked.paths.target, parked.paths.baseline)
    await expect(discardCapabilityCandidate(parked.preset, parked.candidate, parkedDigest))
      .rejects.toThrow(/publishing candidate cannot be discarded/u)

    const published = await prepared()
    await writeFile(published.candidatePath, EDITED_COMPOSITION)
    const publishedDigest = await fenceCapabilityCandidate(published.preset, published.candidate)
    await commitCapabilityCandidate(published.preset, published.candidate, publishedDigest)
    await expect(discardCapabilityCandidate(published.preset, published.candidate, publishedDigest))
      .rejects.toThrow(/publishing candidate cannot be discarded/u)
  })

  it('rejects commit when any formal preset entry changed after candidate creation', async () => {
    const seeded = await prepared()
    await writeFile(seeded.candidatePath, EDITED_COMPOSITION)
    const digest = await fenceCapabilityCandidate(seeded.preset, seeded.candidate)
    await writeFile(join(seeded.paths.target, 'external.txt'), 'concurrent writer\n')

    await expect(commitCapabilityCandidate(seeded.preset, seeded.candidate, digest))
      .rejects.toThrow(/formal baseline before commit.*CAS/u)

    expect(await readFile(seeded.preset.path, 'utf8')).toBe(BASE_COMPOSITION)
    expect((await journalAt(seeded.paths))['phase']).toBe('active')
  })

  it('rebuilds an interrupted preparing clone from its unchanged baseline', async () => {
    const seeded = await prepared()
    await patchJournal(seeded.paths, { phase: 'preparing' })
    await rm(seeded.paths.candidate, { recursive: true, force: true })
    await mkdir(seeded.paths.candidate)
    await writeFile(join(seeded.paths.candidate, 'partial.tmp'), 'partial\n')

    await expect(recoverCapabilityCandidate(seeded.candidate)).resolves.toEqual({ state: 'active' })

    expect(await capabilityPresetTreeDigest(seeded.paths.candidate)).toBe(seeded.candidate.baselineTreeDigest)
    expect((await journalAt(seeded.paths))['phase']).toBe('active')
  })

  it('finishes commit from targetPath while the formal directory is parked', async () => {
    const seeded = await prepared()
    await writeFile(seeded.candidatePath, EDITED_COMPOSITION)
    const digest = await fenceCapabilityCandidate(seeded.preset, seeded.candidate)
    await patchJournal(seeded.paths, { phase: 'baseline_parked', candidateTreeDigest: digest })
    await rename(seeded.paths.target, seeded.paths.baseline)

    await expect(readFile(seeded.preset.path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    const recovered = await recoverCapabilityCandidate(seeded.candidate)

    expect(recovered).toMatchObject({ state: 'committed', disposition: { candidateTreeDigest: digest } })
    expect(await readFile(seeded.preset.path, 'utf8')).toBe(EDITED_COMPOSITION)
    expect((await journalAt(seeded.paths))['phase']).toBe('candidate_published')
  })

  it('recovers when baseline parking completed before commit_prepared advanced', async () => {
    const seeded = await prepared()
    await writeFile(seeded.candidatePath, EDITED_COMPOSITION)
    const digest = await fenceCapabilityCandidate(seeded.preset, seeded.candidate)
    await patchJournal(seeded.paths, { phase: 'commit_prepared', candidateTreeDigest: digest })
    await rename(seeded.paths.target, seeded.paths.baseline)

    const recovered = await recoverCapabilityCandidate(seeded.candidate)

    expect(recovered).toMatchObject({ state: 'committed', disposition: { candidateTreeDigest: digest } })
    expect(await readFile(seeded.preset.path, 'utf8')).toBe(EDITED_COMPOSITION)
    expect((await journalAt(seeded.paths))['phase']).toBe('candidate_published')
  })

  it('recognizes a candidate rename that completed before its journal phase advanced', async () => {
    const seeded = await prepared()
    await writeFile(seeded.candidatePath, EDITED_COMPOSITION)
    const digest = await fenceCapabilityCandidate(seeded.preset, seeded.candidate)
    await patchJournal(seeded.paths, { phase: 'baseline_parked', candidateTreeDigest: digest })
    await rename(seeded.paths.target, seeded.paths.baseline)
    await rename(seeded.paths.candidate, seeded.paths.target)

    const recovered = await recoverCapabilityCandidate(seeded.candidate)

    expect(recovered.state).toBe('committed')
    expect(await readFile(seeded.preset.path, 'utf8')).toBe(EDITED_COMPOSITION)
    expect((await journalAt(seeded.paths))['phase']).toBe('candidate_published')
  })

  it('rejects forged target paths and a formal preset that does not match the durable target', async () => {
    const seeded = await prepared()
    const forged = { ...seeded.candidate, targetPath: join(seeded.paths.target, 'other.yml') }
    await expect(recoverCapabilityCandidate(forged)).rejects.toThrow(/targetPath/u)

    const otherPreset = { ...seeded.preset, id: 'other' }
    await expect(fenceCapabilityCandidate(otherPreset, seeded.candidate))
      .rejects.toThrow(/does not match the durable targetPath/u)
  })
})

describe('strict capability candidate tree deltas', () => {
  it('allows Subagent authoring to change only the composition file', async () => {
    const seeded = await prepared()
    await writeFile(seeded.candidatePath, SUBAGENT_COMPOSITION)
    const digest = await fenceCapabilityCandidate(seeded.preset, seeded.candidate)

    await expect(assertCapabilityCandidateTreeDelta(
      seeded.preset, seeded.candidate, digest, subagentDelta(),
    )).resolves.toBeUndefined()

    await writeFile(join(dirname(seeded.candidatePath), 'extra.txt'), 'not admitted\n')
    const invalidDigest = await fenceCapabilityCandidate(seeded.preset, seeded.candidate)
    await expect(assertCapabilityCandidateTreeDelta(
      seeded.preset, seeded.candidate, invalidDigest, subagentDelta(),
    )).rejects.toThrow(/Subagent authoring added/u)
  })

  it('allows exactly one new verified Skill subtree and preserves every baseline entry', async () => {
    const seeded = await prepared()
    await writeFile(seeded.candidatePath, SKILL_COMPOSITION)
    const skill = join(dirname(seeded.candidatePath), 'skills', 'csv-laptop-comparison')
    await mkdir(join(skill, 'references'), { recursive: true })
    await writeFile(join(skill, 'SKILL.md'), '---\nname: csv-laptop-comparison\n---\nCompare CSV laptops.\n')
    await writeFile(join(skill, 'references', 'columns.md'), 'product,price\n')
    const digest = await fenceCapabilityCandidate(seeded.preset, seeded.candidate)

    await expect(assertCapabilityCandidateTreeDelta(
      seeded.preset,
      seeded.candidate,
      digest,
      { kind: 'skill', skillName: 'csv-laptop-comparison' },
    )).resolves.toBeUndefined()

    await writeFile(join(dirname(seeded.candidatePath), 'assets', 'baseline.txt'), 'mutated\n')
    const mutatedDigest = await fenceCapabilityCandidate(seeded.preset, seeded.candidate)
    await expect(assertCapabilityCandidateTreeDelta(
      seeded.preset,
      seeded.candidate,
      mutatedDigest,
      { kind: 'skill', skillName: 'csv-laptop-comparison' },
    )).rejects.toThrow(/baseline entry.*changed outside/u)
  })

  it('rejects a missing verified Skill subtree, unrelated additions, and hard links', async () => {
    const missing = await prepared()
    await writeFile(missing.candidatePath, SKILL_COMPOSITION)
    const missingDigest = await fenceCapabilityCandidate(missing.preset, missing.candidate)
    await expect(assertCapabilityCandidateTreeDelta(
      missing.preset,
      missing.candidate,
      missingDigest,
      { kind: 'skill', skillName: 'csv-laptop-comparison' },
    )).rejects.toThrow(/one new Skill directory/u)

    const unrelated = await prepared()
    await writeFile(unrelated.candidatePath, SKILL_COMPOSITION)
    const skill = join(dirname(unrelated.candidatePath), 'skills', 'csv-laptop-comparison')
    await mkdir(skill, { recursive: true })
    await writeFile(join(skill, 'SKILL.md'), '# Skill\n')
    await writeFile(join(dirname(unrelated.candidatePath), 'rogue.txt'), 'rogue\n')
    const unrelatedDigest = await fenceCapabilityCandidate(unrelated.preset, unrelated.candidate)
    await expect(assertCapabilityCandidateTreeDelta(
      unrelated.preset,
      unrelated.candidate,
      unrelatedDigest,
      { kind: 'skill', skillName: 'csv-laptop-comparison' },
    )).rejects.toThrow(/outside its new subtree/u)

    const linked = await prepared()
    await link(
      join(dirname(linked.candidatePath), 'assets', 'baseline.txt'),
      join(dirname(linked.candidatePath), 'assets', 'hard-link.txt'),
    )
    await expect(fenceCapabilityCandidate(linked.preset, linked.candidate))
      .rejects.toThrow(/hard-linked file/u)
  })
})
