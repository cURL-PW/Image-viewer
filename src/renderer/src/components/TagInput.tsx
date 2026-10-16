import { useEffect, useId, useState } from 'react'

/** 補完候補を取りに行くまでの待ち時間 (ms) */
const SUGGEST_DEBOUNCE = 150

/**
 * タグを足す入力欄。既存のタグ名を補完候補に出し、無い名前もそのまま足せる。
 * Enter で確定し、欄を空に戻す。
 */
export default function TagInput({
  onSubmit,
  placeholder = '＋タグ',
  autoFocus = false
}: {
  onSubmit: (name: string) => void
  placeholder?: string
  autoFocus?: boolean
}): React.JSX.Element {
  const listId = useId()
  const [value, setValue] = useState('')
  const [suggestions, setSuggestions] = useState<string[]>([])

  useEffect(() => {
    const text = value.trim()
    if (text === '') {
      setSuggestions([])
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      void window.api.suggestTags(text).then((names) => {
        if (!cancelled) setSuggestions(names)
      })
    }, SUGGEST_DEBOUNCE)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [value])

  return (
    <>
      <input
        className="input tag-input"
        value={value}
        placeholder={placeholder}
        aria-label="追加するタグ"
        list={listId}
        autoFocus={autoFocus}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            const name = value.trim()
            if (name !== '') onSubmit(name)
            setValue('')
          } else if (event.key === 'Escape') {
            // 単画像ビューを閉じずに、入力だけをやめる
            event.stopPropagation()
            setValue('')
            event.currentTarget.blur()
          }
        }}
      />
      <datalist id={listId}>
        {suggestions.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
    </>
  )
}
