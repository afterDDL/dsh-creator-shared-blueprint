import { describe, expect, it, vi } from 'vitest'
import type { BlueprintSessionValidation } from '@deepseek-ai/dsh-api-remotes/client'
import { BlueprintTrialValidationError } from '../src/client/controller.ts'
import { prepareBlueprintTrialSession } from '../src/client/trial-session.ts'

const request = { presetId: 'listed-company-research', expectedRevision: 'revision-7' } as const

function validation(
  sessionId = 'trial-1',
  presetId: string = request.presetId,
  expectedRevision: string = request.expectedRevision,
): BlueprintSessionValidation {
  return {
    sessionId, presetId, valid: true, overall: 'pass',
    binding: {
      status: 'pass', sessionPresetId: presetId, composedPresetId: presetId,
      expectedRevision, projectedRevision: expectedRevision, strictRevisionBound: false,
    },
    prompt: { status: 'pass', evidence: [] },
    tools: { status: 'pass', evidence: [], missing: [], unexpected: [], schemaMismatches: [] },
    skills: { status: 'pass', evidence: [], missing: [], unexpected: [] },
    delegations: { status: 'pass', evidence: [] },
    permissions: { status: 'pass' },
  }
}

describe('Blueprint trial Session readiness', () => {
  it('opens after runtime context is ready and leaves conformance as the stronger follow-up', async () => {
    const order: string[] = []
    const evidence = validation()
    const result = await prepareBlueprintTrialSession(request, {
      async create() {
        order.push('create')
        return { sessionId: 'trial-1' as never, agentPreset: 'listed-company-research' }
      },
      async waitUntilAddressable() { order.push('addressable') },
      notePreset() { order.push('identity') },
      async installContext() { order.push('context') },
      mayOpen() {
        order.push('ownership')
        return true
      },
      open() { order.push('open') },
      async validate() {
        order.push('conformance')
        return evidence
      },
    })

    expect(result).toBe(evidence)
    expect(order).toEqual([
      'create', 'addressable', 'identity', 'context', 'ownership', 'open', 'conformance',
    ])
  })

  it('does not expose a Session whose Host preset identity mismatches the request', async () => {
    const waitUntilAddressable = vi.fn()
    const open = vi.fn()
    await expect(prepareBlueprintTrialSession(request, {
      create: async () => ({ sessionId: 'trial-1' as never, agentPreset: 'standard' }),
      waitUntilAddressable,
      notePreset: vi.fn(),
      installContext: vi.fn(),
      validate: async () => validation(),
      mayOpen: () => true,
      open,
    })).rejects.toThrow('preset mismatch')
    expect(waitUntilAddressable).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  it('leaves failed context initialization blank and unopened', async () => {
    const validate = vi.fn(async () => validation())
    const open = vi.fn()
    await expect(prepareBlueprintTrialSession(request, {
      create: async () => ({
        sessionId: 'trial-1' as never,
        agentPreset: 'listed-company-research',
      }),
      waitUntilAddressable: async () => undefined,
      notePreset: vi.fn(),
      installContext: async () => { throw new Error('context failed') },
      validate,
      mayOpen: () => true,
      open,
    })).rejects.toThrow('context failed')
    expect(validate).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  it('does not steal navigation when the user changed Sessions during preparation', async () => {
    const open = vi.fn()
    await prepareBlueprintTrialSession(request, {
      create: async () => ({
        sessionId: 'trial-1' as never,
        agentPreset: 'listed-company-research',
      }),
      waitUntilAddressable: async () => undefined,
      notePreset: vi.fn(),
      installContext: async () => undefined,
      validate: async () => validation(),
      mayOpen: () => false,
      open,
    })
    expect(open).not.toHaveBeenCalled()
  })

  it('associates post-open conformance failure with the exact Trial destination', async () => {
    const open = vi.fn()
    const result = prepareBlueprintTrialSession(request, {
      create: async () => ({
        sessionId: 'trial-1' as never,
        agentPreset: 'listed-company-research',
      }),
      waitUntilAddressable: async () => undefined,
      notePreset: vi.fn(),
      installContext: async () => undefined,
      validate: async () => { throw new Error('validation RPC unavailable') },
      mayOpen: () => true,
      open,
    })

    await expect(result).rejects.toMatchObject({
      name: 'BlueprintTrialValidationError',
      sessionId: 'trial-1',
      message: 'validation RPC unavailable',
    } satisfies Partial<BlueprintTrialValidationError>)
    expect(open).toHaveBeenCalledWith('trial-1')
  })

  it.each([
    ['Session', validation('third-session')],
    ['preset', validation('trial-1', 'other-preset')],
    ['expected revision', validation('trial-1', request.presetId, 'other-revision')],
  ] as const)('rejects a post-open validation response with a mismatched %s identity', async (_field, response) => {
    const open = vi.fn()
    const result = prepareBlueprintTrialSession(request, {
      create: async () => ({
        sessionId: 'trial-1' as never,
        agentPreset: request.presetId,
      }),
      waitUntilAddressable: async () => undefined,
      notePreset: vi.fn(),
      installContext: async () => undefined,
      validate: async () => response,
      mayOpen: () => true,
      open,
    })

    await expect(result).rejects.toMatchObject({
      name: 'BlueprintTrialValidationError',
      sessionId: 'trial-1',
      message: 'Trial validation response does not match the created Session, preset, and expected revision',
    } satisfies Partial<BlueprintTrialValidationError>)
    expect(open).toHaveBeenCalledWith('trial-1')
  })
})
