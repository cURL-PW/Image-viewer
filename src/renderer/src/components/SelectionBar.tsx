import { useEffect, useState } from 'react'
import type { TagInfo } from '@shared/types'
import { confirmAndTrash } from '../lib/trash'
import { useStore } from '../store'
import TagInput from './TagInput'

/**
 * 2 枚以上を選んでいるときに一覧の上に出す操作バー。
 * ★・ごみ箱・タグの追加/削除を、選んだ画像すべてにまとめてかける。
 */
export default function SelectionBar(): React.JSX.Element | null {
  const selection = useStore((state) => state.selection)
  const clearSelection = useStore((state) => state.clearSelection)
  const setFavorite = useStore((state) => state.setFavorite)
  const addTag = useStore((state) => state.addTag)
  const removeTag = useStore((state) => state.removeTag)
  const tagsVersion = useStore((state) => state.tagsVersion)
  const [tagsOpen, setTagsOpen] = useState(false)
  const [tags, setTags] = useState<TagInfo[] | null>(null)

  const count = selection.length

  // 選択中の画像に付いているタグ (付いている枚数付き)
  useEffect(() => {
    if (!tagsOpen || count < 2) return
    let cancelled = false
    void window.api.tagsForImages(selection).then((result) => {
      if (!cancelled) setTags(result)
    })
    return () => {
      cancelled = true
    }
  }, [tagsOpen, selection, count, tagsVersion])

  useEffect(() => {
    if (count < 2) setTagsOpen(false)
  }, [count])

  if (count < 2) return null

  return (
    <div className="selection-bar" role="toolbar" aria-label="選択した画像の操作">
      <div className="selection-bar__row">
        <span className="selection-bar__count">{count.toLocaleString()} 枚選択中</span>
        <button
          type="button"
          className="button button--subtle"
          onClick={() => void setFavorite(selection, true)}
        >
          ★ お気に入りに追加
        </button>
        <button
          type="button"
          className="button button--subtle"
          onClick={() => void setFavorite(selection, false)}
        >
          ☆ お気に入りから外す
        </button>
        <button
          type="button"
          className={`button button--subtle${tagsOpen ? ' button--active' : ''}`}
          aria-expanded={tagsOpen}
          onClick={() => setTagsOpen((open) => !open)}
        >
          タグの追加・削除
        </button>
        <button
          type="button"
          className="button button--subtle button--danger"
          onClick={() => confirmAndTrash(selection)}
        >
          ごみ箱へ移動
        </button>
        <div className="toolbar__spacer" />
        <button
          type="button"
          className="button button--subtle"
          title="選択を解除 (Esc)"
          onClick={clearSelection}
        >
          選択解除
        </button>
      </div>

      {tagsOpen && (
        <div className="selection-bar__tags">
          <TagInput
            autoFocus
            placeholder="選んだ画像すべてに足すタグ"
            onSubmit={(name) => void addTag(selection, name)}
          />
          <div className="selection-bar__chips">
            {tags === null ? (
              <span className="viewer__meta">読み込み中…</span>
            ) : tags.length === 0 ? (
              <span className="viewer__meta">タグはありません</span>
            ) : (
              tags.map((tag) => (
                <span key={tag.id} className="chip chip--tag chip--removable">
                  {tag.name}
                  <span className="chip__count">{tag.count}</span>
                  <button
                    type="button"
                    className="chip__remove"
                    title={`選んだ画像すべてから「${tag.name}」を外す`}
                    aria-label={`${tag.name} を外す`}
                    onClick={() => void removeTag(selection, tag.id)}
                  >
                    ×
                  </button>
                </span>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
