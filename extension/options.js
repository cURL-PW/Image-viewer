;(function () {
  'use strict'
  const api = globalThis.browser ?? globalThis.chrome
  const lib = globalThis.ImageViewerImport
  const isMac = /Mac/i.test(navigator.platform || navigator.userAgent)
  const ALL_SITES = { origins: ['<all_urls>'] }

  const form = document.getElementById('form')
  const port = document.getElementById('port')
  const token = document.getElementById('token')
  const modifier = document.getElementById('modifier')
  const message = document.getElementById('message')
  const permission = document.getElementById('permission')

  for (const value of lib.MODIFIERS) {
    const option = document.createElement('option')
    option.value = value
    option.textContent =
      value === 'off' ? lib.modifierLabel(value, isMac) : `${lib.modifierLabel(value, isMac)}+クリック`
    modifier.append(option)
  }

  function show(text, kind) {
    message.textContent = text
    message.dataset.kind = kind || ''
  }

  async function load() {
    const options = lib.normalizeOptions(await api.storage.local.get(lib.DEFAULT_OPTIONS))
    port.value = String(options.port)
    token.value = options.token
    modifier.value = options.modifier
  }

  // Firefox では、すべてのサイトへのアクセスを後から許可してもらう必要がある
  async function checkPermission() {
    const granted = await api.permissions.contains(ALL_SITES)
    permission.hidden = granted
  }

  document.getElementById('grant').addEventListener('click', async () => {
    await api.permissions.request(ALL_SITES)
    await checkPermission()
  })

  async function save() {
    const options = lib.normalizeOptions({
      port: port.value,
      token: token.value,
      modifier: modifier.value
    })
    await api.storage.local.set(options)
    port.value = String(options.port)
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    await save()
    show('保存しました', 'ok')
  })

  // 入力したばかりの値で確かめられるよう、先に保存する
  document.getElementById('test').addEventListener('click', async () => {
    await save()
    show('確かめています…')
    const result = await api.runtime.sendMessage({ type: 'ping' })
    if (result.status === 'ok') show('Image Viewer につながりました', 'ok')
    else if (result.status === 'no-library') {
      show('つながりましたが、Image Viewer でライブラリが開かれていません', 'warn')
    } else show(lib.resultMessage(result), 'error')
  })

  void load()
  void checkPermission()
})()
