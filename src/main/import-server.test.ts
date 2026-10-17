import http from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ImportServer,
  META_HEADER,
  TOKEN_HEADER,
  isAllowedRequest,
  tokenMatches
} from './import-server'

/** fetch は Host / Origin を書き換えられないので、生の http で投げる */
function request(
  port: number,
  options: { path?: string; method?: string; headers?: Record<string, string>; body?: Buffer } = {}
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: options.path ?? '/v1/ping',
        method: options.method ?? 'GET',
        headers: options.headers
      },
      (res) => {
        let text = ''
        res.on('data', (chunk) => (text += chunk))
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null })
        })
      }
    )
    req.on('error', reject)
    req.end(options.body)
  })
}

describe('tokenMatches', () => {
  it('一致するときだけ true', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true)
    expect(tokenMatches('abc', 'abd')).toBe(false)
    expect(tokenMatches('abc', 'ab')).toBe(false)
    expect(tokenMatches('abc', undefined)).toBe(false)
    expect(tokenMatches('', '')).toBe(false)
  })
})

describe('isAllowedRequest', () => {
  it('Web ページからの送信と、別ホスト名経由の送信を拒む', () => {
    const host = '127.0.0.1:47811'
    expect(isAllowedRequest({ host }, 47811)).toBe(true)
    expect(isAllowedRequest({ host: 'localhost:47811' }, 47811)).toBe(true)
    expect(isAllowedRequest({ host, origin: 'moz-extension://abc' }, 47811)).toBe(true)
    expect(isAllowedRequest({ host, origin: 'chrome-extension://abc' }, 47811)).toBe(true)
    expect(isAllowedRequest({ host, origin: 'https://example.com' }, 47811)).toBe(false)
    expect(isAllowedRequest({ host: 'evil.example:47811' }, 47811)).toBe(false)
  })
})

describe('ImportServer', () => {
  let server: ImportServer | null = null
  let token = 'secret-token'

  afterEach(async () => {
    await server?.stop()
    server = null
  })

  async function start(): Promise<number> {
    server = new ImportServer({
      token: () => token,
      hasLibrary: () => true,
      maxBytes: 16,
      onImport: async (data, meta) => ({ status: 200, body: { size: data.length, meta } })
    })
    const status = await server.start(0)
    expect(status.listening).toBe(true)
    return status.port as number
  }

  it('合言葉が合えば ping に答える', async () => {
    const port = await start()
    const result = await request(port, {
      headers: { host: `127.0.0.1:${port}`, [TOKEN_HEADER]: token }
    })
    expect(result).toEqual({ status: 200, body: { app: 'image-viewer', api: 1, library: true } })
  })

  it('合言葉が違えば 401', async () => {
    const port = await start()
    const result = await request(port, {
      headers: { host: `127.0.0.1:${port}`, [TOKEN_HEADER]: 'wrong' }
    })
    expect(result.status).toBe(401)
  })

  it('作り直した合言葉にすぐ追従する', async () => {
    const port = await start()
    token = 'renewed'
    const result = await request(port, {
      headers: { host: `127.0.0.1:${port}`, [TOKEN_HEADER]: 'renewed' }
    })
    expect(result.status).toBe(200)
    token = 'secret-token'
  })

  it('Web ページの Origin は合言葉が合っていても 403', async () => {
    const port = await start()
    const result = await request(port, {
      headers: { host: `127.0.0.1:${port}`, origin: 'https://example.com', [TOKEN_HEADER]: token }
    })
    expect(result.status).toBe(403)
  })

  it('使用中のポートでは in-use を返す', async () => {
    const port = await start()
    const second = new ImportServer({
      token: () => token,
      hasLibrary: () => false,
      maxBytes: 16,
      onImport: async () => ({ status: 200, body: null })
    })
    const status = await second.start(port)
    expect(status).toEqual({ listening: false, port, error: 'in-use' })
    await second.stop()
  })

  it('画像の本文と付帯情報を受け取る', async () => {
    const port = await start()
    const meta = encodeURIComponent(JSON.stringify({ pageUrl: 'https://example.com/ページ' }))
    const result = await request(port, {
      method: 'POST',
      path: '/v1/import',
      body: Buffer.from('12345'),
      headers: { host: `127.0.0.1:${port}`, [TOKEN_HEADER]: token, [META_HEADER]: meta }
    })
    expect(result).toEqual({
      status: 200,
      body: { size: 5, meta: { pageUrl: 'https://example.com/ページ' } }
    })
  })

  it('上限を超える本文は 413', async () => {
    const port = await start()
    const result = await request(port, {
      method: 'POST',
      path: '/v1/import',
      body: Buffer.alloc(32),
      headers: { host: `127.0.0.1:${port}`, [TOKEN_HEADER]: token }
    })
    expect(result).toEqual({ status: 413, body: { status: 'too-large' } })
  })

  it('止めると接続できなくなる', async () => {
    const port = await start()
    await server?.stop()
    await expect(request(port, { headers: { [TOKEN_HEADER]: token } })).rejects.toThrow()
  })
})
