import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { thumbUrl, thumbnailGenerationSize } from '@shared/types'
import { useStore } from '../store'

const GAP = 10
const PADDING = 14
const CAPTION_HEIGHT = 24
/** Ctrl + ホイールの 1 段分の移動量 (px)。トラックパッドの細かい移動は溜めてから 1 段にする */
const WHEEL_STEP = 100
/** 画面外にも先読みしておく行数 */
const OVERSCAN_ROWS = 2

/**
 * 単画像ビューを開くとグリッドは外される (App が出し分けている) ので、
 * スクロール位置はコンポーネントの外に残しておき、戻ったときに復元する。
 */
let savedScroll: { key: string; top: number } | null = null

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
  const similarTo = useStore((state) => state.similarTo)
  // スクロール位置を覚えておく単位。似た画像の一覧はフォルダとは別に扱う
  const viewKey = similarTo !== null ? `similar:${similarTo}` : `dir:${dir}`
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
  /** 大きさを変える前の並び。真ん中の画像を見失わないよう、変えた後のスクロール位置を決めるのに使う */
  const layoutRef = useRef<{ size: number; columns: number; rowHeight: number } | null>(null)
  const wheelRef = useRef(0)
  const zoomThumbnails = useStore((state) => state.zoomThumbnails)

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

  // フォルダを切り替えたり似た画像を開いたりしたら先頭に戻す。
  // 単画像ビューから戻ってきただけ (同じ一覧) のときは下の復元に任せる。
  useEffect(() => {
    if (savedScroll?.key === viewKey) return
    savedScroll = null
    containerRef.current?.scrollTo({ top: 0 })
    setScrollTop(0)
  }, [viewKey])

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
    if (savedScroll?.key !== viewKey) return

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
  }, [viewport, viewKey, ids.length, columns, rowHeight, cellHeight])

  // サムネイルの大きさを変えたら、画面の真ん中にあった画像が真ん中に来るようにずらす
  useLayoutEffect(() => {
    const element = containerRef.current
    const previous = layoutRef.current
    layoutRef.current = { size: thumbnailSize, columns, rowHeight }
    if (!element || !previous || previous.size === thumbnailSize || viewport.height === 0) return
    if (ids.length === 0) return
    const centerY = element.scrollTop + viewport.height / 2 - PADDING
    const row = Math.max(0, Math.floor(centerY / previous.rowHeight))
    const centerIndex = Math.min(
      ids.length - 1,
      row * previous.columns + Math.floor(previous.columns / 2)
    )
    const top =
      PADDING + Math.floor(centerIndex / columns) * rowHeight + cellHeight / 2 - viewport.height / 2
    element.scrollTop = Math.max(0, top)
    setScrollTop(element.scrollTop)
    // 大きさを変えたときだけ動かす (ids や画面の大きさが変わっただけでは動かさない)
  }, [thumbnailSize, columns, rowHeight])

  // Ctrl + ホイール (mac は Cmd も) でサムネイルの大きさを変える。
  // React の onWheel は passive なので、既定の動き (スクロール・画面ズーム) を止めるためにネイティブで張る
  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const pixels = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY
      wheelRef.current += pixels
      while (Math.abs(wheelRef.current) >= WHEEL_STEP) {
        const direction = wheelRef.current < 0 ? 1 : -1
        wheelRef.current += direction * WHEEL_STEP
        zoomThumbnails(direction)
      }
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [zoomThumbnails])

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
        savedScroll = { key: viewKey, top }
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
                      src={thumbUrl(image, thumbEpoch, thumbnailGenerationSize(thumbnailSize))}
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
