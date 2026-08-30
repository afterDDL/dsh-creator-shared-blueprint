/** Figma-derived Agent Builder presentation over real Blueprint state. */
import { useEffect, useState, type ReactNode } from 'react'
import type { Blueprint, BlueprintChangeProposal, BlueprintChangeSet, BlueprintNode } from '@deepseek-ai/dsh-api-remotes/client'
import { blueprintProposalStatus } from './proposal-status.ts'
import type { BlueprintCreatorDraft, BlueprintUiState } from './controller.ts'
import { deriveSemanticCapabilities, semanticCapabilityForNode } from './semantic-capabilities.ts'
import type { SemanticCapability } from './semantic-capabilities.ts'
import type {
  BlueprintAgentRosterProps, BlueprintOverlayProps, BlueprintPanelProps,
  BlueprintProposalRowProps, BlueprintSelectedContextProps,
} from './slots.ts'
import css from './BlueprintUi.module.css'

const NODE_LABELS: Record<string, string> = {
  'capability:web-search': '网页搜索',
  'capability:web-fetch': '网页读取',
  'capability:file-read': '文件读取',
}

type BlueprintUiLabelLocale = 'zh' | 'en'

function resolveBlueprintUiLabelLocale(blueprint: Blueprint): BlueprintUiLabelLocale {
  const sourceLanguage = blueprint.sourceLanguage?.toLocaleLowerCase()
  return sourceLanguage === 'zh' || sourceLanguage?.startsWith('zh-') === true ? 'zh' : 'en'
}

function nodeLabel(node: BlueprintNode, labelLocale: BlueprintUiLabelLocale = 'zh'): string {
  if (node.type === 'identity') return labelLocale === 'zh' ? '角色' : 'Role'
  if (node.type === 'purpose') return labelLocale === 'zh' ? '做什么' : 'Purpose'
  if (node.type === 'behavior') return typeof node.value === 'string' ? node.value : labelLocale === 'zh' ? '规则' : 'Rules'
  if (node.type === 'output') return labelLocale === 'zh' ? '输出' : 'Output'
  return labelLocale === 'zh'
    ? NODE_LABELS[node.id] ?? (node.type === 'capability' ? '能力' : '配置')
    : node.type === 'capability' ? 'Capability' : 'Configuration'
}

function compactText(value: string, limit: number): string {
  const text = value.replace(/\s+/gu, ' ').trim()
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(1, limit - 1)).trimEnd()}…`
}

function behaviorSummary(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  if (/官网/u.test(normalized) && /官方文档/u.test(normalized) && /公司公告|新闻稿/u.test(normalized)) {
    return '优先使用官网、官方文档和公司公告'
  }
  const heading = normalized.match(/^([^：:]{2,18})[：:]/u)?.[1]
  if (heading !== undefined) return heading
  return compactText(normalized.split(/(?<=[。！？；])/u, 1)[0] ?? normalized, 34)
}

function nodeText(node: BlueprintNode): string {
  return typeof node.value === 'string' ? node.value : JSON.stringify(node.value)
}

function outputDescription(nodes: readonly BlueprintNode[]): string {
  const text = nodes.map(node => typeof node.value === 'string' ? node.value : '').join(' ')
  const parts = [
    ['摘要', /摘要/u],
    ['对比表', /对比表|比较表/u],
    ['结论', /结论/u],
    ['来源', /来源|出处|链接/u],
  ] as const
  const present = parts.filter(([, pattern]) => pattern.test(text)).map(([label]) => label)
  return present.length > 0 ? present.join('、') : compactText(text, 34)
}

function outputTitle(presetName: string): string {
  const subject = presetName.replace(/\s*Agent$/iu, '').trim()
  return `${subject || 'Agent'}报告`
}

function creatorStatusLabel(creator: BlueprintCreatorDraft, projected: boolean): string {
  if (creator.status === 'creating') return projected ? '正在调整' : '正在搭建'
  if (creator.status === 'waiting' && creator.waitingFor === 'approval') return '等待你授权'
  if (creator.status === 'waiting') return '等待你补充信息'
  if (creator.status === 'paused') return '创建已暂停，可以继续'
  if (creator.status === 'ambiguity') return '发现多个候选 Agent，暂未自动绑定'
  return '可试用'
}

function demoStatusLabel(state: BlueprintUiState, fallback: string): string {
  const demo = state.demo
  if (demo === undefined || demo.phase === 'initial') return fallback
  if (demo.phase === 'creating') return '正在搭建'
  if (demo.phase === 'editing') return '正在应用修改…'
  if (demo.phase === 'authoring-skill') return '正在创建 CSV Skill…'
  if (demo.phase === 'authoring-subagent') return '正在添加协作 Agent…'
  if (demo.phase === 'testing') return '正在试用 Agent…'
  if (demo.phase === 'complete') return '试用完成'
  if (!demo.hasModifiedPurpose) return '可试用 · 下一步：调整「做什么」'
  if (!demo.hasCsvSkill) return '可试用 · 下一步：添加 CSV Skill'
  if (!demo.hasIndustrySubagent) return '可试用 · 下一步：添加协作 Agent'
  return '可试用 · 下一步：试用 Agent'
}

/** Sidebar preset roster, projected as the Builder's Agent list. */
export function BlueprintAgentRoster({ wide, useBlueprintUi, load, selectPreset }: BlueprintAgentRosterProps) {
  const state = useBlueprintUi(value => value)
  const creatorLocked = state.creator !== null && state.creator.status !== 'ready'
  useEffect(() => { void load() }, [load])
  if (!wide) return null
  return (
    <section className={css.roster} aria-label="我的 Agents">
      <div className={css.rosterLabel}>我的 Agents</div>
      <div className={css.rosterList}>
        {state.agents.map(agent => (
          <button
            type="button"
            key={agent.id}
            className={css.agentRow}
            data-active={agent.id === state.presetId || undefined}
            disabled={agent.broken !== undefined || state.busy || creatorLocked}
            onClick={() => { void selectPreset(agent.id) }}
          >
            <span className={css.agentName}>{agent.label}</span>
            <span className={css.agentMeta}>{agent.id === 'standard' ? '基础预设' : agent.trust === 'user' ? '可编辑' : '只读'}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

interface EditableRowProps {
  node: BlueprintNode
  selected: boolean
  busy: boolean
  directlyWritable: boolean
  onSelect: () => void
  onAdjust: () => void
  onSave: (value: string, expectedValue: string) => Promise<void>
  displayValue?: string
  summaryTitle?: string
  summaryDescription?: string
  submitLabel?: string
  applying?: boolean | undefined
  labelLocale?: BlueprintUiLabelLocale
}

type EditableRowOverrides = Partial<Pick<
  EditableRowProps,
  'displayValue' | 'summaryTitle' | 'summaryDescription' | 'submitLabel'
>>

function EditableRow({
  node, selected, busy, directlyWritable, onSelect, onAdjust, onSave,
  displayValue, summaryTitle, summaryDescription, submitLabel, applying = false, labelLocale = 'zh',
}: EditableRowProps) {
  const value = typeof node.value === 'string' ? node.value : ''
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [expectedValue, setExpectedValue] = useState(value)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  useEffect(() => {
    if (directlyWritable) return
    setDraft(value)
    setExpectedValue(value)
    setEditing(false)
    setSaveError(null)
  }, [directlyWritable, value])
  if (editing) {
    return (
      <div className={css.editor}>
        <textarea aria-label={`${labelLocale === 'zh' ? '编辑' : 'Edit '}${nodeLabel(node, labelLocale)}`} value={draft} onChange={(event) => { setDraft(event.target.value) }} />
        {saveError !== null && <div className={css.inlineError} role="alert">{saveError}</div>}
        <div className={css.editorActions}>
          <button type="button" disabled={saving} onClick={() => {
            setDraft(value)
            setExpectedValue(value)
            setSaveError(null)
            setEditing(false)
          }}>{labelLocale === 'zh' ? '取消' : 'Cancel'}</button>
          <button type="button" disabled={busy || saving || draft.trim() === ''} onClick={() => {
            setSaving(true)
            setSaveError(null)
            void onSave(draft, expectedValue).then(() => {
              setEditing(false)
            }).catch((error: unknown) => {
              setSaveError(error instanceof Error ? error.message : labelLocale === 'zh' ? '保存失败，请重试。' : 'Save failed. Please retry.')
            }).finally(() => { setSaving(false) })
          }}>{saving ? labelLocale === 'zh' ? '正在保存…' : 'Saving…' : submitLabel ?? (labelLocale === 'zh' ? '保存' : 'Save')}</button>
        </div>
      </div>
    )
  }
  return (
    <div
      className={css.textRow}
      data-selected={selected || undefined}
      data-applying={applying || undefined}
      role="button"
      tabIndex={0}
      aria-label={`${labelLocale === 'zh' ? '选择' : 'Select '}${nodeLabel(node, labelLocale)}`}
      onClick={onSelect}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onSelect() }}
    >
      <div className={css.rowText}>
        {summaryTitle === undefined
          ? displayValue ?? value
          : (
            <>
              <div className={css.summaryTitle}>{summaryTitle}</div>
              {summaryDescription !== undefined && <div className={css.caption}>{summaryDescription}</div>}
            </>
          )}
      </div>
      {(node.editable || node.type === 'identity') && (
        <button type="button" className={css.textAction} disabled={busy} onClick={(event) => {
          event.stopPropagation()
          if (node.editable && directlyWritable) {
            setDraft(value)
            setExpectedValue(value)
            setSaveError(null)
            setEditing(true)
          } else {
            onAdjust()
          }
        }}>{node.editable && directlyWritable
            ? labelLocale === 'zh' ? '编辑' : 'Edit'
            : labelLocale === 'zh' ? '调整' : 'Adjust'}</button>
      )}
    </div>
  )
}

function capabilityExecutorActive(handoff: BlueprintUiState['capabilityHandoff']): boolean {
  return handoff?.status === 'configuring' || handoff?.status === 'authoring'
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key]
  return typeof candidate === 'string' && candidate.trim() !== '' ? candidate : undefined
}

function capabilityPresentation(value: Record<string, unknown>, labelLocale: BlueprintUiLabelLocale): {
  title: string
  description: string
  details: readonly { label: string; value: string }[]
} {
  const kind = value['kind']
  const zh = labelLocale === 'zh'
  if (kind === 'skill') {
    const name = stringField(value, 'name') ?? (zh ? '未命名 Skill' : 'Unnamed Skill')
    const description = stringField(value, 'description') ?? (zh ? '该 Skill 没有提供说明。' : 'No description is available for this Skill.')
    const available = value['callable'] === true
    return {
      title: name,
      description,
      details: [
        { label: zh ? '类型' : 'Type', value: 'Skill' },
        { label: zh ? '标识' : 'Name', value: name },
        ...(stringField(value, 'scope') === undefined ? [] : [{ label: zh ? '范围' : 'Scope', value: stringField(value, 'scope') as string }]),
        { label: zh ? '状态' : 'Status', value: available ? zh ? '可调用' : 'Callable' : zh ? '不可调用' : 'Unavailable' },
      ],
    }
  }
  const name = stringField(value, 'displayLabel') ?? stringField(value, 'name') ?? (zh ? '未命名协作 Agent' : 'Unnamed collaborating Agent')
  const description = stringField(value, 'responsibility') ?? (zh ? '该协作 Agent 没有提供职责说明。' : 'No responsibility is available for this collaborating Agent.')
  const available = value['enabled'] === true && value['providerAvailable'] === true
  return {
    title: name,
    description,
    details: [
      { label: zh ? '类型' : 'Type', value: zh ? '协作 Agent' : 'Delegated Agent' },
      ...(stringField(value, 'tool') === undefined ? [] : [{ label: zh ? '工具' : 'Tool', value: stringField(value, 'tool') as string }]),
      ...(stringField(value, 'provider') === undefined ? [] : [{ label: 'Provider', value: stringField(value, 'provider') as string }]),
      ...(stringField(value, 'mode') === undefined ? [] : [{ label: zh ? '模式' : 'Mode', value: stringField(value, 'mode') as string }]),
      { label: zh ? '状态' : 'Status', value: available ? zh ? '可用' : 'Available' : zh ? '不可用' : 'Unavailable' },
    ],
  }
}

interface SemanticCapabilityRowProps {
  capability: SemanticCapability
  selected: boolean
  onSelect: () => void
}

function SemanticCapabilityRow({ capability, selected, onSelect }: SemanticCapabilityRowProps) {
  return (
    <button type="button" className={css.semanticCapabilityRow} data-selected={selected || undefined} onClick={onSelect} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); onSelect() } }}>
      <span className={css.semanticCapabilityMark} aria-hidden="true" />
      <span>{capability.label}</span>
    </button>
  )
}

interface CapabilityRequestFormProps {
  busy: boolean
  onCancel: () => void
  onSubmit: (request: string) => Promise<void>
}

function CapabilityRequestForm({ busy, onCancel, onSubmit }: CapabilityRequestFormProps) {
  const [request, setRequest] = useState('')
  const ready = request.trim().length > 0
  return (
    <form className={css.capabilityRequest} onSubmit={(event) => {
      event.preventDefault()
      if (!ready || busy) return
      void onSubmit(request.trim())
    }}>
      <label htmlFor="blueprint-capability-request">你希望这个 Agent 还能做什么？</label>
      <textarea
        id="blueprint-capability-request"
        autoFocus
        maxLength={500}
        placeholder="例如：帮我分析上市公司财报"
        value={request}
        onChange={(event) => { setRequest(event.target.value) }}
      />
      <div className={css.capabilityRequestActions}>
        <button type="button" onClick={onCancel}>取消</button>
        <button type="submit" disabled={!ready || busy}>交给 AI</button>
      </div>
    </form>
  )
}

function capabilityHandoffStatus(handoff: import('./controller.ts').BlueprintCapabilityHandoff): string {
  if (handoff.status === 'completed') return `✓ ${handoff.label}已加入`
  if (handoff.status === 'failed') return `${handoff.label} · 这项能力暂时没配置好`
  if (handoff.status === 'cancelled') return `${handoff.label} · 配置已取消`
  if (handoff.status === 'proposal') return `${handoff.label} · 等待你确认`
  if (handoff.waitingFor === 'approval') return `${handoff.label} · 等待你授权`
  if (handoff.waitingFor === 'input') return `${handoff.label} · 等待你补充信息`
  if (handoff.status === 'authoring') return `${handoff.label} · 正在配置…`
  return `${handoff.label} · 正在判断…`
}

function semanticCapabilitySelected(capability: SemanticCapability, selectedNodeId: string | null): boolean {
  return selectedNodeId !== null && capability.supportingNodeIds.includes(selectedNodeId)
}

function selectSemanticCapability(capability: SemanticCapability, selectNode: (nodeId: string) => void): void {
  selectNode(capability.primaryNodeId)
}

function focusConversationComposer(): void {
  document.querySelector<HTMLTextAreaElement>('[data-composer-card] textarea:not(:disabled)')?.focus()
}

/** Right-column Blueprint with node-governed editing affordances. */
export function BlueprintPanel({
  useBlueprintUi, load, selectNode, updateText, beginCapabilityHandoff, openModal,
  startDemoCapability, resetDemo,
}: BlueprintPanelProps) {
  const state = useBlueprintUi(value => value)
  const [expanded, setExpanded] = useState({ behaviors: false, outputs: false })
  const [capabilityRequestOpen, setCapabilityRequestOpen] = useState(false)
  const [demoCapabilityMenu, setDemoCapabilityMenu] = useState<'root' | 'existing' | null>(null)
  const [technicalDetailsNodeId, setTechnicalDetailsNodeId] = useState<string | null>(null)
  useEffect(() => { void load() }, [load])
  const blueprint = state.blueprint
  useEffect(() => {
    setExpanded({ behaviors: false, outputs: false })
    setCapabilityRequestOpen(false)
    setDemoCapabilityMenu(null)
    setTechnicalDetailsNodeId(null)
  }, [blueprint?.preset.id])
  const creator = state.creator
  const demoMode = startDemoCapability !== undefined
  const creatorLocked = creator !== null && creator.status !== 'ready'
  const executorLocked = capabilityExecutorActive(state.capabilityHandoff)
  const interactionLocked = creatorLocked || executorLocked
  const adjustNode = (nodeId: string): void => {
    if (state.selectedNodeId !== nodeId) selectNode(nodeId)
    focusConversationComposer()
  }
  const handoffCapability = async (request: string): Promise<void> => {
    await beginCapabilityHandoff(request)
    setCapabilityRequestOpen(false)
    focusConversationComposer()
  }
  if (creator !== null && creator.status !== 'ready' && blueprint === null) {
    const status = creatorStatusLabel(creator, false)
    return (
      <div className={css.panel}>
        <header className={css.panelHeader}>
          <div className={css.panelTitle}>
            <h2>{creator.name}</h2>
            <div className={css.panelSummary}>{status}</div>
          </div>
        </header>
        <div className={css.creatorDraft} data-status={creator.status}>
          <div className={css.creatorDraftMark} aria-hidden="true" />
          {creator.status !== 'ambiguity' && (
            <div className={css.creatorDraftCopy}>正在根据你的需求生成 Agent 结构…</div>
          )}
          {creator.status === 'ambiguity' && creator.candidateIds.length > 0 && (
            <div className={css.creatorDraftCandidates}>{creator.candidateIds.join('、')}</div>
          )}
        </div>
      </div>
    )
  }
  if (state.demo?.phase === 'initial' && blueprint === null) {
    return (
      <div className={css.panel}>
        <header className={css.panelHeader}>
          <div className={css.panelTitle}>
            <h2>新 Agent</h2>
            <div className={css.panelSummary}>Blueprint 会随着 Creator 的配置过程逐步生成</div>
          </div>
        </header>
        <div className={css.creatorDraft}>
          <div className={css.creatorDraftMark} aria-hidden="true" />
          <div className={css.creatorDraftCopy}>发送左侧需求后，这里会显示角色、目标、能力、规则和输出。</div>
        </div>
      </div>
    )
  }
  if (state.phase === 'loading' && blueprint === null) return <div className={css.panelState}>正在读取 Agent…</div>
  if (state.error !== null && blueprint === null) return <div className={css.panelState} data-error>{state.error}</div>
  if (blueprint === null) return <div className={css.panelState}>没有可投影的 Agent。</div>
  const purpose = blueprint.nodes.find(node => node.type === 'purpose')
  const identity = blueprint.nodes.find(node => node.type === 'identity')
  const semanticCapabilities = deriveSemanticCapabilities(blueprint)
  const behaviors = blueprint.nodes.filter(node => node.type === 'behavior')
  const outputs = blueprint.nodes.filter(node => node.type === 'output')
  const labelLocale = resolveBlueprintUiLabelLocale(blueprint)
  const presetName = blueprint.preset.name ?? blueprint.preset.id
  const visibleBehaviors = expanded.behaviors ? behaviors : behaviors.slice(0, 2)
  const primaryOutput = outputs.find(node => node.editable) ?? outputs[0]
  const selectedCapability = blueprint.nodes.find(node => node.id === state.selectedNodeId && node.type === 'capability')
  const selectedCapabilityValue = selectedCapability !== undefined && typeof selectedCapability.value === 'object'
    && selectedCapability.value !== null && !Array.isArray(selectedCapability.value)
    ? selectedCapability.value as Record<string, unknown>
    : null
  const status = demoStatusLabel(
    state,
    state.creator === null ? '当前 Agent 的结构摘要' : creatorStatusLabel(state.creator, true),
  )
  const directlyWritable = !interactionLocked && !demoMode
  const selectedCapabilityPresentation = selectedCapabilityValue === null
    || (selectedCapabilityValue['kind'] !== 'skill' && selectedCapabilityValue['kind'] !== 'delegation')
    ? null
    : capabilityPresentation(selectedCapabilityValue, labelLocale)
  const renderEditableRow = (node: BlueprintNode, overrides: EditableRowOverrides = {}): ReactNode => (
    <EditableRow
      key={node.id}
      node={node}
      labelLocale={labelLocale}
      selected={state.selectedNodeId === node.id}
      busy={state.busy}
      directlyWritable={directlyWritable}
      onSelect={() => { selectNode(node.id) }}
      onAdjust={() => { adjustNode(node.id) }}
      onSave={(value, expected) => updateText(node.id, value, expected)}
      applying={state.demo?.applyingNodeIds.includes(node.id)}
      {...overrides}
    />
  )
  return (
    <div className={css.panel}>
      <header className={css.panelHeader}>
        <div className={css.panelTitle}>
          <h2>{presetName}</h2>
          <div className={css.panelSummary} aria-live="polite">{status}</div>
        </div>
        <div className={css.headerActions}>
          {resetDemo !== undefined && <button type="button" className={css.quietButton} onClick={resetDemo} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); resetDemo() } }}>重置 Demo</button>}
          <button type="button" className={css.primaryButton} disabled={state.busy || state.applyReceiptsLoading === true || interactionLocked} onClick={() => { openModal('try') }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); openModal('try') } }}>{labelLocale === 'zh' ? '试用 Agent' : 'Try Agent'}</button>
        </div>
      </header>
      <div className={css.panelBody}>
        {identity !== undefined && (
          <section className={css.section}>
            <div className={css.sectionHeader}><span>{labelLocale === 'zh' ? '角色' : 'Role'}</span></div>
            <EditableRow
              node={identity}
              selected={state.selectedNodeId === identity.id}
              busy={state.busy}
              directlyWritable={directlyWritable}
              onSelect={() => { selectNode(identity.id) }}
              onAdjust={() => { adjustNode(identity.id) }}
              onSave={(value, expected) => updateText(identity.id, value, expected)}
              applying={state.demo?.applyingNodeIds.includes(identity.id)}
              labelLocale={labelLocale}
            />
            {!identity.editable && (
              <div className={css.caption}>{labelLocale === 'zh'
                ? '这个角色目前只能查看，你仍然可以选中它继续和我讨论。'
                : 'This role is currently read-only. You can still select it and continue discussing it with me.'}</div>
            )}
          </section>
        )}
        {purpose !== undefined && (
          <section className={css.section}>
            <div className={css.sectionHeader}><span>{labelLocale === 'zh' ? '做什么' : 'Purpose'}</span></div>
            <EditableRow
              node={purpose}
              labelLocale={labelLocale}
              selected={state.selectedNodeId === purpose.id}
              busy={state.busy}
              directlyWritable={directlyWritable}
              onSelect={() => { selectNode(purpose.id) }}
              onAdjust={() => { adjustNode(purpose.id) }}
              onSave={(value, expected) => updateText(purpose.id, value, expected)}
              submitLabel={labelLocale === 'zh' ? '提交修改' : 'Submit change'}
              applying={state.demo?.applyingNodeIds.includes(purpose.id)}
            />
            {demoMode && state.demo?.phase === 'ready' && !state.demo.hasModifiedPurpose && (
              <div className={css.caption}>点击「调整」，左侧会预填修改要求；发送后再应用提案。</div>
            )}
          </section>
        )}
        <section className={`${css.section} ${css.capabilitySection}`}>
          <div className={css.sectionHeader}>
            <span>{labelLocale === 'zh' ? '能力' : 'Capabilities'}</span>
            <button
              type="button"
              className={css.addCapabilityButton}
              aria-expanded={demoMode ? demoCapabilityMenu !== null : capabilityRequestOpen}
              disabled={state.busy || interactionLocked}
              onClick={() => {
                if (demoMode) setDemoCapabilityMenu(value => value === null ? 'root' : null)
                else setCapabilityRequestOpen(value => !value)
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                if (demoMode) setDemoCapabilityMenu(value => value === null ? 'root' : null)
              }}
            >{labelLocale === 'zh' ? '＋ 添加能力' : '+ Add capability'}</button>
          </div>
          {demoMode && demoCapabilityMenu !== null && (
            <div className={css.capabilityMenu} role="menu" aria-label="添加能力">
              {demoCapabilityMenu === 'root' ? (
                <>
                  <button type="button" role="menuitem" onClick={() => { setDemoCapabilityMenu('existing') }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); setDemoCapabilityMenu('existing') } }}><span>从现有能力中添加</span><span>›</span></button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setDemoCapabilityMenu(null)
                      void startDemoCapability('skill')
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return
                      event.preventDefault()
                      setDemoCapabilityMenu(null)
                      void startDemoCapability('skill')
                    }}
                  ><span>创建 Skill</span><small>沉淀可复用工作流</small></button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setDemoCapabilityMenu(null)
                      void startDemoCapability('subagent')
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return
                      event.preventDefault()
                      setDemoCapabilityMenu(null)
                      void startDemoCapability('subagent')
                    }}
                  ><span>添加协作 Agent</span><small>委派独立研究任务</small></button>
                </>
              ) : (
                <>
                  <button type="button" role="menuitem" onClick={() => { setDemoCapabilityMenu('root') }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); setDemoCapabilityMenu('root') } }}><span>‹ 返回</span></button>
                  <button type="button" role="menuitem" disabled><span>网页搜索</span><small>已启用</small></button>
                  <button type="button" role="menuitem" disabled><span>文件读取</span><small>已启用</small></button>
                </>
              )}
            </div>
          )}
          {!demoMode && capabilityRequestOpen && (
            <CapabilityRequestForm
              busy={state.busy}
              onCancel={() => { setCapabilityRequestOpen(false) }}
              onSubmit={handoffCapability}
            />
          )}
          {state.capabilityHandoff !== null && (
            <div
              className={css.capabilityHandoffStatus}
              data-retry={state.capabilityHandoff.status === 'failed' || undefined}
            >
              <span>
                {capabilityHandoffStatus(state.capabilityHandoff)}
                {state.capabilityHandoff.status === 'failed' && (
                  <small>原有 Agent 设置没有受到影响，可以重新尝试。</small>
                )}
              </span>
              {state.capabilityHandoff.status === 'failed' && (
                <button
                  type="button"
                  disabled={state.busy}
                  onClick={() => { void beginCapabilityHandoff(state.capabilityHandoff?.request ?? '') }}
                >重新尝试</button>
              )}
            </div>
          )}
          {state.demo?.pendingCapability !== null && state.demo?.pendingCapability !== undefined && (
            <div className={css.capabilityHandoffStatus}>
              {state.demo.pendingCapability === 'skill' ? 'CSV 财务指标提取 · 正在配置…' : '行业研究协作 Agent · 正在配置…'}
            </div>
          )}
          <div className={css.semanticCapabilityList}>
            {semanticCapabilities.map(capability => (
              <SemanticCapabilityRow
                key={capability.id}
                capability={capability}
                selected={semanticCapabilitySelected(capability, state.selectedNodeId)}
                onSelect={() => { selectSemanticCapability(capability, selectNode) }}
              />
            ))}
            {semanticCapabilities.length === 0 && (
              <div className={css.capabilityEmpty}>{labelLocale === 'zh' ? '这个 Agent 目前没有可概括的已启用能力。' : 'This Agent has no active capabilities to summarize.'}</div>
            )}
          </div>
        </section>
        {selectedCapabilityPresentation !== null && selectedCapability !== undefined && (
          <section className={css.section}>
            <div className={css.sectionHeader}><span>{labelLocale === 'zh' ? '能力详情' : 'Capability details'}</span></div>
            <div className={css.summaryTitle}>{selectedCapabilityPresentation.title}</div>
            <div className={css.caption}>{selectedCapabilityPresentation.description}</div>
            <button
              type="button"
              aria-expanded={technicalDetailsNodeId === selectedCapability.id}
              onClick={() => {
                setTechnicalDetailsNodeId(value => value === selectedCapability.id ? null : selectedCapability.id)
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                setTechnicalDetailsNodeId(value => value === selectedCapability.id ? null : selectedCapability.id)
              }}
            >{technicalDetailsNodeId === selectedCapability.id
                ? labelLocale === 'zh' ? '收起技术详情' : 'Hide technical details'
                : labelLocale === 'zh' ? '查看技术详情' : 'View technical details'}</button>
            {technicalDetailsNodeId === selectedCapability.id && (
              <dl className={css.capabilityDetails}>
                {selectedCapabilityPresentation.details.map(detail => (
                  <div key={detail.label}><dt>{detail.label}</dt><dd>{detail.value}</dd></div>
                ))}
              </dl>
            )}
          </section>
        )}
        {behaviors.length > 0 && (
          <section className={css.section}>
            <div className={css.sectionHeader}>
              <span>{labelLocale === 'zh' ? '规则' : 'Rules'}</span>
              <button type="button" aria-expanded={expanded.behaviors} onClick={() => { setExpanded(value => ({ ...value, behaviors: !value.behaviors })) }}>
                {expanded.behaviors
                  ? labelLocale === 'zh' ? '收起' : 'Collapse'
                  : labelLocale === 'zh' ? '展开' : 'Expand'}
              </button>
            </div>
            {visibleBehaviors.map(node => renderEditableRow(
              node,
              expanded.behaviors ? {} : { displayValue: behaviorSummary(nodeText(node)) },
            ))}
            {!expanded.behaviors && behaviors.length > visibleBehaviors.length && <div className={css.moreSummary}>{labelLocale === 'zh' ? `另有 ${String(behaviors.length - visibleBehaviors.length)} 条规则` : `${String(behaviors.length - visibleBehaviors.length)} more rules`}</div>}
          </section>
        )}
        {outputs.length > 0 && (
          <section className={css.section}>
            <div className={css.sectionHeader}>
              <span>{labelLocale === 'zh' ? '输出' : 'Output'}</span>
              <button type="button" aria-expanded={expanded.outputs} onClick={() => { setExpanded(value => ({ ...value, outputs: !value.outputs })) }}>
                {expanded.outputs
                  ? labelLocale === 'zh' ? '收起' : 'Collapse'
                  : labelLocale === 'zh' ? '展开' : 'Expand'}
              </button>
            </div>
            {expanded.outputs
              ? outputs.map(node => renderEditableRow(node))
              : primaryOutput !== undefined && renderEditableRow(primaryOutput, {
                summaryTitle: outputTitle(presetName),
                summaryDescription: outputDescription(outputs),
              })}
          </section>
        )}
        {state.error !== null && <div className={css.inlineError}>{state.error}</div>}
        {state.validation !== null && (
          <div className={css.validation} data-valid={state.validation.valid || undefined}>
            {state.validation.valid
              ? labelLocale === 'zh' ? '运行配置验证通过，Blueprint 与当前 Agent 组装结果一致。' : 'Runtime validation passed: the Blueprint matches the assembled Agent.'
              : labelLocale === 'zh' ? '运行配置验证未通过，当前 Agent 尚不可安全试用。' : 'Runtime validation failed; this Agent is not ready to use safely.'}
          </div>
        )}
        {state.demo?.testStatus === 'running' && <div className={css.validation}>正在用当前 Demo 配置运行测试…</div>}
        {state.demo?.testStatus === 'verified' && (
          <div className={css.validation} data-valid>✓ Agent 结构与当前 Demo 运行配置一致</div>
        )}
      </div>
    </div>
  )
}

/** Optional conversation context chip; it does not change composer behavior. */
export function BlueprintSelectedContext({
  useBlueprintUi, clearSelection, clearCapabilityHandoff, beginCapabilityHandoff,
}: BlueprintSelectedContextProps) {
  const blueprint = useBlueprintUi(state => state.blueprint)
  const selected = useBlueprintUi(state => state.blueprint?.nodes.find(node => node.id === state.selectedNodeId))
  const handoff = useBlueprintUi(state => state.capabilityHandoff)
  if (handoff !== null) {
    const status = handoff.status === 'completed'
      ? `✓ ${handoff.label}已加入`
      : handoff.status === 'failed'
        ? `这项能力暂时没配置好 · ${handoff.label}`
        : handoff.status === 'cancelled'
          ? `配置已取消 · ${handoff.label}`
          : handoff.waitingFor === 'approval'
            ? '等待授权'
            : handoff.waitingFor === 'input'
              ? '等待补充信息'
              : handoff.status === 'proposal'
                ? '等待确认'
                : handoff.status === 'authoring' ? '正在配置能力' : '正在判断能力'
    const terminal = handoff.terminal !== undefined
    return (
      <div className={css.selectedContext}>
        <span>{terminal ? status : `${status} · ${handoff.label}`}</span>
        {handoff.status === 'failed' && (
          <button
            type="button"
            className={css.selectedContextRetry}
            aria-label={`重新尝试添加：${handoff.label}`}
            onClick={() => { void beginCapabilityHandoff(handoff.request) }}
          >重新尝试</button>
        )}
        {!terminal && <button type="button" aria-label="取消添加能力上下文" onClick={clearCapabilityHandoff}>×</button>}
      </div>
    )
  }
  if (selected === undefined) return null
  const semanticLabel = blueprint === null || selected.type !== 'capability'
    ? undefined
    : semanticCapabilityForNode(blueprint, selected.id)?.label
  const labelLocale = blueprint === null ? 'zh' : resolveBlueprintUiLabelLocale(blueprint)
  return (
    <div className={css.selectedContext}>
      <span className={css.selectedPrefix}>{labelLocale === 'zh' ? '已选：' : 'Selected: '}</span>
      <span>{semanticLabel ?? nodeLabel(selected, labelLocale)}</span>
      <button type="button" aria-label="清除已选 Blueprint 上下文" onClick={clearSelection}>×</button>
    </div>
  )
}

function proposalFromValue(candidate: unknown): BlueprintChangeProposal | null {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return null
  const value = candidate as Record<string, unknown>
  const operation = value['operation']
  const currentValue = value['currentValue']
  const proposedValue = value['proposedValue']
  if (typeof value['proposalId'] !== 'string' || value['proposalId'].trim() === ''
    || typeof value['presetId'] !== 'string' || value['presetId'].trim() === ''
    || typeof value['revision'] !== 'string' || value['revision'].trim() === ''
    || typeof value['targetNodeId'] !== 'string' || value['targetNodeId'].trim() === ''
    || (operation !== 'updateIdentity' && operation !== 'updatePurpose' && operation !== 'updateBehavior'
      && operation !== 'setCapability' && operation !== 'updateOutput')
    || (operation === 'setCapability'
      ? (value['targetNodeId'] !== 'capability:web-search' && value['targetNodeId'] !== 'capability:web-fetch')
        || typeof currentValue !== 'boolean' || typeof proposedValue !== 'boolean'
      : typeof currentValue !== 'string' || typeof proposedValue !== 'string')
    || currentValue === proposedValue
    || typeof value['impact'] !== 'string' || value['impact'].trim() === ''
    || (value['dependency'] !== undefined
      && (typeof value['dependency'] !== 'string' || value['dependency'].trim() === ''))) return null
  return {
    proposalId: value['proposalId'],
    presetId: value['presetId'],
    revision: value['revision'],
    targetNodeId: value['targetNodeId'],
    operation,
    currentValue: currentValue as BlueprintChangeProposal['currentValue'],
    proposedValue: proposedValue as BlueprintChangeProposal['proposedValue'],
    impact: value['impact'],
    ...(value['dependency'] === undefined ? {} : { dependency: value['dependency'] }),
  }
}

function structuredSourceMatches(
  sourceNodeType: Extract<BlueprintChangeSet, { kind: 'structured-edit' }>['sourceNodeType'],
  sourceNodeId: string,
  proposal: BlueprintChangeProposal,
): boolean {
  if (proposal.targetNodeId !== sourceNodeId || proposal.dependency !== undefined) return false
  switch (sourceNodeType) {
    case 'identity': return proposal.operation === 'updateIdentity'
    case 'purpose': return proposal.operation === 'updatePurpose'
    case 'behavior': return proposal.operation === 'updateBehavior'
    case 'output': return proposal.operation === 'updateOutput'
    case 'capability': return proposal.operation === 'setCapability'
  }
}

function changeSetFromMeta(meta: unknown, expectedCallId: string): BlueprintChangeSet | null {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return null
  const record = meta as Record<string, unknown>
  const candidate = record['blueprintChangeSet']
  if (typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)) {
    const value = candidate as Record<string, unknown>
    const proposals = Array.isArray(value['proposals'])
      ? value['proposals'].map(proposalFromValue)
      : []
    if (value['changeSetId'] !== expectedCallId || expectedCallId.trim() === ''
      || typeof value['presetId'] !== 'string' || value['presetId'].trim() === ''
      || typeof value['sourceSessionId'] !== 'string' || value['sourceSessionId'].trim() === ''
      || typeof value['routeId'] !== 'string' || value['routeId'].trim() === ''
      || typeof value['revision'] !== 'string' || value['revision'].trim() === '' || proposals.length === 0
      || proposals.some(proposal => proposal === null
        || proposal.presetId !== value['presetId'] || proposal.revision !== value['revision'])
      || new Set(proposals.map(proposal => proposal?.proposalId)).size !== proposals.length
      || new Set(proposals.map(proposal => proposal?.targetNodeId)).size !== proposals.length) return null
    if (value['kind'] === 'direct-request') {
      if (proposals.length !== 1) return null
      return {
        sourceSessionId: value['sourceSessionId'], routeId: value['routeId'],
        changeSetId: value['changeSetId'], kind: 'direct-request', presetId: value['presetId'],
        revision: value['revision'], proposals: proposals as BlueprintChangeProposal[],
      }
    }
    if (value['kind'] === 'structured-edit'
      && typeof value['sourceNodeId'] === 'string' && value['sourceNodeId'].trim() !== ''
      && typeof value['sourceLabel'] === 'string' && value['sourceLabel'].trim() !== ''
      && (value['sourceNodeType'] === 'purpose' || value['sourceNodeType'] === 'identity'
        || value['sourceNodeType'] === 'capability' || value['sourceNodeType'] === 'behavior'
        || value['sourceNodeType'] === 'output')
      && structuredSourceMatches(
        value['sourceNodeType'],
        value['sourceNodeId'],
        proposals[0] as BlueprintChangeProposal,
      )) {
      return {
        sourceSessionId: value['sourceSessionId'], routeId: value['routeId'],
        changeSetId: value['changeSetId'], kind: 'structured-edit',
        presetId: value['presetId'], revision: value['revision'],
        sourceNodeId: value['sourceNodeId'], sourceNodeType: value['sourceNodeType'],
        sourceLabel: value['sourceLabel'], proposals: proposals as BlueprintChangeProposal[],
      }
    }
    if (value['kind'] === 'direct-edit-reconciliation'
      && typeof value['sourceNodeId'] === 'string' && typeof value['sourceLabel'] === 'string'
      && (value['sourceNodeType'] === 'purpose' || value['sourceNodeType'] === 'identity'
        || value['sourceNodeType'] === 'capability' || value['sourceNodeType'] === 'behavior'
        || value['sourceNodeType'] === 'output' || value['sourceNodeType'] === 'access')) {
      return {
        sourceSessionId: value['sourceSessionId'], routeId: value['routeId'],
        changeSetId: value['changeSetId'], kind: 'direct-edit-reconciliation',
        presetId: value['presetId'], revision: value['revision'],
        sourceNodeId: value['sourceNodeId'], sourceNodeType: value['sourceNodeType'],
        sourceLabel: value['sourceLabel'], proposals: proposals as BlueprintChangeProposal[],
      }
    }
    return null
  }
  return null
}

function proposalTitle(proposal: BlueprintChangeProposal): string {
  if (proposal.operation === 'setCapability') {
    const name = proposal.targetNodeId === 'capability:web-search' ? '网页搜索' : '网页读取'
    return `将${proposal.proposedValue === true ? '开启' : '关闭'}${name}`
  }
  if (proposal.operation === 'updateIdentity') return '将更新角色定位'
  if (proposal.operation === 'updatePurpose') return '将更新 Agent 的目标'
  if (proposal.operation === 'updateBehavior') return '将修改一条规则'
  return '将更新输出要求'
}

function structuredEditTitle(
  changeSet: Extract<BlueprintChangeSet, { kind: 'structured-edit' }>,
  sourceProposal: BlueprintChangeProposal | undefined,
): string {
  if (changeSet.sourceNodeType === 'capability' && sourceProposal?.operation === 'setCapability') {
    return proposalTitle(sourceProposal)
  }
  const label = changeSet.sourceLabel.trim()
  if (changeSet.sourceNodeType === 'identity' && (label === '' || label === '角色')) return '将更新 Agent 的角色定位'
  if (changeSet.sourceNodeType === 'purpose' && (label === '' || label === 'Purpose')) return '将更新 Agent 的目标'
  if (changeSet.sourceNodeType === 'behavior' && (label === '' || label === 'Behavior')) return '将更新 Agent 的规则'
  if (changeSet.sourceNodeType === 'output' && (label === '' || label === 'Output')) return '将更新 Agent 的输出要求'
  return `将更新「${label || '该配置'}」`
}

function proposalStatusFooter(
  applied: boolean,
  canceled: boolean,
  locked: boolean,
  unresolved: string | null,
  messages: { stale: string; applied: string; canceled: string },
): ReactNode {
  if (applied) return <div className={css.proposalStatus}>{messages.applied}</div>
  if (canceled) return <div className={css.proposalStatus}>{messages.canceled}</div>
  if (unresolved !== null) return <div className={css.proposalStatus}>{unresolved}</div>
  if (locked) return <div className={css.proposalStatus}>Creator 正在调整 Agent，完成后才能应用。</div>
  return <div className={css.proposalStatus}>{messages.stale}</div>
}

/** Durable proposal Tool row with explicit user confirmation. */
export function BlueprintProposalRow({
  block, callId, sessionId, useBlueprintUi, cancelProposal, applyChangeSet,
}: BlueprintProposalRowProps) {
  const [expanded, setExpanded] = useState(false)
  const state = useBlueprintUi(value => value)
  if (!('kind' in block)) {
    return <div className={css.proposalCard}><div className={css.proposalTitle}>正在准备修改建议…</div></div>
  }
  const changeSet = block.isError ? null : changeSetFromMeta(block.meta, callId)
  if (changeSet === null) {
    return <div className={css.proposalCard} data-error><div className={css.proposalTitle}>未生成可应用的修改建议</div></div>
  }
  if (changeSet.sourceSessionId !== sessionId) return null
  const status = blueprintProposalStatus(changeSet, state)
  const applied = status === 'applied'
  const canceled = status === 'canceled'
  const locked = status === 'locked'
  const pending = status === 'pending'
  const unresolved = status === 'loading' ? '正在确认建议状态…'
    : status === 'rejected' ? '校验未通过，这条建议未应用。'
      : status === 'failed' ? '这条建议未能成功应用，请重新检查。' : null
  if (changeSet.kind === 'direct-edit-reconciliation' || changeSet.kind === 'structured-edit') {
    const structured = changeSet.kind === 'structured-edit'
    const dependentCount = structured ? changeSet.proposals.length - 1 : changeSet.proposals.length
    const subject = changeSet.sourceNodeType === 'purpose' ? '新目标' : '这次修改'
    const staged = structured ? changeSet.proposals[0] : undefined
    const details = structured ? changeSet.proposals.slice(1) : changeSet.proposals
    const sourceTitle = structured ? structuredEditTitle(changeSet, staged) : undefined
    let footer = proposalStatusFooter(applied, canceled, locked, unresolved, {
      stale: '建议已过期，请在对话中重新检查一致性。',
      applied: structured ? '已应用并重新读取 Blueprint' : '已全部应用',
      canceled: '已取消，未继续修改 Agent',
    })
    if (pending) {
      footer = (
        <div className={css.proposalActions}>
          {details.length > 0 && (
            <button
              type="button"
              aria-expanded={expanded}
              disabled={state.busy}
              onClick={() => { setExpanded(value => !value) }}
            >{structured ? '查看关联调整' : '查看调整'}</button>
          )}
          <button
            type="button"
            className={css.primaryButton}
            disabled={state.busy}
            onClick={() => { void applyChangeSet(changeSet) }}
          >{structured && dependentCount === 0 ? '应用' : '全部应用'}</button>
          {structured && (
            <button
              type="button"
              disabled={state.busy}
              onClick={() => { void cancelProposal(changeSet) }}
            >取消</button>
          )}
        </div>
      )
    }
    return (
      <div className={css.proposalCard} data-state={status}>
        <div className={css.proposalEyebrow}>{structured ? '修改建议' : '关联调整'}</div>
        <div className={css.proposalTitle}>{structured
          ? dependentCount > 0 ? `${sourceTitle}，并建议同步调整 ${String(dependentCount)} 项配置` : sourceTitle
          : `为了让 Agent 与${subject}保持一致，建议同步调整 ${String(dependentCount)} 项配置`}</div>
        {staged !== undefined && <div className={css.proposalImpact}>{staged.impact}</div>}
        {staged !== undefined && typeof staged.proposedValue === 'string' && (
          <div className={css.proposalPreview}>{staged.proposedValue}</div>
        )}
        {expanded && details.length > 0 && (
          <div className={css.changeSetList}>
            {details.map(proposal => (
              <div key={proposal.proposalId} className={css.changeSetItem}>
                <div className={css.changeSetItemTitle}>{proposalTitle(proposal)}</div>
                {proposal.dependency !== undefined && <div className={css.proposalImpact}>{proposal.dependency}</div>}
                <div className={css.proposalImpact}>{proposal.impact}</div>
                {typeof proposal.currentValue === 'string' && <div className={css.proposalPreview}><b>修改前</b>{proposal.currentValue}</div>}
                {typeof proposal.proposedValue === 'string' && <div className={css.proposalPreview}><b>修改后</b>{proposal.proposedValue}</div>}
              </div>
            ))}
          </div>
        )}
        {footer}
      </div>
    )
  }
  const proposal = changeSet.proposals[0]
  if (proposal === undefined) return null
  let footer = proposalStatusFooter(applied, canceled, locked, unresolved, {
    stale: '建议已过期，请在对话中重新提出。',
    applied: '已应用并重新读取 Blueprint',
    canceled: '已取消，未修改 Agent',
  })
  if (pending) {
    footer = (
      <div className={css.proposalActions}>
        <button
          type="button"
          className={css.primaryButton}
          disabled={state.busy}
          onClick={() => { void applyChangeSet(changeSet) }}
        >应用</button>
        <button
          type="button"
          disabled={state.busy}
          onClick={() => { void cancelProposal(changeSet) }}
        >取消</button>
      </div>
    )
  }
  return (
    <div className={css.proposalCard} data-state={status}>
      <div className={css.proposalEyebrow}>修改建议</div>
      <div className={css.proposalTitle}>{proposalTitle(proposal)}</div>
      <div className={css.proposalImpact}>{proposal.impact}</div>
      {typeof proposal.proposedValue === 'string' && (
        <div className={css.proposalPreview}>{proposal.proposedValue}</div>
      )}
      {footer}
    </div>
  )
}

/** Frame-wide trial confirmation layer. */
export function BlueprintOverlay({ useBlueprintUi, closeModal, startTrial }: BlueprintOverlayProps) {
  const state = useBlueprintUi(value => value)
  const blueprint = state.blueprint
  const creatorLocked = state.creator !== null && state.creator.status !== 'ready'
  const interactionLocked = creatorLocked || capabilityExecutorActive(state.capabilityHandoff)
  if (state.modal === null || blueprint === null || interactionLocked) return null
  return (
    <div className={css.backdrop} role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) closeModal() }}>
      <div className={css.modal} role="dialog" aria-modal="true" aria-label="试用这个 Agent">
        <div className={css.modalHeader}>
          <h3>试用这个 Agent</h3>
          <button type="button" aria-label="关闭" onClick={closeModal}>×</button>
        </div>
        <p className={css.tryLead}>将用当前配置开启一个新的会话。</p>
        <p className={css.caption}>当前 Agent：{blueprint.preset.name ?? blueprint.preset.id}</p>
        <div className={css.modalActions}>
          <button type="button" onClick={closeModal}>取消</button>
          <button type="button" disabled={state.busy || state.applyReceiptsLoading === true} onClick={() => { void startTrial() }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void startTrial() } }}>{state.busy ? '正在创建…' : '开始试用'}</button>
        </div>
      </div>
    </div>
  )
}
