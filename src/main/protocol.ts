import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { net, protocol } from 'electron'
import { IMAGE_PROTOCOL, THUMB_PROTOCOL, type ImageRecord } from '@shared/types'
import type { LibraryDb } from './db'
import type { Library } from './library'
import { isNotDownloadedError } from './cloud-guard'
import { debugLog } from './debug-log'
import type { DerivedImageCache } from './image-cache'
import { isHeifPath } from './images'

/** app ready より前に呼ぶ必要がある。 */
export function registerImageSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: IMAGE_PROTOCOL,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    },
    {
      scheme: THUMB_PROTOCOL,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }
  ])
}

export interface ResolvedImage {
  record: ImageRecord
  fullPath: string
}

/**
 * 画像 ID から実ファイルパスを解決する。
 * renderer には ID しか渡さないため、ルート外のファイルは参照できない。
 */
export function createResolver(db: LibraryDb, library: Library) {
  return (id: number): ResolvedImage | null => {
    if (!Number.isInteger(id)) return null
    const record = db.getImage(id)
    const rootPath = library.currentRootPath
    if (!record || !rootPath) return null
    // ライブラリを切り替えた直後は、前のライブラリの ID で引かれることがある。
    // 相対パスだけで解決すると、今のルートの別の画像を返してしまう
    if (db.getImageRootId(id) !== library.currentRootId) return null

    const fullPath = path.resolve(rootPath, record.relPath)
    // パストラバーサル防止: ルート配下であることを必ず確認する
    if (fullPath !== rootPath && !fullPath.startsWith(rootPath + path.sep)) return null
    return { record, fullPath }
  }
}

function parseId(url: string): number | null {
  try {
    const parsed = new URL(url)
    const id = Number(parsed.pathname.replace(/^\/+/, ''))
    return Number.isInteger(id) ? id : null
  } catch {
    return null
  }
}

const NOT_FOUND = (): Response => new Response('not found', { status: 404 })

/**
 * 未ダウンロードのクラウドファイル用のタイル。
 * ここで元ファイルを読むとダウンロードが始まってしまうので、代わりにこれを返す。
 * SVG なら生成コストが無く、Chromium がそのまま <img> で描画できる。
 */
const CLOUD_TILE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96">
  <rect width="96" height="96" fill="#15151a"/>
  <path d="M32 62h34a11 11 0 0 0 1-22 16 16 0 0 0-30-5 12 12 0 0 0-5 23 9 9 0 0 0 0 4z"
        fill="none" stroke="#5a5a68" stroke-width="3" stroke-linejoin="round"/>
  <path d="M48 48v14m0 0-5-5m5 5 5-5" fill="none" stroke="#5a5a68" stroke-width="3"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>`

function cloudTileResponse(): Response {
  return new Response(CLOUD_TILE, {
    headers: {
      'Content-Type': 'image/svg+xml',
      // 実体が落ちてくれば内容が変わるのでキャッシュさせない
      'Cache-Control': 'no-store'
    }
  })
}

/** 生成済みバッファを、内容が変わらない前提のキャッシュヘッダ付きで返す。 */
function derivedResponse(buffer: Buffer): Response {
  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'image/webp',
      // URL に mtime を含めているので、内容が変わればキャッシュも自然に切り替わる
      'Cache-Control': 'public, max-age=31536000, immutable'
    }
  })
}

export function registerImageProtocolHandlers(
  resolve: (id: number) => ResolvedImage | null,
  thumbs: DerivedImageCache,
  display: DerivedImageCache
): void {
  protocol.handle(IMAGE_PROTOCOL, async (request) => {
    const id = parseId(request.url)
    if (id === null) return NOT_FOUND()
    const target = resolve(id)
    if (!target) return NOT_FOUND()
    const startedAt = Date.now()
    try {
      // 単画像ビューはユーザーが明示的に開いた操作なので、未ダウンロードでも
      // この 1 枚だけはダウンロードして表示する (force)。
      //
      // Chromium は HEIC を表示できないので、表示用に変換したものを返す。
      // それ以外は元ファイルをそのまま流す (変換のコストをかけない)。
      if (isHeifPath(target.fullPath)) {
        return derivedResponse(await display.get(target.record, target.fullPath, { force: true }))
      }
      const response = await net.fetch(pathToFileURL(target.fullPath).toString())
      debugLog().log({
        kind: 'viewer-fetch',
        decision: 'forced',
        ms: Date.now() - startedAt,
        target: target.record.relPath
      })
      return response
    } catch (error) {
      debugLog().log({
        kind: 'viewer-fetch',
        decision: 'skipped',
        ms: Date.now() - startedAt,
        target: target.record.relPath,
        note: error instanceof Error ? error.message : String(error)
      })
      return NOT_FOUND()
    }
  })

  protocol.handle(THUMB_PROTOCOL, async (request) => {
    const id = parseId(request.url)
    if (id === null) return NOT_FOUND()
    const target = resolve(id)
    if (!target) return NOT_FOUND()
    try {
      return derivedResponse(await thumbs.get(target.record, target.fullPath))
    } catch (error) {
      // 未ダウンロードのものは読まず、雲のタイルで「まだ手元に無い」と示す
      if (isNotDownloadedError(error)) return cloudTileResponse()
      debugLog().log({
        kind: 'thumb-fetch',
        decision: 'skipped',
        target: target.record.relPath,
        note: error instanceof Error ? error.message : String(error)
      })
      return NOT_FOUND()
    }
  })
}
