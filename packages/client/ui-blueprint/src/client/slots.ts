/** Composed props shared by the Interactive Blueprint slot entries. */
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { BlueprintChangeSet } from '@deepseek-ai/dsh-api-remotes/client'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { ConversationDefaultDetailsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SidebarNavigationSectionProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { BlueprintModal, BlueprintUiState } from './controller.ts'

/** Registrant-private Blueprint state and mutation face. */
export interface BlueprintInjected {
  hooks: { blueprintUi: SnapshotStore<BlueprintUiState> }
  load: () => Promise<void>
  selectPreset: (presetId: string) => Promise<void>
  selectNode: (nodeId: string) => void
  selectCapability: (capabilityId: string, label: string, nodeId: string) => void
  clearSelection: () => void
  updateText: (nodeId: string, value: string, expectedValue: string) => Promise<void>
  setCapability: (nodeId: string, enabled: boolean) => Promise<void>
  addCapability: (nodeId: string) => Promise<void>
  beginCapabilityHandoff: (request: string) => Promise<void>
  clearCapabilityHandoff: () => void
  openModal: (modal: Exclude<BlueprintModal, null>) => void
  closeModal: () => void
  startTrial: () => Promise<void>
  cancelProposal: (changeSet: BlueprintChangeSet) => Promise<void>
  applyChangeSet: (changeSet: BlueprintChangeSet) => Promise<void>
  cancelChangeSet: (changeSet: BlueprintChangeSet) => Promise<void>
  /** Demo-only deterministic capability authoring entry. */
  startDemoCapability?: (kind: 'skill' | 'subagent') => Promise<void>
  /** Demo-only reset to the initial Creator page. */
  resetDemo?: () => void
}

type Face = InjectFace<BlueprintInjected>

/** Props for the Sidebar Agent roster. */
export type BlueprintAgentRosterProps = SidebarNavigationSectionProps & Face
/** Props for the default right-column Blueprint panel. */
export type BlueprintPanelProps = ConversationDefaultDetailsProps & Face
/** Props for the selected-context conversation dock entry. */
export type BlueprintSelectedContextProps = PropsRuntime<'conversation.input.dock'> & Face
/** Props for the frame-wide Builder modal entry. */
export type BlueprintOverlayProps = PropsRuntime<'shell.overlay'> & Face
/** Props for the proposal Tool's conversation card. */
export type BlueprintProposalRowProps = ToolCallViewProps & Face
/** Props for the user-facing Blueprint routing Tool row. */
export type BlueprintRouteRowProps = ToolCallViewProps
