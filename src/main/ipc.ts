import { statSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import {
  IPC,
  type AppSettings,
  type DebugLogInfo,
  type FolderNode,
  type ImageQuery,
  type ImageRecord,
  type ImageTag,
  type LibraryInfo,
  type RootInfo,
  type ScanCommand,
  type ScanProgress,
  type TagInfo,
  type CloudDiagnostics
} from '@shared/types'
import { closeRoot, cloudModeKey, openRoot, type AppContext } from './context'

export interface ImageInfoResult {
  image: ImageRecord | null
  tags: ImageTag[]
}

export interface TagListRequest {
  query: ImageQuery
  /** 選択中のタグは絞り込みで消えても一覧に残す */
  keepTagIds: number[]
  search: string
  limit: number
}

function currentRoot(ctx: AppContext): RootInfo | null {
  const id = ctx.library.currentRootId
  const rootPath = ctx.library.currentRootPath
  if (id === null || rootPath === null) return null
  return { id, path: rootPath, indexed: !ctx.library.isIndexing }
}

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}

function listLibraries(ctx: AppContext): LibraryInfo[] {
  const activeId = ctx.library.currentRootId
  return ctx.db.listRoots().map((root) => ({
    id: root.id,
    path: root.path,
    name: path.basename(root.path) || root.path,
    count: root.count,
    available: isDirectory(root.path),
    active: root.id === activeId
  }))
}

export function registerIpcHandlers(ctx: AppContext): void {
  ipcMain.handle(IPC.openFolder, async (event): Promise<RootInfo | null> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = window
      ? await dialog.showOpenDialog(window, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return currentRoot(ctx)

    await openRoot(ctx, result.filePaths[0])
    return currentRoot(ctx)
  })

  ipcMain.handle(IPC.getRoot, (): RootInfo | null => currentRoot(ctx))

  ipcMain.handle(IPC.listLibraries, (): LibraryInfo[] => listLibraries(ctx))

  ipcMain.handle(IPC.switchLibrary, async (_event, id: number): Promise<RootInfo | null> => {
    const rootPath = Number.isInteger(id) ? ctx.db.getRootPath(id) : null
    if (rootPath === null || !isDirectory(rootPath)) return currentRoot(ctx)
    if (id !== ctx.library.currentRootId) await openRoot(ctx, rootPath)
    return currentRoot(ctx)
  })

  // 登録を外すだけで、フォルダの中身には触らない。開いていたものなら次の候補へ移る
  ipcMain.handle(IPC.removeLibrary, async (_event, id: number): Promise<RootInfo | null> => {
    const rootPath = Number.isInteger(id) ? ctx.db.getRootPath(id) : null
    if (rootPath === null) return currentRoot(ctx)

    if (id === ctx.library.currentRootId) {
      await closeRoot(ctx)
      const next = ctx.db.listRoots().find((root) => root.id !== id && isDirectory(root.path))
      ctx.db.removeRoot(id)
      if (next) await openRoot(ctx, next.path)
    } else {
      ctx.db.removeRoot(id)
    }
    ctx.db.setSetting(cloudModeKey(rootPath), '')
    return currentRoot(ctx)
  })

  ipcMain.handle(IPC.getTree, (): FolderNode | null => {
    const rootId = ctx.library.currentRootId
    const rootPath = ctx.library.currentRootPath
    if (rootId === null || rootPath === null) return null
    return ctx.db.buildTree(rootId, path.basename(rootPath) || rootPath)
  })

  ipcMain.handle(IPC.queryImages, (_event, query: ImageQuery): number[] => {
    const rootId = ctx.library.currentRootId
    if (rootId === null) return []
    // 表示中のフォルダを優先してタグ付けする
    ctx.tagger.setPriorityDir(query.dir)
    return ctx.db.queryImageIds(rootId, query)
  })

  ipcMain.handle(IPC.getImages, (_event, ids: number[]): ImageRecord[] => {
    if (!Array.isArray(ids)) return []
    return ctx.db.getImages(ids.filter((id) => Number.isInteger(id)).slice(0, 2000))
  })

  ipcMain.handle(IPC.getImageInfo, async (_event, id: number): Promise<ImageInfoResult> => {
    const target = ctx.resolve(id)
    if (!target) return { image: null, tags: [] }

    let image = target.record
    // 解像度の取得もファイルのデータを読むため、未ダウンロードなら触らない
    // (ここを通すとクラウドから 1 枚落ちてしまう)
    const notDownloaded = await ctx.guard.isNotDownloaded(target.fullPath)
    if (!notDownloaded && (image.width === null || image.height === null)) {
      const dimensions = await ctx.thumbs.dimensions(target.fullPath)
      if (dimensions) {
        ctx.db.setDimensions(id, dimensions.width, dimensions.height)
        image = { ...image, ...dimensions }
      }
    }
    return { image, tags: ctx.db.getImageTags(id) }
  })

  ipcMain.handle(IPC.revealImage, (_event, id: number): void => {
    const target = ctx.resolve(id)
    if (target) shell.showItemInFolder(target.fullPath)
  })

  ipcMain.handle(IPC.listTags, (_event, request: TagListRequest): TagInfo[] => {
    const rootId = ctx.library.currentRootId
    if (rootId === null) return []

    const limit = Math.min(Math.max(request.limit ?? 300, 1), 2000)
    // 集計範囲はフォルダ選択のみ。タグ条件で絞ると、選択中の条件と共起しない
    // タグが一覧から消えて選べなくなるため、件数もフォルダ基準で安定させる。
    const scope = { ...request.query, includeTags: [], excludeTags: [] }
    const found = ctx.db.listTags(rootId, scope, limit)

    // 選択中タグが結果に含まれていなければ足しておく (解除できなくなるのを防ぐ)
    const present = new Set(found.map((tag) => tag.id))
    const missing = (request.keepTagIds ?? []).filter((id) => !present.has(id))
    const tags = missing.length > 0 ? [...ctx.db.getTagsByIds(missing), ...found] : found

    const search = (request.search ?? '').trim().toLowerCase()
    return search === '' ? tags : tags.filter((tag) => tag.name.toLowerCase().includes(search))
  })

  ipcMain.handle(IPC.scanControl, async (_event, command: ScanCommand): Promise<ScanProgress> => {
    await ctx.tagger.handleCommand(command)
    return ctx.tagger.getProgress()
  })

  ipcMain.handle(IPC.getScanProgress, (): ScanProgress => ctx.tagger.getProgress())

  ipcMain.handle(
    IPC.downloadFolder,
    async (_event, request: { dir: string; recursive: boolean }): Promise<void> => {
      await ctx.tagger.downloadFolder(request.dir ?? '', request.recursive !== false)
    }
  )

  ipcMain.handle(IPC.cancelDownload, (): void => ctx.tagger.cancelDownload())

  ipcMain.handle(IPC.getDiagnostics, (): CloudDiagnostics => ctx.guard.diagnostics)

  ipcMain.handle(IPC.getLogInfo, async (): Promise<DebugLogInfo> => {
    let size = 0
    try {
      size = (await fs.stat(ctx.log.filePath)).size
    } catch {
      // まだ 1 行も書かれていない
    }
    return { enabled: ctx.log.isEnabled, path: ctx.log.filePath, size }
  })

  // 「直近をコピー」。renderer 側でクリップボードへ入れて、そのまま貼って共有できる
  ipcMain.handle(IPC.readLogTail, (_event, lines: number): Promise<string> => {
    const count = Math.min(Math.max(Number(lines) || 300, 1), 5000)
    return ctx.log.tail(count)
  })

  ipcMain.handle(IPC.openLogFolder, async (): Promise<void> => {
    // ファイルがまだ無いとエクスプローラが開かないので、空でも作っておく
    await ctx.log.flush()
    try {
      await fs.mkdir(path.dirname(ctx.log.filePath), { recursive: true })
      await fs.appendFile(ctx.log.filePath, '')
    } catch {
      // 作れなくてもフォルダは開いてみる
    }
    shell.showItemInFolder(ctx.log.filePath)
  })

  ipcMain.handle(IPC.clearLog, (): Promise<void> => ctx.log.clear())

  ipcMain.handle(IPC.getSettings, (): AppSettings => ctx.settings.get())

  ipcMain.handle(IPC.setSettings, async (_event, patch: Partial<AppSettings>): Promise<AppSettings> => {
    const { settings, changed } = ctx.settings.update(patch)

    if (changed.includes('thumbnailSize')) {
      ctx.thumbs.setSize(settings.thumbnailSize)
    }
    if (changed.includes('alwaysReadCloudFiles')) {
      ctx.guard.setAlwaysRead(settings.alwaysReadCloudFiles)
    }
    if (changed.includes('debugLog')) {
      ctx.log.setEnabled(settings.debugLog)
    }
    if (
      changed.includes('modelId') ||
      changed.includes('generalThreshold') ||
      changed.includes('characterThreshold') ||
      changed.includes('provider') ||
      changed.includes('autoScan')
    ) {
      // しきい値やモデルが変われば付与済みタグが変わるため、再スキャンが必要
      const needsRescan =
        changed.includes('modelId') ||
        changed.includes('generalThreshold') ||
        changed.includes('characterThreshold') ||
        changed.includes('provider')
      await ctx.tagger.applySettingsChange(needsRescan)
    }
    return settings
  })
}
