import { describe, expect, it, vi } from 'vitest'
import { BlueprintContextRestorePending } from '../src/client/context-restore.ts'

describe('Blueprint source context restore', () => {
  it('keeps one terminal source pending after a failed install and clears it after retry success', async () => {
    const pending = new BlueprintContextRestorePending()
    const install = vi.fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    pending.mark('source-cordis')

    await expect(pending.restore('source-cordis', install)).resolves.toBe(false)
    expect(pending.sessionIds()).toEqual(['source-cordis'])

    await expect(pending.restore('source-cordis', install)).resolves.toBe(true)
    expect(pending.sessionIds()).toEqual([])
    expect(install).toHaveBeenCalledTimes(2)
  })

  it('retains a background terminal source until its foreground context install succeeds', async () => {
    const pending = new BlueprintContextRestorePending()
    let foreground = 'source-b'
    const install = vi.fn(() => Promise.resolve(foreground === 'source-a'))
    pending.mark('source-a')

    await expect(pending.restore('source-a', install)).resolves.toBe(false)
    expect(pending.has('source-a')).toBe(true)

    foreground = 'source-a'
    await expect(pending.restore('source-a', install)).resolves.toBe(true)
    expect(pending.has('source-a')).toBe(false)
  })
})
