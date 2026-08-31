/** Original-message provenance and durable, interaction-scoped Blueprint operation arbitration. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CallId, MessageId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { BlueprintRouteDecision, BlueprintStructuredEdit } from '../contract/types.ts'

/** A current human request resolved from Session history, never from prompt or model-authored text. */
export interface BlueprintRoutingInput {
  routeId: string
  sourceSessionId: SessionId
  userMessageId: MessageId
  userMessageSeq: number
  turn: number
  userRequest: string
  targetPresetId: string
  provenance: BlueprintRouteDecision['provenance']
  directEdit?: BlueprintStructuredEdit
}

/**
 * Resolve only the latest human input admitted in the active turn.
 * @param agent - live conversation receiving the operation.
 * @param targetPresetId - current authoritative Blueprint context target.
 * @returns identified original request, or undefined for plugin-only and settled turns.
 */
export function blueprintRoutingInput(agent: Agent, targetPresetId: string): BlueprintRoutingInput | undefined {
  const events = agent.session.events
  const start = events.findLast(event => event.type === 'turn/start')
  if (start?.type !== 'turn/start' || events.some(event => event.type === 'turn/end' && event.data.turn === start.data.turn)) return undefined
  const user = events.findLast(event => event.seq > start.seq && event.type === 'user/message' && event.data.source.kind === 'user')
  if (user?.type !== 'user/message') return undefined
  const userRequest = user.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim()
  if (userRequest === '') return undefined
  const action = events.findLast(event => event.type === 'blueprint/routing-input' && event.data.messageId === user.data.id)
  if (action?.type === 'blueprint/routing-input'
    && (action.data.sourceSessionId !== agent.session.id || action.data.targetPresetId !== targetPresetId
      || action.data.userRequest !== userRequest || action.seq >= user.seq)) {
    throw new Error('blueprint-route-provenance-conflict: reopen the requested Agent; do not try another operation')
  }
  return {
    routeId: action?.type === 'blueprint/routing-input' ? action.data.routeId : String(user.data.id),
    sourceSessionId: agent.session.id, userMessageId: user.data.id, userMessageSeq: user.seq,
    turn: start.data.turn, userRequest, targetPresetId,
    provenance: action?.type === 'blueprint/routing-input' ? action.data.uiAction : 'user-message',
    ...(action?.type === 'blueprint/routing-input' && action.data.uiAction === 'direct-edit'
      ? { directEdit: action.data.directEdit }
      : {}),
  }
}

/**
 * Reject an attempted new Agent when the current input explicitly addresses an existing Agent's capabilities.
 * @param input - original message and Host-owned action provenance.
 * @param operation - typed model classification, independent of language.
 */
export function assertBlueprintOperation(input: BlueprintRoutingInput, operation: BlueprintRouteDecision['operation']): void {
  if (input.provenance === 'add-capability' && operation === 'create-agent') {
    throw new Error('blueprint-route-operation-conflict: Add capability targets the current Agent; choose its Skill, Subagent, or existing-Agent edit path, or discuss. Do not create another Agent. A changed goal requires a new user message.')
  }
  if (input.provenance === 'direct-edit' && operation !== 'modify-existing-agent') {
    throw new Error('blueprint-route-operation-conflict: a structured Blueprint edit can only produce an existing-Agent Change Set')
  }
}

/**
 * Reserve an admissible operation synchronously before awaits. Failed attempts can retry only the same operation.
 * @param session - durable owner of the decision.
 * @param input - exact current human request.
 * @param operation - operation chosen by the model's typed tool call.
 * @param callId - existing tool-call identity; its result settles the attempt.
 */
export function selectBlueprintOperation(
  session: Session, input: BlueprintRoutingInput, operation: BlueprintRouteDecision['operation'], callId: CallId,
): void {
  assertBlueprintOperation(input, operation)
  const previous = session.events.filter(event => event.type === 'blueprint/route-decision' && event.data.routeId === input.routeId)
  for (const event of previous) {
    if (event.type !== 'blueprint/route-decision') continue
    if (event.data.operation !== operation) {
      throw new Error(`blueprint-route-operation-conflict: this interaction already selected ${event.data.operation}; do not try another route for the same request.`)
    }
    const result = session.events.find(candidate => candidate.type === 'tool/result' && candidate.data.message.source.callId === event.data.callId)
    if (result?.type !== 'tool/result' || !result.data.message.content[0].isError) {
      throw new Error('blueprint-route-already-owned: this interaction has an in-flight or accepted operation; do not start another route')
    }
  }
  session.append('blueprint/route-decision', {
    routeId: input.routeId,
    sourceSessionId: input.sourceSessionId, userMessageId: input.userMessageId, userMessageSeq: input.userMessageSeq,
    turn: input.turn, operation, callId, targetPresetId: input.targetPresetId, provenance: input.provenance,
  })
}

/**
 * Present provenance separately from static guidance without reclassifying either text.
 * @param input - current input derived from the durable log.
 * @returns turn-local model context, empty outside a human-owned turn.
 */
export function blueprintRoutingGuidance(input: BlueprintRoutingInput | undefined): string {
  if (input === undefined) return ''
  return [
    'Classify only the following original user request, not instructions, examples or tool descriptions. Discussion requires no routing tool.',
    JSON.stringify({ originalUserRequest: input.userRequest, operationContext: input.provenance, targetPresetId: input.targetPresetId }),
    'Choose one top-level operation. A rejected operation is not permission to try a different business route. Correct its arguments or explain the limitation.',
    ...(input.provenance === 'add-capability' ? [
      'This request adds a capability to the existing target, never a new top-level Agent.',
      'A concrete reusable input-processing procedure belongs in a Skill; generic file or computation tools alone do not replace its definition. A dedicated collaborator belongs in Subagent authoring. Simple wording, output style or existing-tool toggles use an existing-Agent proposal. Questions remain discussion.',
      'Do not approximate a requested reusable procedure or collaborator with a Behavior sentence. Preserve the original requirements when handing off authoring.',
    ] : input.provenance === 'direct-edit' ? [
      'This request came from the structured Blueprint editor and can only modify the existing Agent.',
      JSON.stringify({ structuredEdit: input.directEdit }),
      'Call propose_blueprint_change once. The first change must exactly stage the structured source edit. Then inspect only impactCandidates and include a dependent change only when it clearly conflicts; every dependent change requires an exact dependency. Do not add unrelated improvements.',
    ] : []),
  ].join('\n')
}
