import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import sharp from 'sharp'
import {
  _electron as electron,
  chromium,
  expect,
  test,
  type BrowserContext,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { createFixture, removeFixture, type Fixture } from './fixtures'

/**
 * ブラウザ拡張から画像を取り込む一連の流れを、本物の拡張と本物のアプリで確かめる。
 * Chromium に extension/ を読み込み、テスト用のページで修飾キー＋クリックする。
 * x.com と pbs.twimg.com はテスト用のサーバーへ向け、Twitter の投稿を模したページを出す。
 */

test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let window: Page
let fixture: Fixture
let browser: BrowserContext
let site: http.Server
let sitePort: number
let browserProfile: string

const SHOTS = 'e2e/.output/screenshots'
const EXTENSION = path.resolve('extension')
const IMPORT_PORT = 47811

const images: Record<string, Buffer> = {}

async function solid(width: number, height: number, color: string): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer()
}

const PAGES: Record<string, string> = {
  // サムネイルが原寸画像へのリンクになっている、よくある作りのページ
  '/gallery': `<!doctype html><meta charset="utf-8"><title>gallery</title>
    <a href="/full.png"><img id="thumb" src="/thumb.png" width="160" height="120"></a>
    <img id="plain" src="/plain.png" width="160" height="120">`,
  // Twitter (X) の投稿を模したページ。画像のリンク先は画像ではなく投稿の画面
  '/someone/status/1234567890': `<!doctype html><meta charset="utf-8"><title>tweet</title>
    <article>
      <a href="/someone/status/1234567890"><time datetime="2026-10-17">10月17日</time></a>
      <a href="/someone/status/1234567890/photo/1">
        <div style="position:relative;width:200px;height:150px">
          <img id="tweet" src="http://pbs.twimg.com/media/GaBc123?format=png&name=small"
               style="position:absolute;inset:0;width:100%;height:100%">
        </div>
      </a>
    </article>`
}

function startSite(): Promise<void> {
  site = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname in PAGES) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(PAGES[url.pathname])
      return
    }
    const key =
      url.pathname === '/media/GaBc123' ? `tweet-${url.searchParams.get('name')}` : url.pathname
    const image = images[key]
    if (!image) {
      response.writeHead(404)
      response.end()
      return
    }
    response.writeHead(200, { 'Content-Type': 'image/png' })
    response.end(image)
  })
  return new Promise((resolve) => {
    site.listen(0, '127.0.0.1', () => {
      sitePort = (site.address() as AddressInfo).port
      resolve()
    })
  })
}

test.beforeAll(async () => {
  images['/thumb.png'] = await solid(160, 120, '#3366cc')
  images['/full.png'] = await solid(640, 480, '#3366cc')
  images['/plain.png'] = await solid(300, 200, '#cc3366')
  images['tweet-small'] = await solid(200, 150, '#33aa66')
  images['tweet-orig'] = await solid(1200, 900, '#33aa66')
  await startSite()

  fixture = await createFixture()
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
  await expect(window.locator('.toolbar__count')).toHaveText('8 枚', { timeout: 30_000 })
})

test.afterAll(async () => {
  await browser?.close()
  await app?.close()
  site?.close()
  if (fixture) await removeFixture(fixture)
  if (browserProfile) await fs.rm(browserProfile, { recursive: true, force: true })
})

async function openSettings(): Promise<void> {
  await window.locator('.toolbar .button--icon', { hasText: '⚙' }).click()
  await expect(window.locator('.modal__panel')).toBeVisible()
}

async function closeSettings(): Promise<void> {
  await window.locator('.modal__footer .button--primary').click()
  await expect(window.locator('.modal')).toHaveCount(0)
}

async function importedFiles(): Promise<string[]> {
  try {
    return (await fs.readdir(path.join(fixture.root, 'Imported'))).sort()
  } catch {
    return []
  }
}

let token = ''

test('設定で受け口を有効にすると、ポートと合言葉が表示される', async () => {
  await openSettings()
  const status = window.getByTestId('browser-import-status')
  await expect(status).toHaveText('停止中')

  await window.locator('#browser-import').check()
  await expect(status).toHaveText(`受け付け中 (127.0.0.1:${IMPORT_PORT})`)
  token = await window.locator('#browser-import-token').inputValue()
  expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/)

  const section = window.locator('.browser-import')
  await section.scrollIntoViewIfNeeded()
  await section.screenshot({ path: `${SHOTS}/browser-import-settings.png` })
  await closeSettings()
})

test('Web ページからの送信は、合言葉が無いので受け付けない', async () => {
  const response = await fetch(`http://127.0.0.1:${IMPORT_PORT}/v1/import`, {
    method: 'POST',
    body: new Uint8Array(images['/plain.png'])
  })
  expect(response.status).toBe(401)
  expect(await importedFiles()).toEqual([])
})

test('拡張の設定画面で合言葉を貼ると、接続を確かめられる', async () => {
  browserProfile = await fs.mkdtemp(path.join(os.tmpdir(), 'image-viewer-browser-'))
  browser = await chromium.launchPersistentContext(browserProfile, {
    // 拡張は画面ありの Chromium でしか読み込めない (CI では xvfb-run で動かす)
    headless: false,
    // 手元の Playwright と版の違う Chromium しか無い環境では、場所を指定して使う
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
    args: [
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      // x.com と pbs.twimg.com をテスト用のサーバーへ向ける
      `--host-resolver-rules=MAP x.com 127.0.0.1:${sitePort}, MAP pbs.twimg.com 127.0.0.1:${sitePort}, MAP gallery.test 127.0.0.1:${sitePort}`
    ]
  })
  const worker = browser.serviceWorkers()[0] ?? (await browser.waitForEvent('serviceworker'))
  const extensionId = new URL(worker.url()).host

  // 入れた直後に設定画面が開く
  const options =
    browser.pages().find((page) => page.url().includes('options.html')) ??
    (await browser.newPage())
  if (!options.url().includes('options.html')) {
    await options.goto(`chrome-extension://${extensionId}/options.html`)
  }
  await options.locator('#token').fill(token)
  await expect(options.locator('#port')).toHaveValue(String(IMPORT_PORT))
  await expect(options.locator('#modifier')).toHaveValue('alt+shift')
  await options.locator('#test').click()
  await expect(options.locator('#message')).toHaveText('Image Viewer につながりました')
  await options.screenshot({ path: `${SHOTS}/browser-import-extension-options.png` })
  // 最後のタブを閉じると Chromium ごと終わるので、設定画面は開いたままにする
})

test('Alt+Shift+クリックで、リンク先の原寸画像を Imported に取り込む', async () => {
  const page = await browser.newPage()
  await page.goto('http://gallery.test/gallery')
  await page.locator('#thumb').click({ modifiers: ['Alt', 'Shift'] })

  await expect.poll(importedFiles).toEqual(['full.png'])
  const saved = await sharp(path.join(fixture.root, 'Imported', 'full.png')).metadata()
  expect([saved.width, saved.height]).toEqual([640, 480])
  // ページ側はリンク先へ移動していない
  expect(page.url()).toBe('http://gallery.test/gallery')

  const notice = window.locator('.notice')
  await expect(notice).toContainText('ブラウザから取り込みました: full.png')
  await window.screenshot({ path: `${SHOTS}/browser-import-toast.png` })
  // 一覧にも出る (Imported フォルダができ、9 枚になる)
  await expect(window.locator('.toolbar__count')).toHaveText('9 枚')

  // 同じ画像をもう一度取り込んでも保存しない
  await page.locator('#thumb').click({ modifiers: ['Alt', 'Shift'] })
  await expect(window.locator('.notice')).toContainText('取り込み済みの画像です: full.png')
  expect(await importedFiles()).toEqual(['full.png'])

  // 修飾キーなしのクリックでは取り込まない
  await page.locator('#plain').click()
  await page.waitForTimeout(500)
  expect(await importedFiles()).toEqual(['full.png'])
  await page.close()
})

test('Twitter (X) の画像は原寸で取り込み、投稿者と投稿 ID を記録する', async () => {
  const page = await browser.newPage()
  await page.goto('http://x.com/someone/status/1234567890')
  await page.locator('#tweet').click({ modifiers: ['Alt', 'Shift'] })

  await expect.poll(importedFiles).toEqual(['GaBc123.png', 'full.png'])
  const saved = await sharp(path.join(fixture.root, 'Imported', 'GaBc123.png')).metadata()
  expect([saved.width, saved.height]).toEqual([1200, 900])
  await page.close()

  // 通知の「表示」で開き、情報パネルに取り込み元が出る
  await window.locator('.notice__action', { hasText: '表示' }).click()
  await expect(window.locator('.viewer__name')).toHaveText('GaBc123.png')
  const source = window.getByTestId('image-source')
  await expect(source).toContainText('x.com/someone/status/1234567890')
  await expect(source).toContainText('投稿者 @someone')
  await expect(source).toContainText('投稿 ID 1234567890')
  await window.screenshot({ path: `${SHOTS}/browser-import-source.png` })
})

test('画像でないものは保存しない', async () => {
  const response = await fetch(`http://127.0.0.1:${IMPORT_PORT}/v1/import`, {
    method: 'POST',
    headers: { 'X-Image-Viewer-Token': token },
    body: 'not an image'
  })
  expect(response.status).toBe(415)
  expect(await response.json()).toEqual({ status: 'unsupported' })
})
