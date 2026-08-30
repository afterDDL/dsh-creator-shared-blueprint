/** Persisted browser preference for the last valid Blueprint target. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { BlueprintTargetPreference } from './controller.ts'

const TARGET_PREFERENCE_KEY = 'dsh.blueprint.target-preset'

interface TargetPreferenceState {
  bySession: Record<string, string>
  withoutSession?: string
}

const EMPTY_TARGETS: TargetPreferenceState = { bySession: {} }

function targetState(value: unknown): TargetPreferenceState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const bySession = (value as Record<string, unknown>)['bySession']
  const withoutSession = (value as Record<string, unknown>)['withoutSession']
  if (typeof bySession !== 'object' || bySession === null || Array.isArray(bySession)) return null
  if (withoutSession !== undefined && typeof withoutSession !== 'string') return null
  const entries = Object.entries(bySession)
  if (entries.some(([, presetId]) => typeof presetId !== 'string')) return null
  return {
    bySession: Object.fromEntries(entries),
    ...(withoutSession === undefined ? {} : { withoutSession }),
  }
}

/**
 * Create the per-Session browser preferences used during Blueprint startup.
 * Invalid persisted data is discarded; the real Blueprint is always re-read from the Host.
 * @returns a preference reader and writer backed by the Client runtime's non-fatal persistence.
 */
export function createBlueprintTargetPreference(): BlueprintTargetPreference {
  const store = createSnapshotStore<unknown>(EMPTY_TARGETS, { persist: { name: TARGET_PREFERENCE_KEY } })
  const readState = (): TargetPreferenceState => {
    const state = targetState(store.getSnapshot())
    if (state !== null) return state
    store.set(EMPTY_TARGETS)
    return EMPTY_TARGETS
  }
  return {
    read(sessionId) {
      const state = readState()
      return sessionId === undefined
        ? state.withoutSession ?? null
        : state.bySession[sessionId] ?? null
    },
    write(presetId, sessionId) {
      const state = readState()
      if (sessionId === undefined) {
        store.set({ ...state, withoutSession: presetId })
        return
      }
      store.set({ ...state, bySession: { ...state.bySession, [sessionId]: presetId } })
    },
    clear(sessionId) {
      const state = readState()
      if (sessionId === undefined) {
        const { withoutSession: _removed, ...remaining } = state
        store.set(remaining)
        return
      }
      const { [sessionId]: _removed, ...remaining } = state.bySession
      store.set({ ...state, bySession: remaining })
    },
  }
}
