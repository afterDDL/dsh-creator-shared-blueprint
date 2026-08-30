import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  BlueprintDemoSessionPlayer, creatorEventFixtures, creatorInteractionFixtures,
  outcomeFixtures, toolStep,
} from '../src/client/blueprint-demo-events.ts'

afterEach(() => { vi.useRealTimers() })

describe('Blueprint Demo Creator event fixtures', () => {
  it('uses the durable Assistant and paired Tool event fields consumed by the real conversation renderer', () => {
    const think = creatorEventFixtures.think(2, 0, 'inspect the preset')
    const read = toolStep(100, 2, 1, 'read', { file_path: 'README.md' }, 'contents')
    const pwsh = toolStep(200, 2, 2, 'pwsh', { command: 'Get-ChildItem' }, 'files')
    const cordis = toolStep(300, 2, 3, 'cordis_define', { type: 'agent-preset' }, 'defined')
    const question = toolStep(400, 2, 4, 'ask_user_question', {
      questions: [{ id: 'strategy', question: 'Reuse or create?' }],
    }, '{"answers":[]}')

    expect(think).toMatchObject({ type: 'assistant/message', data: { turn: 2, step: 0 } })
    expect([read, pwsh, cordis, question].map(events => events.map(item => item.event.type))).toEqual([
      ['step/start', 'assistant/message', 'tool/call', 'tool/result', 'step/end'],
      ['step/start', 'assistant/message', 'tool/call', 'tool/result', 'step/end'],
      ['step/start', 'assistant/message', 'tool/call', 'tool/result', 'step/end'],
      ['step/start', 'assistant/message', 'tool/call', 'tool/result', 'step/end'],
    ])
    expect([read, pwsh, cordis, question].map((events) => {
      const call = events.find(item => item.event.type === 'tool/call')?.event
      return call?.type === 'tool/call' ? call.data.name : undefined
    })).toEqual(['read', 'pwsh', 'cordis_define', 'ask_user_question'])
  })

  it('uses the production pending-interaction frame fields for questions and approvals', () => {
    const sessionId = SessionId('creator-1')
    const approval = creatorInteractionFixtures.approvalRequested(
      sessionId, 'approval-1' as never, 'write', 'write the Skill file',
    )
    const question = creatorInteractionFixtures.questionRequested(sessionId, [{
      id: 'strategy', question: 'How should the preset be created?', options: [{ label: 'Create' }],
    }])

    expect(approval).toEqual({
      type: 'approval/requested', sessionId, approvalId: 'approval-1',
      toolName: 'write', reason: 'write the Skill file',
    })
    expect(question).toMatchObject({ type: 'question/requested', sessionId })
    expect(creatorInteractionFixtures.approvalResolved(
      sessionId, 'approval-1' as never, 'rejected',
    )).toMatchObject({ type: 'approval/resolved', outcome: 'rejected' })
    expect(creatorInteractionFixtures.questionResolved(
      sessionId, 'question-rpc' as never, 'cancelled',
    )).toMatchObject({ type: 'question/resolved', outcome: 'cancelled' })
  })

  it('keeps success, failure, and cancellation as real turn-end reasons', () => {
    const outcomes = outcomeFixtures(4)
    expect(outcomes.success).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    expect(outcomes.failure).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error' } } })
    expect(outcomes.cancelled).toMatchObject({
      type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } },
    })
  })

  it('centralizes timeline scheduling and cancels outstanding fixture callbacks', () => {
    vi.useFakeTimers()
    const appended: string[] = []
    const player = new BlueprintDemoSessionPlayer((_sessionId, event) => { appended.push(event.type) })
    const sessionId = SessionId('creator-1')
    player.play(sessionId, toolStep(100, 1, 0, 'read', { file_path: 'README.md' }, 'contents'))

    vi.advanceTimersByTime(100)
    expect(appended).toEqual(['step/start', 'assistant/message', 'tool/call', 'tool/result', 'step/end'])

    player.play(sessionId, toolStep(200, 1, 1, 'pwsh', { command: 'pwd' }, 'cwd'))
    player.dispose()
    vi.advanceTimersByTime(200)
    expect(appended).toHaveLength(5)
  })
})
