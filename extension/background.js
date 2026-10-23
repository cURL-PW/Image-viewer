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

  async function notify(result) {
    const ok = result.status === 'imported' || result.status === 'duplicate'
    try {
      await api.notifications.create({
        type: 'basic',
        iconUrl: api.runtime.getURL('icons/icon-96.png'),
        title: ok ? 'Image Viewer' : 'Image Viewer に取り込めませんでした',
        message: lib.resultMessage(result)
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
      const twitter = request.twitter || null
      result = await sendToApp(image, {
        pageUrl: request.pageUrl,
        imageUrl,
        fileName: lib.suggestFileName(imageUrl),
        site: twitter ? twitter.site : undefined,
        author: twitter ? twitter.author : undefined,
        postId: twitter ? twitter.postId : undefined
      })
    }

    if (tabId !== undefined && tabId >= 0) {
      api.tabs
        .sendMessage(tabId, { type: 'result', requestId: request.requestId, status: result.status }, { frameId })
        .catch(() => undefined)
    }
    await notify(result)
    return result
  }

  // 応答は sendResponse で返す (Promise を返す書き方は古い Chrome が受け付けないため)
  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    let work = null
    if (message && message.type === 'import' && sender.tab) {
      work = importImage(message, sender.tab.id, sender.frameId)
    } else if (message && message.type === 'ping') {
      work = ping()
    }
    if (!work) return false
    work.then(sendResponse, () => sendResponse({ status: 'failed' }))
    return true
  })

  api.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== MENU_ID) return
    void (async () => {
      const tabId = tab ? tab.id : undefined
      const frameId = info.frameId ?? 0
      let request = null
      // 右クリックした画像の投稿者などはページ側でしか分からないので聞く
      if (tabId !== undefined && tabId >= 0) {
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
          twitter: null
        }
      }
      await importImage(request, tabId, frameId)
    })()
  })

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
