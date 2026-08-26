import { describe, expect, it, vi } from 'vitest'
import {
  PLACEHOLDER_ATTRIBUTE_MASK,
  buildScanArgs,
  isPlaceholderAttributes,
  listPlaceholders,
  normalizePath,
  parseScanOutput,
  quoteForPowerShell
} from './win-placeholders'

/** iCloud for Windows の未ダウンロードファイルで実測した値 */
const ICLOUD_PLACEHOLDER = 0x401620
/** 同じ構成でローカルに実体があるファイル (ARCHIVE のみ) */
const LOCAL_FILE = 0x20

describe('isPlaceholderAttributes', () => {
  it('実測した iCloud のプレースホルダを検出する', () => {
    // ARCHIVE | SPARSE_FILE | REPARSE_POINT | OFFLINE | RECALL_ON_DATA_ACCESS
    expect(isPlaceholderAttributes(ICLOUD_PLACEHOLDER)).toBe(true)
  })

  it('OFFLINE だけ / RECALL_ON_OPEN だけでも検出する', () => {
    expect(isPlaceholderAttributes(0x1000)).toBe(true)
    expect(isPlaceholderAttributes(0x40000)).toBe(true)
  })

  it('ローカルにあるファイルは対象外', () => {
    expect(isPlaceholderAttributes(LOCAL_FILE)).toBe(false)
    // SPARSE + REPARSE だけでは判断しない (実体がある場合もあるため)
    expect(isPlaceholderAttributes(0x600)).toBe(false)
  })

  it('不正な値は false', () => {
    expect(isPlaceholderAttributes(Number.NaN)).toBe(false)
  })

  it('マスクは 3 つのフラグの論理和', () => {
    expect(PLACEHOLDER_ATTRIBUTE_MASK).toBe(0x441000)
  })
})

describe('quoteForPowerShell', () => {
  it('単引用符を 2 つ重ねて escape する', () => {
    expect(quoteForPowerShell("C:\\Alice's Photos")).toBe("'C:\\Alice''s Photos'")
  })

  it('空白や角括弧を含むパスもそのまま渡せる', () => {
    expect(quoteForPowerShell('C:\\iCloud Photos\\[2024]')).toBe("'C:\\iCloud Photos\\[2024]'")
  })
})

describe('buildScanArgs', () => {
  it('データを読まない列挙になっている', () => {
    const args = buildScanArgs('C:\\Photos')
    const script = args[args.length - 1]
    expect(script).toContain(`-band $mask`)
    expect(script).toContain(`$mask = ${PLACEHOLDER_ATTRIBUTE_MASK}`)
    expect(script).toContain("'C:\\Photos'")
    // 中身を読む Get-Content などが混ざっていないこと
    expect(script).not.toContain('Get-Content')
  })

  it('1 ファイルずつオブジェクトを作るパイプラインを使わない', () => {
    // 89,358 枚では Get-ChildItem -Recurse が 120 秒でも終わらなかった。
    // 列挙時にキャッシュされた属性をそのまま読む .NET の列挙に置き換えてある
    const script = buildScanArgs('C:\\Photos').at(-1) ?? ''
    expect(script).not.toContain('Get-ChildItem')
    expect(script).toContain('EnumerateFiles')
    expect(script).toContain('EnumerateDirectories')
  })

  it('権限の無いフォルダで全体が止まらないようにする', () => {
    const script = buildScanArgs('C:\\Photos').at(-1) ?? ''
    expect(script).toContain('catch {}')
  })

  it('プロファイルや対話を無効にして起動する', () => {
    const args = buildScanArgs('C:\\Photos')
    expect(args).toContain('-NoProfile')
    expect(args).toContain('-NonInteractive')
  })
})

describe('parseScanOutput', () => {
  it('パスを 1 行ずつ拾い、比較用に小文字へ揃える', () => {
    const output = 'C:\\Photos\\IMG_0001.HEIC\r\nC:\\Photos\\Sub\\IMG_0002.HEIC\r\n\r\n'
    expect(parseScanOutput(output)).toEqual(
      new Set(['c:\\photos\\img_0001.heic', 'c:\\photos\\sub\\img_0002.heic'])
    )
  })

  it('空の出力は空集合 (= プレースホルダ無し)', () => {
    expect(parseScanOutput('')).toEqual(new Set())
  })
})

describe('normalizePath', () => {
  it('区切りと大文字小文字を揃える', () => {
    expect(normalizePath('C:/Photos/IMG.HEIC')).toBe('c:\\photos\\img.heic')
  })
})

describe('listPlaceholders', () => {
  it('Windows 以外では実行しない', async () => {
    const run = vi.fn()
    expect(await listPlaceholders('/photos', { run, platform: 'linux' })).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  it('列挙結果を集合として返す', async () => {
    const run = vi.fn(async (_args: string[], onChunk: (chunk: string) => void) => {
      onChunk('C:\\Photos\\a.heic\nC:\\Photos\\b.heic')
    })
    const result = await listPlaceholders('C:\\Photos', { run, platform: 'win32' })
    expect(result).toEqual(new Set(['c:\\photos\\a.heic', 'c:\\photos\\b.heic']))
  })

  it('チャンクの途中で切れた行をまたいで組み立てる', async () => {
    const run = vi.fn(async (_args: string[], onChunk: (chunk: string) => void) => {
      onChunk('C:\\Photos\\a.he')
      onChunk('ic\r\nC:\\Photos\\b.heic\r\n')
    })
    const result = await listPlaceholders('C:\\Photos', { run, platform: 'win32' })
    expect(result).toEqual(new Set(['c:\\photos\\a.heic', 'c:\\photos\\b.heic']))
  })

  it('完了を待たずに途中経過を渡す', async () => {
    // 9 万件の列挙が終わるまで 1 枚も弾けない、という状態を作らないため
    const run = vi.fn(async (_args: string[], onChunk: (chunk: string) => void) => {
      for (let i = 0; i < 5; i++) onChunk(`C:\\Photos\\IMG_${i}.heic\n`)
    })
    const progress: number[] = []
    await listPlaceholders('C:\\Photos', {
      run,
      platform: 'win32',
      progressInterval: 2,
      onProgress: (paths) => progress.push(paths.size)
    })
    expect(progress).toEqual([2, 4])
  })

  it('失敗しても例外を投げず null を返す (遮断器へフォールバックする)', async () => {
    const run = vi.fn().mockRejectedValue(new Error('PowerShell が使えません'))
    expect(await listPlaceholders('C:\\Photos', { run, platform: 'win32' })).toBeNull()
  })

  it('途中で失敗しても、そこまでに取れた分は活かす', async () => {
    const run = vi.fn(async (_args: string[], onChunk: (chunk: string) => void) => {
      onChunk('C:\\Photos\\a.heic\n')
      throw new Error('列挙が進まなくなりました')
    })
    const result = await listPlaceholders('C:\\Photos', { run, platform: 'win32' })
    expect(result).toEqual(new Set(['c:\\photos\\a.heic']))
  })
})

describe('アプリ側のパスとの照合', () => {
  // 一覧の鍵は PowerShell の FullName、引くのは path.resolve(root, relPath) で作った
  // パス。ここが食い違うと 1 枚も弾けなくなるので、実際の組み合わせで確かめる。
  const output = [
    'C:\\Users\\Alice\\Pictures\\iCloud Photos\\Photos\\IMG_8582.HEIC',
    'C:\\Users\\Alice\\Pictures\\iCloud Photos\\Photos\\IMG_8583.HEIC'
  ].join('\r\n')

  it('ルートの大文字小文字が違っても一致する', () => {
    const index = parseScanOutput(output)
    // ユーザーがフォルダを選び直すと、同じ場所でも表記が変わることがある
    const picked = 'c:\\users\\alice\\pictures\\icloud photos'
    const full = `${picked}\\Photos\\IMG_8582.HEIC`
    expect(index.has(normalizePath(full))).toBe(true)
  })

  it('区切りが / でも一致する', () => {
    const index = parseScanOutput(output)
    const full = 'C:/Users/Alice/Pictures/iCloud Photos/Photos/IMG_8583.HEIC'
    expect(index.has(normalizePath(full))).toBe(true)
  })

  it('別のファイルは一致しない', () => {
    const index = parseScanOutput(output)
    const full = 'C:\\Users\\Alice\\Pictures\\iCloud Photos\\Photos\\IMG_9999.HEIC'
    expect(index.has(normalizePath(full))).toBe(false)
  })
})
