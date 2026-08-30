import { Context } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, it } from 'vitest'
import { apply, injectBlueprintDemoBootstrap } from '../src/index.ts'

describe('ui-blueprint Host preview bootstrap', () => {
  it('escapes script-breaking JSON and injects it before the Web shell', () => {
    const html = injectBlueprintDemoBootstrap(
      '<html><head></head><body><script type="module"></script></body></html>',
      { seeds: [{ label: '</script><script>fail()</script>' }] },
    )
    expect(html).toContain('window.__DSH_BLUEPRINT_DEMO__')
    expect(html).toContain('\\u003c/script>')
    expect(html.indexOf('window.__DSH_BLUEPRINT_DEMO__')).toBeLessThan(html.indexOf('type="module"'))
  })

  it('registers and disposes the transform only for explicit Demo configuration', async () => {
    const ctx = new Context()
    let transform: ((html: string) => string) | undefined
    let disposed = false
    ctx.provide('webServer', {
      tapIndex: (next: (html: string) => string) => {
        transform = next
        return () => { disposed = true }
      },
    } as WebServer)

    const production = ctx.plugin({ apply }, {})
    await production.await()
    expect(transform).toBeUndefined()
    await production.dispose()

    const preview = ctx.plugin({ apply }, { demoBootstrapJson: '{"seeds":[]}' })
    await preview.await()
    expect(transform?.('<head></head>')).toContain('"seeds":[]')
    await preview.dispose()
    expect(disposed).toBe(true)
  })

  it('rejects malformed preview JSON at plugin load', async () => {
    const ctx = new Context()
    await expect(ctx.plugin({ apply }, { demoBootstrapJson: '{' }).await())
      .rejects.toThrow('demoBootstrapJson must contain valid JSON')
  })
})
