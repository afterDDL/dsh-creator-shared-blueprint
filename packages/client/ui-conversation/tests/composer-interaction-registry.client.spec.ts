import { describe, expect, it } from 'vitest'
import type { PendingInteraction, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { ComposerInteractionRegistry } from '../src/client/input/interactions.ts'

const sessionId = (value: string): SessionId => value as SessionId

function interaction(owner: SessionId, key: string): PendingInteraction {
  return { kind: 'question', sessionId: owner, key } as unknown as PendingInteraction
}

describe('ComposerInteractionRegistry', () => {
  it('keeps one stable source store and exact carrier identities across replacement and clear', () => {
    const registry = new ComposerInteractionRegistry()
    const source = sessionId('source')
    const store = registry.storeFor(source)
    const first = interaction(sessionId('child-a'), 'question-a')
    const replacement = interaction(sessionId('child-b'), 'question-b')

    expect(registry.storeFor(source)).toBe(store)
    registry.set(source, [first])
    const firstSnapshot = store.getSnapshot()
    expect(firstSnapshot).toHaveLength(1)
    expect(firstSnapshot[0]).toBe(first)

    registry.set(source, [first])
    expect(store.getSnapshot()).toBe(firstSnapshot)

    registry.set(source, [replacement])
    expect(store.getSnapshot()).toHaveLength(1)
    expect(store.getSnapshot()[0]).toBe(replacement)

    registry.set(source, [])
    expect(store.getSnapshot()).toEqual([])
  })

  it('forgets only the addressed source store', () => {
    const registry = new ComposerInteractionRegistry()
    const source = sessionId('source')
    const otherSource = sessionId('other-source')
    const sourceStore = registry.storeFor(source)
    const otherStore = registry.storeFor(otherSource)
    const otherCarrier = interaction(sessionId('other-child'), 'question')
    registry.set(otherSource, [otherCarrier])

    registry.forget(source)

    expect(registry.storeFor(source)).not.toBe(sourceStore)
    expect(registry.storeFor(source).getSnapshot()).toEqual([])
    expect(registry.storeFor(otherSource)).toBe(otherStore)
    expect(otherStore.getSnapshot()[0]).toBe(otherCarrier)
  })
})
