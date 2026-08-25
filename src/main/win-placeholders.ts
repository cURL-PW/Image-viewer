import { spawn } from 'node:child_process'

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

/** ルート配下のプレースホルダだけを列挙するコマンド。 */
export function buildScanArgs(rootPath: string): string[] {
  const script =
    `Get-ChildItem -LiteralPath ${quoteForPowerShell(rootPath)} -Recurse -File -Force ` +
    `-ErrorAction SilentlyContinue | ` +
    `Where-Object { $_.Attributes.value__ -band ${PLACEHOLDER_ATTRIBUTE_MASK} } | ` +
    `ForEach-Object { $_.FullName }`
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
  run?: (args: string[]) => Promise<string>
  timeoutMs?: number
  platform?: NodeJS.Platform
}

function runPowerShell(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', args, { windowsHide: true })
    let stdout = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('プレースホルダの列挙がタイムアウトしました'))
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(new Error(`PowerShell が異常終了しました (code ${code})`))
    })
  })
}

/**
 * ルート配下の未ダウンロードファイルを列挙する。
 * Windows 以外、または列挙に失敗した場合は null を返し、呼び出し側は
 * 従来の「遅さの回路遮断器」にフォールバックする。
 */
export async function listPlaceholders(
  rootPath: string,
  options: ScanOptions = {}
): Promise<Set<string> | null> {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return null

  const args = buildScanArgs(rootPath)
  const run = options.run ?? ((a: string[]) => runPowerShell(a, options.timeoutMs ?? 120_000))

  try {
    return parseScanOutput(await run(args))
  } catch (error) {
    console.warn('[cloud] プレースホルダの列挙に失敗しました', error)
    return null
  }
}
