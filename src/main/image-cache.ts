import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ImageRecord } from '@shared/types'
import { imageDimensions, openImage } from './images'

export interface DerivedImageOptions {
  /** キャッシュの保存先 */
  cacheDir: string
  /** 長辺の上限 (px) */
  size: number
  /** WebP の品質 */
  quality: number
}

/**
 * 元画像から派生させた画像 (サムネイル / 表示用トランスコード) をディスクにキャッシュする。
 * キーは (相対パス, mtime, size, 生成サイズ) なので、ファイルが更新されれば自動的に別ファイルになる。
 */
export class DerivedImageCache {
  private inFlight = new Map<string, Promise<Buffer>>()

  constructor(private options: DerivedImageOptions) {}

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

  async get(image: ImageRecord, sourcePath: string): Promise<Buffer> {
    const key = this.keyFor(image)
    const existing = this.inFlight.get(key)
    if (existing) return existing

    const task = this.generate(key, sourcePath).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, task)
    return task
  }

  private async generate(key: string, sourcePath: string): Promise<Buffer> {
    const file = this.cachePath(key)
    try {
      return await fs.readFile(file)
    } catch {
      // キャッシュミス。以下で生成する
    }

    // openImage が形式ごとの差 (HEIC の WASM 復号や EXIF の向き) を吸収する
    const { image } = await openImage(sourcePath)
    const buffer = await image
      .resize(this.options.size, this.options.size, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .webp({ quality: this.options.quality })
      .toBuffer()

    try {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, buffer)
    } catch (error) {
      console.warn('[image-cache] キャッシュ書き込みに失敗', error)
    }
    return buffer
  }

  /** 画像の実サイズを取得する (単画像ビューの情報表示用)。 */
  async dimensions(sourcePath: string): Promise<{ width: number; height: number } | null> {
    return imageDimensions(sourcePath)
  }

  async clear(): Promise<void> {
    await fs.rm(this.options.cacheDir, { recursive: true, force: true })
  }
}
