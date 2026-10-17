import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BrowserImporter,
  IMPORT_DIR,
  deriveBaseName,
  detectImageExtension,
  sanitizeBaseName
} from './browser-import'
import { LibraryDb } from './db'
import { Library } from './library'

describe('detectImageExtension', () => {
  it('中身から形式を判定する', async () => {
    const pixel = sharp({ create: { width: 2, height: 2, channels: 3, background: '#f00' } })
    expect(detectImageExtension(await pixel.clone().jpeg().toBuffer())).toBe('.jpg')
    expect(detectImageExtension(await pixel.clone().png().toBuffer())).toBe('.png')
    expect(detectImageExtension(await pixel.clone().webp().toBuffer())).toBe('.webp')
    expect(detectImageExtension(await pixel.clone().gif().toBuffer())).toBe('.gif')
    expect(detectImageExtension(Buffer.from('<!doctype html><html></html>'))).toBeNull()
  })
})

describe('sanitizeBaseName', () => {
  it('Windows で使えない文字と予約名を避ける', () => {
    expect(sanitizeBaseName('a<b>c:d"e/f\\g|h?i*j')).toBe('a_b_c_d_e_f_g_h_i_j')
    expect(sanitizeBaseName('CON')).toBe('_CON')
    expect(sanitizeBaseName('  name.  ')).toBe('name')
  })

  it('先頭の「.」を取り除く (隠しファイルは監視の対象外のため)', () => {
    expect(sanitizeBaseName('.hidden')).toBe('hidden')
  })
})

describe('deriveBaseName', () => {
  const now = new Date(2026, 9, 17, 12, 34, 56)

  it('拡張の指定したファイル名を優先し、元の拡張子は落とす', () => {
    expect(deriveBaseName({ fileName: 'photo.png', imageUrl: 'https://e.com/x.jpg' }, now)).toBe('photo')
  })

  it('画像 URL の末尾を使う (エンコードも戻す)', () => {
    expect(deriveBaseName({ imageUrl: 'https://e.com/a/%E5%86%99%E7%9C%9F.jpg?w=1' }, now)).toBe('写真')
    expect(deriveBaseName({ imageUrl: 'https://pbs.twimg.com/media/AbCd?format=jpg' }, now)).toBe('AbCd')
  })

  it('名前が取れなければ「サイト名_日時」', () => {
    expect(deriveBaseName({ pageUrl: 'https://www.example.com/page' }, now)).toBe(
      'example.com_20261017-123456'
    )
    expect(deriveBaseName({}, now)).toBe('image_20261017-123456')
  })
})

describe('BrowserImporter', () => {
  let base: string
  let root: string
  let db: LibraryDb
  let library: Library
  let importer: BrowserImporter

  beforeEach(async () => {
    base = await fsp.mkdtemp(path.join(os.tmpdir(), 'image-viewer-import-'))
    root = path.join(base, 'library')
    await fsp.mkdir(root)
    db = new LibraryDb(path.join(base, 'library.db'))
    library = new Library(db)
    importer = new BrowserImporter(db, library)
  })

  afterEach(async () => {
    await library.stop()
    db.close()
    await fsp.rm(base, { recursive: true, force: true })
  })

  async function png(color: string): Promise<Buffer> {
    return sharp({ create: { width: 4, height: 4, channels: 3, background: color } }).png().toBuffer()
  }

  it('ライブラリを開いていなければ断る', async () => {
    const { result } = await importer.import(await png('#f00'), {})
    expect(result).toEqual({ status: 'no-library' })
  })

  it('Imported に保存し、同名は連番、同じ中身は重複として扱う', async () => {
    await library.setRoot(root)
    const meta = {
      pageUrl: 'https://x.com/someone/status/123',
      imageUrl: 'https://pbs.twimg.com/media/Abc?format=png&name=orig',
      site: 'twitter',
      author: 'someone',
      postId: '123'
    }

    const first = await importer.import(await png('#f00'), meta)
    expect(first.result).toEqual({ status: 'imported', fileName: 'Abc.png', relPath: `${IMPORT_DIR}/Abc.png` })
    expect(first.id).not.toBeNull()
    expect(await fsp.readdir(path.join(root, IMPORT_DIR))).toEqual(['Abc.png'])

    const second = await importer.import(await png('#00f'), meta)
    expect(second.result).toMatchObject({ status: 'imported', fileName: 'Abc (2).png' })

    const again = await importer.import(await png('#f00'), meta)
    expect(again.result).toMatchObject({ status: 'duplicate', fileName: 'Abc.png' })
    expect(again.id).toBe(first.id)

    const source = db.getImageSource(library.currentRootId as number, `${IMPORT_DIR}/Abc.png`)
    expect(source).toMatchObject({
      pageUrl: meta.pageUrl,
      imageUrl: meta.imageUrl,
      site: 'twitter',
      author: 'someone',
      postId: '123'
    })
  })

  it('取り込んだファイルが消されていれば、同じ中身でも取り込み直す', async () => {
    await library.setRoot(root)
    const data = await png('#0f0')
    const first = await importer.import(data, { fileName: 'green' })
    await fsp.rm(path.join(root, IMPORT_DIR, 'green.png'))
    const again = await importer.import(data, { fileName: 'green' })
    expect(again.result).toMatchObject({ status: 'imported', fileName: 'green.png' })
    expect(first.result.status).toBe('imported')
  })

  it('画像でないものは保存しない', async () => {
    await library.setRoot(root)
    const { result } = await importer.import(Buffer.from('<html>not an image</html>'), {})
    expect(result).toEqual({ status: 'unsupported' })
  })

  it('記録する URL は http(s) だけ', async () => {
    await library.setRoot(root)
    await importer.import(await png('#ff0'), {
      fileName: 'yellow',
      pageUrl: 'javascript:alert(1)',
      imageUrl: 'data:image/png;base64,AAAA'
    })
    const source = db.getImageSource(library.currentRootId as number, `${IMPORT_DIR}/yellow.png`)
    expect(source).toMatchObject({ pageUrl: null, imageUrl: null })
  })
})
