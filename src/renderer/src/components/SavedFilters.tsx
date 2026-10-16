import { useEffect, useRef, useState } from 'react'
import type { SavedFilter } from '@shared/types'
import { useStore } from '../store'

/** 条件の中身を 1 行で説明する (ツールチップ用) */
function describe(filter: SavedFilter, tagName: (id: number) => string): string {
  const { data } = filter
  const parts: string[] = []
  if (data.includeTags.length > 0) {
    parts.push(
      `タグ (${data.tagMode.toUpperCase()}): ${data.includeTags.map(tagName).join(', ')}`
    )
  }
  if (data.excludeTags.length > 0) parts.push(`除外: ${data.excludeTags.map(tagName).join(', ')}`)
  if (data.search !== '') parts.push(`検索: ${data.search}`)
  if (data.favoritesOnly) parts.push('お気に入りのみ')
  return parts.length > 0 ? parts.join(' / ') : '条件なし'
}

/** 入力欄。Enter で確定、Esc で取り消す */
function NameInput({
  initial,
  placeholder,
  onSubmit,
  onCancel
}: {
  initial: string
  placeholder: string
  onSubmit: (name: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [value, setValue] = useState(initial)
  return (
    <input
      className="input"
      autoFocus
      value={value}
      placeholder={placeholder}
      aria-label={placeholder}
      onChange={(event) => setValue(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          if (value.trim() !== '') onSubmit(value.trim())
          else onCancel()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onCancel()
        }
      }}
      onBlur={onCancel}
    />
  )
}

/**
 * サイドバーの「保存した条件」。お気に入りのみの切り替えもここに置く。
 *
 * 条件はライブラリごとに保存し、呼び出してもフォルダは今のまま (条件だけを当てる)。
 */
export default function SavedFilters(): React.JSX.Element | null {
  const root = useStore((state) => state.root)
  const savedFilters = useStore((state) => state.savedFilters)
  const favoritesOnly = useStore((state) => state.favoritesOnly)
  const setFavoritesOnly = useStore((state) => state.setFavoritesOnly)
  const saveFilter = useStore((state) => state.saveFilter)
  const applySavedFilter = useStore((state) => state.applySavedFilter)
  const renameSavedFilter = useStore((state) => state.renameSavedFilter)
  const deleteSavedFilter = useStore((state) => state.deleteSavedFilter)
  const tags = useStore((state) => state.tags)

  const [adding, setAdding] = useState(false)
  const [renaming, setRenaming] = useState<number | null>(null)
  const [menu, setMenu] = useState<{ id: number; x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // 名前の変更・削除のメニューは、外側のクリックや Esc で閉じる
  useEffect(() => {
    if (!menu) return
    const onDown = (event: MouseEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setMenu(null)
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [menu])

  if (!root) return null

  const tagName = (id: number): string => tags.find((tag) => tag.id === id)?.name ?? `#${id}`
  const menuTarget = menu ? savedFilters.find((filter) => filter.id === menu.id) : undefined

  return (
    <section className="panel panel--presets">
      <header className="panel__header">
        <h2>保存した条件</h2>
        <label className="panel__toggle" title="★ を付けた画像だけを表示する">
          <input
            type="checkbox"
            checked={favoritesOnly}
            onChange={(event) => setFavoritesOnly(event.target.checked)}
          />
          ★ お気に入りのみ
        </label>
      </header>
      <div className="panel__body">
        {savedFilters.length > 0 && (
          <ul className="presets" aria-label="保存した条件">
            {savedFilters.map((filter) =>
              renaming === filter.id ? (
                <li key={filter.id} className="presets__row presets__row--editing">
                  <NameInput
                    initial={filter.name}
                    placeholder="条件の名前"
                    onSubmit={(name) => {
                      setRenaming(null)
                      void renameSavedFilter(filter.id, name)
                    }}
                    onCancel={() => setRenaming(null)}
                  />
                </li>
              ) : (
                <li key={filter.id}>
                  <button
                    type="button"
                    className="presets__row"
                    title={`${describe(filter, tagName)}\n右クリックで名前の変更・削除`}
                    onClick={() => applySavedFilter(filter)}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      setMenu({ id: filter.id, x: event.clientX, y: event.clientY })
                    }}
                  >
                    {filter.name}
                  </button>
                </li>
              )
            )}
          </ul>
        )}
        {adding ? (
          <div className="presets__add">
            <NameInput
              initial=""
              placeholder="条件の名前"
              onSubmit={(name) => {
                setAdding(false)
                void saveFilter(name)
              }}
              onCancel={() => setAdding(false)}
            />
          </div>
        ) : (
          <button
            type="button"
            className="button button--subtle presets__save"
            title="今のタグ・検索・お気に入り・並び順を保存する (フォルダは含めない)"
            onClick={() => setAdding(true)}
          >
            ＋ 今の条件を保存
          </button>
        )}
      </div>

      {menu && menuTarget && (
        <div
          ref={menuRef}
          className="context-menu"
          role="menu"
          style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
        >
          <button
            type="button"
            role="menuitem"
            className="context-menu__item"
            onClick={() => {
              setMenu(null)
              setRenaming(menuTarget.id)
            }}
          >
            名前を変更
          </button>
          <button
            type="button"
            role="menuitem"
            className="context-menu__item"
            onClick={() => {
              setMenu(null)
              if (window.confirm(`「${menuTarget.name}」を削除しますか？`)) {
                void deleteSavedFilter(menuTarget.id)
              }
            }}
          >
            削除
          </button>
        </div>
      )}
    </section>
  )
}
