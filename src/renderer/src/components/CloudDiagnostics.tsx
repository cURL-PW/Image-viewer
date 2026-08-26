import { useEffect, useState } from 'react'
import type { CloudDiagnostics as Diagnostics, DebugLogInfo } from '@shared/types'
import { useStore } from '../store'

/** 「直近をコピー」で持っていく行数 */
const TAIL_LINES = 300

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
  const [logInfo, setLogInfo] = useState<DebugLogInfo | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const settings = useStore((state) => state.settings)
  const updateSettings = useStore((state) => state.updateSettings)

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      const [nextDiagnostics, nextLog] = await Promise.all([
        window.api.getDiagnostics(),
        window.api.getLogInfo()
      ])
      if (cancelled) return
      setDiagnostics(nextDiagnostics)
      setLogInfo(nextLog)
    }
    void load()
    // 開いている間は追従させる
    const timer = setInterval(() => void load(), 1000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  const copyTail = async (): Promise<void> => {
    const text = await window.api.readLogTail(TAIL_LINES)
    if (text === '') {
      setCopied('まだ記録がありません')
      return
    }
    await navigator.clipboard.writeText(text)
    setCopied(`直近 ${text.split('\n').length} 行をコピーしました`)
  }

  if (!diagnostics) return <p className="field__hint">読み込み中…</p>

  const slowest = diagnostics.reads.reduce((max, read) => Math.max(max, read.ms), 0)

  return (
    <div className="diagnostics">
      <dl className="diagnostics__grid">
        <dt>クラウドフォルダ判定</dt>
        <dd>
          {diagnostics.cloudFolder ? '未ダウンロードあり' : 'なし'}
          {diagnostics.reason ? ` (${REASON_TEXT[diagnostics.reason] ?? diagnostics.reason})` : ''}
        </dd>
        <dt>自動読み込み</dt>
        <dd>
          {diagnostics.alwaysRead || !diagnostics.blocked ? '許可' : '停止中'}
          {diagnostics.alwaysRead ? ' (常に読み込む設定)' : ''}
        </dd>
        <dt>走査の stat</dt>
        <dd>
          {diagnostics.statBlocked ? '停止中 (遅すぎるため)' : '実行'}
        </dd>
        <dt>判定の方法</dt>
        <dd>
          {diagnostics.exactIndex
            ? `ファイル属性 (未ダウンロード ${diagnostics.indexSize.toLocaleString()} 件)`
            : '読み込み時間からの推定'}
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

      <h4 className="diagnostics__title">デバッグログ</h4>
      <p className="field__hint">
        ファイルに触れた操作 (走査・監視・サムネイル・タグ付け) を 1 行ずつ記録します。
        どの経路が時間をかけているかを確かめるためのものです。
      </p>
      <label className="field__check">
        <input
          type="checkbox"
          checked={settings?.debugLog !== false}
          onChange={(event) => void updateSettings({ debugLog: event.target.checked })}
        />
        デバッグログを記録する
      </label>
      <p className="field__hint">
        {logInfo
          ? `${logInfo.path} (${Math.round(logInfo.size / 1024).toLocaleString()} KB)`
          : '—'}
      </p>
      <div className="diagnostics__actions">
        <button type="button" className="button" onClick={() => void window.api.openLogFolder()}>
          ログフォルダを開く
        </button>
        <button type="button" className="button" onClick={() => void copyTail()}>
          直近をコピー
        </button>
        <button
          type="button"
          className="button"
          onClick={() => {
            setCopied(null)
            void window.api.clearLog()
          }}
        >
          ログを消す
        </button>
      </div>
      {copied ? <p className="field__hint">{copied}</p> : null}

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
