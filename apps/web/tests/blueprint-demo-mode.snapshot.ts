// @vitest-environment jsdom
// Blueprint Demo assembly smoke: the normal built Web shell, layout, theme,
// sidebar, conversation, and Blueprint bundles boot unchanged. Only the
// Blueprint data source is replaced with caller-owned browser-memory state.
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { installAssembledBootEnv, mountAssembledApp } from './assembled-boot.ts'
import { BLUEPRINT_DEMO_FIXTURE } from './blueprint-demo-fixture.ts'

installAssembledBootEnv()

it('mounts Demo state inside the production DSH Web shell without a parallel page', async () => {
  mountAssembledApp({ blueprintDemo: BLUEPRINT_DEMO_FIXTURE })

  const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  fireEvent.click(await within(tree).findByText('Fixture 历史会话'))

  expect(await screen.findByText('预览占位 Agent', undefined, { timeout: 10_000 })).toBeTruthy()
  expect(await screen.findByText('结构预览角色')).toBeTruthy()
  const styleOwners = [...document.head.querySelectorAll('style[data-plugin]')]
    .map(style => style.getAttribute('data-plugin'))
  expect(styleOwners).toContain('@deepseek-ai/dsh-client-ui-layout')
  expect(styleOwners).toContain('@deepseek-ai/dsh-shared-blueprint')

  fireEvent.click(screen.getByRole('button', { name: '试用 Agent' }))
  const dialog = await screen.findByRole('dialog', { name: '试用这个 Agent' })
  within(dialog).getByText('将用当前配置开启一个新的会话。')
  fireEvent.click(within(dialog).getByRole('button', { name: '开始试用' }))

  await waitFor(() => { expect(screen.queryByRole('dialog', { name: '试用这个 Agent' })).toBeNull() })
  expect(screen.queryByText('已应用，Agent 结构与实际运行配置一致')).toBeNull()
})
