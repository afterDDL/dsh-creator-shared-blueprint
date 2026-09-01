/** Self-contained Host and browser builds for the installable Interactive Blueprint bundle. */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'
import { typertPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown'

const PACKAGE_NAME = 'dsh-shared-blueprint'
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))
const CSS_VIRTUAL_PREFIX = '\0shared-blueprint-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
] as const

const host: UserConfig = {
  name: PACKAGE_NAME,
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  outputOptions: { codeSplitting: false },
  dts: false,
  clean: false,
  plugins: [typertPlugin({ mode: 'package', faces: ['host'] })],
}

const invariant: UserConfig = {
  ...host,
  name: `${PACKAGE_NAME}/invariant`,
  entry: ['lib/types/invariant.js'],
  plugins: [],
}

const client: UserConfig = {
  name: `${PACKAGE_NAME}/client`,
  entry: { client: 'lib/types/client/index.js' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id as typeof CLIENT_EXTERNALS[number]) ? undefined : true),
  plugins: [{
    name: 'shared-blueprint-generated-remote',
    resolveId(source: string) {
      return source === `${PACKAGE_NAME}/remote`
        ? resolvePath(PACKAGE_DIR, 'lib/typert.remote-client.js')
        : null
    },
  }, {
    name: 'shared-blueprint-css-modules',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const file = importer === undefined ? resolvePath(source) : sourceAssetPath(source, importer)
      return CSS_VIRTUAL_PREFIX + packageAssetId(file) + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX) || !virtualId.endsWith(CSS_VIRTUAL_SUFFIX)) return null
      const assetId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      const file = resolvePath(PACKAGE_DIR, assetId)
      if (packageAssetId(file) !== assetId) throw new Error(`shared-blueprint: invalid CSS asset id ${assetId}`)
      this.addWatchFile(file)
      const result = transform({
        filename: assetId,
        code: await readFile(file),
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classes: Record<string, string> = {}
      for (const [local, value] of Object.entries(result.exports ?? {})) classes[local] = value.name
      const tagId = `${PACKAGE_NAME}/${basename(file)}`
      return [
        `const css = ${JSON.stringify(result.code.toString())};`,
        `const tagId = ${JSON.stringify(tagId)};`,
        'if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {',
        '  const tag = document.createElement("style");',
        `  tag.dataset.plugin = ${JSON.stringify(PACKAGE_NAME)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classes)};`,
      ].join('\n')
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

/** Select the package-local build without any repository build helper. */
export default function config({ env }: Pick<UserConfig, 'env'>): UserConfig[] {
  const face = env?.DSH_BUILD_FACE
  if (face === undefined) return [host, invariant, client]
  if (face === 'host') return [host, invariant]
  if (face === 'client') return [client]
  throw new Error(`shared-blueprint: DSH_BUILD_FACE must be host or client, received ${String(face)}`)
}

function sourceAssetPath(source: string, importer: string): string {
  const emitted = resolvePath(dirname(importer), source)
  if (existsSync(emitted)) return emitted
  const marker = `${sep}lib${sep}types${sep}`
  const boundary = emitted.indexOf(marker)
  return boundary < 0
    ? emitted
    : resolvePath(emitted.slice(0, boundary), 'src', emitted.slice(boundary + marker.length))
}

/** Stable package-local identity for generated CSS modules and class hashes. */
function packageAssetId(file: string): string {
  const id = relative(PACKAGE_DIR, file)
  if (id === '' || id === '..' || id.startsWith(`..${sep}`) || isAbsolute(id)) {
    throw new Error(`shared-blueprint: CSS asset must be package-local, received ${file}`)
  }
  return id.split(sep).join('/')
}
