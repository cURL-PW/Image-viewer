import path from 'node:path'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { createFixture, installDummyModel, removeFixture, type Fixture } from './fixtures'

let app: ElectronApplication
let window: Page
let fixture: Fixture

const SHOTS = 'e2e/.output/screenshots'

test.beforeAll(async () => {
  fixture = await createFixture()
  // 「タグをコピー」を確かめるため、ダミーモデルでタグを付けておく
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
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
  })
  window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await expect(window.locator('.status--done')).toHaveText('タグ付け完了 8 / 8', {
    timeout: 60_000
  })

  // 実際にエクスプローラーや既定アプリを開かないよう、呼ばれたパスだけ記録する
  await app.evaluate(({ shell }) => {
    const calls: string[] = []
    ;(globalThis as Record<string, unknown>).__shellCalls = calls
    shell.openPath = async (target: string) => {
      calls.push(`open:${target}`)
      return ''
    }
    shell.showItemInFolder = (target: string) => {
      calls.push(`reveal:${target}`)
    }
  })
})

test.afterAll(async () => {
  await app?.close()
  if (fixture) await removeFixture(fixture)
})

test.beforeEach(async () => {
  if (await menu().isVisible()) await window.keyboard.press('Escape')
  if (await window.locator('.viewer').isVisible()) {
    await window.keyboard.press('Escape')
    await expect(window.locator('.grid')).toBeVisible()
  }
  await app.evaluate(({ clipboard }) => clipboard.clear())
})

const menu = (): ReturnType<Page['locator']> => window.locator('.context-menu')
const menuItem = (label: string): ReturnType<Page['locator']> =>
  menu().getByRole('menuitem', { name: label, exact: true })

/** 相対パスでサムネイルを選ぶ (並び順は更新日時なので位置では決まらない) */
const cell = (relPath: string): ReturnType<Page['locator']> =>
  window.locator(`.cell[title="${relPath}"]`)
const firstCell = (): ReturnType<Page['locator']> => cell('a/01.png')

async function readClipboardText(): Promise<string> {
  return app.evaluate(({ clipboard }) => clipboard.readText())
}

async function shellCalls(): Promise<string[]> {
  return app.evaluate(() => (globalThis as Record<string, unknown>).__shellCalls as string[])
}

test('一覧のサムネイルを右クリックするとメニューが出る', async () => {
  await firstCell().click({ button: 'right' })
  await expect(menu()).toBeVisible()
  await expect(menu().getByRole('menuitem')).toHaveText([
    '開く',
    '既定のアプリで開く',
    // e2e は Linux で動かすので Linux の文言。Windows では「エクスプローラーで表示」
    process.platform === 'win32'
      ? 'エクスプローラーで表示'
      : process.platform === 'darwin'
        ? 'Finder で表示'
        : 'フォルダで表示',
    '画像をコピー',
    'パスをコピー',
    'ファイル名をコピー',
    'タグをコピー'
  ])
  // タグ付け済みなので「タグをコピー」も押せる
  await expect(menuItem('タグをコピー')).toBeEnabled()
  // 右クリックで単画像ビューへ移ってはいけない
  await expect(window.locator('.grid')).toBeVisible()
  await menuItem('パスをコピー').hover()
  await window.screenshot({ path: `${SHOTS}/context-menu-grid.png` })
})

test('「開く」で単画像ビューを開く', async () => {
  await cell('a/02.png').click({ button: 'right' })
  await menuItem('開く').click()
  await expect(window.locator('.viewer')).toBeVisible()
  await expect(window.locator('.viewer__name')).toHaveText('02.png')
  await expect(menu()).toBeHidden()
})

test('パス・ファイル名・タグをクリップボードへコピーする', async () => {
  await firstCell().click({ button: 'right' })
  await menuItem('パスをコピー').click()
  await expect(menu()).toBeHidden()
  await expect(window.locator('.notice')).toHaveText('パスをコピーしました')
  expect(await readClipboardText()).toBe(path.join(fixture.root, 'a', '01.png'))

  await firstCell().click({ button: 'right' })
  await menuItem('ファイル名をコピー').click()
  await expect.poll(readClipboardText).toBe('01.png')

  await firstCell().click({ button: 'right' })
  await menuItem('タグをコピー').click()
  // カンマ区切り。ダミーモデルでも rating の general は必ず付く
  await expect.poll(readClipboardText).toMatch(/(^|, )general(, |$)/)
})

test('画像そのものをクリップボードへコピーする', async () => {
  await firstCell().click({ button: 'right' })
  await menuItem('画像をコピー').click()
  await expect(window.locator('.notice')).toHaveText('画像をコピーしました')
  // a/01.png は 320×240 で生成している
  const size = await app.evaluate(({ clipboard }) => clipboard.readImage().getSize())
  expect(size).toEqual({ width: 320, height: 240 })
})

test('既定のアプリで開く・フォルダで表示は対象のファイルを渡す', async () => {
  const target = path.join(fixture.root, 'a', '01.png')
  await firstCell().click({ button: 'right' })
  await menuItem('既定のアプリで開く').click()
  await expect.poll(shellCalls).toContain(`open:${target}`)

  await firstCell().click({ button: 'right' })
  await menu().getByRole('menuitem').nth(2).click()
  await expect.poll(shellCalls).toContain(`reveal:${target}`)
})

test('単画像ビューでも右クリックメニューが出て、Esc はメニューだけを閉じる', async () => {
  await firstCell().click()
  await expect(window.locator('.viewer')).toBeVisible()

  // 画像の中央 (ページ送りの領域の外) を右クリック
  const stage = window.locator('.viewer__stage')
  await stage.click({ button: 'right' })
  await expect(menu()).toBeVisible()
  // 開いている最中なので「開く」は出さない
  await expect(menuItem('開く')).toHaveCount(0)
  await expect(menuItem('画像をコピー')).toBeVisible()
  await menuItem('画像をコピー').hover()
  await window.screenshot({ path: `${SHOTS}/context-menu-viewer.png` })

  await window.keyboard.press('Escape')
  await expect(menu()).toBeHidden()
  await expect(window.locator('.viewer')).toBeVisible()

  // ページ送りの領域の上でも開ける
  await window.locator('.viewer__edge--next').click({ button: 'right' })
  await expect(menu()).toBeVisible()
  await menuItem('ファイル名をコピー').click()
  await expect.poll(readClipboardText).toBe('01.png')
  // 右クリックでページ送りされていない
  await expect(window.locator('.viewer__name')).toHaveText('01.png')
})

test('メニューの外をクリックすると閉じ、画面端でははみ出さない', async () => {
  await firstCell().click({ button: 'right' })
  await expect(menu()).toBeVisible()
  await window.locator('.toolbar').click({ position: { x: 5, y: 5 } })
  await expect(menu()).toBeHidden()
  await expect(window.locator('.grid')).toBeVisible()

  // ウィンドウ右下の隅で開く (グリッドの空き領域は対象外なので、メニューを直接開く)
  const viewport = await window.evaluate(() => ({
    width: globalThis.innerWidth,
    height: globalThis.innerHeight
  }))
  const rect = await firstCell().boundingBox()
  expect(rect).not.toBeNull()
  await window.mouse.click(rect!.x + 10, rect!.y + 10, { button: 'right' })
  const box = await menu().boundingBox()
  expect(box).not.toBeNull()
  await window.keyboard.press('Escape')

  await window.evaluate(
    ({ x, y }) => {
      const element = document.querySelector('.cell')!
      element.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y })
      )
    },
    { x: viewport.width - 2, y: viewport.height - 2 }
  )
  await expect(menu()).toBeVisible()
  const edge = await menu().boundingBox()
  expect(edge!.x + edge!.width).toBeLessThanOrEqual(viewport.width)
  expect(edge!.y + edge!.height).toBeLessThanOrEqual(viewport.height)
  expect(edge!.width).toBeCloseTo(box!.width, 0)
})

test('キーボードで項目を選んで実行できる', async () => {
  await firstCell().click({ button: 'right' })
  await expect(menu()).toBeVisible()
  // 開く → 既定のアプリで開く → フォルダで表示 → 画像をコピー → パスをコピー
  for (let i = 0; i < 5; i++) await window.keyboard.press('ArrowDown')
  await expect(window.locator('.context-menu__item--active')).toHaveText('パスをコピー')
  await window.keyboard.press('Enter')
  await expect(menu()).toBeHidden()
  await expect.poll(readClipboardText).toBe(path.join(fixture.root, 'a', '01.png'))
})
