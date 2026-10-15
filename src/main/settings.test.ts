import { describe, expect, it } from 'vitest'
import { normalizeSettings } from './settings'
import { DEFAULT_SETTINGS } from '@shared/types'

describe('normalizeSettings', () => {
  it('空の入力には既定値を返す', () => {
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS)
  })

  it('しきい値を有効範囲に丸める', () => {
    expect(normalizeSettings({ generalThreshold: 5 }).generalThreshold).toBe(0.95)
    expect(normalizeSettings({ generalThreshold: -1 }).generalThreshold).toBe(0.05)
    expect(normalizeSettings({ characterThreshold: 0.5 }).characterThreshold).toBe(0.5)
  })

  it('壊れた値は既定値に戻す', () => {
    expect(normalizeSettings({ thumbnailSize: Number.NaN }).thumbnailSize).toBe(
      DEFAULT_SETTINGS.thumbnailSize
    )
    expect(normalizeSettings({ modelId: '' }).modelId).toBe(DEFAULT_SETTINGS.modelId)
    expect(normalizeSettings({ sortKey: 'bogus' as never }).sortKey).toBe(DEFAULT_SETTINGS.sortKey)
  })

  it('プロバイダは cpu 指定のときだけ cpu になる', () => {
    expect(normalizeSettings({ provider: 'cpu' }).provider).toBe('cpu')
    expect(normalizeSettings({ provider: 'gpu' as never }).provider).toBe('auto')
  })

  it('ページ送りのクリック領域は画面の半分を超えない', () => {
    expect(normalizeSettings({ edgeClickRatio: 0.9 }).edgeClickRatio).toBe(0.45)
  })

  it('デバッグログは既定で有効、明示的に false のときだけ無効', () => {
    expect(normalizeSettings({}).debugLog).toBe(true)
    expect(normalizeSettings({ debugLog: undefined }).debugLog).toBe(true)
    expect(normalizeSettings({ debugLog: false }).debugLog).toBe(false)
  })

  it('除外タグは文字列だけを残し、空のものは捨てる', () => {
    expect(normalizeSettings({}).copyExcludeTags).toEqual([])
    expect(
      normalizeSettings({ copyExcludeTags: [' 1girl ', '', 3, '.*_hair'] as never }).copyExcludeTags
    ).toEqual(['1girl', '.*_hair'])
    expect(normalizeSettings({ copyExcludeTags: 'oops' as never }).copyExcludeTags).toEqual([])
  })
})
