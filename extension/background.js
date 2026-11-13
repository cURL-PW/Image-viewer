/*
 * 背景処理。画像を取りに行き、PC で起動中の Image Viewer (127.0.0.1 の受け口) へ送る。
 * Firefox では背景ページ、Chrome / Edge では Service Worker として動く。
 */
/* global importScripts */
if (typeof importScripts === 'function' && !globalThis.ImageViewerImport) importScripts('lib.js')
;(function () {
  'use strict'
  const api = globalThis.browser ?? globalThis.chrome
  const lib = globalThis.ImageViewerImport
  const MENU_ID = 'image-viewer-import'
  const MENU_WORK_ID = 'image-viewer-import-pixiv-work'
  const MENU_TWEET_ID = 'image-viewer-import-tweet'
  /** X の投稿ページ・タイムライン (x.com / twitter.com) */
  const TWITTER_PATTERNS = ['*://x.com/*', '*://*.x.com/*', '*://twitter.com/*', '*://*.twitter.com/*']
  /**
   * ページと同じ Referer を付けるための一時的な規則の ID の範囲。
   * 続けて取り込むと取りに行く処理が重なるので、1 枚ごとに別の ID を使う
   * (同じ ID だと、先に終わった方が後の規則を消してしまう)
   */
  const REFERER_RULE_FIRST = 4781
  const REFERER_RULE_COUNT = 1000
  let nextRefererRule = 0
  const usedRefererRules = new Set()

  function allocRefererRule() {
    for (let i = 0; i < REFERER_RULE_COUNT; i++) {
      const id = REFERER_RULE_FIRST + ((nextRefererRule + i) % REFERER_RULE_COUNT)
      if (!usedRefererRules.has(id)) {
        nextRefererRule = (id - REFERER_RULE_FIRST + 1) % REFERER_RULE_COUNT
        usedRefererRules.add(id)
        return id
      }
    }
    return null
  }
  /** リンク先が画像かどうかを確かめる間に、HTML を全部読まないための上限 (ms) */
  const FETCH_TIMEOUT = 60_000

  async function loadOptions() {
    return lib.normalizeOptions(await api.storage.local.get(lib.DEFAULT_OPTIONS))
  }

  function createMenu() {
    api.contextMenus.removeAll(() => {
      api.contextMenus.create({
        id: MENU_ID,
        title: 'Image Viewer に取り込む',
        contexts: ['image']
      })
      // pixiv の作品ページでだけ出す
      api.contextMenus.create({
        id: MENU_WORK_ID,
        title: 'この作品の全ページを Image Viewer に取り込む',
        contexts: ['image'],
        documentUrlPatterns: ['*://www.pixiv.net/artworks/*', '*://www.pixiv.net/*/artworks/*']
      })
      // X でだけ出す
      api.contextMenus.create({
        id: MENU_TWEET_ID,
        title: 'この投稿の画像をすべて Image Viewer に取り込む',
        contexts: ['image'],
        documentUrlPatterns: TWITTER_PATTERNS
      })
    })
  }

  api.runtime.onInstalled.addListener((details) => {
    createMenu()
    // 合言葉を貼ってもらうため、入れた直後に設定画面を開く
    if (details.reason === 'install') void api.runtime.openOptionsPage()
  })
  // Firefox は再起動でメニューが消えることがあるので、起動時にも作り直す
  api.runtime.onStartup.addListener(createMenu)

  /**
   * 画像を取りに行く間だけ、ページと同じ Referer を付ける。
   * 直リンクを禁止しているサイト (Referer を見るもの) でも取れるようにするため。
   * 対応していないブラウザでは付けずに進む
   */
  async function withReferer(url, referrer, work) {
    let ruleId = null
    let added = false
    try {
      const host = new URL(url).hostname
      if (referrer && /^https?:/.test(url) && api.declarativeNetRequest) {
        ruleId = allocRefererRule()
      }
      if (ruleId !== null) {
        await api.declarativeNetRequest.updateSessionRules({
          // 前回の起動で消し損ねたものが残っていても入れ直せるように
          removeRuleIds: [ruleId],
          addRules: [
            {
              id: ruleId,
              priority: 1,
              action: {
                type: 'modifyHeaders',
                requestHeaders: [{ header: 'referer', operation: 'set', value: referrer }]
              },
              condition: {
                requestDomains: [host],
                // タブに属さない通信 (= この拡張の通信) だけに付ける
                tabIds: [-1],
                resourceTypes: ['xmlhttprequest', 'other']
              }
            }
          ]
        })
        added = true
      }
    } catch (error) {
      console.warn('[image-viewer] Referer を付けられませんでした', error)
    }
    try {
      return await work()
    } finally {
      if (added) {
        await api.declarativeNetRequest
          .updateSessionRules({ removeRuleIds: [ruleId] })
          .catch(() => undefined)
      }
      if (ruleId !== null) usedRefererRules.delete(ruleId)
    }
  }

  /** 画像を取る。画像でなかったもの (リンク先が HTML など) は null */
  async function fetchImage(url, referrer) {
    if (!lib.isFetchable(url)) return null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT)
    try {
      return await withReferer(url, referrer, async () => {
        const response = await fetch(url, { credentials: 'include', signal: controller.signal })
        if (!response.ok) return null
        const type = response.headers.get('content-type') || ''
        // 画像でなければ本文を読まずにやめる
        if (type && !/^image\//i.test(type) && !/octet-stream/i.test(type)) {
          controller.abort()
          return null
        }
        return { data: await response.arrayBuffer(), type }
      })
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /** 拡張から取れなかったものは、ページの中で読んでもらう */
  async function fetchViaPage(tabId, frameId, url) {
    if (tabId === undefined || tabId < 0) return null
    try {
      const reply = await api.tabs.sendMessage(tabId, { type: 'fetchInPage', url }, { frameId })
      if (!reply || !reply.ok) return null
      return { data: lib.base64ToBuffer(reply.base64), type: reply.type }
    } catch {
      return null
    }
  }

  async function sendToApp(image, meta) {
    const options = await loadOptions()
    if (!options.token) return { status: 'no-token' }
    let response
    try {
      response = await fetch(`http://127.0.0.1:${options.port}/v1/import`, {
        method: 'POST',
        headers: {
          'Content-Type': image.type || 'application/octet-stream',
          'X-Image-Viewer-Token': options.token,
          'X-Image-Viewer-Meta': encodeURIComponent(JSON.stringify(meta))
        },
        body: image.data
      })
    } catch {
      return { status: 'unreachable' }
    }
    if (response.status === 401) return { status: 'bad-token' }
    try {
      const body = await response.json()
      return body && typeof body.status === 'string' ? body : { status: 'failed' }
    } catch {
      return { status: 'failed' }
    }
  }

  function notify(result) {
    const ok = result.status === 'imported' || result.status === 'duplicate'
    return notifyText(ok, lib.resultMessage(result))
  }

  async function notifyText(ok, message) {
    try {
      await api.notifications.create({
        type: 'basic',
        iconUrl: api.runtime.getURL('icons/icon-96.png'),
        title: ok ? 'Image Viewer' : 'Image Viewer に取り込めませんでした',
        message
      })
    } catch {
      // 通知を出せない環境でも、画像の枠では知らせている
    }
  }

  /**
   * 取り込みの本体。リンク先 → 表示中の画像の順に取りに行き、取れたものをアプリへ送る
   */
  async function importImage(request, tabId, frameId) {
    let image = null
    let imageUrl = ''
    for (const candidate of lib.candidateUrls(request.srcUrl, request.linkUrl)) {
      image = await fetchImage(candidate.url, request.pageUrl)
      // 表示中の画像が拡張から取れなければ、ページの中で読む (blob: や Cookie の都合)
      if (!image && !candidate.link) image = await fetchViaPage(tabId, frameId, candidate.url)
      if (image) {
        imageUrl = candidate.url
        break
      }
    }

    let result
    if (!image) {
      result = { status: 'fetch-failed' }
    } else {
      // 投稿者などを読み取れたサイト (Twitter / pixiv) の情報
      const source = request.source || null
      result = await sendToApp(image, {
        pageUrl: request.pageUrl,
        imageUrl,
        fileName: lib.suggestFileName(imageUrl),
        site: source ? source.site : undefined,
        author: source ? source.author : undefined,
        postId: source ? source.postId : undefined
      })
    }

    showResult(tabId, frameId, request.requestId, result.status)
    await notify(result)
    return result
  }

  /** 取り込みを頼んだ画像に、結果の枠を出してもらう */
  function showResult(tabId, frameId, requestId, status) {
    if (tabId === undefined || tabId < 0 || !requestId) return
    api.tabs.sendMessage(tabId, { type: 'result', requestId, status }, { frameId }).catch(() => undefined)
  }

  /** 全ページ取り込みで、まだ取り込んでいない枚数 (ツールバーのバッジに出す) */
  let remainingPages = 0
  /** 全ページ取り込みは 1 作品ずつ順番に進める (pixiv に一度に取りに行かないため) */
  let workQueue = Promise.resolve()
  /** 取り込み中・待ち中の作品 (同じ作品を重ねて頼まれても 1 回にする) */
  const queuedWorks = new Set()

  function updateBadge() {
    try {
      if (remainingPages > 0) {
        void api.action.setBadgeBackgroundColor({ color: '#3c78d8' })
        void api.action.setBadgeText({ text: String(remainingPages) })
      } else {
        void api.action.setBadgeText({ text: '' })
      }
    } catch {
      // バッジを出せない環境 (Android など) では、最後の通知だけで知らせる
    }
  }

  /** 取得に失敗したら 1 回だけ取り直す */
  async function fetchWithRetry(url, referrer) {
    const image = await fetchImage(url, referrer)
    if (image) return image
    await new Promise((resolve) => setTimeout(resolve, 1000))
    return fetchImage(url, referrer)
  }

  /** 1 枚取り込み続けられない状態 (アプリが起動していないなど) になったら、残りはやめる */
  const ABORT_STATUSES = new Set(['no-token', 'bad-token', 'unreachable', 'no-library'])

  /** pixiv の作品の全ページ・X の投稿の全画像を、原寸で 1 枚ずつ取り込む */
  async function importWorkPages(work) {
    const summary = {
      imported: 0,
      duplicate: 0,
      failed: 0,
      ugoira: Boolean(work.ugoira),
      skippedVideos: work.skippedVideos || 0,
      abort: null
    }
    let left = work.pages.length
    try {
      for (const imageUrl of work.pages) {
        const image = await fetchWithRetry(imageUrl, work.referrer)
        let status = 'fetch-failed'
        if (image) {
          const result = await sendToApp(image, {
            pageUrl: work.pageUrl,
            imageUrl,
            fileName: lib.suggestFileName(imageUrl),
            site: work.site,
            author: work.author || undefined,
            postId: work.postId
          })
          status = result.status
        }
        left -= 1
        remainingPages -= 1
        updateBadge()
        if (status === 'imported') summary.imported += 1
        else if (status === 'duplicate') summary.duplicate += 1
        else if (ABORT_STATUSES.has(status)) {
          summary.abort = status
          break
        } else summary.failed += 1
      }
    } finally {
      remainingPages -= left
      updateBadge()
    }
    return summary
  }

  function importWork(work, requestId, tabId, frameId, failure = 'work-failed') {
    if (!work || !Array.isArray(work.pages) || work.pages.length === 0) {
      showResult(tabId, frameId, requestId, 'fetch-failed')
      return notify({ status: failure })
    }
    const key = `${work.site}:${work.postId}`
    if (queuedWorks.has(key)) return Promise.resolve()
    queuedWorks.add(key)
    remainingPages += work.pages.length
    updateBadge()
    const run = workQueue.then(async () => {
      try {
        return await importWorkPages(work)
      } catch {
        return { imported: 0, duplicate: 0, failed: work.pages.length, ugoira: false, abort: null }
      } finally {
        queuedWorks.delete(key)
      }
    })
    // 次の作品は、通知を出し終わるのを待たずに始める (通知が返ってこない環境があるため)
    workQueue = run.then(() => undefined)
    return run.then(async (summary) => {
      const status = summary.abort
        ? summary.abort
        : summary.failed > 0
          ? 'failed'
          : summary.imported > 0
            ? 'imported'
            : 'duplicate'
      showResult(tabId, frameId, requestId, status)
      await notifyText(status === 'imported' || status === 'duplicate', lib.workResultMessage(summary))
    })
  }

  /**
   * X の投稿の画像を一覧にする。画面に出ている画像だけでは揃わない (20 枚の投稿など) ので、
   * 埋め込み用の公開情報から全画像を読み、読めなければ画面に出ている画像 (domUrls) だけにする
   */
  async function loadTweetWork(tweet, domUrls) {
    let media = null
    if (tweet && tweet.postId) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15_000)
      try {
        const response = await fetch(lib.tweetSyndicationUrl(tweet.postId), {
          credentials: 'omit',
          signal: controller.signal
        })
        if (response.ok) media = lib.parseTweetMedia(await response.json())
      } catch {
        // 画面に出ている画像だけで進める
      } finally {
        clearTimeout(timer)
      }
    }
    return lib.buildTweetWork(tweet, media, domUrls)
  }

  async function importTweet(message, tabId, frameId) {
    const work = await loadTweetWork(message.tweet, message.domUrls)
    return importWork(work, message.requestId, tabId, frameId, 'tweet-failed')
  }

  // 応答は sendResponse で返す (Promise を返す書き方は古い Chrome が受け付けないため)
  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    let work = null
    if (message && message.type === 'import' && sender.tab) {
      work = importImage(message, sender.tab.id, sender.frameId)
    } else if (message && message.type === 'importWork' && sender.tab) {
      // 返事は待たせない (全ページの取り込みは時間がかかるため)
      void importWork(message.work, message.requestId, sender.tab.id, sender.frameId)
      work = Promise.resolve({ status: 'queued' })
    } else if (message && message.type === 'importTweet' && sender.tab) {
      void importTweet(message, sender.tab.id, sender.frameId)
      work = Promise.resolve({ status: 'queued' })
    } else if (message && message.type === 'ping') {
      work = ping()
    }
    if (!work) return false
    work.then(sendResponse, () => sendResponse({ status: 'failed' }))
    return true
  })

  async function onMenuClicked(info, tab) {
    const tabId = tab ? tab.id : undefined
    const frameId = info.frameId ?? 0
    const hasTab = tabId !== undefined && tabId >= 0
    if (info.menuItemId === MENU_WORK_ID) {
      const reply = hasTab
        ? await api.tabs
            .sendMessage(tabId, { type: 'workContext', srcUrl: info.srcUrl, linkUrl: info.linkUrl }, { frameId })
            .catch(() => null)
        : null
      await importWork(reply && reply.work, reply && reply.requestId, tabId, frameId)
      return
    }
    if (info.menuItemId === MENU_TWEET_ID) {
      const reply = hasTab
        ? await api.tabs
            .sendMessage(tabId, { type: 'tweetContext', srcUrl: info.srcUrl }, { frameId })
            .catch(() => null)
        : null
      await importTweet(reply || {}, tabId, frameId)
      return
    }
    if (info.menuItemId !== MENU_ID) return
    let request = null
    // 右クリックした画像の投稿者などはページ側でしか分からないので聞く
    if (hasTab) {
      request = await api.tabs
        .sendMessage(tabId, { type: 'context', srcUrl: info.srcUrl, linkUrl: info.linkUrl }, { frameId })
        .catch(() => null)
    }
    if (!request || !request.srcUrl) {
      request = {
        srcUrl: info.srcUrl,
        linkUrl: info.linkUrl || '',
        pageUrl: info.frameUrl || info.pageUrl || '',
        requestId: null,
        source: null
      }
    }
    await importImage(request, tabId, frameId)
  }

  api.contextMenus.onClicked.addListener((info, tab) => void onMenuClicked(info, tab))
  // e2e テストから右クリックメニューを選んだことにするため (ブラウザのメニューは操作できない)
  globalThis.ImageViewerImportBackground = { onMenuClicked }

  // ツールバーのボタンは設定画面を開く
  api.action.onClicked.addListener(() => void api.runtime.openOptionsPage())

  /** 設定画面の「接続を確かめる」 */
  async function ping() {
    const options = await loadOptions()
    if (!options.token) return { status: 'no-token' }
    try {
      const response = await fetch(`http://127.0.0.1:${options.port}/v1/ping`, {
        headers: { 'X-Image-Viewer-Token': options.token }
      })
      if (response.status === 401) return { status: 'bad-token' }
      if (!response.ok) return { status: 'failed' }
      const body = await response.json()
      return { status: body.library ? 'ok' : 'no-library' }
    } catch {
      return { status: 'unreachable' }
    }
  }
})()
