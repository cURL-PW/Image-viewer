import path from 'node:path'
import fs from 'node:fs'
import { BrowserWindow, app, session, shell } from 'electron'
import { IMAGE_PROTOCOL, IPC, THUMB_PROTOCOL, thumbnailGenerationSize } from '@shared/types'
import { broadcast, cloudModeKey, openRoot, type AppContext } from './context'
import { LibraryDb } from './db'
import { registerIpcHandlers } from './ipc'
import { Library } from './library'
import { createResolver, registerImageProtocolHandlers, registerImageSchemes } from './protocol'
import { LAST_ROOT_KEY, SettingsStore } from './settings'
import { TaggerService } from './tagger/service'
import { CloudGuard, DEFAULT_CLOUD_GUARD_OPTIONS } from './cloud-guard'
import { initDebugLog } from './debug-log'
import { installFsProbe } from './fs-probe'
import { DerivedImageCache } from './image-cache'

/**
 * 表示用トランスコードの長辺上限。iPhone の 12MP (4032x3024) はそのまま収まるので、
 * 実質的に元解像度を保ったまま Chromium が表示できる形式へ変換できる。
 */
const DISPLAY_MAX_EDGE = 4096

// registerSchemesAsPrivileged は app ready より前に呼ぶ必要がある
registerImageSchemes()

let context: AppContext | null = null

/**
 * 起動時にルートフォルダを指定できるようにする。
 * `image-viewer --root <path>`、環境変数 IMAGE_VIEWER_ROOT、
 * またはパッケージ版では位置引数のフォルダパス。
 */
function startupRoot(argv: string[], env: NodeJS.ProcessEnv): string | null {
  const candidates: string[] = []
  if (env.IMAGE_VIEWER_ROOT) candidates.push(env.IMAGE_VIEWER_ROOT)

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--root=')) {
      candidates.push(arg.slice('--root='.length))
    } else if (arg === '--root' && i + 1 < argv.length) {
      candidates.push(argv[i + 1])
      i++
    } else if (app.isPackaged && i > 0 && !arg.startsWith('-')) {
      candidates.push(arg)
    }
  }

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return path.resolve(candidate)
    } catch {
      // 存在しないパスは無視する
    }
  }
  return null
}

function createContext(): AppContext {
  const userData = app.getPath('userData')
  fs.mkdirSync(userData, { recursive: true })

  const db = new LibraryDb(path.join(userData, 'library.db'))
  const settings = new SettingsStore(db)

  // 何がファイルを触ってダウンロードを起こしているのかを実測で追うための記録。
  // 原因が分かるまでは既定で有効。設定か IMAGE_VIEWER_DEBUG_LOG=0 で止められる。
  const log = initDebugLog(
    path.join(userData, 'logs', 'debug.log'),
    settings.get().debugLog && process.env.IMAGE_VIEWER_DEBUG_LOG !== '0'
  )
  log.log({ kind: 'app-start', note: `${process.platform} electron ${process.versions.electron}` })
  // 「アプリは読んでいないはずなのにダウンロードが続く」を確かめるための計測。
  // 自覚のない経路 (依存ライブラリの監視など) がファイルを開いていないかを数える
  installFsProbe()

  // クラウド同期フォルダで勝手にダウンロードが走らないようにする門番。
  // しきい値は E2E から下げられるようにしておく。
  const slowReadMs = Number(process.env.IMAGE_VIEWER_SLOW_READ_MS)
  const guard = new CloudGuard({
    ...DEFAULT_CLOUD_GUARD_OPTIONS,
    slowReadMs: Number.isFinite(slowReadMs) ? slowReadMs : DEFAULT_CLOUD_GUARD_OPTIONS.slowReadMs
  })
  guard.setAlwaysRead(settings.get().alwaysReadCloudFiles)

  // 走査の fs.stat は読み込みとは別の遮断器にかける。
  // 実測した iCloud のプレースホルダ (RECALL_ON_DATA_ACCESS) は stat では実体を
  // 取りに行かないので、日付やサイズは拾う。遅ければ自動でやめる。
  const library = new Library(db, {
    allow: () => guard.allowStat(),
    record: (ms) => guard.recordStat(ms)
  })

  const thumbs = new DerivedImageCache({
    label: 'thumb',
    cacheDir: path.join(userData, 'thumbnails'),
    size: thumbnailGenerationSize(settings.get().thumbnailSize),
    quality: 80,
    guard
  })
  // HEIC は Chromium が表示できないので、元の解像度を保ったまま WebP へ変換して配信する
  const display = new DerivedImageCache({
    label: 'display',
    cacheDir: path.join(userData, 'display'),
    size: DISPLAY_MAX_EDGE,
    quality: 88,
    guard
  })
  const tagger = new TaggerService(db, library, settings, guard, thumbs)
  const resolve = createResolver(db, library)

  library.on('change', (change) => {
    broadcast(IPC.eventLibraryChanged, change)
    if (change.added.length > 0 || change.updated.length > 0) {
      tagger.notifyLibraryChanged()
    }
  })
  library.on('indexProgress', (progress) => {
    broadcast(IPC.eventIndexProgress, progress)
  })

  // 一度クラウドと判定したフォルダは覚えておき、次に開くときは
  // また数枚ダウンロードして確かめ直さずに済むようにする
  guard.on('change', (status) => {
    const rootPath = library.currentRootPath
    if (!rootPath || status.reason === 'remembered') return
    db.setSetting(cloudModeKey(rootPath), status.cloudFolder ? '1' : '')
  })

  return { db, library, thumbs, display, settings, guard, tagger, resolve, log }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#1a1a1e',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  window.once('ready-to-show', () => window.show())

  // 起動直後にルートが決まっていた場合、読み込み完了後に必ず 1 度伝える
  window.webContents.on('did-finish-load', () => {
    const rootId = context?.library.currentRootId
    const rootPath = context?.library.currentRootPath
    if (rootId === undefined || rootId === null || !rootPath) return
    window.webContents.send(IPC.eventRootChanged, {
      id: rootId,
      path: rootPath,
      indexed: !context?.library.isIndexing
    })
  })

  // マウスの「戻る」ボタン。Windows ではこちらで飛んでくることがあるので、
  // renderer 側の mousedown と両方で受ける (どちらか一方しか来ない構成がある)
  window.on('app-command', (event, command) => {
    if (command !== 'browser-backward') return
    event.preventDefault()
    window.webContents.send(IPC.eventGoBack)
  })

  // Ctrl + / Ctrl - / Ctrl 0 は Electron 標準では画面全体の拡大縮小になる。
  // 画面ではなくサムネイルの大きさを変えたいので、ここで止めて renderer に伝える。
  // (Ctrl + ホイールは renderer 側で止める)
  window.webContents.setVisualZoomLevelLimits(1, 1).catch(() => undefined)
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return
    const delta =
      input.key === '+' || input.key === '=' || input.key === ';'
        ? 1
        : input.key === '-' || input.key === '_'
          ? -1
          : input.key === '0'
            ? 0
            : null
    if (delta === null) return
    event.preventDefault()
    window.webContents.send(IPC.eventThumbZoom, delta)
  })

  // 全画面の出入りを renderer に伝える。F11 以外 (OS の操作や Esc) で変わることもあるため
  // 状態はウィンドウ側を正とし、renderer はこの通知で表示を合わせる
  window.on('enter-full-screen', () => window.webContents.send(IPC.eventFullScreen, true))
  window.on('leave-full-screen', () => window.webContents.send(IPC.eventFullScreen, false))

  // 外部リンクは既定のブラウザで開き、アプリ内での遷移は許可しない
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void window.loadURL(devUrl)
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  return window
}

function applyContentSecurityPolicy(): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  // dev サーバーは HMR のため inline script と ws を必要とする
  const scriptSrc = devUrl ? `'self' 'unsafe-inline'` : `'self'`
  const connectSrc = devUrl ? `'self' ws: http://localhost:*` : `'self'`

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          [
            `default-src 'self'`,
            `script-src ${scriptSrc}`,
            `style-src 'self' 'unsafe-inline'`,
            `img-src 'self' data: blob: ${IMAGE_PROTOCOL}: ${THUMB_PROTOCOL}:`,
            `connect-src ${connectSrc}`
          ].join('; ')
        ]
      }
    })
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows()
    if (existing) {
      if (existing.isMinimized()) existing.restore()
      existing.focus()
    }
  })

  void app.whenReady().then(async () => {
    applyContentSecurityPolicy()

    context = createContext()
    registerImageProtocolHandlers(context.resolve, context.thumbs, context.display)
    registerIpcHandlers(context)

    createWindow()

    // コマンドラインでの指定を優先し、なければ前回開いていたフォルダを復帰する
    const cliRoot = startupRoot(process.argv, process.env)
    const lastRootId = context.db.getSetting(LAST_ROOT_KEY)
    const startPath =
      cliRoot ?? (lastRootId !== null ? context.db.getRootPath(Number(lastRootId)) : null)

    if (startPath !== null && fs.existsSync(startPath)) {
      const rootId = await openRoot(context, startPath)
      broadcast(IPC.eventRootChanged, { id: rootId, path: startPath, indexed: false })
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let shuttingDown = false

// 終了前にワーカーと監視を止め、DB を確実に閉じる
app.on('before-quit', (event) => {
  if (!context || shuttingDown) return
  shuttingDown = true
  event.preventDefault()

  void (async () => {
    const current = context
    context = null
    try {
      await current?.tagger.dispose()
      await current?.library.stop()
      // 落ちる直前の行まで残す
      await current?.log.dispose()
      current?.db.close()
    } catch (error) {
      console.error('[shutdown]', error)
    }
    app.quit()
  })()
})
