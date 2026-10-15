import { describe, expect, it } from 'vitest'
import { compileTagPatterns, excludeTags } from './tag-filter'

const TAGS = ['1girl', '1girls', 'long_hair', 'short_hair', 'smile', 'general']

describe('excludeTags', () => {
  it('タグ名をそのまま書けば、そのタグだけを除く (全体一致)', () => {
    expect(excludeTags(TAGS, ['1girl'])).toEqual(['1girls', 'long_hair', 'short_hair', 'smile', 'general'])
  })

  it('正規表現で複数のタグをまとめて除ける', () => {
    expect(excludeTags(TAGS, ['.*_hair', 'general|smile'])).toEqual(['1girl', '1girls'])
  })

  it('大文字小文字は区別しない', () => {
    expect(excludeTags(TAGS, ['SMILE'])).not.toContain('smile')
  })

  it('空行と前後の空白は無視する', () => {
    expect(excludeTags(TAGS, ['', '  smile  '])).toEqual(TAGS.filter((tag) => tag !== 'smile'))
  })

  it('壊れた正規表現は無視し、ほかのルールは効かせる', () => {
    expect(excludeTags(TAGS, ['(', 'smile'])).toEqual(TAGS.filter((tag) => tag !== 'smile'))
  })

  it('ルールが無ければそのまま返す', () => {
    expect(excludeTags(TAGS, [])).toEqual(TAGS)
  })
})

describe('compileTagPatterns', () => {
  it('解釈できない正規表現をエラーとして返す', () => {
    const { regexes, errors } = compileTagPatterns(['ok', '[', ''])
    expect(regexes).toHaveLength(1)
    expect(errors).toEqual([{ pattern: '[', message: expect.any(String) }])
  })
})
