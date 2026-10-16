import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizeRotation } from '@shared/types'
import { LibraryDb } from './db'

let base: string

beforeEach(async () => {
  base = await fsp.mkdtemp(path.join(os.tmpdir(), 'image-viewer-rotation-'))
})

afterEach(async () => {
  await fsp.rm(base, { recursive: true, force: true })
})

describe('normalizeRotation', () => {
  it('0 / 90 / 180 / 270 に揃える', () => {
    expect(normalizeRotation(0)).toBe(0)
    expect(normalizeRotation(90)).toBe(90)
    expect(normalizeRotation(360)).toBe(0)
    expect(normalizeRotation(450)).toBe(90)
    expect(normalizeRotation(-90)).toBe(270)
    expect(normalizeRotation(-270)).toBe(90)
    expect(normalizeRotation(Number.NaN)).toBe(0)
  })
})

describe('回転の記憶', () => {
  it('既定は 0 で、記憶した値を読み出せる', () => {
    const db = new LibraryDb(path.join(base, 'library.db'))
    const root = db.getOrCreateRoot('/photos')
    const [id] = db.upsertMany(root, [
      { relPath: 'a.png', dirPath: '', fileName: 'a.png', mtime: 1, size: 1 }
    ]).added
    expect(db.getImage(id)?.rotation).toBe(0)

    db.setRotation(id, 270)
    expect(db.getImage(id)?.rotation).toBe(270)
    db.close()
  })

  it('ファイルの内容が変わっても回転は残す', () => {
    const db = new LibraryDb(path.join(base, 'library.db'))
    const root = db.getOrCreateRoot('/photos')
    const file = { relPath: 'a.png', dirPath: '', fileName: 'a.png', mtime: 1, size: 1 }
    const [id] = db.upsertMany(root, [file]).added
    db.setRotation(id, 90)

    db.upsertMany(root, [{ ...file, mtime: 2, size: 2 }])
    expect(db.getImage(id)?.rotation).toBe(90)
    db.close()
  })

  it('v1 の DB を開くと rotation 列を足して移行する', () => {
    const file = path.join(base, 'library.db')
    // v1 当時の images 表だけを作っておく
    const old = new DatabaseSync(file)
    old.exec(`
      CREATE TABLE roots (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE);
      CREATE TABLE images (
        id INTEGER PRIMARY KEY, root_id INTEGER NOT NULL, rel_path TEXT NOT NULL,
        dir_path TEXT NOT NULL, file_name TEXT NOT NULL, sort_key TEXT NOT NULL,
        mtime INTEGER NOT NULL, size INTEGER NOT NULL, width INTEGER, height INTEGER,
        scanned_model TEXT, scan_error TEXT, UNIQUE (root_id, rel_path)
      );
      INSERT INTO roots (id, path) VALUES (1, '/photos');
      INSERT INTO images (id, root_id, rel_path, dir_path, file_name, sort_key, mtime, size)
        VALUES (1, 1, 'a.png', '', 'a.png', 'a.png', 1, 1);
      PRAGMA user_version = 1;
    `)
    old.close()

    const db = new LibraryDb(file)
    expect(db.getImage(1)?.rotation).toBe(0)
    db.setRotation(1, 180)
    expect(db.getImage(1)?.rotation).toBe(180)
    db.close()
  })
})
