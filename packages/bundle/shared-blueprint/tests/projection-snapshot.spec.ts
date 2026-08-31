import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import BlueprintAdapter from '../src/host/index.ts'

const FIXTURE_PLUGIN = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'runtime.js')

/** One projection generation with mutually identifying text, Tool, and Skill registrations. */
function composition(generation: 'old' | 'new'): string {
  const search = generation === 'old'
  return `- id: persona
  name: '${pathToFileURL(FIXTURE_PLUGIN).href}'
  config:
    text: >-
      你是一名${generation} generation researcher，由 {{model}} 驱动，工作目录是 {{cwd}}。

      你的职责是处理 ${generation} generation research。
    skill:
      name: generation-${generation}
      description: Handle the ${generation} projection generation.
      content: Use only the ${generation} projection generation.
      invocation:
        modelInvocable: true
        userInvocable: true
- id: tool-web
  name: '${pathToFileURL(FIXTURE_PLUGIN).href}'
  config:
    search: ${String(search)}
    fetch: ${String(!search)}
`
}

/** Boot the smallest real Host assembly that can project a committed Blueprint. */
async function harness(root: string): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentPresets, {
    default: 'projection-target',
    roots: [{ path: root, trust: 'user' }],
    includeUserRoot: false,
  })
  await ctx.plugin(BlueprintAdapter)
  return ctx
}

describe('committed Blueprint projection snapshots', () => {
  it('reuses one standing generation when publication lands between assembly and Skill projection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-blueprint-projection-snapshot-'))
    const target = join(root, 'projection-target')
    await mkdir(target)
    await writeFile(join(target, 'agent.cordis.yml'), composition('old'))
    const ctx = await harness(root)
    try {
      const before = await ctx.blueprintAdapter.read('projection-target', { cwd: root })
      expect(before.runtime.tools).toContain('web_search')
      expect(before.runtime.skills.map(skill => skill.name)).toContain('generation-old')
      const transaction = await ctx.agentPresets.prepareTransaction('projection-target', {
        key: 'external-projection-update',
        expectedRevision: before.revision,
      })
      const candidate = await ctx.agentPresets.resolveTransaction(transaction)
      await writeFile(candidate.path, composition('new'))
      const candidateTreeDigest = await ctx.agentPresets.fenceTransaction(transaction)

      const assemble = ctx.systemPrompt.assemble.bind(ctx.systemPrompt)
      let published = false
      vi.spyOn(ctx.systemPrompt, 'assemble').mockImplementation(async (request = {}) => {
        const assembly = await assemble(request)
        if (!published && request.scope !== undefined) {
          published = true
          await ctx.agentPresets.publishTransaction(transaction, candidateTreeDigest)
        }
        return assembly
      })

      const concurrent = await ctx.blueprintAdapter.read('projection-target', { cwd: root })

      expect(published).toBe(true)
      expect(concurrent.revision).toBe(before.revision)
      expect(concurrent.runtime.tools).toContain('web_search')
      expect(concurrent.runtime.tools).not.toContain('web_fetch')
      expect(concurrent.runtime.skills.map(skill => skill.name)).toContain('generation-old')
      expect(concurrent.runtime.skills.map(skill => skill.name)).not.toContain('generation-new')

      const after = await ctx.blueprintAdapter.read('projection-target', { cwd: root })
      expect(after.revision).not.toBe(before.revision)
      expect(after.runtime.tools).toContain('web_fetch')
      expect(after.runtime.tools).not.toContain('web_search')
      expect(after.runtime.skills.map(skill => skill.name)).toContain('generation-new')
      expect(after.runtime.skills.map(skill => skill.name)).not.toContain('generation-old')
      await ctx.agentPresets.cleanupTransaction(transaction)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
