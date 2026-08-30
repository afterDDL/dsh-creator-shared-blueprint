/**
 * Creator-only model tools over the committed preset roster or one route-scoped candidate.
 * The plugin contributes no service or policy; the preset composition decides which agents see it.
 * @module @deepseek-ai/dsh-tool-agent-preset-authoring
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentPreset } from '@deepseek-ai/dsh-agent-presets'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'tool-agent-preset-authoring'
/** Host services consumed by the five model-facing tools. */
export const inject = ['agentPresets', 'tools']

const presetSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    trust: { type: 'string', required: true, enum: ['system', 'user'] },
    path: { type: 'string', required: true },
    name: { type: 'string' },
    description: { type: 'string' },
    order: { type: 'number' },
    broken: { type: 'string' },
  },
} as const

function projectPreset(preset: AgentPreset) {
  return {
    id: preset.id,
    trust: preset.trust,
    path: preset.path,
    ...(preset.name === undefined ? {} : { name: preset.name }),
    ...(preset.description === undefined ? {} : { description: preset.description }),
    ...(preset.order === undefined ? {} : { order: preset.order }),
    ...(preset.broken === undefined ? {} : { broken: preset.broken }),
  }
}

const renderJson = (_args: unknown, value: unknown) => [{
  type: 'text' as const,
  text: JSON.stringify(value, null, 2),
}]

/**
 * Register the fixed preset roster, read, resolve, copy, and mount-validation tools.
 * @param ctx - preset-scoped context carrying the host roster and tool registry.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'preset_list',
    description: 'List every available Agent preset. Use this directly before choosing a reference preset; do not inspect the Tool registry first.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          presets: { type: 'array', required: true, items: presetSchema },
        },
      },
      render: renderJson,
    },
    async execute(_args, exec) {
      const agentCtx = exec.agent?.ctx
      const presets = agentCtx === undefined
        ? await ctx.agentPresets.list()
        : await ctx.agentPresets.listFor(agentCtx)
      return { presets: presets.map(projectPreset) }
    },
    presentCall: () => ({ card: 'generic', title: 'List Agent presets', kind: 'search' }),
  }))

  ctx.tools.register(defineTool({
    name: 'preset_read',
    description: 'Read one Agent preset composition exactly as stored, addressed by preset id.',
    parameters: {
      id: { type: 'string', required: true, description: 'Preset id from preset_list.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          composition: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.composition }],
    },
    async execute(args, exec) {
      const agentCtx = exec.agent?.ctx
      const composition = agentCtx === undefined
        ? await ctx.agentPresets.read(args.id)
        : await ctx.agentPresets.readFor(agentCtx, args.id)
      return { id: args.id, composition }
    },
    presentCall: args => ({ card: 'generic', title: `Read preset ${args.id}`, kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'preset_resolve',
    description: 'Resolve one Agent preset id to its authoritative roster metadata and composition path.',
    parameters: {
      id: { type: 'string', required: true, description: 'Preset id to resolve.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          preset: { ...presetSchema, required: true },
        },
      },
      render: renderJson,
    },
    async execute(args, exec) {
      const agentCtx = exec.agent?.ctx
      const preset = agentCtx === undefined
        ? await ctx.agentPresets.resolve(args.id)
        : await ctx.agentPresets.resolveFor(agentCtx, args.id)
      return { preset: projectPreset(preset) }
    },
    presentCall: args => ({ card: 'generic', title: `Resolve preset ${args.id}`, kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'preset_copy',
    description: 'Create a new user Agent preset by copying an existing preset directory whole. The new id must not already exist; this is the only preset authoring write.',
    parameters: {
      from: { type: 'string', required: true, description: 'Source preset id.' },
      id: { type: 'string', required: true, description: 'New lowercase preset id using letters, digits, and hyphens.' },
      name: { type: 'string', description: 'Optional display name for the new preset.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          preset: { ...presetSchema, required: true },
        },
      },
      render: renderJson,
    },
    async execute(args, exec) {
      const agentCtx = exec.agent?.ctx
      if (agentCtx === undefined) {
        await ctx.agentPresets.copy(args.from, args.id, args.name)
      } else {
        await ctx.agentPresets.copyFor(agentCtx, args.from, args.id, args.name)
      }
      const preset = agentCtx === undefined
        ? await ctx.agentPresets.resolve(args.id)
        : await ctx.agentPresets.resolveFor(agentCtx, args.id)
      return { preset: projectPreset(preset) }
    },
    presentCall: args => ({ card: 'generic', title: `Copy preset ${args.from} to ${args.id}`, kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'preset_validate',
    description: 'Mount-validate one finished Agent preset with the same loader checks used by a new Session. A route-scoped candidate is validated privately and never enters the committed standing mount cache.',
    parameters: {
      id: { type: 'string', required: true, description: 'Preset id to mount-validate.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: ['mounted'] },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `mounted OK for ${value.id}` }],
    },
    async execute(args, exec) {
      const agentCtx = exec.agent?.ctx
      if (agentCtx === undefined) {
        await ctx.agentPresets.standingKeyFor(args.id)
      } else {
        await ctx.agentPresets.validateFor(agentCtx, args.id)
      }
      return { id: args.id, status: 'mounted' as const }
    },
    presentCall: args => ({ card: 'generic', title: `Validate preset ${args.id}`, kind: 'other' }),
  }))
}
