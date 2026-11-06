/*
 * 背景処理・ページ側・設定画面で共有する処理。
 * Firefox の背景ページ、Chrome の Service Worker、コンテンツスクリプトのどれからも
 * 読めるよう、モジュールにせず globalThis.ImageViewerImport に置く。
 */
;(function (root) {
  'use strict'

  /** アプリ側の既定と合わせる (src/shared/types.ts の BROWSER_IMPORT_DEFAULT_PORT) */
  const DEFAULT_PORT = 47811

  /** クリックで取り込むときの修飾キー。ctrl は macOS では ⌘ として扱う */
  const MODIFIERS = ['alt+shift', 'ctrl+shift', 'ctrl+alt', 'ctrl', 'alt', 'shift', 'off']

  const DEFAULT_OPTIONS = { port: DEFAULT_PORT, token: '', modifier: 'alt+shift' }

  function normalizeOptions(input) {
    const value = input || {}
    const port = Number(value.port)
    return {
      port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_PORT,
      token: typeof value.token === 'string' ? value.token.trim() : '',
      modifier: MODIFIERS.includes(value.modifier) ? value.modifier : DEFAULT_OPTIONS.modifier
    }
  }

  /** 修飾キーの表示名。macOS では Ctrl を ⌘、Alt を Option と書く */
  function modifierLabel(modifier, isMac) {
    if (modifier === 'off') return '使わない (右クリックメニューのみ)'
    return modifier
      .split('+')
      .map((key) => {
        if (key === 'ctrl') return isMac ? '⌘' : 'Ctrl'
        if (key === 'alt') return isMac ? 'Option' : 'Alt'
        return 'Shift'
      })
      .join('+')
  }

  /**
   * クリックの修飾キーが設定と一致するか。余計なキーが押されていれば一致しない
   * (Ctrl+Shift+クリックを Shift+クリックの設定で拾わない)。
   * macOS の Ctrl+クリックは右クリック扱いになるので、ctrl は ⌘ (metaKey) で見る
   */
  function matchesModifier(event, modifier, isMac) {
    if (!modifier || modifier === 'off') return false
    const wanted = new Set(modifier.split('+'))
    const ctrl = isMac ? event.metaKey : event.ctrlKey
    const extra = isMac ? event.ctrlKey : event.metaKey
    return (
      !extra &&
      ctrl === wanted.has('ctrl') &&
      event.altKey === wanted.has('alt') &&
      event.shiftKey === wanted.has('shift')
    )
  }

  const TWITTER_HOSTS = new Set([
    'twitter.com',
    'www.twitter.com',
    'mobile.twitter.com',
    'x.com',
    'www.x.com',
    'mobile.x.com'
  ])

  function isTwitterHost(hostname) {
    return TWITTER_HOSTS.has(String(hostname).toLowerCase())
  }

  /** 「/{ユーザー}/status/{投稿 ID}」から投稿者と投稿 ID を読む */
  function parseTweetPath(href, base) {
    try {
      const url = new URL(href, base)
      if (!isTwitterHost(url.hostname)) return null
      const match = url.pathname.match(/^\/([A-Za-z0-9_]{1,50})\/status(?:es)?\/(\d+)/)
      if (!match || match[1] === 'i') return null
      return { site: 'twitter', author: match[1], postId: match[2] }
    } catch {
      return null
    }
  }

  /** pixiv の作品ページか (日本語版・英語版などの言語付きの URL も) */
  function isPixivHost(hostname) {
    const host = String(hostname).toLowerCase()
    return host === 'www.pixiv.net' || host === 'pixiv.net'
  }

  /** 作品ページの URL から作品 ID を読む (/artworks/123, /en/artworks/123, 古い member_illust.php) */
  function parsePixivArtworkPath(href, base) {
    try {
      const url = new URL(href, base)
      if (!isPixivHost(url.hostname)) return null
      const match = url.pathname.match(/^\/(?:[a-z]{2}(?:-[a-z]+)?\/)?artworks\/(\d+)/i)
      if (match) return match[1]
      if (/\/member_illust\.php$/.test(url.pathname)) {
        const id = url.searchParams.get('illust_id')
        if (id && /^\d+$/.test(id)) return id
      }
      return null
    } catch {
      return null
    }
  }

  /**
   * pixiv の画像 (i.pximg.net) の URL から作品 ID とページ番号を読む。
   * 例: .../img-master/img/2026/11/06/00/00/00/146233172_p3_master1200.jpg → { illustId: '146233172', page: 3 }
   * うごイラ (146233172_master1200.jpg など) はページ番号 0 とする
   */
  function parsePixivImageUrl(href) {
    try {
      const url = new URL(href)
      if (!/(^|\.)pximg\.net$/i.test(url.hostname)) return null
      const name = url.pathname.split('/').pop() || ''
      const match = name.match(/^(\d+)(?:_p(\d+))?(?:_|\.)/)
      if (!match) return null
      return { illustId: match[1], page: match[2] ? Number(match[2]) : 0 }
    } catch {
      return null
    }
  }

  /**
   * pixiv の作品情報 (/ajax/illust/{id} と /ajax/illust/{id}/pages の応答) から、
   * 取り込みに使うものを取り出す。読めなければ null
   */
  function parsePixivWork(illustId, info, pages) {
    const body = info && !info.error && info.body ? info.body : null
    if (!body) return null
    const urls = []
    if (pages && !pages.error && Array.isArray(pages.body)) {
      for (const page of pages.body) {
        const original = page && page.urls && page.urls.original
        if (typeof original === 'string' && /^https?:/i.test(original)) urls.push(original)
      }
    }
    // ページ一覧が取れなければ、作品情報にある 1 枚目の原寸だけでも取る
    if (urls.length === 0 && body.urls && typeof body.urls.original === 'string') urls.push(body.urls.original)
    if (urls.length === 0) return null
    return {
      illustId: String(illustId),
      userId: body.userId != null ? String(body.userId) : '',
      title: typeof body.illustTitle === 'string' ? body.illustTitle : '',
      // 0: イラスト, 1: マンガ, 2: うごイラ
      ugoira: Number(body.illustType) === 2,
      pages: urls
    }
  }

  function pixivArtworkUrl(illustId) {
    return `https://www.pixiv.net/artworks/${illustId}`
  }

  /** 全ページ取り込みが終わったときの通知の文言 */
  function workResultMessage(summary) {
    if (summary.abort) return resultMessage({ status: summary.abort })
    const ok = summary.imported + summary.duplicate
    let text
    if (summary.failed > 0) {
      text = `${ok} 枚取り込み、${summary.failed} 枚失敗しました`
    } else if (summary.duplicate > 0 && summary.imported === 0) {
      text = `${ok} 枚すべて取り込み済みです`
    } else {
      text = `${ok} 枚取り込みました${summary.duplicate > 0 ? ` (取り込み済み ${summary.duplicate} 枚)` : ''}`
    }
    if (summary.ugoira) text += '\nうごイラは 1 枚目のみ取り込みました'
    return text
  }

  /**
   * 原寸の画像の URL にする。今は Twitter (X) の画像だけ。
   * pbs.twimg.com/media/XXX?format=jpg&name=small → name=orig
   */
  function upgradeImageUrl(href) {
    try {
      const url = new URL(href)
      if (url.hostname === 'pbs.twimg.com' && url.pathname.startsWith('/media/')) {
        url.searchParams.set('name', 'orig')
        return url.href
      }
      return href
    } catch {
      return href
    }
  }

  /** 拡張から取りに行ける URL か (blob: はページの中でしか読めない) */
  function isFetchable(href) {
    return /^(https?:|data:image\/)/i.test(String(href || ''))
  }

  /**
   * 取りに行く順番。リンク先が画像ならそちらを優先し (原寸画像へのリンクのため)、
   * 画像でなければ表示中の画像を取る
   */
  function candidateUrls(srcUrl, linkUrl) {
    const result = []
    if (linkUrl && /^https?:/i.test(linkUrl)) result.push({ url: upgradeImageUrl(linkUrl), link: true })
    if (srcUrl) result.push({ url: upgradeImageUrl(srcUrl), link: false })
    return result.filter((item, index) => result.findIndex((other) => other.url === item.url) === index)
  }

  /** Twitter の画像の名前。「メディア ID」をそのまま使う (拡張子はアプリが中身から付ける) */
  function suggestFileName(imageUrl) {
    try {
      const url = new URL(imageUrl)
      if (url.hostname === 'pbs.twimg.com' && url.pathname.startsWith('/media/')) {
        return url.pathname.slice('/media/'.length).replace(/\.[A-Za-z0-9]+$/, '')
      }
    } catch {
      // 名前はアプリ側で URL から決める
    }
    return undefined
  }

  /** 応答の状態から、利用者に見せる文言を作る */
  function resultMessage(result) {
    switch (result.status) {
      case 'imported':
        return `取り込みました: ${result.fileName}`
      case 'duplicate':
        return `取り込み済みです: ${result.fileName}`
      case 'no-library':
        return 'Image Viewer でライブラリが開かれていません'
      case 'unsupported':
        return '対応していない形式の画像です'
      case 'too-large':
        return '画像が大きすぎます'
      case 'bad-token':
        return '合言葉が違います。拡張の設定に Image Viewer の合言葉を貼り付けてください'
      case 'no-token':
        return '合言葉が未設定です。拡張の設定を開いて貼り付けてください'
      case 'unreachable':
        return 'Image Viewer が起動していないか、ブラウザからの取り込みがオフになっています'
      case 'fetch-failed':
        return '画像を取得できませんでした'
      case 'work-failed':
        return 'pixiv の作品の情報を読めませんでした。ページを再読み込みしてから試してください'
      default:
        return '取り込みに失敗しました'
    }
  }

  /** ArrayBuffer を base64 にする (メッセージで送るため。大きくても落ちないよう分けて変換) */
  function bufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    }
    return btoa(binary)
  }

  function base64ToBuffer(text) {
    const binary = atob(text)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes.buffer
  }

  root.ImageViewerImport = {
    DEFAULT_PORT,
    DEFAULT_OPTIONS,
    MODIFIERS,
    normalizeOptions,
    modifierLabel,
    matchesModifier,
    isTwitterHost,
    parseTweetPath,
    isPixivHost,
    parsePixivArtworkPath,
    parsePixivImageUrl,
    parsePixivWork,
    pixivArtworkUrl,
    workResultMessage,
    upgradeImageUrl,
    isFetchable,
    candidateUrls,
    suggestFileName,
    resultMessage,
    bufferToBase64,
    base64ToBuffer
  }
})(globalThis)
