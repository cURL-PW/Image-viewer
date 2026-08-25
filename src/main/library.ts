import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import { SUPPORTED_EXTENSIONS, type LibraryChange } from '@shared/types'
import type { ImageUpsert, LibraryDb } from './db'

const EXTENSIONS = new Set<string>(SUPPORTED_EXTENSIONS)
/** 走査結果をこの枚数ごとに DB へ流し込み、走査中でも UI に反映させる */
const WALK_BATCH = 200
/** ファイル監視イベントをまとめて処理するまでの待ち時間 (ms) */
const WATCH_DEBOUNCE = 300

export function isSupportedImage(filePath: string): boolean {
  return EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

/** OS 依存の区切り文字を DB 上の posix 表記へ正規化する。 */
export function toRelPath(rootPath: string, fullPath: string): string {
  return path.relative(rootPath, fullPath).split(path.sep).join('/')
}

export function splitRelPath(relPath: string): { dirPath: string; fileName: string } {
  const slash = relPath.lastIndexOf('/')
  return slash === -1
    ? { dirPath: '', fileName: relPath }
    : { dirPath: relPath.slice(0, slash), fileName: relPath.slice(slash + 1) }
}

export interface WalkedFile extends ImageUpsert {
  fullPath: string
}

/**
 * 走査中に `fs.stat` を許可するかを決める門番。
 *
 * Windows の libuv は `fs.stat` の実装でファイルを CreateFileW で開くため、
 * iCloud のように「開いた時点で実体を取りに行く」プレースホルダだと、
 * **走査するだけでライブラリ全体がダウンロードされてしまう**。
 * ここで所要時間を測り、遅い状態が続いたら stat をやめる。
 */
export interface StatGate {
  allow(): boolean
  record(durationMs: number): void
}

export interface WalkOptions {
  batchSize?: number
  gate?: StatGate
}

/**
 * ルート配下を再帰的に走査し、対応形式の画像を batch 単位で返す。
 * シンボリックリンクのディレクトリは循環を避けるため辿らない。
 *
 * 門番が stat を止めた場合は mtime / size を 0 として登録する。
 * 実際の値は、その画像を本当に読むとき (サムネイル生成やタグ付け) に埋まる。
 */
export async function* walkImages(
  rootPath: string,
  options: WalkOptions = {}
): AsyncGenerator<WalkedFile[]> {
  const batchSize = options.batchSize ?? WALK_BATCH
  const gate = options.gate
  const stack: string[] = [rootPath]
  let batch: WalkedFile[] = []

  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue // 権限がない等のディレクトリはスキップ
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const fullPath = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        stack.push(fullPath)
        continue
      }
      if (!entry.isFile() || !isSupportedImage(entry.name)) continue

      const relPath = toRelPath(rootPath, fullPath)
      const { dirPath, fileName } = splitRelPath(relPath)

      // readdir はファイルを開かないので安全だが、stat は Windows で実体を取りに行く。
      // 止められている間は寸法不明のまま登録し、必要になった時点で埋める。
      if (gate && !gate.allow()) {
        batch.push({ fullPath, relPath, dirPath, fileName, mtime: 0, size: 0 })
      } else {
        try {
          const startedAt = Date.now()
          const stats = await fs.stat(fullPath)
          gate?.record(Date.now() - startedAt)
          batch.push({
            fullPath,
            relPath,
            dirPath,
            fileName,
            mtime: Math.floor(stats.mtimeMs),
            size: stats.size
          })
        } catch {
          continue
        }
      }

      if (batch.length >= batchSize) {
        yield batch
        batch = []
      }
    }
  }

  if (batch.length > 0) yield batch
}

interface LibraryEvents {
  change: [LibraryChange]
  indexProgress: [{ found: number; scanning: boolean }]
}

/**
 * ルートフォルダの再帰走査・差分同期・ファイル監視を担当する。
 * DB 更新後に 'change' を発火し、renderer 側の表示を追従させる。
 */
export class Library extends EventEmitter<LibraryEvents> {
  private rootId: number | null = null
  private rootPath: string | null = null
  private watcher: FSWatcher | null = null
  private indexing = false
  private generation = 0

  private pendingUpsert = new Set<string>()
  private pendingRemove = new Set<string>()
  private pendingRemoveDir = new Set<string>()
  private flushTimer: NodeJS.Timeout | null = null

  constructor(
    private db: LibraryDb,
    /** 走査中の stat を止められるようにする (クラウド同期フォルダ対策) */
    private gate?: StatGate
  ) {
    super()
  }

  get currentRootId(): number | null {
    return this.rootId
  }

  get currentRootPath(): string | null {
    return this.rootPath
  }

  get isIndexing(): boolean {
    return this.indexing
  }

  /** ルートを切り替え、差分同期と監視を開始する。 */
  async setRoot(rootPath: string): Promise<number> {
    await this.stop()
    const generation = ++this.generation

    this.rootPath = rootPath
    this.rootId = this.db.getOrCreateRoot(rootPath)

    // 走査と監視は並行で開始する。監視を先に張ることで、走査中の変更も取りこぼさない。
    this.startWatching(rootPath)
    void this.syncAll(generation)
    return this.rootId
  }

  /** 既存ルートを再オープンする (起動時の復帰用)。 */
  async resumeRoot(rootId: number): Promise<boolean> {
    const rootPath = this.db.getRootPath(rootId)
    if (!rootPath) return false
    try {
      const stats = await fs.stat(rootPath)
      if (!stats.isDirectory()) return false
    } catch {
      return false
    }
    await this.setRoot(rootPath)
    return true
  }

  async stop(): Promise<void> {
    this.generation++
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.pendingUpsert.clear()
    this.pendingRemove.clear()
    this.pendingRemoveDir.clear()
    if (this.watcher) {
      await this.watcher.close()
      this.watcher = null
    }
    this.indexing = false
  }

  /**
   * 全走査を行い DB と実ファイルの差分を解消する。
   * 監視していない間に起きた追加・更新・削除もここで拾う。
   */
  private async syncAll(generation: number): Promise<void> {
    const rootId = this.rootId
    const rootPath = this.rootPath
    if (rootId === null || rootPath === null) return

    this.indexing = true
    this.emit('indexProgress', { found: 0, scanning: true })

    const known = this.db.allRelPaths(rootId)
    const seen = new Set<string>()
    let found = 0

    try {
      for await (const batch of walkImages(rootPath, { gate: this.gate })) {
        if (generation !== this.generation) return // ルートが切り替わった
        for (const file of batch) seen.add(file.relPath)
        const { added, updated } = this.db.upsertMany(rootId, batch)
        found += batch.length
        if (added.length > 0 || updated.length > 0) {
          this.emit('change', { added, updated, removed: [], treeDirty: added.length > 0 })
        }
        this.emit('indexProgress', { found, scanning: true })
        // イベントループを明け渡し、UI の応答性を保つ
        await new Promise((resolve) => setImmediate(resolve))
      }

      if (generation !== this.generation) return

      // 走査で見つからなかった = 監視外で削除されたもの
      const removed: number[] = []
      for (const [relPath, entry] of known) {
        if (!seen.has(relPath)) removed.push(entry.id)
      }
      if (removed.length > 0) {
        this.db.removeIds(removed)
        this.emit('change', { added: [], updated: [], removed, treeDirty: true })
      }
    } finally {
      if (generation === this.generation) {
        this.indexing = false
        this.emit('indexProgress', { found, scanning: false })
      }
    }
  }

  // -------------------------------------------------------------- watching

  private startWatching(rootPath: string): void {
    const watcher = chokidar.watch(rootPath, {
      ignoreInitial: true,
      followSymlinks: false,
      // 書き込み途中のファイルを掴まないよう、サイズが安定するまで待つ
      awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
      // 隠しフォルダは無視する。ただしルート自体が隠しフォルダの場合は監視する
      ignored: (target: string) => target !== rootPath && path.basename(target).startsWith('.')
    })

    watcher.on('add', (file) => this.queueUpsert(file))
    watcher.on('change', (file) => this.queueUpsert(file))
    watcher.on('unlink', (file) => this.queueRemove(file))
    watcher.on('unlinkDir', (dir) => this.queueRemoveDir(dir))
    watcher.on('addDir', () => this.scheduleFlush())
    watcher.on('error', (error) => console.error('[watcher]', error))

    this.watcher = watcher
  }

  private queueUpsert(file: string): void {
    if (!isSupportedImage(file)) return
    this.pendingUpsert.add(file)
    this.pendingRemove.delete(file)
    this.scheduleFlush()
  }

  private queueRemove(file: string): void {
    if (!isSupportedImage(file)) return
    this.pendingRemove.add(file)
    this.pendingUpsert.delete(file)
    this.scheduleFlush()
  }

  private queueRemoveDir(dir: string): void {
    this.pendingRemoveDir.add(dir)
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, WATCH_DEBOUNCE)
  }

  /** 溜まった監視イベントをまとめて DB へ適用する。 */
  private async flush(): Promise<void> {
    const rootId = this.rootId
    const rootPath = this.rootPath
    if (rootId === null || rootPath === null) return

    const upserts = [...this.pendingUpsert]
    const removes = [...this.pendingRemove]
    const removeDirs = [...this.pendingRemoveDir]
    this.pendingUpsert.clear()
    this.pendingRemove.clear()
    this.pendingRemoveDir.clear()

    const files: ImageUpsert[] = []
    for (const fullPath of upserts) {
      const relPath = toRelPath(rootPath, fullPath)
      if (relPath.startsWith('..')) continue
      const { dirPath, fileName } = splitRelPath(relPath)

      // 走査と同じ理由で、止められている間は stat しない
      if (this.gate && !this.gate.allow()) {
        files.push({ relPath, dirPath, fileName, mtime: 0, size: 0 })
        continue
      }
      try {
        const startedAt = Date.now()
        const stats = await fs.stat(fullPath)
        this.gate?.record(Date.now() - startedAt)
        files.push({
          relPath,
          dirPath,
          fileName,
          mtime: Math.floor(stats.mtimeMs),
          size: stats.size
        })
      } catch {
        // flush 待ちの間に消えたファイル
      }
    }

    const { added, updated } = files.length > 0 ? this.db.upsertMany(rootId, files) : { added: [], updated: [] }

    const removed: number[] = []
    for (const fullPath of removes) {
      const id = this.db.removeByRelPath(rootId, toRelPath(rootPath, fullPath))
      if (id !== null) removed.push(id)
    }
    for (const dir of removeDirs) {
      removed.push(...this.db.removeUnderDir(rootId, toRelPath(rootPath, dir)))
    }

    if (added.length > 0 || updated.length > 0 || removed.length > 0 || removeDirs.length > 0) {
      this.emit('change', {
        added,
        updated,
        removed,
        treeDirty: added.length > 0 || removed.length > 0 || removeDirs.length > 0
      })
    }
  }
}
