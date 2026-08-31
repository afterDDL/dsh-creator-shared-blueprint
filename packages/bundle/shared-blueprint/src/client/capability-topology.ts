/** Execution choice for one new capability authoring lifecycle. */
export interface CapabilityAuthoringExecution<Session extends string> {
  /** Session whose durable log owns authoring and repair. */
  sessionId: Session
  /** Whether this is the retained non-Cordis dedicated-worker fallback. */
  dedicatedWorker: boolean
}

/** Host-confirmed identity returned while adopting an existing source Session. */
export interface AdoptedCapabilitySource<Session extends string> {
  /** Existing source identity echoed by the Host. */
  sessionId: Session
  /** Preset resolved from the source's durable log. */
  agentPreset?: string
}

/**
 * Resolve the existing source's durable preset before choosing an authoring topology.
 * @param sourceSessionId - Session that produced the typed route.
 * @param sourceCwd - exact cwd from the Host Session summary.
 * @param sourceAvailable - whether the client can still address the same source.
 * @param adoptSource - idempotently resumes or adopts that exact Host Session.
 * @param noteSourcePreset - converges the client summary to the Host result.
 * @returns the preset the existing source currently runs.
 */
export async function resolveCapabilityAuthoringSourcePreset<Session extends string>(
  sourceSessionId: Session,
  sourceCwd: string | undefined,
  sourceAvailable: boolean,
  adoptSource: (request: { sessionId: Session; cwd: string }) => Promise<AdoptedCapabilitySource<Session>>,
  noteSourcePreset: (sessionId: Session, agentPreset: string) => void,
): Promise<string | undefined> {
  if (sourceCwd === undefined || !sourceAvailable) {
    throw new Error('Source Session 已不可用，无法继续配置能力。')
  }
  const adopted = await adoptSource({ sessionId: sourceSessionId, cwd: sourceCwd })
  if (adopted.sessionId !== sourceSessionId) {
    throw new Error('Source Session 身份在能力配置前发生变化。')
  }
  if (adopted.agentPreset !== undefined) noteSourcePreset(sourceSessionId, adopted.agentPreset)
  return adopted.agentPreset
}

/**
 * Return authoring to a Cordis source without allocating a worker.
 * @param sourceSessionId - Session that produced the typed route.
 * @param resolveSourceAgentPreset - resolves the preset the existing source currently runs.
 * @param createDedicatedWorker - legacy fallback allocator for a non-Cordis source.
 * @returns source execution for Cordis, otherwise the dedicated-worker fallback.
 */
export async function resolveCapabilityAuthoringExecution<Session extends string>(
  sourceSessionId: Session,
  resolveSourceAgentPreset: () => Promise<string | undefined>,
  createDedicatedWorker: () => Promise<Session>,
): Promise<CapabilityAuthoringExecution<Session>> {
  const sourceAgentPreset = await resolveSourceAgentPreset()
  if (sourceAgentPreset === 'cordis') return { sessionId: sourceSessionId, dedicatedWorker: false }
  return { sessionId: await createDedicatedWorker(), dedicatedWorker: true }
}
