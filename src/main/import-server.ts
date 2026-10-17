import http from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { ImportServerStatus } from '@shared/types'

/** 合言葉を入れるリクエストヘッダー */
export const TOKEN_HEADER = 'x-image-viewer-token'
/** 付帯情報 (取り込み元の URL など) を JSON を encodeURIComponent して入れるヘッダー */
export const META_HEADER = 'x-image-viewer-meta'
/** 受け口の API の版。拡張側がずれを検出できるように応答へ含める */
export const API_VERSION = 1

/** 推測されない合言葉を作る (URL やヘッダーにそのまま入る文字だけ) */
export function generateToken(): string {
  return randomBytes(24).toString('base64url')
}

/** 長さの違いや 1 文字ずつの比較時間から合言葉を推測されないように比べる */
export function tokenMatches(expected: string, actual: string | undefined): boolean {
  if (!expected || typeof actual !== 'string') return false
  const a = Buffer.from(expected)
  const b = Buffer.from(actual)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * 閲覧中の Web ページからの送信を拒む。
 * - Host が 127.0.0.1 / localhost 以外 (DNS リバインディング) は拒否
 * - Origin が http(s) のもの (= 普通の Web ページ) は拒否。拡張からは
 *   moz-extension:// / chrome-extension:// が付くか、付かないかのどちらか
 */
export function isAllowedRequest(headers: http.IncomingHttpHeaders, port: number): boolean {
  const host = headers.host
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false
  const origin = headers.origin
  if (origin === undefined || origin === 'null') return true
  return /^(moz|chrome)-extension:\/\//.test(origin)
}

export interface ImportServerOptions {
  /** 今の合言葉 (作り直しに追従するため毎回読む) */
  token: () => string
  /** ping に添える「ライブラリを開いているか」 */
  hasLibrary: () => boolean
  /** 届いた画像を保存する。HTTP の状態コードと応答の本文を返す */
  onImport: (data: Buffer, meta: unknown) => Promise<{ status: number; body: unknown }>
  /** 本文の上限 (バイト) */
  maxBytes: number
}

/** 付帯情報のヘッダーを読む。壊れていれば空として扱う (画像そのものは受け取る) */
export function parseMetaHeader(value: string | string[] | undefined): unknown {
  if (typeof value !== 'string' || value === '') return {}
  try {
    return JSON.parse(decodeURIComponent(value))
  } catch {
    return {}
  }
}

/** 本文を上限まで読む。超えたら null */
function readBody(request: http.IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const declared = Number(request.headers['content-length'])
    if (Number.isFinite(declared) && declared > maxBytes) {
      resolve(null)
      request.resume()
      return
    }
    const chunks: Buffer[] = []
    let total = 0
    let tooLarge = false
    request.on('data', (chunk: Buffer) => {
      if (tooLarge) return
      total += chunk.length
      if (total > maxBytes) {
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(tooLarge ? null : Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store'
  })
  response.end(text)
}

/**
 * ブラウザ拡張から画像を受け取る受け口。127.0.0.1 だけで待ち受け、LAN からは届かない。
 * 既定はオフで、設定画面で有効にしたときだけ開く。
 */
export class ImportServer {
  private server: http.Server | null = null
  private status: ImportServerStatus = { listening: false, port: null, error: null }

  constructor(private options: ImportServerOptions) {}

  get currentStatus(): ImportServerStatus {
    return this.status
  }

  /** 指定のポートで開き直す。開けなかった理由は status.error に残す */
  async start(port: number): Promise<ImportServerStatus> {
    await this.stop()
    const server = http.createServer((request, response) => this.handle(request, response, port))
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject)
          resolve()
        })
      })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      this.status = {
        listening: false,
        port,
        error: code === 'EADDRINUSE' ? 'in-use' : String((error as Error).message ?? error)
      }
      return this.status
    }
    this.server = server
    this.status = { listening: true, port: (server.address() as AddressInfo).port, error: null }
    return this.status
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.status = { listening: false, port: null, error: null }
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private handle(request: http.IncomingMessage, response: http.ServerResponse, port: number): void {
    // ポート 0 (テスト用) で開いたときは実際の番号で Host を照合する
    const actualPort = this.status.port ?? port
    if (!isAllowedRequest(request.headers, actualPort)) {
      sendJson(response, 403, { error: 'forbidden' })
      return
    }
    // ここまで来た Origin は拡張のものだけ。ブラウザによっては拡張の通信でも
    // CORS の確認が入るので、拡張にだけ許可を返す
    const origin = request.headers.origin
    if (origin && origin !== 'null') {
      response.setHeader('Access-Control-Allow-Origin', origin)
      response.setHeader('Vary', 'Origin')
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': `content-type, ${TOKEN_HEADER}, ${META_HEADER}`,
        'Access-Control-Max-Age': '600'
      })
      response.end()
      return
    }
    if (!tokenMatches(this.options.token(), request.headers[TOKEN_HEADER] as string | undefined)) {
      sendJson(response, 401, { error: 'bad-token' })
      return
    }

    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/v1/ping') {
      sendJson(response, 200, {
        app: 'image-viewer',
        api: API_VERSION,
        library: this.options.hasLibrary()
      })
      return
    }
    if (request.method === 'POST' && url.pathname === '/v1/import') {
      void this.handleImport(request, response)
      return
    }
    sendJson(response, 404, { error: 'not-found' })
  }

  private async handleImport(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      const data = await readBody(request, this.options.maxBytes)
      if (data === null) {
        sendJson(response, 413, { status: 'too-large' })
        return
      }
      const result = await this.options.onImport(data, parseMetaHeader(request.headers[META_HEADER]))
      sendJson(response, result.status, result.body)
    } catch (error) {
      console.error('[import-server]', error)
      if (!response.headersSent) sendJson(response, 500, { status: 'failed' })
    }
  }
}
