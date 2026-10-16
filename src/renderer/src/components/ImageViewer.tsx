import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ImageInfo } from '@shared/api'
import { TagCategory, imageUrl } from '@shared/types'
import { confirmAndTrash } from '../lib/trash'
import { useStore } from '../store'
import TagInput from './TagInput'

const MIN_SCALE = 0.1
const MAX_SCALE = 8
/** ホイール 1 ノッチあたりの倍率 */
const ZOOM_STEP = 1.15
/** ホイールイベント 1 ノッチ分の deltaY (ピクセルモード時) */
const WHEEL_NOTCH = 120
/** 前後の画像を先読みしておく枚数 */
const PRELOAD_RADIUS = 2
/** 全画面中、画面下端からこの距離にマウスが来たらバーを出す (px) */
const DOCK_REVEAL_ZONE = 80

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
 *
 * 既定は「画像全体が収まる大きさ」。はみ出さない範囲で最大にし、画面より小さい画像は
 * 引き伸ばさず等倍のまま中央に置く。ホイールでカーソル位置を中心に拡大縮小でき、
 * 全体表示のときだけ左右端のクリックでページ送りできる。
 */
export default function ImageViewer(): React.JSX.Element | null {
  const ids = useStore((state) => state.ids)
  const images = useStore((state) => state.images)
  const viewerIndex = useStore((state) => state.viewerIndex)
  const ensureImages = useStore((state) => state.ensureImages)
  const closeViewer = useStore((state) => state.closeViewer)
  const openContextMenu = useStore((state) => state.openContextMenu)
  const step = useStore((state) => state.step)
  const toggleInclude = useStore((state) => state.toggleInclude)
  const includeTags = useStore((state) => state.includeTags)
  const edgeRatio = useStore((state) => state.settings?.edgeClickRatio ?? 0.25)
  const fullScreen = useStore((state) => state.fullScreen)
  const setFullScreen = useStore((state) => state.setFullScreen)
  const rotate = useStore((state) => state.rotate)
  const setFavorite = useStore((state) => state.setFavorite)
  const addTag = useStore((state) => state.addTag)
  const removeTag = useStore((state) => state.removeTag)
  const tagsVersion = useStore((state) => state.tagsVersion)

  const viewerRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 })
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  const [scale, setScale] = useState(1)
  const [info, setInfo] = useState<ImageInfo | null>(null)
  const [showTags, setShowTags] = useState(true)
  /** 全画面中、画面下端にマウスを寄せてバーを出しているか */
  const [dockRevealed, setDockRevealed] = useState(false)

  // ズーム後にスクロール位置を補正するためのアンカー
  const pendingAnchor = useRef<{ x: number; y: number; ratio: number } | null>(null)
  const dragState = useRef<{ x: number; y: number; left: number; top: number } | null>(null)

  const currentId = viewerIndex !== null ? ids[viewerIndex] : undefined
  const image = currentId !== undefined ? images[currentId] : undefined
  /** 等倍 (scale = 1) は「全体が収まる大きさ」。このときだけページ送りを出す */
  const isFitAll = Math.abs(scale - 1) < 0.001
  const rotation = image?.rotation ?? 0
  /** 90° / 270° 回転では縦横が入れ替わる */
  const quarterTurn = rotation % 180 === 90
  /** 回転後の見た目の大きさ。全体表示や「幅に合わせる」はこれを基準にする */
  const shown = useMemo(
    () => (natural && quarterTurn ? { width: natural.height, height: natural.width } : natural),
    [natural, quarterTurn]
  )

  /**
   * 全体表示のときの表示幅。拡大縮小の基準になる。
   *
   * ステージに収まる範囲で最大、ただし元の大きさは超えない
   * (小さい画像を引き伸ばさないため)。scale = 1 の見え方は CSS の
   * max-width / max-height に任せていて、ここはその結果と一致する。
   */
  const baseWidth = useMemo(() => {
    if (!shown || shown.height === 0) return stageSize.width
    const aspect = shown.width / shown.height
    return Math.min(shown.width, stageSize.width, stageSize.height * aspect)
  }, [shown, stageSize])

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
    const observer = new ResizeObserver(([entry]) =>
      setStageSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    )
    observer.observe(element)
    setStageSize({ width: element.clientWidth, height: element.clientHeight })
    return () => observer.disconnect()
  }, [])

  // 回したら全体表示に戻す (拡大したままだと見ていた場所が飛ぶため)
  useEffect(() => {
    setScale(1)
  }, [rotation])

  // 全画面を抜けたらバーの表示状態も戻す
  useEffect(() => {
    if (!fullScreen) setDockRevealed(false)
  }, [fullScreen])

  // 画像を切り替えたら全体表示に戻し、スクロールも先頭へ
  useEffect(() => {
    setScale(1)
    setNatural(null)
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
    // tagsVersion: 手でタグを足したり外したりしたら読み直す
  }, [currentId, tagsVersion])

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

  // マウスの「戻る」ボタンで一覧へ帰る。左下の ✕ と同じ動作
  useEffect(() => {
    const onBackButton = (event: MouseEvent): void => {
      if (event.button !== 3) return
      // 押しっぱなしで履歴を戻ろうとするのを止める
      event.preventDefault()
      closeViewer()
    }
    window.addEventListener('mousedown', onBackButton)
    return () => window.removeEventListener('mousedown', onBackButton)
  }, [closeViewer])

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

  const onImageLoad = (event: React.SyntheticEvent<HTMLImageElement>): void =>
    setNatural({
      width: event.currentTarget.naturalWidth,
      height: event.currentTarget.naturalHeight
    })

  if (viewerIndex === null || currentId === undefined) return null

  // 全体表示は CSS (max-width / max-height) に任せる。
  // 幅を指定しないので、読み込み直後に大きさが跳ねることもない。
  const displayWidth = isFitAll || baseWidth === 0 ? undefined : baseWidth * scale
  const percent = Math.round(scale * 100)
  /** 回転時の外枠 (回した後の見た目の大きさ)。画像の大きさが分かるまでは null */
  const rotorBox =
    shown && shown.width > 0 && baseWidth > 0
      ? { width: baseWidth * scale, height: (baseWidth * scale * shown.height) / shown.width }
      : null
  /** 「幅に合わせる」でどれだけ拡大すればよいか */
  const widthScale = baseWidth > 0 ? stageSize.width / baseWidth : 1

  return (
    <div
      className={`viewer${fullScreen ? ' viewer--immersive' : ''}`}
      ref={viewerRef}
      onMouseMove={
        fullScreen
          ? (event) => {
              // 全画面ではバーを隠し、画面下端に寄せたときだけ出す。
              // 出ている間はバーやタグ欄の上にいる限り出したままにする
              const rect = event.currentTarget.getBoundingClientRect()
              const nearBottom = event.clientY >= rect.bottom - DOCK_REVEAL_ZONE
              const overDock = dockRef.current?.contains(event.target as Node) ?? false
              setDockRevealed(nearBottom || overDock)
            }
          : undefined
      }
      onMouseLeave={fullScreen ? () => setDockRevealed(false) : undefined}
    >
      {/*
        ページ送りの領域はこの入れ物の中だけに収める。
        .viewer 直下に置くと、絶対配置なので下のバー (✕ など) まで覆ってしまう。
      */}
      <div
        className="viewer__canvas"
        onContextMenu={(event) => {
          event.preventDefault()
          openContextMenu({ x: event.clientX, y: event.clientY, id: currentId })
        }}
      >
        <div
          ref={stageRef}
          className="viewer__stage"
          onMouseDown={onMouseDown}
          onDoubleClick={() => setScale(1)}
        >
          {image && rotation === 0 && (
            <img
              className={`viewer__image${isFitAll ? ' viewer__image--fit' : ''}`}
              src={imageUrl(image)}
              alt={image.fileName}
              style={displayWidth !== undefined ? { width: `${displayWidth}px` } : undefined}
              onLoad={onImageLoad}
              draggable={false}
            />
          )}
          {/*
            回転しているときは CSS の max-width / max-height で収められない
            (回す前の大きさで判定される) ので、回した後の外枠を JS で決めて、
            その中央に元の向きの画像を置いて回す。
          */}
          {image && rotation !== 0 && (
            <div
              className="viewer__rotor"
              style={
                rotorBox
                  ? { width: `${rotorBox.width}px`, height: `${rotorBox.height}px` }
                  : undefined
              }
            >
              <img
                className="viewer__image viewer__image--rotated"
                src={imageUrl(image)}
                alt={image.fileName}
                data-rotation={rotation}
                style={
                  rotorBox
                    ? {
                        width: `${quarterTurn ? rotorBox.height : rotorBox.width}px`,
                        height: `${quarterTurn ? rotorBox.width : rotorBox.height}px`,
                        transform: `translate(-50%, -50%) rotate(${rotation}deg)`
                      }
                    : { visibility: 'hidden' }
                }
                onLoad={onImageLoad}
                draggable={false}
              />
            </div>
          )}
        </div>

        {/* 全体表示のときだけ、左右端のクリックでページ送りできるようにする */}
        {isFitAll && (
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
      </div>

      {/* 先読み用。表示はしないがブラウザキャッシュに載せておく */}
      <div className="viewer__preload" aria-hidden="true">
        {neighborhood
          .filter((id) => id !== currentId && images[id])
          .map((id) => (
            <img key={id} src={imageUrl(images[id])} alt="" />
          ))}
      </div>

      <div
        ref={dockRef}
        className={`viewer__dock${dockRevealed ? ' viewer__dock--revealed' : ''}`}
      >
        <div className="viewer__bar">
          <button
            type="button"
            className="button button--icon"
            onClick={closeViewer}
            title="一覧へ戻る (Esc / マウスの戻るボタン)"
            aria-label="一覧へ戻る"
          >
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
          {!isFitAll && (
            <button type="button" className="button button--subtle" onClick={() => setScale(1)}>
              全体を表示
            </button>
          )}
          {Math.abs(widthScale - scale) > 0.001 && (
            <button
              type="button"
              className="button button--subtle"
              onClick={() => setScale(widthScale)}
            >
              幅に合わせる
            </button>
          )}
          <div className="toolbar__spacer" />
          {image && (
            <button
              type="button"
              className={`button button--icon viewer__star${
                image.favorite ? ' viewer__star--on' : ''
              }`}
              onClick={() => void setFavorite([currentId], !image.favorite)}
              title={image.favorite ? 'お気に入りから外す (F)' : 'お気に入りに追加 (F)'}
              aria-label={image.favorite ? 'お気に入りから外す' : 'お気に入りに追加'}
              aria-pressed={image.favorite}
            >
              {image.favorite ? '★' : '☆'}
            </button>
          )}
          <button
            type="button"
            className="button button--icon"
            onClick={() => void rotate(currentId, -1)}
            title="左に回転 (Shift+R)"
            aria-label="左に回転"
          >
            ⟲
          </button>
          <button
            type="button"
            className="button button--icon"
            onClick={() => void rotate(currentId, 1)}
            title="右に回転 (R)"
            aria-label="右に回転"
          >
            ⟳
          </button>
          <button
            type="button"
            className="button button--subtle"
            onClick={() => void setFullScreen(!fullScreen)}
            title={fullScreen ? '全画面を終了 (F11 / Esc)' : '全画面 (F11)'}
          >
            {fullScreen ? '全画面を終了' : '全画面'}
          </button>
          <button
            type="button"
            className="button button--icon"
            onClick={() => confirmAndTrash([currentId])}
            title="ごみ箱へ移動 (Delete)"
            aria-label="ごみ箱へ移動"
          >
            🗑
          </button>
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
                // × は .chip の外に置く (チップの文字列にタグ名だけが入るように)
                <span key={tag.id} className="tag-chip">
                  <button
                    type="button"
                    className={`chip chip--tag ${tagClass(tag.category)}${
                      includeTags.includes(tag.id) ? ' chip--active' : ''
                    }${tag.manual ? ' chip--manual' : ''}`}
                    title={
                      tag.manual
                        ? '手で足したタグ — クリックでこのタグに絞り込む'
                        : `確信度 ${(tag.confidence * 100).toFixed(1)}% — クリックでこのタグに絞り込む`
                    }
                    onClick={() => toggleInclude(tag.id)}
                  >
                    {tag.name}
                  </button>
                  <button
                    type="button"
                    className="tag-chip__remove"
                    title="このタグを外す (付け直しでも戻りません)"
                    aria-label={`${tag.name} を外す`}
                    onClick={() => void removeTag([currentId], tag.id)}
                  >
                    ×
                  </button>
                </span>
              ))
            )}
            {info !== null && (
              <TagInput onSubmit={(name) => void addTag([currentId], name)} />
            )}
          </div>
        )}
      </div>
    </div>
  )
}
