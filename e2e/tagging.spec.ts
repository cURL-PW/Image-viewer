import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page
} from '@playwright/test'
import { createFixture, installDummyModel, removeFixture, type Fixture } from './fixtures'

let app: ElectronApplication
let window: Page
let fixture: Fixture

const SHOTS = 'e2e/.output/screenshots'

test.beforeAll(async () => {
  fixture = await createFixture()
  // 本物のモデルをダウンロードせずにタグ付け経路を動かす
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

  // 8 枚すべてのタグ付けが終わるまで待つ
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
  }
  const clear = window.locator('.panel--tags .button--subtle', { hasText: 'クリア' })
  if (await clear.isVisible()) await clear.click()
  await expect(window.locator('.toolbar__count')).toHaveText('8 枚')
  await expectTagPanelReady(8)
})

/**
 * タグ一覧が最新かを確認する。
 * general は rating の argmax として全画像に必ず付くので、その件数が
 * 対象枚数と一致していれば一覧は追いついている。
 */
async function expectTagPanelReady(totalImages: number): Promise<void> {
  await expect(tagRow('general').locator('.tag__count')).toHaveText(String(totalImages), {
    timeout: 20_000
  })
}

/** タグ一覧の行 (名前が完全一致するもの)。 */
function tagRow(name: string): Locator {
  return window
    .locator('.tag')
    .filter({ has: window.locator('.tag__name', { hasText: new RegExp(`^${name}$`) }) })
}

async function tagCount(name: string): Promise<number> {
  return Number((await tagRow(name).locator('.tag__count').textContent())?.replace(/,/g, ''))
}

async function gridCount(): Promise<number> {
  return Number((await window.locator('.toolbar__count').textContent())?.replace(/[^\d]/g, ''))
}

test('スキャンが完了するとタグがカテゴリ別に一覧表示される', async () => {
  // rating は最大値ひとつだけが付くので、全画像に general が付く
  await expect(tagRow('general')).toBeVisible()
  expect(await tagCount('general')).toBe(8)
  // rating の argmax ではない sensitive は付かない
  await expect(tagRow('sensitive')).toHaveCount(0)

  // カテゴリの見出しが出ている
  await expect(window.locator('.taglist__title', { hasText: '一般' })).toBeVisible()
  await expect(window.locator('.taglist__title', { hasText: 'レーティング' })).toBeVisible()

  await window.screenshot({ path: `${SHOTS}/04-tags.png` })
})

test('タグをクリックするとその枚数どおりに絞り込まれる', async () => {
  const expected = await tagCount('red_image')
  expect(expected).toBeGreaterThan(0)
  expect(expected).toBeLessThan(8)

  await tagRow('red_image').locator('.tag__main').click()
  await expect(window.locator('.toolbar__count')).toHaveText(`${expected} 枚`)
  await expect(window.locator('.chip', { hasText: 'red_image' })).toBeVisible()
})

test('除外タグを指定すると残りの画像だけが表示される', async () => {
  const excluded = await tagCount('red_image')

  await tagRow('red_image').locator('.tag__exclude').click()
  await expect(window.locator('.toolbar__count')).toHaveText(`${8 - excluded} 枚`)
  await expect(window.locator('.chip--exclude')).toContainText('red_image')
})

test('AND と OR で複数タグの絞り込みを切り替えられる', async () => {
  const redOnly = await tagCount('red_image')
  const blueOnly = await tagCount('blue_image')

  await tagRow('red_image').locator('.tag__main').click()
  await expect(window.locator('.toolbar__count')).toHaveText(`${redOnly} 枚`)

  // 絞り込み中でも、共起しないタグが一覧から消えて選べなくならないこと
  await tagRow('blue_image').locator('.tag__main').click()

  // AND: 両方を持つ画像だけなので、単独の絞り込みより多くはならない
  const andCount = await gridCount()
  expect(andCount).toBeLessThanOrEqual(Math.min(redOnly, blueOnly))

  // OR: どちらかを持つ画像なので、単独より少なくはならない
  await window.locator('.segmented__item', { hasText: 'OR' }).click()
  await expect(window.locator('.toolbar__count')).not.toHaveText(`${andCount} 枚`)
  const orCount = await gridCount()
  expect(orCount).toBeGreaterThanOrEqual(Math.max(redOnly, blueOnly))
  expect(orCount).toBeLessThanOrEqual(8)

  await window.locator('.segmented__item', { hasText: 'AND' }).click()
  await expect(window.locator('.toolbar__count')).toHaveText(`${andCount} 枚`)
})

test('フォルダ選択とタグ絞り込みは組み合わせて効く', async () => {
  const folderA = window
    .locator('.tree__row')
    .filter({ has: window.locator('.tree__name', { hasText: /^a$/ }) })
  await folderA.click()
  await expect(window.locator('.toolbar__count')).toHaveText('5 枚')

  // タグ件数もフォルダ範囲に追従する
  await expectTagPanelReady(5)

  await tagRow('general').locator('.tag__main').click()
  await expect(window.locator('.toolbar__count')).toHaveText('5 枚')

  await window.locator('.panel--tags .button--subtle', { hasText: 'クリア' }).click()
  await window.locator('.tree__row').first().click()
  await expect(window.locator('.toolbar__count')).toHaveText('8 枚')
})

test('単画像ビューに付与タグが表示され、クリックで絞り込める', async () => {
  await window.locator('.cell').first().click()
  await expect(window.locator('.viewer')).toBeVisible()

  const chips = window.locator('.viewer__tags .chip')
  await expect(chips.first()).toBeVisible()
  await expect(window.locator('.viewer__tags .chip', { hasText: 'general' })).toBeVisible()

  await window.screenshot({ path: `${SHOTS}/05-viewer-tags.png` })

  // ビューアーのタグをクリックすると、そのタグでライブラリを絞り込む
  const chipName = await chips.first().textContent()
  await chips.first().click()
  await expect(window.locator('.panel--tags .chip', { hasText: chipName ?? '' })).toBeVisible()
})

test('タグで絞り込み中に追加された画像は、タグ付けが済んだ時点で一覧に入る', async () => {
  const { writeImage } = await import('./fixtures')
  const path = await import('node:path')
  const fsp = await import('node:fs/promises')

  // general は全画像に付くので、絞り込んでも 8 枚のまま
  await tagRow('general').locator('.tag__main').click()
  await expect(window.locator('.chip', { hasText: 'general' })).toBeVisible()
  await expect(window.locator('.toolbar__count')).toHaveText('8 枚')

  // タグ付けを止めておき、追加の通知で一覧を引き直した後にタグが付くようにする。
  // タグ条件がある間は未スキャンの画像を出さないので、この時点ではまだ 8 枚
  await window.evaluate("window.api.scanControl('pause')")
  const added = path.join(fixture.root, 'b', '12.png')
  await writeImage(added, 3)
  await expect(window.locator('.status')).toContainText('一時停止中 (残り 1 枚)', {
    timeout: 20_000
  })
  await window.waitForTimeout(1000)
  await expect(window.locator('.toolbar__count')).toHaveText('8 枚')

  // タグ付けの完了通知で一覧を引き直し、9 枚になる
  await window.evaluate("window.api.scanControl('resume')")
  await expect(window.locator('.status--done')).toHaveText('タグ付け完了 9 / 9', {
    timeout: 30_000
  })
  await expect(window.locator('.toolbar__count')).toHaveText('9 枚', { timeout: 20_000 })

  // 次のテストのために元の 8 枚へ戻す
  await fsp.rm(added)
  await expect(window.locator('.toolbar__count')).toHaveText('8 枚', { timeout: 20_000 })
})

test('新しく追加された画像も自動でタグ付けされる', async () => {
  const { writeImage } = await import('./fixtures')
  const path = await import('node:path')
  await writeImage(path.join(fixture.root, 'b', '11.png'), 2)

  await expect(window.locator('.toolbar__count')).toHaveText('9 枚', { timeout: 20_000 })
  await expect(window.locator('.status--done')).toHaveText('タグ付け完了 9 / 9', {
    timeout: 30_000
  })
  await expectTagPanelReady(9)
})
