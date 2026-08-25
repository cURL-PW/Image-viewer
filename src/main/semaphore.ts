/**
 * 同時実行数を制限する。
 *
 * libuv のスレッドプールは既定 4 本しかなく (Electron 起動後に
 * UV_THREADPOOL_SIZE を変えても効かないことを実測で確認済み)、
 * 遅いファイル読み込みが並ぶとプールが埋まってフォルダ走査まで巻き添えで止まる。
 * 画像の派生生成はここで絞り、常にプールへ空きを残す。
 */
export class Semaphore {
  private active = 0
  private waiting: ((release: () => void) => void)[] = []

  constructor(private readonly limit: number) {}

  get activeCount(): number {
    return this.active
  }

  get waitingCount(): number {
    return this.waiting.length
  }

  /** 枠が空くまで待ち、解放用の関数を返す。 */
  acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++
      return Promise.resolve(this.createRelease())
    }
    return new Promise((resolve) => {
      this.waiting.push(resolve)
    })
  }

  private createRelease(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiting.shift()
      if (next) {
        // 枠はそのまま次へ渡す (active は減らさない)
        next(this.createRelease())
        return
      }
      this.active--
    }
  }
}
