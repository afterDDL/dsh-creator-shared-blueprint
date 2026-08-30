// Import-free preset fixture used through Cordis Loader's real composition path.
export const name = 'blueprint-runtime-fixture'
export const inject = ['tools', 'systemPrompt', 'skills']

export function apply(ctx, config) {
  if (config.skill !== undefined) {
    ctx.effect(() => ctx.skills.register({
      name: config.skill.name,
      description: config.skill.description,
      content: config.skill.content,
      source: 'fixture',
      invocation: config.skill.invocation,
    }))
  }
  if (typeof config.text === 'string') {
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'deployment:persona',
      order: 0,
      text: config.text,
    }))
  }
  for (const [field, tool] of [['search', 'web_search'], ['fetch', 'web_fetch']]) {
    if (config[field] !== true) continue
    ctx.effect(() => ctx.tools.register({
      name: tool,
      description: `fixture schema for ${tool}`,
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      execute: () => Promise.resolve(tool),
    }))
  }
}
