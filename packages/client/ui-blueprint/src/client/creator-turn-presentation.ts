/** Chat presentation marker for direct Creator authoring in one source Turn. */
import type {
  ClientContext, ConversationLocation, ConversationNodeContext, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ChatNode, InternalTurnPresentationData,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { creatorRequest } from './controller.ts'

const SYSTEM_PROMPT_SOURCE = '@deepseek-ai/dsh-system-prompt'
const BLUEPRINT_CONVERSATION_SECTION = 'blueprint:conversation'
const CREATOR_AUTHORING_PREFIX = 'Interactive Blueprint Creator authoring context.'

const DIRECT_CREATOR_REQUEST_KIND = 'blueprint-direct-creator-request'
const LEGACY_CREATOR_PRESET_VALIDATE_KIND = 'blueprint-legacy-creator-preset-validate'
const LEGACY_CREATOR_PRESET_RESOLVE_KIND = 'blueprint-legacy-creator-preset-resolve'

interface DirectCreatorRequestState {
  readonly seq: number
  readonly turn: number | undefined
}

interface CreatorTurnPresentationState {
  readonly seq: number
  readonly active: boolean
  readonly retainWhenInactive: boolean
}

interface PresetCallEvidenceState {
  readonly seq: number
  readonly turn: number | undefined
  readonly presetId: string
}

interface CreatorTurnPresentationData {
  readonly internalTurnPresentation?: InternalTurnPresentationData['internalTurnPresentation']
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** Hidden marker that retains human input while suppressing direct Creator implementation rows. */
    'blueprint-creator-turn-presentation': CreatorTurnPresentationData
  }
}

function locationOf(context: ConversationNodeContext): ConversationLocation {
  return context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' }
}

function turnOf(location: ConversationLocation): number | undefined {
  return location.kind === 'turn' || location.kind === 'step' ? location.turn.turn : undefined
}

function isTruncatedTurn(location: ConversationLocation): boolean {
  return (location.kind === 'turn' || location.kind === 'step') && location.turn.start === undefined
}

function textContent(content: readonly { readonly type: string; readonly text?: string }[]): string {
  return content.flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])
    .join('\n')
    .trim()
}

function isPresetCopyCall(event: Parameters<ConversationNodeDefinition['match']>[0]): boolean {
  if (event.type !== 'tool/call' || event.data.name !== 'preset_copy') return false
  try {
    const parsed: unknown = JSON.parse(event.data.arguments)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
    const record = parsed as Record<string, unknown>
    return typeof record['from'] === 'string' && record['from'] !== ''
      && typeof record['id'] === 'string' && record['id'] !== ''
  } catch {
    return false
  }
}

function presetIdCall(
  event: Parameters<ConversationNodeDefinition['match']>[0],
  name: 'preset_validate' | 'preset_resolve',
): string | null {
  if (event.type !== 'tool/call' || event.data.name !== name) return null
  try {
    const parsed: unknown = JSON.parse(event.data.arguments)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const id = (parsed as Record<string, unknown>)['id']
    return typeof id === 'string' && id !== '' ? id : null
  } catch {
    return null
  }
}

function compositionReadPresetId(event: Parameters<ConversationNodeDefinition['match']>[0]): string | null {
  if (event.type !== 'tool/call' || event.data.name !== 'read') return null
  try {
    const parsed: unknown = JSON.parse(event.data.arguments)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const path = (parsed as Record<string, unknown>)['file_path']
    if (typeof path !== 'string' || path === '') return null
    const parts = path.replaceAll('\\', '/').split('/').filter(part => part !== '')
    if (parts.at(-1) !== 'agent.cordis.yml' || parts.at(-3) !== '.agent-presets') return null
    const presetId = parts.at(-2)
    return presetId === undefined || presetId === '' ? null : presetId
  } catch {
    return null
  }
}

function hasPresetCopySchema(event: Parameters<ConversationNodeDefinition['match']>[0]): boolean {
  return event.type === 'request/header'
    && event.data.header.tools?.some(tool => tool.name === 'preset_copy') === true
}

/** Explicit user request retained as predecessor evidence for direct Creator authoring. */
export const blueprintDirectCreatorRequestDefinition: ConversationNodeDefinition<DirectCreatorRequestState> = {
  kind: DIRECT_CREATOR_REQUEST_KIND,
  match: (event) => {
    if (event.type !== 'user/message' || !isAppendSurfaceEvent(event) || event.data.source.kind !== 'user') return null
    return creatorRequest(textContent(event.data.content)) === null
      ? null
      : { id: String(event.data.id), role: 'start' }
  },
  start: (_context, match) => {
    if (match.event.type !== 'user/message') throw new Error('direct Creator request requires user/message')
    return { seq: match.event.seq, turn: turnOf(match.location) }
  },
  update: context => context.state,
  publication: () => 'none',
}

function presetCallEvidenceDefinition(
  kind: string,
  name: 'preset_validate' | 'preset_resolve',
): ConversationNodeDefinition<PresetCallEvidenceState> {
  return {
    kind,
    match: (event) => {
      const presetId = presetIdCall(event, name)
      return presetId === null || event.type !== 'tool/call'
        ? null
        : { id: String(event.data.callId), role: 'start' }
    },
    start: (_context, match) => {
      const presetId = presetIdCall(match.event, name)
      if (presetId === null) throw new Error(`${name} evidence requires one valid preset id`)
      return { seq: match.event.seq, turn: turnOf(match.location), presetId }
    },
    update: context => context.state,
    publication: () => 'none',
  }
}

/** Legacy paged-Turn evidence for a formal preset mount validation. */
export const blueprintLegacyCreatorPresetValidateDefinition = presetCallEvidenceDefinition(
  LEGACY_CREATOR_PRESET_VALIDATE_KIND,
  'preset_validate',
)

/** Legacy paged-Turn evidence for resolving the same formal preset. */
export const blueprintLegacyCreatorPresetResolveDefinition = presetCallEvidenceDefinition(
  LEGACY_CREATOR_PRESET_RESOLVE_KIND,
  'preset_resolve',
)

/**
 * Test whether one existing runtime-context snapshot identifies direct Blueprint Creator authoring.
 * @param event - current durable Session event.
 * @returns whether the event carries the exact Creator conversation section.
 */
export function isBlueprintCreatorAuthoringContext(
  event: Parameters<ConversationNodeDefinition['match']>[0],
): boolean {
  if (event.type !== 'user/message' || !isAppendSurfaceEvent(event)) return false
  const source = event.data.source
  if (source.kind !== 'plugin' || source.plugin !== SYSTEM_PROMPT_SOURCE || source.form !== 'snapshot') return false
  return source.sections.some(section => section.name === BLUEPRINT_CONVERSATION_SECTION
    && (section.text === CREATOR_AUTHORING_PREFIX || section.text.startsWith(`${CREATOR_AUTHORING_PREFIX}\n`)))
}

/** Direct Creator durable-evidence marker projected into the owning Chat Turn. */
export const blueprintCreatorTurnPresentationDefinition: ConversationNodeDefinition<CreatorTurnPresentationState> = {
  kind: 'blueprint-creator-turn-presentation',
  target: 'chat',
  match: (event) => {
    if (isBlueprintCreatorAuthoringContext(event) && event.type === 'user/message') {
      return { id: String(event.data.id), role: 'start' }
    }
    if (hasPresetCopySchema(event)) return { id: String(event.seq), role: 'start' }
    if (isPresetCopyCall(event) && event.type === 'tool/call') {
      return { id: String(event.data.callId), role: 'start' }
    }
    return compositionReadPresetId(event) !== null && event.type === 'tool/call'
      ? { id: String(event.data.callId), role: 'start' }
      : null
  },
  start: (_context, match, reader) => {
    if (isBlueprintCreatorAuthoringContext(match.event)) {
      return { seq: match.event.seq, active: true, retainWhenInactive: false }
    }
    if (isPresetCopyCall(match.event)) {
      return { seq: match.event.seq, active: true, retainWhenInactive: false }
    }
    const readPresetId = compositionReadPresetId(match.event)
    if (readPresetId !== null) {
      const turn = turnOf(match.location)
      const validate = reader.previous<PresetCallEvidenceState>(LEGACY_CREATOR_PRESET_VALIDATE_KIND)
      const resolve = reader.previous<PresetCallEvidenceState>(LEGACY_CREATOR_PRESET_RESOLVE_KIND)
      return {
        seq: match.event.seq,
        active: isTruncatedTurn(match.location)
          && turn !== undefined
          && validate?.state.turn === turn
          && resolve?.state.turn === turn
          && validate.state.presetId === readPresetId
          && resolve.state.presetId === readPresetId,
        retainWhenInactive: true,
      }
    }
    if (!hasPresetCopySchema(match.event)) {
      throw new Error('blueprint Creator turn presentation requires Creator context or preset authoring evidence')
    }
    const request = reader.previous<DirectCreatorRequestState>(DIRECT_CREATOR_REQUEST_KIND)
    const turn = turnOf(match.location)
    return {
      seq: match.event.seq,
      active: turn !== undefined && request?.state.turn === turn,
      retainWhenInactive: false,
    }
  },
  update: context => context.state,
  buildViewNode: (context) => {
    if (context.state === undefined || (!context.state.active && !context.state.retainWhenInactive)) return null
    const node: ChatNode<'blueprint-creator-turn-presentation'> = {
      key: context.key,
      kind: 'blueprint-creator-turn-presentation',
      id: context.id,
      target: 'chat',
      anchorSeq: context.state.seq,
      location: locationOf(context),
      visibility: 'hidden',
      data: context.state.active ? { internalTurnPresentation: 'implementation-only' } : {},
    }
    return node
  },
}

/**
 * Register direct Creator Chat suppression against existing durable request and runtime-context evidence.
 * @param ctx - owning Blueprint client context.
 */
export function registerBlueprintCreatorTurnPresentation(ctx: ClientContext): void {
  ctx.conversationEvents.register(blueprintDirectCreatorRequestDefinition)
  ctx.conversationEvents.register(blueprintLegacyCreatorPresetValidateDefinition)
  ctx.conversationEvents.register(blueprintLegacyCreatorPresetResolveDefinition)
  ctx.conversationEvents.register(blueprintCreatorTurnPresentationDefinition)
}
