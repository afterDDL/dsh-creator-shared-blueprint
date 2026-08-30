const STRUCTURE_DEMO_SEED = {
  agent: { id: 'structure-demo', label: '预览占位 Agent', trust: 'user' },
  blueprint: {
    schemaVersion: 1,
    sourceLanguage: 'zh',
    preset: { id: 'structure-demo', trust: 'user', name: '预览占位 Agent' },
    revision: 'demo-r1',
    nodes: [
      {
        id: 'identity:persona', type: 'identity', value: '结构预览角色', source: 'preset',
        status: 'active', editable: true, adapterRef: 'identity',
      },
      {
        id: 'purpose:persona', type: 'purpose', value: '仅验证真实产品界面中的 Blueprint 交互。',
        source: 'inferred', status: 'active', editable: true, adapterRef: 'purpose',
      },
      {
        id: 'behavior:1', type: 'behavior', value: '所有预览状态必须明确标注来源。',
        source: 'preset', status: 'active', editable: true, adapterRef: 'behavior:1',
      },
      {
        id: 'output:1', type: 'output', value: '输出结构化验证结果。',
        source: 'preset', status: 'active', editable: true, adapterRef: 'output:1',
      },
      {
        id: 'capability:web-search', type: 'capability',
        value: { name: 'Web Search', tool: 'web_search', enabled: true },
        source: 'runtime', status: 'active', editable: true, adapterRef: 'search',
      },
    ],
    runtime: {
      tools: ['web_search'], promptSections: ['deployment:persona'], skills: [], delegations: [],
      permissions: null,
    },
    mappingGaps: [],
  },
} as const

/** Temporary fixture data for previewing Blueprint inside the production Web UI. */
export const BLUEPRINT_DEMO_FIXTURE = {
  preferredPresetId: 'structure-demo',
  seeds: [STRUCTURE_DEMO_SEED],
  creatorScenario: STRUCTURE_DEMO_SEED,
} as const
