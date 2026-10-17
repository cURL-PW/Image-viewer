import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ImageQuery, SortKey, TagInfo } from '@shared/types'
import { LibraryDb, buildOrder, buildWhere } from './db'

/**
 * 一覧とタグ集計の問い合わせを速くした変更で、結果が変わっていないことを確かめる。
 * 変更前の SQL をそのまま基準として持ち、同じデータで突き合わせる。
 */

let base: string
let db: LibraryDb

beforeEach(async () => {
  base = await fsp.mkdtemp(path.join(os.tmpdir(), 'image-viewer-query-speed-'))
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

/** 変更前の listTags */
function listTagsBefore(rootId: number, scope: ImageQuery, limit: number): TagInfo[] {
  const { where, params } = buildWhere(rootId, scope)
  return db.db
    .prepare(
      `SELECT t.id AS id, t.name AS name, t.category AS category, COUNT(*) AS count
         FROM image_tags it
         JOIN tags t ON t.id = it.tag_id
        WHERE it.image_id IN (SELECT id FROM images WHERE ${where})
        GROUP BY t.id
        ORDER BY count DESC, t.name ASC
        LIMIT ?`
    )
    .all(...params, limit) as unknown as TagInfo[]
}

/** 変更前の queryImageIds */
function queryBefore(rootId: number, q: ImageQuery): number[] {
  const { where, params } = buildWhere(rootId, q)
  const rows = db.db
    .prepare(`SELECT id FROM images WHERE ${where} ORDER BY ${buildOrder(q)}`)
    .all(...params) as { id: number }[]
  return rows.map((row) => row.id)
}

/** 決まった並びの疑似乱数 (テストを毎回同じデータで回すため) */
function random(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
}

/** フォルダ・名前・日時・サイズ・タグがばらけたライブラリを作る */
function fillLibrary(rootPath: string, count: number, seed: number): number {
  const rootId = db.getOrCreateRoot(rootPath)
  const next = random(seed)
  const files = Array.from({ length: count }, (_, i) => {
    const dirPath = i % 5 === 0 ? '' : `album${i % 4}${i % 3 === 0 ? '/sub' : ''}`
    const fileName = `${i % 2 === 0 ? 'IMG' : 'img'}_${Math.floor(next() * 1000)}.jpg`
    return {
      relPath: dirPath ? `${dirPath}/${fileName}_${i}` : `${fileName}_${i}`,
      dirPath,
      fileName,
      // 同じ値を混ぜて、並べ替えの同点の扱いも比べる
      mtime: Math.floor(next() * 20),
      size: Math.floor(next() * 20)
    }
  })
  const { added } = db.upsertMany(rootId, files)
  for (const id of added) {
    // 一部は未スキャンのまま残す
    if (next() < 0.1) continue
    const tags = new Set<string>()
    const tagCount = Math.floor(next() * 12)
    for (let k = 0; k < tagCount; k++) tags.add(`tag${Math.floor(next() * next() * 40)}`)
    db.saveTags(
      id,
      'model',
      [...tags].map((name) => ({ name, category: name.endsWith('7') ? 4 : 0, confidence: next() }))
    )
  }
  return rootId
}

const scopes: ImageQuery[] = [
  query,
  { ...query, recursive: false },
  { ...query, dir: 'album1' },
  { ...query, dir: 'album0', recursive: false },
  { ...query, dir: 'album0/sub' }
]

describe('タグ一覧の集計', () => {
  it('ライブラリが 1 つだけのとき、変更前と同じ結果になる', () => {
    const root = fillLibrary('/lib', 400, 1)
    for (const scope of scopes) {
      for (const limit of [5, 300]) {
        expect(db.listTags(root, scope, limit)).toEqual(listTagsBefore(root, scope, limit))
      }
    }
  })

  it('ほかのライブラリにも画像があるとき、変更前と同じ結果になる (よそのタグを数えない)', () => {
    const first = fillLibrary('/first', 300, 2)
    const second = fillLibrary('/second', 200, 3)
    for (const root of [first, second]) {
      for (const scope of scopes) {
        expect(db.listTags(root, scope, 300)).toEqual(listTagsBefore(root, scope, 300))
      }
    }
  })

  it('ほかのライブラリが空なら、全体の集計がそのライブラリの集計になる', () => {
    const root = fillLibrary('/lib', 200, 4)
    db.getOrCreateRoot('/empty')
    expect(db.listTags(root, query, 300)).toEqual(listTagsBefore(root, query, 300))
  })

  it('画像の無いライブラリでは空になる', () => {
    fillLibrary('/lib', 50, 5)
    const empty = db.getOrCreateRoot('/empty')
    expect(db.listTags(empty, query, 300)).toEqual([])
  })
})

describe('一覧の問い合わせ', () => {
  it('並べ替え・絞り込みの組み合わせで、変更前と同じ順番になる', () => {
    const root = fillLibrary('/lib', 400, 6)
    fillLibrary('/other', 100, 7)
    const sortKeys: SortKey[] = ['path', 'name', 'mtime', 'size']
    const filters: Partial<ImageQuery>[] = [
      {},
      { includeTags: [1, 2] },
      { includeTags: [1, 2], tagMode: 'or' },
      { excludeTags: [1] },
      { search: 'img_1' }
    ]
    for (const scope of scopes) {
      for (const filter of filters) {
        for (const sortKey of sortKeys) {
          for (const sortOrder of ['asc', 'desc'] as const) {
            const q = { ...scope, ...filter, sortKey, sortOrder }
            expect(db.queryImageIds(root, q)).toEqual(queryBefore(root, q))
          }
        }
      }
    }
  })
})
