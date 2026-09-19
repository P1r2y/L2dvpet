'use strict'
/**
 * Renderer ⇄ main bridge. Exposes a narrow, typed-ish API on `window.pet`;
 * no Node primitives leak into the renderer.
 */
const { contextBridge, ipcRenderer } = require('electron')

/** Subscribes to a main→renderer channel; returns an unsubscribe function. */
function on(channel, cb) {
  const wrapped = (_event, payload) => {
    try {
      cb(payload)
    } catch (err) {
      console.error(`[preload] listener for ${channel} threw`, err)
    }
  }
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

contextBridge.exposeInMainWorld('pet', {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    defaults: () => ipcRenderer.invoke('settings:defaults'),
    patch: (partial) => ipcRenderer.invoke('settings:patch', partial),
    reset: () => ipcRenderer.invoke('settings:reset'),
    openFile: () => ipcRenderer.invoke('settings:open-file'),
  },

  state: {
    get: () => ipcRenderer.invoke('state:get'),
    patch: (partial) => ipcRenderer.invoke('state:patch', partial),
  },

  llm: {
    start: (payload) => ipcRenderer.invoke('llm:start', payload),
    abort: (id) => ipcRenderer.invoke('llm:abort', id),
    test: (payload) => ipcRenderer.invoke('llm:test', payload),
    models: (payload) => ipcRenderer.invoke('llm:models', payload),
    onDelta: (cb) => on('llm:delta', cb),
    onDone: (cb) => on('llm:done', cb),
    onError: (cb) => on('llm:error', cb),
  },

  tts: {
    speak: (payload) => ipcRenderer.invoke('tts:speak', payload),
    voices: (payload) => ipcRenderer.invoke('tts:voices', payload),
    status: () => ipcRenderer.invoke('tts:status'),
    languages: (payload) => ipcRenderer.invoke('tts:languages', payload),
    scanGptsovits: (payload) => ipcRenderer.invoke('tts:scan-gptsovits', payload),
    ensureGptsovits: () => ipcRenderer.invoke('gptsovits:ensure'),
    gptsovitsStatus: () => ipcRenderer.invoke('gptsovits:status'),
    onGptsovitsReady: (cb) => on('gptsovits:ready', cb),
    onGptsovitsError: (cb) => on('gptsovits:error', cb),
    onInstallHint: (cb) => on('tts:hint', cb),
  },

  stt: {
    transcribe: (payload) => ipcRenderer.invoke('stt:transcribe', payload),
  },

  win: {
    setInteractive: (interactive) => ipcRenderer.send('win:set-interactive', !!interactive),
    setAlwaysOnTop: (payload) => ipcRenderer.invoke('win:set-always-on-top', payload),
    getBounds: () => ipcRenderer.invoke('win:get-bounds'),
    hide: () => ipcRenderer.send('win:hide'),
    quit: () => ipcRenderer.send('win:quit'),
    reload: () => ipcRenderer.send('win:reload'),
    devtools: () => ipcRenderer.send('win:devtools'),
    setIgnoreMouse: (ignore) => ipcRenderer.send('win:set-ignore-mouse', !!ignore),
    setSize: (payload) => ipcRenderer.invoke('win:set-size', payload),
    selfTestReady: () => ipcRenderer.send('selftest:ready'),
  },

  app: {
    info: () => ipcRenderer.invoke('app:info'),
    openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
    openPath: (p) => ipcRenderer.invoke('app:open-path', p),
    setAutoLaunch: (enabled) => ipcRenderer.invoke('app:set-auto-launch', !!enabled),
    getAutoLaunch: () => ipcRenderer.invoke('app:get-auto-launch'),
    registerHotkey: (accelerator) => ipcRenderer.invoke('app:register-hotkey', accelerator),
  },

  on,
  /** Real OS cursor position, pushed at ~30 Hz (only when it changes). */
  onGlobalPointer: (cb) => on('pointer:global', cb),
  platform: process.platform,
})
