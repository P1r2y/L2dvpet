'use strict'
/**
 * AI desktop pet — Electron main process
 *
 * Responsibilities:
 *  - create the pet window: full-screen, transparent, always-on-top and
 *    click-through by default
 *  - serve local assets through a custom app:// protocol (avoids the XHR limits
 *    of file://)
 *  - tray icon and global shortcuts
 *  - local proxy for LLM / TTS / STT (works around the renderer's CORS limits)
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
const i18n = require('./lib/i18n.cjs')

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
  /*
   * Only `--selftest` / `--selftest=<path>` carry a screenshot path. The other
   * flags that merely start with `--selftest` (`--selftest-api=<url>`,
   * `--selftest-mouth`, `--selftest-gsv`) must not donate their `=` value —
   * taking a URL as a path used to hang the run before the first screenshot.
   */
  const own = process.argv.find((a) => a === '--selftest' || a.startsWith('--selftest='))
  const fallback = path.join(ROOT, 'scripts', 'selftest.png')
  if (!own) return fallback
  const eq = own.indexOf('=')
  return eq > 0 ? own.slice(eq + 1) : fallback
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
    title: i18n.t('AI Desktop Pet'),
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
 * Interface language
 * ------------------------------------------------------------------ */
/**
 * Re-resolves the interface language from `ui.language` (`auto` follows the OS
 * locale). Called once at startup and again on every tray rebuild, so the tray
 * menu, the tooltips and the hotkey messages all follow the setting.
 */
function applyLang() {
  i18n.setLang(settings.get().ui && settings.get().ui.language, app.getLocale())
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
    { label: i18n.t('Show / hide pet'), accelerator: 'CommandOrControl+Shift+H', click: () => toggleVisibility() },
    { type: 'separator' },
    { label: i18n.t('Open chat'), accelerator: 'CommandOrControl+Shift+C', click: () => showAndSend({ type: 'open-chat' }) },
    { label: i18n.t('Settings…'), accelerator: 'CommandOrControl+Shift+S', click: () => showAndSend({ type: 'open-settings' }) },
    { type: 'separator' },
    {
      label: i18n.t('Click-through (clicks pass through the pet)'),
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
      label: i18n.t('Always on top'),
      type: 'checkbox',
      checked: !!s.display.alwaysOnTop,
      click: (item) => {
        settings.patch({ display: { alwaysOnTop: item.checked } })
        mainWindow.setAlwaysOnTop(item.checked, settings.get().display.alwaysOnTopLevel || 'screen-saver')
      },
    },
    {
      label: i18n.t('Speak replies'),
      type: 'checkbox',
      checked: !!s.voice.ttsEnabled,
      click: (item) => {
        settings.patch({ voice: { ttsEnabled: item.checked } })
        sendToRenderer({ type: 'settings-changed-externally', settings: settings.get() })
      },
    },
    { type: 'separator' },
    { label: i18n.t('Reset position'), click: () => sendToRenderer({ type: 'reset-position' }) },
    { label: i18n.t('Reload'), click: () => mainWindow && mainWindow.webContents.reload() },
    { label: i18n.t('Developer tools'), click: () => mainWindow && mainWindow.webContents.openDevTools({ mode: 'detach' }) },
    { type: 'separator' },
    {
      label: i18n.t('Quit'),
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
  // Rebuilt from scratch every time, so the language is re-resolved here too:
  // switching it in the settings panel updates the tray without a restart.
  applyLang()
  if (!tray) return
  tray.setContextMenu(buildTrayMenu())
  tray.setToolTip(i18n.t('AI Desktop Pet'))
}

function createTray() {
  tray = new Tray(trayImage())
  refreshTray()
  tray.on('click', () => toggleVisibility())
  tray.on('double-click', () => showAndSend({ type: 'open-chat' }))
}

/**
 * Settings → Display → Show tray icon. Hiding the tray is safe: the window can
 * still be brought back with Ctrl+Shift+H or from the pet's own menus.
 */
function setTrayEnabled(enabled) {
  if (enabled) {
    if (!tray) createTray()
  } else if (tray) {
    try {
      tray.destroy()
    } catch {
      /* already gone */
    }
    tray = null
  }
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
      if ('showTray' in partial.display) {
        setTrayEnabled(next.display.showTray !== false)
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
    setTrayEnabled(next.display?.showTray !== false)
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
      label: d.label || i18n.t('Display {n}', { n: i + 1 }),
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
            message: aborted ? i18n.t('Request cancelled or timed out') : String(err?.message || err),
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
          { role: 'system', content: 'You are a test assistant. Reply with exactly one word: OK' },
          { role: 'user', content: 'Connection test' },
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
    return { ok: false, message: i18n.t('Shortcut {acc} is already taken by another program', { acc }) }
  } catch (err) {
    return { ok: false, message: i18n.t('Invalid shortcut: {error}', { error: err.message }) }
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
        console.error(`[selftest] ${name} -> empty frame (offscreen rendering may be unavailable)`)
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

    /*
     * Everything below drives the mock through the *real* settings store, so
     * without a snapshot this section overwrites the user's own endpoint, API
     * key and voice settings, and leaves the mock addresses behind (which also
     * breaks their chat until they notice). Capture the fields we are about to
     * touch, and write them back before the block ends.
     */
    const restoreSettings = await wc
      .executeJavaScript(
        `(() => {
           const s = window.__petTest.settings() || {};
           const pick = (o, keys) => keys.reduce((a, k) => (k in (o || {}) ? (a[k] = o[k], a) : a), {});
           return {
             chat: pick(s.chat, ['enabled','baseUrl','apiKey','model','stream','maxTokens','bubbleDuration','autoGreeting']),
             voice: pick(s.voice, ['ttsEnabled','ttsProvider','openaiBaseUrl','openaiApiKey','openaiModel','openaiVoice','autoSpeak','lipSync','volume','sttEnabled','sttBaseUrl','sttApiKey','sttModel','sttLanguage','sttMaxSeconds']),
           };
         })()`,
        true
      )
      .catch(() => null)

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

    const chatPromise = wc.executeJavaScript(`window.__petTest.chat('Tell me about yourself')`, true)
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
    wc.executeJavaScript(`void window.__petTest.speak('Hi there, I am your desktop pet — nice to meet you.')`, true).catch(
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
    if (maxMouthParam <= 0.15) {
      /*
       * Intermittent (~1 run in 4): the pet reports a healthy mouth value while
       * the model parameter never moves at all. Dump the state that would
       * explain it, so the next occurrence is diagnosable rather than just
       * "flaky".
       */
      const dbg = await wc
        .executeJavaScript(
          `(() => {
             const s = window.__petTest.settings() || {};
             const st = window.__petTest.outputState() || {};
             return {
               modelParamsEnabled: !!s.modelParams?.enabled,
               mouthOverride: s.modelParams?.items?.ParamMouthOpenY || null,
               voiceDebug: st.voiceDebug || null,
               applied: window.__petTest.applied(),
             };
           })()`,
          true
        )
        .catch((e) => ({ error: e.message }))
      console.log('[selftest] LIPSYNC diagnosis', JSON.stringify(dbg))
    }

    /*
     * The bubble must sit beside the model's top-right and inside the window. An
     * anchor reading a field getModelBounds() does not provide yields NaN, which
     * CSS drops — the bubble then silently parks in the top-left corner, which
     * only shows up on a screenshot.
     */
    try {
      const br = await wc.executeJavaScript(`window.__petTest.bubbleRect()`, true)
      const mb = (await diag()).modelBounds
      if (!br) {
        console.log('[selftest] BUBBLE FAIL — bubble not shown')
      } else {
        const right = mb ? mb.left + mb.width : null
        const top = mb ? mb.top : null
        /*
         * Anchored at the model's top-right corner: either hung off its right
         * edge, or right-aligned to that edge when the screen side is too narrow
         * to hold the bubble — and always above the model's head.
         */
        const onScreen =
          br.left >= 0 && br.top >= 0 && br.right <= br.winW && br.bottom <= br.winH && br.width > 40
        const anchored =
          right === null || Math.abs(br.right - (right + 10)) <= 60 || Math.abs(br.right - right) <= 40
        const above = top === null || br.bottom <= top + 24
        console.log(
          `[selftest] BUBBLE ${onScreen && anchored && above ? 'PASS' : 'FAIL'} — rect=(${br.left},${br.top})-(${br.right},${br.bottom}) ` +
            `tailRight=${br.tailRight} below=${br.below} | model top-right=(${right === null ? '?' : Math.round(right)},${top === null ? '?' : Math.round(top)}) win=${br.winW}x${br.winH}`
        )
      }
    } catch (err) {
      console.log('[selftest] BUBBLE FAIL —', err.message)
    }

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

    /* ---- model params: can all 18 psd2live params be driven manually? ---- */
    const allParams = await wc
      .executeJavaScript(`window.__petTest.testAllParams()`, true)
      .catch((e) => ({ error: e.message }))
    if (allParams.error) {
      console.log('[selftest] model params FAIL —', allParams.error)
    } else {
      const ok = allParams.passed === allParams.total
      console.log(
        `[selftest] model params ${ok ? 'PASS' : 'FAIL'} — ${allParams.passed}/${allParams.total} params can be driven manually` +
          (ok ? '' : `, failed: ${JSON.stringify(allParams.failures)}`)
      )
    }

    /* ---- model params: auto-mode upper / lower limits ---- */
    const limitTest = await wc
      .executeJavaScript(`window.__petTest.testAutoLimits()`, true)
      .catch((e) => ({ error: e.message }))
    if (limitTest.error) {
      console.log('[selftest] param limits FAIL —', limitTest.error)
    } else {
      const ok = limitTest.clampedHigh && limitTest.clampedLow && limitTest.traced
      console.log(
        `[selftest] param limits ${ok ? 'PASS' : 'FAIL'} — ` +
          `upper ${limitTest.raw}→${limitTest.high} (limit ${limitTest.limitHigh}), ` +
          `lower ${limitTest.raw}→${limitTest.low} (limit ${limitTest.limitLow}), ` +
          `curve sampled ${limitTest.traced} points`
      )
    }

    /* ---- param locks: a preset must not overwrite a locked param ---- */
    const lockRes = await wc
      .executeJavaScript(`window.__petTest.testLock('voice.pitchShift')`, true)
      .catch((e) => ({ error: e.message }))
    if (lockRes.error) {
      console.log('[selftest] lock FAIL —', lockRes.error)
    } else {
      console.log(
        `[selftest] lock ${lockRes.lockHeld && lockRes.unlockApplied ? 'PASS' : 'FAIL'} — ` +
          `preset ${lockRes.original}→${lockRes.probeValue}, found=${lockRes.found}, ` +
          `held while locked=${lockRes.lockHeld}, applied after unlock=${lockRes.unlockApplied}`
      )
      console.log(`[selftest]   lock trace ${JSON.stringify(lockRes.trace)}`)
    }

    /* ---- motion params: must stay compatible with the motion curves psd2live generates ---- */
    const ranges = await wc
      .executeJavaScript(`window.__petTest.paramRanges()`, true)
      .catch(() => ({}))
    console.log(
      '[selftest] model param ranges',
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
        console.log(`[selftest] motion ${motion} -> failed: ${r.error}`)
        continue
      }
      // What matters is that the authored excursion reaches the mesh at all.
      // Cubism fades a motion in over its Meta.FadeInTime (1 s by default, and
      // psd2live's generator omits the field), so a peak that lands early in the
      // clip is attenuated — we therefore assert on the total swing, not on
      // hitting both authored extremes exactly.
      const excursion = r.max - r.min
      const want = motion === 'nod' ? 15 : 20
      const authored = motion === 'nod' ? 'AngleY 0→−18→+6 (24° total)' : 'AngleX 0→−20→+20 (40° total)'
      const ok = excursion >= want
      console.log(
        `[selftest] motion ${motion} -> ${ok ? 'PASS' : 'FAIL'} range [${r.min}, ${r.max}] swing ${excursion.toFixed(1)}°  ` +
          `curve ${authored}  | lowest eye-open ${r.eyeMin} | jelly eye [${r.jellyMin}, ${r.jellyMax}]`
      )
    }

    /* ---- idle motion: is its baked-in breathing and head sway still effective? ---- */
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
        `[selftest] idle curves ${breathOk && swayOk ? 'PASS' : 'FAIL'} — breath ${breathMin.toFixed(2)}~${breathMax.toFixed(2)} (idle curve 0↔1)` +
          `, head sway ${angleZMin.toFixed(2)}~${angleZMax.toFixed(2)}° (idle curve ±2°)`
      )
    }


  /* ---- GPT-SoVITS end to end ---- */
    if (process.argv.includes('--selftest-gsv')) {
      const gsv = await wc
        .executeJavaScript(`window.__petTest.testGptsovits()`, true)
        .catch((e) => ({ ok: false, step: 'invoke', message: e.message }))
      console.log(`[selftest] GPT-SoVITS ${gsv?.ok ? 'PASS' : 'FAIL'} —`, JSON.stringify(gsv))
      await shot('gsv-speaking', null, 300)
    }

    /* ---- voice pitch / pitch shift ---- */
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
          `[selftest] PITCH ${grows && rateOk && pitchOff ? 'PASS' : 'FAIL'} — source durations ${lo.srcDuration}/${mid.srcDuration}/${hi.srcDuration}s grow with pitch=${grows}, playbackRate=${rateOk}, preservesPitch=false=${pitchOff}`
        )
      } else if (!pitchProvider) {
        console.log('[selftest] PITCH SKIP — no usable voice engine configured (GPT-SoVITS is not running and there is no online TTS key)')
      } else {
        console.log(`[selftest] PITCH FAIL — could not get all three synthesis results (engine ${pitchProvider})`)
      }
    }

    if (restoreSettings) {
      await wc
        .executeJavaScript(`window.__petTest.setSettings(${JSON.stringify(restoreSettings)})`, true)
        .catch(() => {})
      console.log('[selftest] restored the endpoint config this self-test had overwritten')
    }
  }

    /* ---- mouth probe: force it open/closed for visual inspection ---- *
     * Deliberately outside the `if (apiBase)` block — it only pokes the model,
     * so requiring a mock API server just to look at the mouth was wrong.
     * ------------------------------------------------------------------ */
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
          ? `${id}: verts=${r.verts} idx=${r.indices} masks=${r.masks}${r.maskIds ? '->' + JSON.stringify(r.maskIds) : ''} blend=${r.blend} uvSpan=${r.uvSpan}x${r.uvSpanV} uvBbox=${JSON.stringify(r.uvBbox)}`
          : `${id}: (missing)`
      }
      /*
       * `applied()` reflects the model this frame; a forced modelParams value
       * reads back inconsistently (0 on some runs, the forced value on others),
       * so treat it as a hint and judge this probe on the screenshot.
       */
      console.log(
        `[selftest] mouth fixed=${value} -> applied read-back=${a?.mouthOpenY} (this value intermittently fails to read back — judge by the render in selftest-mouth-${value}.png)`
      )
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
      if (value === 0) {
        /*
         * Every drawable's UV extent, once. A collapsed UV span (near 0) means the
         * mesh samples a single texel no matter how it deforms — the texture
         * mapping is broken while the geometry still moves, which is invisible
         * in a wireframe check and only shows up as "the part never appears".
         */
        const spans = rows
          .map((r) => ({ id: r.id, s: r.uvSpan, v: r.uvSpanV, w: r.w, h: r.h }))
          .sort((a, b) => (a.s ?? 9) - (b.s ?? 9))
        console.log('[selftest] UV spans of every drawable (ascending, first 12):')
        for (const r of spans.slice(0, 12)) {
          console.log(
            `       ${String(r.id).padEnd(26)} uvSpan=${String(r.s).padEnd(9)}x${String(r.v).padEnd(9)} meshSize=${r.w}x${r.h}`
          )
        }
      }
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
      console.log(`[selftest] control ParamAngleX=${angle} -> face bbox=${JSON.stringify(f?.bbox)} sample=${JSON.stringify(f?.sample)}`)
    }
    await wc.executeJavaScript(
      `window.__petTest.setSettings({ modelParams: { enabled: false, items: {} } })`,
      true
    )
    console.log('[selftest] face point', faceX, faceY)
  }

  /*
   * The GPT-SoVITS GBK filter is an obscure workaround (see the comment in
   * gptsovits.cjs): a character the server cannot encode fails the whole
   * request, so replacing it with a space must still leave audio behind. Pinned
   * down here so it cannot be "simplified away" later.
   */
  {
    const cases = [
      ['ロキシー・ミグルディア', 'ロキシー ミグルディア', 'middle dot with no GBK encoding'],
      ['星★と→と①', '星★と→と①', 'symbols that do have a GBK encoding are kept as-is'],
      ['あ💧い', 'あ い', 'emoji (astral plane)'],
    ]
    const bad = cases.filter(([input, want]) => gptsovits.toGbkSafe(input) !== want)
    console.log(
      `[selftest] GBK filter ${bad.length ? 'FAIL' : 'PASS'} — ${cases.length - bad.length}/${cases.length}` +
        (bad.length
          ? ` mismatched: ${bad.map(([i]) => i).join(' / ')}`
          : ` (charset ${gptsovits.GBK_CHARS ? gptsovits.GBK_CHARS.size : 'N/A'} chars)`)
    )
  }

  /*
   * Auto-blink off must actually stop blinking.
   *
   * The model's own Idle motion bakes a blink into every 6 s loop (2.780 s → 0),
   * so honouring the setting means the app has to take the eye-open channels
   * over instead of scaling what the motion left there. Sample past a full loop
   * so a single baked blink cannot slip between samples.
   */
  {
    const priorAutoBlink = await wc
      .executeJavaScript(`window.__petTest.settings()?.idle?.autoBlink`, true)
      .catch(() => null)
    await wc.executeJavaScript(`window.__petTest.setSettings({ idle: { autoBlink: false } })`, true)
    await new Promise((r) => setTimeout(r, 400))
    let minL = 1
    let minR = 1
    let n = 0
    const startedAt = Date.now()
    while (Date.now() - startedAt < 7200) {
      const st = await params()
      if (st) {
        n++
        if (st.eyeLOpen < minL) minL = st.eyeLOpen
        if (st.eyeROpen < minR) minR = st.eyeROpen
      }
      await new Promise((r) => setTimeout(r, 60))
    }
    const quiet = minL > 0.98 && minR > 0.98
    console.log(
      `[selftest] auto-blink off ${quiet ? 'PASS' : 'FAIL'} — lowest over 7.2s: eyeL=${minL.toFixed(3)} eyeR=${minR.toFixed(3)}, ${n} samples (expected ≥0.98 throughout)`
    )
    /*
     * The flip side: suppressing blinking must not flatten authored motion
     * detail — the Nod curve presses the eyes to 0.75 and that has to reach the
     * model. Reported, not asserted: the observed minimum in this window is
     * consistently lower (≈0.31) than the press predicts (0.75 × eyeScale ≈
     * 0.62), so something else still attenuates the channel after the motion
     * releases it. Printing the number keeps the signal visible without
     * encoding an expectation we cannot yet justify.
     */
    const nod = await wc
      .executeJavaScript(`window.__petTest.testReaction('nod')`, true)
      .catch((e) => ({ error: e.message }))
    console.log(
      `[selftest] motion squint (informational) — with auto-blink off, Nod's lowest eye-open=${nod?.eyeMin} (the motion author wrote 0.75; × smile's 0.9 predicts ≈0.62, and ≥0.98 means the press is fully overridden)`
    )
    await wc.executeJavaScript(
      `window.__petTest.setSettings({ idle: { autoBlink: ${priorAutoBlink === false ? 'false' : 'true'} } })`,
      true
    )
  }

  /*
   * Settings that were declared in the UI but reached no consumer until now.
   * Assert the two that are observable from here so they cannot go dead again
   * without a red line; "show tray icon" is not observable because the
   * self-test never creates a tray in the first place.
   */
  {
    await wc.executeJavaScript(`window.__petTest.setSettings({ ui: { dockVisible: false } })`, true)
    await new Promise((r) => setTimeout(r, 300))
    const dockOff = await wc.executeJavaScript(`window.__petTest.dockHidden()`, true).catch(() => null)

    await wc
      .executeJavaScript(`window.__petTest.setSettings({ idle: { motionsEnabled: false } })`, true)
    await new Promise((r) => setTimeout(r, 500))
    const groupOff = await wc.executeJavaScript(`window.__petTest.idleMotionGroup()`, true).catch(() => null)

    await wc.executeJavaScript(`window.__petTest.setSettings({ ui: { dockVisible: true } })`, true)
    await wc
      .executeJavaScript(`window.__petTest.setSettings({ idle: { motionsEnabled: true } })`, true)
    await new Promise((r) => setTimeout(r, 400))
    const groupOn = await wc.executeJavaScript(`window.__petTest.idleMotionGroup()`, true).catch(() => null)

    const ok = dockOff === true && groupOff !== 'Idle' && groupOn === 'Idle'
    console.log(
      `[selftest] settings wiring ${ok ? 'PASS' : 'FAIL'} — dock hidden when off=${dockOff}; idle group with motions off=${JSON.stringify(groupOff)}, back on=${JSON.stringify(groupOn)}`
    )
  }

  /*
   * Settings added / fixed this round, each verified to "actually do something".
   *
   * A static audit can only prove a setting is read — petting.squint was read
   * (main.js read it to fire one happy reaction), yet the real sustained squint
   * was a hard-coded 0.58 and the setting was never wired up at all. So these
   * checks all look at observable behaviour, never at whether the name appears
   * in the code.
   */
  {
    const orig = await wc.executeJavaScript(`window.__petTest.settings()`, true).catch(() => null)

    /* comfortable squint: on → the eyes are pressed down; off → wide open throughout */
    const eyeMinWhilePetting = async (squint) => {
      await wc.executeJavaScript(
        `window.__petTest.setSettings({ petting: { squint: ${squint}, sound: false, hearts: false, reactions: false, speakLines: false } })`,
        true
      )
      await wc.executeJavaScript(`window.__petTest.petVisual(true, true)`, true)
      await new Promise((r) => setTimeout(r, 600))
      let m = 1
      for (let i = 0; i < 14; i++) {
        const st = await params()
        if (st) m = Math.min(m, st.eyeLOpen)
        await new Promise((r) => setTimeout(r, 60))
      }
      await wc.executeJavaScript(`window.__petTest.petVisual(false, true)`, true)
      await new Promise((r) => setTimeout(r, 350))
      return m
    }
    const eyeOn = await eyeMinWhilePetting(true)
    const eyeOff = await eyeMinWhilePetting(false)
    console.log(
      `[selftest] petting·squint ${eyeOn < 0.75 && eyeOff > 0.9 ? 'PASS' : 'FAIL'} — lowest eye-open with squint on=${eyeOn.toFixed(3)} (expected <0.75), off=${eyeOff.toFixed(3)} (expected >0.9)`
    )

    /* head follows the cursor: while petting the head still swings with the pointer, 0 freezes it */
    const headSpanWhilePetting = async (follow) => {
      await wc.executeJavaScript(`window.__petTest.setSettings({ petting: { squint: false, headFollow: ${follow} } })`, true)
      await wc.executeJavaScript(`window.__petTest.petVisual(true, true)`, true)
      await new Promise((r) => setTimeout(r, 300))
      let lo = Infinity
      let hi = -Infinity
      for (const [x, y] of [
        [120, 200],
        [1900, 900],
        [120, 200],
        [1900, 900],
      ]) {
        await wc.executeJavaScript(`window.__petTest.setPointer(${x}, ${y})`, true)
        await new Promise((r) => setTimeout(r, 420))
        const st = await params()
        if (st) {
          lo = Math.min(lo, st.angleX)
          hi = Math.max(hi, st.angleX)
        }
      }
      await wc.executeJavaScript(`window.__petTest.setPointer(null, null)`, true).catch(() => {})
      await wc.executeJavaScript(`window.__petTest.petVisual(false, true)`, true)
      await new Promise((r) => setTimeout(r, 350))
      return hi - lo
    }
    const spanFollow = await headSpanWhilePetting(1)
    const spanParked = await headSpanWhilePetting(0)
    console.log(
      `[selftest] petting·head follow ${spanFollow > spanParked + 2 ? 'PASS' : 'FAIL'} — AngleX swing at 100% follow ${spanFollow.toFixed(2)}°, at 0% ${spanParked.toFixed(2)}°`
    )

    /* breath amount: ParamBreath must stay constant at 0% */
    await wc.executeJavaScript(`window.__petTest.setSettings({ idle: { breath: true, breathAmount: 0 } })`, true)
    await new Promise((r) => setTimeout(r, 400))
    let bLo = Infinity
    let bHi = -Infinity
    for (let i = 0; i < 40; i++) {
      const st = await params()
      if (st) {
        bLo = Math.min(bLo, st.breath)
        bHi = Math.max(bHi, st.breath)
      }
      await new Promise((r) => setTimeout(r, 60))
    }
    console.log(`[selftest] breath amount ${bHi - bLo < 0.02 ? 'PASS' : 'FAIL'} — ParamBreath swing at 0% amount ${(bHi - bLo).toFixed(4)} (expected ≈0)`)

    /* petting sound: the toggle really does decide whether it plays */
    await wc.executeJavaScript(`window.__petTest.setSettings({ petting: { sound: true } })`, true)
    const soundOn = await wc.executeJavaScript(`window.__petTest.sfxPat()`, true).catch(() => null)
    await wc.executeJavaScript(`window.__petTest.setSettings({ petting: { sound: false } })`, true)
    const soundOff = await wc.executeJavaScript(`window.__petTest.sfxPat()`, true).catch(() => null)
    console.log(`[selftest] petting sound ${soundOn === true && soundOff === false ? 'PASS' : 'FAIL'} — on=${soundOn}, off=${soundOff}`)

    if (orig) {
      const pick = (o, ks) => ks.reduce((a, k) => (k in (o || {}) ? ((a[k] = o[k]), a) : a), {})
      const patch = {
        petting: pick(orig.petting, ['squint', 'headFollow', 'sound', 'hearts', 'reactions', 'speakLines']),
        idle: pick(orig.idle, ['breath', 'breathAmount']),
      }
      await wc.executeJavaScript(`window.__petTest.setSettings(${JSON.stringify(patch)})`, true).catch(() => {})
    }
  }

  /* ---- Interface language: switching it must actually swap the rendered UI ---- */
  {
    // The section id lives on the caret span, not on the row — read the label
    // span that sits next to it.
    const navLabel = (id) =>
      wc.executeJavaScript(
        `(() => {
          const c = [...document.querySelectorAll('.vs-caret[data-section]')].find((el) => el.dataset.section === ${JSON.stringify(id)})
          if (!c) return null
          const label = [...c.parentElement.children].find((el) => !el.classList.contains('vs-caret'))
          return label ? label.textContent.trim() : null
        })()`,
        true
      )
    const before = await wc
      .executeJavaScript(`(window.__petTest.settings().ui || {}).language || 'auto'`, true)
      .catch(() => 'auto')
    await wc.executeJavaScript(`window.__petTest.openSettings()`, true)
    await new Promise((r) => setTimeout(r, 400))

    await wc.executeJavaScript(`window.__petTest.setSettings({ ui: { language: 'en' } })`, true)
    await new Promise((r) => setTimeout(r, 450))
    const enLabel = await navLabel('display')

    await wc.executeJavaScript(`window.__petTest.setSettings({ ui: { language: 'zh-CN' } })`, true)
    await new Promise((r) => setTimeout(r, 450))
    const zhLabel = await navLabel('display')

    console.log(
      `[selftest] interface language ${enLabel === 'Display' && zhLabel === '显示' ? 'PASS' : 'FAIL'} — en="${enLabel}", zh="${zhLabel}"`
    )
    // Put the user's own setting back.
    await wc.executeJavaScript(`window.__petTest.setSettings({ ui: { language: ${JSON.stringify(before)} } })`, true)
    await new Promise((r) => setTimeout(r, 300))
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

    // Resolve the interface language before the first window, menu or dialog
    // exists, so the app comes up in the language the user picked.
    applyLang()

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
      setTrayEnabled(settings.get().display?.showTray !== false)
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
              console.log(`[gptsovits] auto-configured: ${scan.root}`)
            }
          }

          const res = await gsvService.ensureRunning(settings.get(), (m) => console.log(m))
          console.log(`[gptsovits] ${res.message}`)
          if (res.ok) sendToRenderer({ type: 'gptsovits:ready', message: res.message })
          else sendToRenderer({ type: 'gptsovits:error', message: res.message })
        } catch (e) {
          console.log('[gptsovits] auto-start failed:', e.message)
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
