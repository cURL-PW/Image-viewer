import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type {
  FolderNode,
  ImageQuery,
  ImageRecord,
  ImageTag,
  TagInfo
} from '@shared/types'

export interface ImageUpsert {
  relPath: string
  dirPath: string
  fileName: string
  mtime: number
  size: number
}

export interface TagResult {
  name: string
  category: number
  confidence: number
}

const SCHEMA_VERSION = 1

/**
 * ファイル名中の数字列をゼロ埋めして自然順ソート用のキーを作る。
 * "p2.jpg" < "p10.jpg" のように人間の期待どおりに並べるために使う。
 */
export function naturalKey(relPath: string): string {
  return relPath
    .toLowerCase()
    .replace(/\d+/g, (digits) => digits.padStart(12, '0').slice(-12))
}

export class LibraryDb {
  readonly db: DatabaseSync

  constructor(file: string) {
    // Electron 同梱の Node に内蔵された SQLite を使う (ネイティブモジュールの再ビルドが不要)
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.migrate()
  }

  /** 複数の書き込みを 1 トランザクションにまとめる。 */
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined
    if ((row?.user_version ?? 0) >= SCHEMA_VERSION) return

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS roots (
        id   INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE
      );

      CREATE TABLE IF NOT EXISTS images (
        id            INTEGER PRIMARY KEY,
        root_id       INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
        rel_path      TEXT NOT NULL,
        dir_path      TEXT NOT NULL,
        file_name     TEXT NOT NULL,
        sort_key      TEXT NOT NULL,
        mtime         INTEGER NOT NULL,
        size          INTEGER NOT NULL,
        width         INTEGER,
        height        INTEGER,
        scanned_model TEXT,
        scan_error    TEXT,
        UNIQUE (root_id, rel_path)
      );

      CREATE TABLE IF NOT EXISTS tags (
        id       INTEGER PRIMARY KEY,
        name     TEXT NOT NULL UNIQUE,
        category INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS image_tags (
        image_id   INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
        tag_id     INTEGER NOT NULL REFERENCES tags(id),
        confidence REAL NOT NULL,
        PRIMARY KEY (image_id, tag_id)
      );

      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_images_dir       ON images(root_id, dir_path);
      CREATE INDEX IF NOT EXISTS idx_images_unscanned ON images(root_id, scanned_model);
      CREATE INDEX IF NOT EXISTS idx_image_tags_tag   ON image_tags(tag_id);
    `)
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  }

  close(): void {
    this.db.close()
  }

  // ---------------------------------------------------------------- roots

  getOrCreateRoot(path: string): number {
    const existing = this.db.prepare('SELECT id FROM roots WHERE path = ?').get(path) as
      | { id: number }
      | undefined
    if (existing) return existing.id
    return Number(this.db.prepare('INSERT INTO roots (path) VALUES (?)').run(path).lastInsertRowid)
  }

  getRootPath(rootId: number): string | null {
    const row = this.db.prepare('SELECT path FROM roots WHERE id = ?').get(rootId) as
      | { path: string }
      | undefined
    return row?.path ?? null
  }

  // --------------------------------------------------------------- images

  /** 画像を登録/更新する。内容 (mtime/size) が変わった場合はタグを破棄して再スキャン対象にする。 */
  upsertImage(rootId: number, file: ImageUpsert): { id: number; changed: boolean } {
    const existing = this.db
      .prepare('SELECT id, mtime, size FROM images WHERE root_id = ? AND rel_path = ?')
      .get(rootId, file.relPath) as { id: number; mtime: number; size: number } | undefined

    if (!existing) {
      const id = Number(
        this.db
          .prepare(
            `INSERT INTO images (root_id, rel_path, dir_path, file_name, sort_key, mtime, size)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            rootId,
            file.relPath,
            file.dirPath,
            file.fileName,
            naturalKey(file.relPath),
            file.mtime,
            file.size
          ).lastInsertRowid
      )
      return { id, changed: true }
    }

    if (existing.mtime === file.mtime && existing.size === file.size) {
      return { id: existing.id, changed: false }
    }

    this.db
      .prepare(
        `UPDATE images
            SET mtime = ?, size = ?, width = NULL, height = NULL,
                scanned_model = NULL, scan_error = NULL
          WHERE id = ?`
      )
      .run(file.mtime, file.size, existing.id)
    this.db.prepare('DELETE FROM image_tags WHERE image_id = ?').run(existing.id)
    return { id: existing.id, changed: true }
  }

  upsertMany(rootId: number, files: ImageUpsert[]): { added: number[]; updated: number[] } {
    const added: number[] = []
    const updated: number[] = []
    this.transaction(() => {
      for (const file of files) {
        const before = this.db
          .prepare('SELECT id FROM images WHERE root_id = ? AND rel_path = ?')
          .get(rootId, file.relPath) as { id: number } | undefined
        const result = this.upsertImage(rootId, file)
        if (!before) added.push(result.id)
        else if (result.changed) updated.push(result.id)
      }
    })
    return { added, updated }
  }

  removeByRelPath(rootId: number, relPath: string): number | null {
    const row = this.db
      .prepare('SELECT id FROM images WHERE root_id = ? AND rel_path = ?')
      .get(rootId, relPath) as { id: number } | undefined
    if (!row) return null
    this.db.prepare('DELETE FROM images WHERE id = ?').run(row.id)
    return row.id
  }

  /** ディレクトリごと削除された場合に、その配下の画像をまとめて消す。 */
  removeUnderDir(rootId: number, dirPath: string): number[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM images
          WHERE root_id = ? AND (dir_path = ? OR dir_path LIKE ? ESCAPE '\\')`
      )
      .all(rootId, dirPath, `${escapeLike(dirPath)}/%`) as { id: number }[]
    const ids = rows.map((r) => r.id)
    if (ids.length > 0) {
      this.db.prepare(`DELETE FROM images WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids)
    }
    return ids
  }

  /** ルート配下の全相対パス。起動時の差分同期に使う。 */
  allRelPaths(rootId: number): Map<string, { id: number; mtime: number; size: number }> {
    const rows = this.db
      .prepare('SELECT id, rel_path, mtime, size FROM images WHERE root_id = ?')
      .all(rootId) as { id: number; rel_path: string; mtime: number; size: number }[]
    const map = new Map<string, { id: number; mtime: number; size: number }>()
    for (const row of rows) map.set(row.rel_path, { id: row.id, mtime: row.mtime, size: row.size })
    return map
  }

  removeIds(ids: number[]): void {
    if (ids.length === 0) return
    this.transaction(() => {
      const statement = this.db.prepare('DELETE FROM images WHERE id = ?')
      for (const id of ids) statement.run(id)
    })
  }

  getImages(ids: number[]): ImageRecord[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.db
      .prepare(`SELECT ${IMAGE_COLUMNS} FROM images WHERE id IN (${placeholders})`)
      .all(...ids) as unknown as RawImage[]
    const byId = new Map(rows.map((row) => [row.id, toImageRecord(row)]))
    // 要求された順序を保って返す
    return ids.map((id) => byId.get(id)).filter((image): image is ImageRecord => !!image)
  }

  getImage(id: number): ImageRecord | null {
    const row = this.db.prepare(`SELECT ${IMAGE_COLUMNS} FROM images WHERE id = ?`).get(id) as
      | RawImage
      | undefined
    return row ? toImageRecord(row) : null
  }

  setDimensions(id: number, width: number, height: number): void {
    this.db.prepare('UPDATE images SET width = ?, height = ? WHERE id = ?').run(width, height, id)
  }

  // ---------------------------------------------------------------- query

  queryImageIds(rootId: number, query: ImageQuery): number[] {
    const { where, params } = buildWhere(rootId, query)
    const order = buildOrder(query)
    const rows = this.db
      .prepare(`SELECT id FROM images WHERE ${where} ORDER BY ${order}`)
      .all(...params) as { id: number }[]
    return rows.map((row) => row.id)
  }

  /** 現在の絞り込みスコープ内に出現するタグを、出現枚数付きで返す。 */
  listTags(rootId: number, query: ImageQuery, limit = 500): TagInfo[] {
    const { where, params } = buildWhere(rootId, query)
    const rows = this.db
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
    return rows
  }

  /** 選択中のタグは絞り込みで消えないよう、常に取得できるようにする。 */
  getTagsByIds(ids: number[]): TagInfo[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(',')
    return this.db
      .prepare(
        `SELECT t.id AS id, t.name AS name, t.category AS category,
                (SELECT COUNT(*) FROM image_tags it WHERE it.tag_id = t.id) AS count
           FROM tags t WHERE t.id IN (${placeholders})`
      )
      .all(...ids) as unknown as TagInfo[]
  }

  getImageTags(imageId: number): ImageTag[] {
    return this.db
      .prepare(
        `SELECT t.id AS id, t.name AS name, t.category AS category, it.confidence AS confidence
           FROM image_tags it JOIN tags t ON t.id = it.tag_id
          WHERE it.image_id = ?
          ORDER BY it.confidence DESC`
      )
      .all(imageId) as unknown as ImageTag[]
  }

  // ----------------------------------------------------------------- tree

  buildTree(rootId: number, rootName: string): FolderNode {
    const rows = this.db
      .prepare('SELECT dir_path, COUNT(*) AS count FROM images WHERE root_id = ? GROUP BY dir_path')
      .all(rootId) as { dir_path: string; count: number }[]

    const root: FolderNode = { path: '', name: rootName, count: 0, children: [] }
    const index = new Map<string, FolderNode>([['', root]])

    const ensure = (path: string): FolderNode => {
      const existing = index.get(path)
      if (existing) return existing
      const slash = path.lastIndexOf('/')
      const parentPath = slash === -1 ? '' : path.slice(0, slash)
      const name = slash === -1 ? path : path.slice(slash + 1)
      const node: FolderNode = { path, name, count: 0, children: [] }
      index.set(path, node)
      ensure(parentPath).children.push(node)
      return node
    }

    for (const row of rows) {
      const node = ensure(row.dir_path)
      // 自ディレクトリ直下の枚数を、祖先すべてに積み上げる
      let cursor: FolderNode | undefined = node
      let path = row.dir_path
      while (cursor) {
        cursor.count += row.count
        if (path === '') break
        const slash = path.lastIndexOf('/')
        path = slash === -1 ? '' : path.slice(0, slash)
        cursor = index.get(path)
      }
    }

    const sortTree = (node: FolderNode): void => {
      node.children.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      node.children.forEach(sortTree)
    }
    sortTree(root)
    return root
  }

  // ----------------------------------------------------------------- tags

  private tagIdCache = new Map<string, number>()

  private getOrCreateTagId(name: string, category: number): number {
    const cached = this.tagIdCache.get(name)
    if (cached !== undefined) return cached
    const existing = this.db.prepare('SELECT id FROM tags WHERE name = ?').get(name) as
      | { id: number }
      | undefined
    const id = existing
      ? existing.id
      : Number(
          this.db
            .prepare('INSERT INTO tags (name, category) VALUES (?, ?)')
            .run(name, category).lastInsertRowid
        )
    this.tagIdCache.set(name, id)
    return id
  }

  /** 推論結果を保存し、画像をスキャン済みにする。 */
  saveTags(imageId: number, modelId: string, tags: TagResult[]): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM image_tags WHERE image_id = ?').run(imageId)
      const insert = this.db.prepare(
        'INSERT OR REPLACE INTO image_tags (image_id, tag_id, confidence) VALUES (?, ?, ?)'
      )
      for (const tag of tags) {
        insert.run(imageId, this.getOrCreateTagId(tag.name, tag.category), tag.confidence)
      }
      this.db
        .prepare('UPDATE images SET scanned_model = ?, scan_error = NULL WHERE id = ?')
        .run(modelId, imageId)
    })
  }

  setScanError(imageId: number, message: string): void {
    this.db.prepare('UPDATE images SET scan_error = ? WHERE id = ?').run(message.slice(0, 500), imageId)
  }

  /** 未スキャン画像を、指定ディレクトリ配下を優先して取り出す。 */
  nextUnscanned(rootId: number, modelId: string, priorityDir: string | null, limit: number): ImageRecord[] {
    const priority =
      priorityDir !== null
        ? `CASE WHEN dir_path = ? OR dir_path LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,`
        : ''
    const params: SQLInputValue[] = [rootId, modelId]
    if (priorityDir !== null) params.push(priorityDir, `${escapeLike(priorityDir)}/%`)
    params.push(limit)

    const rows = this.db
      .prepare(
        `SELECT ${IMAGE_COLUMNS} FROM images
          WHERE root_id = ?
            AND (scanned_model IS NULL OR scanned_model != ?)
            AND scan_error IS NULL
          ORDER BY ${priority} sort_key
          LIMIT ?`
      )
      .all(...params) as unknown as RawImage[]
    return rows.map(toImageRecord)
  }

  countUnscanned(rootId: number, modelId: string): { pending: number; failed: number; total: number } {
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN (scanned_model IS NULL OR scanned_model != ?) AND scan_error IS NULL THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN scan_error IS NOT NULL THEN 1 ELSE 0 END) AS failed,
           COUNT(*) AS total
         FROM images WHERE root_id = ?`
      )
      .get(modelId, rootId) as { pending: number | null; failed: number | null; total: number }
    return { pending: row.pending ?? 0, failed: row.failed ?? 0, total: row.total }
  }

  /** 特定のエラー文言が付いている画像の数。 */
  countScanErrors(rootId: number, message: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM images WHERE root_id = ? AND scan_error = ?')
      .get(rootId, message) as { count: number }
    return row.count
  }

  /** 指定のエラー文言が付いていれば消し、再スキャン対象へ戻す。 */
  clearScanError(imageId: number, message: string): void {
    this.db
      .prepare('UPDATE images SET scan_error = NULL WHERE id = ? AND scan_error = ?')
      .run(imageId, message)
  }

  /** モデル変更などで全画像を再スキャン対象に戻す。 */
  resetScanState(rootId: number, onlyErrors: boolean): void {
    if (onlyErrors) {
      this.db.prepare('UPDATE images SET scan_error = NULL WHERE root_id = ? AND scan_error IS NOT NULL').run(rootId)
    } else {
      this.db
        .prepare('UPDATE images SET scanned_model = NULL, scan_error = NULL WHERE root_id = ?')
        .run(rootId)
    }
  }

  // ------------------------------------------------------------- settings

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  }
}

// ------------------------------------------------------------------ utils

const IMAGE_COLUMNS = `id, rel_path, dir_path, file_name, mtime, size, width, height, scanned_model, scan_error`

interface RawImage {
  id: number
  rel_path: string
  dir_path: string
  file_name: string
  mtime: number
  size: number
  width: number | null
  height: number | null
  scanned_model: string | null
  scan_error: string | null
}

function toImageRecord(row: RawImage): ImageRecord {
  return {
    id: row.id,
    relPath: row.rel_path,
    dirPath: row.dir_path,
    fileName: row.file_name,
    mtime: row.mtime,
    size: row.size,
    width: row.width,
    height: row.height,
    scannedModel: row.scanned_model,
    scanError: row.scan_error
  }
}

/** LIKE のワイルドカードを無効化する (フォルダ名に % や _ が含まれる場合の対策)。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

function intList(ids: number[]): number[] {
  return ids.filter((id) => Number.isInteger(id))
}

export function buildWhere(rootId: number, query: ImageQuery): { where: string; params: SQLInputValue[] } {
  const clauses = ['root_id = ?']
  const params: SQLInputValue[] = [rootId]

  if (query.dir !== '') {
    if (query.recursive) {
      clauses.push(`(dir_path = ? OR dir_path LIKE ? ESCAPE '\\')`)
      params.push(query.dir, `${escapeLike(query.dir)}/%`)
    } else {
      clauses.push('dir_path = ?')
      params.push(query.dir)
    }
  } else if (!query.recursive) {
    clauses.push(`dir_path = ''`)
  }

  const include = intList(query.includeTags)
  const exclude = intList(query.excludeTags)

  if (include.length > 0) {
    const placeholders = include.map(() => '?').join(',')
    if (query.tagMode === 'and') {
      clauses.push(
        `id IN (SELECT image_id FROM image_tags WHERE tag_id IN (${placeholders})
                 GROUP BY image_id HAVING COUNT(DISTINCT tag_id) = ?)`
      )
      params.push(...include, include.length)
    } else {
      clauses.push(`id IN (SELECT image_id FROM image_tags WHERE tag_id IN (${placeholders}))`)
      params.push(...include)
    }
  }

  if (exclude.length > 0) {
    const placeholders = exclude.map(() => '?').join(',')
    clauses.push(`id NOT IN (SELECT image_id FROM image_tags WHERE tag_id IN (${placeholders}))`)
    params.push(...exclude)
  }

  // タグ条件がある間は、まだスキャンされていない画像は結果に含めない
  if (include.length > 0 || exclude.length > 0) {
    clauses.push('scanned_model IS NOT NULL')
  }

  return { where: clauses.join(' AND '), params }
}

export function buildOrder(query: ImageQuery): string {
  const direction = query.sortOrder === 'desc' ? 'DESC' : 'ASC'
  switch (query.sortKey) {
    case 'name':
      return `file_name COLLATE NOCASE ${direction}, sort_key ${direction}`
    case 'mtime':
      return `mtime ${direction}, sort_key ASC`
    case 'size':
      return `size ${direction}, sort_key ASC`
    case 'path':
    default:
      return `sort_key ${direction}`
  }
}
