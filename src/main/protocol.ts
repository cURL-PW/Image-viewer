import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { net, protocol } from 'electron'
import { IMAGE_PROTOCOL, THUMB_PROTOCOL, type ImageRecord } from '@shared/types'
import type { LibraryDb } from './db'
import type { Library } from './library'
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
    try {
      // Chromium は HEIC を表示できないので、表示用に変換したものを返す。
      // それ以外は元ファイルをそのまま流す (変換のコストをかけない)。
      if (isHeifPath(target.fullPath)) {
        return derivedResponse(await display.get(target.record, target.fullPath))
      }
      return await net.fetch(pathToFileURL(target.fullPath).toString())
    } catch {
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
    } catch {
      return NOT_FOUND()
    }
  })
}
