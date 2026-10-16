import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { createDisplayFixture, removeFixture, type Fixture } from './fixtures'

/**
 * 全画面表示と、表示上の回転。
 *
 * 全画面: F11 / バーのボタンで切り替え。単画像ビューではバーとタグ欄を隠し、
 * 画面下端にマウスを寄せたときだけ出す。Esc は全画面を抜けるのが先。
 * 回転: R / Shift+R / バーのボタン。元ファイルは変えず、画像ごとに DB へ記憶して
 * サムネイルにも反映する。
 */

let app: ElectronApplication
let window: Page
let fixture: Fixture

const SHOTS = 'e2e/.output/screenshots'

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
  await expect(window.locator('.toolbar__count')).toHaveText('3 枚', { timeout: 20_000 })
}

test.beforeAll(async () => {
  fixture = await createDisplayFixture()
  await launch()
})

test.afterAll(async () => {
  await app?.close()
  if (fixture) await removeFixture(fixture)
})

test.beforeEach(async () => {
  if (await isFullScreen()) await window.keyboard.press('F11')
  await expect.poll(isFullScreen).toBe(false)
  if (await window.locator('.viewer').isVisible()) {
    await window.keyboard.press('Escape')
    await expect(window.locator('.grid')).toBeVisible()
  }
})

function isFullScreen(): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())
}

async function open(name: string): Promise<void> {
  await window
    .locator('.cell', { has: window.locator(`.cell__caption:text-is("${name}")`) })
    .click()
  await expect(window.locator('.viewer')).toBeVisible()
  await expect(window.locator('.viewer__name')).toHaveText(name)
}

/** 見た目上の画像の大きさ (回転後の外接矩形) とステージの大きさ */
function measure(): Promise<{
  image: { width: number; height: number }
  stage: { width: number; height: number }
  overflow: number
}> {
  return window.evaluate(() => {
    const stage = document.querySelector('.viewer__stage') as HTMLElement
    const image = document.querySelector('.viewer__image') as HTMLImageElement
    const box = image.getBoundingClientRect()
    return {
      image: { width: box.width, height: box.height },
      stage: { width: stage.clientWidth, height: stage.clientHeight },
      overflow: Math.max(
        stage.scrollHeight - stage.clientHeight,
        stage.scrollWidth - stage.clientWidth
      )
    }
  })
}

/**
 * 画面下端にマウスを寄せてバーを出す。
 * 全画面に入った直後はウィンドウの大きさが変わっている途中なので、出るまで寄せ直す
 */
async function revealDock(): Promise<void> {
  await expect
    .poll(async () => {
      const size = await window.evaluate(() => ({ width: innerWidth, height: innerHeight }))
      await window.mouse.move(size.width / 2, size.height / 2)
      await window.mouse.move(size.width / 2, size.height - 10)
      return dockOpacity()
    })
    .toBe(1)
}

function dockOpacity(): Promise<number> {
  return window
    .locator('.viewer__dock')
    .evaluate((element) => Number(getComputedStyle(element).opacity))
}

test('F11 で全画面になり、単画像ビューではバーを隠して下端に寄せると出す', async () => {
  await open('wide.png')
  await expect(window.locator('.viewer__tags')).toBeVisible()

  await window.keyboard.press('F11')
  await expect.poll(isFullScreen).toBe(true)
  await expect(window.locator('.viewer')).toHaveClass(/viewer--immersive/)
  // 画像だけにする: ツールバーとサイドバーを消し、バーは隠す
  await expect(window.locator('.toolbar')).toBeHidden()
  await expect(window.locator('.sidebar')).toBeHidden()
  await expect.poll(dockOpacity).toBe(0)
  await window.waitForTimeout(300)
  await window.screenshot({ path: `${SHOTS}/fullscreen-01-viewer.png` })

  // 画面下端に寄せるとバーが出る
  await revealDock()
  await expect(window.locator('.viewer__bar')).toBeVisible()
  await window.screenshot({ path: `${SHOTS}/fullscreen-02-dock.png` })

  // Esc は全画面を抜けるだけで、単画像ビューは閉じない
  await window.keyboard.press('Escape')
  await expect.poll(isFullScreen).toBe(false)
  await expect(window.locator('.viewer')).toBeVisible()
  await expect(window.locator('.viewer')).not.toHaveClass(/viewer--immersive/)
  await expect.poll(dockOpacity).toBe(1)
  await expect(window.locator('.toolbar')).toBeVisible()
  await expect(window.locator('.sidebar')).toBeVisible()

  // もう一度押すと一覧へ戻る
  await window.keyboard.press('Escape')
  await expect(window.locator('.grid')).toBeVisible()
})

test('バーの「全画面」ボタンでも切り替えられる', async () => {
  await open('tall.png')
  await window.locator('.viewer__bar').getByRole('button', { name: '全画面', exact: true }).click()
  await expect.poll(isFullScreen).toBe(true)

  await revealDock()
  await window.locator('.viewer__bar').getByRole('button', { name: '全画面を終了' }).click()
  await expect.poll(isFullScreen).toBe(false)
  await expect(window.locator('.viewer')).toBeVisible()
})

test('一覧でも F11 で全画面になり、ツールバーとサイドバーはそのまま', async () => {
  await window.keyboard.press('F11')
  await expect.poll(isFullScreen).toBe(true)
  await expect(window.locator('.toolbar')).toBeVisible()
  await expect(window.locator('.sidebar')).toBeVisible()
  await window.waitForTimeout(300)
  await window.screenshot({ path: `${SHOTS}/fullscreen-03-grid.png` })

  // 一覧では Esc で全画面を抜ける
  await window.keyboard.press('Escape')
  await expect.poll(isFullScreen).toBe(false)
})

test('R で右に回り、回した後の向きで全体が収まる', async () => {
  await open('wide.png')
  const before = await measure()
  // 3000×1500 の横長は幅で頭打ちになる
  expect(before.image.width).toBeGreaterThan(before.image.height)

  await window.keyboard.press('r')
  await expect(window.locator('.viewer__image')).toHaveAttribute('data-rotation', '90')
  await expect.poll(async () => (await measure()).image.height).toBeGreaterThan(0)
  const after = await measure()
  // 縦長になり、はみ出さない (高さで頭打ち)
  expect(after.image.height).toBeGreaterThan(after.image.width)
  expect(after.image.height).toBeLessThanOrEqual(after.stage.height + 1)
  expect(after.image.width).toBeLessThanOrEqual(after.stage.width + 1)
  expect(Math.abs(after.image.height - after.stage.height)).toBeLessThanOrEqual(2)
  expect(after.overflow).toBeLessThanOrEqual(1)
  await window.screenshot({ path: `${SHOTS}/rotate-01-viewer.png` })

  // Shift+R で元に戻る
  await window.keyboard.press('Shift+R')
  await expect(window.locator('.viewer__image')).not.toHaveAttribute('data-rotation', /.*/)
  await expect(window.locator('.viewer__image')).toHaveClass(/viewer__image--fit/)
})

test('回転しても小さい画像は引き伸ばさない', async () => {
  await open('tiny.png')
  await window.locator('.viewer__bar').getByRole('button', { name: '左に回転' }).click()
  await expect(window.locator('.viewer__image')).toHaveAttribute('data-rotation', '270')
  await expect
    .poll(async () => {
      const { image } = await measure()
      return [Math.round(image.width), Math.round(image.height)]
    })
    .toEqual([48, 64])
  // 片付け
  await window.locator('.viewer__bar').getByRole('button', { name: '右に回転' }).click()
  await expect(window.locator('.viewer__image')).toHaveClass(/viewer__image--fit/)
})

test('回転したままホイールで拡大できる', async () => {
  await open('tall.png')
  await window.keyboard.press('r')
  await expect(window.locator('.viewer__image')).toHaveAttribute('data-rotation', '90')
  await expect.poll(async () => (await measure()).image.width).toBeGreaterThan(0)
  const fit = await measure()

  const stage = await window.locator('.viewer__stage').boundingBox()
  if (!stage) throw new Error('stage が無い')
  await window.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2)
  await window.mouse.wheel(0, -240)
  await expect.poll(async () => (await measure()).image.width).toBeGreaterThan(fit.image.width)
  const zoomed = await measure()
  // 縦横比は保たれる (1200×2400 を 90° 回して 2:1)
  expect(zoomed.image.width / zoomed.image.height).toBeCloseTo(2, 1)

  await window.keyboard.press('Shift+R')
  await expect(window.locator('.viewer__image')).toHaveClass(/viewer__image--fit/)
})

test('回転は画像ごとに記憶し、サムネイルにも反映して再起動後も残る', async () => {
  await open('wide.png')
  await window.keyboard.press('r')
  await window.keyboard.press('r')
  await expect(window.locator('.viewer__image')).toHaveAttribute('data-rotation', '180')
  await window.keyboard.press('Escape')
  await expect(window.locator('.grid')).toBeVisible()

  const thumb = window.locator('.cell', {
    has: window.locator('.cell__caption:text-is("wide.png")')
  })
  await expect(thumb.locator('img')).toHaveAttribute('style', /rotate\(180deg\)/)
  // 他の画像は回らない
  await expect(
    window
      .locator('.cell', { has: window.locator('.cell__caption:text-is("tall.png")') })
      .locator('img')
  ).not.toHaveAttribute('style', /rotate/)
  await window.screenshot({ path: `${SHOTS}/rotate-02-grid.png` })

  await app.close()
  await launch()
  const reopened = window.locator('.cell', {
    has: window.locator('.cell__caption:text-is("wide.png")')
  })
  await expect(reopened.locator('img')).toHaveAttribute('style', /rotate\(180deg\)/)
  await open('wide.png')
  await expect(window.locator('.viewer__image')).toHaveAttribute('data-rotation', '180')

  // 片付け
  await window.keyboard.press('Shift+R')
  await window.keyboard.press('Shift+R')
  await expect(window.locator('.viewer__image')).toHaveClass(/viewer__image--fit/)
})
