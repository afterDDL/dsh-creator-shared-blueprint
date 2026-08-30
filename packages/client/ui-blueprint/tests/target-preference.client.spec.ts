// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { createBlueprintTargetPreference } from '../src/client/target-preference.ts'

describe('Blueprint target preference', () => {
  beforeEach(() => { localStorage.clear() })

  it('persists independent selected presets for each owning Session', () => {
    const first = createBlueprintTargetPreference()
    first.write('equity-research', 'session-a')
    first.write('supplier-research', 'session-b')

    expect(localStorage.getItem('dsh.blueprint.target-preset'))
      .toBe('{"bySession":{"session-a":"equity-research","session-b":"supplier-research"}}')
    expect(createBlueprintTargetPreference().read('session-a')).toBe('equity-research')
    expect(createBlueprintTargetPreference().read('session-b')).toBe('supplier-research')
    expect(createBlueprintTargetPreference().read()).toBeNull()
  })

  it('clears only the preference owned by the requested Session', () => {
    const preference = createBlueprintTargetPreference()
    preference.write('equity-research', 'session-a')
    preference.write('supplier-research', 'session-b')

    preference.clear('session-a')

    expect(preference.read('session-a')).toBeNull()
    expect(preference.read('session-b')).toBe('supplier-research')
    expect(localStorage.getItem('dsh.blueprint.target-preset'))
      .toBe('{"bySession":{"session-b":"supplier-research"}}')
  })

  it('does not reinterpret a legacy global target as a new Session preference', () => {
    localStorage.setItem('dsh.blueprint.target-preset', '{"presetId":"equity-research"}')
    expect(createBlueprintTargetPreference().read('session-new')).toBeNull()
    expect(localStorage.getItem('dsh.blueprint.target-preset')).toBe('{"bySession":{}}')
  })

  it('discards an incompatible persisted value', () => {
    localStorage.setItem('dsh.blueprint.target-preset', '{"presetId":42,"blueprint":{"stale":true}}')

    const preference = createBlueprintTargetPreference()

    expect(preference.read()).toBeNull()
    expect(localStorage.getItem('dsh.blueprint.target-preset')).toBe('{"bySession":{}}')
  })
})
