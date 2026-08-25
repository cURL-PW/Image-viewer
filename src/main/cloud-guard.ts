import fs from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import type {
  CloudDiagnostics,
  PlaceholderSample,
  ReadKind,
  ReadSample
} from '@shared/types'
import { debugLog } from './debug-log'
import { normalizePath } from './win-placeholders'

/**
 * クラウド同期フォルダ (iCloud / OneDrive のオンデマンドファイル) を扱うための門番。
 *
 * 未ダウンロードのファイルは読むとダウンロードが始まり、1 枚あたり数秒かかる。
 * サムネイル生成やタグ付けが自動でそれを繰り返すと、通信も待ち時間も止まらなくなる。
 *
 * 状態は 2 つに分けて持つ。混ぜると「案内は出ているのに読み込みは止まっていない」
 * という取り違えが起きる (実際に一度そのバグを入れた)。
 *
 * - `cloudFolder` — 未ダウンロードの写真があるフォルダらしい。**案内を出すための情報**
 * - `blocked` — 自動読み込みを止めている。**実際に読ませないための状態**
 *
 * 未ダウンロードかどうかの判定も 2 段構えにしている:
 *
 * 1. **ファイル属性の一覧** — 1 枚ずつ確実に弾ける。ローカルの写真はそのまま扱えるので
 *    フォルダ全体を止めずに済む。ただし列挙の失敗やパスの食い違いで取りこぼしうる
 * 2. **遅さの回路遮断器** — 読み込みが遅い状態が続いたら、以後の自動読み込みを止める。
 *    1 が当たっていようがいまいが最後の砦として常に効かせる
 *
 * 逆に、ユーザーが明示的に開いた 1 枚や一括ダウンロードは門番を素通りさせる。
 * その読み込みが速ければ自動で解除する (自己回復)。
 */

export interface PlaceholderStats {
  size: number
  blocks: number
}

/**
 * 未ダウンロードのオンデマンドファイルらしいか。
 *
 * Windows では libuv が `st_blocks` に AllocationSize を入れるので、実体を持たない
 * ファイルは割り当てが 0 (または論理サイズよりはるかに小さい) になる。
 * 他の OS ではスパースファイルと区別が付かないため判定しない。
 */
export function isLikelyPlaceholder(
  stats: PlaceholderStats,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform !== 'win32') return false
  if (stats.size <= 0) return false
  if (!Number.isFinite(stats.blocks)) return false
  // 実体が半分も無いなら、まだ落ちてきていないとみなす
  return stats.blocks * 512 < stats.size / 2
}

export type CloudModeReason = 'placeholder' | 'slow' | 'manual' | 'remembered' | null

export interface CloudStatus {
  /** 未ダウンロードの写真があるフォルダとみなしているか (案内用) */
  cloudFolder: boolean
  /** 自動読み込みを止めているか (実際の遮断) */
  blocked: boolean
  reason: CloudModeReason
}

/** 診断で保持する履歴の件数 */
const SAMPLE_LIMIT = 20
/** 一覧による判定は件数が多いので、この件数ごとにまとめて 1 行だけ記録する */
const INDEX_LOG_INTERVAL = 200

export interface CloudGuardOptions {
  /** これを超える読み込みを「遅い」とみなす (ms) */
  slowReadMs: number
  /** 「遅い」が何回続いたら遮断するか */
  slowReadLimit: number
  /** 遮断中に「速い」が何回続いたら解除するか */
  fastRecoveryLimit: number
}

export const DEFAULT_CLOUD_GUARD_OPTIONS: CloudGuardOptions = {
  slowReadMs: 1500,
  slowReadLimit: 2,
  fastRecoveryLimit: 3
}

interface CloudGuardEvents {
  change: [CloudStatus]
}

export class CloudGuard extends EventEmitter<CloudGuardEvents> {
  private cloudFolder = false
  private blocked = false
  private reason: CloudModeReason = null
  private consecutiveSlow = 0
  private consecutiveFast = 0
  /** ユーザーが「常に読み込む」を選んだ場合は門番を無効化する */
  private alwaysRead = false
  private reads: ReadSample[] = []
  private placeholders: PlaceholderSample[] = []
  /**
   * ファイル属性から作った、未ダウンロードファイルの正確な一覧。
   * これがあれば推測が要らないので、フォルダ全体を止めずに 1 枚ずつ弾ける。
   */
  private placeholderIndex: Set<string> | null = null
  /** 一覧による判定の集計 (ログを溢れさせないため) */
  private indexHits = 0
  private indexMisses = 0

  constructor(private readonly options: CloudGuardOptions = DEFAULT_CLOUD_GUARD_OPTIONS) {
    super()
  }

  get status(): CloudStatus {
    return { cloudFolder: this.cloudFolder, blocked: this.blocked, reason: this.reason }
  }

  /** 未ダウンロードの写真があるフォルダとみなしているか。 */
  get isCloudFolder(): boolean {
    return this.cloudFolder
  }

  /** 自動読み込みを止めているか。「常に読み込む」は考慮しない生の状態。 */
  get isBlocked(): boolean {
    return this.blocked
  }

  /** 設定画面へ出す診断情報。 */
  get diagnostics(): CloudDiagnostics {
    return {
      ...this.status,
      alwaysRead: this.alwaysRead,
      exactIndex: this.placeholderIndex !== null,
      indexSize: this.placeholderIndex?.size ?? 0,
      platform: process.platform,
      slowReadMs: this.options.slowReadMs,
      reads: [...this.reads],
      placeholders: [...this.placeholders]
    }
  }

  /** 未ダウンロードファイルの正確な一覧があるか。 */
  get hasExactIndex(): boolean {
    return this.placeholderIndex !== null
  }

  /** ダウンロード済みになったファイルを一覧から外す。 */
  markDownloaded(filePath: string): void {
    if (this.placeholderIndex === null) return
    if (!this.placeholderIndex.delete(normalizePath(filePath))) return
    // 全部落ちたなら案内も遮断も解いてよい
    if (this.placeholderIndex.size === 0) this.release()
  }

  /**
   * ファイル属性から作った一覧を差し込む。null で推測モードへ戻す。
   *
   * 一覧があっても遮断は解除しない。列挙が成功しても、パスの食い違いなどで
   * 判定が外れることはありうる。そのときに全部読みに行かないよう、
   * 遅さの遮断器は最後の砦として残しておく。
   */
  setPlaceholderIndex(paths: Set<string> | null): void {
    this.placeholderIndex = paths
    this.indexHits = 0
    this.indexMisses = 0
    debugLog().log({
      kind: 'guard-index',
      decision: paths === null ? 'skipped' : 'allowed',
      note: paths === null ? '一覧なし (遅さの遮断器のみ)' : `未ダウンロード ${paths.size} 件`
    })
    if (paths && paths.size > 0) this.markCloudFolder('placeholder')
    else this.emitChange()
  }

  /**
   * サムネイル生成やタグ付けなど、自動で走る読み込みを許可してよいか。
   *
   * 判定の精度によらず、遮断中は必ず止める。1 枚ずつの判定 (`isNotDownloaded`) は
   * この先で別途行う。
   */
  allowAutoRead(): boolean {
    return this.alwaysRead || !this.blocked
  }

  /** 設定の「未ダウンロードの写真も読み込む」。 */
  setAlwaysRead(on: boolean): void {
    if (this.alwaysRead === on) return
    this.alwaysRead = on
    debugLog().log({
      kind: 'guard-mode',
      decision: on ? 'forced' : 'blocked',
      note: `常に読み込む=${on}`
    })
    this.emitChange()
  }

  /**
   * ルートを切り替えたら判定をやり直す。
   * 以前クラウドと判定したフォルダは、再び数枚ダウンロードして確かめ直さずに済むよう
   * `remembered` を渡して最初から遮断した状態で始められる。
   */
  reset(remembered = false): void {
    const changed = this.cloudFolder !== remembered || this.blocked !== remembered
    this.cloudFolder = remembered
    this.blocked = remembered
    this.reason = remembered ? 'remembered' : null
    this.consecutiveSlow = 0
    this.consecutiveFast = 0
    this.reads = []
    this.placeholders = []
    this.placeholderIndex = null
    this.indexHits = 0
    this.indexMisses = 0
    debugLog().log({
      kind: 'guard-mode',
      decision: remembered ? 'blocked' : 'allowed',
      note: remembered ? 'ルート切替 (以前の判定を復元)' : 'ルート切替 (判定をやり直す)'
    })
    if (changed) this.emitChange()
  }

  /**
   * ファイルが未ダウンロードらしいかを調べる。
   * 一覧も `stat` もファイルのデータを読まないので、読む前の足切りに使える。
   */
  async isNotDownloaded(filePath: string): Promise<boolean> {
    if (this.alwaysRead) return false

    // 属性から作った一覧があれば、それが答え。stat すら要らない。
    if (this.placeholderIndex !== null) {
      const hit = this.placeholderIndex.has(normalizePath(filePath))
      this.countIndexCheck(hit)
      return hit
    }

    if (process.platform !== 'win32') return false
    try {
      const startedAt = Date.now()
      const stats = await fs.stat(filePath)
      const verdict = isLikelyPlaceholder(stats)
      debugLog().log({
        kind: 'guard-stat',
        decision: verdict ? 'blocked' : 'allowed',
        ms: Date.now() - startedAt,
        target: filePath,
        note: `size=${stats.size} blocks=${stats.blocks}`
      })
      this.record(this.placeholders, {
        name: filePath.split(/[\\/]/).pop() ?? filePath,
        size: stats.size,
        blocks: stats.blocks,
        verdict
      })
      if (!verdict) return false
      // 一覧が無い状態で 1 件でも見つかったら、取りこぼしを恐れて全体を止める
      this.block('placeholder')
      return true
    } catch {
      return false
    }
  }

  /**
   * 読み込みにかかった時間を記録する。
   * 遅さが続けば遮断し、速さが続けば解除する。
   */
  recordRead(durationMs: number, kind: ReadKind = 'thumbnail'): void {
    this.record(this.reads, { kind, ms: Math.round(durationMs) })

    if (durationMs > this.options.slowReadMs) {
      this.consecutiveFast = 0
      this.consecutiveSlow++
      if (this.consecutiveSlow >= this.options.slowReadLimit) {
        this.block('slow')
      }
      return
    }

    this.consecutiveSlow = 0
    this.consecutiveFast++
    // 明示的に落としたファイルが速く読めるようになったら自動で戻す
    if (
      this.blocked &&
      this.reason !== 'manual' &&
      this.consecutiveFast >= this.options.fastRecoveryLimit
    ) {
      this.unblock('読み込みが速くなった')
    }
  }

  /** ユーザー操作で遮断を切り替える。 */
  setBlocked(on: boolean): void {
    if (on) {
      this.block('manual')
      return
    }
    this.release()
  }

  /** 案内も遮断も解く (一括ダウンロード後など)。 */
  release(): void {
    if (!this.cloudFolder && !this.blocked) return
    this.cloudFolder = false
    this.blocked = false
    this.reason = null
    this.consecutiveSlow = 0
    debugLog().log({ kind: 'guard-mode', decision: 'allowed', note: '解除' })
    this.emitChange()
  }

  /** 履歴を新しい順に一定件数だけ保持する。 */
  private record<T>(buffer: T[], sample: T): void {
    buffer.unshift(sample)
    if (buffer.length > SAMPLE_LIMIT) buffer.length = SAMPLE_LIMIT
  }

  /** 一覧による判定は件数が多いので、まとめて 1 行にする。 */
  private countIndexCheck(hit: boolean): void {
    if (hit) this.indexHits++
    else this.indexMisses++
    const total = this.indexHits + this.indexMisses
    if (total % INDEX_LOG_INTERVAL !== 0) return
    debugLog().log({
      kind: 'guard-index',
      decision: 'blocked',
      note: `一覧で判定 ${total} 件: 未ダウンロード ${this.indexHits} / ローカル ${this.indexMisses}`
    })
  }

  /** 未ダウンロードがあることだけを記録する (読み込みは止めない)。 */
  private markCloudFolder(reason: CloudModeReason): void {
    if (this.cloudFolder) return
    this.cloudFolder = true
    if (this.reason === null) this.reason = reason
    debugLog().log({
      kind: 'guard-mode',
      decision: 'allowed',
      note: `クラウドフォルダとして案内 (${reason})`
    })
    this.emitChange()
  }

  /** 自動読み込みを止める。 */
  private block(reason: CloudModeReason): void {
    if (this.blocked && this.reason === reason) return
    const wasBlocked = this.blocked
    this.blocked = true
    this.cloudFolder = true
    this.reason = reason
    this.consecutiveFast = 0
    debugLog().log({
      kind: 'guard-mode',
      decision: 'blocked',
      note: `自動読み込みを停止 (${reason})`
    })
    if (!wasBlocked || this.reason !== reason) this.emitChange()
  }

  private unblock(note: string): void {
    if (!this.blocked) return
    this.blocked = false
    this.consecutiveSlow = 0
    // 一覧に未ダウンロードが残っていれば、案内は出したままにする
    this.cloudFolder = (this.placeholderIndex?.size ?? 0) > 0
    this.reason = this.cloudFolder ? 'placeholder' : null
    debugLog().log({ kind: 'guard-mode', decision: 'allowed', note: `自動読み込みを再開 (${note})` })
    this.emitChange()
  }

  private emitChange(): void {
    this.emit('change', this.status)
  }
}

/** 未ダウンロードのため読み込みを見送ったことを表す。 */
export class NotDownloadedError extends Error {
  readonly notDownloaded = true

  constructor(message = '未ダウンロードのため読み込みを見送りました') {
    super(message)
    this.name = 'NotDownloadedError'
  }
}

export function isNotDownloadedError(error: unknown): error is NotDownloadedError {
  return error instanceof Error && (error as NotDownloadedError).notDownloaded === true
}
