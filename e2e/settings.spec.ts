import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page
} from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { createFixture, installDummyModel, removeFixture, type Fixture } from './fixtures'

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
    ]
  })
  window = await app.firstWindow()
  await expect(window.locator('.status--done')).toHaveText('タグ付け完了 8 / 8', {
    timeout: 60_000
  })
})

test.afterAll(async () => {
  await app?.close()
  if (fixture) await removeFixture(fixture)
})

function tagRow(name: string): Locator {
  return window
    .locator('.tag')
    .filter({ has: window.locator('.tag__name', { hasText: new RegExp(`^${name}$`) }) })
}

async function openSettings(): Promise<void> {
  if (await window.locator('.modal').isVisible()) return
  await window.locator('.toolbar .button--icon', { hasText: '⚙' }).click()
  await expect(window.locator('.modal__panel')).toBeVisible()
}

async function closeSettings(): Promise<void> {
  await window.locator('.modal__footer .button--primary').click()
  await expect(window.locator('.modal')).toHaveCount(0)
}

test('設定ダイアログを開いて現在の実行プロバイダを確認できる', async () => {
  await openSettings()
  // GPU が無い環境なので CPU にフォールバックしている
  await expect(window.locator('.field__hint', { hasText: '現在の実行プロバイダ' })).toContainText(
    'CPU'
  )
  await window.screenshot({ path: `${SHOTS}/06-settings.png` })
  await closeSettings()
})

test('デバッグログは既定でオフで、設定からオンにできる', async () => {
  const logFile = path.join(fixture.userData, 'logs', 'debug.log')
  await openSettings()
  const checkbox = window.getByLabel('デバッグログを記録する')
  await expect(checkbox).not.toBeChecked()
  // 走査もタグ付けも済んでいるが、何も記録されていない
  expect(fs.existsSync(logFile)).toBe(false)

  await checkbox.check()
  await expect(checkbox).toBeChecked()
  await window.locator('.diagnostics').screenshot({ path: `${SHOTS}/06b-debug-log.png` })
  await expect
    .poll(() => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''), {
      timeout: 10_000
    })
    .toContain('記録を開始しました')

  await checkbox.uncheck()
  await closeSettings()
})

test('しきい値を上げると再スキャンされ、付与されるタグが減る', async () => {
  await expect(tagRow('red_image')).toBeVisible()

  await openSettings()
  await window.locator('#general').fill('0.9')
  await closeSettings()

  // 全画像が再スキャン対象になり、終わるとしきい値以下のタグが消える。
  // 再スキャン開始前は「完了」表示が残っているため、タグの消失そのものを待つ。
  await expect(tagRow('red_image')).toHaveCount(0, { timeout: 60_000 })
  await expect(window.locator('.status--done')).toHaveText('タグ付け完了 8 / 8', {
    timeout: 60_000
  })
  // rating は argmax で選ばれるので、しきい値に関係なく残る
  await expect(tagRow('general').locator('.tag__count')).toHaveText('8')

  // 元に戻すと再び付与される
  await openSettings()
  await window.locator('#general').fill('0.35')
  await closeSettings()
  await expect(tagRow('red_image')).toBeVisible({ timeout: 60_000 })
})

test('サムネイルサイズの変更がグリッドに反映される', async () => {
  const cellWidth = async (): Promise<number> =>
    (await window.locator('.cell').first().boundingBox())?.width ?? 0

  const before = await cellWidth()

  await openSettings()
  await window.locator('#thumb').fill('128')
  await closeSettings()

  await expect.poll(cellWidth).toBe(128)
  expect(before).not.toBe(128)
})

test('自動タグ付けを止めると新しい画像はスキャンされない', async () => {
  const { writeImage } = await import('./fixtures')
  const path = await import('node:path')

  await openSettings()
  await window.locator('#autoscan').uncheck()
  await closeSettings()

  await writeImage(path.join(fixture.root, 'b', '12.png'), 4)
  await expect(window.locator('.toolbar__count')).toHaveText('9 枚', { timeout: 20_000 })
  // 枚数は増えるがタグ付けは進まない (完了表示にならない)
  await expect(window.locator('.status')).not.toHaveText('タグ付け完了 9 / 9')

  await openSettings()
  await window.locator('#autoscan').check()
  await closeSettings()
  await expect(window.locator('.status--done')).toHaveText('タグ付け完了 9 / 9', {
    timeout: 60_000
  })
})
