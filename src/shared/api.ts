import type {
  AppSettings,
  CloudDiagnostics,
  DebugLogInfo,
  FolderNode,
  ImageQuery,
  ImageRecord,
  ImageTag,
  LibraryInfo,
  IndexProgress,
  LibraryChange,
  RootInfo,
  ScanCommand,
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
}
