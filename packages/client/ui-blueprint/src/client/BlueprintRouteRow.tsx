/** User-facing presentation for internal Blueprint routing Tools. */
import type { ClientContext, ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import type { BlueprintRouteRowProps } from './slots.ts'
import css from './BlueprintUi.module.css'

const CREATOR_ROUTE_TOOL = 'route_blueprint_creator_authoring'
const CAPABILITY_ROUTE_TOOL = 'route_blueprint_capability_authoring'
const PROVENANCE_CONFLICT = 'blueprint-route-provenance-conflict:'

type RoutePresentationState = 'routing' | 'retrying' | 'accepted' | 'failed'

interface RoutePresentation {
  state: RoutePresentationState
  text: string
}

function hasProvenanceConflict(block: ToolCallBlock): boolean {
  if (!('kind' in block) || !block.isError) return false
  return block.content.some(content => content.type === 'text' && content.text.includes(PROVENANCE_CONFLICT))
}

function routePresentation(toolName: string, block: ToolCallBlock): RoutePresentation {
  const creator = toolName === CREATOR_ROUTE_TOOL
  if (!('kind' in block)) {
    return {
      state: 'routing',
      text: creator ? '正在确认创建请求…' : '正在确认能力请求…',
    }
  }
  if (!block.isError) {
    return {
      state: 'accepted',
      text: creator ? '正在创建 Agent…' : '正在配置能力…',
    }
  }
  if (hasProvenanceConflict(block)) {
    return {
      state: 'retrying',
      text: creator ? '正在重新确认创建请求…' : '正在重新确认能力请求…',
    }
  }
  return {
    state: 'failed',
    text: creator ? '暂时无法开始创建，请重新尝试。' : '暂时无法配置这项能力，请重新尝试。',
  }
}

/**
 * Render one routing attempt without exposing Tool names, arguments, or internal validation errors.
 * @param props - frozen Tool call or result owned by the conversation turn.
 * @returns one user-facing routing status card.
 */
export function BlueprintRouteRow({ toolName, block }: BlueprintRouteRowProps) {
  const presentation = routePresentation(toolName, block)
  return (
    <div
      className={css.proposalCard}
      data-state={presentation.state}
      data-error={presentation.state === 'failed' || undefined}
    >
      <div className={css.proposalTitle}>{presentation.text}</div>
    </div>
  )
}

/**
 * Register the shared user-facing row for new-Agent and capability routing Tools.
 * @param ctx - browser Client context that owns the keyed Tool-view slot.
 */
export function registerBlueprintRouteToolViews(ctx: ClientContext): void {
  ctx.slots.inject('tool.call.toolview', function* () {
    yield ctx.slots.register({
      name: 'tool.call.toolview',
      key: CREATOR_ROUTE_TOOL,
    }, BlueprintRouteRow)
    yield ctx.slots.register({
      name: 'tool.call.toolview',
      key: CAPABILITY_ROUTE_TOOL,
    }, BlueprintRouteRow)
  })
}
