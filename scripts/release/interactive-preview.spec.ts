import { describe, expect, it } from 'vitest'
import {
  compatibilityManifest,
  completeBuildManifest,
  INTERACTIVE_PREVIEW_BASELINE,
  INTERACTIVE_PREVIEW_PACKAGE,
  INTERACTIVE_PREVIEW_VERSION,
} from './interactive-preview.ts'

describe('Interactive Preview release packaging', () => {
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
})
