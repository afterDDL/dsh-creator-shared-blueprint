/** Browser-only assembly for the validated Shared Blueprint scripted Demo. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { createRoot } from 'react-dom/client'
import commandsRemote from '@deepseek-ai/dsh-commands/remote'
import * as ApiGateway from '../../../packages/api/gateway/src/client/index.ts'
import * as SharedBlueprint from '../../../packages/bundle/shared-blueprint/src/client/index.ts'
import * as Connection from '../../../packages/client/connection/src/client/index.ts'
import * as Locale from '../../../packages/client/locale/src/client/index.ts'
import * as ModulesClient from '../../../packages/client/modules/src/client/index.ts'
import { ClientModuleSystem } from '../../../packages/client/modules/src/client/system.ts'
import * as Runtime from '../../../packages/client/runtime/src/client/index.ts'
import * as UiAgentPreset from '../../../packages/client/ui-agent-preset/src/client/index.ts'
import * as UiConversation from '../../../packages/client/ui-conversation/src/client/index.ts'
import * as UiCommands from '../../../packages/client/ui-commands/src/client/index.ts'
import * as UiDeliverables from '../../../packages/client/ui-deliverables/src/client/index.ts'
import * as UiInputTrigger from '../../../packages/client/ui-input-trigger/src/client/index.ts'
import * as UiJobs from '../../../packages/client/ui-jobs/src/client/index.ts'
import * as UiLayout from '../../../packages/client/ui-layout/src/client/index.ts'
import * as UiModelSelection from '../../../packages/client/ui-model-selection/src/client/index.ts'
import * as UiPermissionPresets from '../../../packages/client/ui-permission-presets/src/client/index.ts'
import * as UiPlan from '../../../packages/client/ui-plan/src/client/index.ts'
import * as UiSettings from '../../../packages/client/ui-settings/src/client/index.ts'
import * as UiSettingsGeneral from '../../../packages/client/ui-settings-general/src/client/index.ts'
import * as UiSettingsModels from '../../../packages/client/ui-settings-models/src/client/index.ts'
import * as UiSidebar from '../../../packages/client/ui-sidebar/src/client/index.ts'
import * as UiTheme from '../../../packages/client/ui-theme/src/client/index.ts'
import * as UiTool from '../../../packages/client/ui-tool/src/client/index.ts'
import * as UiTrajectory from '../../../packages/client/ui-trajectory/src/client/index.ts'
import * as UiUserQuestions from '../../../packages/client/ui-user-questions/src/client/index.ts'
import * as UiWorkspace from '../../../packages/client/ui-workspace/src/client/index.ts'
import * as TypertRegistry from '../../../packages/typert/registry/src/client/index.ts'
import * as AppShell from '../../../packages/client/web/src/app-shell.ts'
import { getStaticModules } from '../../../packages/client/web/src/seed.ts'
import '../../../packages/client/web/src/base.css'

type DemoWindow = typeof globalThis & {
  __DSH_BLUEPRINT_DEMO__?: unknown
  __DSH_MODULES__?: ClientModuleSystem
}

const demoUrl = new URL(window.location.href)
demoUrl.searchParams.set('fixture', '')
demoUrl.searchParams.set('blueprintDemo', '')
window.history.replaceState(null, '', demoUrl)

const demoWindow = globalThis as DemoWindow
demoWindow.__DSH_BLUEPRINT_DEMO__ = __DSH_BLUEPRINT_DEMO_SEED__
demoWindow.__DSH_MODULES__ = new ClientModuleSystem({ modules: [], staticModules: getStaticModules() })

const ctx = new Context()
let mountIndex = 0

async function mount(plugin: unknown): Promise<void> {
  mountIndex += 1
  try {
    await ctx.plugin(plugin as never)
  } catch (error) {
    throw new Error(`blueprint static demo: client plugin ${String(mountIndex)} failed`, { cause: error })
  }
}

async function boot(): Promise<void> {
  await mount(Loader)
  ctx.loader.internal = demoWindow.__DSH_MODULES__ as never
  await mount(ModulesClient)
  await mount(TypertRegistry)
  await mount(Connection)
  await mount(ApiGateway)
  await ctx.remote.$mount(commandsRemote)
  await mount(Runtime)
  await mount(UiSettings)
  await mount(Locale)
  await mount(UiTheme)
  await mount(UiLayout)
  await mount(UiInputTrigger)
  await mount(UiSidebar)
  await mount(UiSettingsGeneral)
  await mount(UiSettingsModels)
  await mount(UiConversation)
  await mount(UiTool)
  await mount(UiDeliverables)
  await mount(UiWorkspace)
  await mount(UiCommands)
  await mount(UiJobs)
  await mount(UiModelSelection)
  await mount(UiPermissionPresets)
  await mount(UiAgentPreset)
  await mount(UiPlan)
  await mount(UiUserQuestions)
  await mount(UiTrajectory)
  SharedBlueprint.mountBlueprintDemoUi(ctx, __DSH_BLUEPRINT_DEMO_SEED__ as never)
  await mount(AppShell)

  const el = document.getElementById('root')
  if (el === null) throw new Error('blueprint static demo: missing #root')
  const shell = ctx.get('appShell')
  if (shell === undefined) throw new Error('blueprint static demo: app shell failed to mount')
  createRoot(el).render(shell.renderApp())
}

void boot().catch((error: unknown) => {
  console.error(error)
  const el = document.getElementById('root')
  if (el !== null) el.textContent = error instanceof Error ? error.message : String(error)
})
