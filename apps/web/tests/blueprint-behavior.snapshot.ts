// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { load } from 'js-yaml'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { expect, it } from 'vitest'
import { installAssembledBootEnv, mountAssembledApp } from './assembled-boot.ts'

installAssembledBootEnv()

it('renders the real RC rule source collapsed and expanded in the runnable Blueprint Web example', async () => {
  // The Host parser runs under its source launcher, separate from this Client compiler face.
  const projectionScript = `
    import { readFileSync } from 'node:fs';
    import { projectBehaviors } from './packages/bundle/shared-blueprint/src/host/behavior.ts';
    import { parseComposition, personaText, projectPersona } from './packages/bundle/shared-blueprint/src/host/composition.ts';
    const composition = readFileSync('examples/web-blueprint-demo/tests/fixtures/preset/blueprint-adapter/rc1-folded-rules.cordis.yml', 'utf8');
    const text = personaText(parseComposition(composition));
    console.log(JSON.stringify(projectBehaviors(text, projectPersona(text).items, composition, true).nodes));
  `
  const rules = JSON.parse(execFileSync(process.execPath, [
    '--import', 'tsx/esm', '--input-type=module', '-e', projectionScript,
  ], { encoding: 'utf8' })) as { type: 'behavior'; value: string; editable: boolean }[]
  const rows = load(readFileSync('examples/web-blueprint-demo/cordis.yml', 'utf8')) as {
    id: string
    config?: { demoBootstrapJson?: string }
  }[]
  const bootstrap = JSON.parse(rows.find(row => row.id === 'shared-blueprint')!.config!.demoBootstrapJson!) as {
    creatorScenario: { blueprint: { nodes: { type: string }[] } }
  }
  const blueprint = bootstrap.creatorScenario.blueprint
  blueprint.nodes = [...blueprint.nodes.filter(node => node.type !== 'behavior'), ...rules]
  mountAssembledApp({ blueprintDemo: bootstrap })
  await screen.findByDisplayValue(/我要一个上市公司研究 Agent/u, {}, { timeout: 10_000 })
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send message' }).disabled).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByText('另有 3 条规则', undefined, { timeout: 20_000 })
  const heading = screen.getByText('规则', { exact: true })
  const section = heading.closest('section')!
  const collapsed = section.textContent
  fireEvent.click(section.querySelector('button[aria-expanded]')!)
  const expanded = rules.map((rule) => {
    expect(section.textContent).toContain(rule.value)
    return rule.value
  })
  expect(section.textContent).not.toContain('编辑')
  expect({ collapsed, expanded, readOnly: rules.every(rule => !rule.editable) }).toMatchSnapshot()
}, 45_000)
