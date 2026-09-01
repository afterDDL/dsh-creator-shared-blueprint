/** Build the two Shared Blueprint Interactive Preview release candidates from one clean commit. */

import { createHash } from 'node:crypto'
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { validateTarballPayload } from '../publication-payload.ts'
import { releaseFamily, tarballName, type ReleaseMember } from './families.ts'
import { capture, isEntry, npmInvocation, run } from './process.ts'
import { packedIdentity, tarballFiles } from './tarball.ts'

export const INTERACTIVE_PREVIEW_VERSION = '0.1.0-beta.1'
export const INTERACTIVE_PREVIEW_BASELINE = '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca'
export const INTERACTIVE_PREVIEW_BRANCH = 'release/interactive-preview-v0.1'
export const INTERACTIVE_PREVIEW_PACKAGE = 'dsh-shared-blueprint'
const PRODUCT_NAME = 'Shared Blueprint Interactive Preview'
const REPOSITORY_URL = 'https://github.com/afterDDL/dsh-creator-shared-blueprint.git'
const PACKAGE_DIRECTORY = 'packages/bundle/shared-blueprint'
const RELEASE_DOCS_DIRECTORY = 'release/interactive-preview'
const DEFAULT_OUTPUT = `.artifacts/releases/shared-blueprint-interactive-preview-v${INTERACTIVE_PREVIEW_VERSION}`

const COMPATIBILITY_COMMITS = [
  { sha: 'ba6ba7dec9', capability: 'durable custom Session event registration' },
  { sha: '1a589e2dc7', capability: 'bundled durable event owner identity' },
  { sha: '8eb7cfed6d', capability: 'replacement-aware conversation location references' },
  { sha: 'b27d5fb284', capability: 'preset-ready Session creation' },
  { sha: '00c8d2f5fd', capability: 'isolated AgentPreset publication transactions' },
  { sha: '28902c539d', capability: 'conversation presentation contributions' },
  { sha: 'eecdbcdd97', capability: 'default conversation details contribution' },
  { sha: '9c861a0086', capability: 'additive Sidebar navigation contributions' },
] as const

interface CompleteBuildManifestOptions {
  readonly dependencies: ReadonlyMap<string, string>
  readonly standaloneFilename: string
}

/**
 * Create the portable Complete Build manifest.
 * @param options - packed dependencies and standalone tarball filename.
 * @returns A manifest whose dependency locations remain relative after extraction.
 */
export function completeBuildManifest(options: CompleteBuildManifestOptions): Record<string, unknown> {
  return {
    name: 'shared-blueprint-interactive-preview-complete-build',
    version: INTERACTIVE_PREVIEW_VERSION,
    private: true,
    description: `${PRODUCT_NAME} with a compatible DSH build`,
    type: 'module',
    packageManager: 'pnpm@11.19.0',
    scripts: {
      start: 'node scripts/start.mjs',
      dsh: 'node node_modules/@deepseek-ai/dsh/lib/bin.js',
    },
    dependencies: Object.fromEntries([...options.dependencies].sort(([left], [right]) => left.localeCompare(right))),
    pnpm: {
      onlyBuiltDependencies: ['@deepseek-ai/dsh-subprocess-local', 'esbuild', 'koffi', 'node-pty'],
      ignoredBuiltDependencies: ['@google/genai', 'node-addon-require-builtin', 'protobufjs'],
    },
    files: ['packages', 'scripts', 'INSTALL.md', 'COMPATIBILITY.md', 'RELEASE_NOTES.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'pnpm-lock.yaml'],
    dshSharedBlueprint: { packageTarball: `packages/${options.standaloneFilename}` },
  }
}

/**
 * Describe the exact compatibility checkout instead of claiming a non-applicable squashed patch.
 * @param head - verified release commit.
 * @returns Machine-readable compatibility identity and application steps.
 */
export function compatibilityManifest(head: string): Record<string, unknown> {
  return {
    product: PRODUCT_NAME,
    version: INTERACTIVE_PREVIEW_VERSION,
    format: 'exact-branch',
    officialBaseline: {
      version: '0.1.0-rc.7',
      commit: INTERACTIVE_PREVIEW_BASELINE,
    },
    compatibleCheckout: {
      repository: REPOSITORY_URL,
      branch: INTERACTIVE_PREVIEW_BRANCH,
      commit: head,
    },
    genericSeamCommits: COMPATIBILITY_COMMITS,
    unsupported: 'untouched official DSH 0.1.0-rc.7 plus the standalone bundle',
    application: [
      `git clone --branch ${INTERACTIVE_PREVIEW_BRANCH} ${REPOSITORY_URL}`,
      `git checkout ${head}`,
    ],
  }
}

/** SHA-256 for one artifact. */
function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Copy one family's clean tarballs into a private work directory. */
function packFamily(root: string, familyId: 'dsh' | 'vendor', destination: string): string[] {
  const family = releaseFamily(familyId)
  const members = family.publishOrder(family.members(root)).order
  family.verifyVersions(members)
  mkdirSync(destination, { recursive: true })
  const filenames: string[] = []
  for (const member of members) filenames.push(packMember(root, member, destination, family.validatePayload.bind(family)))
  return filenames
}

/** Pack one package and validate its public payload. */
function packMember(
  root: string,
  member: ReleaseMember,
  destination: string,
  validate: (member: ReleaseMember, files: readonly string[]) => void,
): string {
  run('pnpm', ['--dir', member.directory, 'pack', '--pack-destination', destination], { cwd: root })
  const filename = tarballName(member)
  const path = join(destination, filename)
  if (!existsSync(path)) throw new Error(`${member.name} produced no tarball at ${path}`)
  validate(member, tarballFiles(path))
  return filename
}

/** Browser launcher carried by the Complete Build. */
function completeBuildLauncher(standaloneFilename: string): string {
  return `import { existsSync, readFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dsh = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const bundle = join(root, 'packages', ${JSON.stringify(standaloneFilename)})
const home = process.env.DSH_HOME ?? join(root, '.dsh')
const environment = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: process.env.DSH_TELEMETRY_DISABLED ?? '1' }
const profile = join(home, 'profiles', 'web', 'package.json')
let installed = false
if (existsSync(profile)) {
  const manifest = JSON.parse(readFileSync(profile, 'utf8'))
  installed = typeof manifest.dependencies?.[${JSON.stringify(INTERACTIVE_PREVIEW_PACKAGE)}] === 'string'
}
if (!installed) {
  const result = spawnSync(process.execPath, [dsh, 'plugin', '--profile', 'web', 'add', bundle], { cwd: root, env: environment, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
const child = spawn(process.execPath, [dsh, 'web', ...process.argv.slice(2)], { cwd: root, env: environment, stdio: 'inherit' })
child.on('error', error => { throw error })
child.on('exit', (code, signal) => signal === null ? process.exit(code ?? 1) : process.kill(process.pid, signal))
`
}

/** Assert that generation cannot erase an arbitrary directory. */
function assertSafeOutput(root: string, output: string): void {
  const artifacts = resolve(root, '.artifacts')
  const resolved = resolve(output)
  if (resolved === artifacts || !resolved.startsWith(`${artifacts}\\`) && !resolved.startsWith(`${artifacts}/`)) {
    throw new Error(`release output must be a child of ${artifacts}`)
  }
}

/** Copy release-facing source documentation into one artifact directory. */
function copyReleaseDocs(root: string, destination: string): void {
  for (const filename of ['INSTALL.md', 'COMPATIBILITY.md', 'ARCHITECTURE.md', 'RELEASE_NOTES.md', 'DRAFT_RELEASE.md']) {
    copyFileSync(join(root, RELEASE_DOCS_DIRECTORY, filename), join(destination, filename))
  }
}

/** Build and stage both Interactive Preview release candidates. */
function main(): void {
  const { values } = parseArgs({
    options: { out: { type: 'string' }, 'skip-build': { type: 'boolean', default: false } },
    allowPositionals: false,
  })
  const root = process.cwd()
  const output = resolve(root, values.out ?? DEFAULT_OUTPUT)
  assertSafeOutput(root, output)
  const branch = capture('git', ['branch', '--show-current'], { cwd: root })
  if (branch !== INTERACTIVE_PREVIEW_BRANCH) throw new Error(`release packaging requires ${INTERACTIVE_PREVIEW_BRANCH}, got ${branch}`)
  if (capture('git', ['status', '--porcelain'], { cwd: root }) !== '') throw new Error('release packaging requires a clean working tree')
  const head = capture('git', ['rev-parse', 'HEAD'], { cwd: root })
  if (!values['skip-build']) run('pnpm', ['run', 'build'], { cwd: root })

  rmSync(output, { recursive: true, force: true })
  const work = join(output, '.work')
  const artifacts = join(output, 'artifacts')
  mkdirSync(work, { recursive: true })
  mkdirSync(artifacts, { recursive: true })

  const dshTarballs = packFamily(root, 'dsh', join(work, 'dsh'))
  const vendorTarballs = packFamily(root, 'vendor', join(work, 'vendor'))
  const standaloneDirectory = join(work, 'standalone')
  mkdirSync(standaloneDirectory, { recursive: true })
  run('pnpm', ['--dir', PACKAGE_DIRECTORY, 'pack', '--pack-destination', standaloneDirectory], { cwd: root })
  const standaloneFilename = `${INTERACTIVE_PREVIEW_PACKAGE}-${INTERACTIVE_PREVIEW_VERSION}.tgz`
  const standaloneWorkPath = join(standaloneDirectory, standaloneFilename)
  if (!existsSync(standaloneWorkPath)) throw new Error(`standalone package produced no ${standaloneFilename}`)
  validateTarballPayload(tarballFiles(standaloneWorkPath), INTERACTIVE_PREVIEW_PACKAGE)
  const standaloneIdentity = packedIdentity(standaloneWorkPath)
  if (standaloneIdentity.name !== INTERACTIVE_PREVIEW_PACKAGE || standaloneIdentity.version !== INTERACTIVE_PREVIEW_VERSION) {
    throw new Error(`unexpected standalone identity ${standaloneIdentity.name}@${standaloneIdentity.version}`)
  }
  const standalonePath = join(artifacts, standaloneFilename)
  copyFileSync(standaloneWorkPath, standalonePath)

  const completeRoot = join(work, 'complete-build')
  const completePackages = join(completeRoot, 'packages')
  mkdirSync(completePackages, { recursive: true })
  mkdirSync(join(completeRoot, 'scripts'), { recursive: true })
  const dependencies = new Map<string, string>()
  for (const [directory, filenames] of [[join(work, 'dsh'), dshTarballs], [join(work, 'vendor'), vendorTarballs]] as const) {
    for (const filename of filenames) {
      const source = join(directory, filename)
      copyFileSync(source, join(completePackages, filename))
      dependencies.set(packedIdentity(source).name, `file:packages/${filename}`)
    }
  }
  copyFileSync(standaloneWorkPath, join(completePackages, standaloneFilename))
  dependencies.set(INTERACTIVE_PREVIEW_PACKAGE, `file:packages/${standaloneFilename}`)
  writeFileSync(join(completeRoot, 'package.json'), `${JSON.stringify(completeBuildManifest({ dependencies, standaloneFilename }), null, 2)}\n`)
  writeFileSync(join(completeRoot, 'scripts', 'start.mjs'), completeBuildLauncher(standaloneFilename))
  for (const filename of ['INSTALL.md', 'COMPATIBILITY.md', 'RELEASE_NOTES.md']) {
    copyFileSync(join(root, RELEASE_DOCS_DIRECTORY, filename), join(completeRoot, filename))
  }
  copyFileSync(join(root, 'LICENSE'), join(completeRoot, 'LICENSE'))
  copyFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), join(completeRoot, 'THIRD_PARTY_NOTICES.md'))
  run('pnpm', ['install', '--lockfile-only', '--ignore-scripts', '--config.optional=false'], { cwd: completeRoot })
  if (existsSync(join(completeRoot, 'node_modules'))) rmSync(join(completeRoot, 'node_modules'), { recursive: true, force: true })
  const npm = npmInvocation(['pack', '--pack-destination', artifacts])
  run(npm.command, npm.args, { cwd: completeRoot })
  const completeFilename = `shared-blueprint-interactive-preview-complete-build-${INTERACTIVE_PREVIEW_VERSION}.tgz`
  const completePath = join(artifacts, completeFilename)
  if (!existsSync(completePath)) throw new Error(`Complete Build produced no ${completeFilename}`)

  const compatibilityFilename = `shared-blueprint-interactive-preview-compatibility-${INTERACTIVE_PREVIEW_VERSION}.json`
  const compatibilityPath = join(artifacts, compatibilityFilename)
  writeFileSync(compatibilityPath, `${JSON.stringify(compatibilityManifest(head), null, 2)}\n`)
  copyReleaseDocs(root, output)
  copyFileSync(join(root, 'LICENSE'), join(output, 'LICENSE'))
  copyFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), join(output, 'THIRD_PARTY_NOTICES.md'))

  const checksums = [completePath, standalonePath, compatibilityPath]
    .sort((left, right) => basename(left).localeCompare(basename(right)))
    .map(path => `${sha256(path)}  artifacts/${basename(path)}`)
  writeFileSync(join(output, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`)
  const manifest = {
    product: PRODUCT_NAME,
    version: INTERACTIVE_PREVIEW_VERSION,
    status: 'release-candidate',
    git: { branch, commit: head },
    dshBaseline: { version: '0.1.0-rc.7', commit: INTERACTIVE_PREVIEW_BASELINE },
    compatibility: { format: 'exact-branch', artifact: compatibilityFilename, sha256: sha256(compatibilityPath) },
    standaloneBundle: { filename: standaloneFilename, bytes: statSync(standalonePath).size, sha256: sha256(standalonePath) },
    completeBuild: { filename: completeFilename, bytes: statSync(completePath).size, sha256: sha256(completePath) },
    testResult: 'PENDING_FINAL_ARTIFACT_SMOKE',
    publication: { npm: false, githubRelease: false, tag: false },
  }
  writeFileSync(join(output, 'RELEASE_MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  rmSync(work, { recursive: true, force: true })
  console.log(`Interactive Preview release candidate staged at ${relative(root, output)}`)
}

if (isEntry(import.meta.url)) main()
