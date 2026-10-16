import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { thumbUrl } from '@shared/types'
import { useStore } from '../store'

const GAP = 10
const PADDING = 14
const CAPTION_HEIGHT = 24
/** 画面外にも先読みしておく行数 */
const OVERSCAN_ROWS = 2

/**
 * 単画像ビューを開くとグリッドは外される (App が出し分けている) ので、
 * スクロール位置はコンポーネントの外に残しておき、戻ったときに復元する。
 */
let savedScroll: { dir: string; top: number } | null = null

/**
 * 仮想スクロールのサムネイルグリッド。
 * 表示範囲の行だけを描画するので、数万枚でも DOM 数が一定に保たれる。
 */
export default function ThumbnailGrid(): React.JSX.Element {
  const ids = useStore((state) => state.ids)
  const images = useStore((state) => state.images)
  const ensureImages = useStore((state) => state.ensureImages)
  const openViewer = useStore((state) => state.openViewer)
  const openContextMenu = useStore((state) => state.openContextMenu)
  const loading = useStore((state) => state.loading)
  const dir = useStore((state) => state.dir)
  const thumbnailSize = useStore((state) => state.settings?.thumbnailSize ?? 256)
  const thumbEpoch = useStore((state) => state.thumbEpoch)
  const setFavorite = useStore((state) => state.setFavorite)
  const selection = useStore((state) => state.selection)
  const select = useStore((state) => state.select)

  const containerRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  const [scrollTop, setScrollTop] = useState(0)
  /** 前回のスクロール位置の復元が済んだか (マウント直後に一度だけ行う) */
  const restoredRef = useRef(false)

  const cellHeight = thumbnailSize + CAPTION_HEIGHT
  const rowHeight = cellHeight + GAP

  useLayoutEffect(() => {
    const element = containerRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      setViewport({
        width: entry.contentRect.width,
        height: entry.contentRect.height
      })
    })
    observer.observe(element)
    setViewport({ width: element.clientWidth, height: element.clientHeight })
    return () => observer.disconnect()
  }, [])

  // フォルダを切り替えたら先頭に戻す。
  // 単画像ビューから戻ってきただけ (同じフォルダ) のときは下の復元に任せる。
  useEffect(() => {
    if (savedScroll?.dir === dir) return
    savedScroll = null
    containerRef.current?.scrollTo({ top: 0 })
    setScrollTop(0)
  }, [dir])

  const columns = Math.max(
    1,
    Math.floor((viewport.width - PADDING * 2 + GAP) / (thumbnailSize + GAP))
  )
  const rowCount = Math.ceil(ids.length / columns)

  const { startRow, endRow } = useMemo(() => {
    if (viewport.height === 0) return { startRow: 0, endRow: Math.min(rowCount, 4) }
    const first = Math.max(0, Math.floor((scrollTop - PADDING) / rowHeight) - OVERSCAN_ROWS)
    const last = Math.min(
      rowCount,
      Math.ceil((scrollTop + viewport.height - PADDING) / rowHeight) + OVERSCAN_ROWS
    )
    return { startRow: first, endRow: last }
  }, [scrollTop, viewport.height, rowHeight, rowCount])

  // 単画像ビューから戻ったら元のスクロール位置に戻す。
  // 列数は幅が分かるまで決まらないので、幅を測り終えてから一度だけ行う。
  useLayoutEffect(() => {
    const element = containerRef.current
    if (!element || restoredRef.current || viewport.width === 0) return
    restoredRef.current = true
    if (savedScroll?.dir !== dir) return

    let top = savedScroll.top
    // ページ送りで別の画像まで進んでいたら、その画像が見える位置までずらす
    const { lastViewedIndex } = useStore.getState()
    if (lastViewedIndex !== null && lastViewedIndex < ids.length) {
      const cellTop = PADDING + Math.floor(lastViewedIndex / columns) * rowHeight
      if (cellTop < top) top = cellTop - PADDING
      else if (cellTop + cellHeight > top + viewport.height)
        top = cellTop + cellHeight + PADDING - viewport.height
    }
    element.scrollTop = top
    setScrollTop(element.scrollTop)
  }, [viewport, dir, ids.length, columns, rowHeight, cellHeight])

  const visibleIds = useMemo(
    () => ids.slice(startRow * columns, endRow * columns),
    [ids, startRow, endRow, columns]
  )

  // 表示範囲のメタデータだけを取りに行く
  useEffect(() => {
    if (visibleIds.length > 0) void ensureImages(visibleIds)
  }, [visibleIds, ensureImages])

  const cellWidth = thumbnailSize
  const selected = useMemo(() => new Set(selection), [selection])

  // 空のときもコンテナ自体は描画する。要素が消えると ResizeObserver が外れ、
  // 再表示時に幅が 0 のまま (= 1 列) になってしまうため。
  return (
    <div
      ref={containerRef}
      className="grid"
      onScroll={(event) => {
        const top = event.currentTarget.scrollTop
        setScrollTop(top)
        savedScroll = { dir, top }
      }}
    >
      {ids.length === 0 ? (
        <div className="empty">
          <p className="empty__title">{loading ? '読み込み中…' : '該当する画像がありません'}</p>
          {!loading && (
            <p className="empty__hint">フォルダの選択やタグの絞り込みを見直してください。</p>
          )}
        </div>
      ) : (
        <div
          className="grid__canvas"
          style={{ height: `${rowCount * rowHeight + PADDING * 2}px` }}
        >
          {visibleIds.map((id, offset) => {
            const index = startRow * columns + offset
            const row = Math.floor(index / columns)
            const column = index % columns
            const image = images[id]
            return (
              <div
                key={id}
                className={`cell${selected.has(id) ? ' cell--selected' : ''}`}
                aria-selected={selected.has(id)}
                style={{
                  width: `${cellWidth}px`,
                  height: `${cellHeight}px`,
                  transform: `translate(${PADDING + column * (cellWidth + GAP)}px, ${
                    PADDING + row * rowHeight
                  }px)`
                }}
                onDoubleClick={(event) => {
                  if (!event.ctrlKey && !event.metaKey && !event.shiftKey) openViewer(index)
                }}
                onClick={(event) => {
                  // Ctrl (mac は Cmd) で 1 枚ずつ、Shift で範囲を選ぶ。開きはしない
                  const additive = event.ctrlKey || event.metaKey
                  if (event.shiftKey) {
                    select(id, additive ? 'rangeAdd' : 'range')
                    return
                  }
                  if (additive) {
                    select(id, 'toggle')
                    return
                  }
                  // 修飾キー無しは従来どおり開く。範囲選択の起点だけ覚えておく
                  select(id, 'anchor')
                  if (event.detail === 1) openViewer(index)
                }}
                onContextMenu={(event) => {
                  event.preventDefault()
                  // 選んでいない画像を右クリックしたら、その 1 枚だけを選び直す
                  if (!selected.has(id)) select(id, 'replace')
                  openContextMenu({ x: event.clientX, y: event.clientY, id })
                }}
                title={image?.relPath ?? ''}
              >
                <div className="cell__frame" style={{ height: `${thumbnailSize}px` }}>
                  {image && (
                    <img
                      className="cell__image"
                      src={thumbUrl(image, thumbEpoch)}
                      alt={image.fileName}
                      // 枠が正方形なので、収めた後に回してもはみ出さない
                      style={
                        image.rotation ? { transform: `rotate(${image.rotation}deg)` } : undefined
                      }
                      loading="lazy"
                      draggable={false}
                    />
                  )}
                  {image && (
                    <button
                      type="button"
                      className={`cell__star${image.favorite ? ' cell__star--on' : ''}`}
                      title={image.favorite ? 'お気に入りから外す' : 'お気に入りに追加'}
                      aria-label={image.favorite ? 'お気に入りから外す' : 'お気に入りに追加'}
                      aria-pressed={image.favorite}
                      // セルのクリックは単画像ビューを開くので、ここで止める
                      onClick={(event) => {
                        event.stopPropagation()
                        void setFavorite([id], !image.favorite)
                      }}
                      onDoubleClick={(event) => event.stopPropagation()}
                    >
                      {image.favorite ? '★' : '☆'}
                    </button>
                  )}
                </div>
                <div className="cell__caption">{image?.fileName ?? ''}</div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
