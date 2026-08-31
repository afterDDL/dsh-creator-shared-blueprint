import { describe, expect, it } from 'vitest'
import { BlueprintCapabilityComposerBlockProjection } from '../src/client/capability-composer-block.ts'

interface Block {
  readonly reason: string
  readonly activityPresentation?: 'consumer-owned'
}

class ComposerBlocksDouble {
  private readonly values = new Map<string, Block | undefined>()
  private readonly listeners = new Map<string, Set<() => void>>()

  set(sessionId: string, block: Block | undefined): void {
    if (this.values.get(sessionId)?.reason === block?.reason) return
    this.values.set(sessionId, block)
    for (const listener of this.listeners.get(sessionId) ?? []) listener()
  }

  storeFor(sessionId: string) {
    return {
      getSnapshot: () => this.values.get(sessionId),
      subscribe: (listener: () => void) => {
        const listeners = this.listeners.get(sessionId) ?? new Set()
        listeners.add(listener)
        this.listeners.set(sessionId, listeners)
        return () => { listeners.delete(listener) }
      },
    }
  }

  read(sessionId: string): Block | undefined {
    return this.values.get(sessionId)
  }
}

describe('Blueprint capability composer block projection', () => {
  it('reasserts an active source block when refresh initialization clears the shared registry', () => {
    const blocks = new ComposerBlocksDouble()
    const projection = new BlueprintCapabilityComposerBlockProjection(blocks)

    projection.sync(['source-cordis'], new Set())
    expect(blocks.read('source-cordis')).toEqual({
      reason: '正在配置能力…', activityPresentation: 'consumer-owned',
    })

    blocks.set('source-cordis', undefined)
    expect(blocks.read('source-cordis')).toEqual({
      reason: '正在配置能力…', activityPresentation: 'consumer-owned',
    })

    projection.sync([], new Set())
    expect(blocks.read('source-cordis')).toBeUndefined()
    blocks.set('source-cordis', { reason: '已就绪' })
    expect(blocks.read('source-cordis')).toEqual({ reason: '已就绪' })
  })
})
