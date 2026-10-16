import type {
  AppSettings,
  CloudDiagnostics,
  CopyKind,
  DebugLogInfo,
  FolderNode,
  ImageQuery,
  ImageRecord,
  ImageTag,
  LibraryInfo,
  IndexProgress,
  LibraryChange,
  RootInfo,
  SavedFilter,
  SavedFilterData,
  ScanCommand,
  TrashResult,
  ScanProgress,
  TagInfo
} from './types'

export interface ImageInfo {
  image: ImageRecord | null
  tags: ImageTag[]
}

export interface TagListRequest {
  query: ImageQuery
  keepTagIds: number[]
  search: string
  limit: number
}

/** preload が window.api として公開する API。renderer 側の型定義もこれを使う。 */
export interface RendererApi {
  openFolder(): Promise<RootInfo | null>
  getRoot(): Promise<RootInfo | null>
  /** 登録済みライブラリの一覧 */
  listLibraries(): Promise<LibraryInfo[]>
  /** 登録済みライブラリを開く。開けなければ今のルートを返す */
  switchLibrary(id: number): Promise<RootInfo | null>
  /** ライブラリの登録を外す (フォルダの中身は消さない)。切り替わった後のルートを返す */
  removeLibrary(id: number): Promise<RootInfo | null>
  getTree(): Promise<FolderNode | null>
  queryImages(query: ImageQuery): Promise<number[]>
  getImages(ids: number[]): Promise<ImageRecord[]>
  getImageInfo(id: number): Promise<ImageInfo>
  revealImage(id: number): Promise<void>
  /** 表示上の回転を記憶する (元ファイルは変えない)。保存した値を返す */
  setRotation(id: number, rotation: number): Promise<number>
  /** ウィンドウの全画面を切り替える。切り替え後の状態を返す */
  setFullScreen(fullScreen: boolean): Promise<boolean>
  /** お気に入りを付け外しする。今のライブラリの画像だけが対象 */
  setFavorite(ids: number[], favorite: boolean): Promise<void>
  /** 今のライブラリに保存した絞り込み条件 (保存順) */
  listSavedFilters(): Promise<SavedFilter[]>
  saveFilter(name: string, data: SavedFilterData): Promise<SavedFilter[]>
  renameSavedFilter(id: number, name: string): Promise<SavedFilter[]>
  deleteSavedFilter(id: number): Promise<SavedFilter[]>
  /** OS のごみ箱へ移す (完全削除はしない) */
  trashImages(ids: number[]): Promise<TrashResult>
  /** 複数画像のパスやファイル名を改行区切りでコピーする */
  copyText(ids: number[], kind: 'path' | 'name'): Promise<boolean>
  /** タグを手で足す。無いタグ名なら general として作る */
  addTag(ids: number[], name: string): Promise<void>
  /** タグを手で外す。付け直しでも戻らない */
  removeTag(ids: number[], tagId: number): Promise<void>
  /** 選択中の画像に付いているタグ (付いている枚数付き) */
  tagsForImages(ids: number[]): Promise<TagInfo[]>
  /** タグ名の補完候補 */
  suggestTags(text: string): Promise<string[]>
  /** OS の既定のアプリで開く */
  openImageExternal(id: number): Promise<void>
  /** 画像やパスをクリップボードへ入れる。入れるものが無ければ false */
  copyImage(id: number, kind: CopyKind): Promise<boolean>
  /** 実行中の OS (process.platform)。表示文言の出し分けに使う */
  platform: string
  listTags(request: TagListRequest): Promise<TagInfo[]>
  scanControl(command: ScanCommand): Promise<ScanProgress>
  /** 指定フォルダ配下をまとめてダウンロードし、タグ付けの対象へ戻す */
  downloadFolder(request: { dir: string; recursive: boolean }): Promise<void>
  cancelDownload(): Promise<void>
  /** クラウド判定の診断情報 (設定画面で表示する) */
  getDiagnostics(): Promise<CloudDiagnostics>
  /** デバッグログの状態 */
  getLogInfo(): Promise<DebugLogInfo>
  /** 末尾 n 行を読む (「直近をコピー」用) */
  readLogTail(lines: number): Promise<string>
  openLogFolder(): Promise<void>
  clearLog(): Promise<void>
  getScanProgress(): Promise<ScanProgress>
  getSettings(): Promise<AppSettings>
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>

  /** 各 on* は購読解除用の関数を返す。 */
  onLibraryChanged(listener: (change: LibraryChange) => void): () => void
  onScanProgress(listener: (progress: ScanProgress) => void): () => void
  onIndexProgress(listener: (progress: IndexProgress) => void): () => void
  onImageTagged(listener: (payload: { id: number }) => void): () => void
  onRootChanged(listener: (root: RootInfo | null) => void): () => void
  /** マウスの「戻る」ボタン。DOM のイベントが来ない構成のための保険 */
  onGoBack(listener: () => void): () => void
  /** 全画面の出入り (Esc や OS の操作で抜けた場合も来る) */
  onFullScreen(listener: (fullScreen: boolean) => void): () => void
}
