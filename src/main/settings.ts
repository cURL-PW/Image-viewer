import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types'
import { generateToken } from './import-server'
import type { LibraryDb } from './db'

const KEY = 'app_settings'
/** 除外タグの登録上限。設定ファイルが壊れていても膨らみすぎないように */
const MAX_EXCLUDE_TAGS = 500
const MAX_PATTERN_LENGTH = 500

function normalizePatterns(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  return input
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value !== '' && value.length <= MAX_PATTERN_LENGTH)
    .slice(0, MAX_EXCLUDE_TAGS)
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/** 保存値は信用せず、範囲外・型違いは既定値へ丸める。 */
export function normalizeSettings(input: Partial<AppSettings>): AppSettings {
  return {
    modelId: typeof input.modelId === 'string' && input.modelId ? input.modelId : DEFAULT_SETTINGS.modelId,
    generalThreshold: clamp(input.generalThreshold as number, 0.05, 0.95, DEFAULT_SETTINGS.generalThreshold),
    characterThreshold: clamp(input.characterThreshold as number, 0.05, 0.99, DEFAULT_SETTINGS.characterThreshold),
    provider: input.provider === 'cpu' ? 'cpu' : 'auto',
    autoScan: input.autoScan !== false,
    alwaysReadCloudFiles: input.alwaysReadCloudFiles === true,
    // ファイルパスが残るので既定では無効。調査するときだけ設定か環境変数で入れる
    debugLog: input.debugLog === true,
    thumbnailSize: clamp(input.thumbnailSize as number, 96, 512, DEFAULT_SETTINGS.thumbnailSize),
    edgeClickRatio: clamp(input.edgeClickRatio as number, 0.05, 0.45, DEFAULT_SETTINGS.edgeClickRatio),
    sortKey: (['path', 'name', 'mtime', 'size'] as const).includes(input.sortKey as never)
      ? (input.sortKey as AppSettings['sortKey'])
      : DEFAULT_SETTINGS.sortKey,
    sortOrder: input.sortOrder === 'desc' ? 'desc' : 'asc',
    // 正規表現として壊れているものも残す (設定画面で直せるように)。照合時に無視する
    copyExcludeTags: normalizePatterns(input.copyExcludeTags),
    browserImport: input.browserImport === true,
    // 1024 未満は OS によって管理者権限が要るので使わせない
    browserImportPort: Math.round(
      clamp(input.browserImportPort as number, 1024, 65535, DEFAULT_SETTINGS.browserImportPort)
    )
  }
}

export class SettingsStore {
  private cache: AppSettings

  constructor(private db: LibraryDb) {
    this.cache = this.load()
  }

  private load(): AppSettings {
    const raw = this.db.getSetting(KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    try {
      return normalizeSettings(JSON.parse(raw) as Partial<AppSettings>)
    } catch {
      return { ...DEFAULT_SETTINGS }
    }
  }

  get(): AppSettings {
    return this.cache
  }

  /** 変更を保存し、変わった項目のキー一覧を返す。 */
  update(patch: Partial<AppSettings>): { settings: AppSettings; changed: (keyof AppSettings)[] } {
    const next = normalizeSettings({ ...this.cache, ...patch })
    const changed = (Object.keys(next) as (keyof AppSettings)[]).filter(
      // 配列の項目もあるので中身で比べる
      (key) => JSON.stringify(next[key]) !== JSON.stringify(this.cache[key])
    )
    this.cache = next
    this.db.setSetting(KEY, JSON.stringify(next))
    return { settings: next, changed }
  }
}

/** ルートフォルダの復帰用。設定テーブルに直接持たせる。 */
export const LAST_ROOT_KEY = 'last_root_id'

/** ブラウザ拡張の合言葉。設定 (AppSettings) とは分け、renderer へ配る設定に混ぜない */
const IMPORT_TOKEN_KEY = 'browser_import_token'

/** 保存済みの合言葉を返す。無ければ作って保存する */
export function loadImportToken(db: LibraryDb): string {
  const saved = db.getSetting(IMPORT_TOKEN_KEY)
  if (saved) return saved
  return regenerateImportToken(db)
}

export function regenerateImportToken(db: LibraryDb): string {
  const token = generateToken()
  db.setSetting(IMPORT_TOKEN_KEY, token)
  return token
}
