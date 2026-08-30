import { describe, expect, it, vi } from 'vitest'
import type {
  Blueprint, BlueprintApplyChangeSetRequest, BlueprintApplyChangeSetResult, BlueprintApplyReceipt,
  BlueprintChangeProposal, BlueprintChangeSet, BlueprintSessionValidation,
  BlueprintStructuredEditInput, BlueprintUserChangeInput,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { ConversationNode, ConversationSnapshot, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import {
  BlueprintTrialValidationError, BlueprintUiController, blueprintSessionLifecycleDiagnostic, creatorOwnsForeground,
  type BlueprintCapabilityAuthoringStart,
  type BlueprintCapabilityObservation, type BlueprintCreatorObservation, type BlueprintRemote,
  type BlueprintTargetPreference, type BlueprintAgentOption, type BlueprintCreatorDraft,
  type BlueprintTrialRequest, type BlueprintUiState,
} from '../src/client/controller.ts'
import {
  blueprintComposerInteraction, creatorAuthoringOwnsRoute, creatorAuthoringRoutes, creatorObservation,
  latestCapabilityRecoveryCandidates,
} from '../src/client/index.ts'
import { prepareBlueprintTrialSession } from '../src/client/trial-session.ts'

function blueprint(revision = 'r1', id = 'competitive-research', name = '竞品研究'): Blueprint {
  return {
    schemaVersion: 1,
    preset: { id, trust: 'user', name },
    revision,
    nodes: [
      { id: 'identity:persona', type: 'identity', value: '竞品研究分析师', source: 'preset', status: 'active', editable: true, adapterRef: 'identity' },
      { id: 'purpose:persona', type: 'purpose', value: '比较竞品。', source: 'inferred', status: 'active', editable: true, adapterRef: 'purpose' },
      { id: 'behavior:1', type: 'behavior', value: '先核实事实。', source: 'preset', status: 'active', editable: true, adapterRef: 'behavior:1' },
      { id: 'output:2', type: 'output', value: '输出摘要、对比表、结论和来源。', source: 'inferred', status: 'active', editable: true, adapterRef: 'output:2' },
      { id: 'capability:web-search', type: 'capability', value: { name: 'Web Search', tool: 'web_search', enabled: true }, source: 'runtime', status: 'active', editable: true, adapterRef: 'search' },
      { id: 'capability:web-fetch', type: 'capability', value: { name: 'Web Fetch', tool: 'web_fetch', enabled: true }, source: 'runtime', status: 'active', editable: true, adapterRef: 'fetch' },
      { id: 'capability:file-read', type: 'capability', value: { name: 'File Read', tool: 'read', enabled: true }, source: 'runtime', status: 'active', editable: false, adapterRef: null },
    ],
    runtime: { tools: ['web_search', 'web_fetch', 'read'], promptSections: ['deployment:persona'], skills: [], delegations: [], permissions: null },
    mappingGaps: [],
  }
}

function unverifiedSkillBlueprint(revision = 'r2'): Blueprint {
  const candidate = blueprint(revision)
  candidate.nodes.push({
    id: 'capability:skill:csv-laptop-spec-comparison', type: 'capability', source: 'preset',
    status: 'active', editable: false, adapterRef: null,
    value: {
      kind: 'skill', name: 'csv-laptop-spec-comparison', description: '处理笔记本参数 CSV。',
      callable: true, scope: 'preset', invocation: { modelInvocable: true, userInvocable: true },
    },
  })
  candidate.runtime.skills.push({
    name: 'csv-laptop-spec-comparison', description: '处理笔记本参数 CSV。',
    invocation: { modelInvocable: true, userInvocable: true }, scope: 'preset',
    provider: 'filesystem', source: 'custom', definitionDigest: 'unverified-skill-digest',
  })
  return candidate
}

function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

function singleChangeSet(
  proposal: BlueprintChangeProposal,
  sourceSessionId = 'session-1',
  routeId = `route:${proposal.proposalId}`,
): BlueprintChangeSet {
  return {
    changeSetId: proposal.proposalId,
    sourceSessionId,
    routeId,
    kind: 'direct-request',
    presetId: proposal.presetId,
    revision: proposal.revision,
    proposals: [proposal],
  }
}

function committedReceipt(input: {
  sourceSessionId: string
  routeId?: string
  changeSetId?: string
  presetId?: string
  baseRevision?: string
  committedRevision?: string
  proposalResultSeq?: number
  terminalSeq?: number
}): BlueprintApplyReceipt {
  const routeId = input.routeId ?? 'route:restored'
  return {
    sourceSessionId: input.sourceSessionId,
    routeId,
    proposalResultSeq: input.proposalResultSeq ?? 20,
    terminalSeq: input.terminalSeq ?? 21,
    presetId: input.presetId ?? 'competitive-research',
    result: {
      sourceSessionId: input.sourceSessionId,
      routeId,
      changeSetId: input.changeSetId ?? 'restored-change',
      baseRevision: input.baseRevision ?? 'r0',
      committedRevision: input.committedRevision ?? 'r1',
      status: 'committed',
      operations: [],
      preflight: { ok: true },
      unexpectedDrift: [],
    },
  }
}

type TestCreatorObservation = Omit<
  BlueprintCreatorObservation,
  'userMessages' | 'presetCopies' | 'associationAnswers' | 'authoredPresets' | 'validatedPresets'
> & {
  latestUserMessage?: { seq: number; text: string }
  authoredPresetIds: readonly string[]
  validatedPresetIds?: readonly string[]
}

function observeCreator(
  controller: BlueprintUiController,
  observation: TestCreatorObservation,
): Promise<void> {
  return controller.observeCreator({
    sessionId: observation.sessionId,
    ...(observation.presetId === undefined ? {} : { presetId: observation.presetId }),
    running: observation.running,
    waitingFor: observation.waitingFor,
    lastTurnEnd: observation.lastTurnEnd,
    userMessages: observation.latestUserMessage === undefined ? [] : [observation.latestUserMessage],
    presetCopies: [],
    associationAnswers: [],
    authoredPresets: observation.authoredPresetIds.map((presetId, index) => ({ seq: index + 2, presetId })),
    validatedPresets: (observation.validatedPresetIds ?? [])
      .map((presetId, index) => ({ seq: index + 10, presetId })),
  })
}

const CREATOR_SESSION_ID = 'creator-real-events' as SessionId
const CAPABILITY_OWNER = {
  routeId: 'capability-route', sourceSessionId: 'capability-session', baseRevision: 'r1',
} as const
const CREATION_MESSAGE: ConversationNode = {
  kind: 'user', seq: 7, time: 1,
  content: [{ type: 'text', text: '我要一个课程资料整理测试 Agent' }], source: { kind: 'user' },
}
const STRATEGY_QUESTION = {
  questions: [{
    id: 'course-org-intent',
    question: '已存在一个「课程资料整理测试 Agent」（preset id: course-material-org）。你希望怎么处理？',
    options: [
      { label: '直接用现有的 course-material-org 测试（推荐）', description: '使用已有 preset。' },
      { label: '在现有基础上完善后再测试', description: '基于已有 preset 完善。' },
      { label: '新建一个独立的测试 preset', description: '创建 course-material-test。' },
    ],
  }],
}

function toolResultNode(
  seq: number,
  name: string,
  args: unknown,
  text: string,
): ConversationNode {
  return {
    kind: 'tool-result', seq, time: seq, callId: `call-${seq}`,
    call: { name, argsRaw: JSON.stringify(args) }, callTime: seq - 1,
    content: [{ type: 'text', text }], isError: false, callView: null, resultView: null, subCalls: [],
  }
}

function creatorSnapshot(input: {
  nodes: readonly ConversationNode[]
  running: boolean
  pending?: 'question' | 'approval'
  turnEnd?: { seq: number; reason: 'completed' | 'max-tokens' }
  trailingOpenTurn?: boolean
}): ConversationSnapshot {
  const end = input.turnEnd === undefined
    ? undefined
    : { seq: input.turnEnd.seq, data: { reason: { kind: input.turnEnd.reason } } }
  const chatNodes: { kind: string; data: unknown }[] = []
  for (const node of input.nodes) {
    if (node.kind === 'user' || node.kind === 'steering') chatNodes.push({ kind: node.kind, data: node })
    if (node.kind === 'tool-result') chatNodes.push({ kind: 'tool-call', data: { root: node } })
  }
  return {
    nodes: input.nodes,
    running: input.running,
    runningCalls: [],
    pending: input.pending === undefined ? [] : [{ kind: input.pending }],
    chat: {
      nodes: { values: () => chatNodes },
      timeline: {
        turnOrder: input.trailingOpenTurn === true ? [1, 2] : [1],
        turns: new Map(input.trailingOpenTurn === true
          ? [[1, { end }], [2, {}]]
          : [[1, { end }]]),
      },
    },
  } as unknown as ConversationSnapshot
}

function realObservation(snapshot: ConversationSnapshot): BlueprintCreatorObservation {
  return creatorObservation(CREATOR_SESSION_ID, 'cordis', snapshot)
}

function bench(
  startDemoTrialSession?: (request: { presetId: string; expectedRevision: string }) => Promise<void>,
  cancelCapabilityAuthoring = vi.fn(() => Promise.resolve()),
  targetPreference?: BlueprintTargetPreference,
) {
  let projected = blueprint()
  let revision = 1
  const presets: (Omit<BlueprintAgentOption, 'label'> & { name?: string; isDefault: boolean })[] = [
    { id: 'standard', trust: 'system' as const, isDefault: true },
    { id: 'competitive-research', trust: 'user' as const, isDefault: false, name: '竞品研究' },
  ]
  const projections = new Map<string, Blueprint>([['competitive-research', projected]])
  const remote = {
    get: vi.fn<BlueprintRemote['get']>(({ presetId }) => {
      const value = projections.get(presetId)
      return Promise.resolve(value === undefined
        ? { ok: false as const, error: { code: 'not-found', message: `unknown ${presetId}`, details: { presetId } } }
        : ok(value))
    }),
    applyChangeSet: vi.fn((request: BlueprintApplyChangeSetRequest) => {
      projected = {
        ...projected,
        revision: `r${String(++revision)}`,
        nodes: projected.nodes.map((node) => {
          const operation = request.operations.find(candidate => candidate.targetNodeId === node.id)
          if (operation === undefined) return node
          if (operation.operation === 'setCapability') {
            if (typeof node.value !== 'object' || node.value === null || Array.isArray(node.value)) return node
            return { ...node, value: { ...node.value, enabled: operation.enabled } }
          }
          return { ...node, value: operation.value }
        }),
      }
      projections.set('competitive-research', projected)
      const result: BlueprintApplyChangeSetResult = {
        sourceSessionId: request.sourceSessionId,
        routeId: request.routeId,
        changeSetId: request.changeSetId,
        baseRevision: request.baseRevision,
        committedRevision: projected.revision,
        status: 'committed',
        operations: request.operations,
        preflight: { ok: true },
        unexpectedDrift: [],
      }
      return Promise.resolve(ok(result))
    }),
    setConversationContext: vi.fn<BlueprintRemote['setConversationContext']>(() => Promise.resolve(ok({
      sessionId: 'session-1', active: true,
    }))),
  } satisfies BlueprintRemote
  const catalog = {
    list: () => Promise.resolve({
      agents: presets.map(preset => ({
        id: preset.id,
        label: preset.name ?? preset.id,
        trust: preset.trust,
        ...('description' in preset && preset.description !== undefined ? { description: preset.description } : {}),
        ...('broken' in preset && preset.broken !== undefined ? { broken: preset.broken } : {}),
      })),
      preferredPresetId: 'competitive-research',
    }),
  }
  const validation: BlueprintSessionValidation = {
    sessionId: 'session-1', presetId: 'competitive-research', valid: true, overall: 'pass',
    binding: {
      status: 'pass', sessionPresetId: 'competitive-research', composedPresetId: 'competitive-research',
      expectedRevision: 'r1', projectedRevision: 'r1', strictRevisionBound: false,
    },
    prompt: { status: 'pass', evidence: [] },
    tools: { status: 'pass', evidence: [], missing: [], unexpected: [], schemaMismatches: [] },
    skills: { status: 'pass', evidence: [], missing: [], unexpected: [] },
    delegations: { status: 'pass', evidence: [] },
    permissions: { status: 'pass' },
  }
  const reveal = vi.fn()
  const sync = vi.fn<(
    blueprint: Blueprint | null,
    selectedNodeId: string | null,
    creatorDraft?: BlueprintCreatorDraft,
    userChange?: BlueprintUserChangeInput,
    directEditInput?: BlueprintStructuredEditInput,
  ) => Promise<void>>(() => Promise.resolve())
  const publish = (
    sessionId: string | undefined,
    projectedBlueprint: Blueprint | null,
    selectedNodeId: string | null,
    creatorDraft?: Parameters<typeof sync>[2],
    userChange?: Parameters<typeof sync>[3],
    directEditInput?: Parameters<typeof sync>[4],
    isCurrent: () => boolean = () => true,
  ): Promise<void> => {
    const publication = directEditInput !== undefined
      ? sync(projectedBlueprint, selectedNodeId, creatorDraft, userChange, directEditInput)
      : userChange !== undefined
        ? sync(projectedBlueprint, selectedNodeId, creatorDraft, userChange)
        : creatorDraft !== undefined
          ? sync(projectedBlueprint, selectedNodeId, creatorDraft)
          : sync(projectedBlueprint, selectedNodeId)
    return publication.then(() => {
      if (sessionId !== undefined && isCurrent()) controller.restoreApplyReceipts(sessionId, [])
    })
  }
  const trial = vi.fn((_request: BlueprintTrialRequest) => Promise.resolve(validation))
  const capabilityConversation = vi.fn((handoff: { sourceSessionId: string }) => Promise.resolve({
    sourceSessionId: handoff.sourceSessionId, sourceStartSeq: 20,
  }))
  const capabilityAuthoring = vi.fn((): Promise<BlueprintCapabilityAuthoringStart> => Promise.resolve({
    creatorSessionId: 'creator-session', startSeq: 40, baselineDelegationRowIds: [],
  }))
  const cancelProposalDecision = vi.fn((changeSet: BlueprintChangeSet) => Promise.resolve(ok({
    sourceSessionId: changeSet.sourceSessionId,
    routeId: changeSet.routeId,
    proposalResultSeq: 30,
    changeSetId: changeSet.changeSetId,
    presetId: changeSet.presetId,
    baseRevision: changeSet.revision,
    status: 'cancelled' as const,
  })))
  const controller = new BlueprintUiController(
    catalog, remote, reveal, publish, trial, capabilityConversation, capabilityAuthoring,
    startDemoTrialSession, cancelCapabilityAuthoring, targetPreference, cancelProposalDecision,
  )
  return {
    controller,
    remote, reveal, sync, trial, capabilityConversation, capabilityAuthoring,
    cancelCapabilityAuthoring, cancelProposalDecision, presets, projections,
  }
}

describe('Interactive Blueprint controller', () => {
  it('reports whether the exact foreground Blueprint context was installed', async () => {
    const fixture = bench()
    await fixture.controller.activateSession('source-cordis', 'cordis')
    fixture.sync.mockRejectedValueOnce(new Error('context unavailable'))

    await expect(fixture.controller.syncConversation()).resolves.toBe(false)
    expect(fixture.controller.store.getSnapshot().error).toBe('context unavailable')

    await expect(fixture.controller.syncConversation()).resolves.toBe(true)
  })

  it('grants foreground only to the viewed owner, not an unrelated or absent Session', () => {
    expect(creatorOwnsForeground('session-b', 'creator-a')).toBe(false)
    expect(creatorOwnsForeground(undefined, 'creator-a')).toBe(false)
    expect(creatorOwnsForeground('creator-a', 'creator-a')).toBe(true)
  })

  it('retains the exact background Creator interaction for the source view and clears it when resolved', async () => {
    const fixture = bench()
    await fixture.controller.activateSession('source-a', 'cordis')
    const pendingInteraction = {
      kind: 'question', key: 'creator-question-1', sessionId: 'creator-child',
      payload: { questions: [{ id: 'scope', question: '研究范围是什么？' }] },
      respond: vi.fn(),
    } as unknown as NonNullable<BlueprintCreatorObservation['pendingInteraction']>
    const snapshot = creatorSnapshot({ nodes: [CREATION_MESSAGE], running: true })
    const observed = creatorObservation(
      'creator-child' as SessionId,
      'cordis',
      { ...snapshot, pending: [pendingInteraction] },
    )
    expect(observed.pendingInteraction).toBe(pendingInteraction)

    const typedObserved: BlueprintCreatorObservation = {
      ...observed,
      creatorAuthoring: {
        operation: 'create-agent', routeId: 'route-a', sourceSessionId: 'source-a',
        name: '课程资料整理测试 Agent', request: '创建课程资料整理测试 Agent', startSeq: 7,
      },
    }
    await fixture.controller.observeCreator(typedObserved)
    expect(fixture.controller.store.getSnapshot().creator?.pendingInteraction).toBe(pendingInteraction)
    expect(fixture.controller.store.getSnapshot().creator?.sessionId).toBe('source-a')

    await fixture.controller.observeCreator({ ...typedObserved, waitingFor: null, pendingInteraction: null })
    expect(fixture.controller.store.getSnapshot().creator?.pendingInteraction).toBeUndefined()
  })

  it('selects only child-owned composer carriers for the current Creator or capability source route', () => {
    const base = bench().controller.store.getSnapshot()
    const creatorSource = 'source-create' as SessionId
    const creatorCarrier = {
      kind: 'question', key: 'creator-question', sessionId: 'creator-child',
    } as unknown as NonNullable<BlueprintCreatorObservation['pendingInteraction']>
    const creatorState: BlueprintUiState = {
      ...base,
      creator: {
        sessionId: creatorSource, routeId: 'route-create', name: '研究 Agent', status: 'waiting',
        candidateIds: [], waitingFor: 'question', pendingInteraction: creatorCarrier,
      },
    }

    expect(blueprintComposerInteraction(creatorState, creatorSource)).toBe(creatorCarrier)
    expect(blueprintComposerInteraction(creatorState, 'other-source' as SessionId)).toBeUndefined()
    expect(blueprintComposerInteraction(creatorState, undefined)).toBeUndefined()
    const sameSessionCreatorCarrier = {
      kind: 'question', key: 'creator-question', sessionId: creatorSource,
    } as unknown as NonNullable<BlueprintCreatorObservation['pendingInteraction']>
    expect(blueprintComposerInteraction({
      ...creatorState,
      creator: { ...creatorState.creator!, pendingInteraction: sameSessionCreatorCarrier },
    }, creatorSource)).toBeUndefined()
    const { pendingInteraction: _creatorInteraction, ...clearedCreator } = creatorState.creator!
    expect(blueprintComposerInteraction({
      ...creatorState, creator: clearedCreator,
    }, creatorSource)).toBeUndefined()

    const capabilitySource = 'source-capability' as SessionId
    const capabilityCarrier = {
      kind: 'approval', key: 'creator-approval', sessionId: 'capability-child',
    } as unknown as NonNullable<BlueprintCapabilityObservation['pendingInteraction']>
    const capabilityState: BlueprintUiState = {
      ...base,
      capabilityHandoff: {
        sourceSessionId: capabilitySource, routeId: 'route-capability', request: '添加 CSV Skill',
        label: '添加 CSV Skill', targetPresetId: 'competitive-research', revision: 'r1',
        status: 'authoring', creatorSessionId: 'capability-child', waitingFor: 'approval',
        pendingInteraction: capabilityCarrier,
      },
    }

    expect(blueprintComposerInteraction(capabilityState, capabilitySource)).toBe(capabilityCarrier)
    expect(blueprintComposerInteraction(capabilityState, creatorSource)).toBeUndefined()
    const sameSessionCapabilityCarrier = {
      kind: 'approval', key: 'creator-approval', sessionId: capabilitySource,
    } as unknown as NonNullable<BlueprintCapabilityObservation['pendingInteraction']>
    expect(blueprintComposerInteraction({
      ...capabilityState,
      capabilityHandoff: {
        ...capabilityState.capabilityHandoff!,
        pendingInteraction: sameSessionCapabilityCarrier,
      },
    }, capabilitySource)).toBeUndefined()
    const {
      pendingInteraction: _capabilityInteraction, ...clearedCapability
    } = capabilityState.capabilityHandoff!
    expect(blueprintComposerInteraction({
      ...capabilityState,
      capabilityHandoff: clearedCapability,
    }, capabilitySource)).toBeUndefined()
    const {
      creatorSessionId: _legacyCreatorSessionId, ...sourceOwnedCapability
    } = capabilityState.capabilityHandoff!
    expect(blueprintComposerInteraction({
      ...capabilityState,
      capabilityHandoff: sourceOwnedCapability,
    }, capabilitySource)).toBeUndefined()
  })

  const pausedObservation: BlueprintCreatorObservation = {
    sessionId: 'creator-a', presetId: 'cordis', running: false, waitingFor: null,
    lastTurnEnd: { seq: 30, reason: 'aborted' },
    userMessages: [], presetCopies: [], associationAnswers: [], authoredPresets: [], validatedPresets: [],
    creatorAuthoring: {
      operation: 'create-agent', routeId: 'route-a', sourceSessionId: 'source-a',
      name: '供应商尽调 Agent', request: '创建供应商尽调 Agent', startSeq: 7,
    },
  }

  async function creatorFixture(observation = pausedObservation) {
    const fixture = bench()
    await fixture.controller.activateSession('source-a', 'cordis')
    await fixture.controller.observeCreator(observation)
    fixture.presets.push({ id: 'supplier', trust: 'user', isDefault: false, name: '供应商尽调 Agent' })
    fixture.projections.set('supplier', blueprint('supplier-r1', 'supplier', '供应商尽调 Agent'))
    const associated = {
      ...observation,
      authoredPresets: [{ seq: 10, presetId: 'supplier' }],
      validatedPresets: [{ seq: 11, presetId: 'supplier' }],
    }
    await fixture.controller.observeCreator(associated)
    return { ...fixture, associated }
  }

  it.each([
    '增加 CSV 能力，但不创建新 Agent。',
    '增加 CSV 能力，但不要创建新 Agent。',
    '创建新 Agent。',
    '你觉得这个 Agent 现在还缺什么？',
  ])('does not replace a terminal typed task from later free text: %s', async (text) => {
    const { controller, associated } = await creatorFixture({
      ...pausedObservation, lastTurnEnd: { seq: 30, reason: 'completed' },
    })
    const ready = controller.store.getSnapshot()
    expect(ready.creator).toMatchObject({ routeId: 'route-a', status: 'ready' })
    const { creatorAuthoring: _task, ...untyped } = associated
    for (const running of [true, false]) {
      await controller.observeCreator({
        ...untyped, running, userMessages: [{ seq: 40, text }],
        lastTurnEnd: { seq: 50, reason: 'aborted' },
      })
      expect(controller.store.getSnapshot()).toBe(ready)
    }
    for (const waitingFor of [null, 'approval', 'question'] as const) {
      await controller.observeCreator({ ...associated, running: true, waitingFor })
      expect(controller.store.getSnapshot()).toBe(ready)
    }
    await controller.observeCreator({
      ...untyped, running: true, userMessages: [{ seq: 60, text: 'Create another Agent.' }],
      creatorAuthoring: { ...associated.creatorAuthoring!, routeId: 'route-b', startSeq: 61, name: 'Task B' },
    })
    expect(controller.store.getSnapshot().creator).toMatchObject({ routeId: 'route-b', status: 'creating', name: 'Task B' })
  })

  it('restores task terminal evidence despite a later stopped turn, refresh, and Session switches', async () => {
    const { controller, associated } = await creatorFixture()
    const terminal: BlueprintCreatorObservation = {
      ...associated, lastTurnEnd: { seq: 90, reason: 'aborted' },
      userMessages: [{ seq: 80, text: '增加 CSV 能力，但不创建新 Agent。' }],
      creatorAuthoring: { ...associated.creatorAuthoring!, terminal: {
        routeId: 'route-a', startSeq: 7, outcome: 'completed', targetPresetId: 'supplier', validationSeq: 11, turnEndSeq: 30,
      } },
    }
    await controller.observeCreator(terminal)
    expect(controller.store.getSnapshot().creator).toMatchObject({ status: 'ready', routeId: 'route-a' })
    await controller.activateSession('other-session', 'competitive-research')
    await controller.activateSession('source-a', 'cordis')
    await controller.observeCreator(terminal)
    expect(controller.store.getSnapshot()).toMatchObject({ presetId: 'supplier', creator: { status: 'ready' } })
    const rebuilt = await creatorFixture(terminal)
    expect(rebuilt.controller.store.getSnapshot()).toMatchObject({ presetId: 'supplier', creator: { status: 'ready' } })
  })

  it.each(['failed', 'cancelled'] as const)('does not reactivate a %s task from stale recovery or text', async (outcome) => {
    const { controller, associated } = await creatorFixture()
    await controller.observeCreator({ ...associated, creatorAuthoring: {
      ...associated.creatorAuthoring!, terminal: { routeId: 'route-a', startSeq: 7, turnEndSeq: 30, outcome },
    } })
    await controller.observeCreator(associated)
    const { creatorAuthoring: _task, ...untyped } = associated
    await controller.observeCreator({ ...untyped, userMessages: [{ seq: 99, text: '创建新 Agent。' }] })
    expect(controller.store.getSnapshot().creator).toBeNull()
  })

  it.each(['paused', 'creating', 'waiting', 'ready'] as const)(
    'does not let foreign %s Creator recovery replace a new Session or lock its roster', async (status) => {
      const observation = {
        ...pausedObservation,
        running: status === 'creating',
        waitingFor: status === 'waiting' ? 'question' as const : null,
        lastTurnEnd: { seq: 30, reason: status === 'ready' ? 'completed' as const : 'aborted' as const },
      }
      const { controller, associated, remote, cancelCapabilityAuthoring } = await creatorFixture(observation)
      expect(controller.store.getSnapshot().creator?.status).toBe(status)
      await controller.activateSession('blank-b', 'competitive-research')
      const clean = controller.store.getSnapshot()
      remote.get.mockClear()
      await controller.observeCreator(associated)
      await controller.pollCreator()
      expect(controller.store.getSnapshot()).toBe(clean)
      expect(clean).toMatchObject({ creator: null, presetId: 'competitive-research' })
      expect(remote.get).not.toHaveBeenCalled()
      await controller.selectPreset('competitive-research')
      expect(remote.get).toHaveBeenCalledWith({ presetId: 'competitive-research' })
      expect(cancelCapabilityAuthoring).not.toHaveBeenCalled()

      await controller.activateSession('source-a', 'cordis')
      expect(controller.store.getSnapshot()).toMatchObject({
        presetId: 'supplier', creator: { sessionId: 'source-a', status },
      })
      remote.get.mockClear()
      await controller.selectPreset('competitive-research')
      if (status !== 'ready') expect(remote.get).not.toHaveBeenCalled()
    },
  )

  it('restores only its own durable Creator context in a fresh controller', async () => {
    const { controller, associated, presets, projections } = await creatorFixture()
    const refreshed = bench()
    refreshed.presets.push(...presets.filter(preset => preset.id === 'supplier'))
    refreshed.projections.set('supplier', projections.get('supplier')!)
    await refreshed.controller.activateSession('blank-b', 'competitive-research')
    await refreshed.controller.observeCreator(associated)
    expect(refreshed.controller.store.getSnapshot().creator).toBeNull()
    await refreshed.controller.activateSession('source-a', 'cordis')
    await refreshed.controller.observeCreator(associated)
    expect(refreshed.controller.store.getSnapshot().creator).toEqual(controller.store.getSnapshot().creator)
  })

  it.each(['load', 'poll'] as const)('discards an old Creator %s response after switching Session', async (operation) => {
    const { controller, remote, sync, associated } = await creatorFixture()
    let release!: (value: RemoteResult<Blueprint>) => void
    remote.get.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const stale = operation === 'load' ? controller.load() : controller.pollCreator()
    await vi.waitFor(() => { expect(release).toBeDefined() })
    await controller.activateSession('agent-b', 'competitive-research')
    await controller.activateSession(undefined, undefined)
    const clean = controller.store.getSnapshot()
    sync.mockClear()
    release(ok(blueprint('old', 'supplier', '供应商尽调 Agent')))
    await stale
    expect(controller.store.getSnapshot()).toBe(clean)
    expect(sync).not.toHaveBeenCalled()
    await controller.activateSession('source-a', 'cordis')
    await controller.observeCreator(associated)
    expect(controller.store.getSnapshot()).toMatchObject({
      presetId: 'supplier', creator: { sessionId: 'source-a', status: 'paused' },
      blueprint: { revision: 'supplier-r1' },
    })
  })

  it('rejects a stale load even after A → B → A returns to the same owner', async () => {
    const { controller, remote } = await creatorFixture()
    let release!: (value: RemoteResult<Blueprint>) => void
    remote.get.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const stale = controller.load()
    await vi.waitFor(() => { expect(release).toBeDefined() })
    await controller.activateSession('agent-b', 'competitive-research')
    await controller.activateSession('source-a', 'cordis')
    release(ok(blueprint('stale', 'supplier', '供应商尽调 Agent')))
    await stale
    expect(controller.store.getSnapshot().blueprint?.revision).toBe('supplier-r1')
  })

  it('does not publish a selected target after its owning Session changes during the read', async () => {
    const { controller, remote, presets, projections } = bench()
    presets.push({ id: 'kaoyan-choose', trust: 'user', isDefault: false, name: '考研择校' })
    projections.set('kaoyan-choose', blueprint('k1', 'kaoyan-choose', '考研择校'))
    await controller.activateSession('session-a', 'competitive-research')
    const read = deferred<RemoteResult<Blueprint>>()
    remote.get.mockImplementationOnce(() => read.promise)

    const selecting = controller.selectPreset('kaoyan-choose')
    await controller.activateSession('session-b', 'competitive-research')
    read.resolve(ok(projections.get('kaoyan-choose')!))
    await selecting

    expect(controller.store.getSnapshot()).toMatchObject({
      busy: false, presetId: 'competitive-research', blueprint: { preset: { id: 'competitive-research' } },
    })
  })

  it('clears busy and rejects a structured edit when the Session changes during context publication', async () => {
    const { controller, sync } = bench()
    await controller.activateSession('session-a', 'competitive-research')
    const publication = deferred<undefined>()
    sync.mockImplementationOnce(() => publication.promise)

    const editing = controller.updateText('purpose:persona', '分析目标市场。', '比较竞品。')
    expect(controller.store.getSnapshot().busy).toBe(true)
    await controller.activateSession('session-b', 'competitive-research')
    expect(controller.store.getSnapshot().busy).toBe(false)
    publication.resolve(undefined)

    await expect(editing).rejects.toThrow(/不在前台/u)
    expect(controller.store.getSnapshot()).toMatchObject({
      busy: false, error: null, presetId: 'competitive-research', selectedNodeId: null,
    })
  })

  it('does not publish an Apply completion after the foreground generation changes', async () => {
    const { controller, remote } = bench()
    await controller.activateSession('session-a', 'competitive-research')
    const applied = deferred<RemoteResult<BlueprintApplyChangeSetResult>>()
    remote.applyChangeSet.mockImplementationOnce(() => applied.promise)
    const changeSet = singleChangeSet({
      proposalId: 'late-apply', presetId: 'competitive-research', revision: 'r1',
      targetNodeId: 'behavior:1', operation: 'updateBehavior',
      currentValue: '先核实事实。', proposedValue: '优先官方来源。', impact: '优先一手资料。',
    }, 'session-a')

    const applying = controller.applyChangeSet(changeSet)
    expect(controller.store.getSnapshot().busy).toBe(true)
    await controller.activateSession('session-b', 'competitive-research')
    applied.resolve(ok({
      sourceSessionId: 'session-a', routeId: changeSet.routeId,
      changeSetId: changeSet.changeSetId, baseRevision: 'r1', committedRevision: 'r2',
      status: 'committed', operations: [], preflight: { ok: true }, unexpectedDrift: [],
    }))
    await applying

    expect(controller.store.getSnapshot()).toMatchObject({
      busy: false, presetId: 'competitive-research', validation: null, applyReceipts: [],
    })
    expect(remote.get).toHaveBeenLastCalledWith({ presetId: 'competitive-research' })
  })

  it('does not publish trial validation after the source Session changes', async () => {
    const { controller, trial } = bench()
    await controller.activateSession('session-a', 'competitive-research')
    const validation = deferred<BlueprintSessionValidation>()
    trial.mockImplementationOnce(() => validation.promise)

    const trying = controller.startTrial()
    expect(controller.store.getSnapshot().busy).toBe(true)
    await controller.activateSession('session-b', 'competitive-research')
    validation.resolve({
      sessionId: 'trial-a', presetId: 'competitive-research', valid: true, overall: 'pass',
      binding: {
        status: 'pass', sessionPresetId: 'competitive-research', composedPresetId: 'competitive-research',
        expectedRevision: 'r1', projectedRevision: 'r1', strictRevisionBound: false,
      },
      prompt: { status: 'pass', evidence: [] },
      tools: { status: 'pass', evidence: [], missing: [], unexpected: [], schemaMismatches: [] },
      skills: { status: 'pass', evidence: [], missing: [], unexpected: [] },
      delegations: { status: 'pass', evidence: [] }, permissions: { status: 'pass' },
    })
    await trying

    expect(controller.store.getSnapshot()).toMatchObject({ busy: false, validation: null, modal: null })
  })

  it('does not publish a default projection after the same Session recovers its Creator Draft', async () => {
    const { controller, remote } = bench()
    let release!: (value: RemoteResult<Blueprint>) => void
    remote.get.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const loading = controller.activateSession('source-a', 'cordis')
    await vi.waitFor(() => { expect(release).toBeDefined() })
    await controller.observeCreator(pausedObservation)
    const recovered = controller.store.getSnapshot()
    expect(recovered).toMatchObject({ blueprint: null, creator: { sessionId: 'source-a', status: 'paused' } })
    release(ok(blueprint()))
    await loading
    expect(controller.store.getSnapshot()).toBe(recovered)
  })

  it('keeps a typed Creator Draft on its source while its child stays background-only', async () => {
    const { controller } = bench()
    await controller.activateSession('source-a', 'cordis')
    controller.beginCreatorAuthoringRoute('source-a', pausedObservation.creatorAuthoring!)
    expect(controller.store.getSnapshot().creator?.sessionId).toBe('source-a')
    await controller.observeCreator(pausedObservation)
    expect(controller.store.getSnapshot().creator?.sessionId).toBe('source-a')
    await controller.activateSession('agent-b', 'competitive-research')
    const clean = controller.store.getSnapshot()
    controller.beginCreatorAuthoringRoute('source-a', pausedObservation.creatorAuthoring!)
    controller.failCreatorAuthoringRoute('source-a', new Error('late handoff failure'))
    expect(controller.store.getSnapshot()).toBe(clean)
    await controller.activateSession('creator-a', 'cordis')
    await controller.observeCreator(pausedObservation)
    expect(controller.store.getSnapshot().creator).toBeNull()
    await controller.activateSession('source-a', 'cordis')
    await controller.observeCreator(pausedObservation)
    expect(controller.store.getSnapshot().creator).toMatchObject({ sessionId: 'source-a', status: 'paused' })
  })

  it('loads the real roster target and projects competitive-research first', async () => {
    const { controller, remote, reveal } = bench()

    await controller.load()

    expect(remote.get).toHaveBeenCalledWith({ presetId: 'competitive-research' })
    expect(controller.store.getSnapshot()).toMatchObject({ phase: 'ready', presetId: 'competitive-research' })
    expect(reveal).toHaveBeenCalledTimes(1)
  })

  it('resolves Blueprint targets per Session and restores only the same Session preference', async () => {
    const stored = new Map<string, string>()
    const preference: BlueprintTargetPreference = {
      read: sessionId => sessionId === undefined ? null : stored.get(sessionId) ?? null,
      write: (presetId, sessionId) => { if (sessionId !== undefined) stored.set(sessionId, presetId) },
      clear: (sessionId) => { if (sessionId !== undefined) stored.delete(sessionId) },
    }
    const fixture = bench(undefined, undefined, preference)
    fixture.presets.push(
      { id: 'kaoyan-choose', trust: 'user', isDefault: false, name: '考研择校' },
      { id: 'cordis', trust: 'system', isDefault: false, name: '创造模式' },
    )
    fixture.projections.set('kaoyan-choose', blueprint('k1', 'kaoyan-choose', '考研择校'))
    fixture.projections.set('cordis', blueprint('c1', 'cordis', '创造模式'))

    await fixture.controller.activateSession('session-a', 'competitive-research')
    await fixture.controller.selectPreset('kaoyan-choose')
    expect(stored.get('session-a')).toBe('kaoyan-choose')

    await fixture.controller.activateSession('session-b', 'cordis')
    expect(fixture.controller.store.getSnapshot().presetId).toBe('cordis')

    await fixture.controller.activateSession('session-a', 'competitive-research')
    expect(fixture.controller.store.getSnapshot().presetId).toBe('kaoyan-choose')
  })

  it('invalidates a reused blank Session projection when its runtime preset is recomposed', async () => {
    const stored = new Map<string, string>()
    const preference: BlueprintTargetPreference = {
      read: sessionId => sessionId === undefined ? null : stored.get(sessionId) ?? null,
      write: (presetId, sessionId) => { if (sessionId !== undefined) stored.set(sessionId, presetId) },
      clear: (sessionId) => { if (sessionId !== undefined) stored.delete(sessionId) },
    }
    const fixture = bench(undefined, undefined, preference)
    fixture.presets.push({ id: 'cordis', trust: 'system', isDefault: false, name: '创造模式' })
    fixture.projections.set('cordis', blueprint('c1', 'cordis', '创造模式'))

    await fixture.controller.activateSession('blank-session', 'competitive-research')
    await fixture.controller.selectPreset('competitive-research')
    expect(stored.get('blank-session')).toBe('competitive-research')

    fixture.sync.mockClear()
    fixture.controller.awaitSessionPreset('blank-session')
    await fixture.controller.activateSession('blank-session', 'cordis')

    expect(stored.has('blank-session')).toBe(false)
    expect(fixture.controller.store.getSnapshot().presetId).toBe('cordis')
    expect(fixture.sync).toHaveBeenLastCalledWith(null, null)
    fixture.sync.mockClear()
    await fixture.controller.syncConversation()
    expect(fixture.sync).toHaveBeenCalledWith(null, null)
  })

  it('preserves a restored target while the Host hydrates the same Session runtime preset', async () => {
    const stored = new Map<string, string>([['source-session', 'kaoyan-choose']])
    const preference: BlueprintTargetPreference = {
      read: sessionId => sessionId === undefined ? null : stored.get(sessionId) ?? null,
      write: (presetId, sessionId) => { if (sessionId !== undefined) stored.set(sessionId, presetId) },
      clear: (sessionId) => { if (sessionId !== undefined) stored.delete(sessionId) },
    }
    const fixture = bench(undefined, undefined, preference)
    fixture.presets.push(
      { id: 'kaoyan-choose', trust: 'user', isDefault: false, name: '考研择校' },
      { id: 'cordis', trust: 'system', isDefault: false, name: '创造模式' },
    )
    fixture.projections.set('kaoyan-choose', blueprint('k1', 'kaoyan-choose', '考研择校'))
    fixture.projections.set('cordis', blueprint('c1', 'cordis', '创造模式'))

    await fixture.controller.activateSession('source-session', undefined)
    expect(fixture.controller.store.getSnapshot().presetId).toBe('kaoyan-choose')

    await fixture.controller.activateSession('source-session', 'cordis')

    expect(stored.get('source-session')).toBe('kaoyan-choose')
    expect(fixture.controller.store.getSnapshot().presetId).toBe('kaoyan-choose')
  })

  it('diagnoses a target/runtime split without a Session-owned override', () => {
    expect(blueprintSessionLifecycleDiagnostic({
      activeSessionId: 'session-a', runtimePresetId: 'cordis',
      targetPresetId: 'competitive-research', stagedAuthoring: false, sessionOverride: false,
    })).toMatch(/differs from runtime preset/u)
    expect(blueprintSessionLifecycleDiagnostic({
      activeSessionId: 'session-a', runtimePresetId: 'cordis',
      targetPresetId: 'new-agent', creatorSessionId: 'session-a', stagedAuthoring: true,
      sessionOverride: false,
    })).toBeNull()
  })

  it('clears the previous Blueprint while a new Session awaits its staged runtime preset', async () => {
    const fixture = bench()
    await fixture.controller.activateSession('session-a', 'competitive-research')
    expect(fixture.controller.store.getSnapshot().blueprint?.preset.id).toBe('competitive-research')

    fixture.controller.awaitSessionPreset('session-b')
    expect(fixture.controller.store.getSnapshot()).toMatchObject({
      phase: 'loading', presetId: '', blueprint: null, creator: null,
    })
  })

  it('restores the last valid Blueprint target and lets an explicit selection replace it', async () => {
    let stored: string | null = 'kaoyan-choose'
    const write = vi.fn((presetId: string) => { stored = presetId })
    const preference: BlueprintTargetPreference = {
      read: vi.fn(() => stored),
      write,
      clear: vi.fn(() => { stored = null }),
    }
    const first = bench(undefined, undefined, preference)
    first.presets.push({ id: 'kaoyan-choose', trust: 'user', isDefault: false, name: '考研择校' })
    first.projections.set('kaoyan-choose', blueprint('k1', 'kaoyan-choose', '考研择校'))

    await first.controller.load()
    expect(first.controller.store.getSnapshot().presetId).toBe('kaoyan-choose')

    await first.controller.selectPreset('competitive-research')
    expect(stored).toBe('competitive-research')

    const refreshed = bench(undefined, undefined, preference)
    await refreshed.controller.load()
    expect(refreshed.controller.store.getSnapshot().presetId).toBe('competitive-research')
  })

  it('keeps an explicit Creator selection above later automatic target recovery', async () => {
    let stored: string | null = 'competitive-research'
    const preference: BlueprintTargetPreference = {
      read: () => stored,
      write: (presetId) => { stored = presetId },
      clear: () => { stored = null },
    }
    const fixture = bench(undefined, undefined, preference)
    fixture.presets.push({ id: 'cordis', trust: 'system', isDefault: false, name: '创造模式' })
    fixture.projections.set('cordis', blueprint('c1', 'cordis', '创造模式'))
    await fixture.controller.activateSession('viewer-session', 'cordis')

    await fixture.controller.selectPreset('cordis')
    const restored = await fixture.controller.restoreCapabilityAuthoring('creator-session', {
      ...CAPABILITY_OWNER,
      targetPresetId: 'competitive-research', request: '创建 CSV Skill', kind: 'skill', startSeq: 40,
      baselineDelegationRowIds: [],
    }, 'approval')

    expect(restored).toBe(true)
    expect(stored).toBe('cordis')
    expect(fixture.controller.store.getSnapshot()).toMatchObject({
      presetId: 'cordis', blueprint: { preset: { id: 'cordis' } }, capabilityHandoff: null,
    })
  })

  it('does not let an older terminal capability record replace a newer restored selection', async () => {
    let stored: string | null = 'cordis'
    const preference: BlueprintTargetPreference = {
      read: () => stored,
      write: (presetId) => { stored = presetId },
      clear: () => { stored = null },
    }
    const fixture = bench(undefined, undefined, preference)
    fixture.presets.push({ id: 'cordis', trust: 'system', isDefault: false, name: '创造模式' })
    fixture.projections.set('cordis', blueprint('c1', 'cordis', '创造模式'))
    await fixture.controller.activateSession('viewer-session', 'cordis')

    const restored = await fixture.controller.restoreTerminalCapabilityAuthoring('old-creator-session', {
      ...CAPABILITY_OWNER,
      targetPresetId: 'competitive-research', request: '创建 CSV Skill', kind: 'skill', startSeq: 40,
      baselineDelegationRowIds: [], state: 'ended', endSeq: 45, outcome: 'completed',
    })

    expect(restored).toBe(true)
    expect(stored).toBe('cordis')
    expect(fixture.controller.store.getSnapshot()).toMatchObject({
      presetId: 'cordis', blueprint: { preset: { id: 'cordis' } }, capabilityHandoff: null,
    })
  })

  it('keeps the committed Blueprint during active recovery, then publishes the verified terminal target', async () => {
    let stored: string | null = 'competitive-research'
    const preference: BlueprintTargetPreference = {
      read: () => stored,
      write: (presetId) => { stored = presetId },
      clear: () => { stored = null },
    }
    const fixture = bench(undefined, undefined, preference)
    fixture.presets.push({ id: 'kaoyan-choose', trust: 'user', isDefault: false, name: '考研择校' })
    fixture.projections.set('kaoyan-choose', blueprint('k1', 'kaoyan-choose', '考研择校'))
    await fixture.controller.activateSession('capability-session', 'competitive-research')
    const committed = fixture.controller.store.getSnapshot().blueprint
    fixture.remote.get.mockClear()

    const restored = await fixture.controller.restoreCapabilityAuthoring('creator-session', {
      ...CAPABILITY_OWNER,
      targetPresetId: 'kaoyan-choose', request: '创建 CSV Skill', kind: 'skill', startSeq: 40,
      baselineDelegationRowIds: [],
    }, 'approval')
    expect(restored).toBe(true)
    expect(fixture.remote.get).not.toHaveBeenCalled()
    expect(fixture.controller.store.getSnapshot().presetId).toBe('competitive-research')
    expect(fixture.controller.store.getSnapshot().blueprint).toBe(committed)
    expect(stored).toBe('competitive-research')

    await fixture.controller.restoreTerminalCapabilityAuthoring('creator-session', {
      ...CAPABILITY_OWNER,
      targetPresetId: 'kaoyan-choose', request: '创建 CSV Skill', kind: 'skill', startSeq: 40,
      baselineDelegationRowIds: [], state: 'ended', endSeq: 45, outcome: 'completed',
    })
    expect(stored).toBe('kaoyan-choose')
    expect(fixture.remote.get).toHaveBeenCalledTimes(1)
    expect(fixture.controller.store.getSnapshot().blueprint?.preset.id).toBe('kaoyan-choose')
    expect(fixture.controller.store.getSnapshot().capabilityHandoff?.status).toBe('completed')
  })

  it('restores the formal target Blueprint for a source-owned active lifecycle', async () => {
    let stored: string | null = 'cordis'
    const preference: BlueprintTargetPreference = {
      read: () => stored,
      write: (presetId) => { stored = presetId },
      clear: () => { stored = null },
    }
    const fixture = bench(undefined, undefined, preference)
    fixture.presets.push(
      { id: 'cordis', trust: 'system', isDefault: false, name: '创造模式' },
      { id: 'kaoyan-choose', trust: 'user', isDefault: false, name: '考研择校' },
    )
    fixture.projections.set('cordis', blueprint('c1', 'cordis', '创造模式'))
    fixture.projections.set('kaoyan-choose', blueprint('k1', 'kaoyan-choose', '考研择校'))
    await fixture.controller.activateSession('source-cordis', 'cordis')
    await fixture.controller.selectPreset('cordis')
    fixture.remote.get.mockClear()

    const restored = await fixture.controller.restoreCapabilityAuthoring('source-cordis', {
      routeId: 'same-source-route', sourceSessionId: 'source-cordis', baseRevision: 'k1',
      targetPresetId: 'kaoyan-choose', request: '创建 CSV Skill', kind: 'skill', startSeq: 40,
      baselineDelegationRowIds: [],
    }, null, 23)

    expect(restored).toBe(true)
    expect(fixture.remote.get).toHaveBeenCalledWith({ presetId: 'kaoyan-choose' })
    expect(stored).toBe('kaoyan-choose')
    expect(fixture.controller.store.getSnapshot()).toMatchObject({
      presetId: 'kaoyan-choose', blueprint: { preset: { id: 'kaoyan-choose' } },
      capabilityHandoff: { sourceSessionId: 'source-cordis', status: 'authoring' },
    })
  })

  it('restores the unchanged formal target after a source-owned failed terminal', async () => {
    const fixture = bench()
    fixture.presets.push({ id: 'cordis', trust: 'system', isDefault: false, name: '创造模式' })
    fixture.projections.set('cordis', blueprint('c1', 'cordis', '创造模式'))
    await fixture.controller.activateSession('source-cordis', 'cordis')
    await fixture.controller.selectPreset('cordis')
    fixture.remote.get.mockClear()

    const restored = await fixture.controller.restoreTerminalCapabilityAuthoring('source-cordis', {
      routeId: 'failed-route', sourceSessionId: 'source-cordis', baseRevision: 'r1',
      targetPresetId: 'competitive-research', request: '创建 CSV Skill', kind: 'skill', startSeq: 40,
      baselineDelegationRowIds: [], state: 'ended', endSeq: 46, outcome: 'failed',
    }, 23)

    expect(restored).toBe(true)
    expect(fixture.remote.get).toHaveBeenCalledWith({ presetId: 'competitive-research' })
    expect(fixture.controller.store.getSnapshot()).toMatchObject({
      presetId: 'competitive-research', blueprint: { preset: { id: 'competitive-research' } },
      capabilityHandoff: { routeId: 'failed-route', status: 'failed' },
    })
  })

  it('does not reproject an old terminal after the same source explicitly selects another target', async () => {
    const fixture = bench()
    fixture.presets.push({ id: 'kaoyan-choose', trust: 'user', isDefault: false, name: '考研择校' })
    fixture.projections.set('kaoyan-choose', blueprint('k1', 'kaoyan-choose', '考研择校'))
    await fixture.controller.activateSession('source-cordis', 'cordis')
    const terminal = {
      routeId: 'route-a', sourceSessionId: 'source-cordis', targetPresetId: 'competitive-research',
      request: '创建 CSV Skill', kind: 'skill' as const, baseRevision: 'r1', startSeq: 40,
      baselineDelegationRowIds: [], state: 'ended' as const, endSeq: 46, outcome: 'completed' as const,
    }
    await fixture.controller.restoreTerminalCapabilityAuthoring('source-cordis', terminal, 23)
    await fixture.controller.selectPreset('kaoyan-choose')
    fixture.remote.get.mockClear()

    expect(await fixture.controller.restoreTerminalCapabilityAuthoring('source-cordis', terminal, 23)).toBe(true)

    expect(fixture.remote.get).not.toHaveBeenCalled()
    expect(fixture.controller.store.getSnapshot()).toMatchObject({
      presetId: 'kaoyan-choose', blueprint: { preset: { id: 'kaoyan-choose' } },
      capabilityHandoff: { routeId: 'route-a', terminal: { endSeq: 46 } },
    })
  })

  it('rejects late active and terminal recovery after a newer same-source route', async () => {
    const fixture = bench()
    fixture.presets.push({ id: 'kaoyan-choose', trust: 'user', isDefault: false, name: '考研择校' })
    fixture.projections.set('kaoyan-choose', blueprint('k1', 'kaoyan-choose', '考研择校'))
    await fixture.controller.activateSession('source-cordis', 'cordis')
    const old = {
      routeId: 'route-a', sourceSessionId: 'source-cordis', targetPresetId: 'competitive-research',
      request: '创建 CSV Skill', kind: 'skill' as const, baseRevision: 'r1', startSeq: 40,
      baselineDelegationRowIds: [],
    }
    await fixture.controller.restoreTerminalCapabilityAuthoring('source-cordis', {
      ...old, state: 'ended', endSeq: 46, outcome: 'completed',
    }, 23)
    await fixture.controller.restoreCapabilityAuthoring('source-cordis', {
      routeId: 'route-b', sourceSessionId: 'source-cordis', targetPresetId: 'kaoyan-choose',
      request: '创建研究 Subagent', kind: 'subagent', baseRevision: 'k1', startSeq: 50,
      baselineDelegationRowIds: [],
    }, null, 30)
    fixture.remote.get.mockClear()

    expect(await fixture.controller.restoreTerminalCapabilityAuthoring('source-cordis', {
      ...old, state: 'ended', endSeq: 46, outcome: 'completed',
    }, 23)).toBe(false)
    expect(await fixture.controller.restoreCapabilityAuthoring('source-cordis', old, null, 23)).toBe(false)

    expect(fixture.remote.get).not.toHaveBeenCalled()
    expect(fixture.controller.store.getSnapshot()).toMatchObject({
      presetId: 'kaoyan-choose', blueprint: { preset: { id: 'kaoyan-choose' } },
      capabilityHandoff: { routeId: 'route-b', status: 'authoring', startSeq: 50 },
    })
  })

  it('clears an unavailable stored target and safely falls back to the product default', async () => {
    let stored: string | null = 'deleted-agent'
    const clear = vi.fn(() => { stored = null })
    const preference: BlueprintTargetPreference = {
      read: () => stored,
      write: (presetId) => { stored = presetId },
      clear,
    }
    const { controller } = bench(undefined, undefined, preference)

    await controller.load()

    expect(clear).toHaveBeenCalledTimes(1)
    expect(stored).toBeNull()
    expect(controller.store.getSnapshot()).toMatchObject({
      phase: 'ready', presetId: 'competitive-research', blueprint: { preset: { id: 'competitive-research' } },
    })
  })

  it('clears a roster target whose real Blueprint cannot be projected', async () => {
    let stored: string | null = 'broken-agent'
    const clear = vi.fn(() => { stored = null })
    const preference: BlueprintTargetPreference = {
      read: () => stored,
      write: (presetId) => { stored = presetId },
      clear,
    }
    const fixture = bench(undefined, undefined, preference)
    fixture.presets.push({ id: 'broken-agent', trust: 'user', isDefault: false, name: '损坏 Agent' })

    await fixture.controller.load()

    expect(fixture.remote.get).toHaveBeenNthCalledWith(1, { presetId: 'broken-agent' })
    expect(fixture.remote.get).toHaveBeenNthCalledWith(2, { presetId: 'competitive-research' })
    expect(clear).toHaveBeenCalledTimes(1)
    expect(fixture.controller.store.getSnapshot()).toMatchObject({
      phase: 'ready', presetId: 'competitive-research', error: null,
    })
  })

  it('submits a route-owned Purpose edit while the committed Blueprint stays unchanged until Proposal Apply', async () => {
    const { controller, remote, sync } = bench()
    await controller.activateSession('purpose-source', 'competitive-research')
    remote.get.mockClear()
    sync.mockClear()

    await controller.updateText('purpose:persona', '比较指定市场中的竞品。', '比较竞品。')

    expect(controller.store.getSnapshot()).toMatchObject({
      blueprint: { revision: 'r1' },
      selectedNodeId: 'purpose:persona',
      error: null,
    })
    expect(remote.get).not.toHaveBeenCalled()
    const purposePublication = sync.mock.calls.at(-1)
    expect(purposePublication?.[0]).toMatchObject({ revision: 'r1' })
    expect(purposePublication?.[0]?.nodes).toContainEqual(expect.objectContaining({
      id: 'purpose:persona', value: '比较竞品。',
    }))
    expect(purposePublication?.slice(1, 4)).toEqual(['purpose:persona', undefined, undefined])
    expect(purposePublication?.[4]).toMatchObject({
      sourceSessionId: 'purpose-source',
      nodeId: 'purpose:persona',
      nodeType: 'purpose',
      expectedValue: '比较竞品。',
      proposedValue: '比较指定市场中的竞品。',
    })
    expect(typeof purposePublication?.[4]?.routeId).toBe('string')
  })

  it('stages Identity through the same route-owned Proposal path without a direct write', async () => {
    const { controller, sync } = bench()
    await controller.activateSession('session-1', 'competitive-research')
    sync.mockClear()

    await controller.updateText('identity:persona', '保研申请顾问', '竞品研究分析师')

    expect(controller.store.getSnapshot().blueprint?.revision).toBe('r1')
    const identityPublication = sync.mock.calls.at(-1)
    expect(identityPublication?.[0]).toMatchObject({ revision: 'r1' })
    expect(identityPublication?.slice(1, 4)).toEqual(['identity:persona', undefined, undefined])
    expect(identityPublication?.[4]).toMatchObject({
      sourceSessionId: 'session-1', nodeId: 'identity:persona',
      nodeType: 'identity', expectedValue: '竞品研究分析师', proposedValue: '保研申请顾问',
    })
    expect(typeof identityPublication?.[4]?.routeId).toBe('string')
  })

  it('stages only editable Web capability changes without a direct write', async () => {
    const { controller, sync } = bench()
    await controller.activateSession('session-1', 'competitive-research')
    sync.mockClear()

    await controller.setCapability('capability:web-search', false)
    await controller.setCapability('capability:file-read', false)

    expect(controller.store.getSnapshot().blueprint?.revision).toBe('r1')
    const capabilityPublication = sync.mock.calls.at(-1)
    expect(capabilityPublication?.[0]).toMatchObject({ revision: 'r1' })
    expect(capabilityPublication?.slice(1, 4)).toEqual(['capability:web-search', undefined, undefined])
    expect(capabilityPublication?.[4]).toMatchObject({
      sourceSessionId: 'session-1', nodeId: 'capability:web-search',
      nodeType: 'capability', expectedValue: true, proposedValue: false,
    })
    expect(typeof capabilityPublication?.[4]?.routeId).toBe('string')
  })

  it('queues one plain-language capability goal without choosing an implementation or writing the preset', async () => {
    const { controller, remote, sync, capabilityConversation } = bench()
    await controller.activateSession('capability-session', 'competitive-research')
    sync.mockClear()

    await controller.beginCapabilityHandoff('我希望它能分析上市公司财报')

    expect(controller.store.getSnapshot()).toMatchObject({
      selectedNodeId: null,
      capabilityHandoff: {
        request: '我希望它能分析上市公司财报',
        label: '分析上市公司财报',
        sourceSessionId: 'capability-session', targetPresetId: 'competitive-research',
        revision: 'r1', status: 'configuring', sourceStartSeq: 20,
      },
    })
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ revision: 'r1' }), null)
    const capabilityRequest = capabilityConversation.mock.calls.at(-1)?.[0]
    expect(capabilityRequest).toMatchObject({
      request: '我希望它能分析上市公司财报',
      label: '分析上市公司财报',
      sourceSessionId: 'capability-session', targetPresetId: 'competitive-research',
      revision: 'r1', status: 'configuring',
    })
    expect(typeof (capabilityRequest as { routeId?: unknown } | undefined)?.routeId).toBe('string')
    expect(remote.applyChangeSet).not.toHaveBeenCalled()
  })

  it('keeps an existing-Agent capability request on the Proposal lifecycle', async () => {
    const { controller, capabilityAuthoring } = bench()
    await controller.activateSession('capability-session', 'competitive-research')
    await controller.beginCapabilityHandoff('我希望它能分析上市公司财报')
    const handoff = controller.store.getSnapshot().capabilityHandoff!

    await controller.observeCapability({
      sessionId: 'capability-session', running: false, stopped: false,
      waitingFor: null,
      lastTurnEnd: { seq: 24, reason: 'completed' },
      proposals: [{
        seq: 23, presetId: 'competitive-research', routeId: handoff.routeId,
        sourceSessionId: 'capability-session',
      }], authoringRoutes: [],
    })

    expect(controller.store.getSnapshot().capabilityHandoff?.status).toBe('proposal')
    expect(capabilityAuthoring).not.toHaveBeenCalled()
    expect(controller.capabilityInputBlockedSessionIds()).toEqual([])
  })

  it('enters target-bound Creator authoring only after a typed authoring route', async () => {
    const { controller, capabilityAuthoring } = bench()
    await controller.activateSession('capability-session', 'competitive-research')
    await controller.beginCapabilityHandoff('创建一个专门解析私有格式的新 Skill')
    const handoff = controller.store.getSnapshot().capabilityHandoff!

    await controller.observeCapability({
      sessionId: 'capability-session', running: false, stopped: false, lastTurnEnd: { seq: 24, reason: 'completed' },
      waitingFor: null,
      proposals: [], authoringRoutes: [{
        seq: 23,
        route: {
          routeId: handoff.routeId, sourceSessionId: 'capability-session',
          presetId: 'competitive-research', revision: 'r1', kind: 'skill',
          request: '解析私有格式', reason: '当前没有可调用的解析定义。',
        },
      }],
    })

    expect(capabilityAuthoring).toHaveBeenCalledWith(expect.objectContaining({
      presetId: 'competitive-research', kind: 'skill',
    }))
    expect(controller.store.getSnapshot().capabilityHandoff).toMatchObject({
      status: 'authoring', creatorSessionId: 'creator-session', startSeq: 40,
    })

    await controller.load()
    expect(controller.store.getSnapshot().capabilityHandoff).toMatchObject({
      status: 'authoring', creatorSessionId: 'creator-session', startSeq: 40,
    })
  })

  it.each(['skill', 'subagent'] as const)(
    'keeps routing settlement separate from source-owned %s authoring settlement',
    async (kind) => {
      const { controller, capabilityAuthoring } = bench()
      capabilityAuthoring.mockResolvedValueOnce({ startSeq: 40, baselineDelegationRowIds: [] })
      await controller.activateSession('source-cordis', 'cordis')
      await controller.beginCapabilityHandoff(kind === 'skill'
        ? '创建一个专门解析私有格式的新 Skill'
        : '创建一个行业研究 Subagent')
      const handoff = controller.store.getSnapshot().capabilityHandoff!
      const authoringRoutes = [{
        seq: 23,
        route: {
          routeId: handoff.routeId, sourceSessionId: 'source-cordis',
          presetId: 'competitive-research', revision: 'r1', kind,
          request: '解析私有格式', reason: '当前没有可调用的解析定义。',
        },
      }]

      await controller.observeCapability({
        sessionId: 'source-cordis', running: true, stopped: false,
        lastTurnEnd: { seq: 22, reason: 'completed' }, waitingFor: null,
        proposals: [], authoringRoutes,
      })
      expect(capabilityAuthoring).not.toHaveBeenCalled()
      expect(controller.store.getSnapshot().capabilityHandoff?.status).toBe('configuring')

      await controller.observeCapability({
        sessionId: 'source-cordis', running: false, stopped: false,
        lastTurnEnd: { seq: 23, reason: 'completed' }, waitingFor: null,
        proposals: [], authoringRoutes,
      })
      expect(capabilityAuthoring).not.toHaveBeenCalled()

      await controller.observeCapability({
        sessionId: 'source-cordis', running: false, stopped: false,
        lastTurnEnd: { seq: 24, reason: 'completed' }, waitingFor: null,
        proposals: [], authoringRoutes,
      })
      expect(capabilityAuthoring).toHaveBeenCalledTimes(1)
      expect(controller.store.getSnapshot().capabilityHandoff).toMatchObject({
        sourceSessionId: 'source-cordis', status: 'authoring', startSeq: 40,
      })
      expect(controller.store.getSnapshot().capabilityHandoff).not.toHaveProperty('creatorSessionId')
      expect(controller.capabilityAuthoringSessionIds()).toEqual(['source-cordis'])
      expect(controller.capabilityInputBlockedSessionIds()).toEqual(['source-cordis'])
    },
  )

  it('reconstructs a settled durable route after refresh before lifecycle adoption exactly once', async () => {
    const { controller, capabilityAuthoring } = bench()
    capabilityAuthoring.mockResolvedValueOnce({ startSeq: 40, baselineDelegationRowIds: [] })
    await controller.activateSession('source-cordis', 'cordis')
    const observation: BlueprintCapabilityObservation = {
      sessionId: 'source-cordis', running: false, stopped: false,
      lastTurnEnd: { seq: 24, reason: 'completed' }, waitingFor: null,
      proposals: [], authoringRoutes: [{
        seq: 23,
        route: {
          routeId: 'durable-route', sourceSessionId: 'source-cordis',
          presetId: 'competitive-research', revision: 'r1', kind: 'skill',
          request: '创建 CSV Skill', reason: '当前没有可调用的 CSV 定义。',
        },
      }],
    }

    await controller.observeCapability(observation)

    expect(capabilityAuthoring).toHaveBeenCalledTimes(1)
    expect(controller.store.getSnapshot().capabilityHandoff).toMatchObject({
      sourceSessionId: 'source-cordis', routeId: 'durable-route', sourceRouteSeq: 23,
      status: 'authoring', startSeq: 40,
    })
    expect(controller.store.getSnapshot().capabilityHandoff).not.toHaveProperty('creatorSessionId')

    await controller.observeCapability(observation)
    expect(capabilityAuthoring).toHaveBeenCalledTimes(1)
  })

  it('carries a configuring Cancel through deferred same-source lifecycle adoption exactly once', async () => {
    const started = deferred<{ startSeq: number; baselineDelegationRowIds: readonly string[] }>()
    const { controller, remote, capabilityAuthoring, cancelCapabilityAuthoring } = bench()
    capabilityAuthoring.mockImplementationOnce(() => started.promise)
    await controller.activateSession('source-cordis', 'cordis')
    await controller.beginCapabilityHandoff('创建 CSV Skill')
    const routing = controller.store.getSnapshot().capabilityHandoff
    if (routing === null) throw new Error('Expected configuring capability handoff')
    controller.clearCapabilityHandoff()
    expect(controller.store.getSnapshot().capabilityHandoff).toMatchObject({
      routeId: routing.routeId, status: 'configuring',
    })
    expect(controller.capabilityInputBlockedSessionIds()).toEqual(['source-cordis'])
    remote.setConversationContext.mockClear()
    const observation: BlueprintCapabilityObservation = {
      sessionId: 'source-cordis', running: false, stopped: false,
      lastTurnEnd: { seq: 24, reason: 'completed' }, waitingFor: null,
      proposals: [], authoringRoutes: [{
        seq: 23,
        route: {
          routeId: routing.routeId, sourceSessionId: 'source-cordis',
          presetId: routing.targetPresetId, revision: routing.revision, kind: 'skill',
          request: routing.request, reason: '当前没有可调用的 CSV 定义。',
        },
      }],
    }
    const adoption = controller.observeCapability(observation)
    await vi.waitFor(() => { expect(capabilityAuthoring).toHaveBeenCalledTimes(1) })
    controller.clearCapabilityHandoff()
    await controller.observeCapability(observation)
    expect(capabilityAuthoring).toHaveBeenCalledTimes(1)

    started.resolve({ startSeq: 40, baselineDelegationRowIds: [] })
    await adoption
    await vi.waitFor(() => {
      expect(remote.setConversationContext).toHaveBeenCalledWith({
        sessionId: 'source-cordis', capabilityAuthoringEnd: { outcome: 'cancelled' },
      })
    })
    expect(cancelCapabilityAuthoring).not.toHaveBeenCalled()
    expect(controller.store.getSnapshot().capabilityHandoff).toMatchObject({
      routeId: routing.routeId, status: 'authoring', startSeq: 40,
    })
    expect(controller.capabilityInputBlockedSessionIds()).toEqual(['source-cordis'])

    await controller.restoreTerminalCapabilityAuthoring('source-cordis', {
      routeId: routing.routeId, sourceSessionId: 'source-cordis', targetPresetId: routing.targetPresetId,
      request: routing.request, kind: 'skill', baseRevision: routing.revision, startSeq: 40,
      baselineDelegationRowIds: [], state: 'ended', endSeq: 45, outcome: 'cancelled',
    }, 23)
    expect(controller.capabilityInputBlockedSessionIds()).toEqual([])
    expect(controller.store.getSnapshot().capabilityHandoff).toMatchObject({
      routeId: routing.routeId, status: 'cancelled', terminal: { endSeq: 45 },
    })
  })

  it('does not resurrect a durable route whose lifecycle already has a terminal', async () => {
    const { controller, capabilityAuthoring } = bench()
    await controller.activateSession('source-cordis', 'cordis')
    await controller.restoreTerminalCapabilityAuthoring('source-cordis', {
      routeId: 'settled-route', sourceSessionId: 'source-cordis', targetPresetId: 'competitive-research',
      request: '创建 CSV Skill', kind: 'skill', baseRevision: 'r1', startSeq: 40,
      baselineDelegationRowIds: [], state: 'ended', endSeq: 46, outcome: 'completed',
    }, 23)

    await controller.observeCapability({
      sessionId: 'source-cordis', running: false, stopped: false,
      lastTurnEnd: { seq: 24, reason: 'completed' }, waitingFor: null,
      proposals: [], authoringRoutes: [{
        seq: 23,
        route: {
          routeId: 'settled-route', sourceSessionId: 'source-cordis',
          presetId: 'competitive-research', revision: 'r1', kind: 'skill',
          request: '创建 CSV Skill', reason: '当前没有可调用的 CSV 定义。',
        },
      }],
    })

    expect(capabilityAuthoring).not.toHaveBeenCalled()
    expect(controller.store.getSnapshot().capabilityHandoff).toMatchObject({
      routeId: 'settled-route', status: 'completed', terminal: { endSeq: 46 },
    })
  })

  it('cancels a source-owned lifecycle without stopping its whole Session', async () => {
    const { controller, remote, cancelCapabilityAuthoring } = bench()
    await controller.activateSession('source-cordis', 'cordis')
    await controller.restoreCapabilityAuthoring('source-cordis', {
      routeId: 'route-source', sourceSessionId: 'source-cordis', targetPresetId: 'competitive-research',
      request: '添加 CSV Skill', kind: 'skill', baseRevision: 'r1', startSeq: 40,
      baselineDelegationRowIds: [],
    }, null, 23)
    remote.setConversationContext.mockClear()

    controller.clearCapabilityHandoff()

    await vi.waitFor(() => {
      expect(remote.setConversationContext).toHaveBeenCalledWith({
        sessionId: 'source-cordis', capabilityAuthoringEnd: { outcome: 'cancelled' },
      })
    })
    expect(cancelCapabilityAuthoring).not.toHaveBeenCalled()
    expect(controller.capabilityInputBlockedSessionIds()).toEqual(['source-cordis'])

    await controller.restoreTerminalCapabilityAuthoring('source-cordis', {
      routeId: 'route-source', sourceSessionId: 'source-cordis', targetPresetId: 'competitive-research',
      request: '添加 CSV Skill', kind: 'skill', baseRevision: 'r1', startSeq: 40,
      baselineDelegationRowIds: [], state: 'ended', endSeq: 45, outcome: 'cancelled',
    }, 23)
    expect(controller.store.getSnapshot().capabilityHandoff).toMatchObject({
      sourceSessionId: 'source-cordis', status: 'cancelled', terminal: { endSeq: 45 },
    })
    expect(controller.store.getSnapshot().capabilityHandoff).not.toHaveProperty('creatorSessionId')
    expect(controller.capabilityAuthoringSessionIds()).toEqual([])
    expect(controller.capabilityInputBlockedSessionIds()).toEqual([])
  })

  it('retains source-owned authoring across Session switches and fences a consecutive route', async () => {
    const { controller } = bench()
    await controller.activateSession('source-a', 'cordis')
    await controller.restoreCapabilityAuthoring('source-a', {
      routeId: 'route-a', sourceSessionId: 'source-a', targetPresetId: 'competitive-research',
      request: '创建 CSV Skill', kind: 'skill', baseRevision: 'r1', startSeq: 40,
      baselineDelegationRowIds: [],
    }, null, 23)

    await controller.activateSession('source-b', 'cordis')
    expect(controller.store.getSnapshot().capabilityHandoff).toBeNull()
    expect(controller.capabilityInputBlockedSessionIds()).toEqual(['source-a'])
    await controller.activateSession('source-a', 'cordis')
    expect(controller.store.getSnapshot().capabilityHandoff).toMatchObject({
      sourceSessionId: 'source-a', routeId: 'route-a', status: 'authoring', startSeq: 40,
    })

    await controller.restoreTerminalCapabilityAuthoring('source-a', {
      routeId: 'route-a', sourceSessionId: 'source-a', targetPresetId: 'competitive-research',
      request: '创建 CSV Skill', kind: 'skill', baseRevision: 'r1', startSeq: 40,
      baselineDelegationRowIds: [], state: 'ended', endSeq: 46, outcome: 'completed',
    }, 23)
    const firstRouteId = controller.store.getSnapshot().capabilityHandoff!.routeId
    await controller.beginCapabilityHandoff('创建第二个 CSV 校验 Skill')
    expect(controller.store.getSnapshot().capabilityHandoff).toMatchObject({
      sourceSessionId: 'source-a', status: 'configuring', sourceStartSeq: 20,
    })
    expect(controller.store.getSnapshot().capabilityHandoff?.routeId).not.toBe(firstRouteId)
    expect(controller.capabilityInputBlockedSessionIds()).toEqual(['source-a'])
  })

  it('notifies lifecycle subscribers when a background source-owned task settles', async () => {
    const { controller } = bench()
    await controller.activateSession('source-b', 'cordis')
    const changed = vi.fn()
    const stop = controller.store.subscribe(changed)

    await controller.restoreCapabilityAuthoring('source-a', {
      routeId: 'route-a', sourceSessionId: 'source-a', targetPresetId: 'competitive-research',
      request: '创建 CSV Skill', kind: 'skill', baseRevision: 'r1', startSeq: 40,
      baselineDelegationRowIds: [],
    }, null, 23)
    expect(controller.store.getSnapshot().capabilityHandoff).toBeNull()
    expect(controller.capabilityInputBlockedSessionIds()).toEqual(['source-a'])
    expect(changed).toHaveBeenCalledTimes(1)

    await controller.restoreTerminalCapabilityAuthoring('source-a', {
      routeId: 'route-a', sourceSessionId: 'source-a', targetPresetId: 'competitive-research',
      request: '创建 CSV Skill', kind: 'skill', baseRevision: 'r1', startSeq: 40,
      baselineDelegationRowIds: [], state: 'ended', endSeq: 46, outcome: 'failed',
    }, 23)
    expect(controller.capabilityInputBlockedSessionIds()).toEqual([])
    expect(changed).toHaveBeenCalledTimes(2)
    stop()
  })

  it('keeps independent background authoring progress with each source Session owner', async () => {
    const { controller } = bench()
    await controller.activateSession('source-a', 'competitive-research')
    await controller.restoreCapabilityAuthoring('creator-a', {
      routeId: 'route-a', sourceSessionId: 'source-a', targetPresetId: 'competitive-research',
      request: '创建 CSV Skill', kind: 'skill', baseRevision: 'r1', startSeq: 40, baselineDelegationRowIds: [],
    }, 'approval')
    expect(controller.store.getSnapshot().capabilityHandoff).toMatchObject({
      sourceSessionId: 'source-a', routeId: 'route-a', creatorSessionId: 'creator-a',
      status: 'authoring', waitingFor: 'approval',
    })

    await controller.activateSession('source-b', 'competitive-research')
    expect(controller.store.getSnapshot().capabilityHandoff).toBeNull()
    await controller.restoreCapabilityAuthoring('creator-b', {
      routeId: 'route-b', sourceSessionId: 'source-b', targetPresetId: 'competitive-research',
      request: '创建行业研究 Subagent', kind: 'subagent', baseRevision: 'r1', startSeq: 50, baselineDelegationRowIds: [],
    }, 'question')
    expect(controller.store.getSnapshot().capabilityHandoff).toMatchObject({
      sourceSessionId: 'source-b', routeId: 'route-b', creatorSessionId: 'creator-b',
      status: 'authoring', waitingFor: 'input',
    })

    await controller.activateSession('source-a', 'competitive-research')
    expect(controller.store.getSnapshot().capabilityHandoff).toMatchObject({
      sourceSessionId: 'source-a', routeId: 'route-a', creatorSessionId: 'creator-a',
      status: 'authoring', waitingFor: 'approval',
    })
    expect(new Set(controller.capabilityAuthoringSessionIds())).toEqual(new Set(['creator-a', 'creator-b']))
  })

  it('retains durable terminal projection through reprojection and replaces it only with a new route', async () => {
    const fixture = bench()
    await fixture.controller.activateSession('capability-session', 'competitive-research')
    await fixture.controller.restoreTerminalCapabilityAuthoring('creator-session', {
      ...CAPABILITY_OWNER,
      targetPresetId: 'competitive-research', request: '创建 CSV Skill', kind: 'skill', startSeq: 40,
      baselineDelegationRowIds: [], state: 'ended', endSeq: 46, outcome: 'completed',
    })
    const route1 = fixture.controller.store.getSnapshot().capabilityHandoff!.routeId
    expect(fixture.controller.store.getSnapshot().capabilityHandoff).toMatchObject({
      status: 'completed', terminal: { outcome: 'completed', endSeq: 46 },
    })
    await fixture.controller.load()
    fixture.controller.selectNode('purpose:persona')
    expect(fixture.controller.store.getSnapshot().capabilityHandoff?.routeId).toBe(route1)

    await fixture.controller.activateSession('source-b', 'competitive-research')
    expect(fixture.controller.store.getSnapshot().capabilityHandoff).toBeNull()
    await fixture.controller.activateSession('capability-session', 'competitive-research')
    expect(fixture.controller.store.getSnapshot().capabilityHandoff?.status).toBe('completed')

    await fixture.controller.beginCapabilityHandoff('创建第二个 CSV 校验 Skill')
    const route2 = fixture.controller.store.getSnapshot().capabilityHandoff!
    expect(route2).toMatchObject({ sourceSessionId: 'capability-session', status: 'configuring' })
    expect(route2.routeId).not.toBe(route1)
  })

  it.each(['completed', 'failed', 'cancelled'] as const)(
    'reconstructs only the owning source terminal from durable %s evidence',
    async (outcome) => {
      const fixture = bench()
      await fixture.controller.activateSession('source-b', 'competitive-research')
      await fixture.controller.restoreTerminalCapabilityAuthoring('creator-a', {
        routeId: 'route-a', sourceSessionId: 'source-a', targetPresetId: 'competitive-research',
        request: '创建 CSV Skill', kind: 'skill', baseRevision: 'r1', startSeq: 40, baselineDelegationRowIds: [],
        state: 'ended', endSeq: 46, outcome,
      })
      expect(fixture.controller.store.getSnapshot().capabilityHandoff).toBeNull()
      await fixture.controller.activateSession('source-a', 'competitive-research')
      expect(fixture.controller.store.getSnapshot().capabilityHandoff).toMatchObject({
        sourceSessionId: 'source-a', routeId: 'route-a', status: outcome,
        terminal: { outcome, endSeq: 46 },
      })
    },
  )

  it.each(['failed', 'cancelled'] as const)(
    'retains the committed Blueprint during cold %s terminal recovery without reading the candidate',
    async (outcome) => {
      const { controller, projections, remote } = bench()
      await controller.activateSession('capability-session', 'competitive-research')
      const committed = controller.store.getSnapshot().blueprint
      projections.set('competitive-research', unverifiedSkillBlueprint())
      remote.get.mockClear()

      const restored = await controller.restoreTerminalCapabilityAuthoring('creator-session', {
        ...CAPABILITY_OWNER,
        targetPresetId: 'competitive-research', request: '创建 CSV Skill', kind: 'skill', startSeq: 40,
        baselineDelegationRowIds: [], state: 'ended', endSeq: 46, outcome,
      })

      expect(restored).toBe(true)
      expect(remote.get).not.toHaveBeenCalled()
      expect(controller.store.getSnapshot().blueprint).toBe(committed)
      expect(controller.store.getSnapshot().capabilityHandoff).toMatchObject({
        status: outcome, terminal: { outcome, endSeq: 46 },
      })
    },
  )

  it('publishes Host-verified Subagent completion with an unopened Creator timeline exactly once', async () => {
    const { controller, capabilityAuthoring, projections, trial, remote } = bench()
    await controller.activateSession('capability-session', 'competitive-research')
    await controller.beginCapabilityHandoff('添加一个行业研究协作者')
    const handoff = controller.store.getSnapshot().capabilityHandoff!
    await controller.observeCapability({
      sessionId: 'capability-session', running: false, stopped: false,
      lastTurnEnd: { seq: 24, reason: 'completed' }, waitingFor: null, proposals: [],
      authoringRoutes: [{
        seq: 23,
        route: {
          routeId: handoff.routeId, sourceSessionId: 'capability-session',
          presetId: 'competitive-research', revision: 'r1', kind: 'subagent',
          request: '添加行业研究协作者', reason: '需要真实 delegation composition row。',
        },
      }],
    })
    expect(capabilityAuthoring).toHaveBeenCalledTimes(1)

    const mounted = blueprint('r2')
    mounted.nodes.push({
      id: 'capability:delegation:industry-research', type: 'capability', source: 'preset',
      status: 'active', editable: false, adapterRef: null,
      value: {
        kind: 'delegation', name: 'Industry Research', tool: 'industry_research', provider: 'spawn',
        mode: 'one-shot', providerAvailable: true, enabled: true,
        responsibility: '你是行业研究协作者。负责行业规模和竞争格局。',
      },
    })
    mounted.runtime.delegations.push({
      rowId: 'industry-research', tool: 'industry_research', provider: 'spawn', mode: 'one-shot',
      providerAvailable: true, enabled: true,
      configDigest: '07acfc7eae11e42d866abb00309a56c24da11e0d76bb0ed4749cfbfeadd3a14e',
    })
    projections.set('competitive-research', mounted)
    const validation: BlueprintSessionValidation = {
      sessionId: 'subagent-conformance', presetId: 'competitive-research', valid: true, overall: 'pass',
      binding: {
        status: 'pass', sessionPresetId: 'competitive-research', composedPresetId: 'competitive-research',
        expectedRevision: 'r2', projectedRevision: 'r2', strictRevisionBound: false,
      },
      prompt: { status: 'pass', evidence: [] },
      tools: { status: 'pass', evidence: [], missing: [], unexpected: [], schemaMismatches: [] },
      skills: { status: 'pass', evidence: [], missing: [], unexpected: [] },
      delegations: {
        status: 'pass', evidence: [{
          nodeId: 'capability:delegation:industry-research', rowId: 'industry-research',
          tool: 'industry_research', provider: 'spawn', providerAvailable: true, status: 'pass',
        }],
      },
      permissions: { status: 'pass' },
    }
    remote.setConversationContext.mockResolvedValue(ok({
      sessionId: 'creator-session', active: false,
      capabilityAuthoringRecord: {
        routeId: handoff.routeId, sourceSessionId: 'capability-session',
        targetPresetId: 'competitive-research', request: '添加行业研究协作者', kind: 'subagent', baseRevision: 'r1',
        startSeq: 40, baselineDelegationRowIds: [], state: 'ended', endSeq: 46, outcome: 'completed',
        subagentEvidence: { turnEndSeq: 45, revision: 'r2', delegations: mounted.runtime.delegations, verification: validation },
      },
    }))
    remote.get.mockClear()
    const cold = {
      sessionId: 'creator-session', running: false, stopped: false, waitingFor: null,
      lastTurnEnd: null, proposals: [], authoringRoutes: [],
    }
    await Promise.all([controller.observeCapability(cold), controller.observeCapability(cold)])
    await controller.observeCapability(cold)
    expect(trial).not.toHaveBeenCalled()
    expect(remote.get).toHaveBeenCalledTimes(1)
    expect(remote.setConversationContext).toHaveBeenCalledWith({
      sessionId: 'creator-session', recoverCapabilityAuthoring: true,
    })
    expect(controller.store.getSnapshot()).toMatchObject({
      blueprint: { revision: 'r2' },
      capabilityHandoff: { status: 'completed', creatorSessionId: 'creator-session' },
      validation: { valid: true },
    })
  })

  it('projects exhausted Subagent repair as a safe same-request retry terminal', async () => {
    const { controller, trial, remote, capabilityConversation } = bench()
    await controller.activateSession('capability-session', 'competitive-research')
    await controller.beginCapabilityHandoff('添加一个行业研究协作者')
    const handoff = controller.store.getSnapshot().capabilityHandoff!
    await controller.observeCapability({
      sessionId: 'capability-session', running: false, stopped: false,
      lastTurnEnd: { seq: 24, reason: 'completed' }, waitingFor: null, proposals: [],
      authoringRoutes: [{
        seq: 23,
        route: {
          routeId: handoff.routeId, sourceSessionId: 'capability-session',
          presetId: 'competitive-research', revision: 'r1', kind: 'subagent',
          request: '添加行业研究协作者', reason: '需要真实 delegation composition row。',
        },
      }],
    })

    remote.setConversationContext.mockResolvedValue(ok({
      sessionId: 'creator-session', active: false,
      capabilityAuthoringRecord: {
        routeId: handoff.routeId, sourceSessionId: 'capability-session',
        targetPresetId: 'competitive-research', request: '添加行业研究协作者', kind: 'subagent', baseRevision: 'r1',
        startSeq: 40, baselineDelegationRowIds: [], state: 'ended', endSeq: 46, outcome: 'failed',
        capabilityFailure: {
          turnEndSeq: 45, attempt: 2, prerequisite: 'fresh_mount',
          message: 'mount verification failed: tool-subagent delegation delta missing',
        },
      },
    }))
    await controller.observeCapability({
      sessionId: 'creator-session', running: false, stopped: false, waitingFor: null,
      lastTurnEnd: { seq: 45, reason: 'completed' }, proposals: [], authoringRoutes: [],
    })

    expect(trial).not.toHaveBeenCalled()
    expect(remote.setConversationContext).toHaveBeenCalledWith({
      sessionId: 'creator-session', recoverCapabilityAuthoring: true,
    })
    const failedHandoff = controller.store.getSnapshot().capabilityHandoff
    expect(failedHandoff).toMatchObject({ status: 'failed', terminal: { outcome: 'failed' } })
    expect(failedHandoff?.terminal?.message).toBeUndefined()
    expect(controller.store.getSnapshot().error).toBeNull()

    const failedRouteId = failedHandoff?.routeId
    capabilityConversation.mockClear()
    await controller.beginCapabilityHandoff(failedHandoff?.request ?? '')
    expect(controller.store.getSnapshot().capabilityHandoff).toMatchObject({
      status: 'configuring', request: '添加行业研究协作者', sourceSessionId: 'capability-session',
      targetPresetId: 'competitive-research', revision: 'r1', sourceStartSeq: 20,
    })
    expect(controller.store.getSnapshot().capabilityHandoff?.routeId).not.toBe(failedRouteId)
    expect(capabilityConversation).toHaveBeenCalledTimes(1)
  })

  it.each(['skill', 'subagent'] as const)(
    'retains active %s recovery without publishing an unverified capability',
    async (kind) => {
      const { controller, remote, projections } = bench()
      await controller.activateSession('capability-session', 'competitive-research')
      await controller.restoreCapabilityAuthoring('creator-session', {
        ...CAPABILITY_OWNER,
        targetPresetId: 'competitive-research', request: '新增能力', kind, startSeq: 40,
        baselineDelegationRowIds: [],
      }, null)
      const before = controller.store.getSnapshot().blueprint
      projections.set('competitive-research', unverifiedSkillBlueprint())
      remote.get.mockClear()
      remote.setConversationContext.mockResolvedValue(ok({
        sessionId: 'creator-session', active: true,
        capabilityAuthoringRecord: {
          ...CAPABILITY_OWNER,
          targetPresetId: 'competitive-research', request: '新增能力', kind, startSeq: 40,
          baselineDelegationRowIds: [], state: 'active',
        },
      }))
      await controller.observeCapability({
        sessionId: 'creator-session', running: false, stopped: false, waitingFor: null,
        lastTurnEnd: null, proposals: [], authoringRoutes: [],
      })
      expect(controller.store.getSnapshot().capabilityHandoff?.status).toBe('authoring')
      expect(controller.store.getSnapshot().blueprint).toBe(before)
      expect(remote.get).not.toHaveBeenCalled()
    },
  )

  it.each(['skill', 'subagent'] as const)('restores target-bound %s authoring and its native wait state after remount', async (kind) => {
    const { controller, remote } = bench()
    await controller.activateSession('capability-session', 'competitive-research')
    const approvalWait = {
      kind: 'approval', key: 'approval-child', sessionId: 'creator-session',
      payload: { approvalId: 'approval-1', toolName: 'preset_write' }, respond: vi.fn(),
    } as unknown as NonNullable<BlueprintCapabilityObservation['pendingInteraction']>

    await controller.restoreCapabilityAuthoring('creator-session', {
      ...CAPABILITY_OWNER,
      targetPresetId: 'competitive-research',
      request: '创建 CSV 财报指标提取 Skill',
      kind,
      startSeq: 40,
      baselineDelegationRowIds: [],
    }, 'approval', undefined, approvalWait)

    expect(controller.store.getSnapshot()).toMatchObject({
      presetId: 'competitive-research',
      capabilityHandoff: {
        status: 'authoring',
        authoringKind: kind,
        waitingFor: 'approval',
        creatorSessionId: 'creator-session',
        startSeq: 40,
        pendingInteraction: approvalWait,
      },
    })

    remote.setConversationContext.mockResolvedValueOnce(ok({
      sessionId: 'creator-session', active: true,
      capabilityAuthoringRecord: {
        ...CAPABILITY_OWNER,
        targetPresetId: 'competitive-research', request: '新增能力', kind,
        baselineDelegationRowIds: [], startSeq: 40, state: 'active',
      },
    }))
    const questionWait = {
      kind: 'question', key: 'question-child', sessionId: 'creator-session',
      payload: { questions: [{ id: 'scope', question: '补充范围' }] }, respond: vi.fn(),
    } as unknown as NonNullable<BlueprintCapabilityObservation['pendingInteraction']>
    await controller.observeCapability({
      sessionId: 'creator-session', running: false, stopped: false, waitingFor: 'question',
      pendingInteraction: questionWait, lastTurnEnd: null, proposals: [], authoringRoutes: [],
    })
    expect(controller.store.getSnapshot().capabilityHandoff?.waitingFor).toBe('input')
    expect(controller.store.getSnapshot().capabilityHandoff?.pendingInteraction).toBe(questionWait)

    remote.setConversationContext.mockResolvedValueOnce(ok({
      sessionId: 'creator-session', active: false,
      capabilityAuthoringRecord: {
        ...CAPABILITY_OWNER,
        targetPresetId: 'competitive-research', request: '创建 CSV 财报指标提取 Skill', kind,
        baselineDelegationRowIds: [], startSeq: 40, state: 'ended', endSeq: 46, outcome: 'completed',
      },
    }))
    await controller.observeCapability({
      sessionId: 'creator-session', running: false, stopped: false, waitingFor: null,
      lastTurnEnd: { seq: 45, reason: 'completed' }, proposals: [], authoringRoutes: [],
    })
    expect(controller.store.getSnapshot().capabilityHandoff).toMatchObject({
      status: 'completed', sourceSessionId: 'capability-session', creatorSessionId: 'creator-session',
    })
    expect(remote.setConversationContext).toHaveBeenCalledWith({
      sessionId: 'creator-session', recoverCapabilityAuthoring: true,
    })
  })

  it.each(['completed', 'failed', 'cancelled'] as const)('settles a cold background Skill window from Host %s evidence exactly once', async (outcome) => {
    const { controller, remote, projections } = bench()
    await controller.activateSession('capability-session', 'competitive-research')
    await controller.restoreCapabilityAuthoring('creator-session', {
      ...CAPABILITY_OWNER,
      targetPresetId: 'competitive-research', request: '创建 CSV Skill', kind: 'skill', startSeq: 40,
      baselineDelegationRowIds: [],
    }, null)
    const committed = controller.store.getSnapshot().blueprint
    projections.set('competitive-research', unverifiedSkillBlueprint())
    remote.get.mockClear()
    remote.setConversationContext.mockResolvedValue(ok({
      sessionId: 'creator-session', active: false,
      capabilityAuthoringRecord: {
        ...CAPABILITY_OWNER,
        targetPresetId: 'competitive-research', request: '创建 CSV Skill', kind: 'skill', startSeq: 40,
        baselineDelegationRowIds: [], state: 'ended', endSeq: 46, outcome,
      },
    }))
    const cold = {
      sessionId: 'creator-session', running: false, stopped: false, waitingFor: null,
      lastTurnEnd: null, proposals: [], authoringRoutes: [],
    }
    await Promise.all([controller.observeCapability(cold), controller.observeCapability(cold)])
    await controller.observeCapability(cold)
    expect(remote.setConversationContext).toHaveBeenCalledTimes(1)
    expect(remote.get).toHaveBeenCalledTimes(outcome === 'completed' ? 1 : 0)
    expect(controller.store.getSnapshot()).toMatchObject({
      presetId: 'competitive-research', phase: 'ready', capabilityHandoff: {
        status: outcome, terminal: { outcome, endSeq: 46 },
      },
    })
    if (outcome === 'completed') {
      expect(controller.store.getSnapshot().blueprint).toMatchObject({
        revision: 'r2', runtime: { skills: [{ name: 'csv-laptop-spec-comparison' }] },
      })
    } else {
      expect(controller.store.getSnapshot().blueprint).toBe(committed)
    }
    expect(controller.store.getSnapshot().error).toBeNull()
  })

  it('keeps an internal settlement miss inside active Skill authoring', async () => {
    const { controller, remote } = bench()
    await controller.activateSession('capability-session', 'competitive-research')
    await controller.restoreCapabilityAuthoring('creator-session', {
      ...CAPABILITY_OWNER,
      targetPresetId: 'competitive-research', request: '创建 CSV Skill', kind: 'skill', startSeq: 40,
      baselineDelegationRowIds: [],
    }, null)
    remote.setConversationContext.mockRejectedValue(new Error('checkpoint unavailable'))
    await controller.observeCapability({
      sessionId: 'creator-session', running: false, stopped: false, waitingFor: null,
      lastTurnEnd: { seq: 45, reason: 'completed' }, proposals: [], authoringRoutes: [],
    })
    expect(controller.store.getSnapshot().capabilityHandoff?.status).toBe('authoring')
    expect(controller.store.getSnapshot().error).toBeNull()
  })

  it('durably cancels and stops a background Creator capability turn', async () => {
    const stopped = deferred<undefined>()
    const cancelCapabilityAuthoring = vi.fn(() => stopped.promise)
    const { controller, remote } = bench(undefined, cancelCapabilityAuthoring)
    await controller.activateSession('capability-session', 'competitive-research')
    await controller.restoreCapabilityAuthoring('creator-session', {
      ...CAPABILITY_OWNER,
      targetPresetId: 'competitive-research',
      request: '添加测试合规协作者',
      kind: 'subagent',
      startSeq: 40,
      baselineDelegationRowIds: [],
    }, null)

    controller.clearCapabilityHandoff()

    await vi.waitFor(() => { expect(cancelCapabilityAuthoring).toHaveBeenCalledWith('creator-session') })
    expect(remote.setConversationContext).not.toHaveBeenCalled()
    stopped.resolve(undefined)
    await vi.waitFor(() => {
      expect(remote.setConversationContext).toHaveBeenCalledWith({
        sessionId: 'creator-session', capabilityAuthoringEnd: { outcome: 'cancelled' },
      })
    })
    expect(controller.store.getSnapshot().capabilityHandoff?.status).toBe('authoring')
  })

  it('keeps capability authoring active when stopping its Creator fails', async () => {
    const cancelCapabilityAuthoring = vi.fn(() => Promise.reject(new Error('Creator stop rejected')))
    const { controller, remote } = bench(undefined, cancelCapabilityAuthoring)
    await controller.activateSession('capability-session', 'competitive-research')
    await controller.restoreCapabilityAuthoring('creator-session', {
      ...CAPABILITY_OWNER,
      targetPresetId: 'competitive-research', request: '添加研究协作者', kind: 'subagent', startSeq: 40,
      baselineDelegationRowIds: [],
    }, null)

    controller.clearCapabilityHandoff()

    await vi.waitFor(() => { expect(controller.store.getSnapshot().error).toContain('Creator stop rejected') })
    expect(remote.setConversationContext).not.toHaveBeenCalled()
    expect(controller.store.getSnapshot().capabilityHandoff?.status).toBe('authoring')
  })

  it('restores a completed capability Session target without reopening configuration', async () => {
    const { controller, presets, projections } = bench()
    await controller.activateSession('capability-session', 'competitive-research')
    await controller.restoreCapabilityAuthoring('creator-session', {
      ...CAPABILITY_OWNER,
      targetPresetId: 'competitive-research', request: '创建 CSV Skill', kind: 'skill', startSeq: 40,
      baselineDelegationRowIds: [],
    }, 'approval')

    await controller.restoreTerminalCapabilityAuthoring('creator-session', {
      ...CAPABILITY_OWNER,
      targetPresetId: 'competitive-research', request: '创建 CSV Skill', kind: 'skill', startSeq: 40,
      baselineDelegationRowIds: [], state: 'ended', endSeq: 45, outcome: 'completed',
    })

    expect(controller.store.getSnapshot()).toMatchObject({
      presetId: 'competitive-research', phase: 'ready', creator: null,
      capabilityHandoff: { status: 'completed', creatorSessionId: 'creator-session' },
    })

    await controller.activateSession('creator-session', 'cordis')

    await observeCreator(controller, {
      sessionId: 'creator-session', presetId: 'cordis', running: false, waitingFor: null,
      lastTurnEnd: { seq: 45, reason: 'completed' }, authoredPresetIds: [],
      latestUserMessage: { seq: 4, text: '我要创建一个新 Agent' },
    })
    expect(controller.store.getSnapshot()).toMatchObject({
      presetId: 'competitive-research', creator: null, capabilityHandoff: null,
    })

    await observeCreator(controller, {
      sessionId: 'creator-session', presetId: 'cordis', running: true, waitingFor: null,
      lastTurnEnd: { seq: 45, reason: 'completed' }, authoredPresetIds: [],
      latestUserMessage: { seq: 50, text: '我要一个上市公司研究 Agent' },
    })
    expect(controller.store.getSnapshot()).toMatchObject({
      presetId: '', blueprint: null, creator: { name: '上市公司研究 Agent', status: 'creating' },
    })

    const source = blueprint('r-source', 'pe-analysis', '市盈率分析')
    presets.push({ id: 'pe-analysis', trust: 'user', isDefault: false, name: '市盈率分析' })
    projections.set('pe-analysis', source)
    const copied = {
      ...source,
      revision: 'r-copy',
      preset: { id: 'listed-company-research', trust: 'user' as const, name: '上市公司研究 Agent' },
    }
    presets.push({
      id: 'listed-company-research', trust: 'user', isDefault: false, name: '上市公司研究 Agent',
    })
    projections.set('listed-company-research', copied)
    await controller.observeCreator({
      sessionId: 'creator-session', presetId: 'cordis', running: true, waitingFor: null,
      lastTurnEnd: { seq: 45, reason: 'completed' },
      userMessages: [{ seq: 50, text: '我要一个上市公司研究 Agent' }],
      presetCopies: [{ seq: 60, sourcePresetId: 'pe-analysis', targetPresetId: 'listed-company-research' }],
      associationAnswers: [], authoredPresets: [{ seq: 60, presetId: 'listed-company-research' }],
      validatedPresets: [],
    })
    expect(controller.store.getSnapshot()).toMatchObject({
      presetId: 'listed-company-research', blueprint: null,
      creator: { targetPresetId: 'listed-company-research', status: 'creating' },
    })

    projections.set('listed-company-research', {
      ...copied,
      revision: 'r-customized',
      nodes: copied.nodes.map(node => node.id === 'purpose:persona'
        ? { ...node, value: '研究上市公司的基本面、行业竞争情况和估值水平。' }
        : node),
    })
    await controller.pollCreator()
    expect(controller.store.getSnapshot()).toMatchObject({
      presetId: 'listed-company-research', blueprint: { revision: 'r-customized' },
      creator: { targetPresetId: 'listed-company-research', status: 'creating' },
    })
  })

  it('clears configuration after a completed no-op', async () => {
    const { controller } = bench()
    await controller.activateSession('capability-session', 'competitive-research')
    await controller.beginCapabilityHandoff('补充一个无需配置的说明能力')
    await controller.observeCapability({
      sessionId: 'capability-session', running: false, stopped: false, lastTurnEnd: { seq: 21, reason: 'completed' },
      waitingFor: null,
      proposals: [], authoringRoutes: [],
    })
    expect(controller.store.getSnapshot().capabilityHandoff).toBeNull()
  })

  it('rejects a second Add while the same source route is still active', async () => {
    const { controller, capabilityConversation } = bench()
    await controller.activateSession('capability-session', 'competitive-research')
    await controller.beginCapabilityHandoff('创建 CSV Skill')
    const first = controller.store.getSnapshot().capabilityHandoff

    await controller.beginCapabilityHandoff('创建另一个行业研究 Subagent')

    expect(capabilityConversation).toHaveBeenCalledTimes(1)
    expect(controller.store.getSnapshot().capabilityHandoff).toEqual(first)
  })

  it('durably cancels an exact Proposal before deleting its capability authority', async () => {
    const { controller, cancelProposalDecision } = bench()
    await controller.activateSession('capability-session', 'competitive-research')
    await controller.beginCapabilityHandoff('我希望它能分析上市公司财报')
    const handoff = controller.store.getSnapshot().capabilityHandoff!
    await controller.observeCapability({
      sessionId: 'capability-session', running: false, stopped: false,
      lastTurnEnd: { seq: 24, reason: 'completed' }, waitingFor: null,
      proposals: [{
        seq: 23, presetId: 'competitive-research', sourceSessionId: 'capability-session',
        routeId: handoff.routeId,
      }], authoringRoutes: [],
    })
    const changeSet = singleChangeSet({
      proposalId: 'proposal-1', presetId: 'competitive-research', revision: 'r1',
      targetNodeId: 'purpose:persona', operation: 'updatePurpose',
      currentValue: '比较竞品。', proposedValue: '分析财报。', impact: '加入财报分析。',
    }, 'capability-session', handoff.routeId)

    await controller.cancelChangeSet(changeSet)

    expect(cancelProposalDecision).toHaveBeenCalledWith(changeSet)
    expect(controller.store.getSnapshot().capabilityHandoff).toBeNull()
    expect(controller.store.getSnapshot().proposalCancellations).toEqual([
      expect.objectContaining({
        sourceSessionId: 'capability-session', routeId: handoff.routeId,
        changeSetId: 'proposal-1', status: 'cancelled',
      }),
    ])
  })

  it('deletes exact capability authority after a durable failed Apply result', async () => {
    const { controller, remote } = bench()
    await controller.activateSession('capability-session', 'competitive-research')
    await controller.beginCapabilityHandoff('我希望它能分析上市公司财报')
    const handoff = controller.store.getSnapshot().capabilityHandoff!
    await controller.observeCapability({
      sessionId: 'capability-session', running: false, stopped: false,
      lastTurnEnd: { seq: 24, reason: 'completed' }, waitingFor: null,
      proposals: [{
        seq: 23, presetId: 'competitive-research', sourceSessionId: 'capability-session',
        routeId: handoff.routeId,
      }], authoringRoutes: [],
    })
    remote.applyChangeSet.mockResolvedValueOnce(ok<BlueprintApplyChangeSetResult>({
      sourceSessionId: 'capability-session', routeId: handoff.routeId,
      changeSetId: 'failed', baseRevision: 'r1', status: 'preflight_failed', operations: [],
      preflight: { ok: false, reason: 'stale' }, unexpectedDrift: [],
    }))
    await controller.applyChangeSet({
      changeSetId: 'failed', sourceSessionId: 'capability-session', routeId: handoff.routeId,
      kind: 'direct-request', presetId: 'competitive-research', revision: 'r1',
      proposals: [],
    })
    expect(controller.store.getSnapshot().capabilityHandoff).toBeNull()
  })

  it('routes Add for one disabled Web capability through capability authoring without a preset write', async () => {
    const { controller, remote, projections, capabilityConversation } = bench()
    const disabled = blueprint()
    disabled.nodes = disabled.nodes.map(node => node.id === 'capability:web-search'
      ? { ...node, value: { name: 'Web Search', tool: 'web_search', enabled: false } }
      : node)
    projections.set('competitive-research', disabled)
    await controller.activateSession('capability-session', 'competitive-research')

    await controller.addCapability('capability:web-search')

    expect(capabilityConversation).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionId: 'capability-session', targetPresetId: 'competitive-research',
      request: '添加网页搜索能力', status: 'configuring',
    }))
    expect(remote.applyChangeSet).not.toHaveBeenCalled()
    expect(controller.store.getSnapshot().blueprint?.nodes.find(node => node.id === 'capability:web-search')?.value)
      .toMatchObject({ enabled: false })
  })

  it('stores the validation returned after the new Session opens', async () => {
    const { controller, trial } = bench()
    await controller.load()

    await controller.startTrial()

    expect(trial).toHaveBeenCalledWith({ presetId: 'competitive-research', expectedRevision: 'r1' })
    expect(controller.store.getSnapshot().validation?.valid).toBe(true)
  })

  it('restores the exact current-Session Apply receipt into Try after a browser refresh', async () => {
    const { controller, trial } = bench()
    await controller.activateSession('source-session', 'competitive-research')
    controller.restoreApplyReceipts('source-session', [committedReceipt({
      sourceSessionId: 'source-session', routeId: 'route:restored',
      changeSetId: 'restored-change', committedRevision: 'r1',
    })])

    await controller.startTrial()

    expect(trial).toHaveBeenCalledWith({
      presetId: 'competitive-research', expectedRevision: 'r1',
      sourceSessionId: 'source-session', routeId: 'route:restored', changeSetId: 'restored-change',
    })
  })

  it('waits for the current Session receipt hydration before admitting Try', async () => {
    const { controller, sync, trial } = bench()
    const hydration = deferred<undefined>()
    const receipt = committedReceipt({
      sourceSessionId: 'source-session', routeId: 'route:hydrated',
      changeSetId: 'hydrated-change', committedRevision: 'r1', terminalSeq: 44,
    })
    sync.mockImplementationOnce(async () => {
      await hydration.promise
      controller.restoreApplyReceipts('source-session', [receipt])
    })
    const activation = controller.activateSession('source-session', 'competitive-research')
    await vi.waitFor(() => {
      expect(controller.store.getSnapshot()).toMatchObject({ phase: 'ready', applyReceiptsLoading: true })
    })

    const trying = controller.startTrial()
    expect(trial).not.toHaveBeenCalled()
    hydration.resolve(undefined)
    await Promise.all([activation, trying])

    expect(trial).toHaveBeenCalledWith({
      presetId: 'competitive-research', expectedRevision: 'r1',
      sourceSessionId: 'source-session', routeId: 'route:hydrated', changeSetId: 'hydrated-change',
    })
  })

  it('abandons a receipt-gated Try when foreground ownership changes during hydration', async () => {
    const { controller, sync, trial } = bench()
    const hydration = deferred<undefined>()
    sync.mockImplementationOnce(async () => { await hydration.promise })
    const sourceActivation = controller.activateSession('source-a', 'competitive-research')
    await vi.waitFor(() => {
      expect(controller.store.getSnapshot()).toMatchObject({ phase: 'ready', applyReceiptsLoading: true })
    })

    const trying = controller.startTrial()
    await controller.activateSession('source-b', 'competitive-research')
    hydration.resolve(undefined)
    await Promise.all([sourceActivation, trying])

    expect(trial).not.toHaveBeenCalled()
  })

  it('selects the latest Apply terminal when Proposal and Apply order differ at one revision', async () => {
    const { controller, trial } = bench()
    await controller.activateSession('source-session', 'competitive-research')
    controller.restoreApplyReceipts('source-session', [
      committedReceipt({
        sourceSessionId: 'source-session', routeId: 'route:newer-proposal',
        changeSetId: 'newer-proposal', committedRevision: 'r1', proposalResultSeq: 40, terminalSeq: 70,
      }),
      committedReceipt({
        sourceSessionId: 'source-session', routeId: 'route:later-apply',
        changeSetId: 'later-apply', committedRevision: 'r1', proposalResultSeq: 10, terminalSeq: 90,
      }),
    ])

    await controller.startTrial()

    expect(trial).toHaveBeenCalledWith({
      presetId: 'competitive-research', expectedRevision: 'r1',
      sourceSessionId: 'source-session', routeId: 'route:later-apply', changeSetId: 'later-apply',
    })
  })

  it('does not leak an Apply receipt across a Session switch even for the same preset revision', async () => {
    const { controller, trial } = bench()
    await controller.activateSession('source-a', 'competitive-research')
    controller.restoreApplyReceipts('source-a', [committedReceipt({
      sourceSessionId: 'source-a', committedRevision: 'r1',
    })])
    await controller.activateSession('source-b', 'competitive-research')

    await controller.startTrial()

    expect(trial).toHaveBeenCalledWith({ presetId: 'competitive-research', expectedRevision: 'r1' })
  })

  it('omits P0 identity when restored receipts do not match the current preset and revision exactly', async () => {
    const { controller, trial } = bench()
    await controller.activateSession('source-session', 'competitive-research')
    controller.restoreApplyReceipts('source-session', [
      committedReceipt({
        sourceSessionId: 'source-session', presetId: 'other-preset', committedRevision: 'r1',
        proposalResultSeq: 30,
      }),
      committedReceipt({
        sourceSessionId: 'source-session', committedRevision: 'stale-revision', proposalResultSeq: 31,
      }),
    ])

    await controller.startTrial()

    expect(trial).toHaveBeenCalledWith({ presetId: 'competitive-research', expectedRevision: 'r1' })
  })

  it('publishes P1 only into the exact Trial Session opened by the same interaction', async () => {
    const { controller, trial } = bench()
    await controller.activateSession('source-session', 'competitive-research')
    trial.mockImplementationOnce(async () => {
      await controller.activateSession('trial-session', 'competitive-research')
      return {
        sessionId: 'trial-session', presetId: 'competitive-research', valid: true, overall: 'pass',
        binding: {
          status: 'pass', sessionPresetId: 'competitive-research', composedPresetId: 'competitive-research',
          expectedRevision: 'r1', projectedRevision: 'r1', strictRevisionBound: false,
        },
        prompt: { status: 'pass', evidence: [] },
        tools: { status: 'pass', evidence: [], missing: [], unexpected: [], schemaMismatches: [] },
        skills: { status: 'pass', evidence: [], missing: [], unexpected: [] },
        delegations: { status: 'pass', evidence: [] },
        permissions: { status: 'pass' },
      }
    })

    await controller.startTrial()

    expect(controller.store.getSnapshot()).toMatchObject({
      busy: false,
      validation: { sessionId: 'trial-session', valid: true, overall: 'pass' },
    })
  })

  it('publishes a post-open validation failure only into its exact Trial Session', async () => {
    const { controller, trial } = bench()
    await controller.activateSession('source-session', 'competitive-research')
    trial.mockImplementationOnce(async () => {
      await controller.activateSession('trial-session', 'competitive-research')
      throw new BlueprintTrialValidationError('trial-session', new Error('validation RPC unavailable'))
    })

    await controller.startTrial()

    expect(controller.store.getSnapshot()).toMatchObject({
      busy: false,
      error: 'Agent 已打开，但运行时校验未完成：validation RPC unavailable',
      validation: null,
    })
  })

  it('does not publish a mismatched Trial validation response into a third Session', async () => {
    const { controller, trial } = bench()
    await controller.activateSession('source-session', 'competitive-research')
    trial.mockImplementationOnce(async request => await prepareBlueprintTrialSession(request, {
      create: async () => ({
        sessionId: 'trial-session' as SessionId,
        agentPreset: 'competitive-research',
      }),
      waitUntilAddressable: async () => undefined,
      notePreset: () => {},
      installContext: async () => undefined,
      mayOpen: () => true,
      open: () => { void controller.activateSession('trial-session', 'competitive-research') },
      validate: async () => {
        await controller.activateSession('third-session', 'competitive-research')
        return {
          sessionId: 'third-session', presetId: 'competitive-research', valid: true, overall: 'pass',
          binding: {
            status: 'pass', sessionPresetId: 'competitive-research', composedPresetId: 'competitive-research',
            expectedRevision: 'r1', projectedRevision: 'r1', strictRevisionBound: false,
          },
          prompt: { status: 'pass', evidence: [] },
          tools: { status: 'pass', evidence: [], missing: [], unexpected: [], schemaMismatches: [] },
          skills: { status: 'pass', evidence: [], missing: [], unexpected: [] },
          delegations: { status: 'pass', evidence: [] },
          permissions: { status: 'pass' },
        }
      },
    }))

    await controller.startTrial()

    expect(trial).toHaveBeenCalledOnce()
    expect(controller.store.getSnapshot()).toMatchObject({
      presetId: 'competitive-research', error: null, validation: null,
    })
  })

  it('opens a Demo trial without manufacturing runtime-conformance evidence', async () => {
    const demoTrial = vi.fn(() => Promise.resolve())
    const { controller, trial } = bench(demoTrial)
    await controller.load()

    await controller.startTrial()

    expect(demoTrial).toHaveBeenCalledWith({ presetId: 'competitive-research', expectedRevision: 'r1' })
    expect(trial).not.toHaveBeenCalled()
    expect(controller.store.getSnapshot()).toMatchObject({ modal: null, validation: null, busy: false })
  })

  it('keeps the selected Blueprint target while a trial Session hydrates and scopes the next structured edit', async () => {
    const { controller, presets, projections, remote, sync, trial } = bench()
    presets.push({ id: 'kaoyan-choose', trust: 'user', isDefault: false, name: '考研择校' })
    projections.set('kaoyan-choose', blueprint('k1', 'kaoyan-choose', '考研择校'))
    await controller.activateSession('source-session', 'competitive-research')
    await controller.selectPreset('kaoyan-choose')
    trial.mockImplementationOnce(async () => {
      await controller.load()
      return {
        sessionId: 'kaoyan-trial', presetId: 'kaoyan-choose', valid: true, overall: 'pass',
        binding: {
          status: 'pass', sessionPresetId: 'kaoyan-choose', composedPresetId: 'kaoyan-choose',
          expectedRevision: 'k1', projectedRevision: 'k1', strictRevisionBound: false,
        },
        prompt: { status: 'pass', evidence: [] },
        tools: { status: 'pass', evidence: [], missing: [], unexpected: [], schemaMismatches: [] },
        skills: { status: 'pass', evidence: [], missing: [], unexpected: [] },
        delegations: { status: 'pass', evidence: [] },
        permissions: { status: 'pass' },
      }
    })

    await controller.startTrial()

    expect(controller.store.getSnapshot()).toMatchObject({
      presetId: 'kaoyan-choose',
      blueprint: { preset: { id: 'kaoyan-choose' } },
    })
    expect(trial).toHaveBeenCalledWith({ presetId: 'kaoyan-choose', expectedRevision: 'k1' })

    remote.get.mockClear()
    sync.mockClear()

    await controller.updateText('behavior:1', '只比较可核实的国内院校信息。', '先核实事实。')

    expect(remote.get).not.toHaveBeenCalled()
    const behaviorPublication = sync.mock.calls.at(-1)
    expect(behaviorPublication?.[0]?.preset.id).toBe('kaoyan-choose')
    expect(behaviorPublication?.slice(1, 4)).toEqual(['behavior:1', undefined, undefined])
    expect(behaviorPublication?.[4]).toMatchObject({
      sourceSessionId: 'source-session', nodeId: 'behavior:1', nodeType: 'behavior',
      expectedValue: '先核实事实。', proposedValue: '只比较可核实的国内院校信息。',
    })
  })

  it('treats selection as conversation context without performing a write', async () => {
    const { controller, sync } = bench()
    await controller.load()
    sync.mockClear()

    controller.selectNode('capability:web-search')
    await vi.waitFor(() => { expect(sync).toHaveBeenCalledTimes(1) })

    expect(sync).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 'r1' }),
      'capability:web-search',
    )
  })

  it('applies a still-current proposal through the typed transaction API and reprojects', async () => {
    const { controller, remote, sync } = bench()
    await controller.activateSession('session-1', 'competitive-research')
    remote.get.mockClear()
    sync.mockClear()
    const proposal: BlueprintChangeProposal = {
      proposalId: 'p1', presetId: 'competitive-research', revision: 'r1',
      targetNodeId: 'capability:web-search', operation: 'setCapability',
      currentValue: true, proposedValue: false,
      impact: 'Agent 将不再主动搜索最新公开信息。',
    }

    await controller.applyChangeSet(singleChangeSet(proposal))

    expect(remote.applyChangeSet).toHaveBeenCalledWith({
      sourceSessionId: 'session-1', routeId: 'route:p1',
      changeSetId: 'p1', presetId: 'competitive-research', baseRevision: 'r1',
      operations: [{
        operation: 'setCapability', targetNodeId: 'capability:web-search', capability: 'web-search',
        expected: true, enabled: false,
      }],
    })
    expect(remote.get).toHaveBeenCalledWith({ presetId: 'competitive-research' })
    expect(sync).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 'r2' }), null,
    )
  })

  it('binds receipt recovery to the confirming Session and ignores repeated or late responses', async () => {
    const { controller, remote } = bench()
    await controller.activateSession('receipt-owner', 'competitive-research')
    await controller.applyChangeSet(singleChangeSet({
      proposalId: 'receipt-test', presetId: 'competitive-research', revision: 'r1',
      targetNodeId: 'capability:web-search', operation: 'setCapability',
      currentValue: true, proposedValue: false, impact: '关闭搜索。',
    }, 'receipt-owner'))
    expect(remote.applyChangeSet).toHaveBeenCalledWith(expect.objectContaining({ sourceSessionId: 'receipt-owner' }))
    const request = remote.applyChangeSet.mock.calls.at(0)?.[0]
    const committedRevision = controller.store.getSnapshot().blueprint?.revision
    if (request === undefined || committedRevision === undefined) throw new Error('Expected committed Apply request')
    const applied: BlueprintApplyChangeSetResult = {
      sourceSessionId: request.sourceSessionId,
      routeId: request.routeId,
      changeSetId: request.changeSetId,
      baseRevision: request.baseRevision,
      committedRevision,
      status: 'committed',
      operations: request.operations,
      preflight: { ok: true },
      unexpectedDrift: [],
    }
    const receipts = [{
      sourceSessionId: 'receipt-owner', routeId: 'route:receipt-test', proposalResultSeq: 20,
      terminalSeq: 21, presetId: 'competitive-research', result: applied,
    }]
    controller.restoreApplyReceipts('receipt-owner', receipts)
    expect(controller.store.getSnapshot().applyReceipts).toHaveLength(1)
    const before = controller.store.getSnapshot()
    controller.restoreApplyReceipts('receipt-owner', receipts)
    controller.restoreApplyReceipts('receipt-owner', [])
    expect(controller.store.getSnapshot()).toBe(before)
    controller.awaitSessionPreset('other-session')
    expect(controller.store.getSnapshot()).toMatchObject({ applyReceipts: [], applyReceiptsLoading: true })
    controller.restoreApplyReceipts('receipt-owner', receipts)
    expect(controller.store.getSnapshot().applyReceipts).toEqual([])
    await controller.activateSession('other-session', 'competitive-research')
    controller.restoreApplyReceipts('receipt-owner', receipts)
    expect(controller.store.getSnapshot().applyReceipts).toEqual([])
    controller.restoreApplyReceipts('other-session', receipts)
    expect(controller.store.getSnapshot().applyReceipts).toEqual([])
    expect(controller.store.getSnapshot().presetId).toBe('competitive-research')
  })

  it('does not apply a Change Set after foreground ownership moves to another Session', async () => {
    const { controller, remote } = bench()
    await controller.activateSession('session-b', 'competitive-research')
    remote.applyChangeSet.mockClear()

    await controller.applyChangeSet({
      changeSetId: 'proposal-a', sourceSessionId: 'session-a', routeId: 'interaction-a',
      kind: 'direct-request', presetId: 'competitive-research', revision: 'r1',
      proposals: [{
        proposalId: 'proposal-a', presetId: 'competitive-research', revision: 'r1',
        targetNodeId: 'capability:web-search', operation: 'setCapability',
        currentValue: true, proposedValue: false, impact: '关闭搜索。',
      }],
    })

    expect(remote.applyChangeSet).not.toHaveBeenCalled()
  })

  it('routes Behavior and Output proposals through the typed transaction API', async () => {
    const behaviorBench = bench()
    await behaviorBench.controller.activateSession('session-1', 'competitive-research')
    await behaviorBench.controller.applyChangeSet(singleChangeSet({
      proposalId: 'behavior-proposal', presetId: 'competitive-research', revision: 'r1',
      targetNodeId: 'behavior:1', operation: 'updateBehavior',
      currentValue: '先核实事实。', proposedValue: '优先官网、官方文档和公司公告。',
      impact: '研究会优先引用一手官方来源。',
    }))
    expect(behaviorBench.remote.applyChangeSet).toHaveBeenCalledWith({
      sourceSessionId: 'session-1', routeId: 'route:behavior-proposal',
      changeSetId: 'behavior-proposal', presetId: 'competitive-research', baseRevision: 'r1',
      operations: [{
        operation: 'updateBehavior', targetNodeId: 'behavior:1',
        expected: '先核实事实。', value: '优先官网、官方文档和公司公告。',
      }],
    })

    const outputBench = bench()
    await outputBench.controller.activateSession('session-1', 'competitive-research')
    await outputBench.controller.applyChangeSet(singleChangeSet({
      proposalId: 'output-proposal', presetId: 'competitive-research', revision: 'r1',
      targetNodeId: 'output:2', operation: 'updateOutput',
      currentValue: '输出摘要、对比表、结论和来源。',
      proposedValue: '输出摘要、价格对比表、结论和来源。',
      impact: '交付物会增加价格对比表。',
    }))
    expect(outputBench.remote.applyChangeSet).toHaveBeenCalledWith({
      sourceSessionId: 'session-1', routeId: 'route:output-proposal',
      changeSetId: 'output-proposal', presetId: 'competitive-research', baseRevision: 'r1',
      operations: [{
        operation: 'updateOutput', targetNodeId: 'output:2',
        expected: '输出摘要、对比表、结论和来源。',
        value: '输出摘要、价格对比表、结论和来源。',
      }],
    })
  })

  it('applies one reconciliation Change Set through one transaction and one final refresh', async () => {
    const { controller, remote, sync, trial } = bench()
    await controller.activateSession('session-1', 'competitive-research')
    remote.get.mockClear()
    sync.mockClear()
    const changeSet: BlueprintChangeSet = {
      changeSetId: 'reconcile-us', kind: 'direct-edit-reconciliation',
      sourceSessionId: 'session-1', routeId: 'reconcile-route',
      presetId: 'competitive-research', revision: 'r1',
      sourceNodeId: 'purpose:persona', sourceNodeType: 'purpose', sourceLabel: 'Purpose',
      proposals: [
        {
          proposalId: 'reconcile-us:1', presetId: 'competitive-research', revision: 'r1',
          targetNodeId: 'behavior:1', operation: 'updateBehavior',
          currentValue: '先核实事实。', proposedValue: '优先采用美国院校官网和官方申请渠道。',
          impact: '规则将切换到美国留学口径。', dependency: '原规则仍引用德国申请渠道。',
        },
        {
          proposalId: 'reconcile-us:2', presetId: 'competitive-research', revision: 'r1',
          targetNodeId: 'output:2', operation: 'updateOutput',
          currentValue: '输出摘要、对比表、结论和来源。',
          proposedValue: '输出美国院校对比表、申请结论和注明日期的来源。',
          impact: '输出将与美国申请目标一致。', dependency: '原输出未体现新的美国院校申请范围。',
        },
      ],
    }

    await controller.applyChangeSet(changeSet)

    expect(remote.applyChangeSet).toHaveBeenCalledTimes(1)
    expect(remote.applyChangeSet).toHaveBeenCalledWith(expect.objectContaining({
      changeSetId: 'reconcile-us', baseRevision: 'r1',
      operations: [
        expect.objectContaining({ operation: 'updateBehavior', targetNodeId: 'behavior:1' }),
        expect.objectContaining({ operation: 'updateOutput', targetNodeId: 'output:2' }),
      ],
    }))
    expect(remote.get).toHaveBeenCalledTimes(1)
    expect(controller.store.getSnapshot().blueprint?.revision).toBe('r2')
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ revision: 'r2' }), null)

    controller.restoreApplyReceipts('session-1', [committedReceipt({
      sourceSessionId: 'session-1', routeId: 'reconcile-route', changeSetId: 'reconcile-us',
      baseRevision: 'r1', committedRevision: 'r2',
    })])
    await controller.startTrial()
    expect(trial).toHaveBeenCalledWith({
      presetId: 'competitive-research', expectedRevision: 'r2',
      sourceSessionId: 'session-1', routeId: 'reconcile-route', changeSetId: 'reconcile-us',
    })
  })

  it('keeps the displayed projection unchanged when transaction preflight rejects the set', async () => {
    const { controller, remote } = bench()
    await controller.activateSession('session-1', 'competitive-research')
    remote.get.mockClear()
    remote.applyChangeSet.mockImplementationOnce(request => Promise.resolve(ok({
      sourceSessionId: request.sourceSessionId,
      routeId: request.routeId,
      changeSetId: request.changeSetId,
      baseRevision: request.baseRevision,
      status: 'preflight_failed',
      operations: request.operations,
      preflight: { ok: false, reason: 'behavior:1 expected value changed' },
      unexpectedDrift: [],
    })))

    await controller.applyChangeSet(singleChangeSet({
      proposalId: 'preflight-failure', presetId: 'competitive-research', revision: 'r1',
      targetNodeId: 'behavior:1', operation: 'updateBehavior',
      currentValue: '先核实事实。', proposedValue: '优先官方来源。', impact: '优先使用一手资料。',
    }))

    expect(remote.get).not.toHaveBeenCalled()
    expect(controller.store.getSnapshot().blueprint?.revision).toBe('r1')
    expect(controller.store.getSnapshot().error).toBe('Agent 已发生变化，这组调整没有应用，请重新查看。')
  })

  it('refreshes the restored projection after guarded transaction recovery', async () => {
    const { controller, remote } = bench()
    await controller.activateSession('session-1', 'competitive-research')
    remote.get.mockClear()
    remote.applyChangeSet.mockImplementationOnce(request => Promise.resolve(ok({
      sourceSessionId: request.sourceSessionId,
      routeId: request.routeId,
      changeSetId: request.changeSetId,
      baseRevision: request.baseRevision,
      committedRevision: 'r2',
      status: 'reprojection_failed_recovered',
      operations: request.operations,
      preflight: { ok: true },
      unexpectedDrift: [],
      failure: 'post-write projection failed',
    })))

    await controller.applyChangeSet(singleChangeSet({
      proposalId: 'recovered-failure', presetId: 'competitive-research', revision: 'r1',
      targetNodeId: 'behavior:1', operation: 'updateBehavior',
      currentValue: '先核实事实。', proposedValue: '优先官方来源。', impact: '优先使用一手资料。',
    }))

    expect(remote.get).toHaveBeenCalledTimes(1)
    expect(controller.store.getSnapshot().blueprint?.revision).toBe('r1')
    expect(controller.store.getSnapshot().error).toBe('调整未能完整应用，已恢复到修改前状态。')
  })

  it('rejects a stale proposal before any Host write', async () => {
    const { controller, remote } = bench()
    await controller.activateSession('session-1', 'competitive-research')
    const proposal: BlueprintChangeProposal = {
      proposalId: 'p-stale', presetId: 'competitive-research', revision: 'old',
      targetNodeId: 'purpose:persona', operation: 'updatePurpose',
      currentValue: '比较竞品。', proposedValue: '比较指定市场中的竞品。',
      impact: 'Agent 会聚焦指定市场。',
    }

    await controller.applyChangeSet(singleChangeSet(proposal))

    expect(remote.applyChangeSet).not.toHaveBeenCalled()
    expect(controller.store.getSnapshot().error).toMatch(/过期/u)
  })

  it.each([
    '我要一个课程资料整理测试 Agent',
    '我想要一个课程资料整理测试 Agent',
    '我需要一个课程资料整理测试 Agent',
    '帮我做一个课程资料整理测试 Agent',
    '帮我弄一个课程资料整理测试 Agent',
    '创建一个课程资料整理测试 Agent',
    '新建一个课程资料整理测试 Agent',
    '做一个课程资料整理测试 Agent',
  ])('recognizes an explicit Creator request: %s', async (text) => {
    const { controller } = bench()
    await controller.activateSession(CREATOR_SESSION_ID, 'cordis')

    await controller.observeCreator({
      sessionId: CREATOR_SESSION_ID, presetId: 'cordis', running: true, waitingFor: null,
      lastTurnEnd: null, userMessages: [{ seq: 7, text }], presetCopies: [],
      associationAnswers: [], authoredPresets: [], validatedPresets: [],
    })

    expect(controller.store.getSnapshot().creator).toMatchObject({ status: 'creating' })
  })

  it('starts and restores Creator lifecycle from a typed route without parsing request phrases', async () => {
    const { controller, presets, projections } = bench()
    presets.push({ id: 'cordis', trust: 'system', isDefault: false, name: '创造模式' })
    projections.set('cordis', blueprint('c1', 'cordis', '创造模式'))
    await controller.activateSession('source-session', 'cordis')
    controller.beginCreatorAuthoringRoute('source-session', {
      operation: 'create-agent', routeId: 'route-en',
      request: 'Research public AI companies and produce concise reports.',
      name: 'Public AI Company Research Agent',
    })
    expect(controller.store.getSnapshot()).toMatchObject({
      presetId: '', blueprint: null,
      creator: { name: 'Public AI Company Research Agent', status: 'creating' },
    })

    await controller.observeCreator({
      sessionId: 'creator-en', presetId: 'cordis', running: true, waitingFor: null,
      lastTurnEnd: null, userMessages: [], presetCopies: [], associationAnswers: [],
      authoredPresets: [], validatedPresets: [],
      creatorAuthoring: {
        operation: 'create-agent', routeId: 'route-en', sourceSessionId: 'source-session',
        request: 'Research public AI companies and produce concise reports.',
        name: 'Public AI Company Research Agent', startSeq: 12,
      },
    })
    expect(controller.store.getSnapshot().creator).toMatchObject({
      sessionId: 'source-session', name: 'Public AI Company Research Agent', status: 'creating',
    })
  })

  it('projects only the dedicated typed create-agent Tool result as a Creator continuation', () => {
    const snapshot = creatorSnapshot({
      running: false,
      nodes: [{
        ...toolResultNode(9, 'route_blueprint_creator_authoring', { name: 'Public AI Agent' }, 'accepted'),
        meta: {
          blueprintCreatorAuthoring: {
            operation: 'create-agent', routeId: 'call-9',
            request: '上場AI企業を調査するエージェントを作ってください。',
            name: '上場AI企業リサーチ Agent', sourceLanguage: 'ja',
            handoff: { sourceTurn: 2, targetCreatorSessionId: 'creator-reserved' },
          },
        },
      } as ConversationNode],
    })

    expect(creatorAuthoringRoutes(snapshot)).toEqual([{
      seq: 9,
      route: {
        operation: 'create-agent', routeId: 'call-9',
        request: '上場AI企業を調査するエージェントを作ってください。',
        name: '上場AI企業リサーチ Agent', sourceLanguage: 'ja',
        handoff: { sourceTurn: 2, targetCreatorSessionId: 'creator-reserved' },
      },
    }])
  })

  it('matches a durable Creator continuation to its exact source route', () => {
    const route = {
      operation: 'create-agent' as const,
      routeId: 'route-1',
      request: '创建一个供应商尽调 Agent。',
      name: '供应商尽调 Agent',
    }
    const authoring = {
      ...route,
      sourceSessionId: 'source-1',
      startSeq: 10,
    }

    expect(creatorAuthoringOwnsRoute(authoring, 'source-1' as SessionId, route)).toBe(true)
    expect(creatorAuthoringOwnsRoute(authoring, 'source-2' as SessionId, route)).toBe(false)
    expect(creatorAuthoringOwnsRoute(authoring, 'source-1' as SessionId, { ...route, routeId: 'route-2' })).toBe(false)
  })

  it.each([
    '这个 Agent 是什么？',
    '我需要 Agent 帮我分析一下。',
    '为当前 Agent 新增一个 Skill，不要创建新 Agent。',
    '修改现有 preset，无需新建一个助手。',
  ])('does not infer Creator authoring from ordinary Agent discussion: %s', async (text) => {
    const { controller } = bench()
    await controller.activateSession(CREATOR_SESSION_ID, 'cordis')

    await controller.observeCreator({
      sessionId: CREATOR_SESSION_ID, presetId: 'cordis', running: true, waitingFor: null,
      lastTurnEnd: null, userMessages: [{ seq: 7, text }], presetCopies: [],
      associationAnswers: [], authoredPresets: [], validatedPresets: [],
    })

    expect(controller.store.getSnapshot()).toMatchObject({ presetId: 'competitive-research', creator: null })
  })

  it('does not resurrect an earlier legacy Creator request after a later capability turn', async () => {
    const { controller } = bench()
    await controller.activateSession(CREATOR_SESSION_ID, 'cordis')

    await controller.observeCreator({
      sessionId: CREATOR_SESSION_ID,
      presetId: 'cordis',
      running: true,
      waitingFor: null,
      lastTurnEnd: { seq: 6_014, reason: 'completed' },
      userMessages: [
        { seq: 8, text: '创建一个轻薄本研究 Agent。' },
        { seq: 19_482, text: '为 Agent 添加一个证据核验 Subagent。' },
      ],
      presetCopies: [],
      associationAnswers: [],
      authoredPresets: [{ seq: 5_900, presetId: 'light-laptop-research' }],
      validatedPresets: [{ seq: 6_000, presetId: 'light-laptop-research' }],
    })

    expect(controller.store.getSnapshot()).toMatchObject({
      presetId: 'competitive-research',
      creator: null,
    })
  })

  it('replays the real Creator event sequence and recovers it after a page refresh', async () => {
    const first = bench()
    first.presets.push({
      id: 'course-material-org', trust: 'user', isDefault: false, name: '课程资料整理测试 Agent',
    })
    first.projections.set('course-material-org', blueprint('r-existing', 'course-material-org', '课程资料整理测试 Agent'))
    await first.controller.activateSession(CREATOR_SESSION_ID, 'cordis')
    first.remote.get.mockClear()

    const initial = creatorSnapshot({ nodes: [CREATION_MESSAGE], running: true })
    await first.controller.observeCreator(realObservation(initial))
    expect(first.controller.store.getSnapshot()).toMatchObject({
      presetId: '', blueprint: null, creator: { status: 'creating' },
    })

    const waiting = creatorSnapshot({ nodes: [CREATION_MESSAGE], running: true, pending: 'question' })
    await first.controller.observeCreator(realObservation(waiting))
    expect(first.controller.store.getSnapshot().creator).toMatchObject({ status: 'waiting', waitingFor: 'question' })

    const waitingRefresh = bench()
    waitingRefresh.presets.push({
      id: 'course-material-org', trust: 'user', isDefault: false, name: '课程资料整理测试 Agent',
    })
    waitingRefresh.projections.set(
      'course-material-org',
      blueprint('r-existing', 'course-material-org', '课程资料整理测试 Agent'),
    )
    await waitingRefresh.controller.activateSession(CREATOR_SESSION_ID, 'cordis')
    await waitingRefresh.controller.observeCreator(realObservation(waiting))
    expect(waitingRefresh.controller.store.getSnapshot()).toMatchObject({
      presetId: '', blueprint: null, creator: { status: 'waiting', waitingFor: 'question' },
    })

    const answer = toolResultNode(5233, 'ask_user_question', STRATEGY_QUESTION, JSON.stringify({
      answers: [{ id: 'course-org-intent', selected: ['新建一个独立的测试 preset'] }],
    }))
    const answered = creatorSnapshot({ nodes: [CREATION_MESSAGE, answer], running: true })
    await first.controller.observeCreator(realObservation(answered))
    expect(first.controller.store.getSnapshot()).toMatchObject({ presetId: '', creator: { status: 'creating' } })
    expect(first.remote.get).not.toHaveBeenCalledWith({ presetId: 'course-material-org' })

    const finalBlueprint = blueprint('r-final', 'course-material-test', '课程资料整理测试 Agent')
    finalBlueprint.nodes = finalBlueprint.nodes.filter(node => !node.id.startsWith('capability:web-'))
    finalBlueprint.runtime = { ...finalBlueprint.runtime, tools: ['read'] }
    first.presets.push({
      id: 'course-material-test', trust: 'user', isDefault: false, name: '课程资料整理测试 Agent',
    })
    first.projections.set('course-material-test', finalBlueprint)
    const copy = toolResultNode(5481, 'preset_copy', {
      from: 'course-material-org', id: 'course-material-test', name: '课程资料整理测试 Agent',
    }, 'copied course-material-org -> course-material-test')
    const copied = creatorSnapshot({ nodes: [CREATION_MESSAGE, answer, copy], running: true })
    const copiedObservation = realObservation(copied)
    expect(copiedObservation.presetCopies).toEqual([{
      seq: 5481, sourcePresetId: 'course-material-org', targetPresetId: 'course-material-test',
    }])
    await first.controller.observeCreator(copiedObservation)
    expect(first.controller.store.getSnapshot()).toMatchObject({
      presetId: 'course-material-test',
      creator: { status: 'creating', candidateIds: ['course-material-test'] },
    })

    const check = toolResultNode(5819, 'preset_validate', { id: 'course-material-test' }, 'mounted OK')
    const completed = creatorSnapshot({
      nodes: [CREATION_MESSAGE, answer, copy, check], running: false,
      turnEnd: { seq: 7081, reason: 'completed' },
    })
    await first.controller.observeCreator(realObservation(completed))
    expect(first.remote.get).toHaveBeenLastCalledWith({ presetId: 'course-material-test' })
    expect(first.controller.store.getSnapshot()).toMatchObject({
      presetId: 'course-material-test', blueprint: { revision: 'r-final' }, creator: { status: 'ready' },
    })

    const refreshed = bench()
    refreshed.presets.push(
      { id: 'course-material-org', trust: 'user', isDefault: false, name: '课程资料整理测试 Agent' },
      { id: 'course-material-test', trust: 'user', isDefault: false, name: '课程资料整理测试 Agent' },
    )
    refreshed.projections.set('course-material-org', blueprint('r-existing', 'course-material-org', '课程资料整理测试 Agent'))
    refreshed.projections.set('course-material-test', finalBlueprint)
    await refreshed.controller.activateSession(CREATOR_SESSION_ID, 'cordis')
    await refreshed.controller.observeCreator(copiedObservation)

    expect(refreshed.controller.store.getSnapshot()).toMatchObject({
      presetId: 'course-material-test', creator: { status: 'creating', candidateIds: ['course-material-test'] },
    })

    await refreshed.controller.observeCreator(realObservation(completed))

    expect(refreshed.remote.get).toHaveBeenLastCalledWith({ presetId: 'course-material-test' })
    expect(refreshed.controller.store.getSnapshot()).toMatchObject({
      presetId: 'course-material-test', blueprint: { revision: 'r-final' }, creator: { status: 'ready' },
    })
  })

  it('associates an exact-name baseline only after this Creator Session validates it', async () => {
    const request: ConversationNode = {
      kind: 'user', seq: 389, time: 389,
      content: [{ type: 'text', text: '我要一个上市公司研究 Agent。先搭基础版本。' }],
      source: { kind: 'user' },
    }
    const validate = toolResultNode(
      3561,
      'preset_validate',
      { id: 'listed-company-research' },
      'mounted OK for listed-company-research',
    )
    const completed = creatorSnapshot({
      nodes: [request, validate], running: false,
      turnEnd: { seq: 4677, reason: 'completed' },
    })
    const observation = creatorObservation('creator-existing' as SessionId, 'cordis', completed)
    expect(observation.validatedPresets).toEqual([
      { seq: 3561, presetId: 'listed-company-research' },
    ])

    const beforeValidation = creatorObservation(
      'creator-existing' as SessionId,
      'cordis',
      creatorSnapshot({
        nodes: [request], running: false,
        turnEnd: { seq: 4677, reason: 'completed' },
      }),
    )
    const active = bench()
    for (const fixture of [active, bench()]) {
      const target = blueprint('r-existing', 'listed-company-research', '上市公司研究')
      target.nodes = target.nodes.map(node => node.id === 'purpose:persona'
        ? { ...node, value: '研究上市公司的基本面、行业竞争情况和估值水平。' }
        : node)
      fixture.presets.push({
        id: 'listed-company-research', trust: 'user', isDefault: false, name: '上市公司研究',
      })
      fixture.projections.set('listed-company-research', target)
      await fixture.controller.activateSession('creator-existing', 'cordis')
      if (fixture === active) {
        await fixture.controller.observeCreator(beforeValidation)
        expect(fixture.controller.store.getSnapshot()).toMatchObject({
          blueprint: null, creator: { status: 'paused' },
        })
        expect(fixture.controller.store.getSnapshot().creator?.targetPresetId).toBeUndefined()
      }
      await fixture.controller.observeCreator(observation)

      expect(fixture.controller.store.getSnapshot()).toMatchObject({
        presetId: 'listed-company-research', blueprint: { revision: 'r-existing' },
        creator: { targetPresetId: 'listed-company-research', status: 'ready' },
      })
      await fixture.controller.observeCreator(observation)
      expect(fixture.controller.store.getSnapshot().creator).toMatchObject({
        targetPresetId: 'listed-company-research', status: 'ready',
      })
    }
  })

  it('recovers the latest durable Creator completion when hydration includes a trailing open turn', async () => {
    const request: ConversationNode = {
      kind: 'user', seq: 7, time: 7,
      content: [{ type: 'text', text: '我要一个供应商尽调 RC 验收 Agent' }],
      source: { kind: 'user' },
    }
    const copy = toolResultNode(2445, 'preset_copy', {
      from: 'vendor-due-diligence', id: 'vendor-due-diligence-rc2', name: '供应商尽调 RC 验收 Agent',
    }, 'copied vendor-due-diligence -> vendor-due-diligence-rc2')
    const validate = toolResultNode(
      19533,
      'preset_validate',
      { id: 'vendor-due-diligence-rc2' },
      'mounted OK for vendor-due-diligence-rc2',
    )
    const snapshot = creatorSnapshot({
      nodes: [request, copy, validate], running: false, trailingOpenTurn: true,
      turnEnd: { seq: 20478, reason: 'completed' },
    })
    const observation = creatorObservation(CREATOR_SESSION_ID, 'cordis', snapshot)

    expect(observation.lastTurnEnd).toEqual({ seq: 20478, reason: 'completed' })
    const fixture = bench()
    fixture.presets.push({
      id: 'vendor-due-diligence-rc2', trust: 'user', isDefault: false,
      name: '供应商尽调 RC 验收 Agent',
    })
    fixture.projections.set(
      'vendor-due-diligence-rc2',
      blueprint('r-final', 'vendor-due-diligence-rc2', '供应商尽调 RC 验收 Agent'),
    )
    await fixture.controller.activateSession(CREATOR_SESSION_ID, 'cordis')
    await fixture.controller.observeCreator(observation)

    expect(fixture.controller.store.getSnapshot()).toMatchObject({
      presetId: 'vendor-due-diligence-rc2', blueprint: { revision: 'r-final' },
      creator: { targetPresetId: 'vendor-due-diligence-rc2', status: 'ready' },
    })
  })

  it('recovers a named new Agent preset request and reaches Ready after refresh', async () => {
    const request: ConversationNode = {
      kind: 'user', seq: 11, time: 11,
      content: [{
        type: 'text',
        text: '请创建一个名为「轻薄本研究预发布 Agent」的新 Agent preset，用于研究轻薄本市场。',
      }],
      source: { kind: 'user' },
    }
    const copy = toolResultNode(120, 'preset_copy', {
      from: 'competitive-research', id: 'light-laptop-research', name: '轻薄本研究预发布 Agent',
    }, 'copied competitive-research -> light-laptop-research')
    const validate = toolResultNode(
      180,
      'preset_validate',
      { id: 'light-laptop-research' },
      'mounted OK for light-laptop-research',
    )
    const initial = creatorObservation(
      'creator-named-preset' as SessionId,
      'cordis',
      creatorSnapshot({ nodes: [request], running: true }),
    )
    const completed = creatorObservation(
      'creator-named-preset' as SessionId,
      'cordis',
      creatorSnapshot({
        nodes: [request, copy, validate], running: false,
        turnEnd: { seq: 220, reason: 'completed' },
      }),
    )
    const target = blueprint(
      'r-light-laptop',
      'light-laptop-research',
      '轻薄本研究预发布 Agent',
    )

    const active = bench()
    await active.controller.activateSession('creator-named-preset', 'cordis')
    await active.controller.observeCreator(initial)
    expect(active.controller.store.getSnapshot()).toMatchObject({
      presetId: '', blueprint: null,
      creator: { name: '轻薄本研究预发布 Agent', status: 'creating' },
    })
    active.presets.push({
      id: 'light-laptop-research', trust: 'user', isDefault: false,
      name: '轻薄本研究预发布 Agent',
    })
    active.projections.set('light-laptop-research', target)
    await active.controller.observeCreator(completed)
    expect(active.controller.store.getSnapshot()).toMatchObject({
      presetId: 'light-laptop-research', blueprint: { revision: 'r-light-laptop' },
      creator: { name: '轻薄本研究预发布 Agent', status: 'ready' },
    })

    const refreshed = bench()
    refreshed.presets.push({
      id: 'light-laptop-research', trust: 'user', isDefault: false,
      name: '轻薄本研究预发布 Agent',
    })
    refreshed.projections.set('light-laptop-research', target)
    await refreshed.controller.activateSession('creator-named-preset', 'cordis')
    await refreshed.controller.observeCreator(completed)
    expect(refreshed.controller.store.getSnapshot()).toMatchObject({
      presetId: 'light-laptop-research', blueprint: { revision: 'r-light-laptop' },
      creator: { name: '轻薄本研究预发布 Agent', status: 'ready' },
    })
  })

  it('projects only explicit preset association answers from native Creator questions', () => {
    const selected = ['直接用现有的 course-material-org 测试（推荐）', '在现有基础上完善后再测试', '新建一个独立的测试 preset']
    const strategies = selected.map((label, index) => {
      const answer = toolResultNode(100 + index, 'ask_user_question', STRATEGY_QUESTION, JSON.stringify({
        answers: [{ id: 'course-org-intent', selected: [label] }],
      }))
      return realObservation(creatorSnapshot({ nodes: [CREATION_MESSAGE, answer], running: true }))
        .associationAnswers[0]
    })

    expect(strategies).toEqual([
      { seq: 100, strategy: 'reuse-existing', existingPresetId: 'course-material-org' },
      { seq: 101, strategy: 'enhance-existing', existingPresetId: 'course-material-org' },
      { seq: 102, strategy: 'new-independent', existingPresetId: null },
    ])
  })

  it('allows a structured reuse choice to bind one baseline preset', async () => {
    const { controller, presets, projections } = bench()
    presets.push({ id: 'course-material-org', trust: 'user', isDefault: false, name: '课程资料整理测试 Agent' })
    projections.set('course-material-org', blueprint('r-existing', 'course-material-org', '课程资料整理测试 Agent'))
    await controller.activateSession(CREATOR_SESSION_ID, 'cordis')
    const answer = toolResultNode(5233, 'ask_user_question', STRATEGY_QUESTION, JSON.stringify({
      answers: [{ id: 'course-org-intent', selected: ['直接用现有的 course-material-org 测试（推荐）'] }],
    }))

    await controller.observeCreator(realObservation(creatorSnapshot({
      nodes: [
        CREATION_MESSAGE, answer,
        toolResultNode(6000, 'preset_validate', { id: 'course-material-org' }, 'mounted OK'),
      ], running: false,
      turnEnd: { seq: 7081, reason: 'completed' },
    })))

    expect(controller.store.getSnapshot()).toMatchObject({
      presetId: 'course-material-org', creator: { status: 'ready', candidateIds: ['course-material-org'] },
    })
  })

  it('waits for authoring evidence before an enhance-existing choice binds its baseline preset', async () => {
    const { controller, presets, projections } = bench()
    presets.push({ id: 'course-material-org', trust: 'user', isDefault: false, name: '课程资料整理测试 Agent' })
    projections.set('course-material-org', blueprint('r-existing', 'course-material-org', '课程资料整理测试 Agent'))
    await controller.activateSession(CREATOR_SESSION_ID, 'cordis')
    const answer = toolResultNode(5233, 'ask_user_question', STRATEGY_QUESTION, JSON.stringify({
      answers: [{ id: 'course-org-intent', selected: ['在现有基础上完善后再测试'] }],
    }))

    await controller.observeCreator(realObservation(creatorSnapshot({
      nodes: [CREATION_MESSAGE, answer], running: true,
    })))
    expect(controller.store.getSnapshot().presetId).toBe('')

    const write = toolResultNode(5481, 'pwsh', {
      command: "Set-Content 'C:\\Users\\12460\\.dsh\\.agent-presets\\course-material-org\\agent.cordis.yml'",
    }, 'updated')
    await controller.observeCreator(realObservation(creatorSnapshot({
      nodes: [CREATION_MESSAGE, answer, write], running: true,
    })))

    expect(controller.store.getSnapshot()).toMatchObject({
      presetId: 'course-material-org', creator: { status: 'creating', candidateIds: ['course-material-org'] },
    })
  })

  it('keeps Creator selection context active but rejects every direct write and trial before Ready', async () => {
    const { controller, presets, projections, remote, trial, sync } = bench()
    presets.push({ id: 'course-material-test', trust: 'user', isDefault: false, name: '课程资料整理测试 Agent' })
    projections.set(
      'course-material-test',
      blueprint('r-existing', 'course-material-test', '课程资料整理测试 Agent'),
    )
    await controller.activateSession(CREATOR_SESSION_ID, 'cordis')
    const answer = toolResultNode(5233, 'ask_user_question', {
      questions: [{
        id: 'course-org-intent',
        question: '已存在 preset id: course-material-test。你希望怎么处理？',
        options: [{ label: '直接使用已有 preset', description: '使用已有 preset。' }],
      }],
    }, JSON.stringify({
      answers: [{ id: 'course-org-intent', selected: ['直接使用已有 preset'] }],
    }))
    const waiting = creatorSnapshot({
      nodes: [CREATION_MESSAGE, answer], running: true, pending: 'question',
    })

    await controller.observeCreator(realObservation(waiting))
    expect(controller.store.getSnapshot()).toMatchObject({
      presetId: 'course-material-test', blueprint: { revision: 'r-existing' },
      creator: { status: 'waiting', waitingFor: 'question' },
    })

    remote.get.mockClear()
    await controller.load()
    expect(remote.get).toHaveBeenLastCalledWith({ presetId: 'course-material-test' })
    expect(controller.store.getSnapshot().blueprint?.revision).toBe('r-existing')

    remote.applyChangeSet.mockClear()
    sync.mockClear()
    controller.selectNode('purpose:persona')
    expect(controller.store.getSnapshot().selectedNodeId).toBe('purpose:persona')
    expect(sync).toHaveBeenLastCalledWith(
      expect.objectContaining({ revision: 'r-existing' }),
      'purpose:persona',
      expect.objectContaining({ status: 'waiting' }),
    )
    controller.clearSelection()
    expect(sync).toHaveBeenLastCalledWith(
      expect.objectContaining({ revision: 'r-existing' }),
      null,
      expect.objectContaining({ status: 'waiting' }),
    )
    sync.mockClear()
    controller.openModal('try')
    await controller.updateText('purpose:persona', '修改目标。', '比较竞品。')
    await controller.setCapability('capability:web-search', false)
    await controller.applyChangeSet(singleChangeSet({
      proposalId: 'locked', presetId: 'course-material-test', revision: 'r-existing',
      targetNodeId: 'purpose:persona', operation: 'updatePurpose',
      currentValue: '比较竞品。', proposedValue: '修改目标。', impact: '修改目标。',
    }, CREATOR_SESSION_ID))
    await controller.startTrial()

    expect(controller.store.getSnapshot()).toMatchObject({ selectedNodeId: null, modal: null })
    expect(remote.applyChangeSet).not.toHaveBeenCalled()
    expect(trial).not.toHaveBeenCalled()
    expect(sync).not.toHaveBeenCalled()
  })

  it('replaces the old Blueprint with the Creator Draft lifecycle', async () => {
    const { controller, sync } = bench()
    await controller.activateSession('creator-1', 'cordis')
    sync.mockClear()

    await observeCreator(controller, {
      sessionId: 'creator-1', presetId: 'cordis', running: true, waitingFor: null, lastTurnEnd: null,
      latestUserMessage: { seq: 1, text: '我要做一个秋招投递 Agent' }, authoredPresetIds: [],
    })
    expect(controller.store.getSnapshot()).toMatchObject({
      presetId: '', blueprint: null,
      creator: { sessionId: 'creator-1', name: '秋招投递 Agent', status: 'creating' },
    })
    expect(controller.store.getSnapshot().blueprint).toBeNull()
    expect(sync).toHaveBeenLastCalledWith(null, null, expect.objectContaining({
      sessionId: 'creator-1', name: '秋招投递 Agent', status: 'creating',
    }))

    await observeCreator(controller, {
      sessionId: 'creator-1', presetId: 'cordis', running: false, waitingFor: 'question', lastTurnEnd: null,
      latestUserMessage: { seq: 1, text: '我要做一个秋招投递 Agent' }, authoredPresetIds: [],
    })
    expect(controller.store.getSnapshot().creator?.status).toBe('waiting')
    expect(sync).toHaveBeenLastCalledWith(null, null, expect.objectContaining({ status: 'waiting' }))

    await observeCreator(controller, {
      sessionId: 'creator-1', presetId: 'cordis', running: false, waitingFor: null,
      lastTurnEnd: { seq: 3, reason: 'max-tokens' },
      latestUserMessage: { seq: 2, text: '主要追踪互联网公司的产品岗位。' }, authoredPresetIds: [],
    })
    expect(controller.store.getSnapshot().creator?.status).toBe('paused')
  })

  it('keeps a primary creation request when a later clause defers other authoring', async () => {
    const { controller } = bench()
    await controller.activateSession('creator-primary', 'cordis')

    await observeCreator(controller, {
      sessionId: 'creator-primary', presetId: 'cordis', running: true, waitingFor: null, lastTurnEnd: null,
      latestUserMessage: {
        seq: 1,
        text: '创建一个上市公司研究 Agent。本轮先完成基础 Agent，暂不创建自定义 Skill 或 Subagent。',
      },
      authoredPresetIds: [],
    })

    expect(controller.store.getSnapshot()).toMatchObject({
      blueprint: null,
      creator: { sessionId: 'creator-primary', name: '上市公司研究 Agent', status: 'creating' },
    })
  })

  it.each([
    '不要创建一个上市公司研究 Agent。',
    '不要创建一个名为「轻薄本研究预发布 Agent」的新 Agent preset。',
    '我不想创建一个上市公司研究 Agent。',
    'Do not create an equity research agent.',
  ])('does not start a Creator Draft from a negated request: %s', async (text) => {
    const { controller } = bench()
    await controller.activateSession('creator-negative', 'cordis')

    await observeCreator(controller, {
      sessionId: 'creator-negative', presetId: 'cordis', running: true, waitingFor: null, lastTurnEnd: null,
      latestUserMessage: { seq: 1, text }, authoredPresetIds: [],
    })

    expect(controller.store.getSnapshot().creator).toBeNull()
  })

  it('keeps a copied template hidden until target semantics diverge, then never regresses', async () => {
    const { controller, presets, projections, sync } = bench()
    const source = blueprint('r-source', 'qiuzhao-apply', '秋招投递 Agent')
    source.nodes = source.nodes.map(node => node.id === 'purpose:persona'
      ? { ...node, value: '管理应届生秋招投递全流程。' }
      : node.id === 'behavior:1' ? { ...node, value: '按招聘批次跟踪岗位和投递状态。' } : node)
    presets.push({ id: 'qiuzhao-apply', trust: 'user', isDefault: false, name: '秋招投递 Agent' })
    projections.set('qiuzhao-apply', source)
    await controller.activateSession('creator-study', 'cordis')

    const creation = {
      sessionId: 'creator-study', presetId: 'cordis', running: true, waitingFor: null, lastTurnEnd: null,
      userMessages: [{ seq: 7, text: '我要一个德国留学选校 Agent' }],
      presetCopies: [] as BlueprintCreatorObservation['presetCopies'],
      associationAnswers: [], authoredPresets: [], validatedPresets: [],
    } satisfies BlueprintCreatorObservation
    await controller.observeCreator(creation)

    const copied = {
      ...source,
      revision: 'r-copy',
      preset: { id: 'study-germany', trust: 'user' as const, name: '德国留学选校 Agent' },
    }
    presets.push({ id: 'study-germany', trust: 'user', isDefault: false, name: '德国留学选校 Agent' })
    projections.set('study-germany', copied)
    await controller.pollCreator()
    expect(controller.store.getSnapshot()).toMatchObject({
      presetId: 'study-germany', blueprint: null,
      creator: { status: 'creating', targetPresetId: 'study-germany' },
    })
    const copyObservation = {
      ...creation,
      presetCopies: [{ seq: 20, sourcePresetId: 'qiuzhao-apply', targetPresetId: 'study-germany' }],
      authoredPresets: [{ seq: 20, presetId: 'study-germany' }],
      validatedPresets: [{ seq: 21, presetId: 'study-germany' }],
    } satisfies BlueprintCreatorObservation
    await controller.observeCreator(copyObservation)

    expect(controller.store.getSnapshot()).toMatchObject({
      presetId: 'study-germany', blueprint: null,
      creator: { status: 'creating', targetPresetId: 'study-germany' },
    })
    expect(sync).toHaveBeenLastCalledWith(null, null, expect.objectContaining({
      targetPresetId: 'study-germany',
    }))

    const customized = {
      ...copied,
      revision: 'r-customized',
      nodes: copied.nodes.map(node => node.id === 'purpose:persona'
        ? { ...node, value: '帮助用户完成德国留学选校与申请管理。' }
        : node),
    }
    projections.set('study-germany', customized)
    await controller.observeCreator(copyObservation)

    expect(controller.store.getSnapshot()).toMatchObject({
      presetId: 'study-germany',
      blueprint: { revision: 'r-customized' },
      creator: { status: 'creating' },
    })

    projections.set('study-germany', { ...copied, revision: 'r-temporary-template' })
    await controller.observeCreator(copyObservation)
    expect(controller.store.getSnapshot()).toMatchObject({
      blueprint: { revision: 'r-temporary-template' },
      creator: { status: 'creating' },
    })
  })

  it('keeps an associated copy in authoring and reaches Ready only with the final fresh projection', async () => {
    const { controller, presets, projections, remote, sync } = bench()
    await controller.activateSession('creator-1', 'cordis')
    sync.mockClear()
    await observeCreator(controller, {
      sessionId: 'creator-1', presetId: 'cordis', running: true, waitingFor: null, lastTurnEnd: null,
      latestUserMessage: { seq: 1, text: '我要做一个课程资料整理测试 Agent' }, authoredPresetIds: [],
    })
    presets.push({ id: 'course-materials', trust: 'user', isDefault: false, name: '课程资料整理测试 Agent' })
    projections.set('course-materials', blueprint('r-copy', 'course-materials', '课程资料整理测试 Agent'))

    await observeCreator(controller, {
      sessionId: 'creator-1', presetId: 'cordis', running: true, waitingFor: null, lastTurnEnd: null,
      latestUserMessage: { seq: 1, text: '我要做一个课程资料整理测试 Agent' }, authoredPresetIds: ['course-materials'],
    })
    expect(controller.store.getSnapshot()).toMatchObject({
      presetId: 'course-materials',
      creator: { status: 'creating', candidateIds: ['course-materials'] },
      blueprint: { revision: 'r-copy' },
    })
    expect(sync).toHaveBeenLastCalledWith(
      expect.objectContaining({ revision: 'r-copy' }),
      null,
      expect.objectContaining({ status: 'creating' }),
    )
    controller.selectNode('purpose:persona')

    const final = blueprint('r-final', 'course-materials', '课程资料整理测试 Agent')
    final.nodes = final.nodes
      .filter(node => node.id !== 'capability:web-search' && node.id !== 'capability:web-fetch')
      .map(node => node.id === 'purpose:persona'
        ? { ...node, value: '整理课程资料并生成复习结构。' }
        : node.id === 'behavior:1' ? { ...node, value: '按课程主题和知识点归档。' }
          : node.id === 'output:2' ? { ...node, value: '输出课程清单、知识点索引和复习建议。' } : node)
    final.runtime = { ...final.runtime, tools: ['read'] }
    projections.set('course-materials', final)

    await observeCreator(controller, {
      sessionId: 'creator-1', presetId: 'cordis', running: true, waitingFor: 'approval', lastTurnEnd: null,
      latestUserMessage: { seq: 2, text: '按课程主题整理。' }, authoredPresetIds: ['course-materials'],
    })
    expect(controller.store.getSnapshot()).toMatchObject({
      creator: { status: 'waiting', waitingFor: 'approval' },
      blueprint: { revision: 'r-final' },
      selectedNodeId: 'purpose:persona',
    })

    await observeCreator(controller, {
      sessionId: 'creator-1', presetId: 'cordis', running: false, waitingFor: null,
      lastTurnEnd: { seq: 20, reason: 'max-tokens' },
      latestUserMessage: { seq: 2, text: '按课程主题整理。' }, authoredPresetIds: ['course-materials'],
    })
    expect(controller.store.getSnapshot().creator?.status).toBe('paused')

    await observeCreator(controller, {
      sessionId: 'creator-1', presetId: 'cordis', running: false, waitingFor: null,
      lastTurnEnd: { seq: 20, reason: 'completed' },
      latestUserMessage: { seq: 21, text: '继续。' }, authoredPresetIds: ['course-materials'],
    })
    expect(controller.store.getSnapshot().creator?.status).toBe('paused')

    await observeCreator(controller, {
      sessionId: 'creator-1', presetId: 'cordis', running: false, waitingFor: null,
      lastTurnEnd: { seq: 30, reason: 'completed' },
      latestUserMessage: { seq: 21, text: '继续。' }, authoredPresetIds: ['course-materials'],
      validatedPresetIds: ['course-materials'],
    })

    expect(remote.get).toHaveBeenCalledWith({ presetId: 'course-materials' })
    expect(controller.store.getSnapshot()).toMatchObject({
      presetId: 'course-materials',
      creator: { sessionId: 'creator-1', status: 'ready', candidateIds: ['course-materials'] },
      blueprint: { preset: { id: 'course-materials' }, revision: 'r-final' },
    })
    expect(controller.store.getSnapshot().blueprint?.nodes).toContainEqual(expect.objectContaining({
      id: 'purpose:persona', value: '整理课程资料并生成复习结构。',
    }))
    expect(controller.store.getSnapshot().blueprint?.nodes)
      .not.toContainEqual(expect.objectContaining({ id: 'capability:web-search' }))
    expect(controller.store.getSnapshot().blueprint?.nodes)
      .not.toContainEqual(expect.objectContaining({ id: 'capability:web-fetch' }))
    expect(controller.store.getSnapshot().blueprint?.nodes).toContainEqual(expect.objectContaining({
      id: 'behavior:1', value: '按课程主题和知识点归档。',
    }))
    expect(controller.store.getSnapshot().blueprint?.nodes).toContainEqual(expect.objectContaining({
      id: 'output:2', value: '输出课程清单、知识点索引和复习建议。',
    }))
    expect(sync).toHaveBeenLastCalledWith(
      expect.objectContaining({ revision: 'r-final' }),
      'purpose:persona',
    )
  })

  it('does not let an older projection overwrite a newer completed Creator observation', async () => {
    const { controller, presets, projections, remote } = bench()
    await controller.activateSession('creator-pe', 'cordis')
    await observeCreator(controller, {
      sessionId: 'creator-pe', presetId: 'cordis', running: true, waitingFor: null, lastTurnEnd: null,
      latestUserMessage: { seq: 7, text: '我想要一个市盈率分析 Agent' }, authoredPresetIds: [],
    })
    presets.push({ id: 'pe-analysis', trust: 'user', isDefault: false, name: '市盈率分析' })
    projections.set('pe-analysis', blueprint('r-pe', 'pe-analysis', '市盈率分析'))
    await observeCreator(controller, {
      sessionId: 'creator-pe', presetId: 'cordis', running: true, waitingFor: null, lastTurnEnd: null,
      latestUserMessage: { seq: 7, text: '我想要一个市盈率分析 Agent' }, authoredPresetIds: ['pe-analysis'],
    })

    let releaseProjection = (): void => undefined
    let markProjectionStarted = (): void => undefined
    const projectionStarted = new Promise<void>((resolve) => { markProjectionStarted = resolve })
    const projectionGate = new Promise<void>((resolve) => { releaseProjection = resolve })
    let delayNextProjection = true
    remote.get.mockImplementation(async ({ presetId }) => {
      const value = projections.get(presetId)
      if (presetId === 'pe-analysis' && delayNextProjection) {
        delayNextProjection = false
        markProjectionStarted()
        await projectionGate
      }
      return value === undefined
        ? { ok: false as const, error: { code: 'not-found', message: `unknown ${presetId}`, details: { presetId } } }
        : ok(value)
    })

    const stalePoll = controller.pollCreator()
    await projectionStarted
    const completedObservation = observeCreator(controller, {
      sessionId: 'creator-pe', presetId: 'cordis', running: false, waitingFor: null,
      lastTurnEnd: { seq: 16_690, reason: 'completed' },
      latestUserMessage: { seq: 7, text: '我想要一个市盈率分析 Agent' },
      authoredPresetIds: ['pe-analysis'], validatedPresetIds: ['pe-analysis'],
    })
    releaseProjection()
    await Promise.all([stalePoll, completedObservation])

    expect(controller.store.getSnapshot()).toMatchObject({
      presetId: 'pe-analysis', creator: { status: 'ready' }, blueprint: { revision: 'r-pe' },
    })
  })

  it('keeps multiple valid candidates ambiguous instead of guessing', async () => {
    const { controller, presets, projections } = bench()
    await controller.activateSession('creator-1', 'cordis')
    await observeCreator(controller, {
      sessionId: 'creator-1', presetId: 'cordis', running: true, waitingFor: null, lastTurnEnd: null,
      latestUserMessage: { seq: 1, text: '创建一个求职 Agent。' }, authoredPresetIds: [],
    })
    presets.push(
      { id: 'resume-helper', trust: 'user', isDefault: false, name: '简历助手' },
      { id: 'job-tracker', trust: 'user', isDefault: false, name: '投递追踪' },
    )
    projections.set('resume-helper', blueprint('r2', 'resume-helper', '简历助手'))
    projections.set('job-tracker', blueprint('r3', 'job-tracker', '投递追踪'))

    await observeCreator(controller, {
      sessionId: 'creator-1', presetId: 'cordis', running: false, waitingFor: null,
      lastTurnEnd: { seq: 3, reason: 'completed' },
      latestUserMessage: { seq: 1, text: '创建一个求职 Agent。' },
      authoredPresetIds: ['resume-helper', 'job-tracker'],
    })

    expect(controller.store.getSnapshot()).toMatchObject({
      blueprint: null,
      creator: { status: 'ambiguity', candidateIds: ['resume-helper', 'job-tracker'] },
    })
  })

  it('defers background capability recovery until durable source order is addressable', () => {
    const cold = [
      { creatorSessionId: 'creator-old', sourceSessionId: 'source-1', routeId: 'route-old' },
      { creatorSessionId: 'creator-new', sourceSessionId: 'source-1', routeId: 'route-new' },
    ]
    expect(latestCapabilityRecoveryCandidates(cold)).toEqual([])

    expect(latestCapabilityRecoveryCandidates([
      { ...cold[0]!, sourceRouteSeq: 12 },
      { ...cold[1]!, sourceRouteSeq: 19 },
      { creatorSessionId: 'creator-cold', sourceSessionId: 'source-2', routeId: 'route-cold' },
    ])).toEqual([{ ...cold[1]!, sourceRouteSeq: 19 }])
  })
})
