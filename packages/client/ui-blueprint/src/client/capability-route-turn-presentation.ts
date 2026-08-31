/** Chat presentation marker for one typed capability-routing Turn. */
import type {
  ClientContext, ConversationLocation, ConversationNodeContext, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ChatNode, ConversationTurnPresentationData,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

const CAPABILITY_ROUTE_TOOL = 'route_blueprint_capability_authoring'
const CAPABILITY_ROUTING_INPUT_KIND = 'blueprint-capability-routing-input'
const CAPABILITY_LIFECYCLE_INPUT_KINDS = new Set([
  'blueprint-capability-authoring',
  'blueprint-capability-repair',
])

interface CapabilityRoutingInputState {
  readonly seq: number
  readonly messageId: string
  readonly routeId: string
}

interface CapabilityRouteTurnPresentationState {
  readonly seq: number
  readonly active: boolean
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** Hidden marker that retains human input while suppressing one capability router Turn. */
    'blueprint-capability-route-turn-presentation': ConversationTurnPresentationData
  }
}

function locationOf(context: ConversationNodeContext): ConversationLocation {
  return context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' }
}

/** Exact Add capability routing input retained until its admitted user message is projected. */
export const blueprintCapabilityRoutingInputDefinition:
ConversationNodeDefinition<CapabilityRoutingInputState> = {
  kind: CAPABILITY_ROUTING_INPUT_KIND,
  match: event => event.type === 'blueprint/routing-input' && event.data.uiAction === 'add-capability'
    ? { id: event.data.routeId, role: 'start' }
    : null,
  start: (_context, match) => {
    if (match.event.type !== 'blueprint/routing-input'
      || match.event.data.uiAction !== 'add-capability') {
      throw new Error('capability routing input requires its exact Add capability action')
    }
    return {
      seq: match.event.seq,
      messageId: String(match.event.data.messageId),
      routeId: match.event.data.routeId,
    }
  },
  update: context => context.state,
  publication: () => 'none',
}

/** Exact typed capability route marker projected into its owning Chat Turn. */
export const blueprintCapabilityRouteTurnPresentationDefinition:
ConversationNodeDefinition<CapabilityRouteTurnPresentationState> = {
  kind: 'blueprint-capability-route-turn-presentation',
  target: 'chat',
  match: (event) => {
    if (event.type === 'user/message' && isAppendSurfaceEvent(event)) {
      return event.data.source.kind === 'user'
        || CAPABILITY_LIFECYCLE_INPUT_KINDS.has(event.data.source.kind)
        ? { id: String(event.data.id), role: 'start' }
        : null
    }
    return event.type === 'tool/call' && event.data.name === CAPABILITY_ROUTE_TOOL
      ? { id: String(event.data.callId), role: 'start' }
      : null
  },
  start: (_context, match, reader) => {
    if (match.event.type === 'user/message') {
      if (CAPABILITY_LIFECYCLE_INPUT_KINDS.has(match.event.data.source.kind)) {
        return { seq: match.event.seq, active: true }
      }
      const routingInput = reader.previous<CapabilityRoutingInputState>(CAPABILITY_ROUTING_INPUT_KIND)
      return {
        seq: match.event.seq,
        active: routingInput?.state.messageId === String(match.event.data.id),
      }
    }
    if (match.event.type !== 'tool/call' || match.event.data.name !== CAPABILITY_ROUTE_TOOL) {
      throw new Error('blueprint capability route presentation requires admitted input or its typed route Tool')
    }
    return { seq: match.event.seq, active: true }
  },
  update: context => context.state,
  buildViewNode: (context) => {
    if (context.state?.active !== true) return null
    const node: ChatNode<'blueprint-capability-route-turn-presentation'> = {
      key: context.key,
      kind: 'blueprint-capability-route-turn-presentation',
      id: context.id,
      target: 'chat',
      anchorSeq: context.state.seq,
      location: locationOf(context),
      visibility: 'hidden',
      data: {
        turnPresentation: {
          visibility: 'human-input-only',
          activity: 'consumer-owned',
        },
      },
    }
    return node
  },
}

/**
 * Register typed capability-router suppression against its existing durable Tool call.
 * @param ctx - owning Blueprint client context.
 */
export function registerBlueprintCapabilityRouteTurnPresentation(ctx: ClientContext): void {
  ctx.conversationEvents.register(blueprintCapabilityRoutingInputDefinition)
  ctx.conversationEvents.register(blueprintCapabilityRouteTurnPresentationDefinition)
}
