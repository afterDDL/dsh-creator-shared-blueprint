/** Client verification for one structured Purpose submission. */

import type {
  BlueprintConversationContextResult,
  BlueprintStructuredEditInput,
} from '@deepseek-ai/dsh-shared-blueprint/contract'

/**
 * Require Host evidence that a structured Purpose edit entered its owning Session.
 * @param result - conversation-context response returned by the Host.
 * @param sourceSessionId - foreground Session that submitted the edit.
 * @param input - client-issued structured edit identity.
 */
export function assertDirectEditEnqueued(
  result: BlueprintConversationContextResult,
  sourceSessionId: string,
  input: BlueprintStructuredEditInput,
): void {
  const enqueue = result.directEditEnqueue
  if (enqueue?.routeId === input.routeId && enqueue.sourceSessionId === sourceSessionId) return
  throw new Error('目标修改未进入当前对话。Host 未确认本次 routeId，请重新启动更新后的服务后重试。')
}
