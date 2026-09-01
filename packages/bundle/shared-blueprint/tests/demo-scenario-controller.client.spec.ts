// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { BlueprintUiState } from '../src/client/controller.ts'
import { DemoScenarioController } from '../src/client/demo-scenario-controller.ts'

afterEach(() => { vi.useRealTimers() })

function harness() {
  const prompt = vi.fn(() => Promise.resolve({ ok: true } as never))
  const setDraft = vi.fn()
  const store = createSnapshotStore<BlueprintUiState>({
    phase: 'ready', agents: [], presetId: '', blueprint: null, selectedNodeId: null,
    modal: null, busy: false, error: null, validation: null, proposalCancellations: [],
    creator: null, capabilityHandoff: null,
  })
  const createSession = vi.fn(() => Promise.resolve('session-1' as never))
  const blueprint = {
    store,
    load: vi.fn(() => Promise.resolve()),
    selectNode: vi.fn(),
    clearSelection: vi.fn(),
    updateText: vi.fn(() => Promise.resolve()),
    activateSession: vi.fn(() => Promise.resolve()),
    closeModal: vi.fn(),
    applyChangeSet: vi.fn(() => Promise.resolve()),
    selectPreset: vi.fn(() => Promise.resolve()),
    observeCreator: vi.fn(() => Promise.resolve()),
    pollCreator: vi.fn(() => Promise.resolve()),
  }
  const scenario = new DemoScenarioController({
    ctx: {
      sessions: {
        list: {
          getSnapshot: () => ({
            current: 'session-1',
            byId: { 'session-1': { agentPreset: 'listed-company-research' } },
          }),
          subscribe: () => () => {},
        },
        scope: () => undefined,
        binding: () => ({ session: { prompt } }),
      },
      conversation: { input: { for: () => ({ setDraft, state: { getSnapshot: () => ({ draft: '' }) } }) } },
      layout: { openDetails: vi.fn() },
    } as never,
    blueprint: blueprint as never,
    adapter: {} as never,
    creatorScenario: {
      agent: { id: 'listed-company-research', label: '上市公司研究 Agent', trust: 'user' },
      blueprint: { preset: { id: 'listed-company-research' } },
    } as never,
    createSession,
    observeCreator: vi.fn(),
    fixtureBridge: () => undefined,
  })
  return { scenario, blueprint, createSession, prompt, setDraft, store }
}

describe('DemoScenarioController architecture', () => {
  it('starts with separated lifecycle, Creator, Blueprint, proposal, capability, and test state', () => {
    const { scenario } = harness()
    expect(scenario.snapshot()).toEqual({
      lifecycle: 'idle',
      creator: { sessionId: null, projection: 'absent' },
      blueprint: { presetId: 'listed-company-research', selectedNodeId: null },
      proposal: { status: 'idle', applyingNodeIds: [] },
      capabilityAuthoring: {
        active: null, publishing: null, installed: { skill: false, subagent: false },
      },
      testSession: { sessionId: null, status: 'idle' },
    })
  })

  it('routes UI intents through controller methods and projects only the compatibility view', async () => {
    vi.useFakeTimers()
    const { scenario, blueprint, createSession, prompt, setDraft } = harness()

    scenario.selectNode('identity:persona')
    expect(blueprint.selectNode).toHaveBeenCalledWith('identity:persona')
    expect(scenario.snapshot().blueprint.selectedNodeId).toBe('identity:persona')
    expect(setDraft).not.toHaveBeenCalled()

    await scenario.submitTextEdit('purpose:persona', '新的目标', '旧的目标')
    expect(blueprint.updateText).toHaveBeenCalledWith('purpose:persona', '新的目标', '旧的目标')
    expect(prompt).toHaveBeenCalledWith([{
      type: 'text', text: '将 Purpose 修改为：新的目标',
    }], 'queue')
    prompt.mockClear()

    await scenario.submitCapabilityRequest(
      '我希望它可以处理 CSV 财务数据，提取营收、净利润、PE 和 PB，并生成结构化摘要。',
    )
    expect(blueprint.clearSelection).toHaveBeenCalledOnce()
    expect(createSession).not.toHaveBeenCalled()
    expect(blueprint.activateSession).toHaveBeenCalledWith('session-1', 'listed-company-research')
    expect(prompt).toHaveBeenCalledWith([{
      type: 'text',
      text: '我希望它可以处理 CSV 财务数据，提取营收、净利润、PE 和 PB，并生成结构化摘要。',
    }], 'queue')
    expect(scenario.snapshot().capabilityAuthoring.active).toBe('skill')

    const applying = scenario.applyChangeSet({
      changeSetId: 'set-1', kind: 'direct-edit-reconciliation', presetId: 'listed-company-research',
      revision: 'r1', sourceNodeId: 'purpose:persona', sourceNodeType: 'purpose', sourceLabel: 'Purpose',
      proposals: [],
    } as never)
    expect(scenario.snapshot().proposal.status).toBe('applying')
    await vi.advanceTimersByTimeAsync(800)
    await applying
    expect(blueprint.applyChangeSet).toHaveBeenCalled()
    expect(scenario.snapshot().proposal.status).toBe('applied')
  })
})
