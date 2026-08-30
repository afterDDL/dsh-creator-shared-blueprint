import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'

it('projects Creator working-method rules through the Loader without role boilerplate or unsafe write addresses', () => {
  const driver = fileURLToPath(new URL('./behavior-projection-driver.ts', import.meta.url))
  const launch = resolveExampleLaunch({ srcBin: driver, libBin: driver, tsconfigPath: resolve('tsconfig.base.json') })
  const output = execFileSync(launch.command, launch.args, { env: { ...process.env, ...launch.env }, encoding: 'utf8', timeout: 30_000 })
  const result: unknown = JSON.parse(output.trim())
  expect(result).toHaveProperty('nodes.5.value', '只呈现研究事实、指标对比与相关背景，不提供任何买入、卖出、持有等投资建议。')
  expect(result).toHaveProperty('nodes.5.editable', false)
  expect(result).toHaveProperty('nodes.5.adapterRef', null)
  expect(result).toMatchSnapshot()
})
