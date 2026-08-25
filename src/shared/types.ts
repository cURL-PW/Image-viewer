/**
 * main / preload / renderer で共有する型定義。IPC の契約はここに集約する。
 */

/** WD14 の selected_tags.csv に準拠したカテゴリ番号。 */
export const TagCategory = {
  General: 0,
  Character: 4,
  Rating: 9
} as const
export type TagCategoryValue = (typeof TagCategory)[keyof typeof TagCategory]

export const SUPPORTED_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.bmp',
  '.avif',
  // iPhone / iCloud の既定形式。Chromium も sharp も直接は扱えないため
  // WASM 版 libheif で復号し、表示用に変換して配信する
  '.heic',
  '.heif'
] as const

export interface ImageRecord {
  id: number
  /** ルートフォルダからの相対パス (posix 区切り) */
  relPath: string
  /** 相対ディレクトリ。ルート直下は '' */
  dirPath: string
  fileName: string
  mtime: number
  size: number
  width: number | null
  height: number | null
  /** タグ付け済みのモデル ID。null なら未スキャン */
  scannedModel: string | null
  scanError: string | null
}

export interface FolderNode {
  /** 相対ディレクトリパス。ルートは '' */
  path: string
  name: string
  /** 配下 (再帰) の画像枚数 */
  count: number
  children: FolderNode[]
}

export interface TagInfo {
  id: number
  name: string
  category: number
  /** 現在のスコープ内での出現枚数 */
  count: number
}

export interface ImageTag {
  id: number
  name: string
  category: number
  confidence: number
}

export type SortKey = 'path' | 'name' | 'mtime' | 'size'
export type SortOrder = 'asc' | 'desc'
export type TagMode = 'and' | 'or'

export interface ImageQuery {
  /** 相対ディレクトリ。'' でルート全体 */
  dir: string
  recursive: boolean
  includeTags: number[]
  excludeTags: number[]
  tagMode: TagMode
  sortKey: SortKey
  sortOrder: SortOrder
}

export interface QueryResult {
  /** 絞り込み結果の画像 ID を表示順に並べたもの */
  ids: number[]
}

export interface RootInfo {
  id: number
  path: string
  /** 初回走査が完了しているか */
  indexed: boolean
}

/** 読み込み時間の記録。どの経路が遅いのかを診断で見せるために種別を持つ */
export type ReadKind = 'stat' | 'thumbnail' | 'display'

export interface ReadSample {
  kind: ReadKind
  ms: number
}

export interface PlaceholderSample {
  name: string
  size: number
  blocks: number
  verdict: boolean
}

/** 設定画面に出す診断情報。実機で何が起きているかを手作業なしで確認するためのもの */
export interface CloudDiagnostics {
  cloudMode: boolean
  reason: 'placeholder' | 'slow' | 'manual' | 'remembered' | null
  alwaysRead: boolean
  platform: string
  slowReadMs: number
  /** 直近の読み込み時間 (新しい順) */
  reads: ReadSample[]
  /** 直近のプレースホルダ判定 (新しい順) */
  placeholders: PlaceholderSample[]
}

export interface DownloadProgress {
  done: number
  total: number
  current: string | null
}

export interface ScanProgress {
  /** タグ付け済み枚数 */
  done: number
  /** タグ付け対象の総数 */
  total: number
  /** 現在処理中のファイル名 */
  current: string | null
  /** 使用中の実行プロバイダ */
  provider: string | null
  state: 'idle' | 'preparing' | 'running' | 'paused' | 'error'
  /** モデル準備 (ダウンロード) の進捗 0-1。準備中以外は null */
  modelProgress: number | null
  message: string | null
  /** クラウド同期フォルダとみなして自動読み込みを止めているか */
  cloudMode: boolean
  /** なぜクラウドモードに入ったか */
  cloudReason: 'placeholder' | 'slow' | 'manual' | 'remembered' | null
  /** 未ダウンロードとして飛ばした枚数 */
  notDownloaded: number
  /** 一括ダウンロードの進捗。実行していないときは null */
  download: DownloadProgress | null
}

export interface IndexProgress {
  /** ファイル走査で見つかった枚数 */
  found: number
  scanning: boolean
}

export interface LibraryChange {
  added: number[]
  updated: number[]
  removed: number[]
  /** フォルダ構成が変わったので再取得が必要 */
  treeDirty: boolean
}

export interface AppSettings {
  /** Hugging Face のリポジトリ ID */
  modelId: string
  generalThreshold: number
  characterThreshold: number
  /** 'auto' は CUDA → DirectML → CPU の順に試行 */
  provider: 'auto' | 'cpu'
  autoScan: boolean
  /** クラウド同期フォルダの未ダウンロード写真も自動で読み込む (既定は読み込まない) */
  alwaysReadCloudFiles: boolean
  thumbnailSize: number
  /** 画像左右のページ送りクリック領域の比率 (0-0.5) */
  edgeClickRatio: number
  sortKey: SortKey
  sortOrder: SortOrder
}

export const DEFAULT_SETTINGS: AppSettings = {
  modelId: 'SmilingWolf/wd-eva02-large-tagger-v3',
  generalThreshold: 0.35,
  characterThreshold: 0.85,
  provider: 'auto',
  autoScan: true,
  alwaysReadCloudFiles: false,
  thumbnailSize: 256,
  edgeClickRatio: 0.25,
  sortKey: 'path',
  sortOrder: 'asc'
}

export const AVAILABLE_MODELS = [
  { id: 'SmilingWolf/wd-eva02-large-tagger-v3', label: 'EVA02 Large v3 (精度重視)' },
  { id: 'SmilingWolf/wd-vit-large-tagger-v3', label: 'ViT Large v3' },
  { id: 'SmilingWolf/wd-swinv2-tagger-v3', label: 'SwinV2 v3 (バランス)' },
  { id: 'SmilingWolf/wd-vit-tagger-v3', label: 'ViT v3 (速度重視)' },
  { id: 'SmilingWolf/wd-convnext-tagger-v3', label: 'ConvNeXt v3' }
] as const

/** IPC チャンネル名 */
export const IPC = {
  openFolder: 'library:openFolder',
  getRoot: 'library:getRoot',
  getTree: 'library:getTree',
  queryImages: 'library:queryImages',
  getImages: 'library:getImages',
  getImageInfo: 'library:getImageInfo',
  revealImage: 'library:revealImage',
  listTags: 'tags:list',
  scanControl: 'scan:control',
  getScanProgress: 'scan:getProgress',
  downloadFolder: 'library:downloadFolder',
  cancelDownload: 'library:cancelDownload',
  getDiagnostics: 'cloud:getDiagnostics',
  getSettings: 'settings:get',
  setSettings: 'settings:set',
  // main → renderer
  eventLibraryChanged: 'event:libraryChanged',
  eventScanProgress: 'event:scanProgress',
  eventIndexProgress: 'event:indexProgress',
  eventImageTagged: 'event:imageTagged',
  eventRootChanged: 'event:rootChanged'
} as const

export type ScanCommand = 'pause' | 'resume' | 'rescanAll' | 'retryErrors'

export const IMAGE_PROTOCOL = 'app-image'
export const THUMB_PROTOCOL = 'app-thumb'

export function imageUrl(image: Pick<ImageRecord, 'id' | 'mtime'>): string {
  return `${IMAGE_PROTOCOL}://img/${image.id}?v=${image.mtime}`
}

/**
 * サムネイルの URL。
 * `epoch` は、未ダウンロードだったものが落ちてきたときに <img> を読み直させるための番号。
 * (雲タイルを表示済みの img は、URL が変わらない限り再要求しない)
 */
export function thumbUrl(image: Pick<ImageRecord, 'id' | 'mtime'>, epoch = 0): string {
  const suffix = epoch > 0 ? `&e=${epoch}` : ''
  return `${THUMB_PROTOCOL}://img/${image.id}?v=${image.mtime}${suffix}`
}
