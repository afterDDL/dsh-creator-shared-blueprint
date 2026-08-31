import { createHash } from 'node:crypto'
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { afterEach, describe, expect, it } from 'vitest'
import AgentPresets, {
  COMPOSITION_FILE,
  type AgentPresetTransaction,
  type AgentPresetTransactionDisposition,
} from '@deepseek-ai/dsh-agent-presets'

const BASE = '- id: external\n  name: ./external-preset-plugin.js\n  config:\n    label: committed\n'
const CANDIDATE = '- id: external\n  name: ./external-preset-plugin.js\n  config:\n    label: candidate\n'
const roots: string[] = []

function revision(composition: string): string {
  return createHash('sha256').update(composition).digest('hex')
}

async function fixture(): Promise<{ root: string; presetPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-preset-transaction-'))
  roots.push(root)
  const directory = join(root, 'external-agent')
  await mkdir(directory)
  await writeFile(join(directory, 'external-preset-plugin.js'), 'export default function externalPresetPlugin() {}\n')
  const presetPath = join(directory, COMPOSITION_FILE)
  await writeFile(presetPath, BASE)
  return { root, presetPath }
}

async function harness(root: string): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  await ctx.plugin(AgentPresets, {
    default: 'external-agent',
    roots: [{ path: root, trust: 'user' }],
    includeUserRoot: false,
  })
  return ctx
}

class ExternalPresetPublisher extends Service {
  static inject = ['agentPresets']

  constructor(ctx: Context) {
    super(ctx, 'externalPresetPublisher')
  }

  /** Prepare and edit one transaction exclusively through the public service. */
  async prepare(key: string): Promise<AgentPresetTransaction> {
    const transaction = await this.ctx.agentPresets.prepareTransaction('external-agent', {
      key,
      expectedRevision: revision(BASE),
    })
    const candidate = await this.ctx.agentPresets.resolveTransaction(transaction)
    await writeFile(candidate.path, CANDIDATE)
    return transaction
  }

  /** Validate and publish the current candidate through the public service. */
  async publish(transaction: AgentPresetTransaction): Promise<AgentPresetTransactionDisposition> {
    const digest = await this.ctx.agentPresets.fenceTransaction(transaction)
    return await this.ctx.agentPresets.publishTransaction(transaction, digest)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    externalPresetPublisher: ExternalPresetPublisher
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => await rm(root, { recursive: true, force: true })))
})

describe('isolated agent preset transactions', () => {
  it('keeps committed readers on the baseline until a non-Blueprint plugin publishes', async () => {
    const seeded = await fixture()
    const ctx = await harness(seeded.root)
    await ctx.plugin(ExternalPresetPublisher)
    const before = await ctx.agentPresets.projectionSnapshot('external-agent')

    const transaction = await ctx.externalPresetPublisher.prepare('external-plugin:create-v2')
    expect(await ctx.agentPresets.read('external-agent')).toBe(BASE)
    expect(await readFile((await ctx.agentPresets.resolveTransaction(transaction)).path, 'utf8')).toBe(CANDIDATE)

    const disposition = await ctx.externalPresetPublisher.publish(transaction)
    const after = await ctx.agentPresets.projectionSnapshot('external-agent')
    expect(disposition).toMatchObject({ disposition: 'committed', finalTreeDigest: disposition.candidateTreeDigest })
    expect(after.composition).toBe(CANDIDATE)
    expect(after.standingKey).not.toBe(before.standingKey)
    await ctx.agentPresets.cleanupTransaction(transaction)
  })

  it('rejects publication after the committed baseline changes', async () => {
    const seeded = await fixture()
    const ctx = await harness(seeded.root)
    await ctx.plugin(ExternalPresetPublisher)
    const transaction = await ctx.externalPresetPublisher.prepare('external-plugin:stale')
    const candidateDigest = await ctx.agentPresets.fenceTransaction(transaction)
    await writeFile(seeded.presetPath, `${BASE}# concurrent edit\n`)

    await expect(ctx.agentPresets.publishTransaction(transaction, candidateDigest))
      .rejects.toThrow('complete-tree CAS')
    expect(await readFile(seeded.presetPath, 'utf8')).toBe(`${BASE}# concurrent edit\n`)
  })

  it('persists active work across service restart and publishes it once', async () => {
    const seeded = await fixture()
    const first = await harness(seeded.root)
    await first.plugin(ExternalPresetPublisher)
    const transaction = await first.externalPresetPublisher.prepare('external-plugin:restart')
    const digest = await first.agentPresets.fenceTransaction(transaction)
    await first.fiber.dispose()

    const restarted = await harness(seeded.root)
    expect(await restarted.agentPresets.recoverTransaction(transaction)).toEqual({ state: 'active' })
    const disposition = await restarted.agentPresets.publishTransaction(transaction, digest)
    expect(disposition.disposition).toBe('committed')
    expect(await restarted.agentPresets.read('external-agent')).toBe(CANDIDATE)
    const recovery = await restarted.agentPresets.recoverTransaction(transaction)
    expect(recovery.state).toBe('committed')
    if (recovery.state !== 'committed') throw new Error('expected committed transaction recovery')
    expect(recovery.disposition).toEqual(disposition)
    await restarted.agentPresets.cleanupTransaction(transaction)
  })

  it('records discard without changing the committed preset', async () => {
    const seeded = await fixture()
    const ctx = await harness(seeded.root)
    await ctx.plugin(ExternalPresetPublisher)
    const transaction = await ctx.externalPresetPublisher.prepare('external-plugin:cancel')
    const digest = await ctx.agentPresets.fenceTransaction(transaction)

    const disposition = await ctx.agentPresets.discardTransaction(transaction, digest)
    expect(disposition).toMatchObject({ disposition: 'discarded', finalTreeDigest: transaction.baselineTreeDigest })
    expect(await readFile(seeded.presetPath, 'utf8')).toBe(BASE)
    expect(await ctx.agentPresets.recoverTransaction(transaction)).toEqual({ state: 'discarded', disposition })
    await ctx.agentPresets.cleanupTransaction(transaction)
    expect(await readFile(seeded.presetPath, 'utf8')).toBe(BASE)
    expect(dirname(transaction.targetPath)).toBe(dirname(seeded.presetPath))
  })

  it('rejects hard-linked preset files before preparing isolated storage', async () => {
    const seeded = await fixture()
    await link(seeded.presetPath, join(dirname(seeded.presetPath), 'linked-composition.yml'))
    const ctx = await harness(seeded.root)

    await expect(ctx.agentPresets.prepareTransaction('external-agent', {
      key: 'external-plugin:unsafe-tree',
      expectedRevision: revision(BASE),
    })).rejects.toThrow('hard-linked file')
    expect(await readFile(seeded.presetPath, 'utf8')).toBe(BASE)
  })

  it('rejects durable handles outside configured writable roots', async () => {
    const seeded = await fixture()
    const foreign = await fixture()
    const ctx = await harness(seeded.root)
    const digest = revision(BASE)

    await expect(ctx.agentPresets.recoverTransaction({
      version: 1,
      transactionId: digest,
      targetPath: foreign.presetPath,
      baseRevision: digest,
      baselineTreeDigest: digest,
    })).rejects.toThrow('outside every configured writable root')
  })
})
