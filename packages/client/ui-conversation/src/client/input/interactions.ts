/** Session-addressed external interaction carriers projected into the native composer chain. */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  PendingInteraction, SessionId, SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'

/** Cross-plugin face for projecting answerable interactions into a source Session composer. */
export interface ComposerInteractions {
  /**
   * Replace one source Session's external carriers.
   * @param sessionId - foreground Session that presents the interactions.
   * @param interactions - exact carriers retained by their owning Sessions.
   */
  set(sessionId: SessionId, interactions: readonly PendingInteraction[]): void
  /**
   * Read one source Session's external carriers.
   * @param sessionId - foreground Session to observe.
   * @returns stable observable used by the conversation root.
   */
  storeFor(sessionId: SessionId): SnapshotStore<readonly PendingInteraction[]>
  /**
   * Drop one source Session's store when its presentation owner is released.
   * @param sessionId - foreground Session whose external projection ended.
   */
  forget(sessionId: SessionId): void
}

/** In-memory external interaction registry owned by the conversation plugin. */
export class ComposerInteractionRegistry implements ComposerInteractions {
  private readonly stores = new Map<SessionId, SnapshotStore<readonly PendingInteraction[]>>()

  /** @inheritdoc */
  set(sessionId: SessionId, interactions: readonly PendingInteraction[]): void {
    const store = this.storeFor(sessionId)
    const current = store.getSnapshot()
    if (current.length === interactions.length
      && current.every((interaction, index) => interaction === interactions[index])) return
    store.set([...interactions])
  }

  /** @inheritdoc */
  storeFor(sessionId: SessionId): SnapshotStore<readonly PendingInteraction[]> {
    const existing = this.stores.get(sessionId)
    if (existing !== undefined) return existing
    const created = createSnapshotStore<readonly PendingInteraction[]>([])
    this.stores.set(sessionId, created)
    return created
  }

  /** @inheritdoc */
  forget(sessionId: SessionId): void {
    this.stores.delete(sessionId)
  }
}
