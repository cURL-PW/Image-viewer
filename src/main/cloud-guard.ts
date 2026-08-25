import fs from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import type {
  CloudDiagnostics,
  PlaceholderSample,
  ReadKind,
  ReadSample
} from '@shared/types'
import { normalizePath } from './win-placeholders'

/**
 * クラウド同期フォルダ (iCloud / OneDrive のオンデマンドファイル) を扱うための門番。
 *
 * 未ダウンロードのファイルは読むとダウンロードが始まり、1 枚あたり数秒かかる。
 * サムネイル生成やタグ付けが自動でそれを繰り返すと、通信も待ち時間も止まらなくなる。
 *
 * 判定は 2 段構えにしている:
 *
 * 1. **プレースホルダ属性の推測** — Windows で「論理サイズはあるが実体の割り当てが無い」
 *    ファイルを見つける。当たれば 1 枚も落とさずに済むが、同期クライアントの実装に依存する
 * 2. **遅さの回路遮断器** — 読み込みが遅い状態が続いたら、以後の自動読み込みを止める。
 *    OS の内部仕様に依存しないので、1 が外れてもここで確実に止まる
 *
 * 逆に、ユーザーが明示的に開いた 1 枚や一括ダウンロードは門番を素通りさせる。
 * その読み込みが速ければ自動でクラウドモードを解除する (自己回復)。
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
  cloudMode: boolean
  reason: CloudModeReason
}

/** 診断で保持する履歴の件数 */
const SAMPLE_LIMIT = 20

export interface CloudGuardOptions {
  /** これを超える読み込みを「遅い」とみなす (ms) */
  slowReadMs: number
  /** 「遅い」が何回続いたらクラウドモードへ入るか */
  slowReadLimit: number
  /** クラウドモード中に「速い」が何回続いたら解除するか */
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
  private cloudMode = false
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

  constructor(private readonly options: CloudGuardOptions = DEFAULT_CLOUD_GUARD_OPTIONS) {
    super()
  }

  get status(): CloudStatus {
    return { cloudMode: this.cloudMode, reason: this.reason }
  }

  get isCloudMode(): boolean {
    return this.cloudMode
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
    // 全部落ちたならクラウドモードを解いてよい
    if (this.placeholderIndex.size === 0) this.setCloudMode(false)
  }

  /** ファイル属性から作った一覧を差し込む。null で推測モードへ戻す。 */
  setPlaceholderIndex(paths: Set<string> | null): void {
    this.placeholderIndex = paths
    if (paths && paths.size > 0) this.enterCloudMode('placeholder')
    else this.emitChange()
  }

  /**
   * サムネイル生成やタグ付けなど、自動で走る読み込みを許可してよいか。
   *
   * 正確な一覧があるときは、どのファイルが危険かを個別に判定できるので
   * 全体を止める必要がない (ローカルにある写真はそのまま扱える)。
   */
  allowAutoRead(): boolean {
    if (this.alwaysRead) return true
    if (this.placeholderIndex !== null) return true
    return !this.cloudMode
  }

  /** 設定の「未ダウンロードの写真も読み込む」。 */
  setAlwaysRead(on: boolean): void {
    if (this.alwaysRead === on) return
    this.alwaysRead = on
    this.emitChange()
  }

  /**
   * ルートを切り替えたら判定をやり直す。
   * 以前クラウドと判定したフォルダは、再び数枚ダウンロードして確かめ直さずに済むよう
   * `remembered` を渡して最初からクラウドモードで始められる。
   */
  reset(remembered = false): void {
    const changed = this.cloudMode !== remembered
    this.cloudMode = remembered
    this.reason = remembered ? 'remembered' : null
    this.consecutiveSlow = 0
    this.consecutiveFast = 0
    this.reads = []
    this.placeholders = []
    this.placeholderIndex = null
    if (changed) this.emitChange()
  }

  /**
   * ファイルが未ダウンロードらしいかを調べる。
   * `stat` はダウンロードを起こさないので、読む前の足切りに使える。
   */
  async isNotDownloaded(filePath: string): Promise<boolean> {
    if (this.alwaysRead) return false

    // 属性から作った一覧があれば、それが答え。stat すら要らない。
    if (this.placeholderIndex !== null) {
      return this.placeholderIndex.has(normalizePath(filePath))
    }

    if (process.platform !== 'win32') return false
    try {
      const stats = await fs.stat(filePath)
      const verdict = isLikelyPlaceholder(stats)
      this.record(this.placeholders, {
        name: filePath.split(/[\\/]/).pop() ?? filePath,
        size: stats.size,
        blocks: stats.blocks,
        verdict
      })
      if (!verdict) return false
      // 1 件でも確実に見つかれば、この場でクラウドモードへ入れてよい
      this.enterCloudMode('placeholder')
      return true
    } catch {
      return false
    }
  }

  /**
   * 読み込みにかかった時間を記録する。
   * 遅さが続けばクラウドモードへ入り、速さが続けば解除する。
   */
  recordRead(durationMs: number, kind: ReadKind = 'thumbnail'): void {
    this.record(this.reads, { kind, ms: Math.round(durationMs) })

    if (durationMs > this.options.slowReadMs) {
      this.consecutiveFast = 0
      this.consecutiveSlow++
      if (this.consecutiveSlow >= this.options.slowReadLimit) {
        this.enterCloudMode('slow')
      }
      return
    }

    this.consecutiveSlow = 0
    this.consecutiveFast++
    // 明示的に落としたファイルが速く読めるようになったら自動で戻す
    if (
      this.cloudMode &&
      this.reason !== 'manual' &&
      this.consecutiveFast >= this.options.fastRecoveryLimit
    ) {
      this.cloudMode = false
      this.reason = null
      this.emitChange()
    }
  }

  /** ユーザー操作でクラウドモードを切り替える。 */
  setCloudMode(on: boolean): void {
    if (on) {
      this.enterCloudMode('manual')
      return
    }
    if (!this.cloudMode) return
    this.cloudMode = false
    this.reason = null
    this.consecutiveSlow = 0
    this.emitChange()
  }

  /** 履歴を新しい順に一定件数だけ保持する。 */
  private record<T>(buffer: T[], sample: T): void {
    buffer.unshift(sample)
    if (buffer.length > SAMPLE_LIMIT) buffer.length = SAMPLE_LIMIT
  }

  private enterCloudMode(reason: CloudModeReason): void {
    if (this.cloudMode) return
    this.cloudMode = true
    this.reason = reason
    this.consecutiveFast = 0
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
