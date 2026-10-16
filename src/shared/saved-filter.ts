import type { SavedFilterData } from './types'

const SORT_KEYS = ['path', 'name', 'mtime', 'size'] as const

/**
 * 保存した絞り込み条件を、決まった形に揃える。
 * renderer から来た値や、DB に残っていた古い形の値をそのまま信用しないために使う
 */
export function sanitizeFilterData(
  input: Partial<SavedFilterData> | null | undefined
): SavedFilterData {
  const ids = (value: unknown): number[] =>
    Array.isArray(value) ? value.filter((id): id is number => Number.isInteger(id)) : []
  const data = input ?? {}
  return {
    includeTags: ids(data.includeTags),
    excludeTags: ids(data.excludeTags),
    tagMode: data.tagMode === 'or' ? 'or' : 'and',
    search: typeof data.search === 'string' ? data.search.slice(0, 500) : '',
    favoritesOnly: data.favoritesOnly === true,
    sortKey: SORT_KEYS.includes(data.sortKey as (typeof SORT_KEYS)[number])
      ? (data.sortKey as SavedFilterData['sortKey'])
      : 'path',
    sortOrder: data.sortOrder === 'desc' ? 'desc' : 'asc'
  }
}
