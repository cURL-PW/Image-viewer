import { useEffect, useState } from 'react'
import type { BrowserImportInfo } from '@shared/types'
import { useStore } from '../store'

function statusText(info: BrowserImportInfo | null, enabled: boolean): string {
  if (!enabled) return '停止中'
  if (!info) return '確認中…'
  const { status } = info
  if (status.listening) return `受け付け中 (127.0.0.1:${status.port})`
  if (status.error === 'in-use') {
    return `ポート ${status.port} は他のアプリが使っています。別の番号にしてください`
  }
  return status.error ? `開けませんでした: ${status.error}` : '停止中'
}

/**
 * ブラウザ拡張からの取り込みの設定。受け口のオン・オフ、ポート、拡張に貼り付ける合言葉。
 * ポートは入力中には保存せず、フォーカスが外れたときに保存する (1 文字ごとに開き直さないため)
 */
export default function BrowserImportField(): React.JSX.Element | null {
  const settings = useStore((state) => state.settings)
  const updateSettings = useStore((state) => state.updateSettings)
  const showNotice = useStore((state) => state.showNotice)
  const [info, setInfo] = useState<BrowserImportInfo | null>(null)
  const [port, setPort] = useState(String(settings?.browserImportPort ?? ''))
  const [editingPort, setEditingPort] = useState(false)

  const enabled = settings?.browserImport ?? false
  const savedPort = settings?.browserImportPort

  // 有効・無効やポートが変わるたびに、実際に開けたかを確かめ直す
  useEffect(() => {
    let cancelled = false
    void window.api.getBrowserImport().then((next) => {
      if (!cancelled) setInfo(next)
    })
    return () => {
      cancelled = true
    }
  }, [enabled, savedPort])

  useEffect(() => {
    if (!editingPort && savedPort !== undefined) setPort(String(savedPort))
  }, [savedPort, editingPort])

  if (!settings) return null

  const savePort = (): void => {
    setEditingPort(false)
    const value = Number(port)
    if (Number.isInteger(value) && value !== settings.browserImportPort) {
      void updateSettings({ browserImportPort: value })
    } else {
      setPort(String(settings.browserImportPort))
    }
  }

  const copyToken = async (): Promise<void> => {
    if (!info) return
    await navigator.clipboard.writeText(info.token)
    showNotice('合言葉をコピーしました')
  }

  const regenerate = async (): Promise<void> => {
    if (!window.confirm('合言葉を作り直すと、拡張の設定にも貼り直すまで取り込めなくなります。作り直しますか?')) {
      return
    }
    setInfo(await window.api.regenerateImportToken())
    showNotice('合言葉を作り直しました')
  }

  const listening = enabled && info?.status.listening === true

  return (
    <section className="field browser-import">
      <label htmlFor="browser-import" className="browser-import__toggle">
        <input
          id="browser-import"
          type="checkbox"
          checked={enabled}
          onChange={(event) => void updateSettings({ browserImport: event.target.checked })}
        />
        ブラウザからの取り込みを受け付ける
      </label>
      <p className="field__hint">
        ブラウザ拡張「Image Viewer に取り込む」から送られた画像を、開いているライブラリの
        <code>Imported</code> フォルダに保存します。受け口はこの PC の中 (127.0.0.1) からだけ届きます。
      </p>

      <div className="browser-import__row">
        <label htmlFor="browser-import-port">ポート</label>
        <input
          id="browser-import-port"
          className="browser-import__port"
          type="number"
          min={1024}
          max={65535}
          value={port}
          onFocus={() => setEditingPort(true)}
          onChange={(event) => setPort(event.target.value)}
          onBlur={savePort}
          onKeyDown={(event) => {
            if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
          }}
        />
        <span
          className={`browser-import__status${listening ? ' browser-import__status--on' : ''}${
            enabled && info?.status.error ? ' browser-import__status--error' : ''
          }`}
          data-testid="browser-import-status"
        >
          {statusText(info, enabled)}
        </span>
      </div>

      <div className="browser-import__row">
        <label htmlFor="browser-import-token">合言葉</label>
        <input
          id="browser-import-token"
          className="browser-import__token"
          type="text"
          readOnly
          spellCheck={false}
          value={info?.token ?? ''}
          onFocus={(event) => event.target.select()}
        />
        <button type="button" className="button button--subtle" onClick={() => void copyToken()}>
          コピー
        </button>
        <button type="button" className="button button--subtle" onClick={() => void regenerate()}>
          作り直す
        </button>
      </div>
      <p className="field__hint">
        拡張の設定画面に、このポート番号と合言葉を貼り付けてください。合言葉が合わない送信は受け付けません。
      </p>
    </section>
  )
}
