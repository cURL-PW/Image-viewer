import { AVAILABLE_MODELS } from '@shared/types'
import { useStore } from '../store'

export default function SettingsDialog(): React.JSX.Element | null {
  const settings = useStore((state) => state.settings)
  const updateSettings = useStore((state) => state.updateSettings)
  const setSettingsOpen = useStore((state) => state.setSettingsOpen)
  const scan = useStore((state) => state.scan)

  if (!settings) return null

  return (
    <div className="modal" onClick={() => setSettingsOpen(false)}>
      <div className="modal__panel" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
        <header className="modal__header">
          <h2>設定</h2>
          <button type="button" className="button button--icon" onClick={() => setSettingsOpen(false)}>
            ✕
          </button>
        </header>

        <div className="modal__body">
          <section className="field">
            <label htmlFor="model">タグ付けモデル</label>
            <select
              id="model"
              value={settings.modelId}
              onChange={(event) => void updateSettings({ modelId: event.target.value })}
            >
              {AVAILABLE_MODELS.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
            <p className="field__hint">
              変更すると全画像が再スキャンされます。モデルは初回利用時に自動ダウンロードされます。
            </p>
          </section>

          <section className="field">
            <label htmlFor="general">
              一般タグのしきい値 <strong>{settings.generalThreshold.toFixed(2)}</strong>
            </label>
            <input
              id="general"
              type="range"
              min={0.05}
              max={0.95}
              step={0.05}
              value={settings.generalThreshold}
              onChange={(event) =>
                void updateSettings({ generalThreshold: Number(event.target.value) })
              }
            />
          </section>

          <section className="field">
            <label htmlFor="character">
              キャラクタータグのしきい値 <strong>{settings.characterThreshold.toFixed(2)}</strong>
            </label>
            <input
              id="character"
              type="range"
              min={0.05}
              max={0.99}
              step={0.01}
              value={settings.characterThreshold}
              onChange={(event) =>
                void updateSettings({ characterThreshold: Number(event.target.value) })
              }
            />
          </section>

          <section className="field">
            <label htmlFor="provider">実行プロバイダ</label>
            <select
              id="provider"
              value={settings.provider}
              onChange={(event) =>
                void updateSettings({ provider: event.target.value as 'auto' | 'cpu' })
              }
            >
              <option value="auto">自動 (GPU 優先)</option>
              <option value="cpu">CPU のみ</option>
            </select>
            <p className="field__hint">
              現在の実行プロバイダ: {scan.provider ? scan.provider.toUpperCase() : '未初期化'}
            </p>
          </section>

          <section className="field field--inline">
            <label htmlFor="autoscan">
              <input
                id="autoscan"
                type="checkbox"
                checked={settings.autoScan}
                onChange={(event) => void updateSettings({ autoScan: event.target.checked })}
              />
              バックグラウンドで自動タグ付けする
            </label>
          </section>

          <section className="field field--inline">
            <label htmlFor="cloudfiles">
              <input
                id="cloudfiles"
                type="checkbox"
                checked={settings.alwaysReadCloudFiles}
                onChange={(event) =>
                  void updateSettings({ alwaysReadCloudFiles: event.target.checked })
                }
              />
              未ダウンロードの写真も読み込む
            </label>
            <p className="field__hint">
              iCloud などのクラウド同期フォルダでは、既定で未ダウンロードの写真を読み込みません。
              有効にすると、サムネイル生成やタグ付けのたびにダウンロードが走ります。
            </p>
          </section>

          <section className="field">
            <label htmlFor="thumb">
              サムネイルサイズ <strong>{settings.thumbnailSize}px</strong>
            </label>
            <input
              id="thumb"
              type="range"
              min={96}
              max={512}
              step={16}
              value={settings.thumbnailSize}
              onChange={(event) =>
                void updateSettings({ thumbnailSize: Number(event.target.value) })
              }
            />
          </section>

          <section className="field">
            <label htmlFor="edge">
              ページ送りのクリック領域 <strong>{Math.round(settings.edgeClickRatio * 100)}%</strong>
            </label>
            <input
              id="edge"
              type="range"
              min={0.05}
              max={0.45}
              step={0.05}
              value={settings.edgeClickRatio}
              onChange={(event) =>
                void updateSettings({ edgeClickRatio: Number(event.target.value) })
              }
            />
            <p className="field__hint">画像の左右端をクリックしたときに前後へ移動する幅の割合です。</p>
          </section>
        </div>

        <footer className="modal__footer">
          <button
            type="button"
            className="button button--subtle"
            onClick={() => void window.api.scanControl('retryErrors')}
          >
            失敗した画像を再試行
          </button>
          <button
            type="button"
            className="button"
            onClick={() => void window.api.scanControl('rescanAll')}
          >
            すべて再スキャン
          </button>
          <button type="button" className="button button--primary" onClick={() => setSettingsOpen(false)}>
            閉じる
          </button>
        </footer>
      </div>
    </div>
  )
}
