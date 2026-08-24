import type { TagResult } from '../db'

export type WorkerRequest =
  | { type: 'init'; modelPath: string; tagsPath: string; providers: string[] }
  | {
      type: 'infer'
      jobId: number
      filePath: string
      generalThreshold: number
      characterThreshold: number
    }
  | { type: 'shutdown' }

export type WorkerResponse =
  | { type: 'ready'; provider: string; inputSize: number; tagCount: number }
  | { type: 'initError'; message: string }
  | { type: 'result'; jobId: number; tags: TagResult[]; width: number; height: number }
  | { type: 'error'; jobId: number; message: string }
  | { type: 'log'; message: string }

/** 設定に応じた実行プロバイダの試行順。先頭から順に成功するまで試す。 */
export function providerCandidates(mode: 'auto' | 'cpu'): string[] {
  if (mode === 'cpu') return ['cpu']
  if (process.platform === 'win32') return ['cuda', 'dml', 'cpu']
  if (process.platform === 'darwin') return ['coreml', 'cpu']
  return ['cuda', 'cpu']
}
