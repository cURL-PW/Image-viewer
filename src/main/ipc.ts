import path from 'node:path'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import {
  IPC,
  type AppSettings,
  type FolderNode,
  type ImageQuery,
  type ImageRecord,
  type ImageTag,
  type RootInfo,
  type ScanCommand,
  type ScanProgress,
  type TagInfo
} from '@shared/types'
import type { AppContext } from './context'
import { LAST_ROOT_KEY } from './settings'

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

export function registerIpcHandlers(ctx: AppContext): void {
  ipcMain.handle(IPC.openFolder, async (event): Promise<RootInfo | null> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = window
      ? await dialog.showOpenDialog(window, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return currentRoot(ctx)

    const rootId = await ctx.library.setRoot(result.filePaths[0])
    ctx.db.setSetting(LAST_ROOT_KEY, String(rootId))
    ctx.tagger.notifyLibraryChanged()
    return currentRoot(ctx)
  })

  ipcMain.handle(IPC.getRoot, (): RootInfo | null => currentRoot(ctx))

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
    // 解像度未取得ならこのタイミングで補完する
    if (image.width === null || image.height === null) {
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

  ipcMain.handle(IPC.getSettings, (): AppSettings => ctx.settings.get())

  ipcMain.handle(IPC.setSettings, async (_event, patch: Partial<AppSettings>): Promise<AppSettings> => {
    const { settings, changed } = ctx.settings.update(patch)

    if (changed.includes('thumbnailSize')) {
      ctx.thumbs.setSize(settings.thumbnailSize)
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
