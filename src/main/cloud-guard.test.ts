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
    expect(guard.isBlocked).toBe(false)
    expect(guard.isCloudFolder).toBe(false)
  })

  it('遅い読み込みが続くと自動読み込みを止める', () => {
    const guard = new CloudGuard(OPTIONS)
    guard.recordRead(5000)
    // 1 回だけではまだ止めない (たまたま遅かっただけかもしれない)
    expect(guard.allowAutoRead()).toBe(true)

    guard.recordRead(5000)
    expect(guard.isBlocked).toBe(true)
    // 案内も出す
    expect(guard.isCloudFolder).toBe(true)
    expect(guard.status.reason).toBe('slow')
    expect(guard.allowAutoRead()).toBe(false)
  })

  it('間に速い読み込みが挟まれば連続とみなさない', () => {
    const guard = new CloudGuard(OPTIONS)
    guard.recordRead(5000)
    guard.recordRead(10)
    guard.recordRead(5000)
    expect(guard.isBlocked).toBe(false)
  })

  it('速い読み込みが続けば自動で解除する', () => {
    const guard = new CloudGuard(OPTIONS)
    guard.recordRead(5000)
    guard.recordRead(5000)
    expect(guard.isBlocked).toBe(true)

    // 明示的に落としたファイルが速く読めるようになった
    guard.recordRead(10)
    guard.recordRead(10)
    expect(guard.isBlocked).toBe(true)
    guard.recordRead(10)
    expect(guard.isBlocked).toBe(false)
    expect(guard.isCloudFolder).toBe(false)
  })

  it('手動で止めたものは速い読み込みでは解除しない', () => {
    const guard = new CloudGuard(OPTIONS)
    guard.setBlocked(true)
    expect(guard.status.reason).toBe('manual')
    for (let i = 0; i < 10; i++) guard.recordRead(1)
    expect(guard.isBlocked).toBe(true)

    guard.setBlocked(false)
    expect(guard.isBlocked).toBe(false)
  })

  it('「常に読み込む」を選べば止まっていても自動読み込みを許可する', () => {
    const guard = new CloudGuard(OPTIONS)
    guard.recordRead(5000)
    guard.recordRead(5000)
    expect(guard.allowAutoRead()).toBe(false)

    guard.setAlwaysRead(true)
    expect(guard.allowAutoRead()).toBe(true)
    // 状態自体は残るので、UI では状況を伝えられる
    expect(guard.isBlocked).toBe(true)
  })

  it('ルート切り替えで判定をやり直す', () => {
    const guard = new CloudGuard(OPTIONS)
    guard.recordRead(5000)
    guard.recordRead(5000)
    expect(guard.isBlocked).toBe(true)

    guard.reset()
    expect(guard.isBlocked).toBe(false)
    expect(guard.isCloudFolder).toBe(false)
    expect(guard.allowAutoRead()).toBe(true)
  })

  it('記憶を復元したときは最初から止めておく', () => {
    const guard = new CloudGuard(OPTIONS)
    guard.reset(true)
    expect(guard.isBlocked).toBe(true)
    expect(guard.isCloudFolder).toBe(true)
    expect(guard.status.reason).toBe('remembered')
  })

  it('状態が変わったときだけ change を通知する', () => {
    const guard = new CloudGuard(OPTIONS)
    const listener = vi.fn()
    guard.on('change', listener)

    guard.recordRead(5000)
    expect(listener).not.toHaveBeenCalled()

    guard.recordRead(5000)
    expect(listener).toHaveBeenCalledTimes(1)

    // すでに止まっているので追加の通知は出ない
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

describe('CloudGuard の正確な一覧 (ファイル属性ベース)', () => {
  const index = (): Set<string> => new Set(['c:\\photos\\a.heic', 'c:\\photos\\b.heic'])

  it('一覧にあるファイルだけを未ダウンロードと判定する', async () => {
    const guard = new CloudGuard(OPTIONS)
    guard.setPlaceholderIndex(index())

    expect(await guard.isNotDownloaded('C:\\Photos\\A.HEIC')).toBe(true)
    expect(await guard.isNotDownloaded('C:\\Photos\\local.jpg')).toBe(false)
  })

  it('一覧があるときは全体を止めず、1 枚ずつ弾く', async () => {
    const guard = new CloudGuard(OPTIONS)
    guard.setPlaceholderIndex(index())

    // 未ダウンロードが居るので案内は出す
    expect(guard.isCloudFolder).toBe(true)
    // ただしローカルの写真は従来どおり扱えるよう、自動読み込みは止めない
    expect(guard.allowAutoRead()).toBe(true)
    expect(guard.hasExactIndex).toBe(true)
  })

  it('一覧があっても、遅い読み込みが続けば必ず止まる', () => {
    // 回帰テスト: 一覧が作れただけで遮断器を無効化してしまうと、
    // パスの照合が外れたときにライブラリ全体を読みに行ってしまう
    const guard = new CloudGuard(OPTIONS)
    guard.setPlaceholderIndex(index())
    expect(guard.allowAutoRead()).toBe(true)

    guard.recordRead(5000)
    guard.recordRead(5000)
    expect(guard.allowAutoRead()).toBe(false)
    expect(guard.isBlocked).toBe(true)
  })

  it('照合が総外れ (一覧が空) でも遮断器は効く', () => {
    const guard = new CloudGuard(OPTIONS)
    guard.setPlaceholderIndex(new Set())
    guard.recordRead(5000)
    guard.recordRead(5000)
    expect(guard.allowAutoRead()).toBe(false)
  })

  it('案内と遮断は別々の状態として持つ', () => {
    const guard = new CloudGuard(OPTIONS)
    guard.setPlaceholderIndex(index())
    // 案内だけ出ていて、読み込みは止まっていない
    expect(guard.status).toEqual({ cloudFolder: true, blocked: false, reason: 'placeholder' })

    guard.recordRead(5000)
    guard.recordRead(5000)
    expect(guard.status).toEqual({ cloudFolder: true, blocked: true, reason: 'slow' })
  })

  it('落としたファイルは一覧から外れ、全部落ちれば案内も消える', async () => {
    const guard = new CloudGuard(OPTIONS)
    guard.setPlaceholderIndex(index())

    guard.markDownloaded('C:\\Photos\\a.heic')
    expect(await guard.isNotDownloaded('C:\\Photos\\a.heic')).toBe(false)
    expect(guard.isCloudFolder).toBe(true)

    guard.markDownloaded('C:\\Photos\\b.heic')
    expect(guard.isCloudFolder).toBe(false)
  })

  it('一覧が空 (= 全部ローカル) なら案内を出さない', () => {
    const guard = new CloudGuard(OPTIONS)
    guard.setPlaceholderIndex(new Set())
    expect(guard.isCloudFolder).toBe(false)
    expect(guard.allowAutoRead()).toBe(true)
  })

  it('一覧が作れなかった場合は遅さの遮断器へフォールバックする', async () => {
    const guard = new CloudGuard(OPTIONS)
    guard.setPlaceholderIndex(null)
    expect(guard.hasExactIndex).toBe(false)

    guard.recordRead(5000)
    guard.recordRead(5000)
    expect(guard.allowAutoRead()).toBe(false)
  })

  it('遮断が解けても、一覧に残っていれば案内は出したままにする', () => {
    const guard = new CloudGuard(OPTIONS)
    guard.setPlaceholderIndex(index())
    guard.recordRead(5000)
    guard.recordRead(5000)
    expect(guard.isBlocked).toBe(true)

    for (let i = 0; i < 3; i++) guard.recordRead(10)
    expect(guard.isBlocked).toBe(false)
    expect(guard.isCloudFolder).toBe(true)
    expect(guard.status.reason).toBe('placeholder')
  })

  it('ルートを切り替えたら一覧も捨てる', () => {
    const guard = new CloudGuard(OPTIONS)
    guard.setPlaceholderIndex(index())
    guard.reset()
    expect(guard.hasExactIndex).toBe(false)
  })

  it('「常に読み込む」なら一覧があっても弾かない', async () => {
    const guard = new CloudGuard(OPTIONS)
    guard.setPlaceholderIndex(index())
    guard.setAlwaysRead(true)
    expect(await guard.isNotDownloaded('C:\\Photos\\a.heic')).toBe(false)
  })
})
