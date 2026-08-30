// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { expect, it } from 'vitest'
import { installAssembledBootEnv, mountAssembledApp } from './assembled-boot.ts'

installAssembledBootEnv()

it('shows a confirmed Apply receipt in the runnable Blueprint Web example', async () => {
  const rows = load(readFileSync('examples/web-blueprint-demo/cordis.yml', 'utf8')) as {
    id: string
    config?: { demoBootstrapJson?: string }
  }[]
  const bootstrap = JSON.parse(rows.find(row => row.id === 'ui-blueprint')!.config!.demoBootstrapJson!) as object
  mountAssembledApp({ blueprintDemo: bootstrap })
  await screen.findByDisplayValue(/我要一个上市公司研究 Agent/u, {}, { timeout: 10_000 })
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send message' }).disabled).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByText('上市公司研究 Agent 已创建完成。你可以在右侧继续调整目标、添加专用 Skill 或协作 Agent，也可以直接试用。', undefined, { timeout: 20_000 })
  fireEvent.click(screen.getByRole('button', { name: '选择做什么' }))
  await screen.findByDisplayValue(/不要给投资建议/u, {}, { timeout: 10_000 })
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  const apply = await screen.findByRole('button', { name: '全部应用' }, { timeout: 10_000 })
  const pending = apply.closest('[data-state]')!.getAttribute('data-state')
  fireEvent.click(apply)
  await screen.findByText('已全部应用', undefined, { timeout: 10_000 })
  expect({
    before: pending,
    after: screen.getByText('已全部应用').closest('[data-state]')!.getAttribute('data-state'),
    label: screen.getByText('已全部应用').textContent,
  }).toMatchInlineSnapshot(`
    {
      "after": "applied",
      "before": "pending",
      "label": "已全部应用",
    }
  `)
  expect(screen.queryByText('建议已过期，请在对话中重新检查一致性。')).toBeNull()
}, 45_000)
