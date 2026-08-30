import { describe, expect, it, vi } from 'vitest'
import { capabilityAuthoringCreatorSessionId } from '../src/client/index.ts'
import {
  resolveCapabilityAuthoringExecution, resolveCapabilityAuthoringSourcePreset,
} from '../src/client/capability-topology.ts'

describe('legacy capability authoring Creator identity', () => {
  it('waits for the resolved Cordis source identity without allocating a dedicated worker', async () => {
    let resolvePreset: ((preset: string) => void) | undefined
    const sourceAgentPreset = new Promise<string>((resolve) => { resolvePreset = resolve })
    const createDedicatedWorker = vi.fn(() => Promise.resolve('creator-worker'))
    const execution = resolveCapabilityAuthoringExecution(
      'source-session', () => sourceAgentPreset, createDedicatedWorker,
    )

    await Promise.resolve()
    expect(createDedicatedWorker).not.toHaveBeenCalled()
    resolvePreset?.('cordis')

    await expect(execution).resolves.toEqual({ sessionId: 'source-session', dedicatedWorker: false })
    expect(createDedicatedWorker).not.toHaveBeenCalled()
  })

  it('retains the dedicated-worker fallback for a non-Cordis source', async () => {
    const createDedicatedWorker = vi.fn(() => Promise.resolve('creator-worker'))

    await expect(resolveCapabilityAuthoringExecution(
      'source-session', () => Promise.resolve('competitive-research'), createDedicatedWorker,
    )).resolves.toEqual({ sessionId: 'creator-worker', dedicatedWorker: true })
    expect(createDedicatedWorker).toHaveBeenCalledTimes(1)
  })

  it('does not allocate a worker when source preset resolution fails', async () => {
    const createDedicatedWorker = vi.fn(() => Promise.resolve('creator-worker'))

    await expect(resolveCapabilityAuthoringExecution(
      'source-session', () => Promise.reject(new Error('source adoption failed')), createDedicatedWorker,
    )).rejects.toThrow('source adoption failed')
    expect(createDedicatedWorker).not.toHaveBeenCalled()
  })

  it('adopts the exact existing source and uses its durable preset echo instead of a stale summary', async () => {
    const adoptSource = vi.fn(() => Promise.resolve({
      sessionId: 'source-session', agentPreset: 'cordis',
    }))
    const noteSourcePreset = vi.fn()
    const createDedicatedWorker = vi.fn(() => Promise.resolve('creator-worker'))

    const execution = resolveCapabilityAuthoringExecution(
      'source-session',
      () => resolveCapabilityAuthoringSourcePreset(
        'source-session', 'C:\\workspace', true, adoptSource, noteSourcePreset,
      ),
      createDedicatedWorker,
    )

    await expect(execution).resolves.toEqual({ sessionId: 'source-session', dedicatedWorker: false })
    expect(adoptSource).toHaveBeenCalledWith({ sessionId: 'source-session', cwd: 'C:\\workspace' })
    expect(noteSourcePreset).toHaveBeenCalledWith('source-session', 'cordis')
    expect(createDedicatedWorker).not.toHaveBeenCalled()
  })

  it('fails closed before adoption when the exact source is no longer addressable', async () => {
    const adoptSource = vi.fn()

    await expect(resolveCapabilityAuthoringSourcePreset(
      'source-session', 'C:\\workspace', false, adoptSource, vi.fn(),
    )).rejects.toThrow('Source Session 已不可用')
    expect(adoptSource).not.toHaveBeenCalled()
  })

  it('retains the Host domain-separated source-route identity for fallback recovery', async () => {
    await expect(capabilityAuthoringCreatorSessionId('source-session', 'route-1')).resolves.toBe(
      'creator-capability-19388d788527137a99043615c5bba0891b1cd4b965856c4f110c9bc5ada25ea2',
    )
  })
})
