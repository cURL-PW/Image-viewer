// ブラウザ拡張 (extension/) を配布用の zip にまとめる。
//   release/extension/image-viewer-extension-<版>.zip  … Chrome / Edge 用 (ストア提出・展開して読み込み)
//   release/extension/image-viewer-extension-<版>.xpi  … Firefox 用 (署名は別途)
//   release/extension/firefox/, chrome/                … 同じ中身を展開したもの (web-ext sign や読み込み用)
// extension/manifest.json は両方のブラウザでそのまま読み込めるよう background を二通り書いてあるが、
// 配布物ではそれぞれのブラウザが使わない項目を落とす (AMO の検証で警告が出るため)。
// 外部ツールに頼らないよう、zip は自前で書く (Windows でもそのまま動く)。
import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'extension')
const outDir = path.join(root, 'release', 'extension')

/** zip に入れるファイル。説明書などは入れない */
const INCLUDE = /\.(json|js|html|css|png)$/

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(data) {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

async function listFiles(dir, prefix = '') {
  const result = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) result.push(...(await listFiles(path.join(dir, entry.name), relative)))
    else if (INCLUDE.test(entry.name)) result.push(relative)
  }
  return result.sort()
}

/** 日時は固定する (同じ中身なら同じ zip になるように) */
const DOS_TIME = 0
const DOS_DATE = (1 << 5) | 1 // 1980-01-01

function buildZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8')
    const compressed = zlib.deflateRawSync(data, { level: 9 })
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // ファイル名は UTF-8
    local.writeUInt16LE(8, 8) // deflate
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    locals.push(local, nameBytes, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)

    offset += local.length + nameBytes.length + compressed.length
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

/** Firefox は background.scripts を使う (service_worker は無視され、警告になる) */
function firefoxManifest(manifest) {
  const { service_worker: _unused, ...background } = manifest.background
  return { ...manifest, background }
}

/** Chrome / Edge は service_worker を使う。scripts と Firefox 用の設定は要らない */
function chromeManifest(manifest) {
  const { scripts: _unused, ...background } = manifest.background
  const { browser_specific_settings: _gecko, ...rest } = manifest
  return { ...rest, background }
}

const manifest = JSON.parse(await fs.readFile(path.join(source, 'manifest.json'), 'utf8'))
const files = (await listFiles(source)).filter((name) => name !== 'manifest.json')
const common = await Promise.all(
  files.map(async (name) => ({ name, data: await fs.readFile(path.join(source, name)) }))
)

await fs.mkdir(outDir, { recursive: true })
const base = path.join(outDir, `image-viewer-extension-${manifest.version}`)
const targets = [
  { dir: 'firefox', ext: 'xpi', manifest: firefoxManifest(manifest) },
  { dir: 'chrome', ext: 'zip', manifest: chromeManifest(manifest) }
]
for (const target of targets) {
  const manifestEntry = {
    name: 'manifest.json',
    data: Buffer.from(`${JSON.stringify(target.manifest, null, 2)}\n`, 'utf8')
  }
  const entries = [manifestEntry, ...common].sort((a, b) => (a.name < b.name ? -1 : 1))
  await fs.writeFile(`${base}.${target.ext}`, buildZip(entries))

  const unpacked = path.join(outDir, target.dir)
  await fs.rm(unpacked, { recursive: true, force: true })
  for (const { name, data } of entries) {
    await fs.mkdir(path.dirname(path.join(unpacked, name)), { recursive: true })
    await fs.writeFile(path.join(unpacked, name), data)
  }
}
console.log(
  `${common.length + 1} ファイルをまとめました: ${path.relative(root, base)}.xpi (Firefox) / .zip (Chrome・Edge)`
)
