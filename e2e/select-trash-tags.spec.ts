import fs from 'node:fs/promises'
import path from 'node:path'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { createFixture, installDummyModel, removeFixture, type Fixture } from './fixtures'

/**
 * 一覧での複数選択、ごみ箱へ移動、手動タグの追加・削除。
 *
 * フィクスチャ:
 *   a/01.png a/02.png a/03.png a/deep/04.png a/deep/05.png b/06.png b/07.png 08.png
 */

let app: ElectronApplication
let window: Page
let fixture: Fixture
let trashDir: string

const SHOTS = 'e2e/.output/screenshots'

test.beforeAll(async () => {
  fixture = await createFixture()
  trashDir = path.join(path.dirname(fixture.root), 'trash')
  await fs.mkdir(trashDir, { recursive: true })
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

  // OS のごみ箱の代わりに、フィクスチャ横のフォルダへ移す。
  // 名前に "locked" を含むファイルは「他のアプリが開いている」として失敗させる
  await app.evaluate(({ shell }, trash) => {
    const nodeFs = process.mainModule!.require('node:fs/promises') as typeof import('node:fs/promises')
    const nodePath = process.mainModule!.require('node:path') as typeof import('node:path')
    shell.trashItem = async (target: string) => {
      if (target.includes('locked')) throw new Error('使用中')
      await nodeFs.rename(target, nodePath.join(trash, nodePath.basename(target)))
    }
  }, trashDir)
})

test.afterAll(async () => {
  await app?.close()
  if (fixture) await removeFixture(fixture)
})

test.beforeEach(async () => {
  if (await window.locator('.context-menu').isVisible()) await window.keyboard.press('Escape')
  if (await window.locator('.viewer').isVisible()) {
    await window.keyboard.press('Escape')
    await expect(window.locator('.grid')).toBeVisible()
  }
  await window.keyboard.press('Escape')
  await expect(window.locator('.cell--selected')).toHaveCount(0)
})

const cell = (relPath: string): ReturnType<Page['locator']> =>
  window.locator(`.cell[title="${relPath}"]`)
const bar = (): ReturnType<Page['locator']> => window.locator('.selection-bar')
const menu = (): ReturnType<Page['locator']> => window.locator('.context-menu')
const ctrl = process.platform === 'darwin' ? 'Meta' : 'Control'

async function selectedTitles(): Promise<string[]> {
  return window
    .locator('.cell--selected')
    .evaluateAll((cells) => cells.map((cell) => cell.getAttribute('title') ?? ''))
}

function tagRow(name: string): ReturnType<Page['locator']> {
  return window
    .locator('.panel--tags .tag')
    .filter({ has: window.locator('.tag__name', { hasText: new RegExp(`^${name}$`) }) })
}

test('Ctrl クリックで 1 枚ずつ、Shift クリックで範囲を選べる', async () => {
  await cell('a/01.png').click({ modifiers: [ctrl] })
  await expect(window.locator('.grid')).toBeVisible()
  // 1 枚だけならバーは出さない
  await expect(bar()).toBeHidden()
  await cell('a/03.png').click({ modifiers: [ctrl] })
  await expect(bar()).toContainText('2 枚選択中')
  expect(await selectedTitles()).toEqual(['a/01.png', 'a/03.png'])

  // Ctrl でもう一度押すと外れる
  await cell('a/01.png').click({ modifiers: [ctrl] })
  expect(await selectedTitles()).toEqual(['a/03.png'])

  // 起点 (最後に Ctrl クリックした 01) から Shift で範囲
  await cell('a/deep/04.png').click({ modifiers: ['Shift'] })
  expect(await selectedTitles()).toEqual(['a/01.png', 'a/02.png', 'a/03.png', 'a/deep/04.png'])
  await expect(bar()).toContainText('4 枚選択中')
  await window.screenshot({ path: `${SHOTS}/select-01-range.png` })

  // Esc で解除
  await window.keyboard.press('Escape')
  await expect(bar()).toBeHidden()
  expect(await selectedTitles()).toEqual([])

  // Ctrl+A で全部
  await window.keyboard.press(`${ctrl}+A`)
  await expect(bar()).toContainText('8 枚選択中')
  await bar().getByRole('button', { name: '選択解除' }).click()
  await expect(bar()).toBeHidden()
})

test('修飾キー無しのクリックは従来どおり開き、選択は解除する', async () => {
  await cell('a/01.png').click({ modifiers: [ctrl] })
  await cell('a/02.png').click({ modifiers: [ctrl] })
  await cell('b/06.png').click()
  await expect(window.locator('.viewer__name')).toHaveText('06.png')
  await window.keyboard.press('Escape')
  expect(await selectedTitles()).toEqual([])
})

test('選んだ画像の右クリックは全部に、選んでいない画像の右クリックはその 1 枚だけにかかる', async () => {
  await cell('a/01.png').click({ modifiers: [ctrl] })
  await cell('a/02.png').click({ modifiers: [ctrl] })

  await cell('a/02.png').click({ button: 'right' })
  await expect(menu().getByRole('menuitem', { name: '2 枚のパスをコピー' })).toBeVisible()
  await window.screenshot({ path: `${SHOTS}/select-02-menu.png` })
  await menu().getByRole('menuitem', { name: '2 枚のパスをコピー' }).click()
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe([path.join(fixture.root, 'a', '01.png'), path.join(fixture.root, 'a', '02.png')].join('\n'))

  // 選んでいない画像を右クリックすると、その 1 枚だけを選び直す
  await cell('b/07.png').click({ button: 'right' })
  expect(await selectedTitles()).toEqual(['b/07.png'])
  await expect(menu().getByRole('menuitem', { name: 'パスをコピー', exact: true })).toBeVisible()
  await window.keyboard.press('Escape')
})

test('選択バーでまとめてお気に入りにできる', async () => {
  await cell('a/01.png').click({ modifiers: [ctrl] })
  await cell('b/06.png').click({ modifiers: [ctrl] })
  await bar().getByRole('button', { name: '★ お気に入りに追加' }).click()
  await expect(cell('a/01.png').locator('.cell__star')).toHaveText('★')
  await expect(cell('b/06.png').locator('.cell__star')).toHaveText('★')
  await expect(cell('a/02.png').locator('.cell__star')).toHaveText('☆')

  await bar().getByRole('button', { name: '☆ お気に入りから外す' }).click()
  await expect(cell('a/01.png').locator('.cell__star')).toHaveText('☆')
})

test('単画像ビューでタグを手で足し、外せる (外したタグは付け直しでも戻らない)', async () => {
  await cell('a/01.png').click()
  const tags = window.locator('.viewer__tags')
  await expect(tags.locator('.chip', { hasText: 'red_image' })).toBeVisible()

  // 足す。無いタグ名でも作れる
  const input = tags.getByRole('combobox', { name: '追加するタグ' })
  await input.fill('my_pick')
  await input.press('Enter')
  const manual = tags.locator('.chip', { hasText: 'my_pick' })
  await expect(manual).toBeVisible()
  await expect(manual).toHaveClass(/chip--manual/)
  // 入力中の Enter や文字キーでページ送りや回転をしない
  await expect(window.locator('.viewer__name')).toHaveText('01.png')

  // 自動で付いたタグを外す
  await tags.locator('.tag-chip', { hasText: 'red_image' }).hover()
  await tags.getByRole('button', { name: 'red_image を外す' }).click()
  await expect(tags.locator('.chip', { hasText: 'red_image' })).toHaveCount(0)
  await tags.locator('.tag-chip', { hasText: 'my_pick' }).hover()
  await window.screenshot({ path: `${SHOTS}/tags-01-viewer.png` })

  // サイドバーのタグ一覧にも出て、絞り込める
  await window.keyboard.press('Escape')
  await expect(tagRow('my_pick')).toBeVisible()
  await expect(tagRow('my_pick').locator('.tag__count')).toHaveText('1')

  // 全部を付け直しても、足したタグは残り外したタグは戻らない
  await window.evaluate("window.api.scanControl('rescanAll')")
  await expect(window.locator('.status--done')).toHaveText('タグ付け完了 8 / 8', {
    timeout: 60_000
  })
  await cell('a/01.png').click()
  await expect(tags.locator('.chip', { hasText: 'my_pick' })).toBeVisible()
  await expect(tags.locator('.chip', { hasText: 'bright' })).toBeVisible()
  await expect(tags.locator('.chip', { hasText: 'red_image' })).toHaveCount(0)
})

test('選択バーで、選んだ画像にまとめてタグを足し外しできる', async () => {
  await cell('a/02.png').click({ modifiers: [ctrl] })
  await cell('a/03.png').click({ modifiers: [ctrl] })
  await bar().getByRole('button', { name: 'タグの追加・削除' }).click()

  const input = bar().getByRole('combobox', { name: '追加するタグ' })
  await input.fill('batch_tag')
  await input.press('Enter')
  const chip = bar().locator('.chip', { hasText: 'batch_tag' })
  await expect(chip).toContainText('2')
  await expect(tagRow('batch_tag').locator('.tag__count')).toHaveText('2')
  await window.screenshot({ path: `${SHOTS}/tags-02-bulk.png` })

  await bar().getByRole('button', { name: 'batch_tag を外す' }).click()
  await expect(chip).toHaveCount(0)
  await expect(tagRow('batch_tag')).toHaveCount(0)
})

test('確認してからごみ箱へ移す。キャンセルすれば何もしない', async () => {
  await expect(window.locator('.toolbar__count')).toHaveText('8 枚')
  await cell('a/deep/04.png').click({ modifiers: [ctrl] })
  await cell('a/deep/05.png').click({ modifiers: [ctrl] })

  // キャンセル
  window.once('dialog', (dialog) => {
    expect(dialog.message()).toContain('2 枚の画像をごみ箱へ移動しますか？')
    void dialog.dismiss()
  })
  await window.keyboard.press('Delete')
  await expect(window.locator('.toolbar__count')).toHaveText('8 枚')

  // 実行
  window.once('dialog', (dialog) => void dialog.accept())
  await bar().getByRole('button', { name: 'ごみ箱へ移動' }).click()
  await expect(window.locator('.toolbar__count')).toHaveText('6 枚')
  await expect(window.locator('.notice')).toHaveText('2 枚をごみ箱へ移動しました')
  await expect(bar()).toBeHidden()
  expect((await fs.readdir(trashDir)).sort()).toEqual(['04.png', '05.png'])
  await expect(fs.access(path.join(fixture.root, 'a', 'deep', '04.png'))).rejects.toThrow()
})

test('単画像ビューで消すと次の画像へ進み、最後の 1 枚なら前へ戻る', async () => {
  await cell('b/06.png').click()
  await expect(window.locator('.viewer__name')).toHaveText('06.png')

  window.once('dialog', (dialog) => {
    expect(dialog.message()).toContain('「06.png」をごみ箱へ移動しますか？')
    void dialog.accept()
  })
  await window.keyboard.press('Delete')
  await expect(window.locator('.viewer__name')).toHaveText('07.png')
  await expect(window.locator('.toolbar__count')).toHaveText('5 枚')

  // 07 は並びの末尾 (パス順で 08.png が先頭) なので、消すと前の画像へ
  await window.keyboard.press('End')
  const last = await window.locator('.viewer__name').innerText()
  window.once('dialog', (dialog) => void dialog.accept())
  await window.getByRole('button', { name: 'ごみ箱へ移動' }).click()
  await expect(window.locator('.viewer__name')).not.toHaveText(last)
  await expect(window.locator('.viewer')).toBeVisible()
  await expect(window.locator('.toolbar__count')).toHaveText('4 枚')
})

test('移せなかったファイルは残し、件数を知らせる', async () => {
  await fs.copyFile(path.join(fixture.root, '08.png'), path.join(fixture.root, 'locked.png'))
  await expect(cell('locked.png')).toBeVisible({ timeout: 15_000 })

  await cell('locked.png').click({ button: 'right' })
  window.once('dialog', (dialog) => void dialog.accept())
  await menu().getByRole('menuitem', { name: 'ごみ箱へ移動' }).click()
  await expect(window.locator('.notice')).toHaveText('1 枚をごみ箱へ移動できませんでした')
  await expect(cell('locked.png')).toBeVisible()
})
