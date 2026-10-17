/*
 * ページ側の処理。修飾キー＋クリックを拾い、取り込みを背景処理に頼む。
 * 右クリックメニューから取り込むときのために、右クリックした画像も覚えておく。
 */
;(function () {
  'use strict'
  // all_frames で同じフレームに 2 回入ることがあるので、二重に登録しない
  if (globalThis.__imageViewerImportLoaded) return
  globalThis.__imageViewerImportLoaded = true

  const api = globalThis.browser ?? globalThis.chrome
  const lib = globalThis.ImageViewerImport
  const isMac = /Mac/i.test(navigator.platform || navigator.userAgent)

  let options = lib.DEFAULT_OPTIONS
  /** 右クリックした画像 (メニューから取り込むとき用) */
  let contextTarget = null
  /** 最後に取り込みを頼んだ画像 (結果を枠で知らせる) */
  let lastTarget = null

  api.storage.local.get(lib.DEFAULT_OPTIONS).then((saved) => {
    options = lib.normalizeOptions(saved)
  })
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    const next = { ...options }
    for (const [key, change] of Object.entries(changes)) next[key] = change.newValue
    options = lib.normalizeOptions(next)
  })

  /**
   * クリックした位置の画像を探す。透明な覆いの下に画像があるサイトが多いので、
   * クリックされた要素だけでなく、その位置に重なっている要素も見る
   */
  function imageAt(event) {
    const direct = event.target instanceof Element ? event.target.closest('img') : null
    if (direct) return direct
    for (const element of document.elementsFromPoint(event.clientX, event.clientY)) {
      if (element instanceof HTMLImageElement) return element
      const picture = element.closest('picture')
      if (picture) {
        const img = picture.querySelector('img')
        if (img) return img
      }
    }
    return null
  }

  /** Twitter (X) の投稿者と投稿 ID。画像の入った投稿の、日時のリンクから読む */
  function tweetInfo(img) {
    if (!lib.isTwitterHost(location.hostname)) return null
    const article = img && img.closest('article')
    if (article) {
      const timeLink = article.querySelector('a[href*="/status/"] time')
      const anchors = timeLink
        ? [timeLink.closest('a')]
        : Array.from(article.querySelectorAll('a[href*="/status/"]'))
      for (const anchor of anchors) {
        const info = anchor && lib.parseTweetPath(anchor.getAttribute('href'), location.href)
        if (info) return info
      }
    }
    // 画像を拡大表示している画面 (/ユーザー/status/ID/photo/1) では URL から読む
    return lib.parseTweetPath(location.href)
  }

  /** 取り込みに必要な情報を集める */
  function describe(img, fallback) {
    const twitter = tweetInfo(img)
    const anchor = img && img.closest('a[href]')
    return {
      srcUrl: (img && (img.currentSrc || img.src)) || (fallback && fallback.srcUrl) || '',
      // Twitter の画像のリンク先は画像ではなく投稿の画面なので、取りに行かない
      linkUrl: twitter ? '' : (anchor && anchor.href) || (fallback && fallback.linkUrl) || '',
      pageUrl: location.href,
      twitter
    }
  }

  function flash(element, status) {
    if (!element || !element.isConnected) return
    const color =
      status === 'imported' ? '#3ccf6e' : status === 'duplicate' ? '#e6b33c' : '#e65050'
    const previous = { outline: element.style.outline, offset: element.style.outlineOffset }
    element.style.outline = `3px solid ${color}`
    element.style.outlineOffset = '-3px'
    setTimeout(() => {
      element.style.outline = previous.outline
      element.style.outlineOffset = previous.offset
    }, 900)
  }

  document.addEventListener(
    'contextmenu',
    (event) => {
      contextTarget = imageAt(event)
    },
    true
  )

  // 修飾キー付きのクリックで、ブラウザ既定の動作 (新しいタブで開く・保存など) を止めて取り込む
  function onClick(event) {
    if (event.button !== 0 || !matches(event)) return
    const img = imageAt(event)
    if (!img) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (event.type !== 'click') return
    lastTarget = img
    void api.runtime.sendMessage({ type: 'import', ...describe(img) })
  }

  function matches(event) {
    return lib.matchesModifier(event, options.modifier, isMac)
  }

  // mousedown も止める (Shift+クリックの文字選択や、Alt+クリックのドラッグを防ぐ)
  window.addEventListener('mousedown', onClick, true)
  window.addEventListener('click', onClick, true)

  // 応答は sendResponse で返す (Promise を返す書き方は古い Chrome が受け付けないため)
  api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return false
    if (message.type === 'context') {
      // 右クリックメニューから: 覚えておいた画像の情報を返す
      lastTarget = contextTarget
      sendResponse(describe(contextTarget, message))
      return false
    }
    if (message.type === 'result') {
      flash(lastTarget, message.status)
      return false
    }
    if (message.type === 'fetchInPage') {
      // 拡張から直接取れなかった画像 (blob: など) を、ページと同じ条件で読む
      void fetchInPage(message.url).then(sendResponse)
      return true
    }
    return false
  })

  async function fetchInPage(url) {
    try {
      // Firefox ではページ側の fetch を使う (Cookie や Referer がページと同じになる)
      const pageFetch = typeof content !== 'undefined' && content.fetch ? content.fetch.bind(content) : fetch
      const response = await pageFetch(url, { credentials: 'include' })
      if (!response.ok) return { ok: false }
      const buffer = await response.arrayBuffer()
      return {
        ok: true,
        type: response.headers.get('content-type') || '',
        base64: lib.bufferToBase64(buffer)
      }
    } catch {
      return { ok: false }
    }
  }
})()
