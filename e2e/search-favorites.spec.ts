import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { createFixture, installDummyModel, removeFixture, type Fixture } from './fixtures'

/**
 * ファイル名・パス検索、お気に入り (★)、絞り込み条件の保存。
 *
 * フィクスチャ:
 *   a/01.png a/02.png a/03.png a/deep/04.png a/deep/05.png b/06.png b/07.png 08.png
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
  await expect(window.locator('.status--done')).toHaveText('タグ付け完了 8 / 8', {
    timeout: 60_000
  })
}

test.beforeAll(async () => {
  fixture = await createFixture()
  // 条件の保存でタグも使うので、ダミーモデルでタグを付けておく
  await installDummyModel(fixture)
  await launch()
})

test.afterAll(async () => {
  await app?.close()
  if (fixture) await removeFixture(fixture)
})

/** 毎回まっさらな絞り込みのルート表示に戻す */
test.beforeEach(async () => {
  if (await window.locator('.viewer').isVisible()) {
    await window.keyboard.press('Escape')
    await expect(window.locator('.grid')).toBeVisible()
  }
  await searchBox().fill('')
  const favoritesOnly = window.getByLabel('★ お気に入りのみ')
  if (await favoritesOnly.isChecked()) await favoritesOnly.uncheck()
  const clear = window.locator('.panel--tags .button--subtle', { hasText: 'クリア' })
  if (await clear.isVisible()) await clear.click()
  await folderRow('library').click()
  await expectCount(8)
})

const searchBox = (): ReturnType<Page['locator']> =>
  window.getByRole('searchbox', { name: 'ファイル名・パスで検索' })

function folderRow(name: string): ReturnType<Page['locator']> {
  return window
    .locator('.tree__row')
    .filter({ has: window.locator('.tree__name', { hasText: new RegExp(`^${name}$`) }) })
}

function tagRow(name: string): ReturnType<Page['locator']> {
  return window
    .locator('.tag')
    .filter({ has: window.locator('.tag__name', { hasText: new RegExp(`^${name}$`) }) })
}

const cell = (relPath: string): ReturnType<Page['locator']> =>
  window.locator(`.cell[title="${relPath}"]`)

async function expectCount(count: number): Promise<void> {
  await expect(window.locator('.toolbar__count')).toHaveText(`${count} 枚`)
}

async function captions(): Promise<string[]> {
  return window.locator('.cell').evaluateAll((cells) => cells.map((cell) => cell.getAttribute('title') ?? ''))
}

test('ファイル名・パスで検索できる (部分一致、空白区切りで AND)', async () => {
  await searchBox().fill('deep')
  await expectCount(2)
  expect(await captions()).toEqual(['a/deep/04.png', 'a/deep/05.png'])

  // 大文字小文字は区別しない。空白で区切るとすべてを含むものだけ
  await searchBox().fill('A/DEEP 05')
  await expectCount(1)
  expect(await captions()).toEqual(['a/deep/05.png'])
  await window.screenshot({ path: `${SHOTS}/search-01.png` })

  // フォルダの選択とも組み合わさる
  await searchBox().fill('0')
  await expectCount(8)
  await folderRow('b').click()
  await expectCount(2)

  // 単画像ビューのページ送りも検索結果の並びに従う
  await folderRow('library').click()
  await searchBox().fill('deep')
  await expectCount(2)
  await cell('a/deep/04.png').click()
  await expect(window.locator('.viewer__meta').first()).toHaveText('1 / 2')
  await window.keyboard.press('ArrowRight')
  await expect(window.locator('.viewer__name')).toHaveText('05.png')
})

test('サムネイルの ★ でお気に入りにし、お気に入りだけに絞れる', async () => {
  const star = cell('a/02.png').locator('.cell__star')
  await cell('a/02.png').hover()
  await expect(star).toHaveText('☆')
  await star.click()
  // ★ を押しても単画像ビューは開かない
  await expect(window.locator('.grid')).toBeVisible()
  await expect(star).toHaveText('★')
  await expect(star).toHaveClass(/cell__star--on/)

  await cell('b/06.png').hover()
  await cell('b/06.png').locator('.cell__star').click()

  // 付いていないものはマウスを乗せたときだけ出す
  await window.mouse.move(5, 5)
  const opacity = (relPath: string): Promise<string> =>
    cell(relPath)
      .locator('.cell__star')
      .evaluate((element) => getComputedStyle(element).opacity)
  await expect.poll(() => opacity('a/02.png')).toBe('1')
  await expect.poll(() => opacity('a/01.png')).toBe('0')
  await window.screenshot({ path: `${SHOTS}/favorites-01-grid.png` })

  await window.getByLabel('★ お気に入りのみ').check()
  await expectCount(2)
  expect(await captions()).toEqual(['a/02.png', 'b/06.png'])
  await window.screenshot({ path: `${SHOTS}/favorites-02-only.png` })

  // 外すと一覧から消える
  await cell('b/06.png').locator('.cell__star').click()
  await expectCount(1)

  // 片付け
  await cell('a/02.png').locator('.cell__star').click()
  await expectCount(0)
})

test('単画像ビューの ★ と F キー、右クリックメニューでも付け外しできる', async () => {
  await cell('a/03.png').click()
  await expect(window.locator('.viewer__name')).toHaveText('03.png')
  const viewerStar = window.locator('.viewer__star')
  await expect(viewerStar).toHaveText('☆')

  await window.keyboard.press('f')
  await expect(viewerStar).toHaveText('★')
  await window.screenshot({ path: `${SHOTS}/favorites-03-viewer.png` })
  await viewerStar.click()
  await expect(viewerStar).toHaveText('☆')

  await window.keyboard.press('Escape')
  await cell('a/03.png').click({ button: 'right' })
  await window.locator('.context-menu').getByRole('menuitem', { name: 'お気に入りに追加' }).click()
  await expect(cell('a/03.png').locator('.cell__star')).toHaveText('★')

  await cell('a/03.png').click({ button: 'right' })
  await window
    .locator('.context-menu')
    .getByRole('menuitem', { name: 'お気に入りから外す' })
    .click()
  await expect(cell('a/03.png').locator('.cell__star')).toHaveText('☆')
})

test('今の条件を保存して呼び出せる (フォルダは切り替えない)', async () => {
  const red = Number(await tagRow('red_image').locator('.tag__count').innerText())
  expect(red).toBeGreaterThan(0)

  // タグ + 検索 + 並び順を保存する
  await tagRow('red_image').locator('.tag__main').click()
  await searchBox().fill('png')
  await expectCount(red)
  await window.locator('.toolbar__field select').selectOption('name')
  await window.getByRole('button', { name: '＋ 今の条件を保存' }).click()
  const name = window.getByRole('textbox', { name: '条件の名前' })
  await name.fill('赤い画像')
  await name.press('Enter')
  await expect(window.locator('.presets__row', { hasText: '赤い画像' })).toBeVisible()

  // 条件を外してから、フォルダ b を選んで呼び出す
  await window.locator('.panel--tags .button--subtle', { hasText: 'クリア' }).click()
  await searchBox().fill('')
  await window.locator('.toolbar__field select').selectOption('path')
  await folderRow('b').click()
  await expectCount(2)

  await window.locator('.presets__row', { hasText: '赤い画像' }).click()
  // フォルダは b のまま、条件だけが当たる
  await expect(folderRow('b')).toHaveClass(/tree__row--selected/)
  await expect(window.locator('.panel--tags .chip', { hasText: 'red_image' })).toBeVisible()
  await expect(searchBox()).toHaveValue('png')
  await expect(window.locator('.toolbar__field select')).toHaveValue('name')
  const inB = await captions()
  expect(inB.length).toBeGreaterThan(0)
  expect(inB.every((relPath) => relPath.startsWith('b/'))).toBe(true)
  await window.screenshot({ path: `${SHOTS}/presets-01-applied.png` })

  await window.locator('.toolbar__field select').selectOption('path')
})

test('保存した条件は右クリックで名前の変更と削除ができ、再起動後も残る', async () => {
  await window.getByLabel('★ お気に入りのみ').check()
  await window.getByRole('button', { name: '＋ 今の条件を保存' }).click()
  await window.getByRole('textbox', { name: '条件の名前' }).fill('お気に入り')
  await window.getByRole('textbox', { name: '条件の名前' }).press('Enter')
  const row = window.locator('.presets__row', { hasText: 'お気に入り' })
  await expect(row).toBeVisible()

  await row.click({ button: 'right' })
  await window.locator('.panel--presets .context-menu').getByRole('menuitem', { name: '名前を変更' }).click()
  const input = window.getByRole('textbox', { name: '条件の名前' })
  await input.fill('★だけ')
  await input.press('Enter')
  await expect(window.locator('.presets__row', { hasText: '★だけ' })).toBeVisible()
  await window.screenshot({ path: `${SHOTS}/presets-02-renamed.png` })

  // 再起動しても残る
  await app.close()
  await launch()
  await expect(window.locator('.presets__row', { hasText: '★だけ' })).toBeVisible()
  await expect(window.locator('.presets__row', { hasText: '赤い画像' })).toBeVisible()

  window.once('dialog', (dialog) => void dialog.accept())
  await window.locator('.presets__row', { hasText: '★だけ' }).click({ button: 'right' })
  await window.locator('.panel--presets .context-menu').getByRole('menuitem', { name: '削除' }).click()
  await expect(window.locator('.presets__row', { hasText: '★だけ' })).toHaveCount(0)
  await expect(window.locator('.presets__row', { hasText: '赤い画像' })).toBeVisible()
})
