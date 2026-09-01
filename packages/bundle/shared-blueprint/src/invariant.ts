/** Package-owned invariant companion for `dsh-shared-blueprint`. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { installBlueprintInvariants } from './host/invariant.ts'

const PACKAGE_NAME = 'dsh-shared-blueprint'

/** Cordis companion plugin name. */
export const name = 'shared-blueprint-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

const install: InvariantInstaller = Object.assign(
  (ctx: Context, fail: InvariantFailure) => installBlueprintInvariants(ctx, fail),
  { inject: ['sessions'] },
)

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
