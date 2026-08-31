/** Track source Sessions whose ordinary Blueprint context still needs installation. */
export class BlueprintContextRestorePending {
  private readonly pending = new Set<string>()
  private readonly attempts = new Map<string, Promise<boolean>>()

  /**
   * Reserve one source composer until its ordinary Blueprint context is installed.
   * @param sessionId - source Session that must remain blocked.
   * @returns whether this call added a new pending source.
   */
  mark(sessionId: string): boolean {
    const size = this.pending.size
    this.pending.add(sessionId)
    return this.pending.size !== size
  }

  /**
   * Test whether one source still needs its ordinary Blueprint context.
   * @param sessionId - source Session to inspect.
   * @returns whether its composer must remain blocked.
   */
  has(sessionId: string): boolean {
    return this.pending.has(sessionId)
  }

  /**
   * List source Sessions whose composer must remain blocked.
   * @returns a detached pending-source snapshot.
   */
  sessionIds(): readonly string[] {
    return [...this.pending]
  }

  /**
   * Clear a source whose non-capability context was installed by another exact recovery path.
   * @param sessionId - source Session whose pending restore is satisfied.
   * @returns whether this call cleared pending state.
   */
  clear(sessionId: string): boolean {
    return this.pending.delete(sessionId)
  }

  /**
   * Coalesce one source's restore attempt and clear it only after confirmed installation.
   * @param sessionId - source Session being restored.
   * @param install - exact foreground installation attempt.
   * @returns whether the ordinary context was installed.
   */
  restore(sessionId: string, install: () => Promise<boolean>): Promise<boolean> {
    if (!this.pending.has(sessionId)) return Promise.resolve(true)
    const active = this.attempts.get(sessionId)
    if (active !== undefined) return active
    const attempt = install().then((installed) => {
      if (installed) this.pending.delete(sessionId)
      return installed
    }).finally(() => {
      if (this.attempts.get(sessionId) === attempt) this.attempts.delete(sessionId)
    })
    this.attempts.set(sessionId, attempt)
    return attempt
  }
}
