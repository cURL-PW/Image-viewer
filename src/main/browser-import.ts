import { createHash, randomBytes } from 'node:crypto'
import { constants as fsConstants, existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { BrowserImportResult, ImportTarget } from '@shared/types'
import type { LibraryDb } from './db'
import type { Library } from './library'

/** 取り込んだ画像を置く、ライブラリ直下のフォルダ (保存先が 'imported' のとき) */
export const IMPORT_DIR = 'Imported'
/** 1 枚あたりの上限。これより大きいものは画像ではないとみなして断る */
export const MAX_IMPORT_BYTES = 200 * 1024 * 1024
/** 記録する URL や名前の長さの上限 */
const MAX_TEXT_LENGTH = 2048
/** ファイル名 (拡張子を除く) の長さの上限。Windows のパス長制限に余裕を残す */
const MAX_BASENAME_LENGTH = 120

/**
 * 拡張から届く付帯情報。どれも省略できる。
 * 投稿者などは拡張がページから読み取ったもの (今は Twitter / X のみ)
 */
export interface ImportMeta {
  pageUrl?: string
  imageUrl?: string
  /** 拡張が決めた元のファイル名 (拡張子は中身から付け直す) */
  fileName?: string
  site?: string
  author?: string
  postId?: string
}

export interface ImportedFile {
  result: BrowserImportResult
  /** 登録できた画像の ID (renderer の「表示」用) */
  id: number | null
}

/** 中身の先頭バイトから形式を判定する。Content-Type や URL の拡張子は信用しない */
export function detectImageExtension(data: Buffer): string | null {
  if (data.length < 12) return null
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return '.jpg'
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return '.png'
  }
  const ascii = (start: number, end: number): string => data.subarray(start, end).toString('latin1')
  if (ascii(0, 4) === 'GIF8') return '.gif'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return '.webp'
  if (ascii(0, 2) === 'BM') return '.bmp'
  if (ascii(4, 8) === 'ftyp') {
    // ftyp ボックスの主ブランドと互換ブランドを見る (AVIF も HEIC も mif1 を名乗るため)
    const boxSize = Math.min(data.readUInt32BE(0), data.length, 256)
    const brands = [ascii(8, 12)]
    for (let offset = 16; offset + 4 <= boxSize; offset += 4) brands.push(ascii(offset, offset + 4))
    if (brands.some((brand) => brand === 'avif' || brand === 'avis')) return '.avif'
    if (brands.some((brand) => ['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'].includes(brand))) {
      return '.heic'
    }
  }
  return null
}

/** 制御文字を落とし、長すぎるものは切る。文字列でなければ null */
export function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return text === '' ? null : text.slice(0, MAX_TEXT_LENGTH)
}

/** http(s) の URL だけを記録する (data: や blob: は中身そのものなので残さない) */
export function cleanUrl(value: unknown): string | null {
  const text = cleanText(value)
  if (!text) return null
  try {
    const url = new URL(text)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i

/**
 * Windows / macOS / Linux のどこでも作れる名前にする。
 * 先頭の「.」は隠しファイルになって監視の対象から外れるので取り除く
 */
export function sanitizeBaseName(name: string): string {
  let base = name
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
  if (WINDOWS_RESERVED.test(base)) base = `_${base}`
  // サロゲートペアの途中で切らないよう、文字単位で数える
  return Array.from(base).slice(0, MAX_BASENAME_LENGTH).join('').trim()
}

function timestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/**
 * 保存するファイル名 (拡張子を除く) を決める。
 * 拡張の指定 → 画像 URL の末尾 → 「サイト名_日時」の順に使う
 */
export function deriveBaseName(meta: ImportMeta, now = new Date()): string {
  const candidates: string[] = []
  const given = cleanText(meta.fileName)
  if (given) candidates.push(given)
  const imageUrl = cleanUrl(meta.imageUrl)
  if (imageUrl) {
    const last = new URL(imageUrl).pathname.split('/').filter(Boolean).pop()
    if (last) {
      try {
        candidates.push(decodeURIComponent(last))
      } catch {
        candidates.push(last)
      }
    }
  }
  for (const candidate of candidates) {
    // 拡張子は中身から付け直すので、元の拡張子らしきもの (".jpg" や ".php") は落とす
    const base = sanitizeBaseName(candidate.replace(/\.[A-Za-z0-9]{1,5}$/, ''))
    if (base) return base
  }
  const pageUrl = cleanUrl(meta.pageUrl) ?? imageUrl
  const host = pageUrl ? sanitizeBaseName(new URL(pageUrl).hostname.replace(/^www\./, '')) : ''
  return `${host || 'image'}_${timestamp(now)}`
}

/**
 * 同名があれば「name (2).jpg」のように番号を振る。
 * 存在確認は OS に任せるので、Windows / macOS の大文字小文字を区別しない衝突も避けられる
 */
export function uniqueFileName(dir: string, base: string, ext: string): string {
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${base}${ext}` : `${base} (${n})${ext}`
    if (!existsSync(path.join(dir, name))) return name
  }
}

/**
 * 作業フォルダで書き終えてから、保存先へ移す。
 * 別のドライブで移せない (EXDEV) ときは、作業フォルダからコピーする。
 * どちらの場合も、保存先に書きかけや一時ファイルの名前が現れることはない
 */
export async function writeIntoPlace(tempDir: string, fullPath: string, data: Buffer): Promise<void> {
  await fs.mkdir(tempDir, { recursive: true })
  const temp = path.join(tempDir, `importing-${randomBytes(6).toString('hex')}.part`)
  try {
    await fs.writeFile(temp, data, { flag: 'wx' })
    try {
      await fs.rename(temp, fullPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
      await fs.copyFile(temp, fullPath, fsConstants.COPYFILE_EXCL)
    }
  } finally {
    await fs.rm(temp, { force: true })
  }
}

/**
 * ブラウザから届いた画像を、開いているライブラリの Imported フォルダへ保存する。
 * 同時に届いても名前がぶつからないよう、1 枚ずつ順に処理する
 */
export class BrowserImporter {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private db: LibraryDb,
    private library: Library,
    /** 開いているライブラリの保存先 (ライブラリごとの設定) */
    private target: (rootPath: string) => ImportTarget,
    /**
     * 書きかけを置く作業フォルダ。ライブラリの外に置く。
     * iCloud for Windows は同期フォルダ内の一時ファイル (先頭が「.」など) を同期対象外として扱い、
     * それを本来の名前に変えても新しいファイルとして上げてくれない。
     * 外で書き終えてから移せば、完成したファイルが一度に置かれたように見える
     */
    private tempDir: string = path.join(os.tmpdir(), 'image-viewer-import')
  ) {}

  import(data: Buffer, meta: ImportMeta): Promise<ImportedFile> {
    const run = this.queue.then(() => this.importNow(data, meta))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async importNow(data: Buffer, meta: ImportMeta): Promise<ImportedFile> {
    const rootId = this.library.currentRootId
    const rootPath = this.library.currentRootPath
    if (rootId === null || rootPath === null) {
      return { result: { status: 'no-library' }, id: null }
    }
    const ext = detectImageExtension(data)
    if (!ext) return { result: { status: 'unsupported' }, id: null }

    const sha256 = createHash('sha256').update(data).digest('hex')
    for (const previous of this.db.findImageSourcesByHash(rootId, sha256)) {
      const fullPath = path.join(rootPath, ...previous.relPath.split('/'))
      if (existsSync(fullPath)) {
        const id = await this.library.register(fullPath)
        return {
          result: { status: 'duplicate', fileName: path.basename(fullPath), relPath: previous.relPath },
          id
        }
      }
      // 消されていた画像の記録は片付ける (もう一度取り込めるように)
      this.db.removeImageSource(rootId, previous.relPath)
    }

    const inRoot = this.target(rootPath) === 'root'
    const dir = inRoot ? rootPath : path.join(rootPath, IMPORT_DIR)
    await fs.mkdir(dir, { recursive: true })
    const fileName = uniqueFileName(dir, deriveBaseName(meta), ext)
    const fullPath = path.join(dir, fileName)

    await writeIntoPlace(this.tempDir, fullPath, data)

    const relPath = inRoot ? fileName : `${IMPORT_DIR}/${fileName}`
    this.db.addImageSource(rootId, {
      relPath,
      sha256,
      pageUrl: cleanUrl(meta.pageUrl),
      imageUrl: cleanUrl(meta.imageUrl),
      site: cleanText(meta.site),
      author: cleanText(meta.author),
      postId: cleanText(meta.postId),
      importedAt: Date.now()
    })
    const id = await this.library.register(fullPath)
    return { result: { status: 'imported', fileName, relPath }, id }
  }
}
