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
  listLibraries: () => ipcRenderer.invoke(IPC.listLibraries),
  switchLibrary: (id) => ipcRenderer.invoke(IPC.switchLibrary, id),
  removeLibrary: (id) => ipcRenderer.invoke(IPC.removeLibrary, id),
  getTree: () => ipcRenderer.invoke(IPC.getTree),
  queryImages: (query) => ipcRenderer.invoke(IPC.queryImages, query),
  getImages: (ids) => ipcRenderer.invoke(IPC.getImages, ids),
  getImageInfo: (id) => ipcRenderer.invoke(IPC.getImageInfo, id),
  revealImage: (id) => ipcRenderer.invoke(IPC.revealImage, id),
  setRotation: (id, rotation) => ipcRenderer.invoke(IPC.setRotation, id, rotation),
  setFullScreen: (fullScreen) => ipcRenderer.invoke(IPC.setFullScreen, fullScreen),
  setFavorite: (ids, favorite) => ipcRenderer.invoke(IPC.setFavorite, ids, favorite),
  listSavedFilters: () => ipcRenderer.invoke(IPC.listSavedFilters),
  saveFilter: (name, data) => ipcRenderer.invoke(IPC.saveFilter, name, data),
  renameSavedFilter: (id, name) => ipcRenderer.invoke(IPC.renameSavedFilter, id, name),
  deleteSavedFilter: (id) => ipcRenderer.invoke(IPC.deleteSavedFilter, id),
  openImageExternal: (id) => ipcRenderer.invoke(IPC.openImageExternal, id),
  copyImage: (id, kind) => ipcRenderer.invoke(IPC.copyImage, id, kind),
  platform: process.platform,
  listTags: (request) => ipcRenderer.invoke(IPC.listTags, request),
  scanControl: (command) => ipcRenderer.invoke(IPC.scanControl, command),
  downloadFolder: (request) => ipcRenderer.invoke(IPC.downloadFolder, request),
  cancelDownload: () => ipcRenderer.invoke(IPC.cancelDownload),
  getDiagnostics: () => ipcRenderer.invoke(IPC.getDiagnostics),
  getLogInfo: () => ipcRenderer.invoke(IPC.getLogInfo),
  readLogTail: (lines) => ipcRenderer.invoke(IPC.readLogTail, lines),
  openLogFolder: () => ipcRenderer.invoke(IPC.openLogFolder),
  clearLog: () => ipcRenderer.invoke(IPC.clearLog),
  getScanProgress: () => ipcRenderer.invoke(IPC.getScanProgress),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (patch) => ipcRenderer.invoke(IPC.setSettings, patch),

  onLibraryChanged: (listener) => subscribe(IPC.eventLibraryChanged, listener),
  onScanProgress: (listener) => subscribe(IPC.eventScanProgress, listener),
  onIndexProgress: (listener) => subscribe(IPC.eventIndexProgress, listener),
  onImageTagged: (listener) => subscribe(IPC.eventImageTagged, listener),
  onRootChanged: (listener) => subscribe(IPC.eventRootChanged, listener),
  onGoBack: (listener) => subscribe(IPC.eventGoBack, listener),
  onFullScreen: (listener) => subscribe(IPC.eventFullScreen, listener)
}

contextBridge.exposeInMainWorld('api', api)
