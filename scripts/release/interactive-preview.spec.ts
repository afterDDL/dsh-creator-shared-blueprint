import { describe, expect, it } from 'vitest'
import {
  assertPortableArtifactText,
  compatibilityManifest,
  completeArchiveEntries,
  completeBuildManifest,
  completeBuildWorkspace,
  INTERACTIVE_PREVIEW_BASELINE,
  INTERACTIVE_PREVIEW_PACKAGE,
  INTERACTIVE_PREVIEW_VERSION,
} from './interactive-preview.ts'

describe('Interactive Preview release packaging', () => {
  it('rejects host-specific paths in generated artifact text', () => {
    expect(() => assertPortableArtifactText('//#region C:\\Users\\builder\\checkout\\client.ts', []))
      .toThrow('Windows user directory')
    expect(() => assertPortableArtifactText('//#region /home/builder/checkout/client.ts', []))
      .toThrow('Linux home directory')
    expect(() => assertPortableArtifactText('//#region src/client/BlueprintUi.module.css', ['C:\\build\\checkout']))
      .not.toThrow()
  })

  it('creates stable package-rooted Complete Build archive entries', () => {
    expect(completeArchiveEntries(['scripts\\start.mjs', 'pnpm-lock.yaml', 'package.json'])).toEqual([
      'package/package.json',
      'package/pnpm-lock.yaml',
      'package/scripts/start.mjs',
    ])
  })

  it('uses a neutral standalone identity and relative Complete Build dependencies', () => {
    const manifest = completeBuildManifest({
      dependencies: new Map([
        ['@deepseek-ai/dsh', 'file:packages/deepseek-ai-dsh-0.1.0-rc.7.tgz'],
        [INTERACTIVE_PREVIEW_PACKAGE, `file:packages/${INTERACTIVE_PREVIEW_PACKAGE}-${INTERACTIVE_PREVIEW_VERSION}.tgz`],
      ]),
      standaloneFilename: `${INTERACTIVE_PREVIEW_PACKAGE}-${INTERACTIVE_PREVIEW_VERSION}.tgz`,
    })

    expect(manifest).toMatchObject({
      version: INTERACTIVE_PREVIEW_VERSION,
      private: true,
      dependencies: {
        [INTERACTIVE_PREVIEW_PACKAGE]: `file:packages/${INTERACTIVE_PREVIEW_PACKAGE}-${INTERACTIVE_PREVIEW_VERSION}.tgz`,
      },
    })
    expect(JSON.stringify(manifest)).not.toContain('@deepseek-ai/dsh-shared-blueprint')
    expect(JSON.stringify(manifest)).not.toMatch(/[A-Z]:\\/)
  })

  it('names an exact compatibility checkout without claiming untouched rc7 support', () => {
    const manifest = compatibilityManifest('0123456789abcdef')

    expect(manifest).toMatchObject({
      format: 'exact-branch',
      officialBaseline: { commit: INTERACTIVE_PREVIEW_BASELINE },
      compatibleCheckout: { commit: '0123456789abcdef' },
    })
    expect(JSON.stringify(manifest)).toContain('unsupported')
  })

  it('overrides transitive DSH dependencies to bundle-local tarballs', () => {
    const workspace = completeBuildWorkspace(new Map([
      ['@deepseek-ai/dsh-subprocess-local', 'file:packages/subprocess-local.tgz'],
      ['@deepseek-ai/dsh-tool-agent-preset-authoring', 'file:packages/tool-authoring.tgz'],
      [INTERACTIVE_PREVIEW_PACKAGE, `file:packages/${INTERACTIVE_PREVIEW_PACKAGE}-${INTERACTIVE_PREVIEW_VERSION}.tgz`],
    ]))

    expect(workspace).toContain('"@deepseek-ai/dsh-tool-agent-preset-authoring": "file:packages/tool-authoring.tgz"')
    expect(workspace).toContain('"dsh-shared-blueprint": "file:packages/dsh-shared-blueprint-0.1.0-beta.1.tgz"')
    expect(workspace).toContain('"@deepseek-ai/dsh-subprocess-local@file:packages/subprocess-local.tgz": true')
    expect(workspace).toContain('allowBuilds:')
    expect(workspace).not.toMatch(/[A-Z]:\\/u)
  })
})
