import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { debugLog } from './debug-log'

/**
 * ファイルに触れる fs 呼び出しを数える。
 *
 * クラウド同期フォルダでダウンロードが止まらない問題では、
 * **アプリが自覚していない経路**が犯人だった (chokidar の監視が 1 ファイルずつ
 * lstat していた)。Windows の libuv は stat / lstat をファイルの `CreateFileW` で
 * 実装するため、これは実質「全ファイルを開く」動作になる。
 *
 * 門番も個別のログもすり抜けるので、fs の入口そのもので数えて突き合わせる。
 * 「アプリの読み込みは 0 件なのにダウンロードが続く」ときに、
 * それが本当に 0 件なのかをここで確かめられる。
 */

/** 数える対象。いずれも Windows ではファイルを開く */
const WATCHED_METHODS = [
  'stat',
  'lstat',
  'open',
  'read',
  'readFile',
  'createReadStream',
  'watch',
  'watchFile',
  'access',
  'opendir'
] as const

export interface FsProbe {
  /** 現在までの呼び出し回数 (種別ごと) */
  counts(): Record<string, number>
  /** 元の実装へ戻す */
  uninstall(): void
}

function patch(
  target: Record<string, unknown>,
  prefix: string,
  bump: (key: string) => void
): (() => void)[] {
  const restores: (() => void)[] = []
  for (const name of WATCHED_METHODS) {
    const original = target[name]
    if (typeof original !== 'function') continue
    const wrapped = function (this: unknown, ...args: unknown[]): unknown {
      bump(`${prefix}${name}`)
      return (original as (...a: unknown[]) => unknown).apply(this, args)
    }
    // fs.promises などは元の関数に付いたプロパティ (native など) も引き継ぐ
    Object.assign(wrapped, original)
    try {
      target[name] = wrapped
      restores.push(() => {
        target[name] = original
      })
    } catch {
      // 書き換えられない環境では諦める (計測できないだけで動作には影響しない)
    }
  }
  return restores
}

/**
 * 計測を仕込む。`intervalMs` ごとに、増えた分があれば 1 行だけ記録する。
 *
 * ここで数えられるのは「fs モジュールのオブジェクト経由で呼ばれたもの」だけ。
 * 名前付き import で束縛済みの第三者コードや、sharp のようなネイティブ実装は
 * 通らないので、`walk-stat` など個別の記録と合わせて読む。
 */
export function installFsProbe(intervalMs = 1000): FsProbe {
  const counts: Record<string, number> = {}
  let dirty = false
  const bump = (key: string): void => {
    counts[key] = (counts[key] ?? 0) + 1
    dirty = true
  }

  const restores = [
    ...patch(fs as unknown as Record<string, unknown>, '', bump),
    ...patch(fsp as unknown as Record<string, unknown>, 'p:', bump)
  ]

  let previous: Record<string, number> = {}
  const timer = setInterval(() => {
    if (!dirty) return
    dirty = false
    const deltas = Object.entries(counts)
      .map(([key, value]) => [key, value - (previous[key] ?? 0)] as const)
      .filter(([, delta]) => delta > 0)
      .map(([key, delta]) => `${key}=${delta}`)
    previous = { ...counts }
    if (deltas.length === 0) return
    debugLog().log({ kind: 'fs-probe', note: deltas.join(' ') })
  }, intervalMs)
  timer.unref?.()

  return {
    counts: () => ({ ...counts }),
    uninstall: () => {
      clearInterval(timer)
      for (const restore of restores) restore()
    }
  }
}
