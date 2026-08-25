import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DebugLog, debugLog, formatEvent, initDebugLog, setDebugLog } from './debug-log'

let dir: string
let file: string

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'debug-log-'))
  file = path.join(dir, 'logs', 'debug.log')
})

afterEach(async () => {
  setDebugLog(null)
  await fsp.rm(dir, { recursive: true, force: true })
})

describe('formatEvent', () => {
  const now = new Date('2026-08-25T12:34:56.789Z')

  it('タブ区切りの 1 行にする', () => {
    const line = formatEvent(
      { kind: 'thumb-gen', decision: 'blocked', ms: 5210, target: 'Photos/IMG_8582.HEIC' },
      now
    )
    const columns = line.split('\t')
    expect(columns[0]).toBe('2026-08-25T12:34:56.789Z')
    expect(columns[1].trim()).toBe('thumb-gen')
    expect(columns[2].trim()).toBe('blocked')
    expect(columns[3].trim()).toBe('5210ms')
    expect(columns[4]).toBe('Photos/IMG_8582.HEIC')
  })

  it('省略した項目はプレースホルダで埋める', () => {
    const columns = formatEvent({ kind: 'watch-change', target: 'a.jpg' }, now).split('\t')
    expect(columns[2].trim()).toBe('-')
    expect(columns[3].trim()).toBe('-')
  })

  it('補足は最後の列に付く', () => {
    const columns = formatEvent({ kind: 'guard-mode', note: '停止 (slow)' }, now).split('\t')
    expect(columns.at(-1)).toBe('停止 (slow)')
  })

  it('小数の所要時間は丸める', () => {
    const columns = formatEvent({ kind: 'walk-stat', ms: 12.7 }, now).split('\t')
    expect(columns[3].trim()).toBe('13ms')
  })
})

describe('DebugLog', () => {
  it('有効なら追記する', async () => {
    const log = new DebugLog(file, true)
    log.log({ kind: 'walk-stat', target: 'a.jpg' })
    log.log({ kind: 'thumb-gen', target: 'a.jpg' })
    await log.dispose()

    const content = await fsp.readFile(file, 'utf8')
    expect(content.trimEnd().split('\n')).toHaveLength(2)
    expect(content).toContain('walk-stat')
    expect(content).toContain('thumb-gen')
  })

  it('無効なら 1 バイトも書かない', async () => {
    const log = new DebugLog(file, false)
    log.log({ kind: 'walk-stat', target: 'a.jpg' })
    await log.dispose()
    expect(fs.existsSync(file)).toBe(false)
  })

  it('途中で切り替えられる', async () => {
    const log = new DebugLog(file, false)
    log.log({ kind: '書かれない' })
    log.setEnabled(true)
    log.log({ kind: '書かれる' })
    await log.dispose()

    const content = await fsp.readFile(file, 'utf8')
    expect(content).not.toContain('書かれない')
    expect(content).toContain('書かれる')
  })

  it('measure は所要時間を残す', async () => {
    const log = new DebugLog(file, true)
    const result = await log.measure({ kind: 'open-image', target: 'a.jpg' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return 'ok'
    })
    await log.dispose()

    expect(result).toBe('ok')
    expect(await fsp.readFile(file, 'utf8')).toMatch(/open-image.*\d+ms/)
  })

  it('measure は失敗も残したうえで例外を投げ直す', async () => {
    const log = new DebugLog(file, true)
    await expect(
      log.measure({ kind: 'open-image', target: 'a.jpg' }, async () => {
        throw new Error('読めません')
      })
    ).rejects.toThrow('読めません')
    await log.dispose()

    const content = await fsp.readFile(file, 'utf8')
    expect(content).toContain('読めません')
    expect(content).toContain('skipped')
  })

  it('8MB を超えたら 1 世代だけ退避する', async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, 'x'.repeat(8 * 1024 * 1024 + 1))

    const log = new DebugLog(file, true)
    log.log({ kind: '新しい行' })
    await log.dispose()

    expect(await fsp.readFile(file, 'utf8')).toContain('新しい行')
    // 古い内容は .1 へ移っている
    expect((await fsp.stat(`${file}.1`)).size).toBeGreaterThan(8 * 1024 * 1024)
  })

  it('tail は末尾から指定行数を返す', async () => {
    const log = new DebugLog(file, true)
    for (let i = 0; i < 10; i++) log.log({ kind: `line-${i}` })

    const tail = await log.tail(3)
    const lines = tail.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('line-7')
    expect(lines[2]).toContain('line-9')
    await log.dispose()
  })

  it('ファイルが無ければ tail は空文字', async () => {
    const log = new DebugLog(file, true)
    expect(await log.tail(300)).toBe('')
  })

  it('clear で消える', async () => {
    const log = new DebugLog(file, true)
    log.log({ kind: 'walk-stat' })
    await log.flush()
    await log.clear()
    expect(fs.existsSync(file)).toBe(false)
  })
})

describe('共有インスタンス', () => {
  it('初期化前は何も書かない無効なログを返す', () => {
    setDebugLog(null)
    expect(debugLog().isEnabled).toBe(false)
    // 例外にならないこと (計測側で null チェックを書かなくて済む)
    expect(() => debugLog().log({ kind: 'walk-stat' })).not.toThrow()
  })

  it('初期化したものが共有される', async () => {
    const log = initDebugLog(file, true)
    expect(debugLog()).toBe(log)
    debugLog().log({ kind: 'walk-stat' })
    await log.dispose()
    expect(await fsp.readFile(file, 'utf8')).toContain('walk-stat')
  })
})
