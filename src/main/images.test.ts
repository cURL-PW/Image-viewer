import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyOrientation,
  imageDimensions,
  isHeifPath,
  openImage,
  parseExifOrientation,
  swapsAxes
} from './images'
import sharp from 'sharp'

const FIXTURES = path.resolve('e2e/fixtures')
const SAMPLE = path.join(FIXTURES, 'sample.heic')
/** 480x640 で保存され、EXIF orientation=6 (時計回りに 90 度回して表示) が付いている */
const ROTATED = path.join(FIXTURES, 'sample-rotated.heic')
/** 64x48 の画像を 20 枚詰めた HEIC (アイテム数が 16 を超える)。先頭に EXIF orientation=6 */
const MANY_ITEMS = path.join(FIXTURES, 'sample-many-items.heic')

/** ビッグエンディアン (MM) の最小 EXIF を組み立てる。 */
function exifBigEndian(orientation: number, withPrefix = true): Buffer {
  const tiff = Buffer.alloc(26)
  tiff.write('MM', 0, 'latin1')
  tiff.writeUInt16BE(42, 2)
  tiff.writeUInt32BE(8, 4)
  tiff.writeUInt16BE(1, 8) // エントリ数
  tiff.writeUInt16BE(0x0112, 10) // orientation
  tiff.writeUInt16BE(3, 12) // SHORT
  tiff.writeUInt32BE(1, 14) // count
  tiff.writeUInt16BE(orientation, 18)
  return withPrefix ? Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]) : tiff
}

/** リトルエンディアン (II) 版。 */
function exifLittleEndian(orientation: number): Buffer {
  const tiff = Buffer.alloc(26)
  tiff.write('II', 0, 'latin1')
  tiff.writeUInt16LE(42, 2)
  tiff.writeUInt32LE(8, 4)
  tiff.writeUInt16LE(1, 8)
  tiff.writeUInt16LE(0x0112, 10)
  tiff.writeUInt16LE(3, 12)
  tiff.writeUInt32LE(1, 14)
  tiff.writeUInt16LE(orientation, 18)
  return tiff
}

describe('isHeifPath', () => {
  it('HEIF 系の拡張子を大文字小文字を問わず判定する', () => {
    for (const file of ['a.heic', 'a.HEIC', 'a.heif', 'a.HEIF', 'a.hif']) {
      expect(isHeifPath(file)).toBe(true)
    }
  })

  it('他の形式は対象外', () => {
    for (const file of ['a.jpg', 'a.png', 'a.avif', 'a.webp', 'heic', 'a.heic.jpg']) {
      expect(isHeifPath(file)).toBe(false)
    }
  })
})

describe('parseExifOrientation', () => {
  it('Exif\\0\\0 前置ありのビッグエンディアンを読む', () => {
    expect(parseExifOrientation(exifBigEndian(6))).toBe(6)
  })

  it('TIFF ヘッダから始まる場合も読む', () => {
    expect(parseExifOrientation(exifBigEndian(3, false))).toBe(3)
  })

  it('リトルエンディアンを読む', () => {
    expect(parseExifOrientation(exifLittleEndian(8))).toBe(8)
  })

  it('未定義・短すぎる・壊れた入力は 1 として扱う', () => {
    expect(parseExifOrientation(undefined)).toBe(1)
    expect(parseExifOrientation(Buffer.alloc(4))).toBe(1)
    expect(parseExifOrientation(Buffer.from('not an exif blob at all'))).toBe(1)
  })

  it('範囲外の値は 1 に丸める', () => {
    expect(parseExifOrientation(exifBigEndian(0))).toBe(1)
    expect(parseExifOrientation(exifBigEndian(99))).toBe(1)
  })
})

describe('swapsAxes', () => {
  it('90 度系の向きだけ縦横が入れ替わる', () => {
    expect([1, 2, 3, 4].map(swapsAxes)).toEqual([false, false, false, false])
    expect([5, 6, 7, 8].map(swapsAxes)).toEqual([true, true, true, true])
  })
})

describe('applyOrientation', () => {
  it('orientation=6 は時計回りに 90 度回す', async () => {
    // 左半分が赤、右半分が青の 20x10
    const source = await sharp({
      create: { width: 20, height: 10, channels: 3, background: '#0000ff' }
    })
      .composite([
        {
          input: await sharp({
            create: { width: 10, height: 10, channels: 3, background: '#ff0000' }
          })
            .png()
            .toBuffer(),
          left: 0,
          top: 0
        }
      ])
      .png()
      .toBuffer()

    const rotated = await applyOrientation(sharp(source), 6).png().toBuffer()
    const meta = await sharp(rotated).metadata()
    expect([meta.width, meta.height]).toEqual([10, 20])

    // 時計回りなので、元の左側 (赤) は上へ移動する
    const top = await sharp(rotated).extract({ left: 4, top: 1, width: 2, height: 2 }).raw().toBuffer()
    expect(top[0]).toBeGreaterThan(200)
    expect(top[2]).toBeLessThan(60)
  })
})

describe('openImage (HEIC)', () => {
  it('sharp 単体では HEVC を復号できない (WASM デコーダが要る理由)', async () => {
    // コンテナは読めるので metadata は通る
    const meta = await sharp(SAMPLE).metadata()
    expect(meta.format).toBe('heif')
    // 画素まで読もうとすると失敗する
    await expect(sharp(SAMPLE).png().toBuffer()).rejects.toThrow()
  })

  it('HEIC を復号して寸法を返す', async () => {
    const { image, width, height } = await openImage(SAMPLE)
    expect([width, height]).toEqual([640, 480])
    const meta = await sharp(await image.png().toBuffer()).metadata()
    expect([meta.width, meta.height]).toEqual([640, 480])
  })

  it('EXIF orientation を適用して縦横を入れ替える', async () => {
    const { image, width, height } = await openImage(ROTATED)
    // 保存時は 480x640。orientation=6 なので表示は 640x480 になる
    expect([width, height]).toEqual([640, 480])

    const png = await image.png().toBuffer()
    const meta = await sharp(png).metadata()
    expect([meta.width, meta.height]).toEqual([640, 480])

    // 元画像の上辺は赤。時計回りに 90 度回すと右端へ移る
    const right = await sharp(png)
      .extract({ left: meta.width! - 6, top: Math.floor(meta.height! / 2), width: 4, height: 4 })
      .raw()
      .toBuffer()
    expect(right[0]).toBeGreaterThan(180)
    expect(right[2]).toBeLessThan(90)
  })

  it('アイテム数が 16 を超える HEIC (iPhone の写真など) も開ける', async () => {
    // sharp の既定ではセキュリティ制限に掛かる
    await expect(sharp(MANY_ITEMS).metadata()).rejects.toThrow(/Security limit/)

    const { image, width, height } = await openImage(MANY_ITEMS)
    // 保存時は 64x48。orientation=6 なので表示は 48x64 になる
    expect([width, height]).toEqual([48, 64])
    const meta = await sharp(await image.png().toBuffer()).metadata()
    expect([meta.width, meta.height]).toEqual([48, 64])
  })

  it('通常の形式も同じ入口で開ける', async () => {
    const jpeg = await sharp({
      create: { width: 30, height: 20, channels: 3, background: '#123456' }
    })
      .jpeg()
      .toBuffer()
    const file = path.join(FIXTURES, '.tmp-open-image.jpg')
    await (await import('node:fs/promises')).writeFile(file, jpeg)
    try {
      const { width, height } = await openImage(file)
      expect([width, height]).toEqual([30, 20])
    } finally {
      await (await import('node:fs/promises')).rm(file, { force: true })
    }
  })
})

describe('imageDimensions', () => {
  it('HEIC の寸法を画素の復号なしに返す', async () => {
    expect(await imageDimensions(SAMPLE)).toEqual({ width: 640, height: 480 })
  })

  it('HEIC の EXIF orientation も反映する', async () => {
    expect(await imageDimensions(ROTATED)).toEqual({ width: 640, height: 480 })
  })

  it('アイテム数が 16 を超える HEIC でも寸法を返す', async () => {
    expect(await imageDimensions(MANY_ITEMS)).toEqual({ width: 48, height: 64 })
  })

  it('読めないファイルは null', async () => {
    expect(await imageDimensions(path.join(FIXTURES, 'does-not-exist.heic'))).toBeNull()
  })
})
