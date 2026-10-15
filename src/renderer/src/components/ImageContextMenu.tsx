import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CopyKind } from '@shared/types'
import { useStore } from '../store'

/** 画面端からこれだけは離して表示する */
const EDGE_MARGIN = 4

/** 「フォルダで表示」の文言は OS の呼び方に合わせる */
function revealLabel(platform: string): string {
  if (platform === 'win32') return 'エクスプローラーで表示'
  if (platform === 'darwin') return 'Finder で表示'
  return 'フォルダで表示'
}

interface Item {
  label: string
  action: () => void | Promise<void>
  disabled?: boolean
}

type Entry = Item | 'separator'

const COPY_NOTICE: Record<CopyKind, string> = {
  image: '画像をコピーしました',
  path: 'パスをコピーしました',
  name: 'ファイル名をコピーしました',
  tags: 'タグをコピーしました'
}

/**
 * 画像の右クリックメニュー。一覧のサムネイルと単画像ビューの両方から開く。
 *
 * Electron のネイティブメニューではなく DOM で描いている。
 * 見た目をアプリに揃えられるのと、e2e で中身を確かめられるため。
 */
export default function ImageContextMenu(): React.JSX.Element | null {
  const menu = useStore((state) => state.contextMenu)
  const close = useStore((state) => state.closeContextMenu)
  const viewerIndex = useStore((state) => state.viewerIndex)
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const [hasTags, setHasTags] = useState<boolean | null>(null)
  const [active, setActive] = useState(-1)

  // タグが無い画像では「タグをコピー」を無効にする
  useEffect(() => {
    setHasTags(null)
    if (!menu) return
    let cancelled = false
    void window.api.getImageInfo(menu.id).then((info) => {
      if (!cancelled) setHasTags(info.tags.length > 0)
    })
    return () => {
      cancelled = true
    }
  }, [menu])

  // 画面からはみ出さないよう、大きさを測ってから位置を決める
  useLayoutEffect(() => {
    setActive(-1)
    const element = ref.current
    if (!menu || !element) {
      setPosition(null)
      return
    }
    const { width, height } = element.getBoundingClientRect()
    const maxLeft = window.innerWidth - width - EDGE_MARGIN
    const maxTop = window.innerHeight - height - EDGE_MARGIN
    setPosition({
      // 右や下に収まらなければ、カーソルの反対側へ開く (OS のメニューと同じ)
      left: Math.max(EDGE_MARGIN, menu.x > maxLeft ? menu.x - width : menu.x),
      top: Math.max(EDGE_MARGIN, menu.y > maxTop ? Math.max(menu.y - height, 0) : menu.y)
    })
  }, [menu])

  // 一覧 ⇔ 単画像を行き来したら閉じる
  useEffect(() => close(), [viewerIndex, close])

  // 外側のクリック・スクロール・ウィンドウ切り替えで閉じる
  useEffect(() => {
    if (!menu) return
    const onPointerDown = (event: MouseEvent): void => {
      if (ref.current?.contains(event.target as Node)) return
      close()
    }
    const onDismiss = (): void => close()
    window.addEventListener('mousedown', onPointerDown, true)
    window.addEventListener('wheel', onDismiss, true)
    window.addEventListener('resize', onDismiss)
    window.addEventListener('blur', onDismiss)
    return () => {
      window.removeEventListener('mousedown', onPointerDown, true)
      window.removeEventListener('wheel', onDismiss, true)
      window.removeEventListener('resize', onDismiss)
      window.removeEventListener('blur', onDismiss)
    }
  }, [menu, close])

  if (!menu) return null
  const { id } = menu

  const copy = async (kind: CopyKind): Promise<void> => {
    const state = useStore.getState()
    const ok = await window.api.copyImage(id, kind)
    state.showNotice(ok ? COPY_NOTICE[kind] : 'コピーできませんでした')
  }

  const entries: Entry[] = []
  // 単画像ビューでは今まさに開いているので出さない
  if (viewerIndex === null) {
    entries.push({
      label: '開く',
      action: () => {
        const state = useStore.getState()
        const index = state.ids.indexOf(id)
        if (index >= 0) state.openViewer(index)
      }
    })
  }
  entries.push(
    { label: '既定のアプリで開く', action: () => window.api.openImageExternal(id) },
    { label: revealLabel(window.api.platform), action: () => window.api.revealImage(id) },
    'separator',
    { label: '画像をコピー', action: () => copy('image') },
    { label: 'パスをコピー', action: () => copy('path') },
    { label: 'ファイル名をコピー', action: () => copy('name') },
    { label: 'タグをコピー', action: () => copy('tags'), disabled: hasTags !== true }
  )
  const items = entries.filter((entry): entry is Item => entry !== 'separator')

  const run = (item: Item): void => {
    if (item.disabled) return
    close()
    void item.action()
  }

  // キー操作: ↑↓ で選択、Enter で実行、Esc で閉じる。
  // Esc は単画像ビューを閉じる操作にも割り当たっているので、ここで止める
  const onKeyDown = (event: React.KeyboardEvent): void => {
    const enabled = items.map((item, index) => (item.disabled ? -1 : index)).filter((i) => i >= 0)
    if (event.key === 'Escape') {
      close()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const at = enabled.indexOf(active)
      const delta = event.key === 'ArrowDown' ? 1 : -1
      const next =
        at < 0
          ? enabled[delta > 0 ? 0 : enabled.length - 1]
          : enabled[(at + delta + enabled.length) % enabled.length]
      setActive(next ?? -1)
    } else if (event.key === 'Enter') {
      if (items[active]) run(items[active])
    } else {
      return
    }
    event.preventDefault()
    event.stopPropagation()
  }

  let itemIndex = -1
  return (
    <div
      ref={(element) => {
        ref.current = element
        // 開いたらフォーカスを移し、キー操作を受けられるようにする
        element?.focus({ preventScroll: true })
      }}
      className="context-menu"
      role="menu"
      tabIndex={-1}
      style={
        position
          ? { left: `${position.left}px`, top: `${position.top}px` }
          : { left: `${menu.x}px`, top: `${menu.y}px`, visibility: 'hidden' }
      }
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {entries.map((entry, index) => {
        if (entry === 'separator') {
          return <div key={`sep-${index}`} className="context-menu__separator" role="separator" />
        }
        itemIndex += 1
        const current = itemIndex
        return (
          <button
            key={entry.label}
            type="button"
            role="menuitem"
            className={`context-menu__item${current === active ? ' context-menu__item--active' : ''}`}
            disabled={entry.disabled}
            onMouseEnter={() => setActive(current)}
            onMouseLeave={() => setActive(-1)}
            onClick={() => run(entry)}
          >
            {entry.label}
          </button>
        )
      })}
    </div>
  )
}
