import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import {
  HEIC_FILE,
  createFixtureWithHeic,
  installDummyModel,
  removeFixture,
  type Fixture
} from './fixtures'

/**
 * iCloud / iPhone の写真は既定で HEIC。sharp のプリビルドでは HEVC を復号できず、
 * Chromium も HEIC を表示できないため、WASM 版 libheif での復号と
 * 表示用トランスコードが通っているかをアプリ越しに確認する。
 */

let app: ElectronApplication
let window: Page
let fixture: Fixture

const SHOTS = 'e2e/.output/screenshots'
const HEIC_NAME = HEIC_FILE.split('/').pop() as string

test.beforeAll(async () => {
  fixture = await createFixtureWithHeic()
  await installDummyModel(fixture)
  app = await electron.launch({
    args: [
      'out/main/index.js',
      '--root',
      fixture.root,
      `--user-data-dir=${fixture.userData}`,
      '--no-sandbox',
      '--disable-gpu'
    ]
  })
  window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  await app?.close()
  if (fixture) await removeFixture(fixture)
})

const heicCell = (): ReturnType<Page['locator']> =>
  window.locator('.cell').filter({ hasText: HEIC_NAME })

test('HEIC がライブラリに取り込まれ、サムネイルが表示される', async () => {
  // PNG 8 枚 + HEIC 1 枚
  await expect(window.locator('.toolbar__count')).toHaveText('9 枚', { timeout: 20_000 })
  await expect(heicCell()).toHaveCount(1)

  const thumbnail = heicCell().locator('img')
  await expect(thumbnail).toBeVisible()
  // 実際に画素が描画されていること (復号に失敗すると naturalWidth が 0 になる)
  await expect
    .poll(async () => thumbnail.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0)
})

test('単画像ビューで HEIC が表示され、解像度も正しく出る', async () => {
  await heicCell().click()
  await expect(window.locator('.viewer')).toBeVisible()

  const image = window.locator('.viewer__image')
  await expect(image).toBeVisible()
  const natural = await image.evaluate((img: HTMLImageElement) => ({
    width: img.naturalWidth,
    height: img.naturalHeight
  }))
  // 640x480 の HEIC。表示用トランスコードでも解像度は保たれる
  expect(natural).toEqual({ width: 640, height: 480 })

  await expect(window.locator('.viewer__meta', { hasText: '640×480' })).toBeVisible()
  await window.screenshot({ path: `${SHOTS}/07-heic.png` })

  await window.keyboard.press('Escape')
  await expect(window.locator('.grid')).toBeVisible()
})

test('HEIC もタグ付けの対象になる', async () => {
  await expect(window.locator('.status--done')).toHaveText('タグ付け完了 9 / 9', {
    timeout: 60_000
  })

  await heicCell().click()
  await expect(window.locator('.viewer')).toBeVisible()
  // 推論まで到達していれば、ダミーモデルが必ず付ける general が出る
  await expect(window.locator('.viewer__tags .chip', { hasText: 'general' })).toBeVisible()
  await window.keyboard.press('Escape')
})
