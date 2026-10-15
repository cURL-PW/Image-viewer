import { EventEmitter } from 'node:events'
import { watch, type FSWatcher } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { SUPPORTED_EXTENSIONS, type LibraryChange } from '@shared/types'
import { debugLog } from './debug-log'
import type { ImageUpsert, LibraryDb } from './db'

const EXTENSIONS = new Set<string>(SUPPORTED_EXTENSIONS)
/** 走査結果をこの枚数ごとに DB へ流し込み、走査中でも UI に反映させる */
const WALK_BATCH = 1000
/**
 * ファイル監視イベントをまとめて処理するまでの待ち時間 (ms)。
 * chokidar の awaitWriteFinish の代わりでもあるので、書き込みが落ち着くまで待てる長さにする。
 */
const WATCH_DEBOUNCE = 800
/** 走査中の change / indexProgress をまとめる間隔 (ms) */
const PROGRESS_INTERVAL = 500
/** 走査 1 件ごとの記録をまとめる件数 */
const WALK_LOG_INTERVAL = 1000
/** これより遅い stat は 1 件ずつ記録する (クラウドの実体取得を捕まえるため) */
const SLOW_STAT_MS = 200
/** 監視イベントでファイル名が取れなかったときに、全走査へ切り替えるまでの待ち時間 (ms) */
const RESCAN_DEBOUNCE = 5000
/** 監視イベントの記録をまとめる件数 */
const WATCH_LOG_INTERVAL = 200
/** 監視が落ちたときに張り直すまでの待ち時間 (ms) */
const WATCH_RESTART_DELAY = 2000

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
    const readStartedAt = Date.now()
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue // 権限がない等のディレクトリはスキップ
    }
    debugLog().log({
      kind: 'walk-readdir',
      decision: 'allowed',
      ms: Date.now() - readStartedAt,
      target: dir,
      note: `${entries.length} 件`
    })


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
        // 1 件ずつ出すと 9 万行になるのでまとめる
        debugLog().countEvent(WALK_LOG_INTERVAL, {
          kind: 'walk-stat',
          decision: 'blocked',
          target: relPath
        })
        // stat できていない = mtime / size は不明。既存の値を壊さないよう印を付ける
        batch.push({ fullPath, relPath, dirPath, fileName, mtime: 0, size: 0, statSkipped: true })
      } else {
        try {
          const startedAt = Date.now()
          const stats = await fs.stat(fullPath)
          const elapsed = Date.now() - startedAt
          gate?.record(elapsed)
          const event = { kind: 'walk-stat', decision: 'allowed' as const, ms: elapsed, target: relPath }
          // 遅い 1 件は埋もれさせない。クラウドの実体取得はここに出る
          if (elapsed >= SLOW_STAT_MS) debugLog().log(event)
          else debugLog().countEvent(WALK_LOG_INTERVAL, event)
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

  /** 監視で変化を検知したパス。追加か削除かは flush 時に判定する */
  private pendingChange = new Set<string>()
  private flushTimer: NodeJS.Timeout | null = null
  private rescanTimer: NodeJS.Timeout | null = null
  private restartTimer: NodeJS.Timeout | null = null

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

  /** ルートを閉じ、何も開いていない状態へ戻す (開いているライブラリの登録を外したとき)。 */
  async close(): Promise<void> {
    await this.stop()
    this.rootId = null
    this.rootPath = null
  }

  async stop(): Promise<void> {
    this.generation++
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.rescanTimer) {
      clearTimeout(this.rescanTimer)
      this.rescanTimer = null
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this.pendingChange.clear()
    if (this.watcher) {
      this.watcher.close()
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

    const log = debugLog()
    const startedAt = Date.now()
    log.log({ kind: 'walk-start', target: rootPath })

    const known = this.db.allRelPaths(rootId)
    const seen = new Set<string>()
    let found = 0
    // 走査中の通知はまとめる。1 バッチごとに投げると renderer が毎回
    // 全件を引き直し、9 万枚では往復だけで数十秒になる
    let lastEmit = 0
    let pendingAdded: number[] = []
    let pendingUpdated: number[] = []

    const emitPending = (force: boolean): void => {
      const now = Date.now()
      if (!force && now - lastEmit < PROGRESS_INTERVAL) return
      lastEmit = now
      if (pendingAdded.length > 0 || pendingUpdated.length > 0) {
        this.emit('change', {
          added: pendingAdded,
          updated: pendingUpdated,
          removed: [],
          treeDirty: pendingAdded.length > 0
        })
        pendingAdded = []
        pendingUpdated = []
      }
      this.emit('indexProgress', { found, scanning: true })
    }

    try {
      for await (const batch of walkImages(rootPath, { gate: this.gate })) {
        if (generation !== this.generation) return // ルートが切り替わった
        for (const file of batch) seen.add(file.relPath)
        const { added, updated } = this.db.upsertMany(rootId, batch, known)
        found += batch.length
        if (added.length > 0) pendingAdded.push(...added)
        if (updated.length > 0) pendingUpdated.push(...updated)
        emitPending(false)
        // イベントループを明け渡し、UI の応答性を保つ
        await new Promise((resolve) => setImmediate(resolve))
      }

      if (generation !== this.generation) return

      // 走査で見つからなかった = 監視外で削除されたもの
      const removed: number[] = []
      for (const [relPath, entry] of known) {
        if (!seen.has(relPath)) removed.push(entry.id)
      }
      emitPending(true)
      if (removed.length > 0) {
        this.db.removeIds(removed)
        this.emit('change', { added: [], updated: [], removed, treeDirty: true })
      }
      log.flushCounts()
      log.log({
        kind: 'walk-done',
        decision: 'allowed',
        ms: Date.now() - startedAt,
        target: rootPath,
        note: `${found} 件 (削除 ${removed.length})`
      })
    } catch (error) {
      // 例外で黙って止まると「固まった」のか「終わった」のか分からなくなる
      log.flushCounts()
      log.log({
        kind: 'walk-error',
        decision: 'skipped',
        ms: Date.now() - startedAt,
        target: rootPath,
        note: error instanceof Error ? error.message : String(error)
      })
      console.error('[library] 走査に失敗しました', error)
    } finally {
      if (generation === this.generation) {
        this.indexing = false
        this.emit('indexProgress', { found, scanning: false })
      }
    }
  }

  // -------------------------------------------------------------- watching

  /**
   * ルート配下を監視する。
   *
   * chokidar はやめた。9 万枚のフォルダで実測したところ、監視の準備だけで
   * **1 ファイルにつき 2 回の stat (計 18 万回) と 1 個ずつの watch ハンドル (9 万個)**
   * を作り、11〜25 秒と 400MB を使っていた。Windows の libuv は stat をファイルの
   * `CreateFileW` で実装するので、これは「起動のたびに全ファイルを開く」のと同じで、
   * クラウドの実体取得を誘発しうる。門番もログもすり抜ける経路だった。
   *
   * OS 標準の再帰監視ならハンドルは 1 つで、準備中にファイルを触らない。
   */
  private startWatching(rootPath: string): void {
    try {
      const watcher = watch(rootPath, { recursive: true, persistent: true }, (eventType, name) => {
        // 取りこぼし (プラットフォームによっては名前が来ない) は全走査で拾い直す
        if (!name) {
          this.scheduleRescan()
          return
        }
        const relative = name.toString()
        // 隠しフォルダ配下は対象外
        if (relative.split(/[\\/]/).some((segment) => segment.startsWith('.'))) return

        debugLog().countEvent(WATCH_LOG_INTERVAL, {
          kind: `watch-${eventType}`,
          target: relative
        })
        this.queueChange(path.join(rootPath, relative))
      })

      watcher.on('error', (error) => {
        console.error('[watcher]', error)
        debugLog().log({ kind: 'watch-error', decision: 'skipped', note: String(error) })
        this.restartWatching(rootPath)
      })
      this.watcher = watcher
    } catch (error) {
      // 再帰監視に対応していない環境では、変更の取り込みだけ全走査に頼る
      console.error('[watcher] 監視を開始できませんでした', error)
      debugLog().log({ kind: 'watch-error', decision: 'skipped', note: String(error) })
    }
  }

  /** 監視が落ちたら間を置いて張り直す。 */
  private restartWatching(rootPath: string): void {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
    if (this.restartTimer) return
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.rootPath === rootPath) this.startWatching(rootPath)
    }, WATCH_RESTART_DELAY)
  }

  /**
   * 監視イベントを受けたパスを控える。
   *
   * 再帰監視は「追加」「更新」「削除」を区別しないので、まとめて処理する時点で
   * 実際に在るかどうかを見て決める。拡張子の無いものはフォルダかもしれないので拾う
   * (フォルダごと消えた場合に配下をまとめて外すため)。
   */
  private queueChange(fullPath: string): void {
    if (!isSupportedImage(fullPath) && path.extname(fullPath) !== '') return
    this.pendingChange.add(fullPath)
    this.scheduleFlush()
  }

  /** 取りこぼしたときの保険。間を置いて全走査をやり直す。 */
  private scheduleRescan(): void {
    if (this.rescanTimer) return
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null
      if (this.indexing) {
        this.scheduleRescan()
        return
      }
      debugLog().log({ kind: 'walk-start', note: '監視の取りこぼしを拾い直す' })
      void this.syncAll(this.generation)
    }, RESCAN_DEBOUNCE)
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, WATCH_DEBOUNCE)
  }

  /**
   * 溜まった監視イベントをまとめて DB へ適用する。
   * 再帰監視は追加・更新・削除を区別しないので、実際に在るかどうかで振り分ける。
   */
  private async flush(): Promise<void> {
    const rootId = this.rootId
    const rootPath = this.rootPath
    if (rootId === null || rootPath === null) return

    const changed = [...this.pendingChange]
    this.pendingChange.clear()

    const files: ImageUpsert[] = []
    const removed: number[] = []

    for (const fullPath of changed) {
      const relPath = toRelPath(rootPath, fullPath)
      if (relPath.startsWith('..')) continue
      const { dirPath, fileName } = splitRelPath(relPath)

      // 止められている間は stat しない。在るかどうかだけを、データを読まない方法で見る
      if (this.gate && !this.gate.allow()) {
        debugLog().log({ kind: 'flush-stat', decision: 'blocked', target: relPath })
        if (await exists(fullPath)) {
          if (isSupportedImage(fullPath)) {
            files.push({ relPath, dirPath, fileName, mtime: 0, size: 0, statSkipped: true })
          }
        } else {
          removed.push(...this.removePath(rootId, relPath))
        }
        continue
      }

      try {
        const startedAt = Date.now()
        const stats = await fs.stat(fullPath)
        const elapsed = Date.now() - startedAt
        this.gate?.record(elapsed)
        debugLog().log({ kind: 'flush-stat', decision: 'allowed', ms: elapsed, target: relPath })
        if (stats.isFile() && isSupportedImage(fullPath)) {
          files.push({
            relPath,
            dirPath,
            fileName,
            mtime: Math.floor(stats.mtimeMs),
            size: stats.size
          })
        }
      } catch {
        // 消えていた。ファイルとフォルダの両方を試す
        debugLog().log({ kind: 'flush-stat', decision: 'skipped', target: relPath, note: '消えた' })
        removed.push(...this.removePath(rootId, relPath))
      }
    }

    const { added, updated } =
      files.length > 0 ? this.db.upsertMany(rootId, files) : { added: [], updated: [] }

    if (added.length > 0 || updated.length > 0 || removed.length > 0) {
      this.emit('change', {
        added,
        updated,
        removed,
        treeDirty: added.length > 0 || removed.length > 0
      })
    }
  }

  /** 消えたパスを DB から外す。フォルダごと消えた場合は配下もまとめて外す。 */
  private removePath(rootId: number, relPath: string): number[] {
    const id = this.db.removeByRelPath(rootId, relPath)
    if (id !== null) return [id]
    return this.db.removeUnderDir(rootId, relPath)
  }
}

/**
 * ファイルが在るかどうかだけを調べる。
 * `access` は属性しか見ないので、クラウドの未ダウンロードファイルでも実体は取りに行かない。
 */
async function exists(fullPath: string): Promise<boolean> {
  try {
    await fs.access(fullPath)
    return true
  } catch {
    return false
  }
}
