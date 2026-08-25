import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { RendererApi } from '@shared/api'
import { IPC } from '@shared/types'

/** main → renderer のイベントを購読し、解除用の関数を返す。 */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api: RendererApi = {
  openFolder: () => ipcRenderer.invoke(IPC.openFolder),
  getRoot: () => ipcRenderer.invoke(IPC.getRoot),
  getTree: () => ipcRenderer.invoke(IPC.getTree),
  queryImages: (query) => ipcRenderer.invoke(IPC.queryImages, query),
  getImages: (ids) => ipcRenderer.invoke(IPC.getImages, ids),
  getImageInfo: (id) => ipcRenderer.invoke(IPC.getImageInfo, id),
  revealImage: (id) => ipcRenderer.invoke(IPC.revealImage, id),
  listTags: (request) => ipcRenderer.invoke(IPC.listTags, request),
  scanControl: (command) => ipcRenderer.invoke(IPC.scanControl, command),
  downloadFolder: (request) => ipcRenderer.invoke(IPC.downloadFolder, request),
  cancelDownload: () => ipcRenderer.invoke(IPC.cancelDownload),
  getDiagnostics: () => ipcRenderer.invoke(IPC.getDiagnostics),
  getScanProgress: () => ipcRenderer.invoke(IPC.getScanProgress),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (patch) => ipcRenderer.invoke(IPC.setSettings, patch),

  onLibraryChanged: (listener) => subscribe(IPC.eventLibraryChanged, listener),
  onScanProgress: (listener) => subscribe(IPC.eventScanProgress, listener),
  onIndexProgress: (listener) => subscribe(IPC.eventIndexProgress, listener),
  onImageTagged: (listener) => subscribe(IPC.eventImageTagged, listener),
  onRootChanged: (listener) => subscribe(IPC.eventRootChanged, listener)
}

contextBridge.exposeInMainWorld('api', api)
