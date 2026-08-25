import fs from 'node:fs/promises'
import { EventEmitter } from 'node:events'

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

export type CloudModeReason = 'placeholder' | 'slow' | 'manual' | null

export interface CloudStatus {
  cloudMode: boolean
  reason: CloudModeReason
}

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

  constructor(private readonly options: CloudGuardOptions = DEFAULT_CLOUD_GUARD_OPTIONS) {
    super()
  }

  get status(): CloudStatus {
    return { cloudMode: this.cloudMode, reason: this.reason }
  }

  get isCloudMode(): boolean {
    return this.cloudMode
  }

  /** サムネイル生成やタグ付けなど、自動で走る読み込みを許可してよいか。 */
  allowAutoRead(): boolean {
    return this.alwaysRead || !this.cloudMode
  }

  /** 設定の「未ダウンロードの写真も読み込む」。 */
  setAlwaysRead(on: boolean): void {
    if (this.alwaysRead === on) return
    this.alwaysRead = on
    this.emitChange()
  }

  /** ルートを切り替えたら判定をやり直す。 */
  reset(): void {
    const changed = this.cloudMode
    this.cloudMode = false
    this.reason = null
    this.consecutiveSlow = 0
    this.consecutiveFast = 0
    if (changed) this.emitChange()
  }

  /**
   * ファイルが未ダウンロードらしいかを調べる。
   * `stat` はダウンロードを起こさないので、読む前の足切りに使える。
   */
  async isNotDownloaded(filePath: string): Promise<boolean> {
    if (this.alwaysRead) return false
    if (process.platform !== 'win32') return false
    try {
      const stats = await fs.stat(filePath)
      if (!isLikelyPlaceholder(stats)) return false
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
  recordRead(durationMs: number): void {
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
