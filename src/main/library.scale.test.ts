import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LibraryDb } from './db'
import { installFsProbe } from './fs-probe'
import { Library } from './library'

/**
 * 大量のファイルが 1 フォルダに入っている状態を再現する。
 *
 * 実機の iCloud 同期フォルダは 89,358 枚が 1 階層に並んでいて、そこで
 * 「起動すると固まる」が起きた。原因は監視ライブラリ (chokidar) が
 * 1 ファイルにつき stat を 2 回、監視ハンドルを 1 個ずつ作っていたこと。
 * ここではその規模で「準備が終わること」を実際に測る。
 */

const COUNT = 90_000
/** 走査と監視の準備がこの時間で終わること。chokidar 時代は 25 秒 + 40 万回の stat だった */
const BUDGET_MS = 30_000

let base: string
let root: string
let db: LibraryDb

beforeAll(async () => {
  base = await fsp.mkdtemp(path.join(os.tmpdir(), 'image-viewer-scale-'))
  root = path.join(base, 'library')
  await fsp.mkdir(root, { recursive: true })

  // 中身は読まないので空ファイルでよい (走査が触るのは名前と stat だけ)
  const writes: Promise<void>[] = []
  for (let i = 0; i < COUNT; i++) {
    writes.push(fsp.writeFile(path.join(root, `IMG_${String(i).padStart(6, '0')}.jpg`), ''))
    if (writes.length >= 2000) {
      await Promise.all(writes.splice(0))
    }
  }
  await Promise.all(writes)

  db = new LibraryDb(path.join(base, 'library.db'))
}, 600_000)

afterAll(async () => {
  db?.close()
  await fsp.rm(base, { recursive: true, force: true })
})

/** 走査が終わる (indexProgress の scanning が false になる) まで待つ。 */
function waitForScan(library: Library): Promise<number> {
  return new Promise((resolve) => {
    library.on('indexProgress', (progress) => {
      if (!progress.scanning) resolve(progress.found)
    })
  })
}

describe(`${COUNT.toLocaleString()} 枚が 1 フォルダにある場合`, () => {
  it(
    '走査と監視の準備が現実的な時間で終わる',
    async () => {
      const library = new Library(db)
      const done = waitForScan(library)
      const probe = installFsProbe(60_000)

      const startedAt = Date.now()
      const rootId = await library.setRoot(root)
      const found = await done
      const elapsed = Date.now() - startedAt
      const counts = probe.counts()
      probe.uninstall()

      expect(found).toBe(COUNT)

      // 1 ファイルにつき stat は 1 回だけ。監視の準備でもう一度触ってはいけない。
      // (chokidar は readdirp の lstat と handler の stat で 2 回触っていた)
      const stats = (counts['p:stat'] ?? 0) + (counts['p:lstat'] ?? 0) + (counts.stat ?? 0) + (counts.lstat ?? 0)
      expect(stats).toBeLessThanOrEqual(COUNT + 100)
      expect(db.queryImageIds(rootId, {
        dir: '',
        recursive: true,
        includeTags: [],
        excludeTags: [],
        tagMode: 'and',
        sortKey: 'path',
        sortOrder: 'asc'
      })).toHaveLength(COUNT)
      expect(elapsed).toBeLessThan(BUDGET_MS)

      await library.stop()
    },
    600_000
  )

  it(
    '2 回目の走査は書き込みを起こさない',
    async () => {
      const library = new Library(db)
      const changes: number[] = []
      library.on('change', (change) => changes.push(change.added.length + change.updated.length))
      const done = waitForScan(library)

      await library.setRoot(root)
      await done
      await library.stop()

      // 何も変わっていないので追加も更新も 0 件。
      // (stat を止めた状態で mtime=0 を書き戻すと、ここで全件が「更新」になる)
      expect(changes.reduce((sum, n) => sum + n, 0)).toBe(0)
    },
    600_000
  )

  it(
    '走査を止めていても mtime を 0 で上書きしない',
    async () => {
      // 門番が stat を止めている状態を再現する
      const library = new Library(db, { allow: () => false, record: () => {} })
      const done = waitForScan(library)
      const rootId = await library.setRoot(root)
      await done
      await library.stop()

      const [id] = db.queryImageIds(rootId, {
        dir: '',
        recursive: true,
        includeTags: [],
        excludeTags: [],
        tagMode: 'and',
        sortKey: 'path',
        sortOrder: 'asc'
      })
      const image = db.getImage(id)
      expect(image?.mtime).toBeGreaterThan(0)
    },
    600_000
  )
})
