import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isSupportedImage, splitRelPath, toRelPath } from './library'

describe('isSupportedImage', () => {
  it('対応拡張子を大文字小文字を問わず受け入れる', () => {
    for (const file of ['a.jpg', 'a.JPEG', 'a.png', 'a.WebP', 'a.gif', 'a.bmp', 'a.avif']) {
      expect(isSupportedImage(file)).toBe(true)
    }
  })

  it('画像以外は除外する', () => {
    for (const file of ['a.txt', 'a.mp4', 'a.psd', 'noextension', 'a.png.bak']) {
      expect(isSupportedImage(file)).toBe(false)
    }
  })
})

describe('toRelPath', () => {
  it('ルートからの相対パスを posix 区切りで返す', () => {
    const root = path.join(path.sep, 'photos')
    expect(toRelPath(root, path.join(root, 'a', 'b', 'c.png'))).toBe('a/b/c.png')
  })

  it('ルート直下はファイル名だけになる', () => {
    const root = path.join(path.sep, 'photos')
    expect(toRelPath(root, path.join(root, 'c.png'))).toBe('c.png')
  })
})

describe('splitRelPath', () => {
  it('ディレクトリとファイル名に分割する', () => {
    expect(splitRelPath('a/b/c.png')).toEqual({ dirPath: 'a/b', fileName: 'c.png' })
  })

  it('ルート直下はディレクトリを空文字にする', () => {
    expect(splitRelPath('c.png')).toEqual({ dirPath: '', fileName: 'c.png' })
  })
})
