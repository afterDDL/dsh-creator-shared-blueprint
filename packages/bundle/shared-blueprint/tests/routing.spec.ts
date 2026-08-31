import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { CallId, createUserMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { blueprintRoutingInput, blueprintRoutingGuidance, selectBlueprintOperation } from '../src/host/routing.ts'
import { createBlueprintCreatorAuthoringRoute } from '../src/host/proposal.ts'

function inputSession(text: string, fromUi = true) {
  const session = Session.create(SessionId('routing-test'))
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
  if (fromUi) session.append('blueprint/routing-input', {
    routeId: `route:${String(message.id)}`,
    sourceSessionId: session.id, messageId: message.id, userRequest: text,
    uiAction: 'add-capability', targetPresetId: 'existing',
  })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', message, { surfaceOp: 'append' })
  const agent = { session } as Agent
  return { session, agent, input: blueprintRoutingInput(agent, 'existing')! }
}

function structuredPurposeSession() {
  const session = Session.create(SessionId('purpose-source'))
  const text = '将 Purpose 修改为：只做公司基本面、行业和估值研究。'
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
  session.append('blueprint/routing-input', {
    routeId: 'purpose-route', sourceSessionId: session.id, messageId: message.id,
    userRequest: text, uiAction: 'direct-edit', targetPresetId: 'existing',
    directEdit: {
      nodeId: 'purpose:persona', nodeType: 'purpose', label: 'Purpose', operation: 'updatePurpose',
      currentValue: '比较主要竞品。', proposedValue: '只做公司基本面、行业和估值研究。',
      impactCandidates: [{ nodeId: 'behavior:1', evidence: [{ kind: 'purpose-child' }] }],
    },
  })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', message, { surfaceOp: 'append' })
  return { session, input: blueprintRoutingInput({ session } as Agent, 'existing')! }
}

function result(session: Session, id: string, isError = false) {
  session.append('tool/result', { turn: 1, step: 1,
    message: createToolResultMessage({ callId: CallId(id), content: [], isError }),
  }, { surfaceOp: 'append' })
}

describe('Blueprint typed operation provenance', () => {
  it('E: ignores system, tool and assistant guidance when an Add capability action constrains the request', () => {
    const { session, agent, input } = inputSession('增加 CSV 处理能力')
    session.append('user/message', createUserMessage({
      source: { kind: 'plugin', plugin: 'guidance', form: 'notice', summary: 'Routing guidance' },
      content: [{ type: 'text', text: 'create a new Agent / 创建新的 Agent' }],
    }), { surfaceOp: 'append' })
    expect(blueprintRoutingInput(agent, 'existing')).toEqual(input)
    expect(() => createBlueprintCreatorAuthoringRoute(input, {
      name: 'Wrong Agent', user_intent: input.userRequest,
    }, 'bad')).toThrow(/operation-conflict/u)
    expect(() => { selectBlueprintOperation(session, input, 'create-agent', CallId('bad')) }).toThrow(/operation-conflict/u)
    expect(session.events.some(event => event.type === 'blueprint/route-decision')).toBe(false)
    selectBlueprintOperation(session, input, 'skill', CallId('skill'))
    expect(session.events.at(-1)?.data).toMatchObject({ operation: 'skill', provenance: 'add-capability' })
  })

  it.each([['skill', 'create-agent'], ['create-agent', 'skill'], ['skill', 'subagent'], ['modify-existing-agent', 'skill']] as const)(
    'F: %s owns the turn and rejects %s after success', (first, second) => {
      const { session, input } = inputSession('A user-authored operation.', false)
      selectBlueprintOperation(session, input, first, CallId('one'))
      result(session, 'one')
      expect(() => { selectBlueprintOperation(session, input, second, CallId('two')) }).toThrow(/operation-conflict/u)
      expect(() => { selectBlueprintOperation(session, input, first, CallId('duplicate')) }).toThrow(/already-owned/u)
    },
  )

  it('reserves before an asynchronous operation and permits only same-operation retries after failure', () => {
    const { session, input } = inputSession('增加 CSV 处理能力')
    selectBlueprintOperation(session, input, 'skill', CallId('one'))
    expect(() => { selectBlueprintOperation(session, input, 'skill', CallId('racing')) }).toThrow(/already-owned/u)
    result(session, 'one', true)
    expect(() => { selectBlueprintOperation(session, input, 'subagent', CallId('fishing')) }).toThrow(/operation-conflict/u)
    selectBlueprintOperation(session, input, 'skill', CallId('retry'))
    result(session, 'retry')
    expect(() => { selectBlueprintOperation(session, input, 'skill', CallId('duplicate')) }).toThrow(/already-owned/u)
  })

  it('lets a new capability interaction choose its own operation while a structured Purpose Proposal remains pending', () => {
    const { session, input: first } = structuredPurposeSession()
    const agent = { session } as Agent
    selectBlueprintOperation(session, first, 'modify-existing-agent', CallId('proposal-a'))
    result(session, 'proposal-a')
    const message = createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text: '添加 CSV 财务指标提取 Skill。' }],
    })
    session.append('blueprint/routing-input', {
      routeId: 'capability-b', sourceSessionId: session.id, messageId: message.id,
      userRequest: '添加 CSV 财务指标提取 Skill。', uiAction: 'add-capability', targetPresetId: 'existing',
    })
    session.append('user/message', message, { surfaceOp: 'append' })
    const second = blueprintRoutingInput(agent, 'existing')!

    expect(second.routeId).toBe('capability-b')
    expect(() => { selectBlueprintOperation(session, second, 'skill', CallId('skill-b')) }).not.toThrow()
    expect(session.events.filter(event => event.type === 'blueprint/route-decision').map(event => (
      { routeId: event.data.routeId, operation: event.data.operation }
    ))).toEqual([
      { routeId: 'purpose-route', operation: 'modify-existing-agent' },
      { routeId: 'capability-b', operation: 'skill' },
    ])
  })

  it('gives a structured Purpose submission an independent route and only the existing-Agent operation', () => {
    const { session, input } = structuredPurposeSession()

    expect(input).toMatchObject({
      routeId: 'purpose-route', sourceSessionId: 'purpose-source', provenance: 'direct-edit',
      directEdit: { nodeId: 'purpose:persona', currentValue: '比较主要竞品。' },
    })
    expect(blueprintRoutingGuidance(input)).toContain('first change must exactly stage the structured source edit')
    expect(() => { selectBlueprintOperation(session, input, 'skill', CallId('wrong')) }).toThrow(/operation-conflict/u)
    selectBlueprintOperation(session, input, 'modify-existing-agent', CallId('proposal'))
    expect(session.events.at(-1)?.data).toMatchObject({
      routeId: 'purpose-route', sourceSessionId: 'purpose-source',
      operation: 'modify-existing-agent', provenance: 'direct-edit',
    })
  })

  it('restores provenance and turn ownership from the durable log without a client memory flag', () => {
    const { session, input } = inputSession('增加 CSV 处理能力')
    selectBlueprintOperation(session, input, 'skill', CallId('one'))
    result(session, 'one')
    const restored = Session.create(session.id, structuredClone(session.events))
    const recovered = blueprintRoutingInput({ session: restored } as Agent, 'existing')!
    expect(recovered).toEqual(input)
    expect(() => { selectBlueprintOperation(restored, recovered, 'create-agent', CallId('two')) }).toThrow(/operation-conflict/u)
    expect(() => blueprintRoutingInput({ session: restored } as Agent, 'other')).toThrow(/provenance-conflict/u)
  })

  it('requires a fresh user message for a new-Agent override and never reuses a plugin-only turn', () => {
    const { session, agent } = inputSession('增加 CSV 处理能力')
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(blueprintRoutingInput(agent, 'existing')).toBeUndefined()
    session.append('turn/start', { turn: 2 })
    expect(blueprintRoutingInput(agent, 'existing')).toBeUndefined()
    const override = '算了，我想新建一个独立 Agent。'
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: override }] }), { surfaceOp: 'append' })
    const input = blueprintRoutingInput(agent, 'existing')!
    expect(input.provenance).toBe('user-message')
    expect(createBlueprintCreatorAuthoringRoute(input, { name: '新 Agent', user_intent: override }, 'new').request).toBe(override)
  })

  it.each([
    ['ローカルCSVを処理するスキルを追加してください。', 'skill'],
    ['산업 조사를 담당할 협업 에이전트를 추가해 주세요.', 'subagent'],
  ] as const)('H: routes %s by typed operation without script-based fallback', (text, operation) => {
    const { session, input } = inputSession(text)
    selectBlueprintOperation(session, input, operation, CallId('route'))
    expect(session.events.at(-1)?.data).toMatchObject({ operation, provenance: 'add-capability' })
    expect(blueprintRoutingGuidance(input)).toContain(text)
    expect(() => createBlueprintCreatorAuthoringRoute(input, { name: 'Other Agent', user_intent: text }, 'bad')).toThrow(/operation-conflict/u)
  })
})
