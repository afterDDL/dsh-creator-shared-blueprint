import { describe, expect, it } from 'vitest'
import type {
  ChatConversationViewNode, ChatSnapshot, ConversationEventInput, ConversationNodeDefinition,
  ConversationSnapshot, ConversationViewDefinition, SessionId,
} from '@deepseek-ai/dsh-client-runtime/client'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-runtime/client'
import { assistantDefinition } from '../../ui-conversation/src/client/conversation-nodes/assistant.ts'
import { chatViewDefinition } from '../../ui-conversation/src/client/conversation-nodes/chat-snapshot-builder.ts'
import { messageDefinition } from '../../ui-conversation/src/client/conversation-nodes/message.ts'
import { toolDefinition } from '../../ui-conversation/src/client/conversation-nodes/tool.ts'
import { turnTailDefinition } from '../../ui-conversation/src/client/conversation-nodes/turn-tail.ts'
import {
  blueprintCapabilityRouteTurnPresentationDefinition, blueprintCapabilityRoutingInputDefinition,
} from '../src/client/capability-route-turn-presentation.ts'
import { capabilityObservation } from '../src/client/index.ts'

type ConversationEvent = Parameters<ConversationNodeDefinition['match']>[0]

const DEFINITIONS: readonly ConversationNodeDefinition[] = [
  messageDefinition,
  blueprintCapabilityRoutingInputDefinition,
  blueprintCapabilityRouteTurnPresentationDefinition,
  assistantDefinition,
  toolDefinition,
  turnTailDefinition,
]

class TestEventDefinitions {
  entries(): readonly ConversationNodeDefinition[] {
    return DEFINITIONS
  }

  fallbackEntry(): ConversationNodeDefinition | undefined {
    return undefined
  }
}

class TestViewDefinitions {
  entries(): readonly ConversationViewDefinition[] {
    return [chatViewDefinition]
  }
}

function at(
  seq: number,
  type: string,
  data: unknown,
  extra: Record<string, unknown> = {},
): ConversationEventInput {
  return {
    event: {
      type,
      seq,
      time: 1_700_000_000_000 + seq,
      data,
      ...extra,
    } as ConversationEvent,
    view: undefined,
  }
}

function routingInput(
  messageId: string,
  uiAction: 'add-capability' | 'direct-edit' = 'add-capability',
): ConversationEventInput {
  return at(1, 'blueprint/routing-input', {
    routeId: 'route-capability-1',
    sourceSessionId: 'source-1',
    messageId,
    userRequest: 'Add a CSV Skill',
    targetPresetId: 'target-1',
    uiAction,
    ...(uiAction === 'direct-edit' ? {
      directEdit: {
        nodeId: 'purpose', nodeType: 'purpose', label: 'Purpose',
        operation: { kind: 'set-purpose', value: 'updated' },
        currentValue: 'current', proposedValue: 'updated', impactCandidates: [],
      },
    } : {}),
  })
}

function userMessage(
  id: string,
  source: Record<string, unknown> = { kind: 'user', rpcId: 'rpc-1' },
): ConversationEventInput {
  return at(4, 'user/message', {
    id,
    role: 'user',
    content: [{ type: 'text', text: 'Add a CSV Skill' }],
    source,
  }, { surfaceOp: 'append' })
}

function lifecycleTurn(kind: 'blueprint-capability-authoring' | 'blueprint-capability-repair'):
readonly ConversationEventInput[] {
  return [
    at(20, 'turn/start', { turn: 2 }),
    at(21, 'step/start', { turn: 2, step: 1 }),
    at(22, 'user/message', {
      id: `${kind}-message`,
      role: 'user',
      content: [{ type: 'text', text: 'internal capability continuation' }],
      source: { kind, sourceSessionId: 'source-1', routeId: 'route-capability-1' },
    }, { surfaceOp: 'append' }),
    at(23, 'assistant/message', {
      turn: 2,
      step: 1,
      message: {
        id: `${kind}-assistant`, role: 'assistant',
        content: [{ type: 'reasoning', text: 'internal authoring reasoning' }],
        source: { kind: 'model', provider: 'test', model: 'test' },
      },
    }, { surfaceOp: 'append' }),
    at(24, 'tool/call', {
      turn: 2, step: 1, callId: `${kind}-read`, name: 'read', arguments: '{}',
    }),
  ]
}

function assembledRouteTurn(messageId = 'route-message-1'): readonly ConversationEventInput[] {
  const callId = 'capability-route'
  return [
    routingInput(messageId),
    at(2, 'turn/start', { turn: 1 }),
    at(3, 'step/start', { turn: 1, step: 1 }),
    userMessage(messageId),
    at(5, 'assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'block-start', index: 0, blockType: 'reasoning' },
    }),
    at(6, 'assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'reasoning-delta', index: 0, text: 'I will route this request.' },
    }),
    at(7, 'assistant/message', {
      turn: 1,
      step: 1,
      message: {
        id: 'assistant-routing', role: 'assistant',
        content: [{ type: 'reasoning', text: 'I will route this request.' }],
        source: { kind: 'model', provider: 'test', model: 'test' },
      },
    }, { surfaceOp: 'append' }),
    at(8, 'step/end', { turn: 1, step: 1 }),
    at(9, 'step/start', { turn: 1, step: 2 }),
    at(10, 'tool/call', {
      turn: 1,
      step: 2,
      callId,
      name: 'route_blueprint_capability_authoring',
      arguments: '{"kind":"skill"}',
    }),
    at(11, 'tool/result', {
      turn: 1,
      step: 2,
      message: {
        id: 'route-result', role: 'user', source: { kind: 'tool', callId },
        content: [{
          type: 'tool-result', toolCallId: callId,
          content: [{ type: 'text', text: '{"ok":true}' }], isError: false,
        }],
      },
      meta: { blueprintCapabilityAuthoring: {
        routeId: 'route-capability-1', sourceSessionId: 'source-1', presetId: 'target-1',
        revision: 'revision-1', request: 'Add a CSV Skill', reason: 'Requires one reusable CSV workflow.',
        kind: 'skill',
      } },
    }, { sourceEventSeqs: [10], surfaceOp: 'append' }),
    at(12, 'step/end', { turn: 1, step: 2 }),
    at(13, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
}

function createAssembler(): ConversationNodeAssembler {
  return new ConversationNodeAssembler(new TestEventDefinitions(), new TestViewDefinitions())
}

function snapshot(value: ConversationNodeAssembler): ChatSnapshot {
  const current = value.snapshot('chat') as ChatSnapshot | undefined
  if (current === undefined) throw new Error('chat view was not registered')
  return current
}

function turnNodes(value: ChatSnapshot, turn: number): readonly ChatConversationViewNode[] {
  return value.nodes.values().filter((candidate) => {
    const location = candidate.location
    return (location.kind === 'turn' || location.kind === 'step') && location.turn.turn === turn
  })
}

function visibleKinds(value: ChatSnapshot, turn: number): readonly string[] {
  return turnNodes(value, turn).filter(node => node.visibility === 'visible').map(node => node.kind)
}

function toolCall(name: string, callId = 'capability-route'): ConversationEvent {
  return {
    type: 'tool/call',
    seq: 14,
    time: 1_700_000_000_014,
    data: {
      turn: 3,
      step: 1,
      callId,
      name,
      arguments: '{}',
    },
  } as ConversationEvent
}

describe('Blueprint capability route Turn presentation', () => {
  it('retains only exact Add capability routing input as state', () => {
    const add = routingInput('route-message-1').event
    expect(blueprintCapabilityRoutingInputDefinition.match(add)).toEqual({
      id: 'route-capability-1',
      role: 'start',
    })

    const directEdit = routingInput('route-message-1', 'direct-edit').event
    expect(blueprintCapabilityRoutingInputDefinition.match(directEdit)).toBeNull()
  })

  it('marks only the typed capability router Turn as implementation-only', () => {
    expect(blueprintCapabilityRouteTurnPresentationDefinition.match(toolCall(
      'route_blueprint_capability_authoring',
    ))).toEqual({ id: 'capability-route', role: 'start' })

    expect(blueprintCapabilityRouteTurnPresentationDefinition.match(toolCall(
      'route_blueprint_creator_authoring',
    ))).toBeNull()
    expect(blueprintCapabilityRouteTurnPresentationDefinition.match(toolCall(
      'propose_blueprint_change',
    ))).toBeNull()
    expect(blueprintCapabilityRouteTurnPresentationDefinition.match(toolCall(
      'route_blueprint_capability_authoring_lookalike',
    ))).toBeNull()
  })

  it('suppresses incremental routing implementation from the admitted user message and across refresh', () => {
    const entries = assembledRouteTurn()
    const value = createAssembler()
    value.replaceWindow(entries.slice(0, 4), false)
    value.flush()
    expect(visibleKinds(snapshot(value), 1)).toEqual(['user'])
    expect(turnNodes(snapshot(value), 1).find(
      node => node.kind === 'blueprint-capability-route-turn-presentation',
    )).toMatchObject({
      visibility: 'hidden',
      data: {
        internalTurnPresentation: 'implementation-only',
        runningPresentation: 'configuration',
      },
    })

    value.append(entries[4]!)
    value.flush()
    expect(visibleKinds(snapshot(value), 1)).toEqual(['user'])

    value.append(entries[5]!)
    value.flush()
    expect(visibleKinds(snapshot(value), 1)).toEqual(['user'])

    value.append(entries[6]!)
    value.flush()
    expect(visibleKinds(snapshot(value), 1)).toEqual(['user'])

    for (const entry of entries.slice(7)) value.append(entry)
    value.flush()
    expect(visibleKinds(snapshot(value), 1)).toEqual(['user'])
    expect(snapshot(value).legacy.nodes.map(node => node.kind)).toEqual(['user'])

    value.replaceWindow(entries, false)
    value.flush()
    const refreshed = snapshot(value)
    expect(visibleKinds(refreshed, 1)).toEqual(['user'])
    expect(refreshed.legacy.nodes.map(node => node.kind)).toEqual(['user'])
    expect(capabilityObservation('source-1' as SessionId, {
      sessionId: 'source-1', chat: refreshed, nodes: refreshed.legacy.nodes,
      pending: [], running: false, removed: false,
    } as unknown as ConversationSnapshot).authoringRoutes).toEqual([{
      seq: 11,
      route: {
        routeId: 'route-capability-1', sourceSessionId: 'source-1', presetId: 'target-1',
        revision: 'revision-1', request: 'Add a CSV Skill', reason: 'Requires one reusable CSV workflow.',
        kind: 'skill',
      },
    }])
  })

  it.each([
    'blueprint-capability-authoring',
    'blueprint-capability-repair',
  ] as const)('keeps the %s continuation in configuration presentation', (kind) => {
    const value = createAssembler()
    value.replaceWindow(lifecycleTurn(kind), false)
    value.flush()

    const current = snapshot(value)
    expect(visibleKinds(current, 2)).toEqual([])
    expect(turnNodes(current, 2).find(
      node => node.kind === 'blueprint-capability-route-turn-presentation',
    )).toMatchObject({
      visibility: 'hidden',
      data: {
        internalTurnPresentation: 'implementation-only',
        runningPresentation: 'configuration',
      },
    })
  })

  it('does not hide mismatched, direct-edit, plugin, or ordinary user Turns', () => {
    const cases: readonly ConversationEventInput[][] = [
      [routingInput('another-message'), ...assembledRouteTurn().slice(1, 4)],
      [routingInput('route-message-1', 'direct-edit'), ...assembledRouteTurn().slice(1, 4)],
      [routingInput('route-message-1'), ...assembledRouteTurn().slice(1, 3), userMessage(
        'route-message-1',
        { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot', sections: [] },
      )],
      assembledRouteTurn().slice(1, 4),
    ]

    for (const entries of cases) {
      const value = createAssembler()
      value.replaceWindow([
        ...entries,
        at(5, 'assistant/message', {
          turn: 1,
          step: 1,
          message: {
            id: 'ordinary-assistant', role: 'assistant',
            content: [{ type: 'text', text: 'Visible response' }],
            source: { kind: 'model', provider: 'test', model: 'test' },
          },
        }, { surfaceOp: 'append' }),
      ], false)
      value.flush()
      expect(visibleKinds(snapshot(value), 1)).toContain('assistant-step')
      expect(turnNodes(snapshot(value), 1).some(
        node => node.kind === 'blueprint-capability-route-turn-presentation',
      )).toBe(false)
    }
  })

  it('does not reinterpret route settlement or authoring lifecycle events as presentation markers', () => {
    const result = {
      type: 'tool/result',
      seq: 15,
      time: 1_700_000_000_015,
      data: {
        turn: 3,
        step: 1,
        message: {
          source: { kind: 'tool', callId: 'capability-route' },
          role: 'user',
          id: 'route-result',
          content: [],
        },
      },
      surfaceOp: 'append',
    } as unknown as ConversationEvent
    const terminal = {
      type: 'blueprint/capability-authoring',
      seq: 40,
      time: 1_700_000_000_040,
      data: {
        routeId: 'route-1',
        sourceSessionId: 'source-1',
        targetPresetId: 'target-1',
        request: 'add a CSV Skill',
        kind: 'skill',
        baseRevision: 'revision-1',
        state: 'ended',
        startSeq: 16,
        outcome: 'completed',
      },
    } as unknown as ConversationEvent

    expect(blueprintCapabilityRouteTurnPresentationDefinition.match(result)).toBeNull()
    expect(blueprintCapabilityRouteTurnPresentationDefinition.match(terminal)).toBeNull()
  })
})
