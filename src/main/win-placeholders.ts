import { spawn } from 'node:child_process'
import { debugLog } from './debug-log'

/**
 * Windows のクラウド同期プレースホルダを、ファイル属性から確実に見つける。
 *
 * iCloud for Windows の未ダウンロードファイルは実測で
 * `0x401620` = ARCHIVE | SPARSE_FILE | REPARSE_POINT | OFFLINE | RECALL_ON_DATA_ACCESS
 * だった。`st_blocks` からの推測と違い、属性なら取りこぼしも誤検出もない。
 *
 * Node からは属性を直接読めないので、PowerShell に 1 回だけ列挙させる。
 * 列挙 (FindFirstFile 系) はファイルのデータを読まないため、
 * `RECALL_ON_DATA_ACCESS` のプレースホルダでもダウンロードは起きない。
 */

const FILE_ATTRIBUTE_OFFLINE = 0x1000
const FILE_ATTRIBUTE_RECALL_ON_OPEN = 0x40000
const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS = 0x400000

/** 「実体がここに無い」ことを示す属性のいずれか。 */
export const PLACEHOLDER_ATTRIBUTE_MASK =
  FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS

export function isPlaceholderAttributes(attributes: number): boolean {
  if (!Number.isFinite(attributes)) return false
  return (attributes & PLACEHOLDER_ATTRIBUTE_MASK) !== 0
}

/** Windows のパス比較は大文字小文字を区別しないので、鍵は小文字へ揃える。 */
export function normalizePath(filePath: string): string {
  return filePath.replace(/\//g, '\\').toLowerCase()
}

/** PowerShell へ渡す文字列リテラル。単引用符は 2 つ重ねて escape する。 */
export function quoteForPowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * ルート配下のプレースホルダだけを列挙するコマンド。
 *
 * `Get-ChildItem -Recurse | Where-Object` は 1 ファイルごとに PowerShell の
 * オブジェクトをパイプラインへ流すため、実機の 89,358 枚では 120 秒でも終わらなかった。
 * .NET の列挙なら、列挙時にキャッシュされた `Attributes` をそのまま読めるので
 * 追加の syscall もオブジェクト生成も要らない。
 *
 * フォルダごとに try/catch して、権限の無い場所で全体が止まらないようにする。
 */
export function buildScanArgs(rootPath: string): string[] {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$mask = ${PLACEHOLDER_ATTRIBUTE_MASK}
$out = [Console]::Out
$stack = New-Object System.Collections.Stack
$stack.Push((New-Object System.IO.DirectoryInfo ${quoteForPowerShell(rootPath)}))
while ($stack.Count -gt 0) {
  $dir = $stack.Pop()
  try {
    foreach ($file in $dir.EnumerateFiles()) {
      if (([int]$file.Attributes -band $mask) -ne 0) { $out.WriteLine($file.FullName) }
    }
    foreach ($sub in $dir.EnumerateDirectories()) { $stack.Push($sub) }
  } catch {}
}
$out.Flush()
`.trim()
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]
}

export function parseScanOutput(stdout: string): Set<string> {
  const paths = new Set<string>()
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed !== '') paths.add(normalizePath(trimmed))
  }
  return paths
}

export interface ScanOptions {
  /** テストから差し替えるための実行関数 */
  run?: (args: string[], onChunk: (chunk: string) => void) => Promise<void>
  /** 出力が途絶えてから諦めるまでの時間 (ms) */
  idleTimeoutMs?: number
  platform?: NodeJS.Platform
  /** 途中経過を受け取る。完了を待たずに 1 枚ずつの判定を始められる */
  onProgress?: (paths: Set<string>) => void
  /** 何件ごとに `onProgress` を呼ぶか */
  progressInterval?: number
}

/** 既定の途中経過の間隔 */
const PROGRESS_INTERVAL = 5000
/** 既定の無出力タイムアウト。全体の上限ではなく「進んでいないこと」で打ち切る */
const IDLE_TIMEOUT_MS = 120_000

function runPowerShell(
  args: string[],
  onChunk: (chunk: string) => void,
  idleTimeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', args, { windowsHide: true })
    let timer: NodeJS.Timeout

    const fail = (error: Error): void => {
      clearTimeout(timer)
      child.kill()
      reject(error)
    }
    // 全体の上限ではなく「出力が止まったら」で打ち切る。
    // 9 万件を列挙している最中に時間切れにしても意味がない
    const arm = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => fail(new Error('プレースホルダの列挙が進まなくなりました')), idleTimeoutMs)
    }
    arm()

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      arm()
      onChunk(chunk)
    })
    child.on('error', (error) => fail(error))
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`PowerShell が異常終了しました (code ${code})`))
    })
  })
}

/**
 * ルート配下の未ダウンロードファイルを列挙する。
 * Windows 以外、または列挙に失敗した場合は null を返し、呼び出し側は
 * 従来の「遅さの回路遮断器」にフォールバックする。
 *
 * 出力は逐次読み、`onProgress` で途中経過を渡す。9 万件の列挙が終わるまで
 * 何も判定できない状態を作らないため。
 */
export async function listPlaceholders(
  rootPath: string,
  options: ScanOptions = {}
): Promise<Set<string> | null> {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return null

  const args = buildScanArgs(rootPath)
  const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS
  const run = options.run ?? ((a, onChunk) => runPowerShell(a, onChunk, idleTimeoutMs))
  const startedAt = Date.now()
  debugLog().log({ kind: 'ps-scan', decision: 'allowed', target: rootPath, note: '列挙を開始' })

  const paths = new Set<string>()
  const interval = options.progressInterval ?? PROGRESS_INTERVAL
  let rest = ''
  let lastReported = 0

  const consume = (chunk: string): void => {
    const lines = (rest + chunk).split(/\r?\n/)
    // 最後の要素は行の途中かもしれないので次のチャンクへ持ち越す
    rest = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed !== '') paths.add(normalizePath(trimmed))
    }
    if (paths.size - lastReported < interval) return
    lastReported = paths.size
    debugLog().log({
      kind: 'ps-scan',
      decision: 'allowed',
      ms: Date.now() - startedAt,
      target: rootPath,
      note: `途中経過 ${paths.size} 件`
    })
    options.onProgress?.(new Set(paths))
  }

  try {
    await run(args, consume)
    consume('\n')
    const sample = paths.values().next().value ?? 'なし'
    debugLog().log({
      kind: 'ps-scan',
      decision: 'allowed',
      ms: Date.now() - startedAt,
      target: rootPath,
      note: `未ダウンロード ${paths.size} 件 例: ${sample}`
    })
    return paths
  } catch (error) {
    console.warn('[cloud] プレースホルダの列挙に失敗しました', error)
    debugLog().log({
      kind: 'ps-scan',
      decision: 'skipped',
      ms: Date.now() - startedAt,
      target: rootPath,
      note: `失敗: ${error instanceof Error ? error.message : String(error)} (${paths.size} 件まで取得)`
    })
    // 途中まで取れているなら、それだけでも渡したほうが弾ける枚数は増える
    return paths.size > 0 ? paths : null
  }
}
