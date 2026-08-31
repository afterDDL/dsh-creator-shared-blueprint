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
  blueprintCreatorTurnPresentationDefinition, blueprintDirectCreatorRequestDefinition,
  blueprintLegacyCreatorPresetResolveDefinition, blueprintLegacyCreatorPresetValidateDefinition,
} from '../src/client/creator-turn-presentation.ts'
import { creatorObservation, inject } from '../src/client/index.ts'

type ConversationEvent = Parameters<ConversationNodeDefinition['match']>[0]

const ACTUAL_CREATOR_REQUEST = '请创建一个名为「轻薄本研究预发布 Agent」的新 Agent preset，用于研究轻薄本的性能、价格、重量、续航、接口与适用人群，输出结构化对比与来源。请实际完成 preset 创建与验证。'

const ACTUAL_PRESET_COPY_ARGUMENTS = '{"from": "standard", "id": "light-laptop-research", "name": "轻薄本研究预发布 Agent"}'

const DEFINITIONS: readonly ConversationNodeDefinition[] = [
  messageDefinition,
  blueprintDirectCreatorRequestDefinition,
  blueprintLegacyCreatorPresetValidateDefinition,
  blueprintLegacyCreatorPresetResolveDefinition,
  blueprintCreatorTurnPresentationDefinition,
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
      time: 1_788_116_525_000 + seq,
      data,
      ...extra,
    } as ConversationEvent,
    view: undefined,
  }
}

function userMessage(id: string, text: string) {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user', rpcId: 'actual-create-rpc', clientTimeZone: 'Asia/Shanghai' },
  }
}

function contextMessage(id: string, text: string, source: Record<string, unknown>) {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source,
  }
}

function assistantMessage(id: string, content: readonly { readonly type: string; readonly text: string }[]) {
  return {
    id,
    role: 'assistant',
    content,
    source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  }
}

function toolResult(callId: string, text: string) {
  return {
    id: `result-${callId}`,
    role: 'user',
    source: { kind: 'tool', callId },
    content: [{
      type: 'tool-result',
      toolCallId: callId,
      content: [{ type: 'text', text }],
      isError: false,
    }],
  }
}

function requestHeader(tools: readonly string[]) {
  return {
    reason: 'initial',
    header: {
      config: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' },
      tools: tools.map(name => ({
        name,
        description: `${name} tool`,
        parameters: { type: 'object', properties: {} },
      })),
    },
  }
}

function actualCreatorTurn(request = ACTUAL_CREATOR_REQUEST): readonly ConversationEventInput[] {
  const copyCallId = 'call_00_GTJIdxm00Xm1uV6771Oe9580'
  return [
    at(5, 'turn/start', { turn: 1 }),
    at(7, 'step/start', { turn: 1, step: 1 }),
    at(8, 'user/message', userMessage(
      'e5bcc3dc-c8b9-4699-aea2-270044cdf561',
      request,
    ), { surfaceOp: 'append' }),
    at(13, 'request/header', requestHeader(['preset_list', 'preset_copy', 'preset_read', 'preset_validate'])),
    at(17, 'assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'block-start', index: 0, blockType: 'reasoning' },
    }),
    at(18, 'assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'reasoning-delta', index: 0, text: 'I will author the preset.' },
    }),
    at(899, 'assistant/message', {
      turn: 1,
      step: 1,
      message: assistantMessage('assistant-think', [{ type: 'reasoning', text: 'I will author the preset.' }]),
    }, { surfaceOp: 'append' }),
    at(900, 'step/end', { turn: 1, step: 1 }),
    at(931, 'step/start', { turn: 1, step: 2 }),
    at(932, 'tool/call', {
      turn: 1,
      step: 2,
      callId: copyCallId,
      name: 'preset_copy',
      arguments: ACTUAL_PRESET_COPY_ARGUMENTS,
    }),
    at(933, 'tool/result', {
      turn: 1,
      step: 2,
      message: toolResult(copyCallId, '{"preset":{"id":"light-laptop-research"}}'),
    }, { sourceEventSeqs: [932], surfaceOp: 'append' }),
    at(934, 'step/end', { turn: 1, step: 2 }),
    at(5_395, 'step/start', { turn: 1, step: 9 }),
    at(6_012, 'assistant/message', {
      turn: 1,
      step: 9,
      message: assistantMessage('assistant-final', [
        { type: 'reasoning', text: 'Everything is in place; expose paths and mount prose.' },
        { type: 'text', text: '创建与验证完成。mounted OK for light-laptop-research.' },
      ]),
    }, { surfaceOp: 'append' }),
    at(6_013, 'step/end', { turn: 1, step: 9 }),
    at(6_014, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
}

function presetToolCall(
  seq: number,
  name: 'preset_validate' | 'preset_resolve',
  id: string,
  callId = `${name}-${id}`,
): ConversationEventInput {
  return at(seq, 'tool/call', {
    turn: 1, step: 7, callId, name, arguments: JSON.stringify({ id }),
  })
}

function compositionReadCall(
  seq: number,
  id: string,
  callId = `read-${id}`,
): ConversationEventInput {
  return at(seq, 'tool/call', {
    turn: 1,
    step: 8,
    callId,
    name: 'read',
    arguments: JSON.stringify({
      file_path: `C:\\workspace\\.agent-presets\\${id}\\agent.cordis.yml`,
      limit: 45,
    }),
  })
}

function pagedCreatorSuffix(options: {
  readonly validateId?: string
  readonly resolveId?: string
  readonly readId?: string
  readonly includeResolve?: boolean
} = {}): readonly ConversationEventInput[] {
  const validateId = options.validateId ?? 'light-laptop-research'
  const resolveId = options.resolveId ?? validateId
  const readId = options.readId ?? validateId
  const validateCallId = `validate-${validateId}`
  const resolveCallId = `resolve-${resolveId}`
  const readCallId = `read-${readId}`
  return [
    at(100, 'step/start', { turn: 1, step: 7 }),
    at(101, 'assistant/message', {
      turn: 1,
      step: 7,
      message: assistantMessage('paged-validation', [{
        type: 'text', text: '现在进行挂载验证并确认 roster 元数据。',
      }]),
    }, { surfaceOp: 'append' }),
    presetToolCall(102, 'preset_validate', validateId, validateCallId),
    at(103, 'tool/result', {
      turn: 1, step: 7, message: toolResult(validateCallId, `mounted OK for ${validateId}`),
    }, { sourceEventSeqs: [102], surfaceOp: 'append' }),
    ...(options.includeResolve === false ? [] : [
      presetToolCall(104, 'preset_resolve', resolveId, resolveCallId),
      at(105, 'tool/result', {
        turn: 1, step: 7, message: toolResult(resolveCallId, JSON.stringify({ preset: { id: resolveId } })),
      }, { sourceEventSeqs: [104], surfaceOp: 'append' }),
    ]),
    at(106, 'step/end', { turn: 1, step: 7 }),
    at(107, 'step/start', { turn: 1, step: 8 }),
    compositionReadCall(108, readId, readCallId),
    at(109, 'tool/result', {
      turn: 1, step: 8, message: toolResult(readCallId, 'formal composition'),
    }, { sourceEventSeqs: [108], surfaceOp: 'append' }),
    at(110, 'step/end', { turn: 1, step: 8 }),
    at(111, 'step/start', { turn: 1, step: 9 }),
    at(112, 'assistant/message', {
      turn: 1,
      step: 9,
      message: assistantMessage('paged-final', [{ type: 'text', text: '创建与验证完成。' }]),
    }, { surfaceOp: 'append' }),
    at(113, 'step/end', { turn: 1, step: 9 }),
    at(114, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
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

function visibleAssistantBlocks(value: ChatSnapshot, turn: number): readonly {
  readonly kind: string
  readonly text?: string
}[] {
  return turnNodes(value, turn).flatMap((node) => {
    if (node.visibility !== 'visible' || node.kind !== 'assistant-step') return []
    return (node.data as {
      readonly blocks: readonly { readonly kind: string; readonly text?: string }[]
    }).blocks
  })
}

function contextSnapshot(
  text: string,
  options: {
    readonly name?: string
    readonly plugin?: string
    readonly surfaceOp?: 'append' | { readonly op: 'replace'; readonly start: number; readonly end: number }
  } = {},
): ConversationEvent {
  return {
    type: 'user/message',
    seq: 12,
    time: 1_700_000_000_012,
    data: {
      id: 'runtime-context-12',
      role: 'user',
      content: [{ type: 'text', text }],
      source: {
        kind: 'plugin',
        plugin: options.plugin ?? '@deepseek-ai/dsh-system-prompt',
        form: 'snapshot',
        sections: [{ name: options.name ?? 'blueprint:conversation', text }],
      },
    },
    surfaceOp: options.surfaceOp ?? 'append',
  } as unknown as ConversationEvent
}

describe('Blueprint Creator Turn presentation', () => {
  it('waits for the Conversation registry before the assembled Blueprint apply runs', () => {
    expect(inject).toContain('conversationEvents')
  })

  it('preserves ordinary Assistant conversation while suppressing Creator Context and Tool rows', () => {
    const value = createAssembler()
    value.replaceWindow(actualCreatorTurn(
      '创建一个“研究生项目选择 Agent”，比较课程、学费与就业方向。',
    ), false)
    value.flush()

    const current = snapshot(value)
    expect(visibleKinds(current, 1)).toEqual(expect.arrayContaining([
      'user', 'assistant-step', 'turn-tail',
    ]))
    expect(visibleKinds(current, 1)).not.toContain('tool-call')
    expect(visibleAssistantBlocks(current, 1)).toEqual(expect.arrayContaining([
      { kind: 'reasoning', text: 'I will author the preset.' },
      { kind: 'reasoning', text: 'Everything is in place; expose paths and mount prose.' },
      { kind: 'text', text: '创建与验证完成。mounted OK for light-laptop-research.' },
    ]))
  })

  it('matches only the exact direct Creator runtime-context section', () => {
    const creator = contextSnapshot([
      'Interactive Blueprint Creator authoring context.',
      'Continue authoring the current Agent preset.',
    ].join('\n'))
    expect(blueprintCreatorTurnPresentationDefinition.match(creator)).toEqual({
      id: 'runtime-context-12',
      role: 'start',
    })

    expect(blueprintCreatorTurnPresentationDefinition.match(contextSnapshot(
      'Interactive Blueprint conversation context.\nPropose an existing-Agent edit.',
    ))).toBeNull()
    expect(blueprintCreatorTurnPresentationDefinition.match(contextSnapshot(
      'Interactive Blueprint capability authoring context.\nAuthor one isolated candidate.',
    ))).toBeNull()
    expect(blueprintCreatorTurnPresentationDefinition.match(contextSnapshot(
      'Interactive Blueprint Creator authoring context.\nContinue authoring.',
      { name: 'another:section' },
    ))).toBeNull()
  })

  it('rejects lookalike sources and replacement-only model context', () => {
    const creatorText = 'Interactive Blueprint Creator authoring context.\nContinue authoring.'
    expect(blueprintCreatorTurnPresentationDefinition.match(contextSnapshot(
      creatorText,
      { plugin: 'another-system-prompt' },
    ))).toBeNull()
    expect(blueprintCreatorTurnPresentationDefinition.match(contextSnapshot(
      creatorText,
      { surfaceOp: { op: 'replace', start: 1, end: 1 } },
    ))).toBeNull()
    expect(blueprintCreatorTurnPresentationDefinition.match(contextSnapshot(
      'Interactive Blueprint Creator authoring context. lookalike suffix',
    ))).toBeNull()
  })

  it('shows direct Creator Assistant output as it arrives and preserves it across refresh', () => {
    const entries = actualCreatorTurn()
    const headerIndex = entries.findIndex(entry => entry.event.seq === 13)
    expect(headerIndex).toBeGreaterThan(0)
    const value = createAssembler()
    value.replaceWindow(entries.slice(0, headerIndex), false)
    value.flush()
    expect(visibleKinds(snapshot(value), 1)).toEqual(['user'])

    value.append(entries[headerIndex]!)
    value.flush()
    expect(visibleKinds(snapshot(value), 1)).toEqual(['user'])
    expect(turnNodes(snapshot(value), 1).find(node => node.kind === 'blueprint-creator-turn-presentation'))
      .toMatchObject({ visibility: 'hidden' })

    value.append(entries[headerIndex + 1]!)
    value.flush()
    expect(visibleKinds(snapshot(value), 1)).toEqual(['user'])

    value.append(entries[headerIndex + 2]!)
    value.flush()
    expect(visibleKinds(snapshot(value), 1)).toEqual(['user', 'assistant-step'])
    expect(visibleAssistantBlocks(snapshot(value), 1)).toContainEqual({
      kind: 'reasoning', text: 'I will author the preset.',
    })

    for (const entry of entries.slice(headerIndex + 3)) value.append(entry)
    value.flush()
    const settled = snapshot(value)
    expect(visibleKinds(settled, 1)).toEqual(expect.arrayContaining([
      'user', 'assistant-step', 'turn-tail',
    ]))
    expect(visibleKinds(settled, 1)).not.toContain('tool-call')
    expect(visibleAssistantBlocks(settled, 1)).toEqual(expect.arrayContaining([
      { kind: 'reasoning', text: 'I will author the preset.' },
      { kind: 'reasoning', text: 'Everything is in place; expose paths and mount prose.' },
      { kind: 'text', text: '创建与验证完成。mounted OK for light-laptop-research.' },
    ]))
    expect(turnNodes(settled, 1).find(node => node.kind === 'blueprint-creator-turn-presentation'))
      .toMatchObject({
        visibility: 'hidden',
        data: {
          internalTurnPresentation: 'implementation-only',
          assistantPresentation: 'assistant-visible',
        },
      })
    expect(settled.legacy.nodes.map(node => node.kind)).toEqual(['user', 'assistant', 'assistant'])

    value.replaceWindow(entries, false)
    value.flush()
    const refreshed = snapshot(value)
    expect(visibleKinds(refreshed, 1)).toEqual(expect.arrayContaining([
      'user', 'assistant-step', 'turn-tail',
    ]))
    expect(visibleKinds(refreshed, 1)).not.toContain('tool-call')
    expect(visibleAssistantBlocks(refreshed, 1)).toEqual(visibleAssistantBlocks(settled, 1))
    expect(refreshed.legacy.nodes.map(node => node.kind)).toEqual(['user', 'assistant', 'assistant'])
    const observation = creatorObservation('source-creator' as SessionId, 'cordis', {
      sessionId: 'source-creator', chat: refreshed, nodes: refreshed.legacy.nodes,
      pending: [], running: false, removed: false,
    } as unknown as ConversationSnapshot)
    expect(observation.userMessages).toEqual([{ seq: 8, text: ACTUAL_CREATOR_REQUEST }])
    expect(observation.presetCopies).toEqual([{
      seq: 933, sourcePresetId: 'standard', targetPresetId: 'light-laptop-research',
    }])
    expect(observation.authoredPresets).toContainEqual({ seq: 933, presetId: 'light-laptop-research' })
  })

  it('suppresses Context and Tool rows while retaining paged Creator Assistant conversation', () => {
    const value = createAssembler()
    value.replaceWindow([
      at(8, 'user/message', userMessage('paged-create-request', ACTUAL_CREATOR_REQUEST), {
        surfaceOp: 'append',
      }),
      at(9, 'user/message', contextMessage('paged-instructions', 'workspace instructions', {
        kind: 'agent-instructions',
        form: 'instructions',
        changes: [{ path: 'AGENTS.md' }, { path: 'CLAUDE.md' }],
      }), { surfaceOp: 'append' }),
      at(10, 'user/message', contextMessage('paged-runtime-context', 'runtime context', {
        kind: 'plugin',
        plugin: '@deepseek-ai/dsh-system-prompt',
        form: 'snapshot',
        sections: [{ name: 'sandbox:policy', text: 'runtime context' }],
      }), { surfaceOp: 'append' }),
      at(11, 'user/message', contextMessage('paged-skill-catalog', 'skill catalog', {
        kind: 'skill-catalog',
        form: 'catalog',
        entries: [{ name: 'cordis-plugin-development', description: 'author Cordis plugins' }],
      }), { surfaceOp: 'append' }),
      at(13, 'request/header', requestHeader(['preset_list', 'preset_copy', 'preset_validate'])),
      at(17, 'assistant/message', {
        turn: 1,
        step: 1,
        message: assistantMessage('paged-creator-analysis', [{
          type: 'reasoning', text: 'private preset analysis',
        }]),
      }, { surfaceOp: 'append' }),
      at(18, 'step/end', { turn: 1, step: 1 }),
      at(19, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ], true)
    value.flush()

    const current = snapshot(value)
    expect(visibleKinds(current, 1)).toEqual(expect.arrayContaining([
      'user', 'assistant-step', 'turn-tail',
    ]))
    expect(visibleKinds(current, 1)).not.toContain('context')
    expect(turnNodes(current, 1).filter(node => node.kind === 'context'))
      .toHaveLength(3)
    expect(turnNodes(current, 1).filter(node => node.kind === 'context')
      .every(node => node.visibility === 'hidden')).toBe(true)
    expect(visibleAssistantBlocks(current, 1)).toContainEqual({
      kind: 'reasoning', text: 'private preset analysis',
    })
    expect(current.legacy.nodes.map(node => node.kind)).toEqual(['user', 'assistant'])

    value.prepend([
      at(5, 'turn/start', { turn: 1 }),
      at(7, 'step/start', { turn: 1, step: 1 }),
    ], false)
    value.flush()

    const complete = snapshot(value)
    expect(visibleKinds(complete, 1)).toEqual(expect.arrayContaining([
      'user', 'assistant-step', 'turn-tail',
    ]))
    expect(visibleKinds(complete, 1)).not.toContain('context')
    expect(complete.legacy.nodes.map(node => node.kind)).toEqual(['user', 'assistant'])
  })

  it('keeps an ordinary truncated Turn context visible without exact Creator evidence', () => {
    const value = createAssembler()
    value.replaceWindow([
      at(8, 'user/message', userMessage('ordinary-request', '请解释当前 Agent 的用途。'), {
        surfaceOp: 'append',
      }),
      at(9, 'user/message', contextMessage('ordinary-context', 'ordinary runtime context', {
        kind: 'plugin',
        plugin: '@deepseek-ai/dsh-system-prompt',
        form: 'snapshot',
        sections: [{ name: 'sandbox:policy', text: 'ordinary runtime context' }],
      }), { surfaceOp: 'append' }),
      at(13, 'request/header', requestHeader(['preset_list', 'preset_copy', 'preset_validate'])),
      at(17, 'assistant/message', {
        turn: 1,
        step: 1,
        message: assistantMessage('ordinary-answer', [{ type: 'text', text: 'ordinary answer' }]),
      }, { surfaceOp: 'append' }),
      at(18, 'step/end', { turn: 1, step: 1 }),
      at(19, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ], true)
    value.flush()

    expect(visibleKinds(snapshot(value), 1)).toEqual([
      'user', 'context', 'assistant-step', 'turn-tail',
    ])
  })

  it('preserves legacy Creator Assistant conversation while hiding its Tool rows', () => {
    const value = createAssembler()
    value.replaceWindow(pagedCreatorSuffix(), true)
    value.flush()

    const current = snapshot(value)
    expect(visibleKinds(current, 1)).toEqual(expect.arrayContaining(['assistant-step', 'turn-tail']))
    expect(visibleKinds(current, 1)).not.toContain('tool-call')
    expect(visibleAssistantBlocks(current, 1)).toEqual(expect.arrayContaining([
      { kind: 'text', text: '现在进行挂载验证并确认 roster 元数据。' },
      { kind: 'text', text: '创建与验证完成。' },
    ]))
    expect(turnNodes(current, 1).find(node => node.id === 'read-light-laptop-research'))
      .toMatchObject({
        kind: 'blueprint-creator-turn-presentation',
        visibility: 'hidden',
        data: {
          internalTurnPresentation: 'implementation-only',
          assistantPresentation: 'assistant-visible',
        },
      })
  })

  it('keeps a complete ordinary preset-validation Turn visible', () => {
    const value = createAssembler()
    value.replaceWindow([
      at(90, 'turn/start', { turn: 1 }),
      at(91, 'step/start', { turn: 1, step: 1 }),
      at(92, 'user/message', userMessage('ordinary-validation', '请检查现有 preset 是否可挂载。'), {
        surfaceOp: 'append',
      }),
      at(93, 'step/end', { turn: 1, step: 1 }),
      ...pagedCreatorSuffix(),
    ], false)
    value.flush()

    const current = snapshot(value)
    expect(turnNodes(current, 1)
      .filter(node => node.kind !== 'blueprint-creator-turn-presentation')
      .every(node => node.visibility === 'visible')).toBe(true)
    expect(turnNodes(current, 1).find(node => node.id === 'read-light-laptop-research'))
      .toMatchObject({ data: {} })
  })

  it('does not classify a truncated validate-only Turn as legacy Creator authoring', () => {
    const value = createAssembler()
    value.replaceWindow(pagedCreatorSuffix({ includeResolve: false }), true)
    value.flush()

    const current = snapshot(value)
    expect(visibleKinds(current, 1)).toContain('assistant-step')
    expect(turnNodes(current, 1).find(node => node.id === 'read-light-laptop-research'))
      .toMatchObject({ data: {} })
  })

  it('does not classify mismatched validate and resolve ids as legacy Creator authoring', () => {
    const value = createAssembler()
    value.replaceWindow(pagedCreatorSuffix({ resolveId: 'another-preset' }), true)
    value.flush()

    const current = snapshot(value)
    expect(visibleKinds(current, 1)).toContain('assistant-step')
    expect(turnNodes(current, 1).find(node => node.id === 'read-light-laptop-research'))
      .toMatchObject({ data: {} })
  })

  it('keeps the legacy marker inert while prepended exact evidence takes over presentation', () => {
    const value = createAssembler()
    value.replaceWindow(pagedCreatorSuffix(), true)
    value.flush()
    expect(visibleKinds(snapshot(value), 1)).toEqual(expect.arrayContaining(['assistant-step', 'turn-tail']))
    expect(visibleKinds(snapshot(value), 1)).not.toContain('tool-call')

    expect(() => {
      value.prepend([
        ...actualCreatorTurn().slice(0, 3),
        { event: contextSnapshot([
          'Interactive Blueprint Creator authoring context.',
          'Continue authoring the current Agent preset.',
        ].join('\n')), view: undefined },
      ], false)
      value.flush()
    }).not.toThrow()

    const current = snapshot(value)
    expect(visibleKinds(current, 1)).toEqual(expect.arrayContaining([
      'user', 'assistant-step', 'turn-tail',
    ]))
    expect(visibleKinds(current, 1)).not.toContain('tool-call')
    const markers = turnNodes(current, 1)
      .filter(node => node.kind === 'blueprint-creator-turn-presentation')
    expect(markers.find(node => node.id === 'read-light-laptop-research')).toMatchObject({ data: {} })
    expect(markers.some(node => (
      node.data as {
        readonly internalTurnPresentation?: string
        readonly assistantPresentation?: string
      }
    ).internalTurnPresentation === 'implementation-only'
      && (node.data as { readonly assistantPresentation?: string }).assistantPresentation === 'assistant-visible'))
      .toBe(true)
  })

  it('requires a same-Turn direct request for the early schema and retains exact copy evidence for paged refresh', () => {
    const request = actualCreatorTurn().slice(0, 3)
    const header = actualCreatorTurn().find(entry => entry.event.seq === 13)
    const copy = actualCreatorTurn().find(entry => entry.event.seq === 932)
    if (header === undefined || copy === undefined) throw new Error('actual Creator fixture is incomplete')

    const headerWithoutRequest = createAssembler()
    headerWithoutRequest.replaceWindow([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      { ...header, event: { ...header.event, seq: 3 } },
    ], false)
    headerWithoutRequest.flush()
    expect(turnNodes(snapshot(headerWithoutRequest), 1)
      .some(node => node.kind === 'blueprint-creator-turn-presentation'))
      .toBe(false)

    const headerWithoutSchema = createAssembler()
    headerWithoutSchema.replaceWindow([
      ...request,
      at(13, 'request/header', requestHeader(['preset_list', 'preset_read', 'preset_validate'])),
    ], false)
    headerWithoutSchema.flush()
    expect(turnNodes(snapshot(headerWithoutSchema), 1)
      .some(node => node.kind === 'blueprint-creator-turn-presentation'))
      .toBe(false)

    const requestFromAnotherTurn = createAssembler()
    requestFromAnotherTurn.replaceWindow([
      ...request,
      at(9, 'step/end', { turn: 1, step: 1 }),
      at(10, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      at(11, 'turn/start', { turn: 2 }),
      at(12, 'step/start', { turn: 2, step: 1 }),
      { ...header, event: { ...header.event, seq: 13 } },
    ], false)
    requestFromAnotherTurn.flush()
    expect(turnNodes(snapshot(requestFromAnotherTurn), 2)
      .some(node => node.kind === 'blueprint-creator-turn-presentation'))
      .toBe(false)

    const copyWithoutRequest = createAssembler()
    copyWithoutRequest.replaceWindow([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      { ...copy, event: { ...copy.event, seq: 3, data: { ...copy.event.data, turn: 1, step: 1 } } as ConversationEvent },
    ], false)
    copyWithoutRequest.flush()
    expect(turnNodes(snapshot(copyWithoutRequest), 1)
      .some(node => node.kind === 'blueprint-creator-turn-presentation'))
      .toBe(true)

    expect(blueprintCreatorTurnPresentationDefinition.match({
      ...copy.event,
      data: { ...copy.event.data, arguments: '{"from":"standard"}' },
    } as ConversationEvent)).toBeNull()
  })
})
