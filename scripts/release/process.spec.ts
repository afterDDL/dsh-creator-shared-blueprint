import { basename } from 'node:path'
import { describe, expect, it } from 'vitest'
import { capture, npmInvocation } from './process.ts'

describe('release process helpers', () => {
  it('runs npm through a native child-process entry', () => {
    const npm = npmInvocation(['--version'])
    const version = capture(npm.command, npm.args)

    expect(version).toMatch(/^\d+\.\d+\.\d+/u)
    if (process.platform === 'win32') {
      expect(npm.command).toBe(process.execPath)
      expect(basename(npm.args[0] ?? '')).toBe('npm-cli.js')
    } else {
      expect(npm).toEqual({ command: 'npm', args: ['--version'] })
    }
  })
})
