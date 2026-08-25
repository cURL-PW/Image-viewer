import path from 'node:path'
import { app, utilityProcess, type UtilityProcess } from 'electron'
import { IPC, type ImageRecord, type ScanCommand, type ScanProgress } from '@shared/types'
import { broadcast } from '../context'
import type { CloudGuard } from '../cloud-guard'
import type { LibraryDb } from '../db'
import type { DerivedImageCache } from '../image-cache'
import type { Library } from '../library'
import type { SettingsStore } from '../settings'
import { ensureModel } from './model'
import { providerCandidates, type WorkerRequest, type WorkerResponse } from './protocol'

/** DB から一度に先読みする未スキャン画像の件数 */
const QUEUE_CHUNK = 64
/** 進捗ブロードキャストの最小間隔 (ms) */
const PROGRESS_INTERVAL = 250
/** 未ダウンロードのクラウドファイルに付ける印 */
export const PLACEHOLDER_MESSAGE = '未ダウンロード (iCloud などのオンデマンドファイル)'
/** 一括ダウンロードの同時実行数。回線と待ち時間に優しくする */
const DOWNLOAD_CONCURRENCY = 2
/** 未ダウンロードを飛ばす際、何件ごとに進捗を数え直すか */
const SKIP_PROGRESS_INTERVAL = 200
/** 同じ画像でワーカーが連続クラッシュした場合に諦めるまでの回数 */
const MAX_JOB_RETRIES = 2

/**
 * 未スキャン画像を順番にワーカーへ流し、結果を DB へ保存するバックグラウンドサービス。
 * 推論は 1 件ずつ行い、UI 操作や走査を妨げないようにする。
 */
export class TaggerService {
  private worker: UtilityProcess | null = null
  private workerReady = false
  private preparing: Promise<void> | null = null
  private disposed = false

  private queue: ImageRecord[] = []
  private currentJob: { id: number; record: ImageRecord; retries: number } | null = null
  private nextJobId = 1

  private paused = false
  private priorityDir: string | null = null
  private lastBroadcast = 0
  private progressTimer: NodeJS.Timeout | null = null

  private progress: ScanProgress = {
    done: 0,
    total: 0,
    current: null,
    provider: null,
    state: 'idle',
    modelProgress: null,
    message: null,
    cloudMode: false,
    cloudReason: null,
    notDownloaded: 0,
    download: null
  }

  /** 実行中の一括ダウンロード。中断のためにフラグを持つ */
  private downloadJob: { cancelled: boolean } | null = null
  /** 未ダウンロードを飛ばした回数。進捗の再計算を間引くために使う */
  private skipped = 0

  constructor(
    private db: LibraryDb,
    private library: Library,
    private settings: SettingsStore,
    private guard: CloudGuard,
    private thumbs: DerivedImageCache,
    private modelCacheDir = path.join(app.getPath('userData'), 'models')
  ) {
    // クラウドモードの出入りを進捗へ反映し、自動タグ付けの可否を切り替える
    this.guard.on('change', () => {
      this.refreshProgress()
      this.pump()
    })
  }

  getProgress(): ScanProgress {
    return this.progress
  }

  /** グリッドで表示中のフォルダを優先してタグ付けする。 */
  setPriorityDir(dir: string | null): void {
    if (this.priorityDir === dir) return
    this.priorityDir = dir
    // 先読み済みのキューを捨てて、新しい優先度で取り直す
    this.queue = []
    this.pump()
  }

  /** ライブラリに変更があったときに呼ぶ。停止していたスキャンを再開させる。 */
  notifyLibraryChanged(): void {
    this.queue = []
    this.refreshProgress()
    this.pump()
  }

  async handleCommand(command: ScanCommand): Promise<void> {
    const rootId = this.library.currentRootId
    switch (command) {
      case 'pause':
        this.paused = true
        this.setState('paused')
        break
      case 'resume':
        this.paused = false
        this.pump()
        break
      case 'rescanAll':
        if (rootId !== null) this.db.resetScanState(rootId, false)
        this.queue = []
        this.paused = false
        this.pump()
        break
      case 'retryErrors':
        if (rootId !== null) this.db.resetScanState(rootId, true)
        this.queue = []
        this.paused = false
        this.pump()
        break
    }
    this.refreshProgress()
  }

  /** モデルやしきい値が変わったらワーカーを作り直し、必要なら再スキャンする。 */
  async applySettingsChange(modelChanged: boolean): Promise<void> {
    if (modelChanged) {
      const rootId = this.library.currentRootId
      if (rootId !== null) this.db.resetScanState(rootId, false)
      this.queue = []
      await this.disposeWorker()
      this.preparing = null
      this.progress = { ...this.progress, provider: null }
    }
    this.refreshProgress()
    this.pump()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.progressTimer) clearTimeout(this.progressTimer)
    await this.disposeWorker()
  }

  /**
   * 指定フォルダ配下を順にダウンロードし、タグ付けの対象へ戻す。
   *
   * サムネイル生成を force で走らせることで実体を落とし、あわせて
   * サムネイルも作ってしまう。クラウド側に優しくするため少数並列で行う。
   */
  async downloadFolder(dir: string, recursive: boolean): Promise<void> {
    const rootId = this.library.currentRootId
    const rootPath = this.library.currentRootPath
    if (rootId === null || rootPath === null || this.downloadJob) return

    const ids = this.db.queryImageIds(rootId, {
      dir,
      recursive,
      includeTags: [],
      excludeTags: [],
      tagMode: 'and',
      sortKey: 'path',
      sortOrder: 'asc'
    })

    const job = { cancelled: false }
    this.downloadJob = job
    this.progress = { ...this.progress, download: { done: 0, total: ids.length, current: null } }
    this.broadcastProgress(true)

    let done = 0
    const next = async (): Promise<void> => {
      while (!job.cancelled) {
        const id = ids[done]
        if (id === undefined) return
        done++

        const record = this.db.getImage(id)
        if (!record) continue

        this.progress = {
          ...this.progress,
          download: { done, total: ids.length, current: record.fileName }
        }
        this.broadcastProgress()

        const filePath = path.resolve(rootPath, record.relPath)
        try {
          // force で門番を素通りし、実体を落としてサムネイルまで作る
          await this.thumbs.get(record, filePath, { force: true })
          // 落ちてきたので、未ダウンロード一覧から外してタグ付け対象へ戻す
          this.guard.markDownloaded(filePath)
          this.db.clearScanError(id, PLACEHOLDER_MESSAGE)
        } catch (error) {
          console.warn('[tagger] ダウンロードに失敗', record.relPath, error)
        }
      }
    }

    try {
      await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, next))
    } finally {
      if (this.downloadJob === job) this.downloadJob = null
      this.progress = { ...this.progress, download: null }
      // ユーザーが明示的に落としたフォルダなので、クラウドモードを解いてタグ付けへ進む。
      // まだ未ダウンロードのものが残っていれば、門番がまた止めてくれる。
      if (!job.cancelled) this.guard.setCloudMode(false)
      this.refreshProgress()
      this.broadcastProgress(true)
      // 落としたものをタグ付けし直す
      this.queue = []
      this.pump()
    }
  }

  cancelDownload(): void {
    if (this.downloadJob) this.downloadJob.cancelled = true
  }

  // ------------------------------------------------------------- internals

  private async disposeWorker(): Promise<void> {
    const worker = this.worker
    this.worker = null
    this.workerReady = false
    this.currentJob = null
    if (!worker) return
    try {
      worker.postMessage({ type: 'shutdown' } satisfies WorkerRequest)
    } catch {
      // すでに終了している
    }
    worker.kill()
  }

  /** キューを補充し、空いていれば次の 1 件をワーカーへ送る。 */
  private pump(): void {
    if (this.disposed || this.paused || this.currentJob) return
    const rootId = this.library.currentRootId
    if (rootId === null) return
    if (!this.settings.get().autoScan) {
      this.setState('idle')
      return
    }
    // クラウド同期フォルダとみなしている間は、勝手にダウンロードを起こさない。
    // 「まとめてダウンロードしてタグ付け」か「常に読み込む」で明示的に再開する。
    if (!this.guard.allowAutoRead()) {
      this.setState('paused')
      return
    }

    if (this.queue.length === 0) {
      this.queue = this.db.nextUnscanned(
        rootId,
        this.settings.get().modelId,
        this.priorityDir,
        QUEUE_CHUNK
      )
    }

    if (this.queue.length === 0) {
      // 走査中ならこの後追加される可能性があるので idle にとどめる
      this.setState('idle')
      this.skipped = 0
      this.refreshProgress()
      return
    }

    if (!this.workerReady) {
      void this.prepareWorker()
      return
    }

    const record = this.queue.shift() as ImageRecord
    void this.dispatch(record)
  }

  private async dispatch(record: ImageRecord): Promise<void> {
    const rootPath = this.library.currentRootPath
    if (!rootPath || !this.worker) {
      // 取り出した 1 件を捨てずにキューへ戻す
      this.queue.unshift(record)
      return
    }

    // await をまたぐ前に処理枠を押さえる。ここで currentJob を空のままにすると
    // 次の pump() が同時に走り、2 件が並行してワーカーへ流れてしまう。
    const job = { id: this.nextJobId++, record, retries: 0 }
    this.currentJob = job

    const filePath = path.resolve(rootPath, record.relPath)

    // iCloud のオンデマンドファイルは、読むとダウンロードが始まる。
    // ライブラリ全体を順に読む処理なので、実体が無いものは飛ばす。
    // scan_error に記録しておけば「失敗した画像を再試行」でやり直せる。
    if (await this.guard.isNotDownloaded(filePath)) {
      this.currentJob = null
      this.db.setScanError(record.id, PLACEHOLDER_MESSAGE)
      // 未ダウンロードが数万件あることもあるので、進捗の再計算は間引く
      // (COUNT を 1 件ごとに走らせると、飛ばすだけで時間がかかってしまう)
      this.skipped++
      if (this.skipped % SKIP_PROGRESS_INTERVAL === 0) this.refreshProgress()
      this.pump()
      return
    }

    this.progress = { ...this.progress, current: record.fileName }
    this.setState('running')

    const settings = this.settings.get()
    this.worker.postMessage({
      type: 'infer',
      jobId: job.id,
      filePath,
      generalThreshold: settings.generalThreshold,
      characterThreshold: settings.characterThreshold
    } satisfies WorkerRequest)
  }

  /** モデルの準備 (必要ならダウンロード) とワーカー起動。多重起動しないよう promise を共有する。 */
  private prepareWorker(): Promise<void> {
    if (this.preparing) return this.preparing

    this.preparing = (async () => {
      const settings = this.settings.get()
      this.setState('preparing')
      this.progress = { ...this.progress, message: 'モデルを準備しています', modelProgress: null }
      this.broadcastProgress(true)

      try {
        const files = await ensureModel(this.modelCacheDir, settings.modelId, (fraction, label) => {
          this.progress = { ...this.progress, modelProgress: fraction, message: label }
          this.broadcastProgress()
        })
        if (this.disposed) return
        this.progress = { ...this.progress, modelProgress: null, message: 'モデルを読み込み中' }
        this.broadcastProgress(true)
        await this.spawnWorker(files.modelPath, files.tagsPath)
      } catch (error) {
        this.progress = {
          ...this.progress,
          modelProgress: null,
          message: describe(error),
          state: 'error'
        }
        this.broadcastProgress(true)
      } finally {
        this.preparing = null
      }
    })()

    return this.preparing
  }

  private spawnWorker(modelPath: string, tagsPath: string): Promise<void> {
    return new Promise((resolve) => {
      const scriptPath = path.join(__dirname, 'tagger-worker.js')
      const worker = utilityProcess.fork(scriptPath, [], {
        serviceName: 'wd14-tagger',
        stdio: 'inherit'
      })
      this.worker = worker

      worker.on('message', (message: WorkerResponse) => this.onWorkerMessage(message, resolve))
      worker.on('exit', (code) => this.onWorkerExit(worker, code, resolve))

      worker.postMessage({
        type: 'init',
        modelPath,
        tagsPath,
        providers: providerCandidates(this.settings.get().provider)
      } satisfies WorkerRequest)
    })
  }

  private onWorkerMessage(message: WorkerResponse, resolveInit: () => void): void {
    switch (message.type) {
      case 'ready':
        this.workerReady = true
        this.progress = {
          ...this.progress,
          provider: message.provider,
          message: null,
          modelProgress: null
        }
        resolveInit()
        this.pump()
        break

      case 'initError':
        this.workerReady = false
        this.progress = { ...this.progress, state: 'error', message: message.message }
        this.broadcastProgress(true)
        resolveInit()
        break

      case 'result': {
        const job = this.currentJob
        if (!job || job.id !== message.jobId) break
        this.currentJob = null
        this.db.saveTags(job.record.id, this.settings.get().modelId, message.tags)
        if (message.width > 0 && message.height > 0) {
          this.db.setDimensions(job.record.id, message.width, message.height)
        }
        broadcast(IPC.eventImageTagged, { id: job.record.id })
        this.refreshProgress()
        this.pump()
        break
      }

      case 'error': {
        const job = this.currentJob
        if (!job || job.id !== message.jobId) break
        this.currentJob = null
        this.db.setScanError(job.record.id, message.message)
        this.refreshProgress()
        this.pump()
        break
      }

      case 'log':
        console.info('[tagger]', message.message)
        break
    }
  }

  private onWorkerExit(worker: UtilityProcess, code: number, resolveInit: () => void): void {
    resolveInit()
    // 作り直した後に古いワーカーの exit が届くことがある。その場合に
    // 後始末を走らせると、起動したばかりのワーカーの参照まで消してしまう。
    if (this.worker !== worker) return

    this.workerReady = false
    this.worker = null
    if (this.disposed) return

    const job = this.currentJob
    this.currentJob = null

    if (job) {
      if (job.retries + 1 >= MAX_JOB_RETRIES) {
        // この画像でワーカーが繰り返し落ちるので、エラー扱いにして先へ進む
        this.db.setScanError(job.record.id, `ワーカーが異常終了しました (code ${code})`)
      } else {
        this.queue.unshift(job.record)
      }
    }

    console.warn(`[tagger] ワーカーが終了しました (code ${code})。再起動します`)
    this.preparing = null
    this.pump()
  }

  // -------------------------------------------------------------- progress

  private setState(state: ScanProgress['state']): void {
    if (this.progress.state === state) return
    this.progress = { ...this.progress, state }
    this.broadcastProgress(true)
  }

  private refreshProgress(): void {
    const cloud = this.guard.status
    const rootId = this.library.currentRootId
    if (rootId === null) {
      this.progress = {
        ...this.progress,
        done: 0,
        total: 0,
        notDownloaded: 0,
        cloudMode: cloud.cloudMode,
        cloudReason: cloud.reason
      }
      this.broadcastProgress()
      return
    }
    const counts = this.db.countUnscanned(rootId, this.settings.get().modelId)
    this.progress = {
      ...this.progress,
      done: counts.total - counts.pending,
      total: counts.total,
      notDownloaded: this.db.countScanErrors(rootId, PLACEHOLDER_MESSAGE),
      cloudMode: cloud.cloudMode,
      cloudReason: cloud.reason
    }
    this.broadcastProgress()
  }

  /** 高頻度な更新で renderer を溢れさせないよう間引く。 */
  private broadcastProgress(immediate = false): void {
    const now = Date.now()
    if (!immediate && now - this.lastBroadcast < PROGRESS_INTERVAL) {
      if (!this.progressTimer) {
        this.progressTimer = setTimeout(
          () => {
            this.progressTimer = null
            this.broadcastProgress(true)
          },
          PROGRESS_INTERVAL - (now - this.lastBroadcast)
        )
      }
      return
    }
    this.lastBroadcast = now
    broadcast(IPC.eventScanProgress, this.progress)
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
