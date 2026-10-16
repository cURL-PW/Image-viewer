import { create } from 'zustand'
import {
  THUMBNAIL_SIZE_DEFAULT,
  THUMBNAIL_SIZE_STEP,
  clampThumbnailSize,
  normalizeRotation
} from '@shared/types'
import type {
  AppSettings,
  FolderNode,
  ImageQuery,
  ImageRecord,
  IndexProgress,
  LibraryInfo,
  RootInfo,
  SavedFilter,
  SavedFilterData,
  ScanProgress,
  SortKey,
  SortOrder,
  TagInfo,
  TagMode
} from '@shared/types'

/** 選択を解除した状態。フォルダや絞り込みを切り替えたときに使う */
const NO_SELECTION = { selection: [] as number[], selectionAnchor: null as number | null }
/** フォルダや絞り込みを切り替えたときの共通の後始末。選択を解除し、似た画像の表示もやめる */
const RESET_VIEW = { ...NO_SELECTION, similarTo: null as number | null }

/** サムネイルの大きさを変えてから保存するまでの待ち時間 (ms)。続けて回したときに 1 回で済ませる */
const THUMB_SAVE_DEBOUNCE = 300
/** ファイル名検索の入力が止まってから絞り込むまでの待ち時間 (ms) */
const SEARCH_DEBOUNCE = 300
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
  /** ファイル名・パスの検索語 (入力欄の値) */
  search: string
  favoritesOnly: boolean
  /** 今のライブラリに保存した絞り込み条件 */
  savedFilters: SavedFilter[]

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
  /** グリッドで選択中の画像 ID (選んだ順) */
  selection: number[]
  /** Shift クリックの範囲選択の起点 (画像 ID) */
  selectionAnchor: number | null
  /** 手動タグを変えるたびに増やす。単画像ビューのタグ欄を読み直させるため */
  tagsVersion: number
  /** 似た画像を表示中なら、元の画像の ID。フォルダや絞り込みを変えると解除する */
  similarTo: number | null
}

/** グリッドのクリックでの選択のしかた */
export type SelectMode = 'replace' | 'toggle' | 'range' | 'rangeAdd' | 'anchor'

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
  /** ファイル名・パス検索。入力が止まってから絞り込む */
  setSearch(search: string): void
  setFavoritesOnly(favoritesOnly: boolean): void
  /** お気に入りを付け外しする (複数可) */
  setFavorite(ids: number[], favorite: boolean): Promise<void>
  refreshSavedFilters(): Promise<void>
  /** 今の条件を名前を付けて保存する */
  saveFilter(name: string): Promise<void>
  /** 保存した条件を当てる。フォルダは今のまま */
  applySavedFilter(filter: SavedFilter): void
  renameSavedFilter(id: number, name: string): Promise<void>
  deleteSavedFilter(id: number): Promise<void>
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
  select(id: number, mode: SelectMode): void
  selectAll(): void
  clearSelection(): void
  /** ごみ箱へ移す (確認は呼び出し側で行う) */
  trashImages(ids: number[]): Promise<void>
  addTag(ids: number[], name: string): Promise<void>
  removeTag(ids: number[], tagId: number): Promise<void>
  /**
   * サムネイルの大きさを段階的に変える (Ctrl + ホイール / Ctrl + - 0)。
   * 正で大きく、負で小さく、0 で既定に戻す。表示はすぐ変え、保存は少し遅らせてまとめる
   */
  zoomThumbnails(delta: number): void
  /** ライブラリ全体から、タグの似ている画像を似ている順に並べる */
  showSimilar(id: number): void
  /** 似た画像の表示をやめ、元の絞り込みに戻る */
  exitSimilar(): void
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
  let searchTimer: ReturnType<typeof setTimeout> | null = null
  let thumbSaveTimer: ReturnType<typeof setTimeout> | null = null
  /** クエリに使う検索語。入力欄の値 (state.search) から遅れて追いつく */
  let appliedSearch = ''
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
      sortOrder: state.sortOrder,
      search: appliedSearch,
      favoritesOnly: state.favoritesOnly
    }
  }

  const cancelSearchTimer = (): void => {
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = null
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
    cancelSearchTimer()
    appliedSearch = ''
    set({
      root,
      dir: '',
      includeTags: [],
      excludeTags: [],
      search: '',
      favoritesOnly: false,
      savedFilters: [],
      images: {},
      ids: [],
      tags: [],
      viewerIndex: null,
      ...RESET_VIEW,
      lastViewedIndex: null,
      ...(root ? {} : { tree: null })
    })
    void get().refreshLibraries()
    if (!root) return
    void get().refreshSavedFilters()
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
    search: '',
    favoritesOnly: false,
    savedFilters: [],
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
    selection: [],
    selectionAnchor: null,
    tagsVersion: 0,
    similarTo: null,

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
      // 単画像ビューではサムネイルが見えないので何もしない
      window.api.onThumbZoom((delta) => {
        if (get().viewerIndex === null) get().zoomThumbnails(delta)
      })

      void get().refreshLibraries()
      if (root) {
        void get().refreshSavedFilters()
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
      set({ dir, viewerIndex: null, ...RESET_VIEW })
      void get().refresh()
      void get().refreshTags()
    },

    setRecursive(recursive) {
      set({ recursive, viewerIndex: null, ...RESET_VIEW })
      void get().refresh()
      void get().refreshTags()
    },

    setSort(sortKey, sortOrder) {
      set({ sortKey, sortOrder, similarTo: null })
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
        viewerIndex: null,
        ...RESET_VIEW
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
        viewerIndex: null,
        ...RESET_VIEW
      })
      void get().refresh()
      void get().refreshTags()
    },

    clearTags() {
      set({ includeTags: [], excludeTags: [], viewerIndex: null, ...RESET_VIEW })
      void get().refresh()
      void get().refreshTags()
    },

    setTagMode(tagMode) {
      set({ tagMode, viewerIndex: null, ...RESET_VIEW })
      void get().refresh()
      void get().refreshTags()
    },

    setTagSearch(tagSearch) {
      set({ tagSearch })
      void get().refreshTags()
    },

    setSearch(search) {
      set({ search })
      cancelSearchTimer()
      searchTimer = setTimeout(() => {
        searchTimer = null
        if (appliedSearch === search) return
        appliedSearch = search
        set({ viewerIndex: null, ...RESET_VIEW })
        void get().refresh()
      }, SEARCH_DEBOUNCE)
    },

    setFavoritesOnly(favoritesOnly) {
      set({ favoritesOnly, viewerIndex: null, ...RESET_VIEW })
      void get().refresh()
    },

    async setFavorite(ids, favorite) {
      if (ids.length === 0) return
      // 先に表示へ反映する
      set((state) => {
        const images = { ...state.images }
        for (const id of ids) {
          const image = images[id]
          if (image) images[id] = { ...image, favorite }
        }
        return { images }
      })
      await window.api.setFavorite(ids, favorite)
      // お気に入りだけを表示中なら、外したものが一覧から消える。
      // 単画像ビューで見ている 1 枚は refresh が近くの画像へ寄せる
      if (get().favoritesOnly) void get().refresh()
    },

    async refreshSavedFilters() {
      set({ savedFilters: await window.api.listSavedFilters() })
    },

    async saveFilter(name) {
      const state = get()
      const data: SavedFilterData = {
        includeTags: state.includeTags,
        excludeTags: state.excludeTags,
        tagMode: state.tagMode,
        search: state.search,
        favoritesOnly: state.favoritesOnly,
        sortKey: state.sortKey,
        sortOrder: state.sortOrder
      }
      set({ savedFilters: await window.api.saveFilter(name, data) })
    },

    applySavedFilter(filter) {
      const { data } = filter
      cancelSearchTimer()
      appliedSearch = data.search
      set({
        includeTags: data.includeTags,
        excludeTags: data.excludeTags,
        tagMode: data.tagMode,
        search: data.search,
        favoritesOnly: data.favoritesOnly,
        sortKey: data.sortKey,
        sortOrder: data.sortOrder,
        viewerIndex: null,
        ...RESET_VIEW
      })
      void window.api.setSettings({ sortKey: data.sortKey, sortOrder: data.sortOrder })
      void get().refresh()
      void get().refreshTags()
    },

    async renameSavedFilter(id, name) {
      set({ savedFilters: await window.api.renameSavedFilter(id, name) })
    },

    async deleteSavedFilter(id) {
      set({ savedFilters: await window.api.deleteSavedFilter(id) })
    },

    async refresh() {
      if (!get().root) return
      const token = ++queryToken
      set({ loading: true })
      const { similarTo } = get()
      const ids =
        similarTo !== null
          ? await window.api.findSimilar(similarTo)
          : await window.api.queryImages(currentQuery())
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

    select(id, mode) {
      const { ids, selection, selectionAnchor } = get()
      if (mode === 'replace') {
        set({ selection: [id], selectionAnchor: id })
        return
      }
      // 選択は解除し、次の Shift クリックの起点だけ覚える (修飾キー無しのクリック)
      if (mode === 'anchor') {
        set({ selection: [], selectionAnchor: id })
        return
      }
      if (mode === 'toggle') {
        set({
          selection: selection.includes(id)
            ? selection.filter((selected) => selected !== id)
            : [...selection, id],
          selectionAnchor: id
        })
        return
      }
      // 範囲選択。起点が無い (または一覧から消えた) ときはその 1 枚から
      const to = ids.indexOf(id)
      const from = selectionAnchor !== null ? ids.indexOf(selectionAnchor) : -1
      if (to === -1) return
      const start = from === -1 ? to : Math.min(from, to)
      const end = from === -1 ? to : Math.max(from, to)
      const range = ids.slice(start, end + 1)
      const merged =
        mode === 'rangeAdd' ? [...selection, ...range.filter((r) => !selection.includes(r))] : range
      // 起点は動かさない (続けて Shift クリックすると同じ起点から選び直す)
      set({ selection: merged, selectionAnchor: from === -1 ? id : selectionAnchor })
    },

    selectAll() {
      set({ selection: [...get().ids], selectionAnchor: get().ids[0] ?? null })
    },

    clearSelection() {
      if (get().selection.length > 0) set(NO_SELECTION)
    },

    async trashImages(ids) {
      if (ids.length === 0) return
      const result = await window.api.trashImages(ids)
      const removed = new Set(result.trashed)
      if (removed.size > 0) {
        // 監視の通知を待たずに一覧から外す。単画像ビューで見ていた 1 枚が消えたら、
        // 同じ位置 (= 次の画像)、末尾だったら前の画像、無くなればグリッドへ
        set((state) => {
          const nextIds = state.ids.filter((id) => !removed.has(id))
          let viewerIndex = state.viewerIndex
          if (viewerIndex !== null) {
            const currentId = state.ids[viewerIndex]
            const kept = nextIds.indexOf(currentId)
            if (nextIds.length === 0) viewerIndex = null
            else viewerIndex = kept !== -1 ? kept : Math.min(viewerIndex, nextIds.length - 1)
          }
          return {
            ids: nextIds,
            viewerIndex,
            selection: state.selection.filter((id) => !removed.has(id))
          }
        })
        void get().refresh()
        void get().refreshTree()
        void get().refreshTags()
        void get().refreshLibraries()
      }
      if (result.failed > 0) {
        get().showNotice(`${result.failed} 枚をごみ箱へ移動できませんでした`)
      } else if (removed.size > 1) {
        get().showNotice(`${removed.size} 枚をごみ箱へ移動しました`)
      }
    },

    async addTag(ids, name) {
      if (ids.length === 0 || name.trim() === '') return
      await window.api.addTag(ids, name)
      set((state) => ({ tagsVersion: state.tagsVersion + 1 }))
      void get().refreshTags()
      if (get().includeTags.length > 0 || get().excludeTags.length > 0) void get().refresh()
    },

    async removeTag(ids, tagId) {
      if (ids.length === 0) return
      await window.api.removeTag(ids, tagId)
      set((state) => ({ tagsVersion: state.tagsVersion + 1 }))
      void get().refreshTags()
      if (get().includeTags.length > 0 || get().excludeTags.length > 0) void get().refresh()
    },

    showSimilar(id) {
      set({ similarTo: id, viewerIndex: null, lastViewedIndex: null, ...NO_SELECTION })
      void get().refresh()
    },

    exitSimilar() {
      if (get().similarTo === null) return
      set({ similarTo: null, viewerIndex: null, lastViewedIndex: null, ...NO_SELECTION })
      void get().refresh()
    },

    zoomThumbnails(delta) {
      const { settings } = get()
      if (!settings) return
      const next =
        delta === 0
          ? THUMBNAIL_SIZE_DEFAULT
          : clampThumbnailSize(settings.thumbnailSize + delta * THUMBNAIL_SIZE_STEP)
      if (next === settings.thumbnailSize) return
      set({ settings: { ...settings, thumbnailSize: next } })
      if (thumbSaveTimer) clearTimeout(thumbSaveTimer)
      thumbSaveTimer = setTimeout(() => {
        thumbSaveTimer = null
        void window.api.setSettings({ thumbnailSize: get().settings?.thumbnailSize ?? next })
      }, THUMB_SAVE_DEBOUNCE)
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
