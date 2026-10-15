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
import { writeImage } from './fixtures'

/**
 * 複数のフォルダをライブラリとして登録し、一覧から切り替えられることを確かめる。
 * フォルダ選択ダイアログは操作できないので、main 側の dialog を差し替えて選ばせる。
 */

const SHOTS = 'e2e/.output/screenshots'

// 前のテストで作った登録状態を引き継ぐので、順に流す
test.describe.configure({ mode: 'serial' })

let base: string
let userData: string
let first: string
let second: string
let app: ElectronApplication | null = null
let window: Page

async function launch(args: string[] = []): Promise<void> {
  app = await electron.launch({
    args: [
      'out/main/index.js',
      ...args,
      `--user-data-dir=${userData}`,
      '--no-sandbox',
      '--disable-gpu'
    ],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
  })
  window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
}

/** 次に開くフォルダ選択ダイアログで、指定のフォルダが選ばれたことにする。 */
async function pickFolderNext(folder: string): Promise<void> {
  await app!.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as never
  }, folder)
}

const rows = (): ReturnType<Page['locator']> => window.locator('.libraries__row')
const activeRow = (): ReturnType<Page['locator']> => window.locator('.libraries__row--active')

test.beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'image-viewer-e2e-'))
  userData = path.join(base, 'userdata')
  first = path.join(base, 'photos')
  second = path.join(base, 'screenshots')
  await fs.mkdir(userData, { recursive: true })
  for (let index = 0; index < 3; index++) {
    await writeImage(path.join(first, `p${index + 1}.png`), index, 160, 120)
  }
  for (let index = 0; index < 5; index++) {
    await writeImage(path.join(second, 'sub', `s${index + 1}.png`), index + 3, 160, 120)
  }
  await fs.mkdir(SHOTS, { recursive: true })
})

test.afterAll(async () => {
  await app?.close()
  await fs.rm(base, { recursive: true, force: true })
})

test('2 つ目のフォルダを追加すると一覧に並び、切り替えられる', async () => {
  await launch(['--root', first])
  await expect(window.locator('.toolbar__count')).toHaveText('3 枚', { timeout: 30_000 })
  await expect(rows()).toHaveCount(1)
  await expect(activeRow()).toContainText('photos')

  // 追加したフォルダがそのまま開かれる
  await pickFolderNext(second)
  await window.getByRole('button', { name: '＋ 追加' }).click()
  await expect(window.locator('.toolbar__count')).toHaveText('5 枚', { timeout: 30_000 })
  await expect(rows()).toHaveCount(2)
  await expect(activeRow()).toContainText('screenshots')
  await expect(window.locator('.panel--tree .tree__row').first()).toContainText('screenshots')
  // 走査が終われば一覧の枚数も埋まる
  await expect(activeRow().locator('.libraries__count')).toHaveText('5')

  // サブフォルダを選んでから切り替えると、絞り込みは初期化される
  await window.locator('.panel--tree .tree__name', { hasText: 'sub' }).click()
  await rows().filter({ hasText: 'photos' }).click()
  await expect(window.locator('.toolbar__count')).toHaveText('3 枚')
  await expect(activeRow()).toContainText('photos')
  await expect(window.locator('.cell')).toHaveCount(3)
  await expect(window.locator('.panel--tree .tree__row--selected')).toContainText('photos')

  await rows().first().hover()
  await window.screenshot({ path: `${SHOTS}/libraries-list.png` })
})

test('同じフォルダを追加しても二重に登録されない', async () => {
  await pickFolderNext(first)
  await window.getByRole('button', { name: '＋ 追加' }).click()
  await expect(rows()).toHaveCount(2)
  await expect(activeRow()).toContainText('photos')
})

test('登録したライブラリは再起動後も残り、最後に開いていたものが開く', async () => {
  await rows().filter({ hasText: 'screenshots' }).click()
  await expect(window.locator('.toolbar__count')).toHaveText('5 枚')
  await app!.close()
  app = null

  await launch()
  await expect(window.locator('.toolbar__count')).toHaveText('5 枚', { timeout: 30_000 })
  await expect(rows()).toHaveCount(2)
  await expect(activeRow()).toContainText('screenshots')
})

test('見つからないフォルダは印が付き、開けない', async () => {
  const moved = `${first}-moved`
  await fs.rename(first, moved)
  try {
    // 一覧は開くたびに存在を確かめ直す
    await rows().filter({ hasText: 'screenshots' }).click()
    await pickFolderNext(second)
    await window.getByRole('button', { name: '＋ 追加' }).click()
    const missing = rows().filter({ hasText: 'photos' })
    await expect(missing).toHaveClass(/libraries__row--missing/)
    await expect(missing).toContainText('見つかりません')
    await expect(missing).toHaveAttribute('aria-disabled', 'true')
    await missing.click({ force: true })
    await expect(activeRow()).toContainText('screenshots')
    await expect(window.locator('.toolbar__count')).toHaveText('5 枚')
  } finally {
    await fs.rename(moved, first)
  }
})

test('開いているライブラリを外すと、残りのライブラリへ切り替わる', async () => {
  const target = rows().filter({ hasText: 'screenshots' })
  await expect(target).toHaveClass(/libraries__row--active/)

  // 確認ダイアログでキャンセルすると何も起きない
  window.once('dialog', (dialog) => void dialog.dismiss())
  await target.hover()
  await target.getByRole('button', { name: /をライブラリから外す/ }).click()
  await expect(rows()).toHaveCount(2)

  window.once('dialog', (dialog) => void dialog.accept())
  await target.hover()
  await target.getByRole('button', { name: /をライブラリから外す/ }).click()
  await expect(rows()).toHaveCount(1)
  await expect(activeRow()).toContainText('photos')
  await expect(window.locator('.toolbar__count')).toHaveText('3 枚', { timeout: 30_000 })
  // フォルダの中身は残っている
  await expect(fs.readdir(path.join(second, 'sub'))).resolves.toHaveLength(5)
})

test('最後の 1 つを外すと、空の状態に戻る', async () => {
  window.once('dialog', (dialog) => void dialog.accept())
  const last = rows().first()
  await last.hover()
  await last.getByRole('button', { name: /をライブラリから外す/ }).click()
  await expect(rows()).toHaveCount(0)
  await expect(window.locator('.empty__title')).toHaveText('ライブラリが開かれていません')
  await expect(window.locator('.panel--tree .panel__placeholder')).toBeVisible()
  await window.screenshot({ path: `${SHOTS}/libraries-empty.png` })
})
