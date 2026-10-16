import { useStore } from '../store'

/**
 * 似た画像を表示しているときに一覧の上に出す帯。
 * 元の画像の名前と枚数を示し、× で元の絞り込みに戻る。
 */
export default function SimilarBanner(): React.JSX.Element | null {
  const similarTo = useStore((state) => state.similarTo)
  const source = useStore((state) => (state.similarTo === null ? undefined : state.images[state.similarTo]))
  const ids = useStore((state) => state.ids)
  const loading = useStore((state) => state.loading)
  const exitSimilar = useStore((state) => state.exitSimilar)

  if (similarTo === null) return null
  // 先頭は元の画像なので数えない
  const count = Math.max(0, ids.length - 1)

  return (
    <div className="similar-banner" role="status">
      <span className="similar-banner__text">
        「<span className="similar-banner__name">{source?.fileName ?? '…'}</span>」に似た画像
        {!loading && <span className="similar-banner__count">{count.toLocaleString()} 枚</span>}
      </span>
      <span className="similar-banner__hint">タグの似ている順 (先頭は元の画像)</span>
      <div className="toolbar__spacer" />
      <button
        type="button"
        className="button button--subtle"
        title="似た画像の表示をやめる (Esc)"
        onClick={exitSimilar}
      >
        × 元の一覧に戻る
      </button>
    </div>
  )
}
