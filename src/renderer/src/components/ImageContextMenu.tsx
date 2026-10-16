import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CopyKind } from '@shared/types'
import { confirmAndTrash } from '../lib/trash'
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
  /** ツールチップ */
  hint?: string
}

type Entry = Item | 'separator'

const COPY_NOTICE: Record<CopyKind, string> = {
  image: '画像をコピーしました',
  path: 'パスをコピーしました',
  name: 'ファイル名をコピーしました',
  tags: 'タグをコピーしました',
  tagsExcluded: '除外タグを除いてコピーしました'
}

/** コピーできなかったときの通知。タグは「全部除外された」こともあるので文言を分ける */
const COPY_FAILED: Record<CopyKind, string> = {
  image: 'コピーできませんでした',
  path: 'コピーできませんでした',
  name: 'コピーできませんでした',
  tags: 'コピーするタグがありません',
  tagsExcluded: 'コピーするタグがありません'
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
  const images = useStore((state) => state.images)
  const selection = useStore((state) => state.selection)
  const excludeCount = useStore((state) => state.settings?.copyExcludeTags.length ?? 0)
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
    state.showNotice(ok ? COPY_NOTICE[kind] : COPY_FAILED[kind])
  }

  const favorite = images[id]?.favorite ?? false
  // 選択中の画像を右クリックしたら、選んだ全部にかける (一覧で 2 枚以上選んでいるとき)
  const multi = viewerIndex === null && selection.length >= 2 && selection.includes(id)
  const targets = multi ? selection : [id]
  const count = targets.length

  const copyLines = async (kind: 'path' | 'name'): Promise<void> => {
    const ok = await window.api.copyText(targets, kind)
    const what = kind === 'path' ? 'パス' : 'ファイル名'
    useStore
      .getState()
      .showNotice(ok ? `${count} 枚の${what}をコピーしました` : 'コピーできませんでした')
  }

  const entries: Entry[] = []
  // 単画像ビューでは今まさに開いているので出さない
  if (viewerIndex === null && !multi) {
    entries.push({
      label: '開く',
      action: () => {
        const state = useStore.getState()
        const index = state.ids.indexOf(id)
        if (index >= 0) state.openViewer(index)
      }
    })
  }
  // 1 枚にしか意味の無い項目 (開く・画像のコピー等) は、右クリックした 1 枚にかける
  entries.push(
    { label: '既定のアプリで開く', action: () => window.api.openImageExternal(id) },
    { label: revealLabel(window.api.platform), action: () => window.api.revealImage(id) }
  )
  if (multi) {
    entries.push(
      {
        label: `${count} 枚をお気に入りに追加`,
        action: () => useStore.getState().setFavorite(targets, true)
      },
      {
        label: `${count} 枚をお気に入りから外す`,
        action: () => useStore.getState().setFavorite(targets, false)
      }
    )
  } else {
    entries.push({
      label: favorite ? 'お気に入りから外す' : 'お気に入りに追加',
      action: () => useStore.getState().setFavorite([id], !favorite)
    })
  }
  entries.push(
    'separator',
    { label: '画像をコピー', action: () => copy('image') },
    multi
      ? { label: `${count} 枚のパスをコピー`, action: () => copyLines('path') }
      : { label: 'パスをコピー', action: () => copy('path') },
    multi
      ? { label: `${count} 枚のファイル名をコピー`, action: () => copyLines('name') }
      : { label: 'ファイル名をコピー', action: () => copy('name') },
    { label: 'タグをコピー', action: () => copy('tags'), disabled: hasTags !== true },
    {
      label: 'タグをコピー (除外あり)',
      action: () => copy('tagsExcluded'),
      disabled: hasTags !== true || excludeCount === 0,
      // 除外ルールが無いと押せないので、どこで登録するかを示す
      hint: excludeCount === 0 ? '設定の「コピーから除外するタグ」で登録すると使えます' : undefined
    },
    'separator',
    {
      label: multi ? `${count} 枚をごみ箱へ移動` : 'ごみ箱へ移動',
      action: () => confirmAndTrash(targets)
    }
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
            title={entry.hint}
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
