/** Keyless Loader entry projecting the real Creator working-method persona. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-blueprint-adapter'

const root = await mkdtemp(join(tmpdir(), 'dsh-behavior-snapshot-'))
process.env.DSH_BLUEPRINT_TEST_PRESETS = root
const fixture = new URL('./fixtures/preset/blueprint-adapter/creator-working-method.cordis.yml', import.meta.url)
await mkdir(join(root, 'research'))
await writeFile(join(root, 'research', 'agent.cordis.yml'), await readFile(fixture))
const ctx = await boot('behavior-projection', fileURLToPath(new URL('../subagent-completion.cordis.yml', import.meta.url)))
try {
  const blueprint = await ctx.blueprintAdapter.read('research', { cwd: root })
  process.stdout.write(JSON.stringify({
    nodes: blueprint.nodes.filter(node => ['identity', 'purpose', 'behavior', 'output'].includes(node.type)),
    behaviorGaps: blueprint.mappingGaps.filter(gap => gap.field === 'behavior'),
  }) + '\n')
} finally {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}
