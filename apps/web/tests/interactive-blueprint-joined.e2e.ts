// Web e2e scenario: Interactive Blueprint joined transaction ownership.
//
// A real Chromium drives the shipped Web composition over HTTP. The model
// judgment is positional replay, but every surface around it is production:
// the DOM action installs a typed conversation context, the live Agent calls
// the real proposal Tool, the Blueprint Adapter resolves durable Session
// authority, and Cancel/Apply append terminals before the browser reloads.
// No demo bootstrap, in-memory Blueprint adapter, or direct Host write is used.
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, launchWebScaffold, seedSession,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/interactive-blueprint-joined', import.meta.url))
const REPLAY_FIXTURE = join(SNAPSHOT_DIR, 'session.jsonl')
const REPLAY_OVERRIDE = join(SNAPSHOT_DIR, 'replay.override.json')
const MODE = webSnapshotMode()
const PRESET_ID = 'blueprint-joined'
const PRESET_NAME = 'Blueprint Joined Agent'
const SOURCE_ID = SessionId('interactive-blueprint-source')
const SOURCE_TITLE = 'Blueprint joined source'
const CONTROL_ID = SessionId('interactive-blueprint-control')
const CONTROL_TITLE = 'Blueprint isolation control'
const PURPOSE_INITIAL = 'Compare public product capabilities and pricing.'
const PURPOSE_CANCELLED = 'Compare products from uploaded data only.'
const PURPOSE_APPLIED = 'Compare public product capabilities, pricing, and adoption signals.'

/** One user preset with deterministic, safely writable semantic anchors. */
const COMPOSITION = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      Role: competitive intelligence analyst

      Purpose: ${PURPOSE_INITIAL}

      Rules:
      1. Verify every material claim against an attributable source.

      Output: A concise comparison table followed by sourced conclusions.
`

/** A closed cold Session whose title is stable enough for browser navigation. */
function seedLog(title: string): string {
  const time = 1788134400000
  return [
    JSON.stringify({ type: 'session', version: 0, id: '{{sessionId}}', createdAt: time }),
    JSON.stringify({
      type: 'turn/start', seq: 0, time: time + 1,
      data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user', rpcId: 'seed' } } },
    }),
    JSON.stringify({
      type: 'user/message', seq: 1, time: time + 2,
      data: { content: [{ type: 'text', text: title }], source: { kind: 'user', rpcId: 'seed' } },
      surfaceOp: 'append',
    }),
    JSON.stringify({
      type: 'session/title', seq: 2, time: time + 3,
      data: { title, messageSeqs: [1], source: { kind: 'fallback' } },
    }),
    JSON.stringify({
      type: 'turn/end', seq: 3, time: time + 4,
      data: { turn: 1, reason: { kind: 'completed' } },
    }),
  ].join('\n')
}

/** Open a cold Session by title through the shipped search and list surfaces. */
async function openSession(page: Page, title: string): Promise<void> {
  const searchButton = page.getByRole('button', { name: 'Search sessions' })
  await searchButton.waitFor({ timeout: 15_000 })
  if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
  const search = page.getByPlaceholder('Search sessions', { exact: false })
  await search.fill(title)
  const result = page.getByRole('tree', { name: 'Search results' })
    .getByRole('treeitem', { name: new RegExp(title) })
  await result.waitFor({ timeout: 30_000 })
  await result.click()
  await page.locator('[class*="centerCol"]').getByRole('button', { name: title, exact: true })
    .waitFor({ timeout: 30_000 })
  await search.fill('')
}

/** The production Blueprint card for one staged semantic edit. */
function proposalCard(page: Page, proposedValue: string): Locator {
  return page.locator('[data-state]').filter({ hasText: proposedValue }).first()
}

/** Submit one Purpose editor draft and wait for its replayed model turn. */
async function stagePurpose(page: Page, scaffold: WebScaffold, proposedValue: string): Promise<void> {
  const purpose = page.getByRole('button', { name: 'Select Purpose' })
  await purpose.getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Edit Purpose' })
  await editor.fill(proposedValue)
  const settled = scaffold.whenTurnSettled()
  await page.getByRole('button', { name: 'Submit change' }).click()
  expect(await settled).toBe(SOURCE_ID)
  const proposal = proposalCard(page, proposedValue)
  await proposal.waitFor({ timeout: 15_000 })
  await expect.poll(() => proposal.getAttribute('data-state'), { timeout: 15_000 }).toBe('pending')
}

/** Persisted event suffix owned by the source Session. */
async function durableSourceEvents(scaffold: WebScaffold): Promise<SessionEvent[]> {
  return [...(await scaffold.ctx.sessionPersistence.load(SOURCE_ID)).events]
}

describe.skipIf(MODE === 'record')('web e2e: Interactive Blueprint joined Host transaction', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let presetRoot: string
  let compositionPath: string

  beforeAll(async () => {
    presetRoot = await mkdtemp(join(tmpdir(), 'dsh-blueprint-joined-presets-'))
    const presetDirectory = join(presetRoot, PRESET_ID)
    compositionPath = join(presetDirectory, 'agent.cordis.yml')
    await mkdir(presetDirectory, { recursive: true })
    await writeFile(compositionPath, COMPOSITION)
    await writeFile(join(presetDirectory, 'preset.yml'), [
      `name: ${PRESET_NAME}`,
      'description: Real-Web Interactive Blueprint transaction fixture.',
      '',
    ].join('\n'))

    scaffold = await launchWebScaffold({
      replayFixture: REPLAY_FIXTURE,
      replayOverride: REPLAY_OVERRIDE,
      agentPresets: { roots: [{ path: presetRoot, trust: 'user' }], default: PRESET_ID },
    })
    await seedSession(scaffold, seedLog(CONTROL_TITLE), CONTROL_ID, PRESET_ID)
    await seedSession(scaffold, seedLog(SOURCE_TITLE), SOURCE_ID, PRESET_ID)
    const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await openSession(page, SOURCE_TITLE)
    await page.getByRole('heading', { name: PRESET_NAME, level: 2 }).waitFor({ timeout: 30_000 })
    await page.getByText(PURPOSE_INITIAL, { exact: true }).waitFor({ timeout: 15_000 })
  }, 180_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (presetRoot !== undefined) {
      await rm(presetRoot, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'Interactive Blueprint joined e2e cleanup failed')
  })

  it('stages a zero-write Proposal in the source Session and isolates it across a Session switch', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-interactive-blueprint-stage'))
    const sessionCount = (await scaffold.ctx.sessionPersistence.list()).length

    await stagePurpose(page, scaffold, PURPOSE_CANCELLED)

    expect(await page.locator('[class*="centerCol"]')
      .getByRole('button', { name: SOURCE_TITLE, exact: true }).count()).toBe(1)
    expect((await scaffold.ctx.sessionPersistence.list()).length).toBe(sessionCount)
    expect(await readFile(compositionPath, 'utf8')).toBe(COMPOSITION)
    const staged = await durableSourceEvents(scaffold)
    expect(staged.filter(event => event.type === 'blueprint/routing-input')).toHaveLength(1)
    expect(staged.filter(event => event.type === 'blueprint/route-decision')).toHaveLength(1)
    expect(staged.filter(event => event.type === 'tool/call'
      && event.data.name === 'propose_blueprint_change')).toHaveLength(1)
    expect(staged.filter(event => event.type === 'blueprint/apply-result')).toHaveLength(0)
    expect(staged.filter(event => event.type === 'blueprint/proposal-cancelled')).toHaveLength(0)

    await openSession(page, CONTROL_TITLE)
    expect(await proposalCard(page, PURPOSE_CANCELLED).count()).toBe(0)
    expect(await page.getByText(PURPOSE_INITIAL, { exact: true }).count()).toBeGreaterThanOrEqual(1)

    await openSession(page, SOURCE_TITLE)
    await expect.poll(() => proposalCard(page, PURPOSE_CANCELLED).getAttribute('data-state'), {
      timeout: 15_000,
    }).toBe('pending')
  }, 120_000)

  it('durably cancels the recovered Proposal without changing the preset', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-interactive-blueprint-cancel'))
    const card = proposalCard(page, PURPOSE_CANCELLED)
    await card.getByRole('button', { name: '取消', exact: true }).click()
    await expect.poll(() => card.getAttribute('data-state'), { timeout: 15_000 }).toBe('canceled')
    await card.getByText('已取消，未继续修改 Agent').waitFor({ timeout: 15_000 })

    expect(await readFile(compositionPath, 'utf8')).toBe(COMPOSITION)
    const events = await durableSourceEvents(scaffold)
    const cancellations = events.filter(event => event.type === 'blueprint/proposal-cancelled')
    expect(cancellations).toHaveLength(1)
    expect(cancellations[0]?.data).toMatchObject({
      sourceSessionId: SOURCE_ID, presetId: PRESET_ID, status: 'cancelled',
    })
    expect(events.filter(event => event.type === 'blueprint/apply-result')).toHaveLength(0)
  }, 60_000)

  it('applies a second structured Proposal and reprojects the committed preset', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-interactive-blueprint-apply'))
    await stagePurpose(page, scaffold, PURPOSE_APPLIED)
    expect(await readFile(compositionPath, 'utf8')).toBe(COMPOSITION)

    const card = proposalCard(page, PURPOSE_APPLIED)
    await card.getByRole('button', { name: '应用', exact: true }).click()
    await expect.poll(() => card.getAttribute('data-state'), { timeout: 15_000 }).toBe('applied')
    await card.getByText('已应用并重新读取 Blueprint').waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: 'Select Purpose' })
      .filter({ hasText: PURPOSE_APPLIED }).waitFor({ timeout: 15_000 })

    const committed = await readFile(compositionPath, 'utf8')
    expect(committed).toContain(`Purpose: ${PURPOSE_APPLIED}`)
    expect(committed).not.toContain(PURPOSE_CANCELLED)
    expect(committed).not.toBe(COMPOSITION)
    const events = await durableSourceEvents(scaffold)
    expect(events.filter(event => event.type === 'blueprint/routing-input')).toHaveLength(2)
    expect(events.filter(event => event.type === 'blueprint/route-decision')).toHaveLength(2)
    expect(events.filter(event => event.type === 'tool/call'
      && event.data.name === 'propose_blueprint_change')).toHaveLength(2)
    const receipts = events.filter(event => event.type === 'blueprint/apply-result')
    expect(receipts).toHaveLength(1)
    expect(receipts[0]?.data).toMatchObject({
      sourceSessionId: SOURCE_ID,
      presetId: PRESET_ID,
      result: { sourceSessionId: SOURCE_ID, status: 'committed' },
    })
  }, 120_000)

  it('recovers both terminals and the committed projection after a browser reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-interactive-blueprint-reload'))
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await openSession(page, SOURCE_TITLE)

    await page.getByRole('button', { name: 'Select Purpose' })
      .filter({ hasText: PURPOSE_APPLIED }).waitFor({ timeout: 15_000 })
    await proposalCard(page, PURPOSE_CANCELLED)
      .getByText('已取消，未继续修改 Agent').waitFor({ timeout: 15_000 })
    await proposalCard(page, PURPOSE_APPLIED)
      .getByText('已应用并重新读取 Blueprint').waitFor({ timeout: 15_000 })
    expect(await page.getByText(PURPOSE_INITIAL, { exact: true }).count()).toBe(0)
  }, 120_000)

  it('kept the real joined lane clean and its replay inventory explicit', async () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['replay.override.json', 'session.jsonl'])
  })
})
