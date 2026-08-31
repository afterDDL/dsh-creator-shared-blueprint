/** Host bootstrap for the browser-only Interactive Blueprint surface. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'

/**
 * Inject a caller-owned Demo bootstrap before the production Web shell runs.
 * @param html - production index document.
 * @param bootstrap - parsed JSON value consumed by the browser adapter.
 * @returns index document containing the escaped bootstrap assignment.
 */
export function injectBlueprintDemoBootstrap(html: string, bootstrap: unknown): string {
  const json = JSON.stringify(bootstrap).replaceAll('<', '\\u003c')
  const script = `<script>window.__DSH_BLUEPRINT_DEMO__ = ${json}</script>`
  const head = html.indexOf('<head>')
  if (head !== -1) return `${html.slice(0, head + 6)}${script}${html.slice(head + 6)}`
  return `${script}${html}`
}

/** Parse the build-owned JSON once so malformed preview wiring fails at load. */
function parseBootstrap(source: string): unknown {
  try {
    return JSON.parse(source) as unknown
  } catch (error) {
    throw new Error('shared-blueprint: demoBootstrapJson must contain valid JSON', { cause: error })
  }
}

/**
 * Register the optional Demo bootstrap index transform; ordinary deployments
 * omit the configuration and retain the production Blueprint binding.
 * @param ctx - Host context that may acquire the HTTP service.
 * @param source - preview-only bootstrap document.
 */
export function installBlueprintDemoBootstrap(ctx: Context, source: string): void {
  const bootstrap = parseBootstrap(source)
  ctx.inject(['webServer'], (httpCtx) => {
    httpCtx.effect(
      () => httpCtx.webServer.tapIndex(html => injectBlueprintDemoBootstrap(html, bootstrap)),
      'shared-blueprint: Demo bootstrap injection',
    )
  })
}
