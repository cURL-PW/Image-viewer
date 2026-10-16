import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ImageQuery } from '@shared/types'
import { LibraryDb, buildWhere, searchTerms } from './db'

let base: string
let db: LibraryDb

beforeEach(async () => {
  base = await fsp.mkdtemp(path.join(os.tmpdir(), 'image-viewer-favorites-'))
  db = new LibraryDb(path.join(base, 'library.db'))
})

afterEach(async () => {
  db.close()
  await fsp.rm(base, { recursive: true, force: true })
})

const query: ImageQuery = {
  dir: '',
  recursive: true,
  includeTags: [],
  excludeTags: [],
  tagMode: 'and',
  sortKey: 'path',
  sortOrder: 'asc'
}

function addImages(rootId: number, relPaths: string[]): number[] {
  return db.upsertMany(
    rootId,
    relPaths.map((relPath) => ({
      relPath,
      dirPath: relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '',
      fileName: relPath.slice(relPath.lastIndexOf('/') + 1),
      mtime: 1,
      size: 1
    }))
  ).added
}

describe('searchTerms', () => {
  it('半角・全角の空白で区切り、空の語は捨てる', () => {
    expect(searchTerms('  cat　2024 ')).toEqual(['cat', '2024'])
    expect(searchTerms('')).toEqual([])
    expect(searchTerms(undefined)).toEqual([])
  })
})

describe('ファイル名・パス検索', () => {
  it('相対パスに部分一致し、語ごとに AND で絞る (大文字小文字は区別しない)', () => {
    const root = db.getOrCreateRoot('/photos')
    addImages(root, ['Trip/Cat_01.png', 'trip/dog.png', 'home/cat.png', 'x%y.png'])
    const names = (search: string): string[] =>
      db
        .getImages(db.queryImageIds(root, { ...query, search }))
        .map((image) => image.relPath)

    expect(names('cat')).toEqual(['home/cat.png', 'Trip/Cat_01.png'])
    expect(names('TRIP cat')).toEqual(['Trip/Cat_01.png'])
    // フォルダ名にも当たる
    expect(names('home')).toEqual(['home/cat.png'])
    // LIKE のワイルドカードは文字として扱う
    expect(names('%')).toEqual(['x%y.png'])
    expect(names('_01')).toEqual(['Trip/Cat_01.png'])
  })

  it('検索語が無ければ条件を付けない', () => {
    expect(buildWhere(1, { ...query, search: '   ' }).where).toBe('root_id = ?')
  })
})

describe('お気に入り', () => {
  it('付け外しでき、お気に入りだけに絞れる', () => {
    const root = db.getOrCreateRoot('/photos')
    const [a, b, c] = addImages(root, ['a.png', 'b.png', 'c.png'])
    expect(db.getImage(a)?.favorite).toBe(false)

    db.setFavorite(root, [a, c], true)
    expect(db.queryImageIds(root, { ...query, favoritesOnly: true })).toEqual([a, c])
    db.setFavorite(root, [c], false)
    expect(db.queryImageIds(root, { ...query, favoritesOnly: true })).toEqual([a])
    expect(db.getImage(b)?.favorite).toBe(false)
  })

  it('別ライブラリの画像には付けない', () => {
    const one = db.getOrCreateRoot('/one')
    const two = db.getOrCreateRoot('/two')
    const [other] = addImages(two, ['a.png'])
    db.setFavorite(one, [other], true)
    expect(db.getImage(other)?.favorite).toBe(false)
  })

  it('ファイルの内容が変わっても残す', () => {
    const root = db.getOrCreateRoot('/photos')
    const file = { relPath: 'a.png', dirPath: '', fileName: 'a.png', mtime: 1, size: 1 }
    const [id] = db.upsertMany(root, [file]).added
    db.setFavorite(root, [id], true)
    db.upsertMany(root, [{ ...file, mtime: 5, size: 9 }])
    expect(db.getImage(id)?.favorite).toBe(true)
  })
})

describe('保存した条件', () => {
  it('ライブラリごとに保存し、名前の変更と削除ができる', () => {
    const one = db.getOrCreateRoot('/one')
    const two = db.getOrCreateRoot('/two')
    const id = db.addSavedFilter(one, '猫', '{"search":"cat"}')
    db.addSavedFilter(two, '犬', '{}')

    expect(db.listSavedFilters(one)).toEqual([{ id, name: '猫', data: '{"search":"cat"}' }])

    // 別ライブラリの ID では変えられない
    db.renameSavedFilter(two, id, '別')
    db.renameSavedFilter(one, id, 'ねこ')
    expect(db.listSavedFilters(one)[0].name).toBe('ねこ')

    db.deleteSavedFilter(one, id)
    expect(db.listSavedFilters(one)).toEqual([])
    expect(db.listSavedFilters(two)).toHaveLength(1)
  })

  it('ライブラリを外すと一緒に消える', () => {
    const root = db.getOrCreateRoot('/one')
    db.addSavedFilter(root, '猫', '{}')
    db.removeRoot(root)
    expect(db.listSavedFilters(root)).toEqual([])
  })
})
