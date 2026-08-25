import { useEffect, useState } from 'react'
import type { CloudDiagnostics as Diagnostics } from '@shared/types'

const REASON_TEXT: Record<string, string> = {
  placeholder: '未ダウンロードのファイルを検出',
  slow: '読み込みが遅い状態が続いた',
  manual: '手動で設定',
  remembered: '以前の判定を記憶'
}

/**
 * クラウド判定の内訳を表示する。
 *
 * どの経路が遅いのか、プレースホルダ判定が当たっているのかを、
 * PowerShell などの手作業なしで確認できるようにするためのもの。
 */
export default function CloudDiagnosticsPanel(): React.JSX.Element {
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      const next = await window.api.getDiagnostics()
      if (!cancelled) setDiagnostics(next)
    }
    void load()
    // 開いている間は追従させる
    const timer = setInterval(() => void load(), 1000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  if (!diagnostics) return <p className="field__hint">読み込み中…</p>

  const slowest = diagnostics.reads.reduce((max, read) => Math.max(max, read.ms), 0)

  return (
    <div className="diagnostics">
      <dl className="diagnostics__grid">
        <dt>クラウドモード</dt>
        <dd>
          {diagnostics.cloudMode ? 'オン' : 'オフ'}
          {diagnostics.reason ? ` (${REASON_TEXT[diagnostics.reason] ?? diagnostics.reason})` : ''}
        </dd>
        <dt>自動読み込み</dt>
        <dd>
          {diagnostics.alwaysRead || !diagnostics.cloudMode ? '許可' : '停止中'}
          {diagnostics.alwaysRead ? ' (常に読み込む設定)' : ''}
        </dd>
        <dt>遅いと判定する時間</dt>
        <dd>{diagnostics.slowReadMs} ms 超</dd>
        <dt>直近の最遅</dt>
        <dd>{diagnostics.reads.length > 0 ? `${slowest} ms` : '—'}</dd>
      </dl>

      <h4 className="diagnostics__title">直近の読み込み時間</h4>
      {diagnostics.reads.length === 0 ? (
        <p className="field__hint">まだ記録がありません</p>
      ) : (
        <ul className="diagnostics__list">
          {diagnostics.reads.slice(0, 10).map((read, index) => (
            <li key={index}>
              <span>{read.kind}</span>
              <span className={read.ms > diagnostics.slowReadMs ? 'diagnostics__slow' : ''}>
                {read.ms} ms
              </span>
            </li>
          ))}
        </ul>
      )}

      <h4 className="diagnostics__title">未ダウンロード判定 (Windows のみ)</h4>
      {diagnostics.platform !== 'win32' ? (
        <p className="field__hint">{diagnostics.platform} では判定しません</p>
      ) : diagnostics.placeholders.length === 0 ? (
        <p className="field__hint">まだ記録がありません</p>
      ) : (
        <ul className="diagnostics__list">
          {diagnostics.placeholders.slice(0, 10).map((sample, index) => (
            <li key={index}>
              <span>{sample.name}</span>
              <span>
                size {sample.size.toLocaleString()} / blocks {sample.blocks.toLocaleString()} →{' '}
                {sample.verdict ? '未ダウンロード' : 'ローカル'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
