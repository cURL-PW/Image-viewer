import { describe, expect, it } from 'vitest'
import { Semaphore } from './semaphore'

/** 分解して待てる Promise。 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('Semaphore', () => {
  it('上限までは即座に通す', async () => {
    const semaphore = new Semaphore(2)
    await semaphore.acquire()
    await semaphore.acquire()
    expect(semaphore.activeCount).toBe(2)
    expect(semaphore.waitingCount).toBe(0)
  })

  it('上限を超えた分は枠が空くまで待つ', async () => {
    const semaphore = new Semaphore(2)
    const first = await semaphore.acquire()
    await semaphore.acquire()

    let thirdStarted = false
    const third = semaphore.acquire().then((release) => {
      thirdStarted = true
      return release
    })

    expect(semaphore.waitingCount).toBe(1)
    expect(thirdStarted).toBe(false)

    first()
    await third
    expect(thirdStarted).toBe(true)
    expect(semaphore.activeCount).toBe(2)
  })

  it('同時に走る数が上限を超えない', async () => {
    const semaphore = new Semaphore(2)
    let running = 0
    let peak = 0
    const gate = deferred()

    const task = async (): Promise<void> => {
      const release = await semaphore.acquire()
      running++
      peak = Math.max(peak, running)
      await gate.promise
      running--
      release()
    }

    const all = Promise.all([task(), task(), task(), task(), task()])
    await Promise.resolve()
    gate.resolve()
    await all

    expect(peak).toBe(2)
  })

  it('解放を二重に呼んでも枠が増えない', async () => {
    const semaphore = new Semaphore(1)
    const release = await semaphore.acquire()
    release()
    release()
    expect(semaphore.activeCount).toBe(0)
  })
})
