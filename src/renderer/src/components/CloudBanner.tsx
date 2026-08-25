import { useStore } from '../store'

const REASON_TEXT: Record<string, string> = {
  placeholder: 'まだダウンロードされていない写真が見つかりました',
  slow: 'ファイルの読み込みに時間がかかっています',
  manual: '手動でクラウドモードにしています'
}

/**
 * クラウド同期フォルダ (iCloud など) を検知したときの案内。
 *
 * 未ダウンロードの写真を自動で読むとダウンロードが延々と走るため、既定では止めている。
 * ここから明示的にまとめてダウンロードするか、常に読み込む設定へ切り替えられる。
 */
export default function CloudBanner(): React.JSX.Element | null {
  const scan = useStore((state) => state.scan)
  const dir = useStore((state) => state.dir)
  const recursive = useStore((state) => state.recursive)
  const settings = useStore((state) => state.settings)
  const updateSettings = useStore((state) => state.updateSettings)

  const download = scan.download
  const downloading = download !== null

  if (!scan.cloudFolder && !scan.cloudBlocked && !downloading) return null

  if (downloading) {
    const percent = download.total > 0 ? Math.round((download.done / download.total) * 100) : 0
    return (
      <div className="banner banner--progress">
        <span className="banner__text">
          ダウンロード中 {download.done.toLocaleString()} / {download.total.toLocaleString()} (
          {percent}%)
          {download.current ? ` — ${download.current}` : ''}
        </span>
        <div className="toolbar__spacer" />
        <button type="button" className="button" onClick={() => void window.api.cancelDownload()}>
          中断
        </button>
      </div>
    )
  }

  const alwaysRead = settings?.alwaysReadCloudFiles === true

  return (
    <div className="banner">
      <span className="banner__text">
        {REASON_TEXT[scan.cloudReason ?? 'slow'] ?? REASON_TEXT.slow}。
        {scan.cloudBlocked
          ? '自動の読み込み (サムネイル・タグ付け) を止めています'
          : '未ダウンロードの写真だけを読み込まずにいます'}
        {scan.notDownloaded > 0 ? ` (${scan.notDownloaded.toLocaleString()} 枚)` : ''}。
        写真を開けばその 1 枚はダウンロードされます。
      </span>
      <div className="toolbar__spacer" />
      <label className="banner__toggle" title="未ダウンロードの写真も自動で読み込みます">
        <input
          type="checkbox"
          checked={alwaysRead}
          onChange={(event) => void updateSettings({ alwaysReadCloudFiles: event.target.checked })}
        />
        常に読み込む
      </label>
      <button
        type="button"
        className="button button--primary"
        onClick={() => void window.api.downloadFolder({ dir, recursive })}
      >
        このフォルダをダウンロードしてタグ付け
      </button>
    </div>
  )
}
