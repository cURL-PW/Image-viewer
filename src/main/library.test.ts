import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isPlaceholderFile, isSupportedImage, splitRelPath, toRelPath } from './library'

describe('isSupportedImage', () => {
  it('対応拡張子を大文字小文字を問わず受け入れる', () => {
    for (const file of ['a.jpg', 'a.JPEG', 'a.png', 'a.WebP', 'a.gif', 'a.bmp', 'a.avif']) {
      expect(isSupportedImage(file)).toBe(true)
    }
  })

  it('iPhone / iCloud の HEIC を受け入れる', () => {
    for (const file of ['IMG_0001.HEIC', 'a.heic', 'a.heif']) {
      expect(isSupportedImage(file)).toBe(true)
    }
  })

  it('Live Photos の動画や編集情報のサイドカーは対象外', () => {
    for (const file of ['IMG_0001.MOV', 'IMG_0001.AAE']) {
      expect(isSupportedImage(file)).toBe(false)
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

describe('isPlaceholderFile', () => {
  // iCloud / OneDrive の未ダウンロードファイルは、論理サイズはあるが割り当てが 0 になる
  const placeholder = { size: 2_400_000, blocks: 0 }
  const local = { size: 2_400_000, blocks: 4688 }

  it('Windows では未ダウンロードのプレースホルダを検出する', () => {
    expect(isPlaceholderFile(placeholder, 'win32')).toBe(true)
    expect(isPlaceholderFile(local, 'win32')).toBe(false)
  })

  it('空ファイルはプレースホルダ扱いしない', () => {
    expect(isPlaceholderFile({ size: 0, blocks: 0 }, 'win32')).toBe(false)
  })

  it('Windows 以外ではスパースファイルと区別できないので常に false', () => {
    expect(isPlaceholderFile(placeholder, 'linux')).toBe(false)
    expect(isPlaceholderFile(placeholder, 'darwin')).toBe(false)
  })
})
