import { useStore } from '../store'

/**
 * 確認してからごみ箱へ移す。OS のごみ箱なので元に戻せるが、
 * 一覧から消えるので毎回確認する。
 */
export function confirmAndTrash(ids: number[]): void {
  if (ids.length === 0) return
  const state = useStore.getState()
  const target =
    ids.length === 1 ? `「${state.images[ids[0]]?.fileName ?? '選択した画像'}」` : `${ids.length} 枚の画像`
  const ok = window.confirm(`${target}をごみ箱へ移動しますか？\nOS のごみ箱から元に戻せます。`)
  if (ok) void state.trashImages(ids)
}
