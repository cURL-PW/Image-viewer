import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ImageQuery } from '@shared/types'
import { LibraryDb } from './db'

let base: string
let db: LibraryDb

beforeEach(async () => {
  base = await fsp.mkdtemp(path.join(os.tmpdir(), 'image-viewer-manual-tags-'))
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

function addImages(rootId: number, names: string[]): number[] {
  return db.upsertMany(
    rootId,
    names.map((name) => ({ relPath: name, dirPath: '', fileName: name, mtime: 1, size: 1 }))
  ).added
}

const names = (id: number): string[] =>
  db
    .getImageTags(id)
    .map((tag) => `${tag.name}${tag.manual ? '*' : ''}`)
    .sort()

describe('手動タグ', () => {
  it('足したタグは general として作られ、確信度 1 の手動タグとして出る', () => {
    const root = db.getOrCreateRoot('/photos')
    const [a] = addImages(root, ['a.png'])
    db.saveTags(a, 'model', [{ name: 'cat', category: 0, confidence: 0.6 }])

    const tagId = db.addManualTag(root, [a], '  my_tag ')
    expect(tagId).not.toBeNull()
    expect(names(a)).toEqual(['cat', 'my_tag*'])
    const added = db.getImageTags(a).find((tag) => tag.name === 'my_tag')
    expect(added).toMatchObject({ category: 0, confidence: 1, manual: true })
    // 手で足したタグで絞り込める
    expect(db.queryImageIds(root, { ...query, includeTags: [tagId as number] })).toEqual([a])
  })

  it('再スキャンしても、足したタグは残り、外したタグは戻らない', () => {
    const root = db.getOrCreateRoot('/photos')
    const [a] = addImages(root, ['a.png'])
    const auto = [
      { name: 'cat', category: 0, confidence: 0.9 },
      { name: 'dog', category: 0, confidence: 0.4 }
    ]
    db.saveTags(a, 'model', auto)
    db.addManualTag(root, [a], 'mine')
    const dog = db.getImageTags(a).find((tag) => tag.name === 'dog')?.id as number
    db.removeManualTag(root, [a], dog)
    expect(names(a)).toEqual(['cat', 'mine*'])

    // モデルを変えて付け直しても同じ
    db.saveTags(a, 'other-model', auto)
    expect(names(a)).toEqual(['cat', 'mine*'])
  })

  it('ファイルの内容が変わっても、足したタグは付け直しを待たずに残る', () => {
    const root = db.getOrCreateRoot('/photos')
    const file = { relPath: 'a.png', dirPath: '', fileName: 'a.png', mtime: 1, size: 1 }
    const [a] = db.upsertMany(root, [file]).added
    db.saveTags(a, 'model', [{ name: 'cat', category: 0, confidence: 0.9 }])
    db.addManualTag(root, [a], 'mine')

    db.upsertMany(root, [{ ...file, mtime: 2 }])
    expect(names(a)).toEqual(['mine*'])
  })

  it('外したあとに足し直せる (最後の操作が勝つ)', () => {
    const root = db.getOrCreateRoot('/photos')
    const [a] = addImages(root, ['a.png'])
    const tagId = db.addManualTag(root, [a], 'mine') as number
    db.removeManualTag(root, [a], tagId)
    expect(names(a)).toEqual([])
    db.addManualTag(root, [a], 'mine')
    expect(names(a)).toEqual(['mine*'])
  })

  it('複数画像にまとめて足し外しでき、枚数付きで一覧できる。別ライブラリには触らない', () => {
    const root = db.getOrCreateRoot('/photos')
    const other = db.getOrCreateRoot('/other')
    const [a, b, c] = addImages(root, ['a.png', 'b.png', 'c.png'])
    const [x] = addImages(other, ['x.png'])

    db.addManualTag(root, [a, b, x], 'shared')
    db.addManualTag(root, [c], 'solo')
    expect(db.tagsForImages(root, [a, b, c]).map((tag) => [tag.name, tag.count])).toEqual([
      ['shared', 2],
      ['solo', 1]
    ])
    expect(names(x)).toEqual([])

    const shared = db.tagsForImages(root, [a])[0].id
    db.removeManualTag(root, [a, b], shared)
    expect(db.tagsForImages(root, [a, b, c]).map((tag) => tag.name)).toEqual(['solo'])
  })

  it('タグ名の補完は前方一致を先に出す', () => {
    const root = db.getOrCreateRoot('/photos')
    const [a] = addImages(root, ['a.png'])
    db.saveTags(a, 'model', [
      { name: 'black_cat', category: 0, confidence: 0.9 },
      { name: 'cat', category: 0, confidence: 0.9 },
      { name: 'cat_ears', category: 0, confidence: 0.9 },
      { name: 'dog', category: 0, confidence: 0.9 }
    ])
    expect(db.suggestTags('cat', 10)).toEqual(['cat', 'cat_ears', 'black_cat'])
    expect(db.suggestTags('  ', 10)).toEqual([])
  })
})
