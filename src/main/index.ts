import path from 'node:path'
import fs from 'node:fs'
import { BrowserWindow, app, session, shell } from 'electron'
import { IMAGE_PROTOCOL, IPC, THUMB_PROTOCOL } from '@shared/types'
import { broadcast, type AppContext } from './context'
import { LibraryDb } from './db'
import { registerIpcHandlers } from './ipc'
import { Library } from './library'
import { createResolver, registerImageProtocolHandlers, registerImageSchemes } from './protocol'
import { LAST_ROOT_KEY, SettingsStore } from './settings'
import { TaggerService } from './tagger/service'
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
  const library = new Library(db)
  const thumbs = new DerivedImageCache({
    cacheDir: path.join(userData, 'thumbnails'),
    size: settings.get().thumbnailSize,
    quality: 80
  })
  // HEIC は Chromium が表示できないので、元の解像度を保ったまま WebP へ変換して配信する
  const display = new DerivedImageCache({
    cacheDir: path.join(userData, 'display'),
    size: DISPLAY_MAX_EDGE,
    quality: 88
  })
  const tagger = new TaggerService(db, library, settings)
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

  return { db, library, thumbs, display, settings, tagger, resolve }
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
    if (cliRoot !== null) {
      const rootId = await context.library.setRoot(cliRoot)
      context.db.setSetting(LAST_ROOT_KEY, String(rootId))
      broadcast(IPC.eventRootChanged, { id: rootId, path: cliRoot, indexed: false })
      context.tagger.notifyLibraryChanged()
    } else {
      const lastRoot = context.db.getSetting(LAST_ROOT_KEY)
      if (lastRoot !== null) {
        const restored = await context.library.resumeRoot(Number(lastRoot))
        if (restored) {
          broadcast(IPC.eventRootChanged, {
            id: Number(lastRoot),
            path: context.library.currentRootPath as string,
            indexed: false
          })
          context.tagger.notifyLibraryChanged()
        }
      }
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
      current?.db.close()
    } catch (error) {
      console.error('[shutdown]', error)
    }
    app.quit()
  })()
})
