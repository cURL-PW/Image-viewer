import { beforeAll, describe, expect, it } from 'vitest'

interface Lib {
  matchesModifier(event: Partial<MouseEvent>, modifier: string, isMac: boolean): boolean
  parseTweetPath(href: string, base?: string): { site: string; author: string; postId: string } | null
  upgradeImageUrl(href: string): string
  candidateUrls(srcUrl: string, linkUrl: string): { url: string; link: boolean }[]
  suggestFileName(url: string): string | undefined
  parsePixivArtworkPath(href: string, base?: string): string | null
  parsePixivImageUrl(href: string): { illustId: string; page: number } | null
  parsePixivWork(
    illustId: string,
    info: unknown,
    pages: unknown
  ): { illustId: string; userId: string; title: string; ugoira: boolean; pages: string[] } | null
  tweetSyndicationUrl(postId: string): string
  twitterOriginalUrl(href: string): string | null
  parseTweetMedia(json: unknown): { photos: string[]; videos: number } | null
  buildTweetWork(
    tweet: { author: string; postId: string },
    media: { photos: string[]; videos: number } | null,
    domUrls: string[]
  ): { site: string; postId: string; author: string; pageUrl: string; pages: string[]; skippedVideos: number } | null
  workResultMessage(summary: {
    imported: number
    duplicate: number
    failed: number
    ugoira: boolean
    skippedVideos?: number
    abort: string | null
  }): string
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

describe('X の投稿の画像をまとめて取り込む', () => {
  it('埋め込み用の公開情報の URL に token を付ける', () => {
    const url = new URL(lib.tweetSyndicationUrl('1880000000000000000'))
    expect(url.origin + url.pathname).toBe('https://cdn.syndication.twimg.com/tweet-result')
    expect(url.searchParams.get('id')).toBe('1880000000000000000')
    expect(url.searchParams.get('token')).toMatch(/^[0-9a-z]+$/)
  })

  it('画像の URL はどちらの形でも原寸にする', () => {
    expect(lib.twitterOriginalUrl('https://pbs.twimg.com/media/AbC.png')).toBe(
      'https://pbs.twimg.com/media/AbC?format=png&name=orig'
    )
    expect(lib.twitterOriginalUrl('https://pbs.twimg.com/media/AbC?format=jpg&name=small')).toBe(
      'https://pbs.twimg.com/media/AbC?format=jpg&name=orig'
    )
    expect(lib.twitterOriginalUrl('https://pbs.twimg.com/profile_images/1/a.jpg')).toBeNull()
  })

  it('20 枚の画像を順番どおりに読み、動画・GIF は数えて飛ばす', () => {
    const mediaDetails = [
      ...Array.from({ length: 20 }, (_, n) => ({ type: 'photo', media_url_https: `https://pbs.twimg.com/media/P${n}.jpg` })),
      { type: 'video', media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/v.jpg' },
      { type: 'animated_gif', media_url_https: 'https://pbs.twimg.com/tweet_video_thumb/g.jpg' }
    ]
    const media = lib.parseTweetMedia({ __typename: 'Tweet', mediaDetails })!
    expect(media.photos).toHaveLength(20)
    expect(media.photos[19]).toBe('https://pbs.twimg.com/media/P19?format=jpg&name=orig')
    expect(media.videos).toBe(2)
    expect(lib.parseTweetMedia({ __typename: 'TweetTombstone' })).toBeNull()
  })

  it('埋め込み情報の順に並べ、画面にだけある画像は後ろに足す。同じ画像は 1 回', () => {
    const tweet = { author: 'someone', postId: '42' }
    const media = { photos: ['https://pbs.twimg.com/media/A?format=jpg&name=orig'], videos: 1 }
    const dom = [
      'https://pbs.twimg.com/media/A?format=jpg&name=small',
      'https://pbs.twimg.com/media/B?format=png&name=360x360'
    ]
    expect(lib.buildTweetWork(tweet, media, dom)).toMatchObject({
      site: 'twitter',
      postId: '42',
      author: 'someone',
      pageUrl: 'https://x.com/someone/status/42',
      pages: ['https://pbs.twimg.com/media/A?format=jpg&name=orig', 'https://pbs.twimg.com/media/B?format=png&name=orig'],
      skippedVideos: 1
    })
    // 埋め込み情報が読めなくても、画面の画像で取り込む
    expect(lib.buildTweetWork(tweet, null, dom)!.pages).toHaveLength(2)
    expect(lib.buildTweetWork(tweet, null, [])).toBeNull()
  })

  it('結果の文言に飛ばした動画の数を出す', () => {
    expect(
      lib.workResultMessage({ imported: 20, duplicate: 0, failed: 0, ugoira: false, skippedVideos: 2, abort: null })
    ).toBe('20 枚取り込みました\n動画・GIF 2 件は飛ばしました')
  })
})

describe('pixiv', () => {
  it('作品ページの URL から作品 ID を読む', () => {
    expect(lib.parsePixivArtworkPath('https://www.pixiv.net/artworks/146233172')).toBe('146233172')
    expect(lib.parsePixivArtworkPath('https://www.pixiv.net/en/artworks/42#manga')).toBe('42')
    expect(lib.parsePixivArtworkPath('/artworks/7', 'https://www.pixiv.net/users/1')).toBe('7')
    expect(
      lib.parsePixivArtworkPath('https://www.pixiv.net/member_illust.php?mode=medium&illust_id=99')
    ).toBe('99')
    expect(lib.parsePixivArtworkPath('https://www.pixiv.net/users/1')).toBeNull()
    expect(lib.parsePixivArtworkPath('https://example.com/artworks/1')).toBeNull()
  })

  it('画像の URL から作品 ID とページ番号を読む', () => {
    const base = 'https://i.pximg.net/img-master/img/2026/11/06/00/00/00'
    expect(lib.parsePixivImageUrl(`${base}/146233172_p3_master1200.jpg`)).toEqual({
      illustId: '146233172',
      page: 3
    })
    expect(
      lib.parsePixivImageUrl('https://i.pximg.net/c/250x250_80_a2/img-master/img/2026/01/01/00/00/00/5_p0_square1200.jpg')
    ).toEqual({ illustId: '5', page: 0 })
    expect(lib.parsePixivImageUrl(`${base}/8_master1200.jpg`)).toEqual({ illustId: '8', page: 0 })
    expect(lib.parsePixivImageUrl('https://i.pximg.net/user-profile/img/2020/a.jpg')).toBeNull()
    expect(lib.parsePixivImageUrl(`https://example.com/146233172_p3_master1200.jpg`)).toBeNull()
  })

  it('作品情報から全ページの原寸の URL を取り出す', () => {
    const info = { error: false, body: { userId: '11', illustTitle: 't', illustType: 1, urls: { original: 'https://i.pximg.net/o/1_p0.png' } } }
    const pages = {
      error: false,
      body: [0, 1, 2].map((n) => ({ urls: { original: `https://i.pximg.net/o/1_p${n}.png` } }))
    }
    expect(lib.parsePixivWork('1', info, pages)).toMatchObject({
      site: 'pixiv',
      postId: '1',
      author: '11',
      pageUrl: 'https://www.pixiv.net/artworks/1',
      illustId: '1',
      userId: '11',
      title: 't',
      ugoira: false,
      pages: ['https://i.pximg.net/o/1_p0.png', 'https://i.pximg.net/o/1_p1.png', 'https://i.pximg.net/o/1_p2.png']
    })
    // ページ一覧が読めなければ 1 枚目だけ。うごイラも 1 枚目だけ
    const ugoira = { error: false, body: { ...info.body, illustType: 2 } }
    expect(lib.parsePixivWork('1', ugoira, null)).toMatchObject({ ugoira: true, pages: ['https://i.pximg.net/o/1_p0.png'] })
    expect(lib.parsePixivWork('1', { error: true, body: [] }, pages)).toBeNull()
  })

  it('全ページ取り込みの結果の文言', () => {
    const base = { imported: 0, duplicate: 0, failed: 0, ugoira: false, abort: null }
    expect(lib.workResultMessage({ ...base, imported: 50, duplicate: 3 })).toBe('53 枚取り込みました (取り込み済み 3 枚)')
    expect(lib.workResultMessage({ ...base, imported: 50, failed: 3 })).toBe('50 枚取り込み、3 枚失敗しました')
    expect(lib.workResultMessage({ ...base, duplicate: 4 })).toBe('4 枚すべて取り込み済みです')
    expect(lib.workResultMessage({ ...base, imported: 1, ugoira: true })).toBe(
      '1 枚取り込みました\nうごイラは 1 枚目のみ取り込みました'
    )
    expect(lib.workResultMessage({ ...base, abort: 'unreachable' })).toContain('起動していない')
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
