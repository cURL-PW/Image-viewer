import { useEffect } from 'react'
import CloudBanner from './components/CloudBanner'
import FolderTree from './components/FolderTree'
import ImageContextMenu from './components/ImageContextMenu'
import ImageViewer from './components/ImageViewer'
import LibraryList from './components/LibraryList'
import Notice from './components/Notice'
import SettingsDialog from './components/SettingsDialog'
import TagFilter from './components/TagFilter'
import ThumbnailGrid from './components/ThumbnailGrid'
import Toolbar from './components/Toolbar'
import { useStore } from './store'

export default function App(): React.JSX.Element {
  const init = useStore((state) => state.init)
  const root = useStore((state) => state.root)
  const viewerIndex = useStore((state) => state.viewerIndex)
  const settingsOpen = useStore((state) => state.settingsOpen)
  const openFolder = useStore((state) => state.openFolder)

  useEffect(() => {
    void init()
  }, [init])

  // グローバルなキーボード操作。入力欄にフォーカスがあるときは邪魔しない。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return

      const state = useStore.getState()
      if (state.settingsOpen) {
        if (event.key === 'Escape') state.setSettingsOpen(false)
        return
      }
      if (state.viewerIndex === null) return

      switch (event.key) {
        case 'ArrowRight':
        case 'PageDown':
          state.step(1)
          break
        case 'ArrowLeft':
        case 'PageUp':
          state.step(-1)
          break
        case 'Home':
          state.goTo(0)
          break
        case 'End':
          state.goTo(state.ids.length - 1)
          break
        case 'Escape':
          state.closeViewer()
          break
        default:
          return
      }
      event.preventDefault()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div className="app">
      <Toolbar />
      <CloudBanner />
      <div className="app__body">
        <aside className="sidebar">
          <LibraryList />
          {/* ライブラリを切り替えたら開閉状態も初期化する */}
          <FolderTree key={root?.id ?? 'none'} />
          <TagFilter />
        </aside>
        <main className="content">
          {!root ? (
            <div className="empty">
              <p className="empty__title">ライブラリが開かれていません</p>
              <p className="empty__hint">
                画像の入ったフォルダをライブラリに追加すると、配下を再帰的に読み込みます。
                複数のフォルダを登録して、左の一覧から切り替えられます。
              </p>
              <button type="button" className="button button--primary" onClick={() => void openFolder()}>
                ライブラリを追加
              </button>
            </div>
          ) : viewerIndex === null ? (
            <ThumbnailGrid />
          ) : (
            <ImageViewer />
          )}
        </main>
      </div>
      {settingsOpen && <SettingsDialog />}
      <ImageContextMenu />
      <Notice />
    </div>
  )
}
