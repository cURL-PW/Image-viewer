import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { removeFixture, writeImage, type Fixture } from './fixtures'

/**
 * 一覧のサムネイルの大きさを Ctrl + ホイール / Ctrl + - = 0 で変える。
 * 大きさは 32px 刻みで 96〜512px。変えても画面の真ん中の画像は真ん中に残り、再起動後も保たれる。
 */

let app: ElectronApplication
let window: Page
let fixture: Fixture

const SHOTS = 'e2e/.output/screenshots'
const MANY = 120

async function launch(): Promise<void> {
  app = await electron.launch({
    args: [
      'out/main/index.js',
      '--root',
      fixture.root,
      `--user-data-dir=${fixture.userData}`,
      '--no-sandbox',
      '--disable-gpu'
    ],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
  })
  window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await expect(window.locator('.toolbar__count')).toHaveText(`${MANY} 枚`, { timeout: 30_000 })
}

test.beforeAll(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'image-viewer-e2e-'))
  fixture = { root: path.join(base, 'library'), userData: path.join(base, 'userdata') }
  await fs.mkdir(fixture.userData, { recursive: true })
  for (let index = 0; index < MANY; index++) {
    const name = `${String(index + 1).padStart(3, '0')}.png`
    await writeImage(path.join(fixture.root, name), index, 64, 48)
  }
  await launch()
})

test.afterAll(async () => {
  await app?.close()
  if (fixture) await removeFixture(fixture)
})

/** 1 枚目のサムネイルの幅 (= 設定の大きさ) */
const cellWidth = (): Promise<number> =>
  window.locator('.cell').first().evaluate((cell) => Math.round(cell.getBoundingClientRect().width))

/** 一覧の真ん中にある画像の名前 */
const centerName = (): Promise<string | null> =>
  window.evaluate(() => {
    const grid = document.querySelector('.grid') as HTMLElement
    const rect = grid.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    let best: { title: string; distance: number } | null = null
    for (const cell of Array.from(document.querySelectorAll<HTMLElement>('.cell'))) {
      const r = cell.getBoundingClientRect()
      const distance = Math.hypot(r.left + r.width / 2 - cx, r.top + r.height / 2 - cy)
      if (!best || distance < best.distance) best = { title: cell.title, distance }
    }
    return best?.title ?? null
  })

/**
 * Ctrl + キー。ショートカットは main の before-input-event で拾っているので、
 * Playwright のキー入力 (CDP) ではなく、実際の入力と同じ経路の sendInputEvent で送る
 */
/** 指定の画像の縦の中心が、一覧の縦の中心からどれだけずれているか (サムネイルの高さに対する割合) */
const verticalOffset = (title: string): Promise<number> =>
  window.evaluate((name) => {
    const grid = (document.querySelector('.grid') as HTMLElement).getBoundingClientRect()
    const cell = document.querySelector<HTMLElement>(`.cell[title="${name}"]`)
    if (!cell) return Infinity
    const rect = cell.getBoundingClientRect()
    return Math.abs(rect.top + rect.height / 2 - (grid.top + grid.height / 2)) / rect.height
  }, title)

async function ctrlKey(keyCode: '-' | '=' | '0' | '+'): Promise<void> {
  await app.evaluate(({ BrowserWindow }, key) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    contents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: ['control'] })
    contents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: ['control'] })
  }, keyCode)
}

async function ctrlWheel(deltaY: number): Promise<void> {
  const box = (await window.locator('.grid').boundingBox())!
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await window.keyboard.down('Control')
  await window.mouse.wheel(0, deltaY)
  await window.keyboard.up('Control')
}

test('Ctrl + ホイールで 1 段ずつ大きさが変わり、画面全体は拡大されない', async () => {
  await expect.poll(cellWidth).toBe(256)

  await ctrlWheel(-100)
  await expect.poll(cellWidth).toBe(288)
  await ctrlWheel(100)
  await ctrlWheel(100)
  await expect.poll(cellWidth).toBe(224)

  // 画面全体のズームはかからない
  expect(await window.evaluate('window.devicePixelRatio')).toBe(1)
  await window.screenshot({ path: `${SHOTS}/thumb-zoom-01-wheel.png` })

  // Ctrl なしのホイールは普通のスクロールで、大きさは変わらない
  await window.mouse.wheel(0, 300)
  await expect
    .poll(() => window.evaluate(() => (document.querySelector('.grid') as HTMLElement).scrollTop))
    .toBeGreaterThan(0)
  expect(await cellWidth()).toBe(224)
})

test('Ctrl + - / = / 0 でも変えられ、96〜512px に収まる', async () => {
  await window.locator('.grid').click({ position: { x: 5, y: 5 } })
  await ctrlKey('0')
  await expect.poll(cellWidth).toBe(256)

  for (let i = 0; i < 10; i++) await ctrlKey('-')
  await expect.poll(cellWidth).toBe(96)
  await window.screenshot({ path: `${SHOTS}/thumb-zoom-02-min.png` })

  for (let i = 0; i < 20; i++) await ctrlKey('=')
  await expect.poll(cellWidth).toBe(512)
  await window.screenshot({ path: `${SHOTS}/thumb-zoom-03-max.png` })

  // 256px を超えたら、大きい方のサムネイルを読む
  await expect
    .poll(() => window.locator('.cell__image').first().getAttribute('src'))
    .toContain('s=512')

  await ctrlKey('0')
  await expect.poll(cellWidth).toBe(256)
  await expect
    .poll(() => window.locator('.cell__image').first().getAttribute('src'))
    .toContain('s=256')
})

test('大きさを変えても、真ん中に見えていた画像は真ん中の行に残る', async () => {
  await ctrlKey('0')
  await expect.poll(cellWidth).toBe(256)
  await window.evaluate(() => {
    const grid = document.querySelector('.grid') as HTMLElement
    grid.scrollTop = grid.scrollHeight / 2 - grid.clientHeight / 2
  })
  // スクロールした先の行が描画されるのを待つ
  await expect
    .poll(async () => {
      const name = await centerName()
      return name === null ? Infinity : verticalOffset(name)
    })
    .toBeLessThan(0.6)
  const before = (await centerName()) as string

  // 列の数が変わるので横の位置は動くが、縦は真ん中の行に残る
  await ctrlWheel(100)
  await ctrlWheel(100)
  await ctrlWheel(100)
  await expect.poll(cellWidth).toBe(160)
  expect(await verticalOffset(before)).toBeLessThan(0.6)

  for (let i = 0; i < 5; i++) await ctrlKey('=')
  await expect.poll(cellWidth).toBe(320)
  expect(await verticalOffset(before)).toBeLessThan(0.6)
  await window.screenshot({ path: `${SHOTS}/thumb-zoom-04-center.png` })
})

test('単画像ビューでは効かず、大きさは再起動後も残る', async () => {
  await ctrlKey('0')
  await ctrlKey('-')
  await expect.poll(cellWidth).toBe(224)

  await window.locator('.cell').first().click()
  await expect(window.locator('.viewer')).toBeVisible()
  await ctrlKey('-')
  await window.keyboard.press('Escape')
  await expect(window.locator('.grid')).toBeVisible()
  await expect.poll(cellWidth).toBe(224)

  // 保存は少し遅れて行われる
  await window.waitForTimeout(800)
  await app.close()
  await launch()
  await expect.poll(cellWidth).toBe(224)
})
