import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'

it('settles mounted Subagent authoring through the Loader without Try or a foreground Creator', () => {
  const driver = fileURLToPath(new URL('./subagent-completion-driver.ts', import.meta.url))
  const launch = resolveExampleLaunch({ srcBin: driver, libBin: driver, tsconfigPath: resolve('tsconfig.base.json') })
  const output = execFileSync(launch.command, launch.args, { env: { ...process.env, ...launch.env }, encoding: 'utf8', timeout: 30_000 })
  const result: unknown = JSON.parse(output.trim())
  expect(result).toMatchObject({ outcome: 'completed', conformance: 'pass' })
  expect(result).toMatchSnapshot()
})
