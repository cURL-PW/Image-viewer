import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LibraryDb } from './db'

let base: string
let db: LibraryDb

beforeEach(async () => {
  base = await fsp.mkdtemp(path.join(os.tmpdir(), 'image-viewer-similar-'))
  db = new LibraryDb(path.join(base, 'library.db'))
})

afterEach(async () => {
  db.close()
  await fsp.rm(base, { recursive: true, force: true })
})

function addImages(rootId: number, names: string[]): number[] {
  return db.upsertMany(
    rootId,
    names.map((name) => ({ relPath: name, dirPath: '', fileName: name, mtime: 1, size: 1 }))
  ).added
}

type Tag = { name: string; category: number; confidence: number }
const general = (name: string, confidence = 1): Tag => ({ name, category: 0, confidence })
const character = (name: string, confidence = 1): Tag => ({ name, category: 4, confidence })
const rating = (name: string, confidence = 1): Tag => ({ name, category: 9, confidence })

describe('似た画像', () => {
  it('タグの重なりが大きい順に並び、元の画像とタグを共有しない画像は出ない', () => {
    const root = db.getOrCreateRoot('/photos')
    const [src, near, far, none] = addImages(root, ['src.png', 'near.png', 'far.png', 'none.png'])
    db.saveTags(src, 'm', [general('cat'), general('sky'), general('tree')])
    db.saveTags(near, 'm', [general('cat'), general('sky')])
    db.saveTags(far, 'm', [general('cat'), general('car'), general('road')])
    db.saveTags(none, 'm', [general('dog')])

    const result = db.findSimilar(root, src, 10)
    expect(result.map((row) => row.id)).toEqual([near, far])
    expect(result[0].score).toBeGreaterThan(result[1].score)
    expect(result[0].score).toBeLessThanOrEqual(1)
  })

  it('character タグは general の 2 倍の重みで数える', () => {
    const root = db.getOrCreateRoot('/photos')
    const [src, sameChara, sameGeneral] = addImages(root, ['src.png', 'a.png', 'b.png'])
    db.saveTags(src, 'm', [character('alice'), general('sky')])
    db.saveTags(sameChara, 'm', [character('alice'), general('sea')])
    db.saveTags(sameGeneral, 'm', [character('bob'), general('sky')])

    expect(db.findSimilar(root, src, 10).map((row) => row.id)).toEqual([sameChara, sameGeneral])
  })

  it('rating タグは数えない', () => {
    const root = db.getOrCreateRoot('/photos')
    const [src, onlyRating] = addImages(root, ['src.png', 'a.png'])
    db.saveTags(src, 'm', [general('cat'), rating('general')])
    db.saveTags(onlyRating, 'm', [general('dog'), rating('general')])

    expect(db.findSimilar(root, src, 10)).toEqual([])
  })

  it('別のライブラリの画像と、まだタグ付けしていない画像は出ない', () => {
    const root = db.getOrCreateRoot('/photos')
    const other = db.getOrCreateRoot('/other')
    const [src, unscanned] = addImages(root, ['src.png', 'new.png'])
    const [elsewhere] = addImages(other, ['x.png'])
    db.saveTags(src, 'm', [general('cat')])
    db.saveTags(elsewhere, 'm', [general('cat')])
    db.addManualTag(root, [unscanned], 'cat')

    expect(db.findSimilar(root, src, 10)).toEqual([])
  })

  it('件数の上限を守り、タグのない画像では空になる', () => {
    const root = db.getOrCreateRoot('/photos')
    const ids = addImages(root, ['src.png', 'a.png', 'b.png', 'c.png', 'empty.png'])
    for (const id of ids.slice(0, 4)) db.saveTags(id, 'm', [general('cat')])

    expect(db.findSimilar(root, ids[0], 2)).toHaveLength(2)
    expect(db.findSimilar(root, ids[4], 10)).toEqual([])
  })
})
