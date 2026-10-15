import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LibraryDb } from './db'

let base: string
let db: LibraryDb

beforeEach(async () => {
  base = await fsp.mkdtemp(path.join(os.tmpdir(), 'image-viewer-roots-'))
  db = new LibraryDb(path.join(base, 'library.db'))
})

afterEach(async () => {
  db.close()
  await fsp.rm(base, { recursive: true, force: true })
})

function addImage(rootId: number, relPath: string): number {
  const { added } = db.upsertMany(rootId, [
    { relPath, dirPath: '', fileName: relPath, mtime: 1, size: 1 }
  ])
  return added[0]
}

describe('複数ライブラリ', () => {
  it('登録順に枚数付きで一覧できる', () => {
    const a = db.getOrCreateRoot('/photos/a')
    const b = db.getOrCreateRoot('/photos/b')
    addImage(a, '1.png')
    addImage(a, '2.png')
    addImage(b, '1.png')

    expect(db.listRoots()).toEqual([
      { id: a, path: '/photos/a', count: 2 },
      { id: b, path: '/photos/b', count: 1 }
    ])
  })

  it('同じパスは二重に登録しない', () => {
    const first = db.getOrCreateRoot('/photos/a')
    expect(db.getOrCreateRoot('/photos/a')).toBe(first)
    expect(db.listRoots()).toHaveLength(1)
  })

  it('登録を外すと、そのライブラリの画像だけが消える', () => {
    const a = db.getOrCreateRoot('/photos/a')
    const b = db.getOrCreateRoot('/photos/b')
    const inA = addImage(a, '1.png')
    const inB = addImage(b, '1.png')

    db.removeRoot(a)

    expect(db.listRoots().map((root) => root.id)).toEqual([b])
    expect(db.getImage(inA)).toBeNull()
    expect(db.getImage(inB)).not.toBeNull()
  })

  it('登録を外した後に届いたタグ付け結果は捨てる', () => {
    const a = db.getOrCreateRoot('/photos/a')
    const id = addImage(a, '1.png')
    db.removeRoot(a)
    expect(() => db.saveTags(id, 'model', [{ name: 'cat', category: 0, confidence: 0.9 }])).not.toThrow()
  })

  it('画像の所属ライブラリを引ける', () => {
    const a = db.getOrCreateRoot('/photos/a')
    const b = db.getOrCreateRoot('/photos/b')
    expect(db.getImageRootId(addImage(b, 'x.png'))).toBe(b)
    expect(db.getImageRootId(addImage(a, 'x.png'))).toBe(a)
    expect(db.getImageRootId(99999)).toBeNull()
  })
})
