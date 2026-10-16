import fs from 'node:fs/promises'
import path from 'node:path'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { createFixture, removeFixture, writeImage, type Fixture } from './fixtures'

let app: ElectronApplication
let window: Page
let fixture: Fixture

const SHOTS = 'e2e/.output/screenshots'

test.beforeAll(async () => {
  fixture = await createFixture()
  app = await electron.launch({
    args: [
      'out/main/index.js',
      '--root',
      fixture.root,
      `--user-data-dir=${fixture.userData}`,
      // コンテナ内で root 実行するため
      '--no-sandbox',
      '--disable-gpu'
    ],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
  })
  window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await expectImageCount(8)
})

test.afterAll(async () => {
  await app?.close()
  if (fixture) await removeFixture(fixture)
})

/** テストどうしが干渉しないよう、毎回ルート表示のグリッドに戻す。 */
test.beforeEach(async () => {
  if (await window.locator('.viewer').isVisible()) {
    await window.keyboard.press('Escape')
    await expect(window.locator('.grid')).toBeVisible()
  }
  const subfolders = window.locator('.panel--tree .panel__toggle input')
  if (!(await subfolders.isChecked())) await subfolders.check()
  await folderRow('library').click()
})

/** フォルダ名が完全一致する行を選ぶ (部分一致だと library が a に一致してしまう)。 */
function folderRow(name: string) {
  return window
    .locator('.tree__row')
    .filter({ has: window.locator('.tree__name', { hasText: new RegExp(`^${name}$`) }) })
}

async function expectImageCount(count: number): Promise<void> {
  await expect(window.locator('.toolbar__count')).toHaveText(`${count} 枚`, { timeout: 20_000 })
}

const indexLabel = (): ReturnType<Page['locator']> => window.locator('.viewer__meta').first()
const zoomLabel = (): ReturnType<Page['locator']> =>
  window.locator('.viewer__meta').filter({ hasText: '%' })

test('ルート配下を再帰的に読み込み、フォルダ階層を表示する', async () => {
  await expectImageCount(8)

  const root = folderRow('library')
  await expect(root.locator('.tree__count')).toHaveText('8')
  // a は直下 3 枚 + deep 2 枚、b は 2 枚
  await expect(folderRow('a').locator('.tree__count')).toHaveText('5')
  await expect(folderRow('b').locator('.tree__count')).toHaveText('2')

  await expect(window.locator('.cell').first().locator('img')).toBeVisible()
  await window.screenshot({ path: `${SHOTS}/01-grid.png` })
})

test('フォルダを選ぶと配下 (再帰) の画像だけに絞り込まれる', async () => {
  await folderRow('a').click()
  await expectImageCount(5)

  // サブフォルダを含めない設定にすると a 直下の 3 枚だけになる
  await window.locator('.panel--tree .panel__toggle input').uncheck()
  await expectImageCount(3)
  await window.locator('.panel--tree .panel__toggle input').check()
  await expectImageCount(5)

  await folderRow('b').click()
  await expectImageCount(2)
})

test('画像をクリックすると単画像ビューが開き、既定で画像全体が収まる', async () => {
  await window.locator('.cell').first().click()
  await expect(window.locator('.viewer')).toBeVisible()
  await expect(indexLabel()).toHaveText('1 / 8')
  await expect(zoomLabel()).toHaveText('100%')

  // 幅も高さもはみ出さない (スクロールせずに全体が見える)
  const size = await window.evaluate(() => {
    const stage = document.querySelector('.viewer__stage') as HTMLElement
    const image = document.querySelector('.viewer__image') as HTMLImageElement
    const box = image.getBoundingClientRect()
    return {
      stage: { width: stage.clientWidth, height: stage.clientHeight },
      image: { width: box.width, height: box.height },
      overflow: stage.scrollHeight - stage.clientHeight
    }
  })
  expect(size.image.width).toBeLessThanOrEqual(size.stage.width + 1)
  expect(size.image.height).toBeLessThanOrEqual(size.stage.height + 1)
  expect(size.overflow).toBeLessThanOrEqual(1)

  await window.screenshot({ path: `${SHOTS}/02-viewer.png` })
})

test('左下の ✕ でグリッドへ戻れる (ページ送りの領域とかぶらない)', async () => {
  // ページ送りは絶対配置なので、覆う範囲を区切らないとバー全体を隠してしまう。
  // タグ欄を開いた既定の状態だと ✕ が完全に隠れて押せなくなっていた。
  await window.locator('.cell').first().click()
  await expect(window.locator('.viewer')).toBeVisible()
  await expect(window.locator('.viewer__tags')).toBeVisible()

  await window.getByRole('button', { name: '一覧へ戻る' }).click()
  await expect(window.locator('.grid')).toBeVisible()
  await expect(window.locator('.viewer')).toHaveCount(0)
})

test('マウスの戻るボタンでグリッドへ戻る', async () => {
  await window.locator('.cell').first().click()
  await expect(window.locator('.viewer')).toBeVisible()

  // Playwright の mouse API は戻るボタンを送れないので、DOM のイベントで確かめる
  // (この spec では `window` が Page 変数なので globalThis を使う)
  await window.evaluate(() => {
    globalThis.dispatchEvent(new MouseEvent('mousedown', { button: 3, bubbles: true }))
  })
  await expect(window.locator('.grid')).toBeVisible()
  await expect(window.locator('.viewer')).toHaveCount(0)
})

test('Windows の app-command 経由でもグリッドへ戻る', async () => {
  // DOM のイベントが来ない構成のための保険。main プロセス側の経路を直接叩く
  await window.locator('.cell').first().click()
  await expect(window.locator('.viewer')).toBeVisible()

  await app.evaluate(({ BrowserWindow }) => {
    const [target] = BrowserWindow.getAllWindows()
    // 型定義には無いが、Electron が発行するのと同じイベントを流す
    ;(target as unknown as { emit: (name: string, ...args: unknown[]) => void }).emit(
      'app-command',
      { preventDefault: () => {} },
      'browser-backward'
    )
  })
  await expect(window.locator('.grid')).toBeVisible()
  await expect(window.locator('.viewer')).toHaveCount(0)
})

test('画像の左右端クリックで前後の画像へ移動する', async () => {
  await window.locator('.cell').first().click()
  await expect(indexLabel()).toHaveText('1 / 8')

  await window.locator('.viewer__edge--next').click()
  await expect(indexLabel()).toHaveText('2 / 8')

  await window.locator('.viewer__edge--next').click()
  await expect(indexLabel()).toHaveText('3 / 8')

  await window.locator('.viewer__edge--prev').click()
  await expect(indexLabel()).toHaveText('2 / 8')

  await window.locator('.viewer__edge--prev').click()
  await expect(indexLabel()).toHaveText('1 / 8')
  // 先頭では「前へ」が無効になる
  await expect(window.locator('.viewer__edge--prev')).toBeDisabled()
})

test('ホイールで拡大縮小でき、ズーム中は端クリックが無効になる', async () => {
  await window.locator('.cell').first().click()
  await expect(zoomLabel()).toHaveText('100%')

  const box = await window.locator('.viewer__stage').boundingBox()
  if (!box) throw new Error('ステージが見つかりません')
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2)

  await window.mouse.wheel(0, -120)
  await expect(zoomLabel()).toHaveText('115%')

  await window.mouse.wheel(0, -120)
  await expect(zoomLabel()).toHaveText('132%')

  // 等倍でないので左右端のクリック領域は消える
  await expect(window.locator('.viewer__edge--next')).toHaveCount(0)
  await window.screenshot({ path: `${SHOTS}/03-zoom.png` })

  // 移動量に比例して戻る (2 ノッチ分)
  await window.mouse.wheel(0, 240)
  await expect(zoomLabel()).toHaveText('100%')
  await expect(window.locator('.viewer__edge--next')).toHaveCount(1)
})

test('ダブルクリックで全体表示に戻る', async () => {
  await window.locator('.cell').first().click()
  const box = await window.locator('.viewer__stage').boundingBox()
  if (!box) throw new Error('ステージが見つかりません')
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await window.mouse.wheel(0, -120)
  await expect(zoomLabel()).toHaveText('115%')

  await window.locator('.viewer__stage').dblclick()
  await expect(zoomLabel()).toHaveText('100%')
})

test('画像を切り替えるとズームは全体表示にリセットされる', async () => {
  await window.locator('.cell').first().click()
  const box = await window.locator('.viewer__stage').boundingBox()
  if (!box) throw new Error('ステージが見つかりません')
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await window.mouse.wheel(0, -120)
  await expect(zoomLabel()).toHaveText('115%')

  await window.keyboard.press('ArrowRight')
  await expect(indexLabel()).toHaveText('2 / 8')
  await expect(zoomLabel()).toHaveText('100%')
})

test('キーボードでページ送りとビューを閉じる操作ができる', async () => {
  await window.locator('.cell').first().click()
  await expect(indexLabel()).toHaveText('1 / 8')

  await window.keyboard.press('ArrowRight')
  await expect(indexLabel()).toHaveText('2 / 8')
  await window.keyboard.press('End')
  await expect(indexLabel()).toHaveText('8 / 8')
  await window.keyboard.press('Home')
  await expect(indexLabel()).toHaveText('1 / 8')
  await window.keyboard.press('Escape')
  await expect(window.locator('.grid')).toBeVisible()
})

test('フォルダの内容が変化するとライブラリに自動で反映される', async () => {
  const added = path.join(fixture.root, 'b', '09.png')
  await writeImage(added, 9)
  await expectImageCount(9)
  await expect(folderRow('b').locator('.tree__count')).toHaveText('3')

  // 新しいフォルダもツリーに現れる
  const inNewDir = path.join(fixture.root, 'c', '10.png')
  await writeImage(inNewDir, 10)
  await expectImageCount(10)
  await expect(folderRow('c')).toBeVisible()

  await fs.rm(added)
  await expectImageCount(9)
  await fs.rm(path.dirname(inNewDir), { recursive: true })
  await expectImageCount(8)
  await expect(folderRow('c')).toHaveCount(0)
})
