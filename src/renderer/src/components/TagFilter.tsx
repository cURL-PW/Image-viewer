import { useMemo } from 'react'
import { TagCategory, type TagInfo } from '@shared/types'
import { useStore } from '../store'

const CATEGORY_LABELS: Record<number, string> = {
  [TagCategory.General]: '一般',
  [TagCategory.Character]: 'キャラクター',
  [TagCategory.Rating]: 'レーティング'
}

const CATEGORY_ORDER = [TagCategory.Character, TagCategory.General, TagCategory.Rating]

function categoryClass(category: number): string {
  if (category === TagCategory.Character) return 'tag--character'
  if (category === TagCategory.Rating) return 'tag--rating'
  return 'tag--general'
}

export default function TagFilter(): React.JSX.Element {
  const tags = useStore((state) => state.tags)
  const includeTags = useStore((state) => state.includeTags)
  const excludeTags = useStore((state) => state.excludeTags)
  const tagMode = useStore((state) => state.tagMode)
  const tagSearch = useStore((state) => state.tagSearch)
  const toggleInclude = useStore((state) => state.toggleInclude)
  const toggleExclude = useStore((state) => state.toggleExclude)
  const clearTags = useStore((state) => state.clearTags)
  const setTagMode = useStore((state) => state.setTagMode)
  const setTagSearch = useStore((state) => state.setTagSearch)

  const byId = useMemo(() => new Map(tags.map((tag) => [tag.id, tag])), [tags])
  const selected = includeTags.length + excludeTags.length

  const grouped = useMemo(() => {
    const groups = new Map<number, TagInfo[]>()
    for (const tag of tags) {
      const key = CATEGORY_ORDER.includes(tag.category as never) ? tag.category : TagCategory.General
      const list = groups.get(key)
      if (list) list.push(tag)
      else groups.set(key, [tag])
    }
    return groups
  }, [tags])

  const renderChip = (id: number, excluded: boolean): React.JSX.Element => {
    const tag = byId.get(id)
    return (
      <button
        key={`${excluded ? 'x' : 'i'}-${id}`}
        type="button"
        className={`chip${excluded ? ' chip--exclude' : ''}`}
        onClick={() => (excluded ? toggleExclude(id) : toggleInclude(id))}
        title="クリックで解除"
      >
        {excluded ? '−' : ''}
        {tag?.name ?? `#${id}`}
        <span className="chip__close">×</span>
      </button>
    )
  }

  return (
    <section className="panel panel--tags">
      <header className="panel__header">
        <h2>タグ絞り込み</h2>
        <div className="segmented" role="group" aria-label="タグの結合モード">
          <button
            type="button"
            className={tagMode === 'and' ? 'segmented__item segmented__item--active' : 'segmented__item'}
            onClick={() => setTagMode('and')}
            title="選択したタグをすべて含む"
          >
            AND
          </button>
          <button
            type="button"
            className={tagMode === 'or' ? 'segmented__item segmented__item--active' : 'segmented__item'}
            onClick={() => setTagMode('or')}
            title="選択したタグのいずれかを含む"
          >
            OR
          </button>
        </div>
      </header>

      <div className="panel__controls">
        <input
          type="search"
          className="input"
          placeholder="タグを検索"
          value={tagSearch}
          onChange={(event) => setTagSearch(event.target.value)}
        />
        {selected > 0 && (
          <button type="button" className="button button--subtle" onClick={clearTags}>
            クリア
          </button>
        )}
      </div>

      {selected > 0 && (
        <div className="chips">
          {includeTags.map((id) => renderChip(id, false))}
          {excludeTags.map((id) => renderChip(id, true))}
        </div>
      )}

      <div className="panel__body">
        {tags.length === 0 ? (
          <p className="panel__placeholder">
            タグはまだありません。スキャンが進むと表示されます。
          </p>
        ) : (
          CATEGORY_ORDER.filter((category) => grouped.has(category)).map((category) => (
            <div key={category} className="taglist">
              <h3 className="taglist__title">{CATEGORY_LABELS[category]}</h3>
              <ul>
                {(grouped.get(category) ?? []).map((tag) => {
                  const included = includeTags.includes(tag.id)
                  const excluded = excludeTags.includes(tag.id)
                  return (
                    <li key={tag.id}>
                      <div
                        className={`tag ${categoryClass(tag.category)}${
                          included ? ' tag--included' : ''
                        }${excluded ? ' tag--excluded' : ''}`}
                      >
                        <button
                          type="button"
                          className="tag__main"
                          onClick={() => toggleInclude(tag.id)}
                          title={included ? 'この条件を外す' : 'このタグを含む画像に絞り込む'}
                        >
                          <span className="tag__name">{tag.name}</span>
                          <span className="tag__count">{tag.count.toLocaleString()}</span>
                        </button>
                        <button
                          type="button"
                          className="tag__exclude"
                          onClick={() => toggleExclude(tag.id)}
                          title={excluded ? '除外を解除' : 'このタグを除外する'}
                        >
                          −
                        </button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))
        )}
      </div>
    </section>
  )
}
