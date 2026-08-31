import { Context, Service } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { AgentPreset } from '@deepseek-ai/dsh-agent-presets'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import * as PresetAuthoringTools from '../src/index.ts'

const signal = new AbortController().signal

class FakeAgentPresets extends Service {
  readonly rows: AgentPreset[] = [
    { id: 'standard', trust: 'system', path: '/shipped/standard/agent.cordis.yml' },
    {
      id: 'reference', trust: 'user', path: '/user/reference/agent.cordis.yml',
      name: 'Reference', description: 'Reference preset.', order: 3, broken: 'damaged',
    },
  ]

  readonly copies: Array<{ from: string; id: string; name?: string }> = []
  readonly validations: string[] = []
  readonly scopedCalls: Array<{ method: string; ctx: Context }> = []
  overlayFor: Context | undefined

  constructor(ctx: Context) {
    super(ctx, 'agentPresets')
  }

  async list(): Promise<AgentPreset[]> {
    return this.rows
  }

  async listFor(agentCtx: Context): Promise<AgentPreset[]> {
    this.scopedCalls.push({ method: 'list', ctx: agentCtx })
    return this.rows
  }

  async read(id: string): Promise<string> {
    await this.resolve(id)
    return `- id: ${id}\n`
  }

  async readFor(agentCtx: Context, id: string): Promise<string> {
    this.scopedCalls.push({ method: 'read', ctx: agentCtx })
    return await this.read(id)
  }

  async resolve(id: string): Promise<AgentPreset> {
    const preset = this.rows.find(row => row.id === id)
    if (preset === undefined) throw new Error(`unknown preset ${id}`)
    return preset
  }

  async resolveFor(agentCtx: Context, id: string): Promise<AgentPreset> {
    this.scopedCalls.push({ method: 'resolve', ctx: agentCtx })
    return await this.resolve(id)
  }

  async copy(from: string, id: string, name?: string): Promise<void> {
    await this.resolve(from)
    if (this.rows.some(row => row.id === id)) throw new Error(`preset ${id} already exists`)
    this.copies.push({ from, id, ...(name === undefined ? {} : { name }) })
    this.rows.push({ id, trust: 'user', path: `/user/${id}/agent.cordis.yml`, ...(name === undefined ? {} : { name }) })
  }

  async copyFor(agentCtx: Context, from: string, id: string, name?: string): Promise<void> {
    this.scopedCalls.push({ method: 'copy', ctx: agentCtx })
    if (this.overlayFor === agentCtx) throw new Error('candidate copy refused')
    await this.copy(from, id, name)
  }

  async standingKeyFor(id: string): Promise<object> {
    await this.resolve(id)
    this.validations.push(id)
    return { agentPreset: id }
  }

  async validateFor(agentCtx: Context, id: string): Promise<void> {
    this.scopedCalls.push({ method: 'validate', ctx: agentCtx })
    this.validations.push(id)
  }
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FakeAgentPresets)
  const fiber = await ctx.plugin(PresetAuthoringTools)
  return { ctx, fiber, service: ctx.agentPresets as unknown as FakeAgentPresets }
}

async function call(
  ctx: Context,
  name: string,
  args: unknown,
  agent?: NonNullable<ToolExecutionInput['agent']>,
) {
  return await ctx.tools.execute({
    signal,
    callId: CallId(`call-${name}`),
    name,
    arguments: args,
    ...(agent === undefined ? {} : { agent }),
  })
}

describe('Creator preset authoring tools', () => {
  it('registers the fixed schemas and removes them with its preset fiber', async () => {
    const { ctx, fiber } = await setup()
    const schemas = ctx.tools.schemas()
    expect(schemas.map(schema => schema.name).sort()).toEqual([
      'preset_copy', 'preset_list', 'preset_read', 'preset_resolve', 'preset_validate',
    ])
    expect(schemas.find(schema => schema.name === 'preset_list')?.description)
      .toContain('do not inspect the Tool registry first')
    expect(schemas.find(schema => schema.name === 'preset_copy')?.parameters.required).toEqual(['from', 'id'])

    await fiber.dispose()
    expect(ctx.tools.schemas()).toEqual([])
  })

  it('forwards list, read, resolve, copy, and validation to the preset service', async () => {
    const { ctx, service } = await setup()

    const listed = await call(ctx, 'preset_list', {})
    expect(listed).toMatchObject({
      isError: false,
      value: { presets: [
        { id: 'standard', trust: 'system', path: '/shipped/standard/agent.cordis.yml' },
        {
          id: 'reference', trust: 'user', path: '/user/reference/agent.cordis.yml',
          name: 'Reference', description: 'Reference preset.', order: 3, broken: 'damaged',
        },
      ] },
    })
    const listedContent = listed.content[0]
    expect(listedContent?.type).toBe('text')
    if (listedContent?.type !== 'text') throw new Error('preset_list must render one text block')
    expect(listedContent.text).toContain('"reference"')

    const read = await call(ctx, 'preset_read', { id: 'standard' })
    expect(read).toMatchObject({
      isError: false, value: { id: 'standard', composition: '- id: standard\n' },
      content: [{ type: 'text', text: '- id: standard\n' }],
    })

    const resolved = await call(ctx, 'preset_resolve', { id: 'reference' })
    expect(resolved).toMatchObject({ isError: false, value: { preset: { id: 'reference', broken: 'damaged' } } })

    const copied = await call(ctx, 'preset_copy', { from: 'standard', id: 'study-germany', name: '德国留学选校' })
    expect(copied).toMatchObject({
      isError: false,
      value: { preset: { id: 'study-germany', trust: 'user', name: '德国留学选校' } },
    })
    expect(service.copies).toEqual([{ from: 'standard', id: 'study-germany', name: '德国留学选校' }])

    const validated = await call(ctx, 'preset_validate', { id: 'study-germany' })
    expect(validated).toEqual({
      isError: false,
      value: { id: 'study-germany', status: 'mounted' },
      content: [{ type: 'text', text: 'mounted OK for study-germany' }],
    })
    expect(service.validations).toEqual(['study-germany'])

    const duplicate = await call(ctx, 'preset_copy', { from: 'standard', id: 'study-germany' })
    expect(duplicate.isError).toBe(true)
    expect(duplicate.content).toEqual([{ type: 'text', text: 'Error: preset study-germany already exists' }])
  })

  it('addresses the executing Creator overlay and refuses copy while it is active', async () => {
    const { ctx, service } = await setup()
    const creator = { ctx } as NonNullable<ToolExecutionInput['agent']>
    service.overlayFor = ctx

    await expect(call(ctx, 'preset_list', {}, creator)).resolves.toMatchObject({ isError: false })
    await expect(call(ctx, 'preset_read', { id: 'standard' }, creator)).resolves.toMatchObject({ isError: false })
    await expect(call(ctx, 'preset_resolve', { id: 'standard' }, creator)).resolves.toMatchObject({ isError: false })
    await expect(call(ctx, 'preset_validate', { id: 'standard' }, creator)).resolves.toMatchObject({ isError: false })
    const copied = await call(ctx, 'preset_copy', { from: 'standard', id: 'blocked' }, creator)

    expect(copied).toMatchObject({ isError: true })
    expect(copied.content).toEqual([{ type: 'text', text: 'Error: candidate copy refused' }])
    expect(service.scopedCalls.map(call => call.method)).toEqual([
      'list', 'read', 'resolve', 'validate', 'copy',
    ])
    expect(service.scopedCalls.every(call => call.ctx === ctx)).toBe(true)
    expect(service.validations).toEqual(['standard'])
    expect(service.copies).toEqual([])
  })
})
