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
  const fullScreen = useStore((state) => state.fullScreen)
  /** 全画面の単画像ビューでは、ツールバーやサイドバーも隠して画像だけにする */
  const immersive = fullScreen && viewerIndex !== null

  useEffect(() => {
    void init()
  }, [init])

  // グローバルなキーボード操作。入力欄にフォーカスがあるときは邪魔しない。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const state = useStore.getState()
      // 全画面はどの画面でも (入力欄にいても) 切り替えられる
      if (event.key === 'F11') {
        event.preventDefault()
        void state.setFullScreen(!state.fullScreen)
        return
      }

      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      if (state.settingsOpen) {
        if (event.key === 'Escape') state.setSettingsOpen(false)
        return
      }
      // Esc は「全画面を抜ける」を優先する。もう一度押すと一覧へ戻る
      if (event.key === 'Escape' && state.fullScreen) {
        event.preventDefault()
        void state.setFullScreen(false)
        return
      }
      if (state.viewerIndex === null) return

      const currentId = state.ids[state.viewerIndex]
      switch (event.key) {
        case 'r':
        case 'R':
          if (event.ctrlKey || event.metaKey || event.altKey) return
          void state.rotate(currentId, event.shiftKey ? -1 : 1)
          break
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
    <div className={`app${immersive ? ' app--immersive' : ''}`}>
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
