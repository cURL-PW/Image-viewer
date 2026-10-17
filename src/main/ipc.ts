import { statSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron'
import {
  IPC,
  type AppSettings,
  type BrowserImportInfo,
  type ImportTarget,
  type DebugLogInfo,
  type FolderNode,
  type ImageQuery,
  type ImageRecord,
  type ImageTag,
  type ImageSource,
  type LibraryInfo,
  type RootInfo,
  type ScanCommand,
  type ScanProgress,
  type TagInfo,
  type CloudDiagnostics,
  type CopyKind,
  type SavedFilter,
  type SavedFilterData,
  type TrashResult,
  normalizeRotation,
  thumbnailGenerationSize
} from '@shared/types'
import {
  applyImportServerSettings,
  closeRoot,
  cloudModeKey,
  importTargetKey,
  loadImportTarget,
  openRoot,
  type AppContext
} from './context'
import { loadImportToken, regenerateImportToken } from './settings'
import { openImage } from './images'
import { excludeTags } from '@shared/tag-filter'
import { sanitizeFilterData } from '@shared/saved-filter'

/** 似た画像として出す最大枚数 */
const SIMILAR_LIMIT = 200

export interface ImageInfoResult {
  image: ImageRecord | null
  tags: ImageTag[]
  source?: ImageSource | null
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

function listSavedFilters(ctx: AppContext): SavedFilter[] {
  const rootId = ctx.library.currentRootId
  if (rootId === null) return []
  return ctx.db.listSavedFilters(rootId).map((row) => {
    let parsed: Partial<SavedFilterData> = {}
    try {
      parsed = JSON.parse(row.data) as Partial<SavedFilterData>
    } catch {
      // 壊れていても一覧からは消さない (名前は残し、条件は空として扱う)
    }
    return { id: row.id, name: row.name, data: sanitizeFilterData(parsed) }
  })
}

/** 保存条件の名前。空なら保存しない */
function filterName(name: unknown): string {
  return typeof name === 'string' ? name.trim().slice(0, 100) : ''
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
    ctx.db.setSetting(importTargetKey(rootPath), '')
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
    const rootId = ctx.library.currentRootId
    const source = rootId !== null ? ctx.db.getImageSource(rootId, image.relPath) : null
    return {
      image,
      tags: ctx.db.getImageTags(id),
      source: source && {
        pageUrl: source.pageUrl,
        imageUrl: source.imageUrl,
        site: source.site,
        author: source.author,
        postId: source.postId,
        importedAt: source.importedAt
      }
    }
  })

  ipcMain.handle(IPC.revealImage, (_event, id: number): void => {
    const target = ctx.resolve(id)
    if (target) shell.showItemInFolder(target.fullPath)
  })

  ipcMain.handle(IPC.setRotation, (_event, id: number, rotation: number): number => {
    const target = ctx.resolve(id)
    if (!target) return 0
    const normalized = normalizeRotation(Number(rotation))
    ctx.db.setRotation(id, normalized)
    return normalized
  })

  ipcMain.handle(IPC.setFavorite, (_event, ids: number[], favorite: boolean): void => {
    const rootId = ctx.library.currentRootId
    if (rootId === null || !Array.isArray(ids)) return
    ctx.db.setFavorite(rootId, ids, favorite === true)
  })

  // ごみ箱へ移す。OS のごみ箱を使うので、間違えても元に戻せる。
  // 未ダウンロードのクラウドファイルも、中身を読まずにそのまま移せる
  ipcMain.handle(IPC.trashImages, async (_event, ids: number[]): Promise<TrashResult> => {
    const trashed: number[] = []
    let failed = 0
    for (const id of Array.isArray(ids) ? ids : []) {
      const target = ctx.resolve(id)
      if (!target) {
        failed += 1
        continue
      }
      try {
        await shell.trashItem(target.fullPath)
        trashed.push(id)
      } catch {
        failed += 1
      }
    }
    ctx.library.forget(trashed)
    return { trashed, failed }
  })

  ipcMain.handle(
    IPC.copyText,
    (_event, ids: number[], kind: 'path' | 'name'): boolean => {
      const lines = (Array.isArray(ids) ? ids : [])
        .map((id) => ctx.resolve(id))
        .filter((target) => target !== null)
        .map((target) => (kind === 'name' ? target.record.fileName : target.fullPath))
      if (lines.length === 0) return false
      clipboard.writeText(lines.join('\n'))
      return true
    }
  )

  ipcMain.handle(IPC.addTag, (_event, ids: number[], name: string): void => {
    const rootId = ctx.library.currentRootId
    if (rootId === null || !Array.isArray(ids) || typeof name !== 'string') return
    ctx.db.addManualTag(rootId, ids, name.slice(0, 200))
  })

  ipcMain.handle(IPC.removeTag, (_event, ids: number[], tagId: number): void => {
    const rootId = ctx.library.currentRootId
    if (rootId === null || !Array.isArray(ids)) return
    ctx.db.removeManualTag(rootId, ids, tagId)
  })

  ipcMain.handle(IPC.tagsForImages, (_event, ids: number[]): TagInfo[] => {
    const rootId = ctx.library.currentRootId
    if (rootId === null || !Array.isArray(ids)) return []
    return ctx.db.tagsForImages(rootId, ids)
  })

  ipcMain.handle(IPC.findSimilar, (_event, id: number): number[] => {
    const rootId = ctx.library.currentRootId
    if (rootId === null || !Number.isInteger(id)) return []
    const similar = ctx.db.findSimilar(rootId, id, SIMILAR_LIMIT)
    return [id, ...similar.map((row) => row.id)]
  })

  ipcMain.handle(IPC.suggestTags, (_event, text: string): string[] =>
    typeof text === 'string' ? ctx.db.suggestTags(text, 20) : []
  )

  ipcMain.handle(IPC.listSavedFilters, (): SavedFilter[] => listSavedFilters(ctx))

  ipcMain.handle(
    IPC.saveFilter,
    (_event, name: string, data: SavedFilterData): SavedFilter[] => {
      const rootId = ctx.library.currentRootId
      const trimmed = filterName(name)
      if (rootId !== null && trimmed !== '') {
        ctx.db.addSavedFilter(rootId, trimmed, JSON.stringify(sanitizeFilterData(data)))
      }
      return listSavedFilters(ctx)
    }
  )

  ipcMain.handle(IPC.renameSavedFilter, (_event, id: number, name: string): SavedFilter[] => {
    const rootId = ctx.library.currentRootId
    const trimmed = filterName(name)
    if (rootId !== null && Number.isInteger(id) && trimmed !== '') {
      ctx.db.renameSavedFilter(rootId, id, trimmed)
    }
    return listSavedFilters(ctx)
  })

  ipcMain.handle(IPC.deleteSavedFilter, (_event, id: number): SavedFilter[] => {
    const rootId = ctx.library.currentRootId
    if (rootId !== null && Number.isInteger(id)) ctx.db.deleteSavedFilter(rootId, id)
    return listSavedFilters(ctx)
  })

  ipcMain.handle(IPC.setFullScreen, (event, fullScreen: boolean): boolean => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return false
    window.setFullScreen(fullScreen === true)
    return window.isFullScreen()
  })

  ipcMain.handle(IPC.openImageExternal, async (_event, id: number): Promise<void> => {
    const target = ctx.resolve(id)
    if (target) await shell.openPath(target.fullPath)
  })

  // 右クリックメニューのコピー。renderer はフルパスを知らないので main 側で入れる
  ipcMain.handle(IPC.copyImage, async (_event, id: number, kind: CopyKind): Promise<boolean> => {
    const target = ctx.resolve(id)
    if (!target) return false
    switch (kind) {
      case 'path':
        clipboard.writeText(target.fullPath)
        return true
      case 'name':
        clipboard.writeText(target.record.fileName)
        return true
      case 'tags':
      case 'tagsExcluded': {
        const all = ctx.db.getImageTags(id).map((tag) => tag.name)
        const tags =
          kind === 'tagsExcluded' ? excludeTags(all, ctx.settings.get().copyExcludeTags) : all
        if (tags.length === 0) return false
        clipboard.writeText(tags.join(', '))
        return true
      }
      case 'image': {
        // ユーザーが明示的に選んだ操作なので、未ダウンロードでもこの 1 枚は読む。
        // HEIC や WebP など貼り付け先が扱えない形式もあるため、PNG に揃えて入れる
        try {
          const { image } = await openImage(target.fullPath)
          const png = await image.png().toBuffer()
          const native = nativeImage.createFromBuffer(png)
          if (native.isEmpty()) return false
          clipboard.writeImage(native)
          return true
        } catch {
          return false
        }
      }
      default:
        return false
    }
  })

  ipcMain.handle(IPC.listTags, (_event, request: TagListRequest): TagInfo[] => {
    const rootId = ctx.library.currentRootId
    if (rootId === null) return []

    const limit = Math.min(Math.max(request.limit ?? 300, 1), 2000)
    // 集計範囲はフォルダ選択のみ。タグ条件で絞ると、選択中の条件と共起しない
    // タグが一覧から消えて選べなくなるため、件数もフォルダ基準で安定させる。
    const scope = {
      ...request.query,
      includeTags: [],
      excludeTags: [],
      search: '',
      favoritesOnly: false
    }
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
      ctx.thumbs.setSize(thumbnailGenerationSize(settings.thumbnailSize))
    }
    if (changed.includes('alwaysReadCloudFiles')) {
      ctx.guard.setAlwaysRead(settings.alwaysReadCloudFiles)
    }
    if (changed.includes('debugLog')) {
      ctx.log.setEnabled(settings.debugLog)
    }
    if (changed.includes('browserImport') || changed.includes('browserImportPort')) {
      await applyImportServerSettings(ctx)
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

  const browserImportInfo = (token: string): BrowserImportInfo => {
    const rootPath = ctx.library.currentRootPath
    return {
      status: ctx.importServer.currentStatus,
      token,
      target: rootPath === null ? null : loadImportTarget(ctx.db, rootPath)
    }
  }

  ipcMain.handle(IPC.getBrowserImport, (): BrowserImportInfo =>
    browserImportInfo(loadImportToken(ctx.db))
  )

  ipcMain.handle(IPC.regenerateImportToken, (): BrowserImportInfo =>
    browserImportInfo(regenerateImportToken(ctx.db))
  )

  ipcMain.handle(IPC.setImportTarget, (_event, target: ImportTarget): BrowserImportInfo => {
    const rootPath = ctx.library.currentRootPath
    if (rootPath !== null && (target === 'root' || target === 'imported')) {
      ctx.db.setSetting(importTargetKey(rootPath), target)
    }
    return browserImportInfo(loadImportToken(ctx.db))
  })
}
