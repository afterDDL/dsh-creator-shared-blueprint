/** Package invariant companion for the Interactive Blueprint UI. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-blueprint'

/** Cordis companion plugin name. */
export const name = 'client-ui-blueprint-invariant'
/** Service required before reserving package ownership. */
export const inject = ['invariants']

/** No runtime invariant: slot disposal and Host state are covered by focused composition tests. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
