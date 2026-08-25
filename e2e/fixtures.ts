import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { DEFAULT_SETTINGS } from '../src/shared/types'

export interface Fixture {
  /** 画像を置くルートフォルダ */
  root: string
  /** Electron の userData (テストごとに隔離する) */
  userData: string
}

const COLORS = [
  { r: 220, g: 80, b: 80 },
  { r: 80, g: 190, b: 120 },
  { r: 90, g: 130, b: 230 },
  { r: 230, g: 200, b: 90 },
  { r: 180, g: 110, b: 220 },
  { r: 90, g: 200, b: 210 }
]

/** 単色の PNG を 1 枚生成する。 */
export async function writeImage(
  file: string,
  index: number,
  width = 320,
  height = 240
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const color = COLORS[index % COLORS.length]
  await sharp({ create: { width, height, channels: 3, background: color } })
    .png()
    .toFile(file)
}

/**
 * 再帰的なフォルダ構成のテストデータを作る。
 *   root/a/01.png .. 03.png
 *   root/a/deep/04.png, 05.png
 *   root/b/06.png, 07.png
 *   root/08.png
 */
export async function createFixture(): Promise<Fixture> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'image-viewer-e2e-'))
  const root = path.join(base, 'library')
  const userData = path.join(base, 'userdata')
  await fs.mkdir(userData, { recursive: true })

  const files = [
    'a/01.png',
    'a/02.png',
    'a/03.png',
    'a/deep/04.png',
    'a/deep/05.png',
    'b/06.png',
    'b/07.png',
    '08.png'
  ]
  for (const [index, relative] of files.entries()) {
    // 画像ごとにサイズを変えて、fit-width の挙動を確認できるようにする
    await writeImage(path.join(root, relative), index, 320 + index * 40, 240 + index * 10)
  }

  return { root, userData }
}

/** 既定モデル ID に対応するキャッシュ先。ここに置いておけばダウンロードは走らない。 */
export function modelCacheDir(userData: string, modelId = DEFAULT_SETTINGS.modelId): string {
  return path.join(userData, 'models', modelId.replace(/[^A-Za-z0-9._-]+/g, '_'))
}

/**
 * 本物の WD14 モデルの代わりに、同じ入出力形状のダミーモデルを配置する。
 * (e2e/fixtures/make-model.py で生成したもの)
 */
export async function installDummyModel(fixture: Fixture): Promise<void> {
  const destination = modelCacheDir(fixture.userData)
  await fs.mkdir(destination, { recursive: true })
  const source = path.join(__dirname, 'fixtures')
  await fs.copyFile(path.join(source, 'model.onnx'), path.join(destination, 'model.onnx'))
  await fs.copyFile(
    path.join(source, 'selected_tags.csv'),
    path.join(destination, 'selected_tags.csv')
  )
}

export async function removeFixture(fixture: Fixture): Promise<void> {
  await fs.rm(path.dirname(fixture.root), { recursive: true, force: true })
}

/** iCloud / iPhone の写真を模した HEIC。sharp では復号できず WASM 経由になる。 */
export const HEIC_FILE = 'iphone/IMG_0001.HEIC'

/**
 * 通常のフィクスチャに HEIC を 1 枚足したもの。
 * `e2e/fixtures/sample.heic` は make-heic.py で生成した実物の HEVC ファイル。
 */
export async function createFixtureWithHeic(): Promise<Fixture & { heicPath: string }> {
  const fixture = await createFixture()
  const heicPath = path.join(fixture.root, ...HEIC_FILE.split('/'))
  await fs.mkdir(path.dirname(heicPath), { recursive: true })
  await fs.copyFile(path.join(__dirname, 'fixtures', 'sample.heic'), heicPath)
  return { ...fixture, heicPath }
}
