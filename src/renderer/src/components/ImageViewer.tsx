import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ImageInfo } from '@shared/api'
import { TagCategory, imageUrl } from '@shared/types'
import { useStore } from '../store'

const MIN_SCALE = 0.1
const MAX_SCALE = 8
/** ホイール 1 ノッチあたりの倍率 */
const ZOOM_STEP = 1.15
/** ホイールイベント 1 ノッチ分の deltaY (ピクセルモード時) */
const WHEEL_NOTCH = 120
/** 前後の画像を先読みしておく枚数 */
const PRELOAD_RADIUS = 2

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * ホイールの移動量をノッチ数に正規化する。
 * ブラウザによって行単位・ページ単位で来ることがあるため、ピクセル換算してから割る。
 */
function wheelNotches(event: WheelEvent, viewportHeight: number): number {
  const pixels =
    event.deltaMode === 1
      ? event.deltaY * 16
      : event.deltaMode === 2
        ? event.deltaY * viewportHeight
        : event.deltaY
  return pixels / WHEEL_NOTCH
}

function tagClass(category: number): string {
  if (category === TagCategory.Character) return 'tag--character'
  if (category === TagCategory.Rating) return 'tag--rating'
  return 'tag--general'
}

/**
 * 単画像ビュー。
 * 既定はウィンドウ幅いっぱい (fit-width)、ホイールでカーソル位置を中心に拡大縮小、
 * 等倍表示のときだけ左右端のクリックでページ送りできる。
 */
export default function ImageViewer(): React.JSX.Element | null {
  const ids = useStore((state) => state.ids)
  const images = useStore((state) => state.images)
  const viewerIndex = useStore((state) => state.viewerIndex)
  const ensureImages = useStore((state) => state.ensureImages)
  const closeViewer = useStore((state) => state.closeViewer)
  const step = useStore((state) => state.step)
  const toggleInclude = useStore((state) => state.toggleInclude)
  const includeTags = useStore((state) => state.includeTags)
  const edgeRatio = useStore((state) => state.settings?.edgeClickRatio ?? 0.25)

  const viewerRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [stageWidth, setStageWidth] = useState(0)
  const [scale, setScale] = useState(1)
  const [info, setInfo] = useState<ImageInfo | null>(null)
  const [showTags, setShowTags] = useState(true)

  // ズーム後にスクロール位置を補正するためのアンカー
  const pendingAnchor = useRef<{ x: number; y: number; ratio: number } | null>(null)
  const dragState = useRef<{ x: number; y: number; left: number; top: number } | null>(null)

  const currentId = viewerIndex !== null ? ids[viewerIndex] : undefined
  const image = currentId !== undefined ? images[currentId] : undefined
  const isFitWidth = Math.abs(scale - 1) < 0.001

  // 現在の画像と、その前後をまとめて取得しておく
  const neighborhood = useMemo(() => {
    if (viewerIndex === null) return []
    const from = Math.max(0, viewerIndex - PRELOAD_RADIUS)
    const to = Math.min(ids.length, viewerIndex + PRELOAD_RADIUS + 1)
    return ids.slice(from, to)
  }, [ids, viewerIndex])

  useEffect(() => {
    if (neighborhood.length > 0) void ensureImages(neighborhood)
  }, [neighborhood, ensureImages])

  useLayoutEffect(() => {
    const element = stageRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setStageWidth(entry.contentRect.width))
    observer.observe(element)
    setStageWidth(element.clientWidth)
    return () => observer.disconnect()
  }, [])

  // 画像を切り替えたら fit-width に戻し、スクロールも先頭へ
  useEffect(() => {
    setScale(1)
    const stage = stageRef.current
    if (stage) {
      stage.scrollLeft = 0
      stage.scrollTop = 0
    }
  }, [currentId])

  useEffect(() => {
    if (currentId === undefined) {
      setInfo(null)
      return
    }
    let cancelled = false
    void window.api.getImageInfo(currentId).then((result) => {
      if (!cancelled) setInfo(result)
    })
    return () => {
      cancelled = true
    }
  }, [currentId])

  // ズーム倍率が変わった直後に、カーソル位置が動かないようスクロールを補正する
  useLayoutEffect(() => {
    const anchor = pendingAnchor.current
    const stage = stageRef.current
    if (!anchor || !stage) return
    pendingAnchor.current = null
    stage.scrollLeft = (stage.scrollLeft + anchor.x) * anchor.ratio - anchor.x
    stage.scrollTop = (stage.scrollTop + anchor.y) * anchor.ratio - anchor.y
  }, [scale])

  const zoomAt = useCallback(
    (clientX: number, clientY: number, factor: number) => {
      const stage = stageRef.current
      if (!stage) return
      setScale((previous) => {
        const next = clamp(previous * factor, MIN_SCALE, MAX_SCALE)
        if (next === previous) return previous
        const rect = stage.getBoundingClientRect()
        pendingAnchor.current = {
          x: clientX - rect.left,
          y: clientY - rect.top,
          ratio: next / previous
        }
        return next
      })
    },
    []
  )

  // React の onWheel は passive で登録されるため preventDefault が効かない。
  // ネイティブリスナーを passive: false で張り、既定のスクロールを止めてズームに割り当てる。
  useEffect(() => {
    const element = viewerRef.current
    if (!element) return

    const onWheel = (event: WheelEvent): void => {
      const stage = stageRef.current
      if (!stage) return
      event.preventDefault()
      // Shift + ホイールは縦スクロール
      if (event.shiftKey) {
        stage.scrollTop += event.deltaY
        return
      }
      zoomAt(event.clientX, event.clientY, ZOOM_STEP ** -wheelNotches(event, stage.clientHeight))
    }

    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  const onMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const stage = stageRef.current
    if (!stage || event.button !== 0) return
    dragState.current = {
      x: event.clientX,
      y: event.clientY,
      left: stage.scrollLeft,
      top: stage.scrollTop
    }
  }, [])

  useEffect(() => {
    const onMouseMove = (event: MouseEvent): void => {
      const drag = dragState.current
      const stage = stageRef.current
      if (!drag || !stage) return
      stage.scrollLeft = drag.left - (event.clientX - drag.x)
      stage.scrollTop = drag.top - (event.clientY - drag.y)
    }
    const onMouseUp = (): void => {
      dragState.current = null
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  if (viewerIndex === null || currentId === undefined) return null

  const displayWidth = stageWidth > 0 ? stageWidth * scale : undefined
  const percent = Math.round(scale * 100)

  return (
    <div className="viewer" ref={viewerRef}>
      <div
        ref={stageRef}
        className="viewer__stage"
        onMouseDown={onMouseDown}
        onDoubleClick={() => setScale(1)}
      >
        {image && (
          <img
            className="viewer__image"
            src={imageUrl(image)}
            alt={image.fileName}
            style={displayWidth !== undefined ? { width: `${displayWidth}px` } : undefined}
            draggable={false}
          />
        )}
      </div>

      {/* fit-width のときだけ、左右端のクリックでページ送りできるようにする */}
      {isFitWidth && (
        <>
          <button
            type="button"
            className="viewer__edge viewer__edge--prev"
            style={{ width: `${edgeRatio * 100}%` }}
            onClick={() => step(-1)}
            disabled={viewerIndex === 0}
            aria-label="前の画像"
          >
            <span className="viewer__arrow">‹</span>
          </button>
          <button
            type="button"
            className="viewer__edge viewer__edge--next"
            style={{ width: `${edgeRatio * 100}%` }}
            onClick={() => step(1)}
            disabled={viewerIndex >= ids.length - 1}
            aria-label="次の画像"
          >
            <span className="viewer__arrow">›</span>
          </button>
        </>
      )}

      {/* 先読み用。表示はしないがブラウザキャッシュに載せておく */}
      <div className="viewer__preload" aria-hidden="true">
        {neighborhood
          .filter((id) => id !== currentId && images[id])
          .map((id) => (
            <img key={id} src={imageUrl(images[id])} alt="" />
          ))}
      </div>

      <div className="viewer__bar">
        <button type="button" className="button button--icon" onClick={closeViewer} title="一覧へ戻る (Esc)">
          ✕
        </button>
        <span className="viewer__name" title={image?.relPath}>
          {image?.fileName ?? ''}
        </span>
        <span className="viewer__meta">
          {viewerIndex + 1} / {ids.length}
        </span>
        {info?.image?.width && info?.image?.height && (
          <span className="viewer__meta">
            {info.image.width}×{info.image.height}
          </span>
        )}
        <span className="viewer__meta">{percent}%</span>
        {!isFitWidth && (
          <button type="button" className="button button--subtle" onClick={() => setScale(1)}>
            幅に合わせる
          </button>
        )}
        <div className="toolbar__spacer" />
        <button
          type="button"
          className="button button--subtle"
          onClick={() => void window.api.revealImage(currentId)}
        >
          場所を開く
        </button>
        <button
          type="button"
          className="button button--subtle"
          onClick={() => setShowTags((previous) => !previous)}
        >
          タグ {showTags ? '▾' : '▸'}
        </button>
      </div>

      {showTags && (
        <div className="viewer__tags">
          {info === null ? (
            <span className="viewer__meta">読み込み中…</span>
          ) : info.tags.length === 0 ? (
            <span className="viewer__meta">
              {image?.scanError ? `タグ付け失敗: ${image.scanError}` : 'タグ未付与'}
            </span>
          ) : (
            info.tags.map((tag) => (
              <button
                key={tag.id}
                type="button"
                className={`chip chip--tag ${tagClass(tag.category)}${
                  includeTags.includes(tag.id) ? ' chip--active' : ''
                }`}
                title={`確信度 ${(tag.confidence * 100).toFixed(1)}% — クリックでこのタグに絞り込む`}
                onClick={() => toggleInclude(tag.id)}
              >
                {tag.name}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
