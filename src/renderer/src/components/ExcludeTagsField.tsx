import { useEffect, useMemo, useState } from 'react'
import { compileTagPatterns } from '@shared/tag-filter'
import { useStore } from '../store'

function toText(patterns: string[]): string {
  return patterns.join('\n')
}

/**
 * 「タグをコピー (除外あり)」で取り除くタグの登録欄。1 行に 1 つの正規表現。
 * 入力中は保存せず、フォーカスが外れたときにまとめて保存する
 * (1 文字ごとに保存すると、往復の間にカーソルが飛ぶため)。
 */
export default function ExcludeTagsField(): React.JSX.Element {
  const saved = useStore((state) => state.settings?.copyExcludeTags ?? [])
  const updateSettings = useStore((state) => state.updateSettings)
  const [text, setText] = useState(() => toText(saved))
  const [editing, setEditing] = useState(false)

  // 編集中でなければ保存値に追従する
  const savedText = toText(saved)
  useEffect(() => {
    if (!editing) setText(savedText)
  }, [savedText, editing])

  const errors = useMemo(() => compileTagPatterns(text.split('\n')).errors, [text])

  const save = (): void => {
    setEditing(false)
    const patterns = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
    if (toText(patterns) !== savedText) void updateSettings({ copyExcludeTags: patterns })
  }

  return (
    <section className="field">
      <label htmlFor="exclude-tags">コピーから除外するタグ</label>
      <textarea
        id="exclude-tags"
        className="field__textarea"
        rows={5}
        spellCheck={false}
        placeholder={'1girl\n.*_hair\nrating:.*'}
        value={text}
        onFocus={() => setEditing(true)}
        onChange={(event) => setText(event.target.value)}
        onBlur={save}
      />
      <p className="field__hint">
        右クリックメニューの「タグをコピー (除外あり)」で、ここに書いたタグを除いてコピーします。
        1 行に 1 つ、正規表現で書けます。タグ名全体との一致で、大文字小文字は区別しません
        (例: <code>.*_hair</code> は long_hair や short_hair に一致)。
      </p>
      {errors.length > 0 && (
        <ul className="field__errors" role="alert">
          {errors.map((error) => (
            <li key={error.pattern}>
              <code>{error.pattern}</code> は正規表現として読めないため無視されます
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
