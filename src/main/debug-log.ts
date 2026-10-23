import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * ファイルに触れた操作をすべて記録するデバッグログ。
 *
 * クラウド同期フォルダでダウンロードが止まらない問題を、推測ではなく
 * 実測で追うためのもの。「5 秒級の行の直前に何が走っていたか」が分かれば
 * ダウンロードを起こしている経路が確定する。
 */

export type LogDecision = 'allowed' | 'blocked' | 'forced' | 'cached' | 'skipped' | '-'

export interface LogEvent {
  /** 操作の種別 (walk-stat, thumb-gen, open-image ...) */
  kind: string
  decision?: LogDecision
  /** 所要時間 (ms) */
  ms?: number
  /** ルートからの相対パス。無ければ省略 */
  target?: string
  /** 補足 (判定の根拠、エラー内容など) */
  note?: string
}

/** ログをまとめて書き出すまでの待ち時間 (ms)。計測自体が遅さの原因にならないように */
const FLUSH_INTERVAL = 300
/** これを超えたら 1 世代だけ退避する */
const MAX_BYTES = 8 * 1024 * 1024

/** 1 イベントを 1 行に整形する。タブ区切りでそのまま貼れる形にする。 */
export function formatEvent(event: LogEvent, now = new Date()): string {
  const columns = [
    now.toISOString(),
    event.kind.padEnd(14),
    (event.decision ?? '-').padEnd(8),
    event.ms === undefined ? '-'.padStart(7) : `${Math.round(event.ms)}ms`.padStart(7),
    event.target ?? '-'
  ]
  if (event.note) columns.push(event.note)
  return columns.join('\t')
}

/** 集約中の記録 */
interface Counter {
  total: number
  sinceLast: number
  msTotal: number
  last: LogEvent
}

export class DebugLog {
  private buffer: string[] = []
  private timer: NodeJS.Timeout | null = null
  private writing: Promise<void> = Promise.resolve()
  private counters = new Map<string, Counter>()

  constructor(
    private readonly file: string,
    private enabled: boolean
  ) {}

  get filePath(): string {
    return this.file
  }

  get isEnabled(): boolean {
    return this.enabled
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return
    // 止めるときは、止めた事実を残してから書き込みを閉じる
    if (!enabled) {
      this.log({ kind: 'log', note: '記録を停止しました' })
      this.enabled = false
      void this.flush()
      return
    }
    this.enabled = true
    this.log({ kind: 'log', note: '記録を開始しました' })
  }

  log(event: LogEvent): void {
    if (!this.enabled) return
    this.buffer.push(formatEvent(event))
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, FLUSH_INTERVAL)
  }

  /**
   * 1 ファイルごとに出ると溢れる記録 (走査など) を、件数ごとに 1 行へまとめる。
   * 端数は `flushCounts` で出す。遅い 1 件だけは `log` で個別に残すとよい。
   */
  countEvent(interval: number, event: LogEvent): void {
    if (!this.enabled) return
    const key = `${event.kind}\t${event.decision ?? '-'}`
    const counter = this.counters.get(key) ?? { total: 0, sinceLast: 0, msTotal: 0, last: event }
    counter.total++
    counter.sinceLast++
    counter.msTotal += event.ms ?? 0
    counter.last = event
    this.counters.set(key, counter)
    if (counter.sinceLast >= interval) this.emitCount(counter)
  }

  /** 集約中の端数を出し切る (走査の完了時など)。 */
  flushCounts(): void {
    for (const counter of this.counters.values()) this.emitCount(counter)
    this.counters.clear()
  }

  private emitCount(counter: Counter): void {
    if (counter.sinceLast === 0) return
    const average = counter.msTotal > 0 ? ` 平均 ${Math.round(counter.msTotal / counter.sinceLast)}ms` : ''
    this.log({
      kind: counter.last.kind,
      decision: counter.last.decision,
      note: `${counter.sinceLast} 件 (累計 ${counter.total})${average} 例: ${counter.last.target ?? '-'}`
    })
    counter.sinceLast = 0
    counter.msTotal = 0
  }

  /**
   * 経過時間を測って記録するためのヘルパー。
   * 例外が出た場合も所要時間と内容を残す。
   */
  async measure<T>(event: LogEvent, work: () => Promise<T>): Promise<T> {
    if (!this.enabled) return work()
    const startedAt = Date.now()
    try {
      const result = await work()
      this.log({ ...event, ms: Date.now() - startedAt })
      return result
    } catch (error) {
      this.log({
        ...event,
        ms: Date.now() - startedAt,
        decision: 'skipped',
        note: `失敗: ${error instanceof Error ? error.message : String(error)}`
      })
      throw error
    }
  }

  /** 溜まった行を書き出す。呼び出しが重なっても順序が崩れないよう直列化する。 */
  flush(): Promise<void> {
    if (this.buffer.length === 0) return this.writing
    const lines = this.buffer.join('\n') + '\n'
    this.buffer = []

    this.writing = this.writing
      .then(async () => {
        await fsp.mkdir(path.dirname(this.file), { recursive: true })
        await this.rotateIfNeeded()
        await fsp.appendFile(this.file, lines, 'utf8')
      })
      .catch((error) => {
        console.warn('[debug-log] 書き込みに失敗', error)
      })
    return this.writing
  }

  private async rotateIfNeeded(): Promise<void> {
    try {
      const stats = await fsp.stat(this.file)
      if (stats.size < MAX_BYTES) return
      await fsp.rm(`${this.file}.1`, { force: true })
      await fsp.rename(this.file, `${this.file}.1`)
    } catch {
      // まだファイルが無い場合など
    }
  }

  /** 末尾から指定行数を読む。「直近をコピー」用。 */
  async tail(lines: number): Promise<string> {
    try {
      await this.flush()
      const content = await fsp.readFile(this.file, 'utf8')
      const all = content.split('\n').filter((line) => line !== '')
      return all.slice(-lines).join('\n')
    } catch {
      return ''
    }
  }

  /** 終了時に取りこぼしなく書き出す。 */
  async dispose(): Promise<void> {
    this.flushCounts()
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.flush()
  }

  /** ログを消す (調べ直すときに使う)。 */
  async clear(): Promise<void> {
    this.buffer = []
    await this.writing
    try {
      fs.rmSync(this.file, { force: true })
      fs.rmSync(`${this.file}.1`, { force: true })
    } catch {
      // 消せなくても致命的ではない
    }
  }
}

/**
 * main プロセス全体で共有するログ。
 *
 * 計測したい場所がファイルに触れる経路すべて (走査・監視・サムネイル・推論・
 * プロトコル) に散らばっているため、引数で持ち回らずここから取れるようにする。
 * 初期化されていない間は「無効なログ」を返すので、テストからは何も書かれない。
 */
const DISABLED = new DebugLog('', false)
let current: DebugLog | null = null

export function initDebugLog(file: string, enabled: boolean): DebugLog {
  current = new DebugLog(file, enabled)
  return current
}

/** テストから差し替える。null で無効へ戻す。 */
export function setDebugLog(log: DebugLog | null): void {
  current = log
}

export function debugLog(): DebugLog {
  return current ?? DISABLED
}

/** 本体の処理が止まっていたとみなす長さ (ms) */
const STALL_THRESHOLD = 300
/** 止まっていないかを確かめる間隔 (ms) */
const STALL_CHECK_INTERVAL = 100

/**
 * 本体 (main プロセス) の処理が止まっていた時間を記録する。
 * 止まっている間は取り込みの受け口も応答できないので、何秒止まったかと、
 * 直前に何をしていたか (ログの前後の行) で原因を追えるようにする
 */
export function watchMainStalls(): () => void {
  let last = Date.now()
  const timer = setInterval(() => {
    const now = Date.now()
    const stalled = now - last - STALL_CHECK_INTERVAL
    last = now
    if (stalled >= STALL_THRESHOLD) debugLog().log({ kind: 'main-busy', ms: stalled })
  }, STALL_CHECK_INTERVAL)
  timer.unref?.()
  return () => clearInterval(timer)
}
