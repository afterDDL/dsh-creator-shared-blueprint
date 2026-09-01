/** Build the browser-only Blueprint Demo with its generated Commands client descriptor. */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { WorkspaceTypertGenerator } from '../packages/typert/generator/src/index.ts'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const generatedRoot = resolve(repositoryRoot, 'dist/.blueprint-static-generated')

await rm(generatedRoot, { recursive: true, force: true })
await mkdir(generatedRoot, { recursive: true })
try {
  const artifact = new WorkspaceTypertGenerator(repositoryRoot)
    .generate(['@deepseek-ai/dsh-commands'], ['host'])[0]
  if (artifact?.remote === undefined) throw new Error('blueprint static demo: missing generated Commands Remote')
  await writeFile(resolve(generatedRoot, 'commands.js'), artifact.remote.js, 'utf8')
  await execa('pnpm', [
    '--filter', '@deepseek-ai/dsh-web-frontend',
    'exec', 'vite', 'build', '--config', resolve(repositoryRoot, 'apps/blueprint-demo-static/vite.config.ts'),
  ], {
    cwd: repositoryRoot,
    env: { ...process.env, DSH_BLUEPRINT_STATIC_GENERATED: generatedRoot },
    stdio: 'inherit',
  })
} finally {
  await rm(generatedRoot, { recursive: true, force: true })
}
