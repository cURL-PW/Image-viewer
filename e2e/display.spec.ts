import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { DISPLAY_SIZES, createDisplayFixture, removeFixture, type Fixture } from './fixtures'

/**
 * 単画像ビューの表示の決まりを確かめる。
 *
 * 既定は「画像全体が収まる大きさ」。はみ出さない範囲で最大にし、
 * 画面より小さい画像は引き伸ばさない。
 */

let app: ElectronApplication
let window: Page
let fixture: Fixture

const SHOTS = 'e2e/.output/screenshots'

test.beforeAll(async () => {
  fixture = await createDisplayFixture()
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
  await expect(window.locator('.toolbar__count')).toHaveText('3 枚', { timeout: 20_000 })
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
})

/** ファイル名で画像を開く。 */
async function open(name: string): Promise<void> {
  await window
    .locator('.cell', { has: window.locator(`.cell__caption:text-is("${name}")`) })
    .click()
  await expect(window.locator('.viewer')).toBeVisible()
  await expect(window.locator('.viewer__name')).toHaveText(name)
}

/** 表示中の画像とステージの寸法。 */
async function measure(): Promise<{
  image: { width: number; height: number }
  stage: { width: number; height: number }
}> {
  return window.evaluate(() => {
    const stage = document.querySelector('.viewer__stage') as HTMLElement
    const image = document.querySelector('.viewer__image') as HTMLImageElement
    const box = image.getBoundingClientRect()
    return {
      image: { width: box.width, height: box.height },
      stage: { width: stage.clientWidth, height: stage.clientHeight }
    }
  })
}

test('横長の画像は幅で頭打ちになり、全体が収まる', async () => {
  await open('wide.png')
  const { image, stage } = await measure()
  const source = DISPLAY_SIZES['wide.png']

  // はみ出さない
  expect(image.width).toBeLessThanOrEqual(stage.width + 1)
  expect(image.height).toBeLessThanOrEqual(stage.height + 1)
  // 幅いっぱいまで使っている (横長なので幅で決まる)
  expect(Math.abs(image.width - stage.width)).toBeLessThanOrEqual(1)
  // 縦横比が保たれている
  expect(Math.abs(image.width / image.height - source.width / source.height)).toBeLessThan(0.01)

  await window.screenshot({ path: `${SHOTS}/11-fit-wide.png` })
})

test('縦長の画像は高さで頭打ちになり、下が切れない', async () => {
  await open('tall.png')
  const { image, stage } = await measure()
  const source = DISPLAY_SIZES['tall.png']

  expect(image.height).toBeLessThanOrEqual(stage.height + 1)
  // 高さいっぱいまで使い、幅は余る (以前の「幅いっぱい」ではここが切れていた)
  expect(Math.abs(image.height - stage.height)).toBeLessThanOrEqual(1)
  expect(image.width).toBeLessThan(stage.width)
  expect(Math.abs(image.width / image.height - source.width / source.height)).toBeLessThan(0.01)

  // 全体が収まっているので縦スクロールは要らない
  const scrollable = await window.evaluate(() => {
    const stageElement = document.querySelector('.viewer__stage') as HTMLElement
    return stageElement.scrollHeight - stageElement.clientHeight
  })
  expect(scrollable).toBeLessThanOrEqual(1)

  await window.screenshot({ path: `${SHOTS}/12-fit-tall.png` })
})

test('画面より小さい画像は引き伸ばさない', async () => {
  await open('tiny.png')
  const { image, stage } = await measure()
  const source = DISPLAY_SIZES['tiny.png']

  expect(image.width).toBe(source.width)
  expect(image.height).toBe(source.height)
  expect(image.width).toBeLessThan(stage.width)
})

test('拡大の基準は全体表示の大きさ', async () => {
  await open('wide.png')
  const before = await measure()

  const box = await window.locator('.viewer__stage').boundingBox()
  if (!box) throw new Error('ステージが見つかりません')
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await window.mouse.wheel(0, -120)
  await expect(window.locator('.viewer__meta').filter({ hasText: '%' })).toHaveText('115%')

  const after = await measure()
  expect(after.image.width / before.image.width).toBeCloseTo(1.15, 1)
})

test('「幅に合わせる」で以前の見え方に切り替えられる', async () => {
  await open('tall.png')
  await window.locator('.viewer__bar').getByRole('button', { name: '幅に合わせる' }).click()

  const { image, stage } = await measure()
  expect(Math.abs(image.width - stage.width)).toBeLessThanOrEqual(1)
})
