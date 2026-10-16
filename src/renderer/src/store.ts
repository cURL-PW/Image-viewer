import { create } from 'zustand'
import { normalizeRotation } from '@shared/types'
import type {
  AppSettings,
  FolderNode,
  ImageQuery,
  ImageRecord,
  IndexProgress,
  LibraryInfo,
  RootInfo,
  ScanProgress,
  SortKey,
  SortOrder,
  TagInfo,
  TagMode
} from '@shared/types'

/** ライブラリ変更後の再クエリをまとめるための待ち時間 (ms) */
const REQUERY_DEBOUNCE = 250
/**
 * タグ付け完了通知は画像 1 枚ごとに飛んでくる。表示中の一覧が丸ごと入れ替わる
 * ほどの変化ではないので、ライブラリ変更よりも長い間隔でまとめる。
 */
const TAGGED_DEBOUNCE = 1200

interface State {
  root: RootInfo | null
  /** 登録済みライブラリ */
  libraries: LibraryInfo[]
  tree: FolderNode | null
  settings: AppSettings | null

  dir: string
  recursive: boolean
  includeTags: number[]
  excludeTags: number[]
  tagMode: TagMode
  sortKey: SortKey
  sortOrder: SortOrder

  /** 絞り込み結果の画像 ID を表示順に並べたもの */
  ids: number[]
  /** 取得済みの画像メタデータ */
  images: Record<number, ImageRecord>
  loading: boolean

  tags: TagInfo[]
  tagSearch: string

  /** null ならグリッド表示、数値ならその位置の画像を単画像表示 */
  viewerIndex: number | null
  /** 最後に単画像ビューで見ていた位置。一覧へ戻ったとき、その画像が見えるようにする */
  lastViewedIndex: number | null

  scan: ScanProgress
  index: IndexProgress
  settingsOpen: boolean
  /** 未ダウンロードだったサムネイルを読み直させるための番号 */
  thumbEpoch: number
  /** 画像の右クリックメニュー */
  contextMenu: ContextMenuState | null
  /** 画面下に一瞬だけ出す通知 (「コピーしました」など) */
  notice: { text: string; key: number } | null
  /** ウィンドウが全画面か。main からの通知で合わせる */
  fullScreen: boolean
}

export interface ContextMenuState {
  /** 表示位置 (クライアント座標) */
  x: number
  y: number
  /** 対象の画像 ID。一覧が入れ替わっても取り違えないよう、位置ではなく ID で持つ */
  id: number
}

interface Actions {
  init(): Promise<void>
  openFolder(): Promise<void>
  switchLibrary(id: number): Promise<void>
  removeLibrary(id: number): Promise<void>
  refreshLibraries(): Promise<void>
  setDir(dir: string): void
  setRecursive(recursive: boolean): void
  setSort(sortKey: SortKey, sortOrder: SortOrder): void
  toggleInclude(tagId: number): void
  toggleExclude(tagId: number): void
  clearTags(): void
  setTagMode(mode: TagMode): void
  setTagSearch(search: string): void
  refresh(): Promise<void>
  refreshTree(): Promise<void>
  refreshTags(): Promise<void>
  ensureImages(ids: number[]): Promise<void>
  openViewer(index: number): void
  closeViewer(): void
  step(delta: number): void
  goTo(index: number): void
  updateSettings(patch: Partial<AppSettings>): Promise<void>
  setSettingsOpen(open: boolean): void
  openContextMenu(menu: ContextMenuState): void
  closeContextMenu(): void
  showNotice(text: string): void
  setFullScreen(fullScreen: boolean): Promise<void>
  /** 表示上の回転を 90° 単位で変える (正で時計回り)。DB に記憶し、サムネイルにも反映する */
  rotate(id: number, delta: number): Promise<void>
}

const initialScan: ScanProgress = {
  done: 0,
  total: 0,
  current: null,
  provider: null,
  state: 'idle',
  modelProgress: null,
  message: null,
  cloudFolder: false,
  cloudBlocked: false,
  cloudReason: null,
  notDownloaded: 0,
  download: null
}

export const useStore = create<State & Actions>((set, get) => {
  let requeryTimer: ReturnType<typeof setTimeout> | null = null
  // 非同期の応答が追い越されたときに、古い結果で上書きしないための世代番号
  let queryToken = 0
  let tagToken = 0
  let treeToken = 0
  // StrictMode では effect が 2 回走るため、購読の二重登録を防ぐ
  let initStarted = false
  const inFlightImages = new Set<number>()

  /** 連続する変更をまとめて 1 回だけ再クエリする。先に入っている予約を優先する。 */
  const scheduleRefresh = (delay = REQUERY_DEBOUNCE): void => {
    if (requeryTimer) return
    requeryTimer = setTimeout(() => {
      requeryTimer = null
      void get().refresh()
      void get().refreshTags()
    }, delay)
  }

  const currentQuery = (): ImageQuery => {
    const state = get()
    return {
      dir: state.dir,
      recursive: state.recursive,
      includeTags: state.includeTags,
      excludeTags: state.excludeTags,
      tagMode: state.tagMode,
      sortKey: state.sortKey,
      sortOrder: state.sortOrder
    }
  }

  let libraryToken = 0

  /** 開いているライブラリが変わったときに、絞り込みと表示を初期状態へ戻して読み直す。 */
  const applyRoot = async (root: RootInfo | null): Promise<void> => {
    // 同じライブラリを選び直したときは、絞り込みを保つ
    if (root !== null && root.id === get().root?.id) {
      set({ root })
      void get().refreshLibraries()
      return
    }
    set({
      root,
      dir: '',
      includeTags: [],
      excludeTags: [],
      images: {},
      ids: [],
      tags: [],
      viewerIndex: null,
      lastViewedIndex: null,
      ...(root ? {} : { tree: null })
    })
    void get().refreshLibraries()
    if (!root) return
    await Promise.all([get().refreshTree(), get().refresh()])
    void get().refreshTags()
  }

  return {
    root: null,
    libraries: [],
    tree: null,
    settings: null,
    dir: '',
    recursive: true,
    includeTags: [],
    excludeTags: [],
    tagMode: 'and',
    sortKey: 'path',
    sortOrder: 'asc',
    ids: [],
    images: {},
    loading: false,
    tags: [],
    tagSearch: '',
    viewerIndex: null,
    lastViewedIndex: null,
    scan: initialScan,
    index: { found: 0, scanning: false },
    settingsOpen: false,
    thumbEpoch: 0,
    contextMenu: null,
    notice: null,
    fullScreen: false,

    async init() {
      if (initStarted) return
      initStarted = true

      const [root, settings, scan] = await Promise.all([
        window.api.getRoot(),
        window.api.getSettings(),
        window.api.getScanProgress()
      ])
      set({
        root,
        settings,
        scan,
        sortKey: settings.sortKey,
        sortOrder: settings.sortOrder
      })

      window.api.onRootChanged((next) => void applyRoot(next))

      window.api.onLibraryChanged((change) => {
        // 削除された画像はキャッシュから落とす
        if (change.removed.length > 0 || change.updated.length > 0) {
          set((state) => {
            const images = { ...state.images }
            for (const id of change.removed) delete images[id]
            for (const id of change.updated) delete images[id]
            return { images }
          })
        }
        if (change.treeDirty) void get().refreshTree()
        scheduleRefresh()
      })

      window.api.onScanProgress((scanProgress) => {
        const previous = get().scan
        // 一括ダウンロードが終わった / クラウドモードが解けたときは、
        // 雲タイルのまま止まっているサムネイルを読み直す
        const downloadFinished = previous.download !== null && scanProgress.download === null
        const cloudCleared = previous.cloudBlocked && !scanProgress.cloudBlocked
        set((state) => ({
          scan: scanProgress,
          thumbEpoch: downloadFinished || cloudCleared ? state.thumbEpoch + 1 : state.thumbEpoch
        }))
      })
      window.api.onIndexProgress((indexProgress) => {
        // 走査が終わったら一覧の枚数を更新する
        if (get().index.scanning && !indexProgress.scanning) void get().refreshLibraries()
        set({ index: indexProgress })
      })
      // マウスの「戻る」ボタン。単画像ビューを開いていれば一覧へ戻る
      window.api.onGoBack(() => {
        if (get().viewerIndex !== null) get().closeViewer()
      })
      window.api.onImageTagged(() => scheduleRefresh(TAGGED_DEBOUNCE))
      window.api.onFullScreen((fullScreen) => set({ fullScreen }))

      void get().refreshLibraries()
      if (root) {
        await Promise.all([get().refreshTree(), get().refresh()])
        void get().refreshTags()
      }
    },

    async openFolder() {
      const root = await window.api.openFolder()
      if (!root) return
      await applyRoot(root)
    },

    async switchLibrary(id) {
      if (get().root?.id === id) return
      const root = await window.api.switchLibrary(id)
      if (root?.id !== id) {
        // 開けなかった (フォルダが見つからない等)。表示だけ最新にする
        void get().refreshLibraries()
        return
      }
      await applyRoot(root)
    },

    async removeLibrary(id) {
      await applyRoot(await window.api.removeLibrary(id))
    },

    async refreshLibraries() {
      const token = ++libraryToken
      const libraries = await window.api.listLibraries()
      if (token !== libraryToken) return
      set({ libraries })
    },

    setDir(dir) {
      set({ dir, viewerIndex: null })
      void get().refresh()
      void get().refreshTags()
    },

    setRecursive(recursive) {
      set({ recursive, viewerIndex: null })
      void get().refresh()
      void get().refreshTags()
    },

    setSort(sortKey, sortOrder) {
      set({ sortKey, sortOrder })
      void window.api.setSettings({ sortKey, sortOrder })
      void get().refresh()
    },

    toggleInclude(tagId) {
      const { includeTags, excludeTags } = get()
      set({
        includeTags: includeTags.includes(tagId)
          ? includeTags.filter((id) => id !== tagId)
          : [...includeTags, tagId],
        excludeTags: excludeTags.filter((id) => id !== tagId),
        viewerIndex: null
      })
      void get().refresh()
      void get().refreshTags()
    },

    toggleExclude(tagId) {
      const { includeTags, excludeTags } = get()
      set({
        excludeTags: excludeTags.includes(tagId)
          ? excludeTags.filter((id) => id !== tagId)
          : [...excludeTags, tagId],
        includeTags: includeTags.filter((id) => id !== tagId),
        viewerIndex: null
      })
      void get().refresh()
      void get().refreshTags()
    },

    clearTags() {
      set({ includeTags: [], excludeTags: [], viewerIndex: null })
      void get().refresh()
      void get().refreshTags()
    },

    setTagMode(tagMode) {
      set({ tagMode, viewerIndex: null })
      void get().refresh()
      void get().refreshTags()
    },

    setTagSearch(tagSearch) {
      set({ tagSearch })
      void get().refreshTags()
    },

    async refresh() {
      if (!get().root) return
      const token = ++queryToken
      set({ loading: true })
      const ids = await window.api.queryImages(currentQuery())
      if (token !== queryToken) return // 新しいクエリに追い越された

      // 表示中の画像が結果から消えた場合は近い位置へ寄せる
      const state = get()
      let viewerIndex = state.viewerIndex
      if (viewerIndex !== null) {
        const currentId = state.ids[viewerIndex]
        const moved = ids.indexOf(currentId)
        viewerIndex = moved !== -1 ? moved : Math.min(viewerIndex, ids.length - 1)
        if (ids.length === 0) viewerIndex = null
      }
      set({ ids, loading: false, viewerIndex })
    },

    async refreshTree() {
      const token = ++treeToken
      const tree = await window.api.getTree()
      if (token !== treeToken) return
      set({ tree })
    },

    async refreshTags() {
      if (!get().root) return
      const state = get()
      const token = ++tagToken
      const tags = await window.api.listTags({
        query: currentQuery(),
        keepTagIds: [...state.includeTags, ...state.excludeTags],
        search: state.tagSearch,
        limit: 300
      })
      if (token !== tagToken) return
      set({ tags })
    },

    async ensureImages(ids) {
      const { images } = get()
      const missing = ids.filter((id) => !images[id] && !inFlightImages.has(id))
      if (missing.length === 0) return
      for (const id of missing) inFlightImages.add(id)

      try {
        const records = await window.api.getImages(missing)
        set((state) => {
          const next = { ...state.images }
          for (const record of records) next[record.id] = record
          return { images: next }
        })
      } finally {
        for (const id of missing) inFlightImages.delete(id)
      }
    },

    openViewer(index) {
      const { ids } = get()
      if (index < 0 || index >= ids.length) return
      set({ viewerIndex: index })
    },

    closeViewer() {
      set({ viewerIndex: null, lastViewedIndex: get().viewerIndex })
    },

    step(delta) {
      const { viewerIndex, ids } = get()
      if (viewerIndex === null || ids.length === 0) return
      const next = viewerIndex + delta
      if (next < 0 || next >= ids.length) return
      set({ viewerIndex: next })
    },

    goTo(index) {
      const { ids } = get()
      if (ids.length === 0) return
      set({ viewerIndex: Math.min(Math.max(index, 0), ids.length - 1) })
    },

    async updateSettings(patch) {
      const settings = await window.api.setSettings(patch)
      set({ settings })
    },

    setSettingsOpen(settingsOpen) {
      set({ settingsOpen })
    },

    openContextMenu(contextMenu) {
      set({ contextMenu })
    },

    closeContextMenu() {
      if (get().contextMenu !== null) set({ contextMenu: null })
    },

    showNotice(text) {
      set({ notice: { text, key: Date.now() } })
    },

    async setFullScreen(fullScreen) {
      set({ fullScreen: await window.api.setFullScreen(fullScreen) })
    },

    async rotate(id, delta) {
      const current = get().images[id]
      if (!current) return
      const target = normalizeRotation(current.rotation + delta * 90)
      // 先に表示へ反映し、保存は後から追いかける (ボタンの反応を待たせない)
      set((state) => ({ images: { ...state.images, [id]: { ...current, rotation: target } } }))
      const saved = await window.api.setRotation(id, target)
      if (saved !== target) {
        set((state) => {
          const image = state.images[id]
          return image ? { images: { ...state.images, [id]: { ...image, rotation: saved } } } : {}
        })
      }
    }
  }
})
