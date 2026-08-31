// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup } from '@testing-library/react'
import type { ISession, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotTestRuntime, stubSettingsScope, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ConversationDefaultDetailsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { createChatStore } from '../src/client/stores.ts'

const SESSION_ID = 'external-details-session' as SessionId

type RootProps = PropsRenderSlots<'conversation' | 'details'>

function TestRoot({ renderSlot }: RootProps) {
  return <>{renderSlot('conversation', {})}{renderSlot('details', {})}</>
}

function ExternalSessionInspector({ sessionId }: ConversationDefaultDetailsProps) {
  return <div data-testid="external-session-inspector">Inspector for {sessionId}</div>
}

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

usePinnedBrowserLanguages('en')

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('default details extension', () => {
  it('mounts a non-Blueprint Session inspector before declaration and restores the usable fallback on unload', async () => {
    const runtime = await SlotTestRuntime.create()
    runtime.provide('connection', { api: { settings: {} }, isLoopback: false })
    runtime.provide('remote', { $on: () => () => {} })
    runtime.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
    const layout = { openDetails: vi.fn(), closeDetails: vi.fn() }
    runtime.provide('layout', layout)
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.provide('locale', locale)
    runtime.slots.installLocale(locale)
    await runtime.sessions.add({
      id: SESSION_ID,
      summary: { title: 'External details', displayTitle: 'External details' },
      session: {
        loadOlder: vi.fn<ISession['loadOlder']>(),
        prompt: vi.fn<ISession['prompt']>(async () => ({ ok: true, value: { accepted: true } })),
      },
    })
    await runtime.root.declare({
      'conversation': { kind: 'single', scope: 'session-maybe' },
      'details': { kind: 'single', scope: 'session' },
    }, TestRoot)

    const external = runtime.ctx.plugin({
      name: 'external-session-inspector',
      inject: ['slots', 'layout'],
      apply(ctx) {
        ctx.slots.inject('conversation.details.default', () => {
          const dispose = ctx.slots.register(
            { name: 'conversation.details.default' },
            ExternalSessionInspector,
          )
          ctx.layout.openDetails()
          return dispose
        })
      },
    })
    await external.await()
    expect(runtime.slots.entries('conversation.details.default')).toHaveLength(0)

    await runtime.mount({ inject: [...inject], apply })
    const view = runtime.renderRoot()
    expect(view.getByTestId('external-session-inspector').textContent)
      .toBe(`Inspector for ${SESSION_ID}`)
    expect(layout.openDetails).toHaveBeenCalledOnce()

    const chat = runtime.storeOf('details', SESSION_ID) as ReturnType<ReturnType<typeof createChatStore>['create']>
    act(() => { chat.actions.select({ turnSeq: 1, callId: 'transient', toolName: 'External Tool' }) })
    await runtime.flush()
    expect(view.queryByTestId('external-session-inspector')).toBeNull()
    expect(view.getByText('External Tool')).toBeTruthy()
    act(() => { chat.actions.select(null) })
    await runtime.flush()
    expect(view.getByTestId('external-session-inspector')).toBeTruthy()

    await external.dispose()
    await runtime.flush()
    expect(view.queryByTestId('external-session-inspector')).toBeNull()
    expect(view.getByText('Details')).toBeTruthy()
    view.getByRole('button', { name: 'Close details' }).click()
    expect(layout.closeDetails).toHaveBeenCalledOnce()
    await runtime.dispose()
  })
})
