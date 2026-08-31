// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { installAssembledBootEnv, mountAssembledApp } from './assembled-boot.ts'

installAssembledBootEnv()

it('keeps a new Session free of the prior Creator lock in the runnable Web example', async () => {
  const rows = load(readFileSync('examples/web-blueprint-demo/cordis.yml', 'utf8')) as {
    id: string
    config?: { demoBootstrapJson?: string }
  }[]
  const bootstrap = JSON.parse(rows.find(row => row.id === 'shared-blueprint')!.config!.demoBootstrapJson!) as {
    seeds: object[]
    preferredPresetId?: string
    creatorScenario: { blueprint: object }
  }
  const creator = bootstrap.creatorScenario
  bootstrap.seeds = [{
    agent: { id: 'cordis', label: '创造模式', trust: 'system' },
    blueprint: {
      ...creator.blueprint,
      preset: { id: 'cordis', name: '创造模式', trust: 'system' },
      nodes: [],
    },
  }]
  bootstrap.preferredPresetId = 'cordis'
  Object.defineProperty(window, 'innerWidth', { value: 1707, configurable: true })
  mountAssembledApp({ blueprintDemo: bootstrap })
  await screen.findByDisplayValue(/我要一个上市公司研究 Agent/u, {}, { timeout: 10_000 })
  const frame = document.querySelector<HTMLElement>('[class$="_frame"]')!
  expect(frame.style.gridTemplateColumns).toBe('240px minmax(0, 1fr) 600px')
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send message' }).disabled).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByText(/正在调整|正在搭建/u, undefined, { timeout: 10_000 })
  expect(frame.style.gridTemplateColumns).toBe('240px minmax(0, 1fr) 600px')
  const roster = screen.getByRole('region', { name: '我的 Agents' })
  const locked = within(roster).getAllByRole<HTMLButtonElement>('button').every(button => button.disabled)
  fireEvent.click(screen.getAllByRole('button', { name: 'New session' })[0]!)
  await waitFor(() => {
    expect(screen.getByRole('heading', { name: '创造模式' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '上市公司研究 Agent' })).toBeNull()
    expect(within(screen.getByRole('region', { name: '我的 Agents' })).getAllByRole<HTMLButtonElement>('button').every(button => !button.disabled)).toBe(true)
  })
  expect(frame.style.gridTemplateColumns).toBe('240px minmax(0, 1fr) 600px')
  expect({
    creatorRosterLocked: locked,
    newSessionRosterLocked: within(screen.getByRole('region', { name: '我的 Agents' })).getAllByRole<HTMLButtonElement>('button').some(button => button.disabled),
    creatorTitleVisible: screen.queryByRole('heading', { name: '上市公司研究 Agent' }) !== null,
    pausedVisible: screen.queryByText('创建已暂停，可以继续') !== null,
  }).toMatchInlineSnapshot(`
    {
      "creatorRosterLocked": true,
      "creatorTitleVisible": false,
      "newSessionRosterLocked": false,
      "pausedVisible": false,
    }
  `)
}, 30_000)
