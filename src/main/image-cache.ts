import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ImageRecord } from '@shared/types'
import { NotDownloadedError, type CloudGuard } from './cloud-guard'
import { debugLog } from './debug-log'
import { imageDimensions, openImage } from './images'
import { Semaphore } from './semaphore'

/**
 * 同時に走らせる派生生成の数。
 * libuv のスレッドプールは既定 4 本なので、走査など他の I/O のために空きを残す。
 */
const DEFAULT_CONCURRENCY = 2

export interface DerivedImageOptions {
  /** ログに出す名前 (thumb / display) */
  label: string
  /** キャッシュの保存先 */
  cacheDir: string
  /** 長辺の上限 (px) */
  size: number
  /** WebP の品質 */
  quality: number
  /** 未ダウンロードのクラウドファイルを読まないための門番 */
  guard?: CloudGuard
  concurrency?: number
}

export interface GetOptions {
  /**
   * ユーザーが明示的に要求した場合は true。
   * 門番を素通りし、未ダウンロードでもダウンロードして生成する。
   */
  force?: boolean
}

/**
 * 元画像から派生させた画像 (サムネイル / 表示用トランスコード) をディスクにキャッシュする。
 * キーは (相対パス, mtime, size, 生成サイズ) なので、ファイルが更新されれば自動的に別ファイルになる。
 */
export class DerivedImageCache {
  private inFlight = new Map<string, Promise<Buffer>>()
  private semaphore: Semaphore

  constructor(private options: DerivedImageOptions) {
    this.semaphore = new Semaphore(options.concurrency ?? DEFAULT_CONCURRENCY)
  }

  setSize(size: number): void {
    this.options = { ...this.options, size }
  }

  private keyFor(image: ImageRecord): string {
    return createHash('sha1')
      .update([image.relPath, image.mtime, image.size, this.options.size].join(' '))
      .digest('hex')
  }

  private cachePath(key: string): string {
    // 1 ディレクトリにファイルが集中しないよう 2 階層に分散する
    return path.join(this.options.cacheDir, key.slice(0, 2), `${key}.webp`)
  }

  async get(image: ImageRecord, sourcePath: string, options: GetOptions = {}): Promise<Buffer> {
    const key = this.keyFor(image)
    const label = this.options.label

    // キャッシュ済みならローカル読み込みだけで済むので、門番も同時実行の制限も通さない
    const cached = await this.readCache(key)
    if (cached) {
      debugLog().log({ kind: `${label}-cache`, decision: 'cached', target: image.relPath })
      return cached
    }

    const existing = this.inFlight.get(key)
    if (existing) return existing

    const task = this.generate(key, sourcePath, image.relPath, options).finally(() =>
      this.inFlight.delete(key)
    )
    this.inFlight.set(key, task)
    return task
  }

  private async readCache(key: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.cachePath(key))
    } catch {
      return null
    }
  }

  private async generate(
    key: string,
    sourcePath: string,
    relPath: string,
    options: GetOptions
  ): Promise<Buffer> {
    const guard = this.options.guard
    const force = options.force === true
    const label = this.options.label
    const log = debugLog()

    if (!force && guard) {
      if (!guard.allowAutoRead()) {
        log.log({ kind: `${label}-gen`, decision: 'blocked', target: relPath, note: '遮断中' })
        throw new NotDownloadedError()
      }
      // 一覧も stat もダウンロードを起こさないので、読む前の足切りに使える
      if (await guard.isNotDownloaded(sourcePath)) {
        log.log({
          kind: `${label}-gen`,
          decision: 'blocked',
          target: relPath,
          note: '未ダウンロード'
        })
        throw new NotDownloadedError()
      }
    }

    const release = await this.semaphore.acquire()
    try {
      // 順番待ちの間に遮断へ入っていることがある。ここで弾けば、
      // 画面いっぱいに積まれたサムネイル要求も読み込まずに順次片付く。
      if (!force && guard && !guard.allowAutoRead()) {
        log.log({
          kind: `${label}-gen`,
          decision: 'blocked',
          target: relPath,
          note: '順番待ちの間に遮断'
        })
        throw new NotDownloadedError()
      }

      const startedAt = Date.now()
      // openImage が形式ごとの差 (HEIC の WASM 復号や EXIF の向き) を吸収する
      const { image } = await openImage(sourcePath)
      const buffer = await image
        .resize(this.options.size, this.options.size, {
          fit: 'inside',
          withoutEnlargement: true
        })
        .webp({ quality: this.options.quality })
        .toBuffer()
      const elapsed = Date.now() - startedAt
      guard?.recordRead(elapsed)
      // 実際に画素を読んだ地点。ここが数秒なら、その 1 枚を落としていたことになる
      log.log({
        kind: `${label}-gen`,
        decision: force ? 'forced' : 'allowed',
        ms: elapsed,
        target: relPath
      })

      await this.writeCache(key, buffer)
      return buffer
    } finally {
      release()
    }
  }

  private async writeCache(key: string, buffer: Buffer): Promise<void> {
    const file = this.cachePath(key)
    try {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, buffer)
    } catch (error) {
      console.warn('[image-cache] キャッシュ書き込みに失敗', error)
    }
  }

  /** 画像の実サイズを取得する (単画像ビューの情報表示用)。 */
  async dimensions(sourcePath: string): Promise<{ width: number; height: number } | null> {
    const startedAt = Date.now()
    const result = await imageDimensions(sourcePath)
    debugLog().log({
      kind: 'dimensions',
      decision: 'allowed',
      ms: Date.now() - startedAt,
      target: sourcePath
    })
    return result
  }

  async clear(): Promise<void> {
    await fs.rm(this.options.cacheDir, { recursive: true, force: true })
  }
}
