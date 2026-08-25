import type {
  AppSettings,
  FolderNode,
  ImageQuery,
  ImageRecord,
  ImageTag,
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
  getScanProgress(): Promise<ScanProgress>
  getSettings(): Promise<AppSettings>
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>

  /** 各 on* は購読解除用の関数を返す。 */
  onLibraryChanged(listener: (change: LibraryChange) => void): () => void
  onScanProgress(listener: (progress: ScanProgress) => void): () => void
  onIndexProgress(listener: (progress: IndexProgress) => void): () => void
  onImageTagged(listener: (payload: { id: number }) => void): () => void
  onRootChanged(listener: (root: RootInfo) => void): () => void
}
