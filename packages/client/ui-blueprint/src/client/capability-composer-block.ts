interface CapabilityComposerBlock {
  readonly reason: string
}

interface CapabilityComposerBlockStore {
  getSnapshot(): CapabilityComposerBlock | undefined
  subscribe(listener: () => void): () => void
}

interface CapabilityComposerBlocks {
  set(sessionId: string, block: CapabilityComposerBlock | undefined): void
  storeFor(sessionId: string): CapabilityComposerBlockStore
}

interface CapabilityComposerBlockLease {
  readonly store: CapabilityComposerBlockStore
  stop: () => void
}

const CAPABILITY_COMPOSER_BLOCK: CapabilityComposerBlock = { reason: '正在配置能力…' }

/** Keep active capability source blocks resident when another input owner republishes its state. */
export class BlueprintCapabilityComposerBlockProjection {
  private readonly leases = new Map<string, CapabilityComposerBlockLease>()

  /** @param blocks - shared conversation composer-block registry. */
  constructor(private readonly blocks: CapabilityComposerBlocks) {}

  /**
   * Converge source blocks while preserving an execution whose controller projection is between updates.
   * @param desiredSessionIds - sources currently configuring, authoring, or restoring context.
   * @param retainedSessionIds - same-source executions that must not be released during reconciliation.
   */
  sync(desiredSessionIds: Iterable<string>, retainedSessionIds: ReadonlySet<string>): void {
    const desired = new Set(desiredSessionIds)
    for (const [sessionId, lease] of this.leases) {
      if (desired.has(sessionId) || retainedSessionIds.has(sessionId)) continue
      this.leases.delete(sessionId)
      lease.stop()
      if (lease.store.getSnapshot()?.reason === CAPABILITY_COMPOSER_BLOCK.reason) {
        this.blocks.set(sessionId, undefined)
      }
    }
    for (const sessionId of desired) {
      let lease = this.leases.get(sessionId)
      if (lease === undefined) {
        const store = this.blocks.storeFor(sessionId)
        lease = { store, stop: () => {} }
        this.leases.set(sessionId, lease)
        lease.stop = store.subscribe(() => { this.reassert(sessionId) })
      }
      this.reassert(sessionId)
    }
  }

  /** Release every block still owned by this projection. */
  dispose(): void {
    this.sync([], new Set())
  }

  private reassert(sessionId: string): void {
    const lease = this.leases.get(sessionId)
    if (lease === undefined || lease.store.getSnapshot()?.reason === CAPABILITY_COMPOSER_BLOCK.reason) return
    this.blocks.set(sessionId, CAPABILITY_COMPOSER_BLOCK)
  }
}
