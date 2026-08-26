import { create } from 'zustand'
import type {
  AppSettings,
  FolderNode,
  ImageQuery,
  ImageRecord,
  IndexProgress,
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

  scan: ScanProgress
  index: IndexProgress
  settingsOpen: boolean
  /** 未ダウンロードだったサムネイルを読み直させるための番号 */
  thumbEpoch: number
}

interface Actions {
  init(): Promise<void>
  openFolder(): Promise<void>
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

  return {
    root: null,
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
    scan: initialScan,
    index: { found: 0, scanning: false },
    settingsOpen: false,
    thumbEpoch: 0,

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

      window.api.onRootChanged((next) => {
        set({ root: next, dir: '', includeTags: [], excludeTags: [], images: {} })
        scheduleRefresh()
        void get().refreshTree()
      })

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
      window.api.onIndexProgress((indexProgress) => set({ index: indexProgress }))
      // マウスの「戻る」ボタン。単画像ビューを開いていれば一覧へ戻る
      window.api.onGoBack(() => {
        if (get().viewerIndex !== null) get().closeViewer()
      })
      window.api.onImageTagged(() => scheduleRefresh(TAGGED_DEBOUNCE))

      if (root) {
        await Promise.all([get().refreshTree(), get().refresh()])
        void get().refreshTags()
      }
    },

    async openFolder() {
      const root = await window.api.openFolder()
      if (!root) return
      set({
        root,
        dir: '',
        includeTags: [],
        excludeTags: [],
        images: {},
        ids: [],
        viewerIndex: null
      })
      await Promise.all([get().refreshTree(), get().refresh()])
      void get().refreshTags()
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
      set({ viewerIndex: null })
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
    }
  }
})
