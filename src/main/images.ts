import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import type { Sharp } from 'sharp'
import { debugLog } from './debug-log'

/**
 * 画像を開く唯一の入口。
 *
 * sharp のプリビルドに含まれる libheif には HEVC デコーダ (libde265) が入っていないため、
 * iPhone / iCloud の HEIC は画素まで復号できない (コンテナは読めるので metadata() だけは通る)。
 * HEIF のときは WASM 版 libheif で RGBA へ復号し、sharp には raw 入力として渡す。
 */

const HEIF_EXTENSIONS = new Set(['.heic', '.heif', '.hif'])

export function isHeifPath(filePath: string): boolean {
  return HEIF_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

/**
 * sharp で HEIF のコンテナ (寸法・EXIF) を読むときの入力オプション。
 *
 * sharp 同梱の libheif は既定でアイテム数を 16 個までに制限しているが、iPhone の HEIC は
 * 48 枚のタイルなどで普通に超える ("Security limit exceeded: Number of references in iref box")。
 * 画素の復号は WASM 側で行い、ここではヘッダを読むだけなので制限を外す。
 */
const HEIF_SHARP_OPTIONS = { failOn: 'none', unlimited: true } as const

/**
 * EXIF (TIFF) バイト列から orientation (1-8) を取り出す。
 * sharp は HEIF でも生の EXIF バッファは返すが orientation を解釈してくれないため自前で読む。
 */
export function parseExifOrientation(exif: Buffer | undefined): number {
  if (!exif || exif.length < 12) return 1

  // "Exif\0\0" が前置されている場合と、TIFF ヘッダから始まる場合がある
  const start = exif.subarray(0, 6).toString('latin1') === 'Exif\0\0' ? 6 : 0
  const byteOrder = exif.subarray(start, start + 2).toString('latin1')
  const littleEndian = byteOrder === 'II'
  if (!littleEndian && byteOrder !== 'MM') return 1

  const readU16 = (offset: number): number =>
    littleEndian ? exif.readUInt16LE(offset) : exif.readUInt16BE(offset)
  const readU32 = (offset: number): number =>
    littleEndian ? exif.readUInt32LE(offset) : exif.readUInt32BE(offset)

  try {
    const ifd0 = start + readU32(start + 4)
    if (ifd0 + 2 > exif.length) return 1
    const entries = readU16(ifd0)

    for (let i = 0; i < entries; i++) {
      const entry = ifd0 + 2 + i * 12
      if (entry + 12 > exif.length) break
      if (readU16(entry) !== 0x0112) continue
      const value = readU16(entry + 8)
      return value >= 1 && value <= 8 ? value : 1
    }
  } catch {
    // 壊れた EXIF は「回転なし」として扱う
  }
  return 1
}

/** EXIF orientation の指す変換を sharp のパイプラインへ適用する。 */
export function applyOrientation(image: Sharp, orientation: number): Sharp {
  switch (orientation) {
    case 2:
      return image.flop()
    case 3:
      return image.rotate(180)
    case 4:
      return image.flip()
    case 5:
      return image.rotate(90).flop()
    case 6:
      return image.rotate(90)
    case 7:
      return image.rotate(270).flop()
    case 8:
      return image.rotate(270)
    default:
      return image
  }
}

/** 回転後に幅と高さが入れ替わる向きか。 */
export function swapsAxes(orientation: number): boolean {
  return orientation >= 5 && orientation <= 8
}

export interface OpenedImage {
  /** 向きを補正済みの sharp パイプライン */
  image: Sharp
  /** 向き補正後 (表示上) の寸法 */
  width: number
  height: number
}

async function openHeif(filePath: string): Promise<OpenedImage> {
  // 内部で WASM を読み込むので、HEIF を実際に開くまでロードしない
  const { default: decode } = await import('heic-decode')

  const file = await fs.readFile(filePath)
  // 画素は WASM 側で、EXIF はコンテナを読める sharp 側で取得する
  const [decoded, metadata] = await Promise.all([
    decode({ buffer: new Uint8Array(file) }),
    sharp(file, HEIF_SHARP_OPTIONS).metadata()
  ])

  const orientation = parseExifOrientation(metadata.exif)
  const pixels = Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.length)
  const raw = sharp(pixels, {
    raw: { width: decoded.width, height: decoded.height, channels: 4 }
  })
  const swap = swapsAxes(orientation)

  return {
    image: applyOrientation(raw, orientation),
    width: swap ? decoded.height : decoded.width,
    height: swap ? decoded.width : decoded.height
  }
}

/**
 * 形式を問わず、向きを補正済みのパイプラインと表示上の寸法を返す。
 * 呼び出し側はここから resize や raw 取り出しへ続ければよい。
 */
export async function openImage(filePath: string): Promise<OpenedImage> {
  // 画素を読む地点。クラウドの未ダウンロードファイルなら、ここでダウンロードが始まる
  const startedAt = Date.now()
  const opened = await openImageInner(filePath)
  debugLog().log({
    kind: 'open-image',
    decision: 'allowed',
    ms: Date.now() - startedAt,
    target: filePath
  })
  return opened
}

async function openImageInner(filePath: string): Promise<OpenedImage> {
  if (isHeifPath(filePath)) return openHeif(filePath)

  const image = sharp(filePath, { failOn: 'none', animated: false })
  const metadata = await image.metadata()
  const swap = swapsAxes(metadata.orientation ?? 1)

  return {
    // 通常の形式は sharp が EXIF を見て自動で回転してくれる
    image: image.rotate(),
    width: (swap ? metadata.height : metadata.width) ?? 0,
    height: (swap ? metadata.width : metadata.height) ?? 0
  }
}

/**
 * 向きを補正したうえでの表示上の寸法だけを返す。
 * HEIC でも画素の復号までは行わないので、情報表示のためだけに呼んでも軽い。
 */
export async function imageDimensions(
  filePath: string
): Promise<{ width: number; height: number } | null> {
  try {
    const heif = isHeifPath(filePath)
    const metadata = await sharp(filePath, heif ? HEIF_SHARP_OPTIONS : { failOn: 'none' }).metadata()
    if (!metadata.width || !metadata.height) return null

    // HEIF は sharp が orientation を解釈しないので、EXIF から自前で読む
    const orientation = heif
      ? parseExifOrientation(metadata.exif)
      : (metadata.orientation ?? 1)

    return swapsAxes(orientation)
      ? { width: metadata.height, height: metadata.width }
      : { width: metadata.width, height: metadata.height }
  } catch {
    return null
  }
}
