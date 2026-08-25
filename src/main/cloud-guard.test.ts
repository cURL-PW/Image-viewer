import { describe, expect, it, vi } from 'vitest'
import { CloudGuard, isLikelyPlaceholder, isNotDownloadedError, NotDownloadedError } from './cloud-guard'

const OPTIONS = { slowReadMs: 1000, slowReadLimit: 2, fastRecoveryLimit: 3 }

describe('isLikelyPlaceholder', () => {
  it('Windows で実体の割り当てが無いファイルを検出する', () => {
    expect(isLikelyPlaceholder({ size: 2_400_000, blocks: 0 }, 'win32')).toBe(true)
  })

  it('部分的にしか落ちていないファイルも検出する', () => {
    // 論理 2.4MB に対して割り当ては 64KB しかない
    expect(isLikelyPlaceholder({ size: 2_400_000, blocks: 128 }, 'win32')).toBe(true)
  })

  it('ローカルに実体があるファイルは対象外', () => {
    expect(isLikelyPlaceholder({ size: 2_400_000, blocks: 4688 }, 'win32')).toBe(false)
  })

  it('空ファイルや不正な値は対象外', () => {
    expect(isLikelyPlaceholder({ size: 0, blocks: 0 }, 'win32')).toBe(false)
    expect(isLikelyPlaceholder({ size: 100, blocks: Number.NaN }, 'win32')).toBe(false)
  })

  it('Windows 以外ではスパースファイルと区別できないので判定しない', () => {
    expect(isLikelyPlaceholder({ size: 2_400_000, blocks: 0 }, 'linux')).toBe(false)
    expect(isLikelyPlaceholder({ size: 2_400_000, blocks: 0 }, 'darwin')).toBe(false)
  })
})

describe('CloudGuard の回路遮断器', () => {
  it('初期状態では自動読み込みを許可する', () => {
    const guard = new CloudGuard(OPTIONS)
    expect(guard.allowAutoRead()).toBe(true)
    expect(guard.isCloudMode).toBe(false)
  })

  it('遅い読み込みが続くとクラウドモードへ入る', () => {
    const guard = new CloudGuard(OPTIONS)
    guard.recordRead(5000)
    // 1 回だけではまだ止めない (たまたま遅かっただけかもしれない)
    expect(guard.allowAutoRead()).toBe(true)

    guard.recordRead(5000)
    expect(guard.isCloudMode).toBe(true)
    expect(guard.status.reason).toBe('slow')
    expect(guard.allowAutoRead()).toBe(false)
  })

  it('間に速い読み込みが挟まれば連続とみなさない', () => {
    const guard = new CloudGuard(OPTIONS)
    guard.recordRead(5000)
    guard.recordRead(10)
    guard.recordRead(5000)
    expect(guard.isCloudMode).toBe(false)
  })

  it('速い読み込みが続けばクラウドモードを自動で解除する', () => {
    const guard = new CloudGuard(OPTIONS)
    guard.recordRead(5000)
    guard.recordRead(5000)
    expect(guard.isCloudMode).toBe(true)

    // 明示的に落としたファイルが速く読めるようになった
    guard.recordRead(10)
    guard.recordRead(10)
    expect(guard.isCloudMode).toBe(true)
    guard.recordRead(10)
    expect(guard.isCloudMode).toBe(false)
  })

  it('手動で入れたクラウドモードは速い読み込みでは解除しない', () => {
    const guard = new CloudGuard(OPTIONS)
    guard.setCloudMode(true)
    expect(guard.status.reason).toBe('manual')
    for (let i = 0; i < 10; i++) guard.recordRead(1)
    expect(guard.isCloudMode).toBe(true)

    guard.setCloudMode(false)
    expect(guard.isCloudMode).toBe(false)
  })

  it('「常に読み込む」を選べばクラウドモードでも自動読み込みを許可する', () => {
    const guard = new CloudGuard(OPTIONS)
    guard.recordRead(5000)
    guard.recordRead(5000)
    expect(guard.allowAutoRead()).toBe(false)

    guard.setAlwaysRead(true)
    expect(guard.allowAutoRead()).toBe(true)
    // モード自体は残るので、UI では状況を伝えられる
    expect(guard.isCloudMode).toBe(true)
  })

  it('ルート切り替えで判定をやり直す', () => {
    const guard = new CloudGuard(OPTIONS)
    guard.recordRead(5000)
    guard.recordRead(5000)
    expect(guard.isCloudMode).toBe(true)

    guard.reset()
    expect(guard.isCloudMode).toBe(false)
    expect(guard.allowAutoRead()).toBe(true)
  })

  it('状態が変わったときだけ change を通知する', () => {
    const guard = new CloudGuard(OPTIONS)
    const listener = vi.fn()
    guard.on('change', listener)

    guard.recordRead(5000)
    expect(listener).not.toHaveBeenCalled()

    guard.recordRead(5000)
    expect(listener).toHaveBeenCalledTimes(1)

    // すでにクラウドモードなので追加の通知は出ない
    guard.recordRead(5000)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('NotDownloadedError', () => {
  it('型を問わず判別できる', () => {
    expect(isNotDownloadedError(new NotDownloadedError())).toBe(true)
    expect(isNotDownloadedError(new Error('別のエラー'))).toBe(false)
    expect(isNotDownloadedError('文字列')).toBe(false)
  })
})
