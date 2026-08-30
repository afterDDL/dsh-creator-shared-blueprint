/** Real Session event fixtures and the sole timer owner for the Blueprint Demo. */
import { createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm/message'
import { CallId } from '@deepseek-ai/dsh-llm/brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId, TurnEndReason } from '@deepseek-ai/dsh-session/types'
import type { MuxFrame, RpcId } from './api.ts'

/** A real Session event before the fixture carrier assigns `seq` and `time`. */
export type SessionEventFixture = SessionEvent extends infer Event
  ? Event extends SessionEvent ? Omit<Event, 'seq' | 'time'> : never
  : never

/** One real Session event scheduled relative to the start of a scripted turn. */
export interface TimedSessionEventFixture {
  atMs: number
  event: SessionEventFixture
}

function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

function assistantMessage(content: ContentBlock[]) {
  return createAssistantMessage({ content, source: { provider: 'fixture', model: 'blueprint-demo' } })
}

function toolResultMessage(callId: string, content: ContentBlock[], isError: boolean) {
  return createToolResultMessage({ callId: CallId(callId), content, isError })
}

/** Factory for exact Session event fields used by Creator-oriented Demo timelines. */
export const creatorEventFixtures = {
  assistant(turn: number, step: number, content: ContentBlock[]): SessionEventFixture {
    return {
      type: 'assistant/message', surfaceOp: 'append',
      data: { turn, step, message: assistantMessage(content) },
    }
  },
  think(turn: number, step: number, body: string): SessionEventFixture {
    return this.assistant(turn, step, [{ type: 'reasoning', text: body }])
  },
  stepStart(turn: number, step: number): SessionEventFixture {
    return { type: 'step/start', data: { turn, step } }
  },
  stepEnd(turn: number, step: number): SessionEventFixture {
    return { type: 'step/end', data: { turn, step } }
  },
  toolCall(turn: number, step: number, callId: string, name: string, args: Record<string, unknown>): SessionEventFixture {
    return {
      type: 'tool/call',
      data: { turn, step, callId: CallId(callId), name, arguments: JSON.stringify(args) },
    }
  },
  toolResult(
    turn: number,
    step: number,
    callId: string,
    result: string,
    options: { isError?: boolean; meta?: unknown } = {},
  ): SessionEventFixture {
    return {
      type: 'tool/result', surfaceOp: 'append',
      data: {
        turn,
        step,
        message: toolResultMessage(callId, text(result), options.isError ?? false),
        ...(options.meta === undefined ? {} : { meta: options.meta as never }),
      },
    }
  },
  turnEnd(turn: number, reason: TurnEndReason): SessionEventFixture {
    return { type: 'turn/end', data: { turn, reason } }
  },
}

/** Exact live interaction frames used by the production Session pending-state controller. */
export const creatorInteractionFixtures = {
  approvalRequested(
    sessionId: SessionId,
    approvalId: Extract<MuxFrame, { type: 'approval/requested' }>['approvalId'],
    toolName: string,
    reason?: string,
  ): Extract<MuxFrame, { type: 'approval/requested' }> {
    return { type: 'approval/requested', sessionId, approvalId, toolName, ...(reason === undefined ? {} : { reason }) }
  },
  approvalResolved(
    sessionId: SessionId,
    approvalId: Extract<MuxFrame, { type: 'approval/resolved' }>['approvalId'],
    outcome: Extract<MuxFrame, { type: 'approval/resolved' }>['outcome'],
  ): Extract<MuxFrame, { type: 'approval/resolved' }> {
    return { type: 'approval/resolved', sessionId, approvalId, outcome }
  },
  questionRequested(
    sessionId: SessionId,
    questions: Extract<MuxFrame, { type: 'question/requested' }>['questions'],
  ): Extract<MuxFrame, { type: 'question/requested' }> {
    return { type: 'question/requested', sessionId, questions }
  },
  questionResolved(
    sessionId: SessionId,
    questionRpcId: RpcId,
    outcome: Extract<MuxFrame, { type: 'question/resolved' }>['outcome'],
  ): Extract<MuxFrame, { type: 'question/resolved' }> {
    return { type: 'question/resolved', sessionId, questionRpcId, outcome }
  },
}

/**
 * Build one complete tool step with paired real `tool/call` and `tool/result` events.
 * @param atMs - timeline offset for every event in the step.
 * @param turn - turn identity shared by the step events.
 * @param step - step identity shared by the step events.
 * @param name - Tool name recorded by the call and result.
 * @param args - structured Tool arguments.
 * @param result - serialized successful Tool result.
 * @param meta - optional result metadata projected to the Client.
 * @returns ordered fixtures for one complete Tool step.
 */
export function toolStep(
  atMs: number,
  turn: number,
  step: number,
  name: string,
  args: Record<string, unknown>,
  result: string,
  meta?: unknown,
): TimedSessionEventFixture[] {
  const callId = `blueprint-${String(turn)}-${String(step)}-${name}`
  const argumentsRaw = JSON.stringify(args)
  return [
    { atMs, event: creatorEventFixtures.stepStart(turn, step) },
    {
      atMs,
      event: creatorEventFixtures.assistant(turn, step, [{
        type: 'tool-call', id: callId, name, arguments: argumentsRaw,
      } as ContentBlock]),
    },
    { atMs, event: creatorEventFixtures.toolCall(turn, step, callId, name, args) },
    { atMs, event: creatorEventFixtures.toolResult(turn, step, callId, result, { meta }) },
    { atMs, event: creatorEventFixtures.stepEnd(turn, step) },
  ]
}

/**
 * Build the supported terminal turn outcomes for a fixture turn.
 * @param turn - turn identity recorded by each outcome.
 * @returns terminal event fixtures keyed by outcome.
 */
export function outcomeFixtures(turn: number): Record<'success' | 'failure' | 'cancelled', SessionEventFixture> {
  return {
    success: creatorEventFixtures.turnEnd(turn, { kind: 'completed' }),
    failure: creatorEventFixtures.turnEnd(turn, {
      kind: 'error', error: { code: 'UNKNOWN', message: 'fixture failure' },
    }),
    cancelled: creatorEventFixtures.turnEnd(turn, { kind: 'aborted', reason: { kind: 'user' } }),
  }
}

/** Plays timed real events; scenario declarations contain no timer calls. */
export class BlueprintDemoSessionPlayer {
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()

  constructor(private readonly append: (sessionId: SessionId, event: SessionEventFixture) => void) {}

  /**
   * Schedule one callback and forget its timer after it fires.
   * @param delayMs - delay before the callback runs.
   * @param action - callback to run once.
   */
  schedule(delayMs: number, action: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      action()
    }, delayMs)
    this.timers.add(timer)
  }

  /**
   * Play a timeline of real Session events against one fixture Session.
   * @param sessionId - fixture Session receiving the events.
   * @param timeline - ordered events and their playback offsets.
   */
  play(sessionId: SessionId, timeline: readonly TimedSessionEventFixture[]): void {
    for (const item of timeline) this.schedule(item.atMs, () => { this.append(sessionId, item.event) })
  }

  /** Cancel callbacks when the fixture world is disposed. */
  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }
}
