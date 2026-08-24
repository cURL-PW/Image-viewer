import { describe, expect, it } from 'vitest'
import { parseCsvLine, parseTagVocabulary, sanitizeModelId } from './model'
import { TagCategory } from '@shared/types'

describe('sanitizeModelId', () => {
  it('リポジトリ ID をそのままフォルダ名に使える文字列へ変換する', () => {
    expect(sanitizeModelId('SmilingWolf/wd-eva02-large-tagger-v3')).toBe(
      'SmilingWolf_wd-eva02-large-tagger-v3'
    )
  })

  it('パス区切りを含む細工された ID でも階層を作らせない', () => {
    expect(sanitizeModelId('../../etc/passwd')).toBe('.._.._etc_passwd')
  })
})

describe('parseCsvLine', () => {
  it('通常のカンマ区切りを分割する', () => {
    expect(parseCsvLine('0,1girl,0,1234')).toEqual(['0', '1girl', '0', '1234'])
  })

  it('引用符で囲まれたカンマをフィールドの一部として扱う', () => {
    expect(parseCsvLine('1,"cosplay, female",4,10')).toEqual(['1', 'cosplay, female', '4', '10'])
  })

  it('二重の引用符をエスケープとして扱う', () => {
    expect(parseCsvLine('2,"say ""hi""",0,1')).toEqual(['2', 'say "hi"', '0', '1'])
  })
})

describe('parseTagVocabulary', () => {
  const csv = [
    'tag_id,name,category,count',
    '0,1girl,0,100',
    '1,hatsune_miku,4,50',
    '2,general,9,10',
    '',
    '3,solo,0,80'
  ].join('\n')

  it('出力インデックスの順にタグを返す', () => {
    const tags = parseTagVocabulary(csv)
    expect(tags.map((tag) => tag.name)).toEqual(['1girl', 'hatsune_miku', 'general', 'solo'])
  })

  it('カテゴリを数値として読み取る', () => {
    const tags = parseTagVocabulary(csv)
    expect(tags[0].category).toBe(TagCategory.General)
    expect(tags[1].category).toBe(TagCategory.Character)
    expect(tags[2].category).toBe(TagCategory.Rating)
  })

  it('列の並びが違っても name / category の位置を見て解釈する', () => {
    const reordered = ['name,category,tag_id', 'solo,0,3'].join('\n')
    expect(parseTagVocabulary(reordered)).toEqual([{ name: 'solo', category: 0 }])
  })

  it('想定した列がない場合はエラーにする', () => {
    expect(() => parseTagVocabulary('a,b\n1,2')).toThrow(/selected_tags.csv/)
  })
})
