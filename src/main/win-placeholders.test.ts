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
    expect(script).toContain('Get-ChildItem')
    expect(script).toContain('-LiteralPath')
    expect(script).toContain(`-band ${PLACEHOLDER_ATTRIBUTE_MASK}`)
    // 中身を読む Get-Content などが混ざっていないこと
    expect(script).not.toContain('Get-Content')
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
    const run = vi.fn().mockResolvedValue('C:\\Photos\\a.heic\nC:\\Photos\\b.heic')
    const result = await listPlaceholders('C:\\Photos', { run, platform: 'win32' })
    expect(result).toEqual(new Set(['c:\\photos\\a.heic', 'c:\\photos\\b.heic']))
  })

  it('失敗しても例外を投げず null を返す (遮断器へフォールバックする)', async () => {
    const run = vi.fn().mockRejectedValue(new Error('PowerShell が使えません'))
    expect(await listPlaceholders('C:\\Photos', { run, platform: 'win32' })).toBeNull()
  })
})
