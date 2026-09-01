import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { load } from 'js-yaml'
import tsconfigPaths from 'vite-tsconfig-paths'
import webConfig from '../web/vite.config.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(here, '../..')
const require = createRequire(resolve(repositoryRoot, 'packages/bundle/shared-blueprint/package.json'))
const webRequire = createRequire(resolve(repositoryRoot, 'apps/web/package.json'))
const generatedRoot = process.env['DSH_BLUEPRINT_STATIC_GENERATED']
if (generatedRoot === undefined) throw new Error('blueprint static demo: generated Remote directory is unset')

interface DemoPatchRow {
  id?: unknown
  config?: { demoBootstrapJson?: unknown }
}

const patch = load(readFileSync(resolve(repositoryRoot, 'examples/web-blueprint-demo/cordis.yml'), 'utf8')) as DemoPatchRow[]
const bootstrapJson = patch.find(row => row.id === 'shared-blueprint')?.config?.demoBootstrapJson
if (typeof bootstrapJson !== 'string') throw new Error('blueprint static demo: demoBootstrapJson is missing')
const seed = JSON.parse(bootstrapJson) as unknown

const base = webConfig
const connectionIndex = resolve(repositoryRoot, 'packages/client/connection/src/client/index.ts').replaceAll('\\', '/')
const staticFixture = resolve(here, 'src/fixture.ts')

export default {
  ...base,
  root: here,
  base: process.env['DSH_BLUEPRINT_DEMO_BASE'] ?? '/dsh-creator-shared-blueprint/',
  publicDir: resolve(repositoryRoot, 'apps/web/public'),
  plugins: [
    {
      name: 'blueprint-demo-static-fixture',
      enforce: 'pre',
      resolveId(source, importer) {
        if (source === './fixture.ts' && importer?.replaceAll('\\', '/') === connectionIndex) return staticFixture
        return null
      },
    },
    ...(base.plugins ?? []),
    tsconfigPaths({ projects: [resolve(repositoryRoot, 'tsconfig.base.json')] }),
  ],
  resolve: {
    ...base.resolve,
    alias: [
      { find: '@deepseek-ai/dsh-commands/remote', replacement: resolve(generatedRoot, 'commands.js') },
      { find: 'react-dom/client', replacement: webRequire.resolve('react-dom/client') },
      { find: 'zod', replacement: require.resolve('zod') },
      { find: 'dsh-shared-blueprint/remote', replacement: resolve(here, 'src/remote-stub.ts') },
      {
        find: '@deepseek-ai/dsh-client-ui-theme/styles',
        replacement: resolve(repositoryRoot, 'packages/client/ui-theme/src/styles'),
      },
      ...Array.isArray(base.resolve?.alias) ? base.resolve.alias : [],
    ],
  },
  define: {
    ...base.define,
    __DSH_BLUEPRINT_DEMO_SEED__: JSON.stringify(seed),
  },
  build: {
    ...base.build,
    outDir: resolve(repositoryRoot, 'dist/dsh-creator-shared-blueprint'),
    emptyOutDir: true,
    sourcemap: false,
  },
}
