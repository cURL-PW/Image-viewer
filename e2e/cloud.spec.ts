import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createFixture, installDummyModel, removeFixture, type Fixture } from './fixtures'

/**
 * クラウド同期フォルダ (iCloud のオンデマンドファイル) の扱いを確認する。
 *
 * 実機の iCloud は用意できないので、「遅い読み込み」のしきい値を 0 にして
 * すべての読み込みを遅い扱いにし、回路遮断器が働いた状態を再現する。
 * この遮断器は OS の内部仕様に依存しないため、これが本番でも最後の砦になる。
 */

let app: ElectronApplication
let window: Page
let fixture: Fixture

const SHOTS = 'e2e/.output/screenshots'
/** 未ダウンロードを示す雲タイル (SVG) の大きさ */
const CLOUD_TILE_WIDTH = 96

test.beforeAll(async () => {
  fixture = await createFixture()
  await installDummyModel(fixture)
  app = await electron.launch({
    args: [
      'out/main/index.js',
      '--root',
      fixture.root,
      `--user-data-dir=${fixture.userData}`,
      '--no-sandbox',
      '--disable-gpu'
    ],
    // すべての読み込みを「遅い」とみなさせる
    env: { ...process.env, IMAGE_VIEWER_SLOW_READ_MS: '0' }
  })
  window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  await app?.close()
  if (fixture) await removeFixture(fixture)
})

/** グリッド上で雲タイルになっている枚数。 */
async function cloudTileCount(): Promise<number> {
  return window.locator('.cell__image').evaluateAll(
    (images, width) =>
      images.filter((img) => (img as HTMLImageElement).naturalWidth === width).length,
    CLOUD_TILE_WIDTH
  )
}

test('読み込みが遅いとクラウドモードに入り、警告バーが出る', async () => {
  await expect(window.locator('.toolbar__count')).toHaveText('8 枚', { timeout: 20_000 })
  await expect(window.locator('.banner')).toBeVisible({ timeout: 20_000 })
  await expect(window.locator('.banner__text')).toContainText('止めています')
  await window.screenshot({ path: `${SHOTS}/08-cloud-banner.png` })
})

test('未ダウンロード扱いの画像は雲タイルになり、元ファイルを読みにいかない', async () => {
  // 遮断器が働くまでの数枚は生成されるが、残りは雲タイルへ切り替わる
  await expect.poll(cloudTileCount, { timeout: 20_000 }).toBeGreaterThan(0)
})

test('クラウドモードでも UI は固まらない', async () => {
  const folderA = window
    .locator('.tree__row')
    .filter({ has: window.locator('.tree__name', { hasText: /^a$/ }) })

  const started = Date.now()
  await folderA.click()
  await expect(window.locator('.toolbar__count')).toHaveText('5 枚', { timeout: 5_000 })
  await window.locator('.tree__row').first().click()
  await expect(window.locator('.toolbar__count')).toHaveText('8 枚', { timeout: 5_000 })
  // 読み込みが詰まっていても操作は即座に返る
  expect(Date.now() - started).toBeLessThan(5_000)
})

test('自動タグ付けは止まる', async () => {
  // クラウドモードの間は勝手にダウンロードを起こさないので完了表示にはならない
  await expect(window.locator('.status--done')).toHaveCount(0)
})

test('画像を開けばその 1 枚はダウンロードして表示する', async () => {
  await window.locator('.cell').first().click()
  await expect(window.locator('.viewer')).toBeVisible()
  const image = window.locator('.viewer__image')
  await expect(image).toBeVisible()
  await expect
    .poll(async () => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(CLOUD_TILE_WIDTH)
  await window.keyboard.press('Escape')
  await expect(window.locator('.grid')).toBeVisible()
})

test('まとめてダウンロードすると雲タイルが消え、タグ付けまで進む', async () => {
  await window.locator('.banner .button--primary').click()

  await expect(window.locator('.status--done')).toHaveText('タグ付け完了 8 / 8', {
    timeout: 60_000
  })
  await expect.poll(cloudTileCount, { timeout: 20_000 }).toBe(0)
  await expect(window.locator('.tag').first()).toBeVisible()
  await window.screenshot({ path: `${SHOTS}/09-after-download.png` })
})

test('設定画面の診断で、判定の内訳と読み込み時間を確認できる', async () => {
  await window.locator('.toolbar .button--icon', { hasText: '⚙' }).click()
  await expect(window.locator('.modal__panel')).toBeVisible()

  const diagnostics = window.locator('.diagnostics')
  await diagnostics.scrollIntoViewIfNeeded()

  // 判定のしきい値と現在の状態が読める (この spec では 0ms に下げて起動している)
  await expect(diagnostics).toContainText('クラウドフォルダ判定')
  await expect(diagnostics).toContainText('0 ms 超')

  // 読み込み時間が記録されている。走査の stat も計測対象で、
  // Windows ではここが最初の発火点になる
  const samples = diagnostics.locator('.diagnostics__list li')
  await expect(samples.first()).toBeVisible()
  await expect(samples.first()).toContainText('ms')
  await window.screenshot({ path: `${SHOTS}/10-diagnostics.png` })

  await window.locator('.modal__footer .button--primary').click()
  await expect(window.locator('.modal')).toHaveCount(0)
})

test('デバッグログにファイルへ触れた経路が残る', async () => {
  await window.locator('.toolbar .button--icon', { hasText: '⚙' }).click()
  await expect(window.locator('.modal__panel')).toBeVisible()

  const diagnostics = window.locator('.diagnostics')
  await expect(diagnostics.getByText('デバッグログを記録する')).toBeVisible()

  // 「直近をコピー」はクリップボードへ入れる前にログを書き出す
  await diagnostics.getByRole('button', { name: '直近をコピー' }).click()
  await expect(diagnostics).toContainText('行をコピーしました')

  const logFile = path.join(fixture.userData, 'logs', 'debug.log')
  const content = await fs.readFile(logFile, 'utf8')
  // 走査・サムネイル生成・門番の判定がそれぞれ記録されている
  expect(content).toContain('walk-stat')
  expect(content).toContain('thumb-gen')
  expect(content).toContain('guard-mode')
  // 走査が終わったのか死んだのかが分かること (実機で判別できずに困った)
  expect(content).toContain('walk-start')
  expect(content).toContain('walk-done')
  // 自覚のない fs 呼び出しを数えている
  expect(content).toContain('fs-probe')
  // 1 行は「時刻 / 種別 / 判定 / 所要 / 対象」のタブ区切り
  const line = content.split('\n').find((row) => row.includes('walk-stat')) ?? ''
  expect(line.split('\t').length).toBeGreaterThanOrEqual(5)

  await window.locator('.modal__footer .button--primary').click()
  await expect(window.locator('.modal')).toHaveCount(0)
})
