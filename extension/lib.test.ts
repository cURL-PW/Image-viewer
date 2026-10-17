import { beforeAll, describe, expect, it } from 'vitest'

interface Lib {
  matchesModifier(event: Partial<MouseEvent>, modifier: string, isMac: boolean): boolean
  parseTweetPath(href: string, base?: string): { site: string; author: string; postId: string } | null
  upgradeImageUrl(href: string): string
  candidateUrls(srcUrl: string, linkUrl: string): { url: string; link: boolean }[]
  suggestFileName(url: string): string | undefined
  normalizeOptions(input: unknown): { port: number; token: string; modifier: string }
  bufferToBase64(buffer: ArrayBuffer): string
  base64ToBuffer(text: string): ArrayBuffer
}

let lib: Lib

beforeAll(async () => {
  // 拡張の lib.js はモジュールではなく globalThis に生やす作り
  await import('./lib.js')
  lib = (globalThis as unknown as { ImageViewerImport: Lib }).ImageViewerImport
})

const keys = (pressed: string[]): Partial<MouseEvent> => ({
  ctrlKey: pressed.includes('ctrl'),
  altKey: pressed.includes('alt'),
  shiftKey: pressed.includes('shift'),
  metaKey: pressed.includes('meta')
})

describe('matchesModifier', () => {
  it('設定どおりのキーだけが押されているときに一致する', () => {
    expect(lib.matchesModifier(keys(['alt', 'shift']), 'alt+shift', false)).toBe(true)
    expect(lib.matchesModifier(keys(['alt']), 'alt+shift', false)).toBe(false)
    expect(lib.matchesModifier(keys(['ctrl', 'alt', 'shift']), 'alt+shift', false)).toBe(false)
    expect(lib.matchesModifier(keys([]), 'off', false)).toBe(false)
  })

  it('macOS では Ctrl の代わりに ⌘ を見る (Ctrl+クリックは右クリックになるため)', () => {
    expect(lib.matchesModifier(keys(['meta', 'shift']), 'ctrl+shift', true)).toBe(true)
    expect(lib.matchesModifier(keys(['ctrl', 'shift']), 'ctrl+shift', true)).toBe(false)
    expect(lib.matchesModifier(keys(['meta', 'shift']), 'ctrl+shift', false)).toBe(false)
  })
})

describe('Twitter (X)', () => {
  it('投稿の URL から投稿者と投稿 ID を読む', () => {
    expect(lib.parseTweetPath('/someone/status/1234567890', 'https://x.com/home')).toEqual({
      site: 'twitter',
      author: 'someone',
      postId: '1234567890'
    })
    expect(lib.parseTweetPath('https://twitter.com/a_b/status/42/photo/1')).toMatchObject({
      author: 'a_b',
      postId: '42'
    })
    expect(lib.parseTweetPath('https://x.com/i/status/42')).toBeNull()
    expect(lib.parseTweetPath('https://example.com/a/status/42')).toBeNull()
  })

  it('画像は原寸の URL にし、メディア ID を名前にする', () => {
    const small = 'https://pbs.twimg.com/media/GaBc123?format=jpg&name=small'
    expect(lib.upgradeImageUrl(small)).toBe('https://pbs.twimg.com/media/GaBc123?format=jpg&name=orig')
    expect(lib.suggestFileName(small)).toBe('GaBc123')
    expect(lib.upgradeImageUrl('https://example.com/a.jpg')).toBe('https://example.com/a.jpg')
  })
})

describe('candidateUrls', () => {
  it('リンク先を先に試し、次に表示中の画像', () => {
    expect(lib.candidateUrls('https://e.com/thumb.jpg', 'https://e.com/full.jpg')).toEqual([
      { url: 'https://e.com/full.jpg', link: true },
      { url: 'https://e.com/thumb.jpg', link: false }
    ])
  })

  it('リンクが無い・http(s) でない・同じ URL のときは表示中の画像だけ', () => {
    expect(lib.candidateUrls('https://e.com/a.jpg', '')).toHaveLength(1)
    expect(lib.candidateUrls('https://e.com/a.jpg', 'javascript:void(0)')).toHaveLength(1)
    expect(lib.candidateUrls('https://e.com/a.jpg', 'https://e.com/a.jpg')).toHaveLength(1)
  })
})

describe('normalizeOptions', () => {
  it('壊れた値は既定に戻す', () => {
    expect(lib.normalizeOptions({ port: 'x', token: ' abc ', modifier: 'bogus' })).toEqual({
      port: 47811,
      token: 'abc',
      modifier: 'alt+shift'
    })
  })
})

it('base64 の往復で中身が変わらない', () => {
  const bytes = new Uint8Array(100_000).map((_, i) => i % 256)
  const back = new Uint8Array(lib.base64ToBuffer(lib.bufferToBase64(bytes.buffer)))
  expect(back).toEqual(bytes)
})
