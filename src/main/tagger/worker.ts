/**
 * WD14 tagger の推論を行う utilityProcess ワーカー。
 * onnxruntime と sharp の重い処理を main プロセスから切り離し、UI の応答性を守る。
 */
import sharp from 'sharp'
import * as ort from 'onnxruntime-node'
import { TagCategory } from '@shared/types'
import type { TagResult } from '../db'
import type { WorkerRequest, WorkerResponse } from './protocol'

const DEFAULT_INPUT_SIZE = 448

let session: ort.InferenceSession | null = null
let vocabulary: { name: string; category: number }[] = []
let inputSize = DEFAULT_INPUT_SIZE
let inputName = ''
let outputName = ''

const port = process.parentPort

function send(message: WorkerResponse): void {
  port.postMessage(message)
}

/** モデル入力の空間サイズを推定する。動的形状のモデルは既定値にフォールバックする。 */
function detectInputSize(loaded: ort.InferenceSession): number {
  try {
    const metadata = (loaded as unknown as { inputMetadata?: Record<string, { dimensions?: number[] }> })
      .inputMetadata
    const dims = metadata?.[loaded.inputNames[0]]?.dimensions
    if (dims && dims.length === 4) {
      // NHWC を想定。動的次元は -1 で入ってくる
      const candidate = dims[1] > 0 ? dims[1] : dims[2]
      if (candidate > 0) return candidate
    }
  } catch {
    // メタデータが取れないランタイムでは既定値を使う
  }
  return DEFAULT_INPUT_SIZE
}

async function init(request: Extract<WorkerRequest, { type: 'init' }>): Promise<void> {
  const { parseTagVocabulary } = await import('./model')
  const fsp = await import('node:fs/promises')
  vocabulary = parseTagVocabulary(await fsp.readFile(request.tagsPath, 'utf8'))

  let lastError: unknown = null
  for (const provider of request.providers) {
    try {
      session = await ort.InferenceSession.create(request.modelPath, {
        executionProviders: [provider],
        graphOptimizationLevel: 'all'
      })
      inputName = session.inputNames[0]
      outputName = session.outputNames[0]
      inputSize = detectInputSize(session)
      send({ type: 'ready', provider, inputSize, tagCount: vocabulary.length })
      return
    } catch (error) {
      lastError = error
      send({
        type: 'log',
        message: `実行プロバイダ ${provider} を利用できません: ${describe(error)}`
      })
    }
  }

  send({
    type: 'initError',
    message: `推論セッションを作成できませんでした: ${describe(lastError)}`
  })
}

/**
 * WD14 の標準的な前処理。
 * 白背景で正方形にパディング → モデル入力サイズへリサイズ → BGR float32 (0-255) の NHWC。
 */
async function preprocess(
  filePath: string
): Promise<{ tensor: ort.Tensor; width: number; height: number }> {
  const image = sharp(filePath, { failOn: 'none', animated: false }).rotate()
  const metadata = await image.metadata()

  const { data } = await image
    .flatten({ background: '#ffffff' })
    .resize(inputSize, inputSize, {
      fit: 'contain',
      background: { r: 255, g: 255, b: 255, alpha: 1 },
      position: 'center',
      kernel: 'lanczos3'
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const pixels = inputSize * inputSize
  const tensorData = new Float32Array(pixels * 3)
  for (let i = 0; i < pixels; i++) {
    const src = i * 3
    const dst = i * 3
    // RGB → BGR
    tensorData[dst] = data[src + 2]
    tensorData[dst + 1] = data[src + 1]
    tensorData[dst + 2] = data[src]
  }

  const rotated = metadata.orientation !== undefined && metadata.orientation >= 5
  return {
    tensor: new ort.Tensor('float32', tensorData, [1, inputSize, inputSize, 3]),
    width: (rotated ? metadata.height : metadata.width) ?? 0,
    height: (rotated ? metadata.width : metadata.height) ?? 0
  }
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value))
}

function postprocess(
  scores: Float32Array,
  generalThreshold: number,
  characterThreshold: number
): TagResult[] {
  // v3 モデルは sigmoid 適用済みだが、生のロジットを返すモデルにも備える
  let probabilities: ArrayLike<number> = scores
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] < 0 || scores[i] > 1) {
      probabilities = Array.from(scores, sigmoid)
      break
    }
  }

  const tags: TagResult[] = []
  let bestRating: TagResult | null = null

  const count = Math.min(vocabulary.length, probabilities.length)
  for (let i = 0; i < count; i++) {
    const entry = vocabulary[i]
    const confidence = probabilities[i]

    if (entry.category === TagCategory.Rating) {
      // rating は排他的なので、しきい値ではなく最大値を 1 つだけ採用する
      if (!bestRating || confidence > bestRating.confidence) {
        bestRating = { name: entry.name, category: entry.category, confidence }
      }
      continue
    }

    const threshold =
      entry.category === TagCategory.Character ? characterThreshold : generalThreshold
    if (confidence >= threshold) {
      tags.push({ name: entry.name, category: entry.category, confidence })
    }
  }

  if (bestRating) tags.push(bestRating)
  tags.sort((a, b) => b.confidence - a.confidence)
  return tags
}

async function infer(request: Extract<WorkerRequest, { type: 'infer' }>): Promise<void> {
  if (!session) {
    send({ type: 'error', jobId: request.jobId, message: '推論セッションが未初期化です' })
    return
  }
  try {
    const { tensor, width, height } = await preprocess(request.filePath)
    const output = await session.run({ [inputName]: tensor })
    const scores = output[outputName].data as Float32Array
    send({
      type: 'result',
      jobId: request.jobId,
      tags: postprocess(scores, request.generalThreshold, request.characterThreshold),
      width,
      height
    })
  } catch (error) {
    send({ type: 'error', jobId: request.jobId, message: describe(error) })
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

port.on('message', (event) => {
  const request = event.data as WorkerRequest
  switch (request.type) {
    case 'init':
      void init(request)
      break
    case 'infer':
      void infer(request)
      break
    case 'shutdown':
      void session?.release().finally(() => process.exit(0))
      break
  }
})
