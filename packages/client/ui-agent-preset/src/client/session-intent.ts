/** Session-creation intent shared by preset-selection surfaces. */

/** Client-local handoff from a preset picker to the next blank Session. */
export interface AgentPresetSessionIntent {
  /**
   * Stage a preset for the next Session created by the current conversation flow.
   * @param presetId - preset that the Host must compose before prompting is admitted.
   * @param introduce - whether the receiving seat should announce the externally chosen preset.
   */
  stage(presetId: string, introduce?: boolean): void
  /** @returns the preset still waiting for a receiving Session, when present. */
  pending(): string | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Client-local next-Session preset intent; it never changes a running Session. */
    agentPresetSessionIntent: AgentPresetSessionIntent
  }
}
