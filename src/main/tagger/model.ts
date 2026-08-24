import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { net } from 'electron'
import { TagCategory } from '@shared/types'

const HF_BASE = 'https://huggingface.co'
const MODEL_FILE = 'model.onnx'
const TAGS_FILE = 'selected_tags.csv'

export interface ModelFiles {
  modelPath: string
  tagsPath: string
}

export interface TagVocabularyEntry {
  name: string
  category: number
}

export function sanitizeModelId(modelId: string): string {
  return modelId.replace(/[^A-Za-z0-9._-]+/g, '_')
}

function fileUrl(modelId: string, file: string): string {
  return `${HF_BASE}/${modelId}/resolve/main/${file}?download=true`
}

async function exists(target: string): Promise<boolean> {
  try {
    const stats = await fsp.stat(target)
    return stats.isFile() && stats.size > 0
  } catch {
    return false
  }
}

/**
 * Hugging Face から 1 ファイルをダウンロードする。
 * 途中で失敗しても壊れたファイルが残らないよう、一時ファイルに書いてから rename する。
 */
async function download(
  url: string,
  destination: string,
  onProgress: (received: number, total: number | null) => void
): Promise<void> {
  const response = await net.fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(`ダウンロードに失敗しました (${response.status}): ${url}`)
  }

  const totalHeader = response.headers.get('content-length')
  const total = totalHeader ? Number(totalHeader) : null
  let received = 0

  await fsp.mkdir(path.dirname(destination), { recursive: true })
  const tempPath = `${destination}.part`

  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
  source.on('data', (chunk: Buffer) => {
    received += chunk.length
    onProgress(received, total)
  })

  await pipeline(source, fs.createWriteStream(tempPath))
  await fsp.rename(tempPath, destination)
}

/**
 * モデルと selected_tags.csv をローカルキャッシュに用意し、そのパスを返す。
 * すでに存在する場合はダウンロードしない。
 */
export async function ensureModel(
  cacheRoot: string,
  modelId: string,
  onProgress: (fraction: number, label: string) => void
): Promise<ModelFiles> {
  const dir = path.join(cacheRoot, sanitizeModelId(modelId))
  const modelPath = path.join(dir, MODEL_FILE)
  const tagsPath = path.join(dir, TAGS_FILE)

  if (!(await exists(tagsPath))) {
    onProgress(0, 'タグ一覧をダウンロード中')
    await download(fileUrl(modelId, TAGS_FILE), tagsPath, () => {})
  }

  if (!(await exists(modelPath))) {
    onProgress(0, 'モデルをダウンロード中')
    await download(fileUrl(modelId, MODEL_FILE), modelPath, (received, total) => {
      if (total && total > 0) {
        onProgress(received / total, 'モデルをダウンロード中')
      }
    })
  }

  return { modelPath, tagsPath }
}

/** ダブルクォートで囲まれたフィールドに対応した最小限の CSV 行分割。 */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let quoted = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        current += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      fields.push(current)
      current = ''
    } else {
      current += char
    }
  }
  fields.push(current)
  return fields
}

/**
 * selected_tags.csv を読み、出力インデックス順のタグ語彙を返す。
 * 期待するヘッダ: tag_id,name,category,count
 */
export function parseTagVocabulary(csv: string): TagVocabularyEntry[] {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim() !== '')
  if (lines.length === 0) return []

  const header = parseCsvLine(lines[0]).map((field) => field.trim().toLowerCase())
  const nameIndex = header.indexOf('name')
  const categoryIndex = header.indexOf('category')
  if (nameIndex === -1 || categoryIndex === -1) {
    throw new Error('selected_tags.csv の形式が想定と異なります')
  }

  const entries: TagVocabularyEntry[] = []
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i])
    const name = fields[nameIndex]?.trim()
    if (!name) continue
    const category = Number(fields[categoryIndex])
    entries.push({
      name,
      category: Number.isFinite(category) ? category : TagCategory.General
    })
  }
  return entries
}

export async function loadTagVocabulary(tagsPath: string): Promise<TagVocabularyEntry[]> {
  return parseTagVocabulary(await fsp.readFile(tagsPath, 'utf8'))
}
