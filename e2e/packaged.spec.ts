import { existsSync } from 'node:fs'
import path from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { HEIC_FILE, createFixtureWithHeic, installDummyModel, removeFixture } from './fixtures'

/**
 * パッケージ済みアプリのスモークテスト。
 * asar 内からの推論ワーカー起動やネイティブモジュールの読み込みなど、
 * 開発ツリーでは表面化しない配布時固有の問題を検出する。
 *
 * `npm run package` を実行していない場合はスキップする。
 */
const BINARIES = [
  'release/linux-unpacked/image-viewer',
  'release/mac/Image Viewer.app/Contents/MacOS/Image Viewer',
  'release/win-unpacked/Image Viewer.exe'
]

const executablePath = BINARIES.map((relative) => path.resolve(relative)).find((candidate) =>
  existsSync(candidate)
)

test.describe('パッケージ版', () => {
  test.skip(executablePath === undefined, 'npm run package を実行すると有効になります')

  test('起動してライブラリを読み込み、タグ付けまで動作する', async () => {
    test.setTimeout(180_000)
    const fixture = await createFixtureWithHeic()
    await installDummyModel(fixture)

    const app = await electron.launch({
      executablePath,
      args: [
        '--root',
        fixture.root,
        `--user-data-dir=${fixture.userData}`,
        '--no-sandbox',
        '--disable-gpu'
      ]
    })
    const window = await app.firstWindow()

    await expect(window.locator('.toolbar__count')).toHaveText('9 枚', { timeout: 30_000 })
    // 推論ワーカーは utilityProcess として別プロセスで動く。ここが通れば
    // asar からのワーカー起動と onnxruntime / sharp の読み込みが成立している。
    await expect(window.locator('.status--done')).toHaveText('タグ付け完了 9 / 9', {
      timeout: 120_000
    })
    await expect(window.locator('.tag').first()).toBeVisible()

    await window.locator('.cell').first().click()
    await expect(window.locator('.viewer__image')).toBeVisible()
    await window.keyboard.press('Escape')

    // HEIC は asar 外へ展開した libheif の WASM を読めていないと表示できない
    const heicName = HEIC_FILE.split('/').pop() as string
    await window.locator('.cell').filter({ hasText: heicName }).click()
    const heic = window.locator('.viewer__image')
    await expect(heic).toBeVisible()
    await expect
      .poll(async () => heic.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(640)

    await app.close()
    await removeFixture(fixture)
  })
})
