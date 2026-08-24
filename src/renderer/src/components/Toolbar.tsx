import type { SortKey } from '@shared/types'
import { useStore } from '../store'

const SORT_LABELS: Record<SortKey, string> = {
  path: 'パス',
  name: 'ファイル名',
  mtime: '更新日時',
  size: 'サイズ'
}

function ScanStatus(): React.JSX.Element | null {
  const scan = useStore((state) => state.scan)
  const index = useStore((state) => state.index)

  if (index.scanning) {
    return <span className="status">フォルダを走査中… {index.found.toLocaleString()} 枚</span>
  }

  if (scan.state === 'error') {
    return <span className="status status--error">タグ付けエラー: {scan.message}</span>
  }
  if (scan.state === 'preparing') {
    const percent = scan.modelProgress !== null ? ` ${Math.round(scan.modelProgress * 100)}%` : ''
    return (
      <span className="status">
        {scan.message ?? 'モデルを準備中'}
        {percent}
      </span>
    )
  }
  if (scan.total === 0) return null

  const remaining = scan.total - scan.done
  if (scan.state === 'running') {
    return (
      <span className="status">
        タグ付け中 {scan.done.toLocaleString()} / {scan.total.toLocaleString()}
        {scan.provider ? ` (${scan.provider.toUpperCase()})` : ''}
      </span>
    )
  }
  if (scan.state === 'paused') {
    return <span className="status">一時停止中 (残り {remaining.toLocaleString()} 枚)</span>
  }
  return (
    <span className="status status--done">
      タグ付け完了 {scan.done.toLocaleString()} / {scan.total.toLocaleString()}
    </span>
  )
}

export default function Toolbar(): React.JSX.Element {
  const root = useStore((state) => state.root)
  const openFolder = useStore((state) => state.openFolder)
  const sortKey = useStore((state) => state.sortKey)
  const sortOrder = useStore((state) => state.sortOrder)
  const setSort = useStore((state) => state.setSort)
  const scan = useStore((state) => state.scan)
  const setSettingsOpen = useStore((state) => state.setSettingsOpen)
  const total = useStore((state) => state.ids.length)

  const scanning = scan.state === 'running' || scan.state === 'preparing'

  return (
    <header className="toolbar">
      <button type="button" className="button" onClick={() => void openFolder()}>
        フォルダを開く
      </button>
      <span className="toolbar__root" title={root?.path ?? ''}>
        {root?.path ?? '—'}
      </span>

      <span className="toolbar__count">{total.toLocaleString()} 枚</span>

      <label className="toolbar__field">
        並び順
        <select
          value={sortKey}
          onChange={(event) => setSort(event.target.value as SortKey, sortOrder)}
        >
          {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
            <option key={key} value={key}>
              {SORT_LABELS[key]}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="button button--icon"
        title={sortOrder === 'asc' ? '昇順' : '降順'}
        onClick={() => setSort(sortKey, sortOrder === 'asc' ? 'desc' : 'asc')}
      >
        {sortOrder === 'asc' ? '↑' : '↓'}
      </button>

      <div className="toolbar__spacer" />

      <ScanStatus />

      {root && (
        <button
          type="button"
          className="button button--icon"
          title={scanning ? 'タグ付けを一時停止' : 'タグ付けを再開'}
          onClick={() => void window.api.scanControl(scanning ? 'pause' : 'resume')}
        >
          {scanning ? '⏸' : '▶'}
        </button>
      )}
      <button
        type="button"
        className="button button--icon"
        title="設定"
        onClick={() => setSettingsOpen(true)}
      >
        ⚙
      </button>
    </header>
  )
}
