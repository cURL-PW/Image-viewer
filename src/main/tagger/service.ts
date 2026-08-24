import path from 'node:path'
import { app, utilityProcess, type UtilityProcess } from 'electron'
import { IPC, type ImageRecord, type ScanCommand, type ScanProgress } from '@shared/types'
import { broadcast } from '../context'
import type { LibraryDb } from '../db'
import type { Library } from '../library'
import type { SettingsStore } from '../settings'
import { ensureModel } from './model'
import { providerCandidates, type WorkerRequest, type WorkerResponse } from './protocol'

/** DB から一度に先読みする未スキャン画像の件数 */
const QUEUE_CHUNK = 64
/** 進捗ブロードキャストの最小間隔 (ms) */
const PROGRESS_INTERVAL = 250
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
    message: null
  }

  constructor(
    private db: LibraryDb,
    private library: Library,
    private settings: SettingsStore,
    private modelCacheDir = path.join(app.getPath('userData'), 'models')
  ) {}

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
      this.refreshProgress()
      return
    }

    if (!this.workerReady) {
      void this.prepareWorker()
      return
    }

    const record = this.queue.shift() as ImageRecord
    this.dispatch(record)
  }

  private dispatch(record: ImageRecord): void {
    const rootPath = this.library.currentRootPath
    if (!rootPath || !this.worker) return

    const job = { id: this.nextJobId++, record, retries: 0 }
    this.currentJob = job
    this.progress = { ...this.progress, current: record.fileName }
    this.setState('running')

    const settings = this.settings.get()
    this.worker.postMessage({
      type: 'infer',
      jobId: job.id,
      filePath: path.resolve(rootPath, record.relPath),
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
      worker.on('exit', (code) => this.onWorkerExit(code, resolve))

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

  private onWorkerExit(code: number, resolveInit: () => void): void {
    this.workerReady = false
    this.worker = null
    resolveInit()
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
    const rootId = this.library.currentRootId
    if (rootId === null) {
      this.progress = { ...this.progress, done: 0, total: 0 }
      this.broadcastProgress()
      return
    }
    const counts = this.db.countUnscanned(rootId, this.settings.get().modelId)
    this.progress = {
      ...this.progress,
      done: counts.total - counts.pending,
      total: counts.total
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
