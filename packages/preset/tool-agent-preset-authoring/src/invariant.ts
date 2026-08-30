/** Package-owned invariant companion for the preset authoring Tool Consumer. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-agent-preset-authoring'

/** Cordis companion plugin name. */
export const name = 'tool-agent-preset-authoring-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: the Consumer delegates every relationship to `agentPresets` and `tools`. */
const install: InvariantInstaller = () => {}

/**
 * Register the package's empty invariant ownership declaration.
 * @param ctx - Cordis context carrying the invariant registry.
 * @returns the registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
