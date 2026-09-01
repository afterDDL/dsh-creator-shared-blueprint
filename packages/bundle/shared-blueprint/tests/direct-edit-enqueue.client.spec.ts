import { describe, expect, it } from 'vitest'
import type { BlueprintConversationContextResult } from 'dsh-shared-blueprint/contract'
import { assertDirectEditEnqueued } from '../src/client/direct-edit-enqueue.ts'

const input = {
  sourceSessionId: 'source-session',
  routeId: 'purpose-route',
  nodeId: 'purpose:persona',
  nodeType: 'purpose' as const,
  expectedValue: '旧目标',
  proposedValue: '新目标',
}

describe('structured Purpose enqueue confirmation', () => {
  it('accepts the matching durable Host enqueue evidence', () => {
    expect(() => { assertDirectEditEnqueued({
      sessionId: 'source-session',
      active: true,
      directEditEnqueue: {
        routeId: input.routeId,
        sourceSessionId: 'source-session',
        routingInputSeq: 42,
        messageId: 'message-1' as never,
      },
    }, 'source-session', input) }).not.toThrow()
  })

  it.each([
    { sessionId: 'source-session', active: true },
    {
      sessionId: 'source-session', active: true,
      directEditEnqueue: {
        routeId: 'foreign-route', sourceSessionId: 'source-session', routingInputSeq: 42,
        messageId: 'message-1' as never,
      },
    },
    {
      sessionId: 'source-session', active: true,
      directEditEnqueue: {
        routeId: input.routeId, sourceSessionId: 'foreign-session', routingInputSeq: 42,
        messageId: 'message-1' as never,
      },
    },
  ] satisfies BlueprintConversationContextResult[])('rejects missing or foreign enqueue evidence', (result) => {
    expect(() => { assertDirectEditEnqueued(result, 'source-session', input) })
      .toThrow('目标修改未进入当前对话')
  })
})
