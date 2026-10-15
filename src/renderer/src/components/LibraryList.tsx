import type { LibraryInfo } from '@shared/types'
import { useStore } from '../store'

function LibraryRow({ library }: { library: LibraryInfo }): React.JSX.Element {
  const switchLibrary = useStore((state) => state.switchLibrary)
  const removeLibrary = useStore((state) => state.removeLibrary)

  const open = (): void => {
    if (library.available) void switchLibrary(library.id)
  }

  const remove = (): void => {
    // フォルダの中身は消さないが、タグ付けの結果は捨てるので確認する
    const ok = window.confirm(
      `「${library.name}」をライブラリから外しますか？\n` +
        'フォルダ内の画像は削除されません。タグ付けの結果は破棄されます。'
    )
    if (ok) void removeLibrary(library.id)
  }

  const classes = ['libraries__row']
  if (library.active) classes.push('libraries__row--active')
  if (!library.available) classes.push('libraries__row--missing')

  return (
    <li
      className={classes.join(' ')}
      role="option"
      aria-selected={library.active}
      aria-disabled={!library.available}
      tabIndex={library.available ? 0 : -1}
      title={library.available ? library.path : `${library.path} (見つかりません)`}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          open()
        }
      }}
    >
      <span className="libraries__name">{library.name}</span>
      {library.available ? (
        <span className="libraries__count">{library.count.toLocaleString()}</span>
      ) : (
        <span className="libraries__missing">見つかりません</span>
      )}
      <button
        type="button"
        className="libraries__remove"
        title="ライブラリから外す"
        aria-label={`${library.name} をライブラリから外す`}
        onClick={(event) => {
          event.stopPropagation()
          remove()
        }}
      >
        ×
      </button>
    </li>
  )
}

/** 登録済みライブラリの一覧。クリックで切り替え、＋で追加、×で登録解除。 */
export default function LibraryList(): React.JSX.Element {
  const libraries = useStore((state) => state.libraries)
  const openFolder = useStore((state) => state.openFolder)

  return (
    <section className="panel panel--libraries">
      <header className="panel__header">
        <h2>ライブラリ</h2>
        <button
          type="button"
          className="button button--small"
          title="フォルダをライブラリに追加"
          onClick={() => void openFolder()}
        >
          ＋ 追加
        </button>
      </header>
      <div className="panel__body">
        {libraries.length > 0 ? (
          <ul className="libraries" role="listbox" aria-label="ライブラリ">
            {libraries.map((library) => (
              <LibraryRow key={library.id} library={library} />
            ))}
          </ul>
        ) : (
          <p className="panel__placeholder">登録されたライブラリはありません</p>
        )}
      </div>
    </section>
  )
}
