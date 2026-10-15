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
 * 単画像ビューから一覧へ戻ったとき、一覧のスクロール位置が元に戻ることを確かめる。
 * 以前は一覧が作り直されるたびに先頭へ戻っていた。
 */

let app: ElectronApplication
let window: Page
let fixture: Fixture

const SHOTS = 'e2e/.output/screenshots'
/** 一覧がスクロールするだけの枚数 */
const MANY = 120

test.beforeAll(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'image-viewer-e2e-'))
  fixture = { root: path.join(base, 'library'), userData: path.join(base, 'userdata') }
  await fs.mkdir(fixture.userData, { recursive: true })
  for (let index = 0; index < MANY; index++) {
    const name = `${String(index + 1).padStart(3, '0')}.png`
    await writeImage(path.join(fixture.root, 'many', name), index, 64, 48)
  }
  await writeImage(path.join(fixture.root, 'other', 'x.png'), 0, 64, 48)

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
  await expect(window.locator('.toolbar__count')).toHaveText(`${MANY + 1} 枚`, {
    timeout: 30_000
  })
})

test.afterAll(async () => {
  await app?.close()
  if (fixture) await removeFixture(fixture)
})

test.beforeEach(async () => {
  if (await window.locator('.viewer').isVisible()) {
    await window.keyboard.press('Escape')
    await expect(window.locator('.grid')).toBeVisible()
  }
  await folderRow('many').click()
  await expect(window.locator('.toolbar__count')).toHaveText(`${MANY} 枚`)
})

function folderRow(name: string) {
  return window
    .locator('.tree__row')
    .filter({ has: window.locator('.tree__name', { hasText: new RegExp(`^${name}$`) }) })
}

const gridScrollTop = (): Promise<number> =>
  window.evaluate(() => (document.querySelector('.grid') as HTMLElement).scrollTop)

/** 一覧を途中までスクロールし、そこで見えている画像を開く。開いた画像の名前を返す。 */
async function scrollAndOpen(): Promise<{ top: number; name: string }> {
  await window.evaluate(() => {
    const grid = document.querySelector('.grid') as HTMLElement
    grid.scrollTop = grid.scrollHeight / 2
  })
  await expect.poll(gridScrollTop).toBeGreaterThan(200)
  const top = await gridScrollTop()

  // 画面内に見えているセルを 1 つ選んで開く (描画とメタデータの取得を待つ)
  const visibleName = (): Promise<string> =>
    window.evaluate(() => {
      const grid = (document.querySelector('.grid') as HTMLElement).getBoundingClientRect()
      const cell = Array.from(document.querySelectorAll<HTMLElement>('.cell')).find((element) => {
        const box = element.getBoundingClientRect()
        return box.top >= grid.top && box.bottom <= grid.bottom
      })
      return cell?.querySelector('.cell__caption')?.textContent ?? ''
    })
  await expect.poll(visibleName).not.toBe('')
  const name = await visibleName()
  await window.locator('.cell', { has: window.locator(`.cell__caption:text-is("${name}")`) }).click()
  await expect(window.locator('.viewer__name')).toHaveText(name)
  return { top, name }
}

const closeWays: Record<string, () => Promise<void>> = {
  'マウスの戻るボタン': () =>
    window.evaluate(() => {
      globalThis.dispatchEvent(new MouseEvent('mousedown', { button: 3, bubbles: true }))
    }),
  'Windows の app-command': () =>
    app.evaluate(({ BrowserWindow }) => {
      const [target] = BrowserWindow.getAllWindows()
      ;(target as unknown as { emit: (name: string, ...args: unknown[]) => void }).emit(
        'app-command',
        { preventDefault: () => {} },
        'browser-backward'
      )
    }),
  '左下の ✕': () => window.locator('.viewer__bar .button--icon').click(),
  Esc: () => window.keyboard.press('Escape')
}

for (const [label, close] of Object.entries(closeWays)) {
  test(`${label}で閉じると、一覧が元のスクロール位置に戻る`, async () => {
    const { top } = await scrollAndOpen()
    await close()
    await expect(window.locator('.grid')).toBeVisible()
    await expect.poll(gridScrollTop).toBe(top)
    if (label === 'マウスの戻るボタン') {
      await window.screenshot({ path: `${SHOTS}/scroll-restored.png` })
    }
  })
}

test('ページ送りで先へ進んでから閉じると、最後に見ていた画像が見える位置になる', async () => {
  await scrollAndOpen()
  // 一画面ぶん以上先へ進める
  for (let count = 0; count < 40; count++) await window.keyboard.press('ArrowRight')
  const last = (await window.locator('.viewer__name').textContent()) ?? ''

  await window.evaluate(() => {
    globalThis.dispatchEvent(new MouseEvent('mousedown', { button: 3, bubbles: true }))
  })
  await expect(window.locator('.grid')).toBeVisible()
  const cell = window.locator('.cell', {
    has: window.locator(`.cell__caption:text-is("${last}")`)
  })
  await expect(cell).toBeInViewport({ ratio: 1 })
})

test('フォルダを切り替えたときは従来どおり先頭から表示する', async () => {
  const { top } = await scrollAndOpen()
  expect(top).toBeGreaterThan(0)
  await window.keyboard.press('Escape')
  await expect.poll(gridScrollTop).toBe(top)

  await folderRow('other').click()
  await expect(window.locator('.toolbar__count')).toHaveText('1 枚')
  await folderRow('many').click()
  await expect(window.locator('.toolbar__count')).toHaveText(`${MANY} 枚`)
  await expect.poll(gridScrollTop).toBe(0)
})
