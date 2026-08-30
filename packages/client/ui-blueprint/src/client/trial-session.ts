import type { BlueprintSessionValidation } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { BlueprintTrialValidationError, type BlueprintTrialRequest } from './controller.ts'

/** Host response required before a Blueprint trial can continue client setup. */
export interface BlueprintTrialCreatedSession {
  readonly sessionId: SessionId
  readonly agentPreset?: string
}

/** Ordered client steps that make a created trial safe to expose to input. */
export interface BlueprintTrialReadinessSteps {
  /** Create and fully compose the Host Session. */
  create(): Promise<BlueprintTrialCreatedSession>
  /** Wait until the created Host Session is addressable by the client runtime. */
  waitUntilAddressable(sessionId: SessionId): Promise<void>
  /** Publish the Host-confirmed preset identity into the client summary. */
  notePreset(sessionId: SessionId, presetId: string): void
  /** Install the Blueprint conversation context before any user input can run. */
  installContext(sessionId: SessionId): Promise<void>
  /** Whether navigation still belongs to the interaction that started the trial. */
  mayOpen(): boolean
  /** Expose the ready Session to the user. */
  open(sessionId: SessionId): void
  /** Validate the live assembled runtime against the committed projection. */
  validate(sessionId: SessionId): Promise<BlueprintSessionValidation>
}

/**
 * Prepare one trial Session and expose it after Host composition and Blueprint
 * conversation-context installation. Runtime conformance remains the stronger
 * Try Agent check that follows readiness; it does not define prompt admission.
 * @param request - target preset, expected projection revision, exact optional receipt identity, and open policy.
 * @param steps - Host and client operations supplied by the Web assembly.
 * @returns conformance evidence for the newly created Session.
 * @throws {BlueprintTrialValidationError} when post-open validation fails or returns another Session, preset, or revision identity.
 */
export async function prepareBlueprintTrialSession(
  request: BlueprintTrialRequest,
  steps: BlueprintTrialReadinessSteps,
): Promise<BlueprintSessionValidation> {
  const created = await steps.create()
  if (created.agentPreset !== request.presetId) {
    throw new Error(
      `New Session preset mismatch: expected ${JSON.stringify(request.presetId)}, `
      + `received ${JSON.stringify(created.agentPreset)}`,
    )
  }
  await steps.waitUntilAddressable(created.sessionId)
  steps.notePreset(created.sessionId, created.agentPreset)
  await steps.installContext(created.sessionId)
  if (request.open !== false && steps.mayOpen()) steps.open(created.sessionId)
  try {
    const validation = await steps.validate(created.sessionId)
    if (validation.sessionId !== created.sessionId || validation.presetId !== request.presetId
      || validation.binding.expectedRevision !== request.expectedRevision) {
      throw new Error('Trial validation response does not match the created Session, preset, and expected revision')
    }
    return validation
  } catch (error) {
    throw new BlueprintTrialValidationError(created.sessionId, error)
  }
}
