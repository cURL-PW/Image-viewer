import { BrowserWindow } from 'electron'
import type { LibraryDb } from './db'
import type { Library } from './library'
import type { ResolvedImage } from './protocol'
import type { SettingsStore } from './settings'
import type { DerivedImageCache } from './image-cache'
import type { TaggerService } from './tagger/service'

export interface AppContext {
  db: LibraryDb
  library: Library
  thumbs: DerivedImageCache
  /** HEIC など、ブラウザが直接表示できない形式の表示用トランスコード */
  display: DerivedImageCache
  settings: SettingsStore
  tagger: TaggerService
  resolve: (id: number) => ResolvedImage | null
}

/** 開いている全ウィンドウへイベントを送る。 */
export function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}
