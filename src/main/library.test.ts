import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isSupportedImage, splitRelPath, toRelPath, walkImages } from './library'

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

describe('walkImages の stat 門番', () => {
  /**
   * Windows の libuv は fs.stat でファイルを開くため、クラウドのプレースホルダだと
   * 走査するだけでライブラリ全体がダウンロードされてしまう。
   * 門番が止めているあいだは stat せずに登録できることを確認する。
   */
  async function fixture(): Promise<string> {
    const os = await import('node:os')
    const fsp = await import('node:fs/promises')
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'walk-gate-'))
    await fsp.mkdir(path.join(dir, 'sub'), { recursive: true })
    for (const name of ['a.png', 'b.png', 'sub/c.png']) {
      await fsp.writeFile(path.join(dir, ...name.split('/')), Buffer.alloc(16, 1))
    }
    return dir
  }

  async function collect(root: string, gate?: Parameters<typeof walkImages>[1]) {
    const files = []
    for await (const batch of walkImages(root, gate)) files.push(...batch)
    return files.sort((a, b) => a.relPath.localeCompare(b.relPath))
  }

  it('門番が無ければ従来どおり stat して mtime と size を埋める', async () => {
    const root = await fixture()
    const files = await collect(root)
    expect(files.map((file) => file.relPath)).toEqual(['a.png', 'b.png', 'sub/c.png'])
    for (const file of files) {
      expect(file.size).toBe(16)
      expect(file.mtime).toBeGreaterThan(0)
    }
  })

  it('門番が止めているあいだは stat せず、寸法不明として登録する', async () => {
    const root = await fixture()
    let statCalls = 0
    const files = await collect(root, {
      gate: {
        allow: () => false,
        record: () => {
          statCalls++
        }
      }
    })

    // ファイル自体は見つかる (readdir はファイルを開かないので安全)
    expect(files.map((file) => file.relPath)).toEqual(['a.png', 'b.png', 'sub/c.png'])
    // stat は 1 回も呼ばれない
    expect(statCalls).toBe(0)
    for (const file of files) {
      expect(file.size).toBe(0)
      expect(file.mtime).toBe(0)
    }
  })

  it('遅さを検知した時点で以降の stat をやめる', async () => {
    const root = await fixture()
    const durations: number[] = []
    let allowed = true

    const files = await collect(root, {
      gate: {
        allow: () => allowed,
        record: (ms) => {
          durations.push(ms)
          // 1 件目を「遅い」とみなして打ち切る、という遮断器の動きを模す
          allowed = false
        }
      }
    })

    expect(files).toHaveLength(3)
    // stat したのは最初の 1 件だけ
    expect(durations).toHaveLength(1)
    expect(files.filter((file) => file.size === 0)).toHaveLength(2)
  })
})

describe('walkImages の差分走査', () => {
  /**
   * 起動のたびに登録済みの 9 万枚を stat し直すと、Windows では全ファイルを開くことになる。
   * 登録済みのファイルは stat せず、新しく現れたファイルだけを stat することを確認する。
   */
  async function fixture(): Promise<string> {
    const os = await import('node:os')
    const fsp = await import('node:fs/promises')
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'walk-known-'))
    await fsp.mkdir(path.join(dir, 'sub'), { recursive: true })
    for (const name of ['a.png', 'b.png', 'sub/c.png']) {
      await fsp.writeFile(path.join(dir, ...name.split('/')), Buffer.alloc(16, 1))
    }
    return dir
  }

  it('登録済みのファイルは stat せず、新しいファイルだけ stat する', async () => {
    const root = await fixture()
    let statCalls = 0
    const files = []
    const known = new Map([
      ['a.png', { mtime: 1000 }],
      ['sub/c.png', { mtime: 1000 }]
    ])
    for await (const batch of walkImages(root, {
      known,
      gate: { allow: () => true, record: () => statCalls++ }
    })) {
      files.push(...batch)
    }
    files.sort((a, b) => a.relPath.localeCompare(b.relPath))

    expect(files.map((file) => file.relPath)).toEqual(['a.png', 'b.png', 'sub/c.png'])
    expect(statCalls).toBe(1)
    expect(files[1].size).toBe(16)
    // 登録済みは前回の値を壊さないよう「寸法不明」の印を付けて返す
    expect(files[0].statSkipped).toBe(true)
    expect(files[2].statSkipped).toBe(true)
  })

  it('mtime が 0 のまま登録されているファイルは、値を埋めるために stat する', async () => {
    const root = await fixture()
    let statCalls = 0
    const known = new Map([['a.png', { mtime: 0 }]])
    for await (const batch of walkImages(root, {
      known,
      gate: { allow: () => true, record: () => statCalls++ }
    })) {
      void batch
    }
    expect(statCalls).toBe(3)
  })
})
