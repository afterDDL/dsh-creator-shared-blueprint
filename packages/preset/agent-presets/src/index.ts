/**
 * Agent presets: each session composes its model-facing plugin set from one
 * preset `cordis.yml`, mounted ONCE per preset under a standing scope and
 * joined by every agent that names it.
 *
 * The standing mount is what makes a preset one composition rather than one
 * per session: its plugin instances, tool registrations, prompt sections, and
 * projection units exist exactly once, keyed per session inside the plugins
 * themselves (they predate presets and were written for a shared world). An
 * agent joins by having its scope key parented to the mount's
 * ({@link bindScopeParent}), which makes the mount's registrations visible to
 * that agent's views and the mount's listeners receive that agent's events —
 * and a host reader with no agent at all (a cold transcript read) resolves
 * the same standing registrations by preset id.
 *
 * This package owns the preset vocabulary, filesystem discovery, and the
 * guarded standing mount. It does not decide when an agent is created — the
 * agent factory's `setup(agentCtx)` hook is the one supported call site,
 * because only there is the join installed while the agent is still
 * unpublished, so a rejected composition rolls the whole creation back.
 * @module @deepseek-ai/dsh-agent-presets
 */

import { stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { bindScopeParent, createScope, scopeOf, type Scope, type ScopeKey, type ScopeParentBinding } from '@deepseek-ai/dsh-scope'
// Type-only: resolves the `agent/created` lifecycle event this service watches.
import type {} from '@deepseek-ai/dsh-agent'
import { settingsNamespace, type SettingsScope, type default as SettingsService } from '@deepseek-ai/dsh-settings'
import { dshHomePath, expandHomePath } from '@deepseek-ai/dsh-home-paths'
import { discoverPresets, USER_PRESET_DIR } from './discovery.ts'
import { copyComposition, deleteComposition, readComposition } from './authoring.ts'
import { mountPreset, serviceForAgent, standingMountFor } from './mount.ts'
import { PresetExistsError } from './authoring.ts'
import { PresetMountError, UnknownPresetError, type AgentPreset, type Config, type PresetRoot } from './preset.ts'
import {
  cleanupAgentPresetTransaction,
  discardAgentPresetTransaction,
  fenceAgentPresetTransaction,
  prepareAgentPresetTransaction,
  publishAgentPresetTransaction,
  recoverAgentPresetTransaction,
  resolveAgentPresetTransaction,
  type AgentPresetTransaction,
  type AgentPresetTransactionDisposition,
  type AgentPresetTransactionOptions,
  type AgentPresetTransactionRecovery,
} from './transaction.ts'
import type {} from './types.ts'

/** Settings namespace carrying the user's chosen default preset. */
export const SETTINGS_NAMESPACE = 'agent-presets'

/** The user-writable slice of this plugin's config. */
export interface AgentPresetSettings {
  /** Preset mounted when a session names none. */
  default?: string
}

/** One committed preset generation captured for a Host-side projection. */
export interface AgentPresetProjectionSnapshot {
  /** Committed preset metadata resolved in the snapshot's filesystem operation. */
  readonly preset: AgentPreset
  /** Exact committed composition mounted by this snapshot. */
  readonly composition: string
  /** Standing registration scope for the same composition generation. */
  readonly standingKey: ScopeKey
}

/** Runtime schema for the user-writable slice. */
export const AgentPresetSettingsSchema: z<AgentPresetSettings> = z.object({
  default: z.string(),
})

export { COMPOSITION_FILE, discoverPresets, scanRoot } from './discovery.ts'
export {
  METADATA_FILE, readPresetMetadata, renderPresetMetadata, type PresetMetadata,
} from './metadata.ts'
export {
  inactiveRows, leakedServices, livePresetMounts, mountPreset, serviceForAgent, standingMountFor,
  type JoinedPresetMount, type PresetMount,
} from './mount.ts'
export {
  copyComposition, deleteComposition, InvalidPresetIdError, PresetExistsError,
  PresetNotWritableError, readComposition, writableRoot,
} from './authoring.ts'
export { resolveSessionPreset, type PresetBearingSession } from './session.ts'
export { PresetMountError, UnknownPresetError } from './preset.ts'
export type { AgentPreset, Config, PresetRoot, PresetTrust } from './preset.ts'
export {
  agentPresetTreeDigest,
  AgentPresetTransactionNotFoundError,
  type AgentPresetTransaction,
  type AgentPresetTransactionDisposition,
  type AgentPresetTransactionOptions,
  type AgentPresetTransactionRecovery,
} from './transaction.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentPresets: AgentPresets
  }
}

/**
 * Registry over the deployment's agent presets.
 *
 * Discovery is unmemoized: `list()` and `resolve()` re-read the roots on every
 * call so a preset authored while the process runs is visible immediately,
 * and a preset deleted underneath a picker disappears from the next read.
 */
export class AgentPresets extends Service {
  static inject = ['loader']

  /** Runtime schema for the preset roster. */
  static Config = z.object({
    default: z.string().required(),
    roots: z.array(z.object({
      path: z.string().required(),
      trust: z.union(['system', 'user'] as const).default('user'),
    })).default([]),
    includeUserRoot: z.boolean().default(true),
  }) as z<Config>

  /**
   * The roots discovery and authoring actually scan: every configured root in
   * order, then the harness-home user root unless `includeUserRoot` is false.
   *
   * Derived once, because a root set that changed between `list()` and the
   * `copy()` acting on its answer would author into a directory the caller
   * never saw. Appending rather than prepending keeps an earlier configured
   * root winning a duplicate id, so a shipped preset still shadows a
   * locally authored directory that claimed its name.
   */
  private readonly resolvedRoots: readonly PresetRoot[]

  /**
   * FIFO gates around formal preset filesystem operations.
   *
   * `roster` excludes whole-roster discovery from any publication, while one
   * `preset:<id>` key excludes only operations that can dereference that
   * preset's formal path. Promise values never reject, so a failed operation
   * cannot poison the next waiter.
   */
  private readonly formalFilesystemGates = new Map<string, Promise<void>>()

  /**
   * The user layer over `config.default`, present only while a settings
   * provider is composed. Held rather than snapshotted so a hot-reloaded
   * document takes effect without a restart.
   */
  private settings: SettingsScope<AgentPresetSettings> | undefined

  /**
   * The settings service behind {@link settings}, held for the one write this
   * service makes: clearing a user default it has just deleted.
   */
  private settingsService: SettingsService | undefined

  /**
   * The service's own untraced context. Methods invoked through the traceable
   * proxy see `this.ctx` rebound to the CALLER's context, which carries a
   * shadow; a subtree minted from it resolves every service through that
   * shadow's fiber instead of each entry's own inject store, so preset rows
   * would fail on the very services they declare. Standing mounts must hang
   * off the untraced original (the `jobs-local` selfCtx precedent).
   */
  private readonly selfCtx: Context

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'agentPresets')
    this.selfCtx = ctx
    this.resolvedRoots = config.includeUserRoot
      ? [...config.roots, { path: dshHomePath(USER_PRESET_DIR), trust: 'user' }]
      : [...config.roots]
    // Deliberately not `installSettingsSection`: that helper exists to re-judge
    // what a consumer DERIVED from the source — memoized resolutions,
    // registration-level facts — across attach, detach, and change. Nothing
    // here is derived. `defaultId` reads through on every call, so both of its
    // hooks would be no-ops and the source thunk would restate this field.
    ctx.inject(['settings'], (settingsCtx) => {
      this.settings = settingsCtx.settings.register(
        settingsNamespace(SETTINGS_NAMESPACE),
        AgentPresetSettingsSchema,
        { base: { default: config.default } },
      )
      this.settingsService = settingsCtx.settings
      settingsCtx.effect(() => () => {
        this.settings = undefined
        this.settingsService = undefined
      }, 'agentPresets.settings()')
    })

    // Advisory, not fatal: a synchronous `agent/created` listener that throws
    // VETOES publication, and this service must not, because composing an agent
    // outside the roster is legal — `recompose` binds exactly such a bare agent
    // below, and the ACP, SDK-server, and headless entry points all create one.
    // The invariant companion is the check that fails loud, at assembly. Why an
    // unjoined agent matters at all has one home: the [Agent
    // Note](../../../../.agents/notes/implemented/architecture/2026-08-10-host-plane-ownership-after-presets.md).
    //
    // Known false positive: a session created bare and bound later by
    // `recompose` is warned about once, before its first bind. No shipped flow
    // does that today — the Web surface mounts in `setup` and children join
    // through `composeFrom` before publication.
    ctx.on('agent/created', ({ agent }) => {
      if (this.resolvedRoots.length === 0) return
      if (this.composedPreset(agent.ctx) !== undefined) return
      ctx.logger.warn(
        `agent "${agent.id}" was published without joining an agent preset; `
        + 'its tools, prompt sections, and skill catalog resolve against the empty global layer '
        + '(join through AgentPresets.mount() or composeFrom() in the agent factory setup)',
      )
    })

    // The durable record is the commit point. Its public notification carries
    // only the stable identity needed by clients, never the live Session.
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'agent-preset/selected') return
      ctx.emit('agent-preset/selected', session.id, event.data.agentPreset)
    })
  }

  /**
   * The preset id mounted when a caller names none.
   *
   * Read per call rather than cached: the settings document is hot-reloaded, so
   * changing the default takes effect on the next session created and leaves
   * every running session on the preset it was composed from.
   */
  get defaultId(): string {
    return this.settings?.get().default ?? this.config.default
  }

  /** Run one FIFO formal-filesystem critical section. */
  private async runFormalFilesystemOperation<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const predecessor = this.formalFilesystemGates.get(key)
    const current = Promise.withResolvers<void>()
    this.formalFilesystemGates.set(key, current.promise)
    if (predecessor !== undefined) await predecessor
    try {
      return await operation()
    } finally {
      current.resolve()
      if (this.formalFilesystemGates.get(key) === current.promise) {
        this.formalFilesystemGates.delete(key)
      }
    }
  }

  /** Run one operation while every named formal preset path is stable. */
  private async withStablePresets<T>(ids: readonly string[], operation: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(ids)].sort()
    const enter = async (index: number): Promise<T> => {
      const id = ordered[index]
      if (id === undefined) return await operation()
      return await this.runFormalFilesystemOperation(`preset:${id}`, async () => await enter(index + 1))
    }
    return await enter(0)
  }

  /** Discover the committed roster when the caller already owns the required gate. */
  private async discoverCommitted(): Promise<AgentPreset[]> {
    return await discoverPresets(this.resolvedRoots)
  }

  /** Resolve one committed preset when its formal path is already stable. */
  private async resolveCommitted(id: string): Promise<AgentPreset> {
    const presets = await this.discoverCommitted()
    const found = presets.find(preset => preset.id === id)
    if (found === undefined) {
      throw new UnknownPresetError(id, presets.map(preset => preset.id))
    }
    return found
  }

  /**
   * Every preset the configured roots currently supply.
   * @returns the presets, first-root-wins per id.
   */
  async list(): Promise<AgentPreset[]> {
    return await this.runFormalFilesystemOperation('roster', async () => await this.discoverCommitted())
  }

  /**
   * List the roster through one agent's scoped preset projection.
   *
   * A registered candidate replaces only the committed row with the same id;
   * every other row and its order remain unchanged. A candidate for an id not
   * yet committed is appended, which keeps it addressable to its owner without
   * publishing it through {@link list}.
   * @param agentCtx - scoped agent whose private overlay may be visible.
   * @returns the committed roster with that scope's preset overlaid.
   */
  async listFor(agentCtx: Context): Promise<AgentPreset[]> {
    const overlay = this.scopedOverlay(agentCtx)
    const presets = await this.list()
    if (overlay === undefined) return presets
    const index = presets.findIndex(preset => preset.id === overlay.id)
    if (index < 0) return [...presets, overlay]
    return presets.map((preset, candidateIndex) => candidateIndex === index ? overlay : preset)
  }

  /**
   * Resolve one preset by id.
   *
   * A broken preset resolves — deleting one, reading one, and reporting one
   * all need the row — and the mounting paths refuse it AFTER resolution
   * through {@link resolveMountable}.
   * @param id - the preset id, or `undefined` for {@link defaultId}.
   * @returns the resolved preset.
   * @throws when no configured root supplies that id.
   */
  async resolve(id?: string): Promise<AgentPreset> {
    const wanted = id ?? this.defaultId
    return await this.withStablePresets([wanted], async () => await this.resolveCommitted(wanted))
  }

  /**
   * Resolve a preset through one agent's private projection.
   * @param agentCtx - scoped agent whose overlay may satisfy the id.
   * @param id - preset id, or `undefined` for {@link defaultId}.
   * @returns the overlay for its target id, otherwise the committed preset.
   * @throws when neither the overlay nor the committed roster supplies the id.
   */
  async resolveFor(agentCtx: Context, id?: string): Promise<AgentPreset> {
    const wanted = id ?? this.defaultId
    const overlay = this.scopedOverlay(agentCtx)
    if (overlay?.id === wanted) return overlay
    return await this.resolve(wanted)
  }

  /**
   * Resolve one preset that is about to compose an agent, refusing a broken
   * one with its discovery-reported reason. Failing here rather than inside
   * the loader keeps the answer the same for every unloadable shape — ghost
   * directory, unparsable YAML, rowless list — and spends no mount attempt
   * on a composition discovery already read as unusable.
   * @param id - the preset id, or `undefined` for {@link defaultId}.
   * @returns the resolved, mountable preset.
   * @throws when the preset is unknown or discovery reports it broken.
   */
  private async resolveMountable(id: string): Promise<AgentPreset> {
    return this.assertMountable(await this.resolveCommitted(id))
  }

  /** Refuse a discovery-reported broken preset before asking the Loader to mount it. */
  private assertMountable(preset: AgentPreset): AgentPreset {
    if (preset.broken !== undefined) {
      throw new PresetMountError(preset.id, preset.broken)
    }
    return preset
  }

  /**
   * Standing mounts by preset id, single-flight so two agents racing the
   * first use of one preset share one composition. A settled failure is
   * removed so a later session retries a preset whose file has been fixed; a
   * settled success serves until the composition FILE visibly changes — each
   * generation records its file stamp, and a stale stamp starts the next
   * generation for sessions created afterwards. Sessions already joined keep
   * the generation they run on; a superseded one is never disposed while the
   * process lives (reclaimed only by whole-tree teardown), so editing files
   * is bounded by how often compositions change, not by session count.
   */
  private readonly standing = new Map<string, Promise<StandingMount>>()

  /**
   * Parent bindings of the agents this roster composed, keyed by the agent's
   * scope key. The binding is dsh-scope's only re-link capability; holding it
   * here makes this service the sole authority that can move an agent between
   * standing compositions. WeakMap: entries die with their agents.
   */
  private readonly bindings = new WeakMap<ScopeKey, ScopeParentBinding>()

  /**
   * Candidate compositions visible only through one scoped projection.
   *
   * The key is the caller's exact agent scope rather than a preset id, so the
   * committed roster can keep serving the same id while one plugin inspects or
   * edits a private copy. Weak ownership plus the registered scope effect
   * prevents a disposed consumer from leaving an overlay addressable.
   */
  private readonly scopedOverlays = new WeakMap<ScopeKey, AgentPreset>()

  /** Resolve the exact scope key required by every scoped-overlay method. */
  private overlayScope(agentCtx: Context): ScopeKey {
    const key = scopeOf(agentCtx)
    if (key === undefined) {
      throw new Error('agent-presets: a preset overlay requires a scoped agent context')
    }
    return key
  }

  /** Read the preset overlay registered for one scope, when it has one. */
  private scopedOverlay(agentCtx: Context): AgentPreset | undefined {
    return this.scopedOverlays.get(this.overlayScope(agentCtx))
  }

  /**
   * Register one private preset projection for a scoped agent.
   *
   * Only the explicit `*For(agentCtx)` methods read the overlay; ordinary
   * roster methods continue to address committed files.
   * @param agentCtx - scoped agent that owns the projection.
   * @param preset - replacement preset identity and composition path.
   * @returns an idempotent disposer that removes this exact registration.
   * @throws when the context is unscoped or already owns an overlay.
   */
  registerScopedOverlay(agentCtx: Context, preset: AgentPreset): () => Promise<void> {
    const key = this.overlayScope(agentCtx)
    if (this.scopedOverlays.has(key)) {
      throw new Error('agent-presets: this scope already has a preset overlay')
    }
    this.scopedOverlays.set(key, preset)
    return agentCtx.effect(() => () => {
      if (this.scopedOverlays.get(key) === preset) this.scopedOverlays.delete(key)
    }, `agentPresets.scopedOverlay(${JSON.stringify(preset.id)})`)
  }

  /**
   * Compose one agent from a preset: ensure the preset's standing mount, then
   * parent the agent's scope key to it so the mount's registrations and
   * listeners cover this agent.
   *
   * Call from the agent factory's `setup(agentCtx)`; a rejection there rolls
   * the agent creation back, so a broken preset never yields a half-composed
   * session.
   * @param agentCtx - the agent's scope context.
   * @param id - the preset id, or `undefined` for {@link defaultId}.
   * @returns the preset that was composed, for the caller to record.
   * @throws when the preset is unknown or its composition is unusable.
   */
  async mount(agentCtx: Context, id?: string): Promise<AgentPreset> {
    const agentKey = scopeOf(agentCtx)
    if (agentKey === undefined) {
      throw new Error('agent-presets: refusing to compose an unscoped context; the scope key is what joins an agent to its preset')
    }
    const wanted = id ?? this.defaultId
    return await this.withStablePresets([wanted], async () => {
      const preset = await this.resolveMountable(wanted)
      const standing = await this.ensureStanding(preset)
      // The one bind of this agent's ancestry. The binding is the only re-link
      // authority, held privately so nothing outside this roster can move a
      // composed agent to another preset; a later recompose layer re-links
      // through it under the caller-owned blank-session contract.
      this.bindings.set(agentKey, bindScopeParent(agentKey, standing.key))
      return preset
    })
  }

  /**
   * Compose one fresh agent from an isolated preset without publishing a
   * standing generation.
   *
   * The candidate receives an independent composition scope that is parented
   * only to this agent and disposed with it. It therefore exercises the same
   * Loader and scope checks as a real Session while remaining unreachable to
   * sessions on the committed preset id.
   * @param agentCtx - fresh agent's scope context.
   * @param preset - exact isolated composition to mount.
   * @returns the isolated preset that was composed.
   * @throws when the agent is unscoped, already composed, or the preset is unusable.
   */
  async mountIsolated(agentCtx: Context, preset: AgentPreset): Promise<AgentPreset> {
    const agentKey = scopeOf(agentCtx)
    if (agentKey === undefined) {
      throw new Error('agent-presets: refusing to compose an unscoped isolated context')
    }
    if (this.bindings.has(agentKey)) {
      throw new Error('agent-presets: refusing to replace an already composed isolated agent')
    }
    this.assertMountable(preset)
    const key: ScopeKey = { agentPresetCandidate: preset.id }
    const scope = createScope(this.selfCtx, key)
    try {
      await mountPreset(scope.ctx, preset)
      this.bindings.set(agentKey, bindScopeParent(agentKey, key))
      agentCtx.effect(() => () => scope.dispose(), `agentPresets.isolatedMount(${JSON.stringify(preset.id)})`)
      return preset
    } catch (error) {
      await scope.dispose()
      throw error
    }
  }

  /**
   * Join one agent to the SAME standing composition another already runs on.
   *
   * This is how a child agent inherits its parent's capabilities. It is a bind,
   * not a mount: the parent's generation is already composed, so the child gets
   * that exact instance — the same plugin objects, the same tool registrations,
   * the same prompt sections. Re-resolving the parent's preset by id instead
   * would re-read the roster, and a composition file edited since the parent
   * started would hand the child a DIFFERENT generation than the one its
   * parent's history was produced under (and a preset deleted since would fail
   * the child outright while its parent keeps running).
   *
   * Synchronous, and with no composition failure mode of its own — it reads no
   * roster, mounts nothing, and touches no file — which is what lets a child
   * creation window use it: the two in-process subagent drivers compose their
   * children inside a synchronous `setup`. It still rejects a caller error, as
   * the `@throws` below record.
   *
   * A parent that joined no preset — a rosterless deployment — yields no join
   * and no error: there, the model-facing rows sit in the host composition and
   * the child already sees them through the global layer.
   * @param agentCtx - the joining agent's scope context.
   * @param parentCtx - the scope context of the agent whose composition to join.
   * @returns the preset id joined, or undefined when the parent joined none.
   * @throws when `agentCtx` carries no scope, or has already joined a preset.
   */
  composeFrom(agentCtx: Context, parentCtx: Context): string | undefined {
    const agentKey = scopeOf(agentCtx)
    if (agentKey === undefined) {
      throw new Error('agent-presets: refusing to compose an unscoped context; the scope key is what joins an agent to its preset')
    }
    const standing = standingMountFor(parentCtx)
    if (standing === undefined) return undefined
    this.bindings.set(agentKey, bindScopeParent(agentKey, standing.key))
    return standing.presetId
  }

  /**
   * The preset one live agent runs on.
   *
   * Read from the live scope chain rather than from the session, so it answers
   * for an agent whose session has not recorded a preset yet — a child agent
   * whose durable header is being built from its parent's composition.
   * @param agentCtx - the agent's scope context.
   * @returns the preset id, or undefined when the agent joined none.
   */
  composedPreset(agentCtx: Context): string | undefined {
    return standingMountFor(agentCtx)?.presetId
  }

  /**
   * The roots this roster scans, which is not `config.roots`: it is every
   * configured root in order, then the harness-home user root unless
   * `includeUserRoot` is false. Read this — not the config field — to answer
   * whether a roster is composed at all, so one derivation decides it.
   */
  get roots(): readonly PresetRoot[] {
    return this.resolvedRoots
  }

  /** Whether this deployment has a root locally authored presets go to. */
  get authorable(): boolean {
    return this.resolvedRoots.some(root => root.trust === 'user')
  }

  /**
   * Read one preset's composition text.
   * @param id - the preset id.
   * @returns the composition exactly as stored.
   * @throws when no configured root supplies that id.
   */
  async read(id: string): Promise<string> {
    return await this.withStablePresets([id], async () => await readComposition(await this.resolveCommitted(id)))
  }

  /**
   * Read a composition through one agent's private preset projection.
   * @param agentCtx - scoped agent whose overlay may satisfy the id.
   * @param id - the preset id.
   * @returns the selected composition exactly as stored.
   */
  async readFor(agentCtx: Context, id: string): Promise<string> {
    const overlay = this.scopedOverlay(agentCtx)
    if (overlay?.id === id) return await readComposition(overlay)
    return await this.read(id)
  }

  /**
   * Mount-validate a preset through one agent's private projection.
   *
   * The candidate target is mounted in a disposable one-shot scope so neither
   * success nor failure enters the committed standing cache. Other ids retain
   * the ordinary standing-validation behavior.
   * @param agentCtx - scoped agent whose overlay may satisfy the id.
   * @param id - the preset id to validate.
   */
  async validateFor(agentCtx: Context, id: string): Promise<void> {
    const overlay = this.scopedOverlay(agentCtx)
    if (overlay === undefined || overlay.id !== id) {
      await this.standingKeyFor(id)
      return
    }
    const preset = this.assertMountable(await this.resolveFor(agentCtx, id))
    const validation = createScope(this.selfCtx, { agentPresetCandidateValidation: preset.id })
    try {
      await mountPreset(validation.ctx, preset)
    } finally {
      await validation.dispose()
    }
  }

  /**
   * Create a locally authored preset by copying an existing one whole.
   *
   * Copy is the only authoring write. Composition text never crosses this
   * seam: the source is named by id and its directory is copied as it stands,
   * so the copy is exactly as loadable as its source and authoring grants no
   * capability the roster did not already carry. The copy is NOT mounted to
   * validate — a source that mounts today yields a copy that mounts today.
   * @param from - the preset the copy starts from; shipped presets are the
   * primary source, so any trust is accepted.
   * @param id - the new preset's id, which becomes its directory name.
   * @param name - display name for the copy; absent falls back to the id.
   * @throws when the source is unknown, the id is unusable or already taken,
   * or the deployment configures no writable root.
   */
  async copy(from: string, id: string, name?: string): Promise<void> {
    await this.withStablePresets([from, id], async () => {
      const source = await this.resolveCommitted(from)
      // The roster check refuses ids any root supplies — shipped ones included,
      // since a user directory named like a shipped preset is shadowed by it.
      // The disk check inside copyComposition only sees the writable root.
      if ((await this.discoverCommitted()).some(preset => preset.id === id)) {
        throw new PresetExistsError(id)
      }
      await copyComposition(this.resolvedRoots, source, id, name)
      // A settled mount under this id can only be stale (its preset was deleted
      // from disk outside `remove`); the new preset must not inherit it. Every
      // session already joined keeps the generation it runs on regardless.
      this.standing.delete(id)
    })
  }

  /**
   * Copy through one scoped projection, refusing a second authoring target.
   * @param agentCtx - executing scoped agent.
   * @param from - the committed source preset id.
   * @param id - the new preset id.
   * @param name - optional display name.
   * @throws when the scope owns a preset overlay.
   */
  async copyFor(agentCtx: Context, from: string, id: string, name?: string): Promise<void> {
    const overlay = this.scopedOverlay(agentCtx)
    if (overlay !== undefined) {
      throw new Error(
        `agent-presets: preset_copy is unavailable while preset "${overlay.id}" is overlaid; `
        + 'use the projected preset returned by preset_resolve instead',
      )
    }
    await this.copy(from, id, name)
  }

  /**
   * Delete a locally authored preset.
   * @param id - the preset id.
   * @throws when the preset is unknown or ships with the deployment.
   */
  async remove(id: string): Promise<void> {
    await this.withStablePresets([id], async () => {
      await deleteComposition(this.resolvedRoots, await this.resolveCommitted(id))
      // Sessions on the deleted preset keep their standing mount; only new
      // sessions see the roster without it.
      this.standing.delete(id)
      // Storing a default that does not exist YET is deliberate — the roster is a
      // live directory, so a name absent now may exist by the time a session asks
      // for it, and `resolve` reports it then. A default this call just deleted is
      // not that case: nothing will ever supply it again, and left in place every
      // session created without an explicit pick would fail to start. Clearing it
      // exposes the deployment's own default underneath, which is the layering.
      if (this.settings?.get().default !== id) return
      await this.settingsService?.mutate(
        settingsNamespace(SETTINGS_NAMESPACE),
        [{ op: 'unset', path: ['default'] }],
      )
    })
  }

  /**
   * One agent's instance of a service its preset mounted.
   *
   * A preset publishes services behind `isolate` realms, which are invisible
   * outside the group that declares them — including to the host. This is how a
   * caller holding the agent reads one anyway: a request that is ABOUT a
   * session but arrives from outside it, which is every browser RPC.
   *
   * Read addressing only. A host row that `inject`s a service cannot use this,
   * because injection resolves before any session exists and has no agent to
   * key by; such a service belongs on the host plane instead.
   * @param agent - the agent whose composition to look inside.
   * @param name - the service name as the preset's rows resolve it.
   * @returns the agent's instance, or undefined when its preset mounts none.
   */
  serviceFor<K extends string & keyof Context>(agent: { ctx: Context }, name: K): Context[K] | undefined {
    return serviceForAgent(this.ctx, agent, name)
  }

  /**
   * Re-link one agent to a different preset's standing composition.
   *
   * Only valid while the agent has produced nothing: swapping tools mid
   * conversation would leave logged tool calls the new composition cannot
   * make. The CALLER owns that check — this method does not read session
   * history.
   *
   * The swap is a parent re-link, not an unmount: standing mounts are shared
   * and permanent, so the old composition stays for its other agents and the
   * new one is ensured BEFORE the link moves. An unknown or unusable preset
   * therefore throws with the agent exactly as it was — there is no torn-down
   * state to restore. The re-link runs through the binding this roster kept
   * from the agent's mount — dsh-scope's only re-link authority. An agent
   * that never composed one has nothing to re-link: the switch is then the
   * agent's first bind, exactly a mount.
   * @param agentCtx - the agent's scope context.
   * @param id - the preset to compose the agent from instead.
   * @returns the preset now installed.
   * @throws when the preset is unknown or its composition is unusable.
   */
  async recompose(agentCtx: Context, id: string): Promise<AgentPreset> {
    const agentKey = scopeOf(agentCtx)
    if (agentKey === undefined) {
      throw new Error('agent-presets: refusing to recompose an unscoped context')
    }
    return await this.withStablePresets([id], async () => {
      const preset = await this.resolveMountable(id)
      const standing = await this.ensureStanding(preset)
      const binding = this.bindings.get(agentKey)
      if (binding === undefined) {
        this.bindings.set(agentKey, bindScopeParent(agentKey, standing.key))
      } else {
        binding.rebind(standing.key)
      }
      return preset
    })
  }

  /**
   * The standing scope key of one preset, for a host reader with no agent.
   *
   * A cold transcript read resolves tool presenters against the composition
   * the session recorded, and the standing mount makes that possible without
   * resuming anything: ensuring the mount composes plugins but starts no
   * agent, no session, and no turn.
   * @param id - the preset id, or `undefined` for {@link defaultId}.
   * @returns the standing scope key readers pass as a registry view scope.
   * @throws when the preset is unknown or its composition is unusable.
   */
  async standingKeyFor(id?: string): Promise<ScopeKey> {
    const wanted = id ?? this.defaultId
    return await this.withStablePresets([wanted], async () => {
      const preset = await this.resolveMountable(wanted)
      return (await this.ensureStanding(preset)).key
    })
  }

  /**
   * Capture one committed composition and its standing runtime generation.
   *
   * Resolution, content read, and mount share one preset filesystem operation, so
   * a Host projection cannot combine composition text from one publication
   * with registrations from another.
   * @param id - the preset id, or `undefined` for {@link defaultId}.
   * @returns preset metadata, composition text, and the matching standing key.
   * @throws when the preset is unknown or its composition is unusable.
   */
  async projectionSnapshot(id?: string): Promise<AgentPresetProjectionSnapshot> {
    const wanted = id ?? this.defaultId
    return await this.withStablePresets([wanted], async () => {
      const preset = await this.resolveMountable(wanted)
      const composition = await readComposition(preset)
      const standingKey = (await this.ensureStanding(preset)).key
      return { preset, composition, standingKey }
    })
  }

  /**
   * Prepare or re-adopt one isolated transaction against a committed preset.
   * @param id - writable committed preset id.
   * @param options - stable request key and accepted composition revision.
   * @returns durable transaction handle.
   */
  async prepareTransaction(
    id: string,
    options: AgentPresetTransactionOptions,
  ): Promise<AgentPresetTransaction> {
    return await this.runFormalFilesystemOperation('roster', async () => {
      return await this.withStablePresets([id], async () => {
        return await prepareAgentPresetTransaction(await this.resolveCommitted(id), options)
      })
    })
  }

  /**
   * Recover interrupted preparation or settlement while excluding committed readers.
   * @param transaction - durable transaction handle.
   * @returns reconstructed active or terminal state.
   */
  async recoverTransaction(transaction: AgentPresetTransaction): Promise<AgentPresetTransactionRecovery> {
    const id = this.transactionTargetId(transaction)
    return await this.runFormalFilesystemOperation('roster', async () => {
      return await this.withStablePresets([id], async () => {
        const recovery = await recoverAgentPresetTransaction(transaction)
        if (recovery.state === 'committed') this.refreshStanding(id)
        return recovery
      })
    })
  }

  /**
   * Resolve the private candidate without exposing it through committed roster reads.
   * @param transaction - active transaction handle.
   * @returns preset metadata with its composition path redirected to the candidate.
   */
  async resolveTransaction(transaction: AgentPresetTransaction): Promise<AgentPreset> {
    const id = this.transactionTargetId(transaction)
    return await this.withStablePresets([id], async () => {
      return await resolveAgentPresetTransaction(await this.resolveCommitted(id), transaction)
    })
  }

  /**
   * Fence one quiescent candidate for external inspection or validation.
   * @param transaction - active transaction handle.
   * @returns stable complete-tree digest.
   */
  async fenceTransaction(transaction: AgentPresetTransaction): Promise<string> {
    const id = this.transactionTargetId(transaction)
    return await this.withStablePresets([id], async () => {
      return await fenceAgentPresetTransaction(await this.resolveCommitted(id), transaction)
    })
  }

  /**
   * Atomically publish a validated candidate against its unchanged baseline.
   *
   * Committed readers are excluded for the complete crash-recoverable rename
   * sequence. A successful publication also invalidates the standing pointer,
   * so the next agent receives the published directory generation.
   * @param transaction - active or interrupted publishing transaction.
   * @param candidateTreeDigest - complete tree digest retained across validation.
   * @returns durable publication evidence.
   */
  async publishTransaction(
    transaction: AgentPresetTransaction,
    candidateTreeDigest: string,
  ): Promise<AgentPresetTransactionDisposition> {
    const id = this.transactionTargetId(transaction)
    return await this.runFormalFilesystemOperation('roster', async () => {
      return await this.withStablePresets([id], async () => {
        const disposition = await publishAgentPresetTransaction(transaction, candidateTreeDigest)
        this.refreshStanding(id)
        return disposition
      })
    })
  }

  /**
   * Record a safe no-publication settlement against the unchanged baseline.
   * @param transaction - active or publish-prepared transaction.
   * @param candidateTreeDigest - stable candidate tree being abandoned.
   * @returns durable discard evidence.
   */
  async discardTransaction(
    transaction: AgentPresetTransaction,
    candidateTreeDigest: string,
  ): Promise<AgentPresetTransactionDisposition> {
    const id = this.transactionTargetId(transaction)
    return await this.runFormalFilesystemOperation('roster', async () => {
      return await this.withStablePresets([id], async () => {
        return await discardAgentPresetTransaction(transaction, candidateTreeDigest)
      })
    })
  }

  /**
   * Remove isolated storage after the consumer has durably recorded settlement.
   * @param transaction - settled transaction handle.
   */
  async cleanupTransaction(transaction: AgentPresetTransaction): Promise<void> {
    const id = this.transactionTargetId(transaction)
    await this.withStablePresets([id], async () => await cleanupAgentPresetTransaction(transaction))
  }

  /**
   * Exclude committed readers while a pre-transaction consumer recovers its old storage format.
   *
   * New consumers must use the typed transaction methods. This callback exists
   * only until already-persisted external journals have crossed their recovery
   * horizon; it must not create new transaction data.
   * @param id - committed preset whose legacy journal may rename its directory.
   * @param recover - idempotent recovery of an existing legacy journal.
   * @returns recovery result after all filesystem transitions settle.
   * @internal
   */
  async runLegacyPublication<T>(id: string, recover: () => Promise<T>): Promise<T> {
    return await this.runFormalFilesystemOperation('roster', async () => {
      return await this.withStablePresets([id], recover)
    })
  }

  /** Require a transaction target to live directly under a configured writable root. */
  private transactionTargetId(transaction: AgentPresetTransaction): string {
    const target = dirname(resolve(transaction.targetPath))
    const root = dirname(target)
    if (!this.resolvedRoots.some(candidate => candidate.trust === 'user'
      && resolve(expandHomePath(candidate.path)) === root)) {
      throw new Error('agent-presets: transaction target is outside every configured writable root')
    }
    return basename(target)
  }

  /**
   * Make the next Session compose a new generation of one committed preset.
   *
   * Directory-owned inputs can change while the composition file's stamp stays
   * identical. Removing only the pointer makes the next mount re-read the whole
   * preset directory; agents already joined keep their existing generation.
   * @param id - committed preset id whose next mount must be fresh.
   */
  refreshStanding(id: string): void {
    this.standing.delete(id)
  }

  /** Resolve (or create, single-flight) the standing mount of one preset. */
  private async ensureStanding(preset: AgentPreset): Promise<StandingMount> {
    const pending = this.standing.get(preset.id)
    if (pending !== undefined) {
      const mounted = await pending
      // Files are the only composition editor (authoring is copy/delete), so
      // the stamp is what notices an edit: a changed file starts the next
      // generation here, for this and later sessions. An unreadable stamp
      // serves the current generation — a mount must survive its file
      // disappearing, and failing the session over a stat would not.
      const current = await compositionStamp(preset.path)
      if (current === undefined || sameStamp(mounted.stamp, current)) return mounted
      // TODO: reclaim the superseded generation once the last agent joined to
      // it is gone. The subtree is not inert — `dsh-skill-filesystem` watches its
      // roots — and the settings-page authoring flow turns "a composition
      // changed" into a per-save event. This needs a joined-agent count on
      // StandingMount, incremented in `mount`/`composeFrom`/`recompose` and
      // decremented when the agent's scope key dies.
      // Guarded delete: a caller that raced this one may have already started
      // the next generation, and dropping THAT pointer would fork a third.
      if (this.standing.get(preset.id) === pending) this.standing.delete(preset.id)
      return this.ensureStanding(preset)
    }
    const created = (async (): Promise<StandingMount> => {
      const key: ScopeKey = { agentPreset: preset.id }
      const scope = createScope(this.selfCtx, key)
      try {
        // Stamped before the file is read: an edit racing the mount makes the
        // stamp stale rather than silently current, so the next session
        // refreshes instead of trusting a composition older than its stamp.
        const stamp = await compositionStamp(preset.path)
        if (stamp === undefined) {
          throw new PresetMountError(preset.id, `composition file is unreadable: ${preset.path}`)
        }
        await mountPreset(scope.ctx, preset)
        return { key, scope, stamp }
      } catch (error) {
        await scope.dispose()
        throw error
      }
    })()
    this.standing.set(preset.id, created)
    void created.catch(() => {
      // A refresh may have removed this pending generation and let a newer
      // call install its own pointer while this one was still settling.
      if (this.standing.get(preset.id) === created) this.standing.delete(preset.id)
    })
    return created
  }
}

/** The composition file identity one standing generation was mounted from. */
interface CompositionStamp {
  /** Modification time in milliseconds, as `stat` reports it. */
  readonly mtimeMs: number
  /** File size in bytes, the tiebreak for edits within one mtime tick. */
  readonly size: number
}

/** Read one composition file's stamp, or undefined when it cannot be statted. */
async function compositionStamp(path: string): Promise<CompositionStamp | undefined> {
  try {
    const { mtimeMs, size } = await stat(path)
    return { mtimeMs, size }
  } catch {
    // Deleted, replaced by an unreadable entry, or otherwise unstattable all
    // mean the same to the caller: the file offers no identity to compare.
    return undefined
  }
}

/** Whether two stamps name the same file state. */
function sameStamp(a: CompositionStamp, b: CompositionStamp): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size
}

/** One preset's standing composition. */
interface StandingMount {
  /** Scope key agents are parented to; also the mount's registration scope. */
  readonly key: ScopeKey
  /** Disposal boundary; held for whole-tree teardown, never per-session. */
  readonly scope: Scope
  /** Stamp of the composition file this generation was mounted from. */
  readonly stamp: CompositionStamp
}

export default AgentPresets
