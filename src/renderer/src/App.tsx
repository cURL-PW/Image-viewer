import { useEffect } from 'react'
import FolderTree from './components/FolderTree'
import ImageViewer from './components/ImageViewer'
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
      <div className="app__body">
        <aside className="sidebar">
          <FolderTree />
          <TagFilter />
        </aside>
        <main className="content">
          {!root ? (
            <div className="empty">
              <p className="empty__title">フォルダが選択されていません</p>
              <p className="empty__hint">
                画像の入ったフォルダを開くと、配下を再帰的に読み込みます。
              </p>
              <button type="button" className="button button--primary" onClick={() => void openFolder()}>
                フォルダを開く
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
    </div>
  )
}
