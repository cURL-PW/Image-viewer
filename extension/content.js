/*
 * ページ側の処理。修飾キー＋クリックを拾い、取り込みを背景処理に頼む。
 * 右クリックメニューから取り込むときのために、右クリックした画像も覚えておく。
 * pixiv の作品ページでは、作品の全ページの原寸の URL を pixiv から読んで背景処理に渡す。
 * X では、投稿の画像をクリックするとその投稿の画像をすべて取り込む (一覧は背景処理が読む)。
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
  /**
   * 取り込みを頼んだ画像 (結果を枠で知らせる)。続けて頼んでも取り違えないよう、
   * 頼んだごとに番号を振って覚えておく
   */
  const pending = new Map()
  let nextRequestId = 1

  function remember(img) {
    const requestId = `${Date.now()}-${nextRequestId++}`
    pending.set(requestId, img)
    // 結果が来なかったものを溜め込まない
    setTimeout(() => pending.delete(requestId), 5 * 60_000)
    return requestId
  }

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
    // 画像のリンク先 (…/status/ID/photo/1) がその画像の投稿 (引用された投稿の画像でも取り違えない)
    const photoLink = img && img.closest('a[href*="/photo/"]')
    const fromPhoto = photoLink && lib.parseTweetPath(photoLink.getAttribute('href'), location.href)
    if (fromPhoto) return fromPhoto
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

  /** X の投稿の画像 (pbs.twimg.com/media/…) か */
  function isTweetPhoto(img) {
    return Boolean(img && lib.twitterMediaId(img.currentSrc || img.src))
  }

  /**
   * X の投稿の中に出ている画像を、投稿内の順 (…/photo/1, /photo/2 …) に集める。
   * 引用された別の投稿の画像は、リンク先の投稿 ID が違うので入れない。
   * 拡大表示の画面 (投稿の枠が無い) では、その画面に出ている画像を集める
   */
  function tweetPhotoUrls(img, tweet) {
    const urls = []
    const article = img && img.closest('article')
    if (article) {
      const found = []
      for (const anchor of article.querySelectorAll('a[href*="/photo/"]')) {
        const href = anchor.getAttribute('href') || ''
        const info = lib.parseTweetPath(href, location.href)
        if (!info || info.postId !== tweet.postId) continue
        const index = Number((href.match(/\/photo\/(\d+)/) || [])[1] || 0)
        for (const photo of anchor.querySelectorAll('img')) {
          if (isTweetPhoto(photo)) found.push({ index, url: photo.currentSrc || photo.src })
        }
      }
      found.sort((a, b) => a.index - b.index)
      for (const item of found) urls.push(item.url)
    } else if (img) {
      const scope = img.closest('[role="dialog"]') || img.closest('[aria-modal="true"]')
      for (const photo of scope ? scope.querySelectorAll('img') : []) {
        if (isTweetPhoto(photo)) urls.push(photo.currentSrc || photo.src)
      }
    }
    if (isTweetPhoto(img) && urls.length === 0) urls.push(img.currentSrc || img.src)
    return urls
  }

  /** X の投稿の画像をまとめて取り込むときに、背景処理へ渡す情報 */
  function tweetRequest(img) {
    const tweet = tweetInfo(img)
    if (!tweet) return null
    return { tweet, domUrls: tweetPhotoUrls(img, tweet) }
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
      source: twitter
    }
  }

  /** pixiv の作品情報を読む。同じ作品を何度も読まないよう覚えておく */
  const pixivWorks = new Map()

  function loadPixivWork(illustId) {
    if (!pixivWorks.has(illustId)) {
      const work = (async () => {
        // Firefox ではページ側の fetch を使う (ログインの Cookie がページと同じになる)
        const pageFetch =
          typeof content !== 'undefined' && content.fetch ? content.fetch.bind(content) : fetch
        const getJson = async (path) => {
          const response = await pageFetch(`${location.origin}${path}`, { credentials: 'include' })
          return response.ok ? response.json() : null
        }
        const [info, pages] = await Promise.all([
          getJson(`/ajax/illust/${illustId}`),
          getJson(`/ajax/illust/${illustId}/pages`)
        ])
        return lib.parsePixivWork(illustId, info, pages)
      })().catch(() => null)
      pixivWorks.set(illustId, work)
      // 失敗したものは次に読み直せるように、少ししたら忘れる
      void work.then((value) => {
        setTimeout(() => pixivWorks.delete(illustId), value ? 10 * 60_000 : 0)
      })
    }
    return pixivWorks.get(illustId)
  }

  /**
   * pixiv の画像なら、どの作品の何ページ目か。画像の URL (…/146233172_p3_master1200.jpg) か、
   * 画像を囲むリンク (/artworks/146233172) から読む
   */
  function pixivTarget(img, fallback) {
    if (!lib.isPixivHost(location.hostname)) return null
    const src = (img && (img.currentSrc || img.src)) || (fallback && fallback.srcUrl) || ''
    const fromImage = lib.parsePixivImageUrl(src)
    if (fromImage) return fromImage
    const anchor = img && img.closest('a[href]')
    const fromLink = anchor && lib.parsePixivArtworkPath(anchor.getAttribute('href'), location.href)
    return fromLink ? { illustId: fromLink, page: 0 } : null
  }

  /** 開いている作品ページの画像か (修飾キー＋クリックで全ページを取り込む対象) */
  function isCurrentWork(target) {
    return Boolean(target && target.illustId === lib.parsePixivArtworkPath(location.href))
  }

  /**
   * describe に加えて、pixiv の画像なら原寸の URL と投稿者・作品 ID を付ける
   * (表示中の画像は縮小版なので、原寸をリンク先として先に試す)
   */
  async function describeFull(img, fallback) {
    const base = describe(img, fallback)
    const target = pixivTarget(img, fallback)
    if (!target) return base
    const work = await loadPixivWork(target.illustId)
    if (!work) return base
    return {
      ...base,
      linkUrl: work.pages[target.page] || work.pages[0],
      pageUrl: lib.pixivArtworkUrl(work.illustId),
      source: pixivSource(work)
    }
  }

  function pixivSource(work) {
    return { site: 'pixiv', author: work.userId, postId: work.illustId }
  }

  /** 枠を付ける前の outline と、元に戻すタイマー。枠が重なっても元の見た目に戻すため */
  const flashing = new WeakMap()

  function flash(element, status) {
    if (!element || !element.isConnected) return
    const color =
      status === 'imported' ? '#3ccf6e' : status === 'duplicate' ? '#e6b33c' : '#e65050'
    let state = flashing.get(element)
    if (state) {
      clearTimeout(state.timer)
    } else {
      state = { outline: element.style.outline, offset: element.style.outlineOffset, timer: 0 }
      flashing.set(element, state)
    }
    element.style.outline = `3px solid ${color}`
    element.style.outlineOffset = '-3px'
    state.timer = setTimeout(() => {
      element.style.outline = state.outline
      element.style.outlineOffset = state.offset
      flashing.delete(element)
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
    const requestId = remember(img)
    // X の投稿の画像なら、その投稿の画像をすべて取り込む
    const tweet = isTweetPhoto(img) ? tweetRequest(img) : null
    if (tweet) {
      void api.runtime.sendMessage({ type: 'importTweet', requestId, ...tweet })
      return
    }
    const target = pixivTarget(img)
    void (async () => {
      // pixiv の作品ページでは、その作品の全ページを取り込む
      if (isCurrentWork(target)) {
        const work = await loadPixivWork(target.illustId)
        if (work) {
          await api.runtime.sendMessage({ type: 'importWork', requestId, work })
          return
        }
      }
      await api.runtime.sendMessage({ type: 'import', requestId, ...(await describeFull(img)) })
    })()
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
      const img = contextTarget
      void describeFull(img, message).then((info) => sendResponse({ requestId: remember(img), ...info }))
      return true
    }
    if (message.type === 'workContext') {
      // 右クリックメニューの「この作品の全ページを取り込む」: 右クリックした画像の作品を読む
      const img = contextTarget
      const target = pixivTarget(img, message)
      const illustId = target ? target.illustId : lib.parsePixivArtworkPath(location.href)
      if (!illustId) {
        sendResponse({ requestId: null, work: null })
        return false
      }
      void loadPixivWork(illustId).then((work) => sendResponse({ requestId: remember(img), work }))
      return true
    }
    if (message.type === 'tweetContext') {
      // 右クリックメニューの「この投稿の画像をすべて取り込む」: 右クリックした画像の投稿を調べる
      const img = contextTarget
      const tweet = tweetRequest(img)
      sendResponse(tweet ? { requestId: remember(img), ...tweet } : { requestId: null })
      return false
    }
    if (message.type === 'result') {
      const img = pending.get(message.requestId)
      if (!img) return false
      pending.delete(message.requestId)
      flash(img, message.status)
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
