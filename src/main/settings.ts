import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types'
import type { LibraryDb } from './db'

const KEY = 'app_settings'

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
    thumbnailSize: clamp(input.thumbnailSize as number, 96, 512, DEFAULT_SETTINGS.thumbnailSize),
    edgeClickRatio: clamp(input.edgeClickRatio as number, 0.05, 0.45, DEFAULT_SETTINGS.edgeClickRatio),
    sortKey: (['path', 'name', 'mtime', 'size'] as const).includes(input.sortKey as never)
      ? (input.sortKey as AppSettings['sortKey'])
      : DEFAULT_SETTINGS.sortKey,
    sortOrder: input.sortOrder === 'desc' ? 'desc' : 'asc'
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
      (key) => next[key] !== this.cache[key]
    )
    this.cache = next
    this.db.setSetting(KEY, JSON.stringify(next))
    return { settings: next, changed }
  }
}

/** ルートフォルダの復帰用。設定テーブルに直接持たせる。 */
export const LAST_ROOT_KEY = 'last_root_id'
