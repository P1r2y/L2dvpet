'use strict'
/**
 * AI 桌面小精灵 — Electron 主进程
 *
 * 职责：
 *  - 创建全屏透明、置顶、默认鼠标穿透的宠物窗口
 *  - 通过自定义 app:// 协议提供本地资源（避免 file:// 的 XHR 限制）
 *  - 托盘图标与全局快捷键
 *  - 提供 LLM / TTS / STT 的本地代理（绕开渲染进程的跨域限制）
 */
const {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  net,
  screen,
  shell,
  session,
  Tray,
  Menu,
  globalShortcut,
  nativeImage,
  dialog,
} = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const { JsonStore } = require('./lib/store.cjs')
const defaults = require('../shared/defaults.json')
const llm = require('./lib/llm.cjs')
const tts = require('./lib/tts.cjs')
const stt = require('./lib/stt.cjs')
const gptsovits = require('./lib/gptsovits.cjs')
const scanGsv = require('./lib/gptsovits-scan.cjs')
const gsvService = require('./lib/gptsovits-service.cjs')
const voiceProfile = require('./lib/voice-profile.cjs')

const ROOT = path.resolve(__dirname, '..', '..')
/** Only files under these roots may be served through app://. */
const SERVE_ROOTS = [ROOT]

/** Escalating per-engine cooldowns after a synthesis failure. Mirrors tts.cjs. */
const FAILURE_BACKOFF_MS = [20_000, 60_000, 5 * 60_000, 30 * 60_000]

const isDev = process.argv.includes('--dev')
/** `--selftest[=path]` loads the app, screenshots it, then exits (CI / verification). */
const selftestArg = process.argv.find((a) => a.startsWith('--selftest'))
/**
 * `--selftest` runs the app **completely offscreen**: no visible window, no
 * tray icon, no global shortcuts. It must never take over the user's desktop.
 * Frames come from Electron's offscreen-rendering `paint` event instead of
 * `capturePage`, which does not work for a window that is never shown.
 */
const isSelftest = !!selftestArg
/** Offscreen rendering can be disabled with --onscreen for interactive debugging. */
const useOffscreen = isSelftest && !process.argv.includes('--onscreen')
const selftestPath = (() => {
  if (!selftestArg) return null
  const eq = selftestArg.indexOf('=')
  return eq > 0 ? selftestArg.slice(eq + 1) : path.join(ROOT, 'scripts', 'selftest.png')
})()
let mainWindow = null
let tray = null
let settings = null
let state = null
/** requestId -> AbortController for in-flight LLM streams */
const inflight = new Map()
/** Last language the pet actually spoke in — surfaced in the settings panel. */
let lastSpokenLanguage = null

/* ------------------------------------------------------------------ *
 * Security: restrict app:// to project files
 * ------------------------------------------------------------------ */
function resolveServedPath(urlPath) {
  let rel = decodeURIComponent(urlPath).replace(/^\/+/, '')
  if (!rel) rel = 'dist/index.html'
  const abs = path.resolve(ROOT, rel)
  const allowed = SERVE_ROOTS.some((root) => abs === root || abs.startsWith(root + path.sep))
  return allowed ? abs : null
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
      bypassCSP: false,
    },
  },
])

/* ------------------------------------------------------------------ *
 * Window
 * ------------------------------------------------------------------ */
function pickDisplay() {
  const displays = screen.getAllDisplays()
  const idx = Number(settings.get().display.screenIndex) || 0
  return displays[idx] || screen.getPrimaryDisplay()
}

function createWindow() {
  const display = pickDisplay()
  const { x, y, width, height } = display.bounds

  mainWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    title: '桌面小精灵',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      webgl: true,
      spellcheck: false,
      devTools: true,
      // Offscreen rendering keeps the self-test invisible on the desktop while
      // still producing real frames (including WebGL) for capture.
      offscreen: useOffscreen,
    },
  })

  mainWindow.setMenuBarVisibility(false)
  // Never steal the desktop while self-testing.
  if (!isSelftest) {
    mainWindow.setAlwaysOnTop(
      settings.get().display.alwaysOnTop,
      settings.get().display.alwaysOnTopLevel || 'screen-saver'
    )
  }
  if (process.platform === 'darwin' && !isSelftest) {
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }

  // Start click-through; the renderer opts in when the cursor is over the pet/UI.
  mainWindow.setIgnoreMouseEvents(true, { forward: true })
  mainWindow.setSkipTaskbar(true)

  mainWindow.loadURL('app://local/dist/index.html')

  // Surface renderer logs in the terminal — essential when verifying headless.
  mainWindow.webContents.on('console-message', (...args) => {
    // Electron >= 35 passes a single event object; older versions pass positionals.
    const evt = args[0]
    const isObj = evt && typeof evt === 'object' && 'message' in evt
    const level = isObj ? evt.level : args[1]
    const message = isObj ? evt.message : args[2]
    const line = isObj ? evt.lineNumber : args[3]
    const sourceId = isObj ? evt.sourceId : args[4]
    const levelName =
      typeof level === 'string' ? level : ['debug', 'info', 'warn', 'error'][level] || 'log'
    if (!isDev && !isSelftest && levelName !== 'error' && levelName !== 'warning') return
    console.log(`[renderer:${levelName}] ${message}${sourceId ? ` (${sourceId}:${line})` : ''}`)
  })
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer] process gone:', details)
  })
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[renderer] failed to load ${url}: ${code} ${desc}`)
  })

  mainWindow.once('ready-to-show', () => {
    if (!isSelftest && !settings.get().display.startHidden) mainWindow.showInactive()
    if (isDev || settings.get().advanced.devTools) mainWindow.webContents.openDevTools({ mode: 'detach' })
    if (isSelftest) {
      // Safety net: never hang a CI run if the renderer fails to report in.
      setTimeout(() => runSelftest(), 25000)
    }
  })

  // Offscreen rendering delivers frames here; kept as "the latest frame".
  if (useOffscreen) {
    mainWindow.webContents.setFrameRate(60)
    mainWindow.webContents.on('paint', (_e, _dirty, image) => {
      lastOsrFrame = image
    })
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Keep the pet window glued to its display if the desktop layout changes.
  const relayout = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const d = pickDisplay()
    mainWindow.setBounds(d.bounds)
    mainWindow.webContents.send('ui:command', { type: 'display-changed', bounds: d.bounds })
  }
  screen.on('display-metrics-changed', relayout)
  screen.on('display-added', relayout)
  screen.on('display-removed', relayout)

  return mainWindow
}

/** Sends a UI command to the renderer, ignoring a not-yet-ready window. */
function sendToRenderer(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('ui:command', payload)
}

/* ------------------------------------------------------------------ *
 * Interactive / click-through handling (with a liveness watchdog)
 * ------------------------------------------------------------------ */
let lastInteractiveAt = 0
let watchdog = null
let currentlyInteractive = false

function setInteractive(interactive) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  lastInteractiveAt = Date.now()
  if (interactive === currentlyInteractive) return
  currentlyInteractive = interactive
  if (interactive) mainWindow.setIgnoreMouseEvents(false)
  else mainWindow.setIgnoreMouseEvents(true, { forward: true })
}

function startWatchdog() {
  if (watchdog) return
  // If the renderer stops heart-beating while interactive (crash/hang), fall
  // back to click-through so the desktop never becomes unusable.
  watchdog = setInterval(() => {
    if (currentlyInteractive && Date.now() - lastInteractiveAt > 4000) {
      console.warn('[win] interactive heartbeat lost — restoring click-through')
      setInteractive(false)
    }
  }, 1000)
}

/* ------------------------------------------------------------------ *
 * Tray
 * ------------------------------------------------------------------ */
function trayImage() {
  const p = path.join(ROOT, 'dist', 'tray.png')
  if (fs.existsSync(p)) {
    const img = nativeImage.createFromPath(p)
    if (!img.isEmpty()) return img.resize({ width: 16, height: 16, quality: 'best' })
  }
  return nativeImage.createEmpty()
}

function buildTrayMenu() {
  const s = settings.get()
  const visible = !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()
  return Menu.buildFromTemplate([
    { label: '显示 / 隐藏桌宠', accelerator: 'CommandOrControl+Shift+H', click: () => toggleVisibility() },
    { type: 'separator' },
    { label: '打开对话', accelerator: 'CommandOrControl+Shift+C', click: () => showAndSend({ type: 'open-chat' }) },
    { label: '设置…', accelerator: 'CommandOrControl+Shift+S', click: () => showAndSend({ type: 'open-settings' }) },
    { type: 'separator' },
    {
      label: '鼠标穿透（点击穿过桌宠）',
      type: 'checkbox',
      checked: !currentlyInteractive,
      click: (item) => {
        // Manual override: force one state and stop the renderer from flipping it.
        manualClickThrough = item.checked
        setInteractive(!item.checked)
        sendToRenderer({ type: 'click-through-override', value: manualClickThrough })
      },
    },
    {
      label: '始终置顶',
      type: 'checkbox',
      checked: !!s.display.alwaysOnTop,
      click: (item) => {
        settings.patch({ display: { alwaysOnTop: item.checked } })
        mainWindow.setAlwaysOnTop(item.checked, settings.get().display.alwaysOnTopLevel || 'screen-saver')
      },
    },
    {
      label: '语音朗读',
      type: 'checkbox',
      checked: !!s.voice.ttsEnabled,
      click: (item) => {
        settings.patch({ voice: { ttsEnabled: item.checked } })
        sendToRenderer({ type: 'settings-changed-externally', settings: settings.get() })
      },
    },
    { type: 'separator' },
    { label: '重置位置', click: () => sendToRenderer({ type: 'reset-position' }) },
    { label: '重新加载', click: () => mainWindow && mainWindow.webContents.reload() },
    { label: '开发者工具', click: () => mainWindow && mainWindow.webContents.openDevTools({ mode: 'detach' }) },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true
        app.quit()
      },
    },
  ])
}

let manualClickThrough = false
let quitting = false

function refreshTray() {
  if (!tray) return
  tray.setContextMenu(buildTrayMenu())
  tray.setToolTip('桌面小精灵')
}

function createTray() {
  tray = new Tray(trayImage())
  refreshTray()
  tray.on('click', () => toggleVisibility())
  tray.on('double-click', () => showAndSend({ type: 'open-chat' }))
}

function toggleVisibility() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isVisible()) mainWindow.hide()
  else mainWindow.showInactive()
  refreshTray()
}

function showAndSend(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  if (!mainWindow.isVisible()) mainWindow.showInactive()
  setTimeout(() => sendToRenderer(payload), 120)
  refreshTray()
}

/* ------------------------------------------------------------------ *
 * IPC — settings & state
 * ------------------------------------------------------------------ */
function registerIpc() {
  ipcMain.handle('settings:get', () => settings.get())
  /** Factory defaults — the panel uses these to mark modified settings. */
  ipcMain.handle('settings:defaults', () => defaults)
  ipcMain.handle('settings:patch', (_e, partial) => {
    const next = settings.patch(partial || {})
    if (partial && partial.display) {
      if ('alwaysOnTop' in partial.display && mainWindow) {
        mainWindow.setAlwaysOnTop(next.display.alwaysOnTop, next.display.alwaysOnTopLevel || 'screen-saver')
      }
      if ('screenIndex' in partial.display) {
        const d = pickDisplay()
        mainWindow && mainWindow.setBounds(d.bounds)
      }
    }
    refreshTray()
    return next
  })
  ipcMain.handle('settings:reset', () => {
    const next = settings.reset()
    if (mainWindow) {
      mainWindow.setAlwaysOnTop(next.display.alwaysOnTop, next.display.alwaysOnTopLevel || 'screen-saver')
    }
    refreshTray()
    return next
  })
  ipcMain.handle('settings:open-file', async () => {
    settings.flush()
    shell.showItemInFolder(settings.filePath)
    return settings.filePath
  })

  ipcMain.handle('state:get', () => state.get())
  ipcMain.handle('state:patch', (_e, partial) => state.patch(partial || {}))

  /* ---- window ---- */
  ipcMain.on('win:set-interactive', (_e, interactive) => {
    if (manualClickThrough) return
    setInteractive(!!interactive)
  })
  ipcMain.on('win:set-ignore-mouse', (_e, ignore) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      currentlyInteractive = !ignore
      mainWindow.setIgnoreMouseEvents(!!ignore, { forward: true })
    }
  })
  ipcMain.handle('win:set-always-on-top', (_e, payload) => {
    const on = !!payload?.on
    const level = payload?.level || settings.get().display.alwaysOnTopLevel || 'screen-saver'
    settings.patch({ display: { alwaysOnTop: on, alwaysOnTopLevel: level } })
    if (mainWindow) mainWindow.setAlwaysOnTop(on, level)
    refreshTray()
    return { on, level }
  })
  ipcMain.handle('win:get-bounds', () => {
    const d = pickDisplay()
    return { ...d.bounds, scaleFactor: d.scaleFactor, displays: screen.getAllDisplays().length }
  })
  ipcMain.on('win:hide', () => {
    mainWindow && mainWindow.hide()
    refreshTray()
  })
  ipcMain.on('win:quit', () => {
    quitting = true
    app.quit()
  })
  ipcMain.on('win:reload', () => mainWindow && mainWindow.webContents.reload())
  ipcMain.on('win:devtools', () => mainWindow && mainWindow.webContents.openDevTools({ mode: 'detach' }))

  /* ---- app ---- */
  ipcMain.on('selftest:ready', () => {
    if (isSelftest) runSelftest()
  })
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    selftest: isSelftest,
    userData: app.getPath('userData'),
    settingsPath: settings.filePath,
    statePath: state.filePath,
    root: ROOT,
    displays: screen.getAllDisplays().map((d, i) => ({
      index: i,
      label: d.label || `显示器 ${i + 1}`,
      bounds: d.bounds,
      primary: d.id === screen.getPrimaryDisplay().id,
    })),
  }))
  ipcMain.handle('app:open-external', (_e, url) => {
    if (/^https?:\/\//i.test(String(url))) shell.openExternal(url)
  })
  ipcMain.handle('app:open-path', (_e, p) => {
    if (typeof p === 'string' && p) shell.openPath(p)
  })
  ipcMain.handle('app:get-auto-launch', () => app.getLoginItemSettings().openAtLogin)
  ipcMain.handle('app:set-auto-launch', (_e, enabled) => {
    app.setLoginItemSettings({ openAtLogin: !!enabled, args: [] })
    return app.getLoginItemSettings().openAtLogin
  })
  ipcMain.handle('app:register-hotkey', (_e, accelerator) => registerSttHotkey(accelerator))

  /* ---- LLM ---- */
  ipcMain.handle('llm:start', async (event, payload) => {
    const id = payload?.id || `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const s = settings.get()
    const cfg = { ...s.chat, ...(payload?.config || {}) }
    const controller = new AbortController()
    inflight.set(id, controller)

    const timeout = setTimeout(() => controller.abort(), Number(cfg.timeoutMs) || 60000)

    ;(async () => {
      try {
        if (cfg.stream === false) {
          // Non-streaming mode: one request, one delta, then done.
          const text = await llm.chatOnce(cfg, payload.messages || [], controller.signal)
          if (!event.sender.isDestroyed()) {
            if (text) event.sender.send('llm:delta', { id, text })
            event.sender.send('llm:done', { id })
          }
        } else {
          for await (const chunk of llm.streamChat(cfg, payload.messages || [], controller.signal)) {
            if (event.sender.isDestroyed()) break
            if (chunk.type === 'delta') event.sender.send('llm:delta', { id, text: chunk.text })
            else if (chunk.type === 'usage') event.sender.send('llm:delta', { id, usage: chunk.usage })
          }
          if (!event.sender.isDestroyed()) event.sender.send('llm:done', { id })
        }
      } catch (err) {
        const aborted = controller.signal.aborted
        if (!event.sender.isDestroyed()) {
          event.sender.send('llm:error', {
            id,
            message: aborted ? '请求已取消或超时' : String(err?.message || err),
            aborted,
          })
        }
      } finally {
        clearTimeout(timeout)
        inflight.delete(id)
      }
    })()

    return { id }
  })

  ipcMain.handle('llm:abort', (_e, id) => {
    const c = inflight.get(id)
    if (c) {
      c.abort()
      inflight.delete(id)
      return true
    }
    return false
  })

  ipcMain.handle('llm:test', async (_e, payload) => {
    const s = settings.get()
    const cfg = { ...s.chat, ...(payload?.config || {}) }
    try {
      const reply = await llm.chatOnce(
        { ...cfg, maxTokens: 32 },
        [
          { role: 'system', content: '你是一个测试助手，只回复两个字：成功' },
          { role: 'user', content: '连接测试' },
        ],
        AbortSignal.timeout(Number(cfg.timeoutMs) || 60000)
      )
      return { ok: true, reply: String(reply).slice(0, 120) }
    } catch (err) {
      return { ok: false, message: String(err?.message || err) }
    }
  })

  ipcMain.handle('llm:models', async (_e, payload) => {
    const s = settings.get()
    const cfg = { ...s.chat, ...(payload?.config || {}) }
    try {
      return { ok: true, models: await llm.listModels(cfg, AbortSignal.timeout(20000)) }
    } catch (err) {
      return { ok: false, message: String(err?.message || err) }
    }
  })

  /* ---- TTS ---- */
  ipcMain.handle('tts:speak', async (_e, payload) => {
    const s = settings.get()
    const text = payload?.text || ''
    // Pass the engine the user explicitly picked, so a manual retry is honoured.
    const effective = payload?.provider
      ? { ...s, voice: { ...s.voice, ttsProvider: payload.provider } }
      : s
    try {
      const { result, failed } = await tts.synthesizeWithFallback(effective, text, {
        failures: state.get().voiceFailures || {},
      })
      // Remember which engines failed, and *why* — the message is what makes a
      // later "unavailable" report diagnosable instead of a mystery.
      if (failed.length) {
        const map = { ...(state.get().voiceFailures || {}) }
        for (const f of failed) {
          const prev = map[f.provider]
          const count = (typeof prev === 'number' ? 1 : Number(prev?.count) || 0) + 1
          map[f.provider] = { at: Date.now(), count, error: f.message || '' }
        }
        state.patch({ voiceFailures: map })
      }
      if (failed.length) console.warn('[tts] failed engines:', failed.map((f) => f.provider).join(', '))
      if (result.lang) lastSpokenLanguage = result.lang
      return result
    } catch (err) {
      return { kind: 'error', message: String(err?.message || err) }
    }
  })

  ipcMain.handle('tts:voices', async (_e, payload) => {
    try {
      const provider = payload?.provider || settings.get().voice.ttsProvider
      const voices = await tts.listVoices(provider)
      return { ok: true, voices }
    } catch (err) {
      return { ok: false, message: String(err?.message || err), voices: [] }
    }
  })

  /** Language catalogue + which language a sample of text would be spoken in. */
  ipcMain.handle('tts:languages', (_e, payload) => {
    const sample = payload?.text || ''
    const s = settings.get()
    const resolved = voiceProfile.resolveProfile(s, sample)
    return {
      languages: voiceProfile.LANGUAGES,
      mode: s.voice.languageMode || 'auto',
      // What `auto` would pick right now (falls back to the last thing spoken).
      detected: resolved.detected,
      active: resolved.lang,
      lastSpokenLanguage: lastSpokenLanguage || null,
      profiles: s.voice.languageProfiles || {},
    }
  })

  /** Locates a GPT-SoVITS install, its weights and reference clips. */
  ipcMain.handle('tts:scan-gptsovits', (_e, payload) =>
    scanGsv.scan(payload?.root || settings.get().voice.gptsovits?.root)
  )

  /** Starts the GPT-SoVITS api_v2 service if it is not already up. */
  ipcMain.handle('gptsovits:ensure', async () => {
    const s = settings.get()
    const res = await gsvService.ensureRunning(s, (m) => console.log(m))
    if (res.ok) {
      // Once the service answers, pick up whatever weights are on disk.
      sendToRenderer({ type: 'gptsovits:ready', message: res.message })
    } else {
      sendToRenderer({ type: 'gptsovits:error', message: res.message })
    }
    return res
  })

  ipcMain.handle('gptsovits:status', async () => {
    const s = settings.get()
    const { host, port } = gsvService.parseHostPort(s.voice.gptsovits?.baseUrl)
    const up = await gsvService.portOpen(host, port)
    return {
      running: up,
      host,
      port,
      root: s.voice.gptsovits?.root || '',
      hasLauncher: !!gsvService.launcherFor(s.voice.gptsovits?.root),
    }
  })

  /** Which engines are currently usable / cooling down after a failure. */
  ipcMain.handle('tts:status', async () => {
    const s = settings.get()
    const failures = state.get().voiceFailures || {}
    let gsv = { ok: false }
    try {
      gsv = await gptsovits.probe(s.voice.gptsovits?.baseUrl, 1500)
    } catch {
      /* ignore */
    }
    const info = (p) => {
      const e = failures[p]
      const entry = typeof e === 'number' ? { at: e, count: 1 } : e
      if (!entry) return { provider: p, cooling: false, failedAt: 0, retryInSec: 0, count: 0, error: '' }
      const wait = FAILURE_BACKOFF_MS[Math.min((entry.count || 1) - 1, FAILURE_BACKOFF_MS.length - 1)]
      const left = wait - (Date.now() - entry.at)
      return {
        provider: p,
        cooling: left > 0,
        failedAt: entry.at,
        retryInSec: left > 0 ? Math.ceil(left / 1000) : 0,
        retryInMin: left > 0 ? Math.ceil(left / 60000) : 0,
        count: entry.count || 1,
        error: entry.error || '',
      }
    }
    return {
      configured: s.voice.ttsProvider,
      gptsovitsAvailable: !!gsv.ok,
      hasOpenaiKey: !!(s.voice.openaiApiKey || s.chat?.apiKey),
      languageMode: s.voice.languageMode || 'auto',
      lastSpokenLanguage: lastSpokenLanguage || null,
      engines: ['gptsovits', 'openai'].map(info),
    }
  })

  /* ---- STT ---- */
  ipcMain.handle('stt:transcribe', async (_e, payload) => {
    const s = settings.get()
    try {
      return { ok: true, ...(await stt.transcribe(s, payload || {})) }
    } catch (err) {
      return { ok: false, message: String(err?.message || err) }
    }
  })
}

/* ------------------------------------------------------------------ *
 * Media permissions — the pet needs the microphone for voice input.
 * ------------------------------------------------------------------ */
function setupPermissions() {
  const ses = session.defaultSession
  const ALLOWED = new Set(['media', 'audioCapture', 'microphone'])
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED.has(permission))
  })
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED.has(permission))
}

/* ------------------------------------------------------------------ *
 * Global shortcuts
 * ------------------------------------------------------------------ */
let sttHotkeyRegistered = null

function registerSttHotkey(accelerator) {
  const acc = String(accelerator || '').trim()
  try {
    if (sttHotkeyRegistered) globalShortcut.unregister(sttHotkeyRegistered)
  } catch {
    /* ignore */
  }
  sttHotkeyRegistered = null
  if (!acc) return { ok: true, accelerator: '' }
  try {
    const ok = globalShortcut.register(acc, () => showAndSend({ type: 'toggle-record' }))
    if (ok) {
      sttHotkeyRegistered = acc
      return { ok: true, accelerator: acc }
    }
    return { ok: false, message: `快捷键 ${acc} 已被其他程序占用` }
  } catch (err) {
    return { ok: false, message: `快捷键无效: ${err.message}` }
  }
}

function registerFixedShortcuts() {
  const bind = (acc, fn) => {
    try {
      globalShortcut.register(acc, fn)
    } catch (err) {
      console.warn(`[shortcut] failed to register ${acc}:`, err.message)
    }
  }
  bind('CommandOrControl+Shift+H', () => toggleVisibility())
  bind('CommandOrControl+Shift+C', () => showAndSend({ type: 'open-chat' }))
  bind('CommandOrControl+Shift+S', () => showAndSend({ type: 'open-settings' }))
}

/**
 * Pushes the OS cursor position to the renderer (~30 Hz, only on change).
 *
 * The pet window is clamped by Windows to the work area, so it does not cover
 * the taskbar. Relying on DOM pointer events alone made the gaze collapse
 * whenever the cursor moved onto the taskbar (a `pointerleave` fired and the
 * gaze target was cleared). Reading the real cursor makes tracking authoritative
 * and also works when the cursor sits on another monitor.
 */
let cursorFeedTimer = null

function startCursorFeed() {
  if (cursorFeedTimer) return
  let last = { x: -99999, y: -99999 }
  cursorFeedTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return
    try {
      const p = screen.getCursorScreenPoint()
      if (Math.abs(p.x - last.x) < 1 && Math.abs(p.y - last.y) < 1) return
      last = p
      const d = pickDisplay()
      mainWindow.webContents.send('pointer:global', {
        x: p.x - d.bounds.x,
        y: p.y - d.bounds.y,
        screenX: p.x,
        screenY: p.y,
      })
    } catch {
      /* display may be changing */
    }
  }, 33)
}

/* ------------------------------------------------------------------ *
 * Self-test: capture frames offscreen, then exit.
 * ------------------------------------------------------------------ */
let selftestRunning = false
/** Latest frame from offscreen rendering. */
let lastOsrFrame = null

/**
 * Grabs one frame from the window.
 * Offscreen windows never composite to the screen, so `capturePage` returns
 * blank — the `paint` event is the supported path there.
 */
async function grabFrame(wc) {
  if (!useOffscreen) return wc.capturePage()
  return new Promise((resolve) => {
    let done = false
    const finish = (img) => {
      if (done) return
      done = true
      clearTimeout(timer)
      wc.off('paint', onPaint)
      resolve(img)
    }
    const onPaint = (_e, _dirty, image) => finish(image)
    const timer = setTimeout(() => finish(lastOsrFrame), 4000)
    wc.on('paint', onPaint)
    wc.invalidate()
    // If a frame is already available, use it as an immediate fallback.
    if (lastOsrFrame) setTimeout(() => finish(lastOsrFrame), 1200)
  })
}

async function runSelftest() {
  if (!isSelftest || selftestRunning || !mainWindow) return
  selftestRunning = true
  const dir = path.dirname(selftestPath)
  const base = path.basename(selftestPath, '.png')
  fs.mkdirSync(dir, { recursive: true })
  const wc = mainWindow.webContents

  const shot = async (name, prep, waitMs) => {
    try {
      if (prep) await prep()
      await new Promise((r) => setTimeout(r, waitMs))
      const img = await grabFrame(wc)
      if (!img || img.isEmpty()) {
        console.error(`[selftest] ${name} -> 空帧（离屏渲染可能不可用）`)
        return
      }
      const p = path.join(dir, `${base}-${name}.png`)
      fs.writeFileSync(p, img.toPNG())
      const size = img.getSize()
      console.log(`[selftest] ${name} -> ${p} (${size.width}x${size.height})`)
    } catch (err) {
      console.error(`[selftest] ${name} failed:`, err.message)
    }
  }

  const diag = () =>
    wc
      .executeJavaScript(
        `(() => { const d = window.__petDiag; return (typeof d === 'function' ? d() : d) || {}; })()`,
        true
      )
      .catch(() => ({}))

  const move = (x, y, extra = {}) =>
    wc.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y), ...extra })

  await shot('base', null, 2600)

  /* ---- gaze: pointer far to the left, then far to the right ---- */
  const d0 = await diag()
  const b = d0.modelBounds || { left: 1200, top: 400, width: 350, height: 680 }
  const faceX = Math.round(b.left + b.width / 2)
  const faceY = Math.round(b.top + b.height * 0.16)
  console.log('[selftest] face point', faceX, faceY, 'bounds', JSON.stringify(b))

  const params = () => wc.executeJavaScript(`window.__petTest.applied()`, true).catch(() => null)
  const pointer = () => wc.executeJavaScript(`window.__petTest.pointer()`, true).catch(() => null)
  await wc.executeJavaScript(`window.__petTest.setCapture(true)`, true)
  // Synthetic moves do not move the real cursor; pause the OS cursor feed so
  // the gaze assertions test the DOM path deterministically.
  await wc.executeJavaScript(`window.__petTest.setGlobalPointer(false)`, true).catch(() => {})

  /**
   * Moves the gaze target to a point and lets the controller settle there.
   * Synthetic `sendInputEvent` coordinates proved unreliable in this
   * environment, so the target is set through the app's own API instead.
   */
  const gazeTo = async (x, y, settleMs = 900) => {
    for (let i = 0; i < 6; i++) {
      await wc.executeJavaScript(`window.__petTest.setGazeTarget(${x}, ${y})`, true).catch(() => {})
      await new Promise((r) => setTimeout(r, 40))
    }
    await new Promise((r) => setTimeout(r, settleMs))
  }

  await wc.executeJavaScript(`window.__petTest.setCapture(true)`, true)

  await shot('gaze-left', () => gazeTo(120, 500), 200)
  const pLeft = await params()
  const ptrLeft = await pointer()
  console.log('[selftest] applied after gaze-left ', JSON.stringify(pLeft), 'pointer', JSON.stringify(ptrLeft))

  await shot('gaze-right', () => gazeTo(1960, 200), 200)
  const pRight = await params()
  const ptrRight = await pointer()
  console.log('[selftest] applied after gaze-right', JSON.stringify(pRight), 'pointer', JSON.stringify(ptrRight))

  {
    const ok = pLeft && pRight && typeof pLeft.eyeBallX === 'number' && typeof pRight.eyeBallX === 'number'
    if (!ok) {
      console.log('[selftest] GAZE FAIL — no parameter read-back')
    } else {
      const dEye = pRight.eyeBallX - pLeft.eyeBallX
      const dHead = pRight.angleX - pLeft.angleX
      const dBody = pRight.bodyX - pLeft.bodyX
      const eyeOk = dEye > 0.1
      const headOk = dHead > 1
      console.log(
        `[selftest] GAZE ${eyeOk && headOk ? 'PASS' : 'FAIL'} — ΔeyeBallX=${dEye.toFixed(3)} (${pLeft.eyeBallX.toFixed(3)}→${pRight.eyeBallX.toFixed(3)}), ΔAngleX=${dHead.toFixed(2)}°, ΔBodyAngleX=${dBody.toFixed(2)}°`
      )
    }
  }
  // Restore the authoritative cursor feed for the remaining scenarios.
  await wc.executeJavaScript(`window.__petTest.setGlobalPointer(true)`, true).catch(() => {})

  /* ---- petting: press on the head and stroke, hearts + squint ---- */
  await shot(
    'petting',
    async () => {
      move(faceX, faceY)
      await new Promise((r) => setTimeout(r, 200))
      wc.sendInputEvent({ type: 'mouseDown', x: faceX, y: faceY, button: 'left', clickCount: 1 })
      for (let i = 0; i < 26; i++) {
        const x = faceX + Math.round(Math.sin(i / 2) * 55)
        const y = faceY + Math.round(Math.cos(i / 3) * 10)
        wc.sendInputEvent({
          type: 'mouseMove',
          x,
          y,
          movementX: i === 0 ? 0 : x - faceX,
          movementY: 0,
          button: 'left',
        })
        await new Promise((r) => setTimeout(r, 55))
      }
    },
    120
  )

  const dPet = await diag()
  console.log(
    '[selftest] while petting ->',
    JSON.stringify({
      emotion: dPet.emotion,
      gaze: dPet.gaze,
      bounds: dPet.modelBounds,
    })
  )

  await shot(
    'after-pet',
    async () => {
      wc.sendInputEvent({ type: 'mouseUp', x: faceX, y: faceY, button: 'left', clickCount: 1 })
    },
    900
  )

  await shot('chat', () => sendToRenderer({ type: 'open-chat' }), 1400)
  await shot('settings', () => sendToRenderer({ type: 'open-settings' }), 1400)
  await shot('voice', () => sendToRenderer({ type: 'open-settings', section: 'voice' }), 2200)
  await shot(
    'gptsovits',
    () => sendToRenderer({ type: 'open-settings', section: 'voice', group: 'gptsovits' }),
    1200
  )
  await shot('motion', () => sendToRenderer({ type: 'open-settings', section: 'idle' }), 1200)
  await shot('params', () => sendToRenderer({ type: 'open-settings', section: 'params' }), 1200)

  /* ---- optional: exercise the real LLM / TTS / STT code paths ---- */
  const apiArg = process.argv.find((a) => a.startsWith('--selftest-api='))
  const apiBase = apiArg ? apiArg.split('=')[1] : process.env.PET_TEST_API || null
  if (apiBase) {
    console.log(`[selftest] exercising API pipeline against ${apiBase}`)
    sendToRenderer({ type: 'open-chat' })
    await new Promise((r) => setTimeout(r, 400))

    await wc.executeJavaScript(
      `window.__petTest.setSettings({
         chat: { enabled: true, baseUrl: ${JSON.stringify(apiBase)}, apiKey: 'test-key', model: 'mock-chat', stream: true, maxTokens: 200, bubbleDuration: 30, autoGreeting: false },
         voice: {
           ttsEnabled: true, ttsProvider: 'openai',
           openaiBaseUrl: ${JSON.stringify(apiBase)}, openaiApiKey: 'test-key', openaiModel: 'tts-1', openaiVoice: 'nova',
           autoSpeak: true, lipSync: true, volume: 0.6,
           sttEnabled: true, sttBaseUrl: ${JSON.stringify(apiBase)}, sttApiKey: 'test-key', sttModel: 'whisper-1', sttLanguage: 'zh', sttMaxSeconds: 20
         }
       })`,
      true
    )

    const chatPromise = wc.executeJavaScript(`window.__petTest.chat('请介绍一下你自己')`, true)
    await new Promise((r) => setTimeout(r, 900))
    await shot('api-streaming', null, 0)

    let chatResult = null
    try {
      chatResult = await Promise.race([
        chatPromise,
        new Promise((r) => setTimeout(() => r({ timeout: true }), 25000)),
      ])
    } catch (err) {
      chatResult = { error: err.message }
    }
    console.log('[selftest] chat result', JSON.stringify(chatResult))

    // Sample the mouth while TTS plays to prove lip-sync is driven by audio.
    // `void` so we don't block on the promise — we want to sample during playback.
    wc.executeJavaScript(`void window.__petTest.speak('你好呀，我是你的桌面宠物，很高兴认识你。')`, true).catch(
      () => {}
    )
    let maxMouth = 0
    let maxMouthParam = 0
    let samples = 0
    let maxVoiceLevel = 0
    const t0 = Date.now()
    while (Date.now() - t0 < 9000) {
      const st = await wc
        .executeJavaScript(
          `({ s: window.__petTest.outputState(), p: window.__petTest.applied() })`,
          true
        )
        .catch(() => null)
      if (st) {
        samples++
        if (st.s.mouth > maxMouth) maxMouth = st.s.mouth
        if (st.p?.mouthOpenY > maxMouthParam) maxMouthParam = st.p.mouthOpenY
        maxVoiceLevel = Math.max(maxVoiceLevel, st.s.voiceDebug?.maxLevel || 0)
        if (samples === 6) await shot('api-speaking', null, 0)
      }
      await new Promise((r) => setTimeout(r, 120))
    }
    console.log(
      `[selftest] LIPSYNC ${maxMouthParam > 0.15 ? 'PASS' : 'FAIL'} — peak ParamMouthOpenY = ${maxMouthParam.toFixed(3)}, pet mouth = ${maxMouth.toFixed(3)}, audio level = ${maxVoiceLevel.toFixed(3)}, ${samples} samples`
    )

    const st = await wc.executeJavaScript(`window.__petTest.outputState()`, true).catch(() => null)
    console.log('[selftest] output state', JSON.stringify(st))
    await shot('api-chatlog', null, 300)

    /* ---- STT: main-process upload path, then the real microphone path ---- */
    const stt1 = await wc
      .executeJavaScript(`window.__petTest.testSttSynthetic()`, true)
      .catch((e) => ({ ok: false, message: e.message }))
    console.log(`[selftest] STT(upload) ${stt1?.ok ? 'PASS' : 'FAIL'} —`, JSON.stringify(stt1))

    const stt2 = await wc
      .executeJavaScript(`window.__petTest.testSttRecord(2200)`, true)
      .catch((e) => ({ ok: false, message: e.message }))
    console.log(`[selftest] STT(mic)    ${stt2?.ok ? 'PASS' : 'FAIL'} —`, JSON.stringify(stt2))

    /* ---- 模型参数：18 个 psd2live 参数是否都能手动驱动 ---- */
    const allParams = await wc
      .executeJavaScript(`window.__petTest.testAllParams()`, true)
      .catch((e) => ({ error: e.message }))
    if (allParams.error) {
      console.log('[selftest] 模型参数 FAIL —', allParams.error)
    } else {
      const ok = allParams.passed === allParams.total
      console.log(
        `[selftest] 模型参数 ${ok ? 'PASS' : 'FAIL'} — ${allParams.passed}/${allParams.total} 个参数可手动驱动` +
          (ok ? '' : `，失败：${JSON.stringify(allParams.failures)}`)
      )
    }

    /* ---- 模型参数：自动模式上下限 ---- */
    const limitTest = await wc
      .executeJavaScript(`window.__petTest.testAutoLimits()`, true)
      .catch((e) => ({ error: e.message }))
    if (limitTest.error) {
      console.log('[selftest] 参数上下限 FAIL —', limitTest.error)
    } else {
      const ok = limitTest.clampedHigh && limitTest.clampedLow && limitTest.traced
      console.log(
        `[selftest] 参数上下限 ${ok ? 'PASS' : 'FAIL'} — ` +
          `上限 ${limitTest.raw}→${limitTest.high}（限 ${limitTest.limitHigh}）, ` +
          `下限 ${limitTest.raw}→${limitTest.low}（限 ${limitTest.limitLow}）, ` +
          `曲线采样 ${limitTest.traced} 点`
      )
    }

    /* ---- 参数锁定：锁定后预设不得覆盖 ---- */
    const lockRes = await wc
      .executeJavaScript(`window.__petTest.testLock('voice.pitchShift')`, true)
      .catch((e) => ({ error: e.message }))
    if (lockRes.error) {
      console.log('[selftest] 锁定 FAIL —', lockRes.error)
    } else {
      console.log(
        `[selftest] 锁定 ${lockRes.lockHeld && lockRes.unlockApplied ? 'PASS' : 'FAIL'} — ` +
          `预设 ${lockRes.original}→${lockRes.probeValue}, found=${lockRes.found}, ` +
          `锁定中未被覆盖=${lockRes.lockHeld}, 解锁后生效=${lockRes.unlockApplied}`
      )
      console.log(`[selftest]   锁定轨迹 ${JSON.stringify(lockRes.trace)}`)
    }

    /* ---- 动作参数：必须与 psd2live 生成的 motion 曲线相容 ---- */
    const ranges = await wc
      .executeJavaScript(`window.__petTest.paramRanges()`, true)
      .catch(() => ({}))
    console.log(
      '[selftest] 模型参数范围',
      Object.entries(ranges || {})
        .filter(([, v]) => v && v.index >= 0)
        .map(([k, v]) => `${k.replace('Param', '')}[${v.min},${v.max}]`)
        .join(' ')
    )

    for (const motion of ['nod', 'shake']) {
      const r = await wc
        .executeJavaScript(`window.__petTest.testReaction(${JSON.stringify(motion)})`, true)
        .catch((e) => ({ error: e.message }))
      if (r.error) {
        console.log(`[selftest] 动作 ${motion} -> 失败: ${r.error}`)
        continue
      }
      // What matters is that the authored excursion reaches the mesh at all.
      // Cubism fades a motion in over its Meta.FadeInTime (1 s by default, and
      // psd2live's generator omits the field), so a peak that lands early in the
      // clip is attenuated — we therefore assert on the total swing, not on
      // hitting both authored extremes exactly.
      const excursion = r.max - r.min
      const want = motion === 'nod' ? 15 : 20
      const authored = motion === 'nod' ? 'AngleY 0→−18→+6（共 24°）' : 'AngleX 0→−20→+20（共 40°）'
      const ok = excursion >= want
      console.log(
        `[selftest] 动作 ${motion} -> ${ok ? 'PASS' : 'FAIL'} 区间 [${r.min}, ${r.max}] 摆幅 ${excursion.toFixed(1)}°  ` +
          `曲线 ${authored}  | 睁眼最低 ${r.eyeMin} | 果冻眼 [${r.jellyMin}, ${r.jellyMax}]`
      )
    }

    /* ---- idle motion 自带的呼吸与头部摇摆是否还在生效 ---- */
    await wc.executeJavaScript(`window.__petTest.applied()`, true).catch(() => null)
    {
      let breathMin = Infinity
      let breathMax = -Infinity
      let angleZMin = Infinity
      let angleZMax = -Infinity
      const t0 = Date.now()
      while (Date.now() - t0 < 7000) {
        const a = await wc.executeJavaScript(`window.__petTest.applied()`, true).catch(() => null)
        if (a) {
          if (typeof a.breath === 'number') {
            breathMin = Math.min(breathMin, a.breath)
            breathMax = Math.max(breathMax, a.breath)
          }
          if (typeof a.angleZ === 'number') {
            angleZMin = Math.min(angleZMin, a.angleZ)
            angleZMax = Math.max(angleZMax, a.angleZ)
          }
        }
        await new Promise((r) => setTimeout(r, 120))
      }
      const breathOk = breathMax - breathMin > 0.25
      const swayOk = angleZMax - angleZMin > 0.8
      console.log(
        `[selftest] 待机曲线 ${breathOk && swayOk ? 'PASS' : 'FAIL'} — 呼吸 ${breathMin.toFixed(2)}~${breathMax.toFixed(2)}（idle 曲线 0↔1）` +
          `，头部摇摆 ${angleZMin.toFixed(2)}~${angleZMax.toFixed(2)}°（idle 曲线 ±2°）`
      )
    }

    /* ---- optional: force the mouth open/closed for visual inspection ---- */
  if (process.argv.includes('--selftest-mouth')) {
    // Hide every panel so the character is actually visible in the capture.
    await wc.executeJavaScript(
      `['settings-panel','chat-panel','bubble','dock','toast'].forEach(id => document.getElementById(id)?.classList.add('hidden'))`,
      true
    )
    await new Promise((r) => setTimeout(r, 400))
    const b = (await diag()).modelBounds || { left: 1460, top: 408, width: 355, height: 684 }
    const faceX = Math.round(b.left + b.width / 2)
    const faceY = Math.round(b.top + b.height * 0.22)
    for (const [name, value] of [
      ['mouth-closed', 0],
      ['mouth-half', 0.5],
      ['mouth-open', 1],
    ]) {
      await wc.executeJavaScript(
        `window.__petTest.setSettings({ modelParams: { enabled: true, items: { ParamMouthOpenY: { mode: 'fixed', value: ${value} } } } })`,
        true
      )
      await new Promise((r) => setTimeout(r, 700))
      await shot(`mouth-${value}`, null, 0)
      const a = await params()
      // Measure the mesh while the override is still in force.
      const d = await wc
        .executeJavaScript(`window.__petTest.dumpDrawables()`, true)
        .catch((e) => ({ error: e.message }))
      const rows = d?.drawables || []
      const m = rows.find((r) => r.id === 'ArtMeshMouth')
      const f = rows.find((r) => r.id === 'ArtMeshFace')
      // Full precision — the mouth may be a sub-pixel sliver.
      const raw = (r) => (r?.bbox ? r.bbox.map((n) => n.toExponential(2)).join(', ') : 'null')
      const one = (id) => {
        const r = rows.find((x) => x.id === id)
        return r
          ? `${id}: verts=${r.verts} idx=${r.indices} masks=${r.masks}${r.maskIds ? '->' + JSON.stringify(r.maskIds) : ''} blend=${r.blend} uv=${JSON.stringify(r.uv)}`
          : `${id}: (missing)`
      }
      console.log(`[selftest] mouth fixed=${value} -> ParamMouthOpenY=${a?.mouthOpenY}`)
      for (const id of [
        'ArtMeshFace',
        'ArtMeshNose',
        'ArtMeshMouth',
        'ArtMeshMouth_lip_0',
        'ArtMeshEyewhiteL',
        'ArtMeshEyewhiteR',
        'ArtMeshIridesL',
        'ArtMeshEyelashL',
        'ArtMeshEyebrowL',
        'ArtMeshBottomwear',
        'ArtMeshBottomwear2',
        'ArtMeshLegwearL',
      ]) {
        console.log('     ' + one(id))
      }
      console.log(`     ArtMeshMouth bbox=[${raw(m)}]`)
    }
    await wc.executeJavaScript(
      `window.__petTest.setSettings({ modelParams: { enabled: false, items: {} } })`,
      true
    )

    /*
     * Control: does getDrawableVertices actually report the *deformed* mesh?
     * A 45° head yaw must move the face vertices. If the bbox is unchanged, the
     * vertex probe is returning static data and the mouth measurement above
     * cannot be trusted.
     */
    for (const angle of [0, 45]) {
      await wc.executeJavaScript(
        `window.__petTest.setSettings({ modelParams: { enabled: true, items: { ParamAngleX: { mode: 'fixed', value: ${angle} } } } })`,
        true
      )
      await new Promise((r) => setTimeout(r, 500))
      const d = await wc.executeJavaScript(`window.__petTest.dumpDrawables()`, true).catch(() => null)
      const f = (d?.drawables || []).find((r) => r.id === 'ArtMeshFace')
      console.log(`[selftest] 对照 ParamAngleX=${angle} -> face bbox=${JSON.stringify(f?.bbox)} sample=${JSON.stringify(f?.sample)}`)
    }
    await wc.executeJavaScript(
      `window.__petTest.setSettings({ modelParams: { enabled: false, items: {} } })`,
      true
    )
    console.log('[selftest] face point', faceX, faceY)
  }

  /* ---- GPT-SoVITS 端到端 ---- */
    if (process.argv.includes('--selftest-gsv')) {
      const gsv = await wc
        .executeJavaScript(`window.__petTest.testGptsovits()`, true)
        .catch((e) => ({ ok: false, step: 'invoke', message: e.message }))
      console.log(`[selftest] GPT-SoVITS ${gsv?.ok ? 'PASS' : 'FAIL'} —`, JSON.stringify(gsv))
      await shot('gsv-speaking', null, 300)
    }

    /* ---- 声线 / pitch shift ---- */
    const eng = await wc.executeJavaScript(`window.__petTest.engineStatus()`, true).catch(() => null)
    console.log('[selftest] engines', JSON.stringify(eng))

    /*
     * The pitch test has to actually synthesize, so it needs a reachable
     * engine. Prefer the local clone service, then the online one; when
     * neither is configured, skip rather than fail — a missing API key is a
     * setup state, not a regression.
     */
    const pitchProvider = eng?.gptsovitsAvailable
      ? 'gptsovits'
      : eng?.hasOpenaiKey
        ? 'openai'
        : null
    const pitchRows = pitchProvider
      ? await wc
          .executeJavaScript(`window.__petTest.testPitch(${JSON.stringify(pitchProvider)})`, true)
          .catch((e) => [{ error: e.message }])
      : null
    for (const r of pitchRows || []) {
      console.log(
        `[selftest] pitch ${r.pitch} -> play=${r.ok} provider=${r.provider} rate=${r.playbackRate} preservesPitch=${r.preservesPitch} src=${r.srcDuration}s` +
          ` | probe kind=${r.probeKind} via=${r.probeProvider} probeRate=${r.probeRate}` +
          (r.probeError ? ` err=${r.probeError}` : '') +
          (r.lastError ? ` lastError=${r.lastError}` : '')
      )
    }
    {
      const rows = (pitchRows || []).filter((r) => r && r.srcDuration > 0)
      if (rows.length === 3) {
        const [lo, mid, hi] = rows
        const grows = hi.srcDuration > mid.srcDuration && mid.srcDuration > lo.srcDuration
        const rateOk = Math.abs(lo.playbackRate - 0.8) < 0.01 && Math.abs(hi.playbackRate - 1.3) < 0.01
        const pitchOff = lo.preservesPitch === false && hi.preservesPitch === false
        console.log(
          `[selftest] PITCH ${grows && rateOk && pitchOff ? 'PASS' : 'FAIL'} — 源时长 ${lo.srcDuration}/${mid.srcDuration}/${hi.srcDuration}s 随音调增长=${grows}, 播放倍率=${rateOk}, preservesPitch=false=${pitchOff}`
        )
      } else if (!pitchProvider) {
        console.log('[selftest] PITCH SKIP — 未配置可用的语音引擎（GPT-SoVITS 未运行且无在线 TTS Key）')
      } else {
        console.log(`[selftest] PITCH FAIL — 未能取得三次合成结果（引擎 ${pitchProvider}）`)
      }
    }
  }

  try {
    console.log('[selftest] diag', JSON.stringify(await diag()))
  } catch (err) {
    console.error('[selftest] diag failed:', err.message)
  }

  console.log('[selftest] done')
  setTimeout(() => app.exit(0), 200)
}

/* ------------------------------------------------------------------ *
 * Bootstrap
 * ------------------------------------------------------------------ */
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      mainWindow.showInactive()
      refreshTray()
    }
  })

  app.whenReady().then(() => {
    settings = new JsonStore(path.join(app.getPath('userData'), 'settings.json'), defaults)
    state = new JsonStore(path.join(app.getPath('userData'), 'state.json'), {
      affection: 0,
      chatHistory: [],
      petPos: { x: 0.8, y: 0.99 },
      uiPos: { chat: { x: 0, y: 0 }, settings: { x: 0, y: 0 } },
      /** provider -> timestamp of last failure; {} is a free-form map. */
      voiceFailures: {},
      lastSeen: Date.now(),
      stats: { pets: 0, messages: 0, spoken: 0 },
    })
    // Materialise both files on first run so users can find and hand-edit them.
    if (!fs.existsSync(settings.filePath)) settings.flush()
    if (!fs.existsSync(state.filePath)) state.flush()

    protocol.handle('app', async (request) => {
      const url = new URL(request.url)
      const abs = resolveServedPath(url.pathname)
      if (!abs || !fs.existsSync(abs)) {
        return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } })
      }
      return net.fetch(pathToFileURL(abs).toString())
    })

    registerIpc()
    setupPermissions()
    createWindow()
    // The tray icon and global shortcuts would intrude on the user's desktop,
    // so neither is created while self-testing.
    if (!isSelftest) {
      createTray()
      registerFixedShortcuts()
      registerSttHotkey(settings.get().voice.sttHotkey)
    }
    startWatchdog()
    startCursorFeed()

    /*
     * Bring GPT-SoVITS up with the pet, if the user asked for it. It is started
     * lazily (after the UI is up) and never during a self-test.
     */
    if (!isSelftest && settings.get().voice.gptsovits?.autoStart) {
      setTimeout(async () => {
        try {
          // First run (or an empty install path): adopt whatever is on disk so
          // the voice works without the user filling anything in.
          if (!settings.get().voice.gptsovits?.root) {
            const scan = scanGsv.scan(null)
            if (scan?.root) {
              const g = {
                root: scan.root,
                baseUrl: settings.get().voice.gptsovits?.baseUrl || 'http://127.0.0.1:9880',
                mode: 'weights',
              }
              if (scan.gptWeights.length && scan.sovitsWeights.length) {
                g.gptWeights = scan.gptWeights[0].path
                g.sovitsWeights = scan.sovitsWeights[0].path
              } else if (scan.pretrained.gpt && scan.pretrained.sovits) {
                g.gptWeights = scan.pretrained.gpt
                g.sovitsWeights = scan.pretrained.sovits
              }
              const ref = scan.references[0]
              if (ref) {
                // Base models can only clone, so a reference clip is required.
                g.mode = scan.gptWeights.length ? 'weights' : 'audio'
                g.refAudio = ref.path
                if (ref.transcript) {
                  g.promptText = ref.transcript
                  g.promptLang = /[\u3040-\u30ff]/.test(ref.transcript) ? 'ja' : 'zh'
                }
              }
              await settings.patch({ voice: { gptsovits: g } })
              console.log(`[gptsovits] 已自动配置：${scan.root}`)
            }
          }

          const res = await gsvService.ensureRunning(settings.get(), (m) => console.log(m))
          console.log(`[gptsovits] ${res.message}`)
          if (res.ok) sendToRenderer({ type: 'gptsovits:ready', message: res.message })
          else sendToRenderer({ type: 'gptsovits:error', message: res.message })
        } catch (e) {
          console.log('[gptsovits] 自动启动失败:', e.message)
        }
      }, 2500)
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    quitting = true
    for (const c of inflight.values()) {
      try {
        c.abort()
      } catch {
        /* ignore */
      }
    }
    inflight.clear()
    globalShortcut.unregisterAll()
    settings && settings.flush()
    state && state.flush()
  })

  app.on('will-quit', () => globalShortcut.unregisterAll())

  process.on('uncaughtException', (err) => {
    console.error('[main] uncaught exception:', err)
  })
  process.on('unhandledRejection', (err) => {
    console.error('[main] unhandled rejection:', err)
  })
}
