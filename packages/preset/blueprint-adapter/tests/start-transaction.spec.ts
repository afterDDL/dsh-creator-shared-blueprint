import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentPreset } from '@deepseek-ai/dsh-agent-presets'
import { afterEach, describe, expect, it, vi } from 'vitest'
import BlueprintAdapter from '../src/index.ts'
import { compositionRevision } from '../src/composition.ts'
import {
  cleanupAgentPresetTransaction,
  discardAgentPresetTransaction,
  fenceAgentPresetTransaction,
  prepareAgentPresetTransaction,
  recoverAgentPresetTransaction,
} from '../../agent-presets/src/transaction.ts'
import type {
  Blueprint,
  BlueprintCapabilityAuthoringEvent,
  BlueprintConversationContextRequest,
} from '../src/types.ts'

const COMPOSITION = '- id: persona\n  name: preset-persona\n  config:\n    text: baseline\n'
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true })
  }))
})

interface StartFixture {
  adapter: BlueprintAdapter
  agent: Agent
  events: Array<{ seq: number; type: string; data: unknown }>
  owners: Map<string, string>
  preset: AgentPreset
  request: NonNullable<BlueprintConversationContextRequest['capabilityAuthoring']>
  root: string
}

async function startFixture(flush: () => Promise<void>, appendFails = false): Promise<StartFixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-capability-start-'))
  roots.push(root)
  const target = join(root, 'laptop-research')
  await mkdir(target)
  const path = join(target, 'agent.cordis.yml')
  await writeFile(path, COMPOSITION)
  const revision = compositionRevision(COMPOSITION)
  const preset: AgentPreset = { id: 'laptop-research', trust: 'user', path, name: 'Laptop research' }
  const blueprint: Blueprint = {
    schemaVersion: 1,
    preset: {
      id: preset.id,
      trust: preset.trust,
      ...(preset.name === undefined ? {} : { name: preset.name }),
    },
    revision,
    nodes: [],
    runtime: { tools: [], promptSections: [], skills: [], delegations: [], permissions: null },
    mappingGaps: [],
  }
  const events: Array<{ seq: number; type: string; data: unknown }> = []
  const agent = {
    session: {
      id: 'creator-1',
      header: { cwd: root },
      events,
      append: (type: string, data: unknown) => {
        if (appendFails) throw new Error('append fault')
        const event = { seq: events.length + 1, type, data }
        events.push(event)
        return event
      },
    },
  } as unknown as Agent
  const owners = new Map<string, string>()
  const adapter = Object.create(BlueprintAdapter.prototype) as BlueprintAdapter
  Object.assign(adapter, {
    ctx: {
      agentPresets: {
        resolve: async () => preset,
        prepareTransaction: async (_id: string, options: { key: string; expectedRevision: string }) => (
          await prepareAgentPresetTransaction(preset, options)
        ),
        fenceTransaction: async (transaction: Parameters<typeof fenceAgentPresetTransaction>[1]) => (
          await fenceAgentPresetTransaction(preset, transaction)
        ),
        discardTransaction: async (
          transaction: Parameters<typeof discardAgentPresetTransaction>[0],
          digest: string,
        ) => await discardAgentPresetTransaction(transaction, digest),
        cleanupTransaction: async (transaction: Parameters<typeof cleanupAgentPresetTransaction>[0]) => (
          await cleanupAgentPresetTransaction(transaction)
        ),
      },
      sessions: { flush },
    },
    config: {},
    capabilityTargetOwners: owners,
    read: async () => blueprint,
    capabilityPresetRoster: async () => [],
    assertRosterTargetMatchesBlueprint: () => undefined,
  })
  return {
    adapter,
    agent,
    events,
    owners,
    preset,
    root,
    request: {
      routeId: 'route-1',
      sourceSessionId: 'source-1',
      targetPresetId: preset.id,
      request: 'Add CSV laptop comparison',
      kind: 'skill',
      baseRevision: revision,
    },
  }
}

async function startCapabilityAuthoring(fixture: StartFixture): Promise<unknown> {
  const start = (fixture.adapter as unknown as {
    startCapabilityAuthoringLifecycle: (
      agent: Agent,
      request: StartFixture['request'],
    ) => Promise<unknown>
  }).startCapabilityAuthoringLifecycle
  return await start.call(fixture.adapter, fixture.agent, fixture.request)
}

describe('capability lifecycle start transaction', () => {
  it('discards an isolated candidate and releases its target when start append fails', async () => {
    const fixture = await startFixture(async () => undefined, true)

    await expect(startCapabilityAuthoring(fixture)).rejects.toThrow('append fault')

    expect(fixture.events).toEqual([])
    expect(fixture.owners.has(fixture.preset.id)).toBe(false)
    expect(await readdir(fixture.root)).toEqual([fixture.preset.id])
    expect(await readFile(fixture.preset.path, 'utf8')).toBe(COMPOSITION)
  })

  it('retains the adopted candidate and target ownership when its first flush fails', async () => {
    const fixture = await startFixture(vi.fn(async () => { throw new Error('flush fault') }))

    await expect(startCapabilityAuthoring(fixture)).rejects.toThrow('flush fault')

    expect(fixture.owners.get(fixture.preset.id)).toBe(String(fixture.agent.session.id))
    expect(fixture.events).toHaveLength(1)
    const start = fixture.events[0]
    expect(start).toMatchObject({ type: 'blueprint/capability-authoring', data: { state: 'started' } })
    const data = start?.data as Extract<BlueprintCapabilityAuthoringEvent, { state: 'started' }>
    expect(await recoverAgentPresetTransaction(data.candidate)).toEqual({ state: 'active' })
    expect((await readdir(fixture.root)).some(name => name.startsWith('.agent-preset-transaction-'))).toBe(true)
    expect(await readFile(fixture.preset.path, 'utf8')).toBe(COMPOSITION)
  })
})
