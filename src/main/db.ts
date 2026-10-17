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
  /**
   * 門番に止められて `stat` できなかった場合は true。
   * mtime / size は不明なので、既存行の値を上書きしてはいけない
   * (上書きすると「内容が変わった」と誤判定し、付与済みタグが消える)。
   */
  statSkipped?: boolean
}

/** 既知の行。走査時に 1 回だけ読み出して使い回す */
export interface KnownImage {
  id: number
  mtime: number
  size: number
}

export interface TagResult {
  name: string
  category: number
  confidence: number
}

/** ブラウザ拡張から取り込んだ画像の取り込み元 */
export interface ImageSourceRow {
  relPath: string
  sha256: string
  pageUrl: string | null
  imageUrl: string | null
  /** 投稿者や投稿 ID を読み取れたサイト ('twitter' など) */
  site: string | null
  author: string | null
  postId: string | null
  importedAt: number
}

const SCHEMA_VERSION = 5

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
  /**
   * 用意済みのステートメント。`prepare` は SQL のコンパイルを伴うので、
   * 走査のように 1 行ずつ回す処理では作り直さない (9 万件で数秒の差になる)。
   */
  private statements = new Map<string, ReturnType<DatabaseSync['prepare']>>()

  constructor(file: string) {
    // Electron 同梱の Node に内蔵された SQLite を使う (ネイティブモジュールの再ビルドが不要)
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.migrate()
  }

  /** 同じ SQL は使い回す。 */
  private stmt(sql: string): ReturnType<DatabaseSync['prepare']> {
    const existing = this.statements.get(sql)
    if (existing) return existing
    const prepared = this.db.prepare(sql)
    this.statements.set(sql, prepared)
    return prepared
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
    const version = row?.user_version ?? 0
    if (version >= SCHEMA_VERSION) return

    if (version < 1) this.createBaseTables()
    // v2: 画像ごとの表示上の回転
    if (version < 2) this.addColumn('images', 'rotation', 'INTEGER NOT NULL DEFAULT 0')
    // v3: お気に入りと、保存した絞り込み条件
    if (version < 3) {
      this.addColumn('images', 'favorite', 'INTEGER NOT NULL DEFAULT 0')
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS saved_filters (
          id      INTEGER PRIMARY KEY,
          root_id INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
          name    TEXT NOT NULL,
          data    TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_saved_filters_root ON saved_filters(root_id);
        CREATE INDEX IF NOT EXISTS idx_images_favorite    ON images(root_id, favorite);
      `)
    }
    // v4: 手動で足した / 外したタグ。自動タグ (image_tags) を書き直すたびに当て直す
    if (version < 4) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS image_tag_overrides (
          image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
          tag_id   INTEGER NOT NULL REFERENCES tags(id),
          mode     INTEGER NOT NULL,  -- 1 = 足した, -1 = 外した
          PRIMARY KEY (image_id, tag_id)
        );
      `)
    }
    // v5: ブラウザ拡張から取り込んだ画像の取り込み元。
    // 取り込んだ時点では画像の行がまだ無いこともあるので、画像 ID ではなくパスで持つ
    if (version < 5) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS image_sources (
          root_id     INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
          rel_path    TEXT NOT NULL,
          sha256      TEXT NOT NULL,
          page_url    TEXT,
          image_url   TEXT,
          site        TEXT,
          author      TEXT,
          post_id     TEXT,
          imported_at INTEGER NOT NULL,
          PRIMARY KEY (root_id, rel_path)
        );
        CREATE INDEX IF NOT EXISTS idx_image_sources_hash ON image_sources(root_id, sha256);
      `)
    }
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  }

  /** 既に列があれば何もしない (途中で失敗した移行をやり直せるように) */
  private addColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    if (columns.some((entry) => entry.name === column)) return
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }

  private createBaseTables(): void {
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
  }

  close(): void {
    this.statements.clear()
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

  /** 登録済みのルートを、取り込み済みの枚数付きで登録順に返す。 */
  listRoots(): { id: number; path: string; count: number }[] {
    return this.db
      .prepare(
        `SELECT r.id AS id, r.path AS path,
                (SELECT COUNT(*) FROM images i WHERE i.root_id = r.id) AS count
           FROM roots r ORDER BY r.id`
      )
      .all() as { id: number; path: string; count: number }[]
  }

  /** ルートの登録を外す。画像とタグ付け結果も消える (実ファイルには触らない)。 */
  removeRoot(rootId: number): void {
    this.db.prepare('DELETE FROM roots WHERE id = ?').run(rootId)
  }

  /** 画像がどのルートに属するか。別ライブラリの ID で引かれたときに弾くために使う。 */
  getImageRootId(id: number): number | null {
    const row = this.stmt('SELECT root_id FROM images WHERE id = ?').get(id) as
      | { root_id: number }
      | undefined
    return row?.root_id ?? null
  }

  // --------------------------------------------------------------- images

  /**
   * 画像を登録/更新する。内容 (mtime/size) が変わった場合はタグを破棄して再スキャン対象にする。
   *
   * `known` を渡すと既存行の問い合わせを省ける (走査は全件を 1 回で読んでいる)。
   */
  upsertImage(
    rootId: number,
    file: ImageUpsert,
    known?: KnownImage | undefined
  ): { id: number; added: boolean; changed: boolean } {
    const existing =
      known ??
      (this.stmt('SELECT id, mtime, size FROM images WHERE root_id = ? AND rel_path = ?').get(
        rootId,
        file.relPath
      ) as KnownImage | undefined)

    if (!existing) {
      const id = Number(
        this.stmt(
          `INSERT INTO images (root_id, rel_path, dir_path, file_name, sort_key, mtime, size)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          rootId,
          file.relPath,
          file.dirPath,
          file.fileName,
          naturalKey(file.relPath),
          file.mtime,
          file.size
        ).lastInsertRowid
      )
      return { id, added: true, changed: true }
    }

    // stat できていないものは内容の比較ができない。既存の値をそのまま残す
    if (file.statSkipped) return { id: existing.id, added: false, changed: false }

    if (existing.mtime === file.mtime && existing.size === file.size) {
      return { id: existing.id, added: false, changed: false }
    }

    this.stmt(
      `UPDATE images
          SET mtime = ?, size = ?, width = NULL, height = NULL,
              scanned_model = NULL, scan_error = NULL
        WHERE id = ?`
    ).run(file.mtime, file.size, existing.id)
    this.stmt('DELETE FROM image_tags WHERE image_id = ?').run(existing.id)
    // 手動で足したタグは付け直しを待たずに残す
    this.applyTagOverrides(existing.id)
    return { id: existing.id, added: false, changed: true }
  }

  /**
   * まとめて登録/更新する。
   * `known` (relPath → 既存行) を渡すと 1 行ごとの検索をせずに済む。
   */
  upsertMany(
    rootId: number,
    files: ImageUpsert[],
    known?: Map<string, KnownImage>
  ): { added: number[]; updated: number[] } {
    const added: number[] = []
    const updated: number[] = []
    this.transaction(() => {
      for (const file of files) {
        const result = this.upsertImage(rootId, file, known?.get(file.relPath))
        if (result.added) added.push(result.id)
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
  allRelPaths(rootId: number): Map<string, KnownImage> {
    const rows = this.db
      .prepare('SELECT id, rel_path, mtime, size FROM images WHERE root_id = ?')
      .all(rootId) as { id: number; rel_path: string; mtime: number; size: number }[]
    const map = new Map<string, KnownImage>()
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

  /** 表示上の回転を記憶する。ファイルの内容が変わっても残す (タグとは違い画像の見え方の好みなので) */
  setRotation(id: number, rotation: number): void {
    this.db.prepare('UPDATE images SET rotation = ? WHERE id = ?').run(rotation, id)
  }

  /** お気に入りを付け外しする。別ライブラリの画像は触らない。ファイルの内容が変わっても残す */
  setFavorite(rootId: number, ids: number[], favorite: boolean): void {
    const targets = intList(ids)
    if (targets.length === 0) return
    this.transaction(() => {
      const statement = this.stmt('UPDATE images SET favorite = ? WHERE id = ? AND root_id = ?')
      for (const id of targets) statement.run(favorite ? 1 : 0, id, rootId)
    })
  }

  // -------------------------------------------------------- saved filters

  listSavedFilters(rootId: number): { id: number; name: string; data: string }[] {
    return this.db
      .prepare('SELECT id, name, data FROM saved_filters WHERE root_id = ? ORDER BY id')
      .all(rootId) as { id: number; name: string; data: string }[]
  }

  addSavedFilter(rootId: number, name: string, data: string): number {
    return Number(
      this.db
        .prepare('INSERT INTO saved_filters (root_id, name, data) VALUES (?, ?, ?)')
        .run(rootId, name, data).lastInsertRowid
    )
  }

  renameSavedFilter(rootId: number, id: number, name: string): void {
    this.db
      .prepare('UPDATE saved_filters SET name = ? WHERE id = ? AND root_id = ?')
      .run(name, id, rootId)
  }

  deleteSavedFilter(rootId: number, id: number): void {
    this.db.prepare('DELETE FROM saved_filters WHERE id = ? AND root_id = ?').run(id, rootId)
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
    const rows = this.db
      .prepare(
        `SELECT t.id AS id, t.name AS name, t.category AS category, it.confidence AS confidence,
                COALESCE(o.mode, 0) = 1 AS manual
           FROM image_tags it
           JOIN tags t ON t.id = it.tag_id
           LEFT JOIN image_tag_overrides o ON o.image_id = it.image_id AND o.tag_id = it.tag_id
          WHERE it.image_id = ?
          ORDER BY manual DESC, it.confidence DESC`
      )
      .all(imageId) as unknown as (Omit<ImageTag, 'manual'> & { manual: number })[]
    return rows.map((row) => ({ ...row, manual: row.manual === 1 }))
  }

  // ---------------------------------------------------------- manual tags

  /** 手動の追加・削除を image_tags に反映する */
  private applyTagOverrides(imageId: number): void {
    this.stmt(
      `DELETE FROM image_tags WHERE image_id = ? AND tag_id IN
         (SELECT tag_id FROM image_tag_overrides WHERE image_id = ? AND mode = -1)`
    ).run(imageId, imageId)
    this.stmt(
      `INSERT OR REPLACE INTO image_tags (image_id, tag_id, confidence)
         SELECT image_id, tag_id, 1.0 FROM image_tag_overrides WHERE image_id = ? AND mode = 1`
    ).run(imageId)
  }

  /**
   * 画像にタグを手で足す。無いタグ名なら general として作る。
   * 確信度は 1 (100%) として扱う。足したタグの ID を返す
   */
  addManualTag(rootId: number, ids: number[], name: string): number | null {
    const tagName = name.trim()
    const targets = this.idsInRoot(rootId, ids)
    if (tagName === '' || targets.length === 0) return null
    return this.transaction(() => {
      const tagId = this.getOrCreateTagId(tagName, 0)
      for (const id of targets) {
        this.stmt(
          'INSERT OR REPLACE INTO image_tag_overrides (image_id, tag_id, mode) VALUES (?, ?, 1)'
        ).run(id, tagId)
        this.stmt(
          'INSERT OR REPLACE INTO image_tags (image_id, tag_id, confidence) VALUES (?, ?, 1.0)'
        ).run(id, tagId)
      }
      return tagId
    })
  }

  /** 画像からタグを手で外す。自動で付いたタグでも、付け直しで戻らないよう記録する */
  removeManualTag(rootId: number, ids: number[], tagId: number): void {
    const targets = this.idsInRoot(rootId, ids)
    if (!Number.isInteger(tagId) || targets.length === 0) return
    this.transaction(() => {
      for (const id of targets) {
        this.stmt(
          'INSERT OR REPLACE INTO image_tag_overrides (image_id, tag_id, mode) VALUES (?, ?, -1)'
        ).run(id, tagId)
        this.stmt('DELETE FROM image_tags WHERE image_id = ? AND tag_id = ?').run(id, tagId)
      }
    })
  }

  /** 複数画像に付いているタグを、付いている枚数付きで返す (多い順) */
  tagsForImages(rootId: number, ids: number[]): TagInfo[] {
    const counts = new Map<number, TagInfo>()
    for (const chunk of chunks(this.idsInRoot(rootId, ids))) {
      const placeholders = chunk.map(() => '?').join(',')
      const rows = this.db
        .prepare(
          `SELECT t.id AS id, t.name AS name, t.category AS category, COUNT(*) AS count
             FROM image_tags it JOIN tags t ON t.id = it.tag_id
            WHERE it.image_id IN (${placeholders})
            GROUP BY t.id`
        )
        .all(...chunk) as unknown as TagInfo[]
      for (const row of rows) {
        const existing = counts.get(row.id)
        if (existing) existing.count += row.count
        else counts.set(row.id, { ...row })
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  }

  /**
   * タグの重なりで似た画像を探す。
   *
   * 各画像を「タグ → 確信度 × 重み」のベクトルとみなし、コサイン類似度の高い順に返す。
   * general は重み 1、character は 2 (同じキャラクターが上に来やすくする)、rating は使わない。
   * 対象はタグ付けが済んだ画像だけ。元の画像自身は含めない
   */
  findSimilar(rootId: number, imageId: number, limit: number): { id: number; score: number }[] {
    const weight = `CASE t.category WHEN 4 THEN 2.0 ELSE 1.0 END`
    const target = this.db
      .prepare(
        `SELECT it.tag_id AS tagId, it.confidence * ${weight} AS w
           FROM image_tags it JOIN tags t ON t.id = it.tag_id
          WHERE it.image_id = ? AND t.category != 9`
      )
      .all(imageId) as { tagId: number; w: number }[]
    const targetNorm = Math.sqrt(target.reduce((sum, tag) => sum + tag.w * tag.w, 0))
    if (target.length === 0 || targetNorm === 0) return []

    // 元の画像とタグを 1 つも共有しない画像は類似度 0 なので、共有するものだけを候補にする。
    // 候補ごとに内積と、自分のベクトルの長さ (の 2 乗) を 1 回の問い合わせで出す
    const rows = this.db
      .prepare(
        `WITH target(tag_id, w) AS (SELECT value ->> 0, value ->> 1 FROM json_each(?)),
              dots AS (
                SELECT it.image_id AS id, SUM(target.w * it.confidence * ${weight}) AS dot
                  FROM image_tags it
                  JOIN target ON target.tag_id = it.tag_id
                  JOIN tags t ON t.id = it.tag_id
                 WHERE it.image_id != ?
                 GROUP BY it.image_id
              )
         SELECT d.id AS id, d.dot AS dot,
                (SELECT SUM((it.confidence * ${weight}) * (it.confidence * ${weight}))
                   FROM image_tags it JOIN tags t ON t.id = it.tag_id
                  WHERE it.image_id = d.id AND t.category != 9) AS norm2
           FROM dots d JOIN images i ON i.id = d.id
          WHERE i.root_id = ? AND i.scanned_model IS NOT NULL`
      )
      .all(
        JSON.stringify(target.map((tag) => [tag.tagId, tag.w])),
        imageId,
        rootId
      ) as { id: number; dot: number; norm2: number | null }[]

    return rows
      .filter((row) => row.norm2 !== null && row.norm2 > 0)
      .map((row) => ({ id: row.id, score: row.dot / (targetNorm * Math.sqrt(row.norm2 as number)) }))
      .sort((a, b) => b.score - a.score || a.id - b.id)
      .slice(0, limit)
  }

  /** タグ名の補完候補。前方一致を先に、続けて部分一致を出す */
  suggestTags(text: string, limit: number): string[] {
    const term = text.trim()
    if (term === '') return []
    const rows = this.db
      .prepare(
        `SELECT name FROM tags
          WHERE name LIKE ? ESCAPE '\\'
          ORDER BY CASE WHEN name LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, length(name), name
          LIMIT ?`
      )
      .all(`%${escapeLike(term)}%`, `${escapeLike(term)}%`, limit) as { name: string }[]
    return rows.map((row) => row.name)
  }

  /** 指定ライブラリに属する ID だけに絞る (別ライブラリの画像を書き換えないため) */
  private idsInRoot(rootId: number, ids: number[]): number[] {
    const found: number[] = []
    // 全選択だと数万件になるので、SQL の変数の上限に掛からないよう分けて問い合わせる
    for (const chunk of chunks(intList(ids))) {
      const placeholders = chunk.map(() => '?').join(',')
      const rows = this.db
        .prepare(`SELECT id FROM images WHERE root_id = ? AND id IN (${placeholders})`)
        .all(rootId, ...chunk) as { id: number }[]
      for (const row of rows) found.push(row.id)
    }
    return found
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
    // 推論中に画像が消えた (ファイル削除やライブラリの登録解除)。
    // そのまま書くと外部キー違反で例外になり、タグ付けのキューが止まる
    if (!this.stmt('SELECT 1 FROM images WHERE id = ?').get(imageId)) return
    this.transaction(() => {
      this.db.prepare('DELETE FROM image_tags WHERE image_id = ?').run(imageId)
      const insert = this.db.prepare(
        'INSERT OR REPLACE INTO image_tags (image_id, tag_id, confidence) VALUES (?, ?, ?)'
      )
      for (const tag of tags) {
        insert.run(imageId, this.getOrCreateTagId(tag.name, tag.category), tag.confidence)
      }
      // 手動の追加・削除は自動タグより優先する (再スキャンやモデル変更でも戻らない)
      this.applyTagOverrides(imageId)
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

  // ---------------------------------------------------------------- 取り込み元

  addImageSource(rootId: number, source: ImageSourceRow): void {
    this.stmt(
      `INSERT OR REPLACE INTO image_sources
         (root_id, rel_path, sha256, page_url, image_url, site, author, post_id, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      rootId,
      source.relPath,
      source.sha256,
      source.pageUrl,
      source.imageUrl,
      source.site,
      source.author,
      source.postId,
      source.importedAt
    )
  }

  /** 同じ中身を前に取り込んだ記録 (ファイルが今もあるかは呼び出し側で確かめる) */
  findImageSourcesByHash(rootId: number, sha256: string): ImageSourceRow[] {
    const rows = this.stmt(
      `SELECT rel_path, sha256, page_url, image_url, site, author, post_id, imported_at
         FROM image_sources WHERE root_id = ? AND sha256 = ?`
    ).all(rootId, sha256) as Record<string, SQLInputValue>[]
    return rows.map(toSourceRow)
  }

  getImageSource(rootId: number, relPath: string): ImageSourceRow | null {
    const row = this.stmt(
      `SELECT rel_path, sha256, page_url, image_url, site, author, post_id, imported_at
         FROM image_sources WHERE root_id = ? AND rel_path = ?`
    ).get(rootId, relPath) as Record<string, SQLInputValue> | undefined
    return row ? toSourceRow(row) : null
  }

  removeImageSource(rootId: number, relPath: string): void {
    this.stmt('DELETE FROM image_sources WHERE root_id = ? AND rel_path = ?').run(rootId, relPath)
  }

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

const IMAGE_COLUMNS = `id, rel_path, dir_path, file_name, mtime, size, width, height, scanned_model, scan_error, rotation, favorite`

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
  rotation: number
  favorite: number
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
    scanError: row.scan_error,
    rotation: row.rotation,
    favorite: row.favorite === 1
  }
}

/** LIKE のワイルドカードを無効化する (フォルダ名に % や _ が含まれる場合の対策)。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

/** 検索語を空白 (全角を含む) で区切る */
export function searchTerms(search: string | undefined): string[] {
  return (search ?? '').split(/[\s\u3000]+/).filter((term) => term !== '')
}

const CHUNK_SIZE = 500

function chunks<T>(items: T[]): T[][] {
  const result: T[][] = []
  for (let i = 0; i < items.length; i += CHUNK_SIZE) result.push(items.slice(i, i + CHUNK_SIZE))
  return result
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

  // ファイル名・パス検索。語ごとに AND。LIKE は ASCII の大文字小文字を区別しない
  for (const term of searchTerms(query.search)) {
    clauses.push(`rel_path LIKE ? ESCAPE '\\'`)
    params.push(`%${escapeLike(term)}%`)
  }

  if (query.favoritesOnly) clauses.push('favorite = 1')

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

function toSourceRow(row: Record<string, SQLInputValue>): ImageSourceRow {
  const text = (value: SQLInputValue): string | null => (typeof value === 'string' ? value : null)
  return {
    relPath: String(row.rel_path),
    sha256: String(row.sha256),
    pageUrl: text(row.page_url),
    imageUrl: text(row.image_url),
    site: text(row.site),
    author: text(row.author),
    postId: text(row.post_id),
    importedAt: Number(row.imported_at)
  }
}
