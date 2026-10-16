import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { createFixture, installDummyModel, removeFixture, type Fixture } from './fixtures'

/**
 * 似た画像を探す。ライブラリ全体から、タグの似ている順に並べる。
 *
 * フィクスチャ (ダミーモデルで色のタグが付く):
 *   a/01.png a/02.png a/03.png a/deep/04.png a/deep/05.png b/06.png b/07.png 08.png
 */

let app: ElectronApplication
let window: Page
let fixture: Fixture

const SHOTS = 'e2e/.output/screenshots'

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
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
  })
  window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await expect(window.locator('.status--done')).toHaveText('タグ付け完了 8 / 8', {
    timeout: 60_000
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
  const exit = window.getByRole('button', { name: '× 元の一覧に戻る' })
  if (await exit.isVisible()) await exit.click()
  await folderRow('library').click()
  await expectCount(8)
})

function folderRow(name: string): ReturnType<Page['locator']> {
  return window
    .locator('.tree__row')
    .filter({ has: window.locator('.tree__name', { hasText: new RegExp(`^${name}$`) }) })
}

const cell = (relPath: string): ReturnType<Page['locator']> =>
  window.locator(`.cell[title="${relPath}"]`)

async function expectCount(count: number): Promise<void> {
  await expect(window.locator('.toolbar__count')).toHaveText(`${count} 枚`)
}

async function captions(): Promise<string[]> {
  return window
    .locator('.cell')
    .evaluateAll((cells) => cells.map((cell) => cell.getAttribute('title') ?? ''))
}

test('右クリックの「似た画像を探す」で、元の画像を先頭に似ている順に並ぶ', async () => {
  // a/01.png と b/06.png だけに共通のタグを足して、いちばん似ている組にする
  await cell('a/01.png').click({ modifiers: ['ControlOrMeta'] })
  await cell('b/06.png').click({ modifiers: ['ControlOrMeta'] })
  await window.locator('.selection-bar').getByRole('button', { name: 'タグの追加・削除' }).click()
  const input = window.locator('.selection-bar').getByPlaceholder('選んだ画像すべてに足すタグ')
  for (const name of ['pair_one', 'pair_two', 'pair_three']) {
    await input.fill(name)
    await input.press('Enter')
    await expect(window.locator('.selection-bar .chip', { hasText: name })).toBeVisible()
  }
  await window.locator('.selection-bar').getByRole('button', { name: '選択解除' }).click()
  await expect(window.locator('.selection-bar')).toHaveCount(0)

  // フォルダ a を選んでいても、探す範囲はライブラリ全体
  await folderRow('a').click()
  await expectCount(5)

  await cell('a/01.png').click({ button: 'right' })
  await window.locator('.context-menu').getByRole('menuitem', { name: '似た画像を探す' }).click()

  const banner = window.locator('.similar-banner')
  await expect(banner).toBeVisible()
  await expect(banner.locator('.similar-banner__name')).toHaveText('01.png')
  const list = await captions()
  expect(list[0]).toBe('a/01.png')
  // 共通のタグが多い b/06.png がいちばん似ている。ほかの画像もモデルのタグを共有するので並ぶ
  expect(list[1]).toBe('b/06.png')
  expect(list).toHaveLength(8)
  await expect(banner.locator('.similar-banner__count')).toHaveText(`${list.length - 1} 枚`)
  await window.screenshot({ path: `${SHOTS}/similar-01-grid.png` })

  // 似た画像の一覧からも単画像ビューで順に見られる
  await cell('b/06.png').click()
  await expect(window.locator('.viewer__name')).toHaveText('06.png')
  await window.keyboard.press('ArrowLeft')
  await expect(window.locator('.viewer__name')).toHaveText('01.png')
  await window.keyboard.press('Escape')
  await expect(banner).toBeVisible()

  // × で元の絞り込み (フォルダ a) に戻る
  await window.getByRole('button', { name: '× 元の一覧に戻る' }).click()
  await expect(banner).toHaveCount(0)
  await expectCount(5)
})

test('単画像ビューの「似た画像」ボタンからも探せ、Esc で戻る', async () => {
  await cell('a/02.png').click()
  await expect(window.locator('.viewer__name')).toHaveText('02.png')
  await window.screenshot({ path: `${SHOTS}/similar-02-viewer.png` })
  await window.locator('.viewer__bar').getByRole('button', { name: '似た画像' }).click()

  // ビューは閉じて、一覧に似た画像が並ぶ
  await expect(window.locator('.grid')).toBeVisible()
  await expect(window.locator('.similar-banner__name')).toHaveText('02.png')
  const list = await captions()
  expect(list[0]).toBe('a/02.png')
  expect(list.length).toBeGreaterThan(1)

  await window.keyboard.press('Escape')
  await expect(window.locator('.similar-banner')).toHaveCount(0)
  await expectCount(8)
})

test('フォルダや絞り込みを変えると、似た画像の表示は解除される', async () => {
  await cell('a/03.png').click({ button: 'right' })
  await window.locator('.context-menu').getByRole('menuitem', { name: '似た画像を探す' }).click()
  await expect(window.locator('.similar-banner')).toBeVisible()

  await folderRow('b').click()
  await expect(window.locator('.similar-banner')).toHaveCount(0)
  await expectCount(2)
})
