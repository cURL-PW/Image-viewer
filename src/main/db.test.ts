import { describe, expect, it } from 'vitest'
import { buildOrder, buildWhere, naturalKey } from './db'
import type { ImageQuery } from '@shared/types'

const baseQuery: ImageQuery = {
  dir: '',
  recursive: true,
  includeTags: [],
  excludeTags: [],
  tagMode: 'and',
  sortKey: 'path',
  sortOrder: 'asc'
}

describe('naturalKey', () => {
  it('数字列をゼロ埋めして人間の期待どおりに並べる', () => {
    const files = ['p10.jpg', 'p2.jpg', 'p1.jpg', 'p20.jpg']
    const sorted = [...files].sort((a, b) => naturalKey(a).localeCompare(naturalKey(b)))
    expect(sorted).toEqual(['p1.jpg', 'p2.jpg', 'p10.jpg', 'p20.jpg'])
  })

  it('フォルダをまたいでも階層順が保たれる', () => {
    const files = ['ch10/002.png', 'ch2/001.png', 'ch2/010.png']
    const sorted = [...files].sort((a, b) => naturalKey(a).localeCompare(naturalKey(b)))
    expect(sorted).toEqual(['ch2/001.png', 'ch2/010.png', 'ch10/002.png'])
  })

  it('大文字小文字を無視する', () => {
    expect(naturalKey('A/B.PNG')).toBe(naturalKey('a/b.png'))
  })
})

describe('buildWhere', () => {
  it('ルート全体の再帰表示ではディレクトリ条件を付けない', () => {
    const { where, params } = buildWhere(1, baseQuery)
    expect(where).toBe('root_id = ?')
    expect(params).toEqual([1])
  })

  it('再帰表示では配下のディレクトリも対象にする', () => {
    const { where, params } = buildWhere(1, { ...baseQuery, dir: 'a/b' })
    expect(where).toContain('dir_path = ? OR dir_path LIKE ?')
    expect(params).toEqual([1, 'a/b', 'a/b/%'])
  })

  it('非再帰ではそのディレクトリ直下だけを対象にする', () => {
    const { where, params } = buildWhere(1, { ...baseQuery, dir: 'a', recursive: false })
    expect(where).toContain('dir_path = ?')
    expect(where).not.toContain('LIKE')
    expect(params).toEqual([1, 'a'])
  })

  it('LIKE のワイルドカードを含むフォルダ名をエスケープする', () => {
    const { params } = buildWhere(1, { ...baseQuery, dir: '100%_best' })
    expect(params).toEqual([1, '100%_best', '100\\%\\_best/%'])
  })

  it('AND 指定では指定タグをすべて持つ画像に絞る', () => {
    const { where, params } = buildWhere(1, { ...baseQuery, includeTags: [3, 7] })
    expect(where).toContain('HAVING COUNT(DISTINCT tag_id) = ?')
    expect(params).toEqual([1, 3, 7, 2])
  })

  it('OR 指定ではいずれかを持つ画像に絞る', () => {
    const { where, params } = buildWhere(1, { ...baseQuery, includeTags: [3, 7], tagMode: 'or' })
    expect(where).not.toContain('HAVING')
    expect(where).toContain('id IN (SELECT image_id FROM image_tags WHERE tag_id IN (?,?))')
    expect(params).toEqual([1, 3, 7])
  })

  it('除外タグを NOT IN で除く', () => {
    const { where, params } = buildWhere(1, { ...baseQuery, excludeTags: [9] })
    expect(where).toContain('id NOT IN (SELECT image_id FROM image_tags WHERE tag_id IN (?))')
    expect(params).toEqual([1, 9])
  })

  it('タグ条件があるときは未スキャンの画像を除く', () => {
    expect(buildWhere(1, { ...baseQuery, includeTags: [3] }).where).toContain(
      'scanned_model IS NOT NULL'
    )
    expect(buildWhere(1, { ...baseQuery, excludeTags: [3] }).where).toContain(
      'scanned_model IS NOT NULL'
    )
    // タグ条件がなければ未スキャンでも表示する
    expect(buildWhere(1, baseQuery).where).not.toContain('scanned_model')
  })

  it('整数でないタグ ID は無視する', () => {
    const { where, params } = buildWhere(1, {
      ...baseQuery,
      includeTags: [1.5, Number.NaN, 4] as number[]
    })
    expect(params).toEqual([1, 4, 1])
    expect(where).toContain('tag_id IN (?)')
  })
})

describe('buildOrder', () => {
  it('既定はパスの自然順', () => {
    expect(buildOrder(baseQuery)).toBe('sort_key ASC')
    expect(buildOrder({ ...baseQuery, sortOrder: 'desc' })).toBe('sort_key DESC')
  })

  it('更新日時やサイズでも並べ替えられ、同値はパス順で安定する', () => {
    expect(buildOrder({ ...baseQuery, sortKey: 'mtime', sortOrder: 'desc' })).toBe(
      'mtime DESC, sort_key ASC'
    )
    expect(buildOrder({ ...baseQuery, sortKey: 'size' })).toBe('size ASC, sort_key ASC')
  })
})
