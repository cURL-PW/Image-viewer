import { BrowserWindow } from 'electron'
import { LAST_ROOT_KEY } from './settings'
import { listPlaceholders } from './win-placeholders'
import type { LibraryDb } from './db'
import type { Library } from './library'
import type { ResolvedImage } from './protocol'
import type { SettingsStore } from './settings'
import type { CloudGuard } from './cloud-guard'
import type { DerivedImageCache } from './image-cache'
import type { TaggerService } from './tagger/service'

export interface AppContext {
  db: LibraryDb
  library: Library
  thumbs: DerivedImageCache
  /** HEIC など、ブラウザが直接表示できない形式の表示用トランスコード */
  display: DerivedImageCache
  settings: SettingsStore
  guard: CloudGuard
  tagger: TaggerService
  resolve: (id: number) => ResolvedImage | null
}

/** クラウド判定をルートごとに覚えておくための設定キー。 */
export function cloudModeKey(rootPath: string): string {
  return `cloud_mode:${rootPath}`
}

/**
 * ルートフォルダを開く。
 *
 * 走査は `setRoot` の中で即座に始まり、その走査自体が `fs.stat` でファイルを開く
 * (= クラウドではダウンロードが走る) ため、**門番の状態を決めてから**開くこと。
 * 以前クラウドと判定したフォルダは、また数枚落として確かめ直さずに済むよう記憶を復元する。
 */
export async function openRoot(ctx: AppContext, rootPath: string): Promise<number> {
  const remembered = ctx.db.getSetting(cloudModeKey(rootPath)) === '1'
  ctx.guard.reset(remembered)

  const rootId = await ctx.library.setRoot(rootPath)
  ctx.db.setSetting(LAST_ROOT_KEY, String(rootId))
  ctx.tagger.notifyLibraryChanged()

  // 属性から未ダウンロードの一覧を作る。列挙はファイルのデータを読まないので
  // ダウンロードは起きない。走査と並行して進め、できあがったら門番へ渡す。
  void refreshPlaceholderIndex(ctx, rootPath)
  return rootId
}

/**
 * ファイル属性による未ダウンロード一覧を作り直す。
 * Windows 以外や PowerShell が使えない環境では null になり、
 * 「遅さの回路遮断器」だけで守る従来の動作へフォールバックする。
 */
export async function refreshPlaceholderIndex(
  ctx: AppContext,
  rootPath: string
): Promise<void> {
  const paths = await listPlaceholders(rootPath)
  // 待っている間にフォルダが切り替わっていたら捨てる
  if (ctx.library.currentRootPath !== rootPath) return
  ctx.guard.setPlaceholderIndex(paths)
  ctx.tagger.notifyLibraryChanged()
}

/** 開いている全ウィンドウへイベントを送る。 */
export function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}
