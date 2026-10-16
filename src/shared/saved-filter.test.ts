import { describe, expect, it } from 'vitest'
import { sanitizeFilterData } from './saved-filter'
import type { SavedFilterData } from './types'

describe('sanitizeFilterData', () => {
  it('正しい値はそのまま残す', () => {
    const data: SavedFilterData = {
      includeTags: [1, 2],
      excludeTags: [3],
      tagMode: 'or',
      search: 'cat 2024',
      favoritesOnly: true,
      sortKey: 'mtime',
      sortOrder: 'desc'
    }
    expect(sanitizeFilterData(data)).toEqual(data)
  })

  it('壊れた値や足りない値は既定に戻す', () => {
    const broken = {
      includeTags: [1, 'x', 2.5],
      excludeTags: 'nope',
      tagMode: 'xor',
      search: 42,
      favoritesOnly: 'yes',
      sortKey: 'random',
      sortOrder: 'sideways',
      dir: 'a/b'
    } as unknown as Partial<SavedFilterData>
    expect(sanitizeFilterData(broken)).toEqual({
      includeTags: [1],
      excludeTags: [],
      tagMode: 'and',
      search: '',
      favoritesOnly: false,
      sortKey: 'path',
      sortOrder: 'asc'
    })
    expect(sanitizeFilterData(null).tagMode).toBe('and')
  })
})
