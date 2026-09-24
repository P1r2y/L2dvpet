/**
 * Renderer entry point — builds the app, wires every subsystem together and
 * owns the high-level petting experience (hearts + dialogue).
 */
import { $, clamp, pick, rand } from './core/util.js'
import { bus } from './core/bus.js'
import { Pet } from './pet.js'
import { InteractionManager } from './features/interaction.js'
import { VoiceService } from './features/voice.js'
import { ChatService } from './features/chat.js'
import { EffectsLayer } from './features/fx.js'
import { SfxService } from './features/sfx.js'
import { PARAM_CATALOG } from './live2d/params.js'
import { SpeechBubble } from './ui/bubble.js'
import { setLang, t } from './core/i18n.js'
import { ChatPanel } from './ui/chatPanel.js'
import { SettingsPanel } from './ui/settings/panel.js'
import { QuickDock } from './ui/dock.js'
import { ContextMenu } from './ui/contextMenu.js'
import { toast, toastErr, toastOk } from './ui/notify.js'

const bridge = window.pet

/** ParamId → key in `pet.applied`, used by the automation hook. */
const APPLIED_KEY = {
  ParamAngleX: 'angleX',
  ParamAngleY: 'angleY',
  ParamAngleZ: 'angleZ',
  ParamBodyAngleX: 'bodyX',
  ParamBodyAngleY: 'bodyY',
  ParamBodyAngleZ: 'bodyZ',
  ParamEyeLOpen: 'eyeLOpen',
  ParamEyeROpen: 'eyeROpen',
  ParamEyeBallX: 'eyeBallX',
  ParamEyeBallY: 'eyeBallY',
  ParamEyeBallForm: 'eyeBallForm',
  ParamBrowLY: 'browLY',
  ParamBrowRY: 'browRY',
  ParamMouthForm: 'mouthForm',
  ParamMouthOpenY: 'mouthOpenY',
  ParamBreath: 'breath',
  ParamHairFront: 'hairFront',
  ParamHairBack: 'hairBack',
}

/* ---------------------------------------------------------------- *
 * Application state
 * ---------------------------------------------------------------- */
const app = {
  settings: null,
  state: null,
  pet: null,
  voice: null,
  chat: null,
  fx: null,
  bubble: null,
  chatPanel: null,
  settingsPanel: null,
  dock: null,
  menu: null,
  interaction: null,
  dockHideTimer: null,
  statusEl: null,
  lastPetAt: 0,
  overrideClickThrough: false,
}

/* ---------------------------------------------------------------- *
 * Boot
 * ---------------------------------------------------------------- */
async function boot() {
  const loading = $('#loading')
  const loadingText = $('#loading-text')
  const loadingSub = $('#loading-sub')
  const setProgress = (msg, sub = '') => {
    loadingText.textContent = msg
    loadingSub.textContent = sub
  }

  try {
    setProgress(t('Reading settings…'))
    const [settings, state, defaults] = await Promise.all([
      bridge.settings.get(),
      bridge.state.get(),
      bridge.settings.defaults ? bridge.settings.defaults() : Promise.resolve(null),
    ])
    app.settings = settings
    app.state = state
    app.defaults = defaults

    applyTheme()

    const pet = new Pet()
    app.pet = pet
    pet.pos = { x: state.petPos?.x ?? 0.8, y: state.petPos?.y ?? 1.0 }

    try {
      await pet.load({
        canvas: $('#stage'),
        layer: $('#pet-layer'),
        fxLayer: $('#fx-layer'),
        modelUrl: new URL(`../${settings.model.path}`, location.href).href,
        onProgress: setProgress,
      })
    } catch (err) {
      // The model is a bring-your-own asset that the repo does not ship, so "no model /
      // wrong path" is the most common first-run state. The raw error (usually a bare
      // fetch failure) is swapped for a message the user can act on.
      const p = String(settings.model.path || '').trim()
      throw new Error(
        p
          ? t('Failed to load the Live2D model: {path} ({error}). Point Settings → Display → Model path at an existing .model3.json.', {
              path: p,
              error: err?.message || err,
            })
          : t('No Live2D model is set yet. Fill in the path to your own .model3.json under Settings → Display → Model path.')
      )
    }

    setProgress(t('Ready'))
    pet.applySettings(app.settings)

    /* controllers ---------------------------------------------------- */
    app.fx = new EffectsLayer($('#fx-layer'))

    app.voice = new VoiceService({
      pet,
      getSettings: () => app.settings,
      getState: () => app.state,
      patchState: (partial) => saveState(partial),
    })
    app.sfx = new SfxService({ getSettings: () => app.settings })
    app.chat = new ChatService({ getSettings: () => app.settings, state: app.state, voice: app.voice }).attach()

    app.bubble = new SpeechBubble({
      pet,
      el: $('#bubble'),
      textEl: $('#bubble-text'),
      actionsEl: $('#bubble-actions'),
      getSettings: () => app.settings,
    })
    app.bubble.onAction = (action) => {
      if (action === 'close') app.bubble.hide()
      else if (action === 'speak') app.voice.speak(app.bubble.text, { force: true })
    }

    app.dock = new QuickDock({ el: $('#dock'), pet })
    app.dock.setEnabled(app.settings?.ui?.dockVisible !== false)
    app.menu = new ContextMenu($('#ctx-menu'))

    app.chatPanel = new ChatPanel({
      pet,
      chat: app.chat,
      voice: app.voice,
      getSettings: () => app.settings,
      onStateChange: (patch) => {
        if (patch) saveState(patch)
        return app.state
      },
    })
    app.chatPanel.renderHistory(app.state.chatHistory)

    // Interface language, applied before anything renders so the dock, the
    // menus and the settings panel all start out in the same language.
    setLang(app.settings.ui?.language)

    app.settingsPanel = new SettingsPanel({
      getSettings: () => app.settings,
      patchSettings: (partial) => patchSettings(partial),
      app,
      chat: app.chat,
      voice: app.voice,
      getParamRanges: () => app.pet?.paramRanges || {},
      /** Live parameter tracing — only runs while the Model parameters section is open. */
      setTrace: (on) => {
        app.pet.setTracing(on)
        app.pet._captureApplied = !!on
      },
      getTrace: (id) => app.pet.getTrace(id),
      onStateChange: (patch) => {
        if (patch) saveState(patch)
        return app.state
      },
    })

    app.interaction = new InteractionManager({
      pet,
      getSettings: () => app.settings,
    }).attach()

    wireDock()
    wireBus()
    wireMainCommands()
    wireLifecycle()

    pet.start()
    updateDockSpeakIcon()

    // The Live2D canvas is much larger than the character; measure the real
    // silhouette so the bubble and dock hug her instead of the canvas.
    pet.measure({ delayFrames: 40 }).then((content) => {
      if (!content) {
        console.warn('[app] silhouette measurement failed — using canvas bounds')
        return
      }
      app.bubble.layout()
      app.interaction?.refresh()
    })

    loading.classList.add('done')
    setTimeout(() => loading.classList.add('hidden'), 600)

    // Startup greeting
    if (app.settings.chat.autoGreeting) {
      setTimeout(() => {
        const greet = app.settings.chat.greeting || t('Hi there~')
        app.bubble.show(greet, { actions: true, duration: 12 })
        app.pet.setEmotion('happy', 4000)
        if (app.settings.voice.ttsEnabled && app.settings.voice.autoSpeak) {
          // Wait for a cold GPT-SoVITS to finish loading, so the first line of
          // the session uses her real voice instead of the fallback.
          app.voice.speakWhenReady(greet)
        }
      }, 900)
    }

    // Diagnostics surfaced for the --selftest harness and devtools inspection.
    // A function so every field reflects the live state at call time.
    window.__petDiag = () => ({
      ok: true,
      modelPath: app.settings.model.path,
      nativeSize: { w: Math.round(pet.stage.baseWidth), h: Math.round(pet.stage.baseHeight) },
      layerSize: { w: Math.round(pet.stage.layerWidth), h: Math.round(pet.stage.layerHeight) },
      silhouette: pet.stage.content
        ? {
            x0: +pet.stage.content.x0.toFixed(3),
            y0: +pet.stage.content.y0.toFixed(3),
            x1: +pet.stage.content.x1.toFixed(3),
            y1: +pet.stage.content.y1.toFixed(3),
          }
        : null,
      motionGroups: pet.stage.getUsableMotionGroups(),
      petPos: { ...pet.pos },
      modelBounds: pet.getModelBounds(),
      headAnchor: pet.getHeadAnchor(),
      fps: pet.fps,
      emotion: pet.emotion.current,
      gaze: { ...pet.gaze.output },
      hasCore: !!pet.stage.coreModel,
      webgl: (() => {
        try {
          const gl = pet.stage.app.renderer.gl
          const dbg = gl.getExtension('WEBGL_debug_renderer_info')
          return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
        } catch {
          return 'unknown'
        }
      })(),
      settings: {
        gazeEnabled: app.settings.gaze.enabled,
        gazeIntensity: app.settings.gaze.intensity,
        fps: app.settings.display.fps,
      },
    })
    bridge.win.selfTestReady?.()

    // Automation hook, only present when launched with --selftest.
    const info = await bridge.app.info().catch(() => null)
    if (info?.selftest) {
      window.__petTest = {
        diag: () => window.__petDiag(),
        settings: () => app.settings,
        /** Enables the per-frame parameter read-back used by the self-test. */
        setCapture: (on) => {
          app.pet._captureApplied = !!on
        },
        setSettings: async (partial) => {
          app.settings = await bridge.settings.patch(partial)
          setLang(app.settings.ui?.language)
          app.pet.applySettings(app.settings)
          applyTheme()
          updateDockSpeakIcon()
          /*
           * A real change goes through the panel, which emits one
           * settings:changed per touched key — anything that reacts on the bus
           * (the dock, the theme, the interaction layer) only updates because of
           * it. Announce the same way here, or this shortcut drives a path the
           * app never uses and quietly skips half the reaction.
           */
          for (const section of Object.keys(partial || {})) {
            for (const key of Object.keys(partial[section] || {})) {
              bus.emit('settings:changed', { path: `${section}.${key}` })
            }
          }
          return app.settings
        },
        chat: (text) => app.chat.send(text),
        speak: (text) => app.voice.speak(text, { force: true }),
        stopSpeech: () => app.voice.stop(),
        bubble: (text) => app.bubble.show(text, { duration: 0, keep: true }),
        react: (kind) => app.pet.react(kind),
        openChat: () => app.chatPanel.open(),
        openSettings: () => app.settingsPanel.open(),
        /** Drives the gaze pointer directly (synthetic mouse moves are unreliable here). */
        setPointer: (x, y) => {
          app.pet.setPointer(x ?? null, y ?? null)
        },
        /** Fires one pat sound; the boolean says whether one actually played. */
        sfxPat: (strength = 0.6) => !!app.sfx?.pat(strength, { minGapMs: 0 }),
        /** Simulates the petting state without a real mouse drag. */
        petVisual: (on, head = true) => app.pet.setPettingVisual(!!on, { head: !!head }),
        /** Which group the library will auto-play next — the Play motions switch. */
        idleMotionGroup: () => app.pet.stage?.model?.internalModel?.motionManager?.groups?.idle ?? null,
        /** Whether the quick dock is currently suppressed. */
        dockHidden: () => !!document.getElementById('dock')?.classList.contains('hidden'),
        /**
         * The speech bubble's on-screen rect, plus which way it flipped. Exposed
         * because a bad anchor silently degrades into `left: NaNpx`, which CSS
         * drops — the bubble then stays wherever it was last painted, which is
         * only visible on a screenshot.
         */
        bubbleRect: () => {
          const el = document.getElementById('bubble')
          if (!el || el.classList.contains('hidden')) return null
          const r = el.getBoundingClientRect()
          return {
            left: Math.round(r.left),
            top: Math.round(r.top),
            right: Math.round(r.right),
            bottom: Math.round(r.bottom),
            width: Math.round(r.width),
            height: Math.round(r.height),
            tailRight: el.classList.contains('tail-right'),
            below: el.classList.contains('below'),
            winW: window.innerWidth,
            winH: window.innerHeight,
          }
        },
        /** Reads live values straight out of the Cubism model. */
        params: () => {
          const core = app.pet.stage.coreModel
          if (!core) return null
          const read = (id) => {
            try {
              return core.getParameterValueById(id)
            } catch {
              return null
            }
          }
          return {
            mouthOpenY: read('ParamMouthOpenY'),
            mouthForm: read('ParamMouthForm'),
            eyeBallX: read('ParamEyeBallX'),
            eyeBallY: read('ParamEyeBallY'),
            eyeLOpen: read('ParamEyeLOpen'),
            angleX: read('ParamAngleX'),
            angleY: read('ParamAngleY'),
            angleZ: read('ParamAngleZ'),
            bodyX: read('ParamBodyAngleX'),
            breath: read('ParamBreath'),
          }
        },
        /**
         * Parameters exactly as the model received them this frame. This is the
         * meaningful check: loadParameters() reverts them immediately after
         * model.update(), so post-frame reads only show motion values.
         */
        applied: () => app.pet.applied,
        /** The gaze target the pet is currently using (null when it has none). */
        pointer: () => app.pet.pointer,

        /** Lists every drawable with opacity / visibility / render order / bounds. */
        dumpDrawables: () => {
          const core = app.pet.stage?.coreModel
          if (!core) return { error: 'no coreModel' }
          const out = []
          let count = 0
          try {
            count = core.getDrawableCount()
          } catch (e) {
            return { error: 'getDrawableCount: ' + e.message }
          }
          let orders = null
          try {
            orders = core.getDrawableRenderOrders ? core.getDrawableRenderOrders() : null
          } catch {
            orders = null
          }
          const bounds = new Float32Array(4)
          for (let i = 0; i < count; i++) {
            const row = { i }
            try {
              row.id = core.getDrawableId(i)
            } catch {
              row.id = '#' + i
            }
            try {
              row.opacity = Number(core.getDrawableOpacity(i).toFixed(3))
            } catch {
              row.opacity = null
            }
            try {
              row.visible = !!core.getDrawableDynamicFlagIsVisible(i)
            } catch {
              row.visible = null
            }
            try {
              row.order = orders ? orders[i] : null
            } catch {
              row.order = null
            }
            try {
              // getDrawableVertices returns [x0,y0,x1,y1,…] in model space.
              const v = core.getDrawableVertices(i)
              let minX = Infinity
              let minY = Infinity
              let maxX = -Infinity
              let maxY = -Infinity
              for (let k = 0; k < v.length; k += 2) {
                if (v[k] < minX) minX = v[k]
                if (v[k] > maxX) maxX = v[k]
                if (v[k + 1] < minY) minY = v[k + 1]
                if (v[k + 1] > maxY) maxY = v[k + 1]
              }
              row.bbox = [minX, minY, maxX, maxY]
              row.w = Number((maxX - minX).toFixed(1))
              row.h = Number((maxY - minY).toFixed(1))
              row.verts = v.length / 2
              row.sample = [v[0], v[1], v[2], v[3], v[4], v[5]].map((n) => Number(n.toFixed(3)))
              try {
                row.indices = core.getDrawableVertexIndexCount(i)
              } catch {
                row.indices = null
              }
              try {
                row.texture = core.getDrawableTextureIndices(i)[0]
              } catch {
                row.texture = null
              }
              try {
                const uv = core.getDrawableVertexUvs(i)
                row.uv = [uv[0], uv[1], uv[2], uv[3]].map((n) => Number(n.toFixed(3)))
              } catch {
                row.uv = null
              }
              try {
                /*
                 * Full UV extent. The first two vertices' UVs (above) say nothing
                 * about whether a drawable's texture mapping is intact — a mesh
                 * whose UVs have all collapsed onto one texel still reports two
                 * identical corner UVs, which is exactly how the mouth drawable
                 * hides: it samples skin instead of the mouth line.
                 */
                const uvs = core.getDrawableVertexUvs(i)
                let u0 = Infinity
                let v0 = Infinity
                let u1 = -Infinity
                let v1 = -Infinity
                for (let k = 0; k < uvs.length; k += 2) {
                  if (uvs[k] < u0) u0 = uvs[k]
                  if (uvs[k] > u1) u1 = uvs[k]
                  if (uvs[k + 1] < v0) v0 = uvs[k + 1]
                  if (uvs[k + 1] > v1) v1 = uvs[k + 1]
                }
                row.uvBbox = [u0, v0, u1, v1].map((n) => Number(n.toFixed(5)))
                row.uvSpan = Number((u1 - u0).toFixed(5))
                row.uvSpanV = Number((v1 - v0).toFixed(5))
              } catch {
                row.uvBbox = null
              }
              try {
                const mc = core.getDrawableMaskCounts()[i]
                row.masks = mc
                if (mc > 0) {
                  const ids = core.getDrawableMasks()
                  const off = i * mc
                  row.maskIds = []
                  for (let k = 0; k < mc; k++) row.maskIds.push(ids[off + k])
                }
              } catch {
                row.masks = null
              }
              try {
                row.blend = core.getDrawableBlendMode ? core.getDrawableBlendMode(i) : null
              } catch {
                row.blend = null
              }
            } catch {
              row.bbox = null
            }
            out.push(row)
          }
          return { count, drawables: out }
        },
        /** Parameter ranges psd2live baked into this model. */
        paramRanges: () => app.pet.paramRanges || {},
        /**
         * Synthetic `sendInputEvent` moves do not move the real OS cursor, so
         * the authoritative cursor feed must be paused for gaze assertions.
         */
        /**
         * Synthetic `sendInputEvent` moves do not move the real OS cursor, and
         * their coordinates are not dependable, so gaze assertions set the target
         * directly instead. The DOM → gaze path is covered by the petting test.
         */
        setGlobalPointer: (on) => app.interaction?.setGlobalPointerEnabled(on),
        setGazeTarget: (x, y) => {
          app.pet.setPointer(x, y)
          return app.pet.pointer
        },

        /**
         * Locks a setting, applies a preset that would normally change it, and
         * reports whether the value survived — i.e. that locks really gate presets.
         */
        testLock: async (path = 'voice.pitchShift') => {
          const panel = app.settingsPanel
          const read = () => {
            const parts = path.split('.')
            return parts.reduce((o, k) => (o == null ? undefined : o[k]), app.settings)
          }
          const original = read()
          const probeValue = original === 1.5 ? 1.0 : 1.5
          const probe = { id: '__probe__', label: 'probe', patch: { voice: { pitchShift: probeValue } } }
          panel.presets.push(probe)
          const found = !!panel.presets.find((p) => p.id === '__probe__')

          const trace = []
          await panel._toggleLock(path)
          const locked = panel.isLocked(path)
          trace.push(`locked=${locked} locks=${JSON.stringify(app.settings.locks)}`)
          await panel.applyPresetById('__probe__')
          const afterLocked = read()
          trace.push(`afterLockedPreset=${afterLocked}`)

          await panel._toggleLock(path)
          const unlockedAfter = panel.isLocked(path)
          trace.push(`unlocked=${!unlockedAfter} locks=${JSON.stringify(app.settings.locks)}`)
          await panel.applyPresetById('__probe__')
          const afterUnlocked = read()
          trace.push(`afterUnlockedPreset=${afterUnlocked}`)

          panel.presets.pop()
          await bridge.settings.patch({ voice: { pitchShift: original } })
          app.settings = await bridge.settings.get()

          return {
            path,
            original,
            probeValue,
            found,
            trace,
            lockHeld: afterLocked === original,
            unlockApplied: afterUnlocked === probeValue,
          }
        },

        /**
         * Plays a reaction motion and samples the *applied* parameters while it
         * runs. psd2live authors `Nod` as ParamAngleY → −18° and `Shake` as
         * ParamAngleX → −20/+20°; if the gaze overwrote those, the excursion
         * here would collapse to a fraction of a degree.
         */
        testReaction: async (motion = 'nod', ms = 3000) => {
          const want = { nod: { id: 'angleY', min: -18 }, shake: { id: 'angleX', neg: -20, pos: 20 } }
          app.pet._captureApplied = true
          // Park the cursor so the gaze contributes only a small, known offset,
          // and make sure no previous motion is still fading out.
          app.pet.setPointer(null, null)
          app.pet.stage.stopAllMotions()
          await new Promise((r) => setTimeout(r, 500))

          const before = { ...(app.pet.applied || {}) }
          app.pet.react(motion)
          let min = Infinity
          let max = -Infinity
          let eyeMin = Infinity
          let jellyMin = Infinity
          let jellyMax = -Infinity
          const t0 = Date.now()
          while (Date.now() - t0 < ms) {
            const a = app.pet.applied
            if (a) {
              const v = a[want[motion]?.id || 'angleY']
              if (typeof v === 'number') {
                min = Math.min(min, v)
                max = Math.max(max, v)
              }
              if (typeof a.eyeLOpen === 'number') eyeMin = Math.min(eyeMin, a.eyeLOpen)
              if (typeof a.eyeBallForm === 'number') {
                jellyMin = Math.min(jellyMin, a.eyeBallForm)
                jellyMax = Math.max(jellyMax, a.eyeBallForm)
              }
            }
            await new Promise((r) => setTimeout(r, 16))
          }
          return {
            motion,
            before: before[want[motion]?.id || 'angleY'],
            min: +min.toFixed(2),
            max: +max.toFixed(2),
            eyeMin: +eyeMin.toFixed(3),
            jellyMin: +jellyMin.toFixed(4),
            jellyMax: +jellyMax.toFixed(4),
          }
        },
        /** Posts a synthetic WAV straight to the STT endpoint (no mic needed). */
        testSttSynthetic: async () => {
          const rate = 16000
          const n = rate
          const buf = new ArrayBuffer(44 + n * 2)
          const dv = new DataView(buf)
          const put = (off, str) => {
            for (let i = 0; i < str.length; i++) dv.setUint8(off + i, str.charCodeAt(i))
          }
          put(0, 'RIFF')
          dv.setUint32(4, 36 + n * 2, true)
          put(8, 'WAVE')
          put(12, 'fmt ')
          dv.setUint32(16, 16, true)
          dv.setUint16(20, 1, true)
          dv.setUint16(22, 1, true)
          dv.setUint32(24, rate, true)
          dv.setUint32(28, rate * 2, true)
          dv.setUint16(32, 2, true)
          dv.setUint16(34, 16, true)
          put(36, 'data')
          dv.setUint32(40, n * 2, true)
          for (let i = 0; i < n; i++) {
            dv.setInt16(44 + i * 2, Math.round(Math.sin((i / rate) * 2 * Math.PI * 220) * 9000), true)
          }
          const bytes = new Uint8Array(buf)
          let bin = ''
          for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
          return bridge.stt.transcribe({ base64: btoa(bin), mime: 'audio/wav', language: 'zh' })
        },
        /** Full microphone path: getUserMedia → MediaRecorder → upload. */
        testSttRecord: async (ms = 2000) => {
          const started = await app.voice.startRecording()
          if (!started) return { ok: false, message: 'startRecording failed' }
          await new Promise((r) => setTimeout(r, ms))
          const text = await app.voice.stopRecording()
          return { ok: !!text, text }
        },
        /**
         * Synthesizes the same sentence at several pitch settings and reports
         * source duration + playbackRate, proving the pitch shift is real.
         * Goes through the real settings pipeline — the engine is chosen in the
         * main process, so a renderer-local override would not be honoured.
         */
        testPitch: async (provider = 'auto') => {
          const original = {
            ttsProvider: app.settings.voice.ttsProvider,
            pitchShift: app.settings.voice.pitchShift,
          }
          const out = []
          try {
            for (const pitch of [0.8, 1.0, 1.3]) {
              app.settings = await bridge.settings.patch({
                voice: { ttsProvider: provider, pitchShift: pitch },
              })
              app.pet.applySettings(app.settings)
              app.voice.stop()
              await new Promise((r) => setTimeout(r, 250))

              // Probe the synthesis layer directly so a playback failure can be
              // told apart from a synthesis failure.
              const probe = await bridge.tts
                .speak({ text: 'Testing the voice change — one, two, three, four, five.' })
                .catch((e) => ({ kind: 'throw', message: e.message }))

              const ok = await app.voice.speak('Testing the voice change — one, two, three, four, five.', { force: true })
              for (let i = 0; i < 25 && !(app.voice.audio?.duration > 0); i++) {
                await new Promise((r) => setTimeout(r, 60))
              }
              out.push({
                pitch,
                ok,
                provider: app.voice.debug.provider,
                probeKind: probe?.kind,
                probeProvider: probe?.provider,
                probeRate: probe?.playbackRate,
                probeError: probe?.message ? String(probe.message).slice(0, 120) : '',
                playbackRate: app.voice.audio?.playbackRate,
                preservesPitch: app.voice.audio?.preservesPitch,
                srcDuration: +(app.voice.audio?.duration || 0).toFixed(2),
                lastError: app.voice.debug.lastError,
              })
              await new Promise((r) => setTimeout(r, 400))
            }
          } finally {
            app.settings = await bridge.settings.patch({ voice: original })
            app.pet.applySettings(app.settings)
            app.voice.stop()
          }
          return out
        },
        /**
         * Verifies that auto-mode limits actually clamp the engine's value and
         * that the live-curve buffer fills up.
         */
        testAutoLimits: async () => {
          const id = 'ParamAngleX'
          const rawSettings = app.settings
          const read = async () => {
            await new Promise((r) => setTimeout(r, 350))
            return app.pet.applied?.[APPLIED_KEY[id]]
          }

          // Drive the gaze hard to the right so AngleX sits high, then cap it.
          app.pet.setPointer(2020, 200)
          await new Promise((r) => setTimeout(r, 600))
          app.pet._captureApplied = true
          app.settings = await bridge.settings.patch({
            modelParams: { enabled: true, items: { [id]: { mode: 'auto', min: null, max: null } } },
          })
          app.pet.applySettings(app.settings)
          const raw = await read()

          // Limits must *always* bite, independent of where the live gaze
          // happens to be. The gaze can only reach about ±14° on this model
          // (yawMax), so a max of −40 and a min of +40 are outside its entire
          // range and the clamped value is therefore deterministic. Deriving the
          // limits from the sampled `raw` was wrong: the gaze keeps moving, so a
          // limit set just past one sample is a no-op a moment later.
          const limitHigh = -40
          app.settings = await bridge.settings.patch({
            modelParams: { enabled: true, items: { [id]: { mode: 'auto', min: null, max: limitHigh } } },
          })
          app.pet.applySettings(app.settings)
          const high = await read()

          const limitLow = 40
          app.settings = await bridge.settings.patch({
            modelParams: { enabled: true, items: { [id]: { mode: 'auto', min: limitLow, max: null } } },
          })
          app.pet.applySettings(app.settings)
          const low = await read()

          // Live curve
          app.pet.setTracing(true)
          await new Promise((r) => setTimeout(r, 400))
          const buf = app.pet.getTrace('ParamAngleX')
          const traced = buf ? buf.filter((v) => Number.isFinite(v) && v !== 0).length : 0
          app.pet.setTracing(false)

          app.settings = rawSettings
          app.pet.applySettings(app.settings)
          await bridge.settings.patch({ modelParams: { enabled: false, items: {} } })
          app.settings = await bridge.settings.get()
          app.pet.setPointer(null, null)
          app.pet._captureApplied = false

          return {
            raw,
            high,
            low,
            limitHigh,
            limitLow,
            // The engine value must land exactly on the limit that bit.
            clampedHigh: typeof high === 'number' && Math.abs(high - limitHigh) < 0.02,
            clampedLow: typeof low === 'number' && Math.abs(low - limitLow) < 0.02,
            traced,
          }
        },

        /** Which engines are usable right now. */
        engineStatus: () => app.voice.engineStatus(),

        /**
         * Drives every psd2live parameter (18 of them) to a distinctive value via
         * the manual-override panel and reads each one back from the model, so we
         * can prove all of them are actually writable.
         */
        testAllParams: async () => {
          const ranges = app.pet.paramRanges || {}
          const ids = PARAM_CATALOG.flatMap((g) => g.params.map((p) => p.id))

          // Build a target inside each parameter's real range, away from default.
          const items = {}
          const targets = {}
          for (const id of ids) {
            const r = ranges[id] || { min: -1, max: 1 }
            const lo = Number(r.min)
            const hi = Number(r.max)
            const t = lo >= 0 ? lo + (hi - lo) * 0.25 : lo + (hi - lo) * 0.2
            items[id] = { mode: 'fixed', value: Number(t.toFixed(3)) }
            targets[id] = Number(t.toFixed(3))
          }

          app.settings = await bridge.settings.patch({ modelParams: { enabled: true, items } })
          app.pet.applySettings(app.settings)
          app.pet._captureApplied = true

          // Let a few frames run so the hook writes and we can read back.
          await new Promise((r) => setTimeout(r, 500))
          const applied = app.pet.applied || {}

          const results = []
          for (const id of ids) {
            const want = targets[id]
            const got = applied[APPLIED_KEY[id]]
            results.push({ id, want, got, ok: typeof got === 'number' && Math.abs(got - want) < 0.02 })
          }

          // Restore.
          app.settings = await bridge.settings.patch({ modelParams: { enabled: false, items: {} } })
          app.pet.applySettings(app.settings)
          app.pet._captureApplied = false

          return {
            total: ids.length,
            passed: results.filter((r) => r.ok).length,
            failures: results.filter((r) => !r.ok),
          }
        },

        /**
         * End-to-end GPT-SoVITS check: detect the install, apply the found
         * configuration, speak, and report which engine actually produced audio.
         */
        testGptsovits: async (text = 'Hello, this is a preview of the current voice.') => {
          const scan = await bridge.tts.scanGptsovits({})
          if (!scan?.root) return { ok: false, step: 'scan', message: 'GPT-SoVITS install directory not found' }

          const g = {
            root: scan.root,
            baseUrl: app.settings.voice.gptsovits?.baseUrl || 'http://127.0.0.1:9880',
            mode: 'weights',
            gptWeights: scan.pretrained.gpt || '',
            sovitsWeights: scan.pretrained.sovits || '',
          }
          if (scan.gptWeights.length && scan.sovitsWeights.length) {
            g.mode = 'weights'
            g.gptWeights = scan.gptWeights[0].path
            g.sovitsWeights = scan.sovitsWeights[0].path
          } else if (scan.references.length) {
            // No fine-tuned model → fall back to zero-shot with a reference clip.
            const ref = scan.references[0]
            g.mode = 'audio'
            g.refAudio = ref.path
            if (ref.transcript) {
              g.promptText = ref.transcript
              g.promptLang = /[\u3040-\u30ff]/.test(ref.transcript) ? 'ja' : 'zh'
            }
          }

          app.settings = await bridge.settings.patch({
            voice: { ttsProvider: 'gptsovits', gptsovits: g, pitchShift: 1.0 },
          })
          app.pet.applySettings(app.settings)

          const status = await app.voice.engineStatus().catch(() => null)
          if (!status?.gptsovitsAvailable) {
            return { ok: false, step: 'probe', message: 'GPT-SoVITS service is not running', root: scan.root, config: g }
          }

          app.voice.stop()
          const started = Date.now()
          const ok = await app.voice.speak(text, { force: true })
          // Wait for the media element to report a duration.
          for (let i = 0; i < 40 && !(app.voice.audio?.duration > 0); i++) {
            await new Promise((r) => setTimeout(r, 100))
          }
          const d = app.voice.debug
          return {
            ok: ok && d.provider === 'gptsovits',
            step: 'speak',
            root: scan.root,
            config: g,
            provider: d.provider,
            duration: +(app.voice.audio?.duration || 0).toFixed(2),
            playbackRate: d.playbackRate,
            elapsed: ((Date.now() - started) / 1000).toFixed(2),
            error: d.lastError,
          }
        },
        outputState: () => ({
          speaking: app.voice.speaking,
          mouth: app.pet.mouthValue,
          emotion: app.pet.emotion.current,
          history: app.chat.history.length,
          lastReply: app.chat.history.filter((m) => m.role === 'assistant').slice(-1)[0]?.content || '',
          bubbleText: app.bubble.text,
          voiceDebug: { ...app.voice.debug },
        }),
      }
      console.log('[app] automation hook ready')
    }
  } catch (err) {
    console.error('[app] boot failed', err)
    loading.classList.remove('done')
    loading.querySelector('.loading-card')?.classList.add('error')
    setProgress(t('Startup failed'), String(err?.message || err))
    toastErr(t('Startup failed: {error}', { error: err?.message || err }), 12000)
  }
}

/* ---------------------------------------------------------------- *
 * Settings plumbing
 * ---------------------------------------------------------------- */
async function patchSettings(partial) {
  const next = await bridge.settings.patch(partial)
  app.settings = next
  // Every settings write goes through here, so this is the one place that has
  // to notice a language change — switching it re-renders the panel in place
  // (via the i18n:changed event) and re-labels anything else that listens.
  setLang(next.ui?.language)
  return next
}

function saveState(partial) {
  app.state = { ...app.state, ...partial }
  bridge.state.patch(partial).catch(() => {})
  return app.state
}

function applyTheme() {
  const ui = app.settings?.ui || {}
  const root = document.documentElement
  if (ui.accent) {
    root.style.setProperty('--accent', ui.accent)
    root.style.setProperty('--accent-soft', `${ui.accent}33`)
    root.style.setProperty('--accent-strong', ui.accent)
  }
  if (ui.fontSize) root.style.setProperty('--fs', `${ui.fontSize}px`)
  if (ui.panelOpacity) {
    const o = clamp(Number(ui.panelOpacity), 0.3, 1)
    /* Same colour as the VS Code editor background (#1e1e1e): only the opacity is adjustable. */
    root.style.setProperty('--panel-bg', `rgba(30, 30, 30, ${o})`)
  }
}

/* ---------------------------------------------------------------- *
 * Dock
 * ---------------------------------------------------------------- */
function wireDock() {
  const dock = app.dock
  dock.on('chat', () => app.chatPanel.toggle())
  dock.on('settings', () => app.settingsPanel.toggle())
  dock.on('mic', () => app.chatPanel.toggleRecord())
  dock.on('hide', () => bridge.win.hide())
  dock.on('speak-toggle', async () => {
    const on = !app.settings.voice.ttsEnabled
    await patchSettings({ voice: { ttsEnabled: on } })
    updateDockSpeakIcon()
    if (!on) app.voice.stop()
    toastOk(on ? t('Voice reading on') : t('Voice reading off'))
  })
}

function updateDockSpeakIcon() {
  app.dock?.setIcon('speak-toggle', app.settings.voice.ttsEnabled ? '🔊' : '🔈')
}

function showDock() {
  if (app.dockHideTimer) {
    clearTimeout(app.dockHideTimer)
    app.dockHideTimer = null
  }
  app.dock.show()
}

function scheduleDockHide(delay = 1200) {
  if (app.dockHideTimer) clearTimeout(app.dockHideTimer)
  app.dockHideTimer = setTimeout(() => {
    if (!app.interaction.overModel && !app.interaction.overUI) app.dock.hide()
  }, delay)
}

/* ---------------------------------------------------------------- *
 * Bus wiring — the heart of the interaction feel
 * ---------------------------------------------------------------- */
function wireBus() {
  /* ---- hover / dock ---- */
  bus.on('input:hover', ({ over }) => {
    if (over) showDock()
    else scheduleDockHide()
  })

  bus.on('ui:panel', ({ panel, open }) => {
    app.interaction?.refresh()
    if (panel === 'chat') app.dock?.setActive('chat', open)
    if (panel === 'settings') app.dock?.setActive('settings', open)
  })

  /* ---- petting: hearts appear while stroking the head, and only then ---- */
  bus.on('input:pet-start', ({ head }) => {
    app.lastPetAt = performance.now()
    // Petting sound: one soft pat as the hand lands, then the stroke handler keeps a
    // gentle rhythm going.
    if (head) app.sfx?.pat(0.7, { minGapMs: 0 })
    const lines = app.settings.petting.greetLines || []
    if (head && lines.length && Math.random() < 0.35) {
      app.bubble.show(pick(lines), { duration: 3.5 })
    }
  })

  bus.on('input:pet-stroke', ({ x, y, head, intensity }) => {
    const cfg = app.settings.petting
    if (head) app.sfx?.pat(intensity ?? 0.6)
    if (cfg.hearts && head) {
      app.fx.heart(x, y, { rate: cfg.heartRate, scale: 1.15 })
    }
    if (cfg.reactions && head && intensity > 0.65 && Math.random() < 0.02) {
      app.pet.react('love')
    }
  })

  bus.on('input:pet-end', ({ total, head, duration }) => {
    const cfg = app.settings.petting
    const stats = { ...(app.state.stats || {}) }
    stats.pets = (stats.pets || 0) + 1
    saveState({ stats, lastSeen: Date.now() })

    const gave = total > 60
    if (gave) {
      if (cfg.squint && head) app.pet.react('happy')
      if (cfg.speakLines !== false && cfg.reactions && app.settings.voice.speakOnPet) {
        const lines = cfg.reactLines || []
        if (lines.length && Math.random() < 0.55) {
          const line = pick(lines)
          app.bubble.show(line, { duration: 4, actions: true })
          app.voice.speak(line)
        }
      }
    } else if (duration > 200) {
      app.pet.react('shy')
      const lines = cfg.leaveLines || []
      if (lines.length && Math.random() < 0.3) app.bubble.show(pick(lines), { duration: 3.5 })
    }
    app.pet.setPettingVisual(false)
  })

  /* ---- dragging ---- */
  bus.on('input:drag-start', () => {
    app.bubble.hide()
    app.pet.setPettingVisual(false)
  })
  bus.on('input:drag-end', () => {
    saveState({ petPos: { ...app.pet.pos } })
  })

  /* ---- context menu ---- */
  bus.on('input:context-menu', ({ x, y }) => {
    app.menu.show(x, y, [
      { label: t('Start chatting'), icon: '💬', action: () => app.chatPanel.open() },
      { label: app.settings.voice.sttEnabled ? t('Voice input') : t('Voice input (off)'), icon: '🎤', action: () => app.chatPanel.toggleRecord() },
      { type: 'sep' },
      { label: t('Make her nod'), icon: '🙂', action: () => app.pet.react('nod') },
      { label: t('Make her shake her head'), icon: '🙅', action: () => app.pet.react('shake') },
      { label: t('Head pat'), icon: '💗', action: () => app.pet.react('love') },
      { type: 'sep' },
      {
        label: app.settings.voice.ttsEnabled ? t('Turn voice reading off') : t('Turn voice reading on'),
        icon: '🔊',
        action: async () => {
          await patchSettings({ voice: { ttsEnabled: !app.settings.voice.ttsEnabled } })
          updateDockSpeakIcon()
          if (!app.settings.voice.ttsEnabled) app.voice.stop()
        },
      },
      {
        label: t('Click-through'),
        icon: '🖱',
        checked: app.overrideClickThrough,
        action: () => {
          app.overrideClickThrough = !app.overrideClickThrough
          bridge.win.setIgnoreMouse(app.overrideClickThrough)
          toast(app.overrideClickThrough ? t('Click-through on (restore from the tray)') : t('Mouse interaction restored'), '', 4000)
        },
      },
      { type: 'sep' },
      { label: t('Settings…'), icon: '⚙️', key: 'Ctrl+Shift+S', action: () => app.settingsPanel.open() },
      { label: t('Let her idle (hide)'), icon: '👁', key: 'Ctrl+Shift+H', action: () => bridge.win.hide() },
      { type: 'sep' },
      { label: t('Quit'), icon: '🚪', danger: true, action: () => bridge.win.quit() },
    ])
  })

  /* ---- chat ---- */
  bus.on('chat:emotion', ({ emotion }) => {
    if (app.settings.chat.emotionTags !== false) app.pet.setEmotion(emotion, 7000)
  })
  bus.on('chat:motion', ({ motion }) => app.pet.react(motion))

  bus.on('chat:start', () => {
    app.pet.setEmotion('think', 20000)
    if (!app.chatPanel.visible) app.bubble.show(t('Hmm… let me think~'), { duration: 0, keep: true })
  })

  bus.on('chat:delta', ({ full }) => {
    if (!app.chatPanel.visible && full) app.bubble.setText(full)
  })

  bus.on('chat:done', ({ text, emotion, error }) => {
    if (error && error !== 'aborted') {
      app.pet.setEmotion('sad', 3500)
      return
    }
    if (!text) return
    app.pet.setEmotion(emotion || 'neutral', 8000)
    if (!app.chatPanel.visible) {
      app.bubble.show(text, { actions: true })
    }
    if (app.settings.voice.ttsEnabled && app.settings.voice.autoSpeak) {
      app.voice.speak(text).then((ok) => {
        if (ok) {
          const stats = { ...(app.state.stats || {}) }
          stats.spoken = (stats.spoken || 0) + 1
          saveState({ stats })
        } else {
          app.bubble.show(text, { actions: true })
        }
      })
    }
  })

  bus.on('chat:error', () => app.pet.setEmotion('sad', 3500))
  bus.on('chat:cleared', () => toastOk(t('Chat history cleared')))

  // ChatService mutates its own view of state; mirror it to disk so the
  // conversation (and stats) survive a restart.
  bus.on('state:changed', (partial) => saveState(partial))

  /* ---- voice ---- */
  bus.on('voice:error', ({ message }) => toastErr(message, 6000))
  bus.on('voice:fallback', ({ label, from, to }) => {
    const names = { gptsovits: 'GPT-SoVITS', openai: t('Online TTS') }
    toast(
      label || t('{from} unavailable — switched to {to}', { from: names[from] || from, to: names[to] || to }),
      'err',
      6000
    )
    updateDockSpeakIcon()
  })
  bus.on('voice:lang-mismatch', ({ lang }) => {
    const pretty = t({ 'ja-JP': 'Japanese', 'en-US': 'English', 'ko-KR': 'Korean', 'zh-CN': 'Chinese' }[lang] || lang)
    toast(
      t(
        'This machine has no {lang} speech engine, so {lang} text is read with the current voice (timbre and pronunciation may be off). ' +
          'For a {lang} voice: keep the GPT-SoVITS service running, or point an online TTS endpoint at a model that supports the language.',
        { lang: pretty }
      ),
      'err',
      9000
    )
  })

  /* ---- settings ---- */
  bus.on('settings:changed', async ({ path }) => {
    app.pet.applySettings(app.settings)
    app.dock?.setEnabled(app.settings?.ui?.dockVisible !== false)
    if (path === 'ui.accent' || path === 'ui.fontSize' || path === 'ui.panelOpacity') applyTheme()
    app.interaction?.refresh()
  })

  bus.on('settings:reloaded', async () => {
    app.settings = await bridge.settings.get()
    app.pet.applySettings(app.settings)
    app.dock?.setEnabled(app.settings?.ui?.dockVisible !== false)
    applyTheme()
    updateDockSpeakIcon()
    toastOk(t('Defaults restored'))
  })

  /* ---- internal UI commands ---- */
  bus.on('ui:reset-position', () => {
    app.pet.setPosition(0.8, 1.0)
    saveState({ petPos: { ...app.pet.pos } })
  })
  bus.on('ui:test-motion', ({ motion }) => app.pet.react(motion))
  bus.on('ui:focus-input', () => app.interaction?.refresh())
  bus.on('ui:theme', () => applyTheme())

  /* ---- status badge (fps / emotion / gaze debug) ---- */
  app.statusEl = $('#status-hud')
  setInterval(() => {
    if (!app.statusEl) return
    if (!app.settings?.ui?.showStatusHud) {
      app.statusEl.classList.add('hidden')
      return
    }
    app.statusEl.classList.remove('hidden')
    const g = app.pet.gaze.output
    app.statusEl.textContent =
      `FPS ${String(app.pet.fps).padStart(3)}  ${app.settings.display.fps}cap\n` +
      `${t('Emotion')} ${app.pet.emotion.current}\n` +
      `${t('Eyes')} ${g.eyeX >= 0 ? '+' : ''}${g.eyeX.toFixed(2)} ${g.eyeY >= 0 ? '+' : ''}${g.eyeY.toFixed(2)}\n` +
      `${t('Head')} ${g.headX >= 0 ? '+' : ''}${g.headX.toFixed(1)}° ${g.headY >= 0 ? '+' : ''}${g.headY.toFixed(1)}°\n` +
      `${t('Interaction')} ${app.interaction.overModel ? t('petting') : app.interaction.overUI ? 'UI' : t('click-through')}`
  }, 250)

  /* ---- periodic HUD tracking ---- */
  setInterval(() => {
    if (!app.pet?.ready) return
  }, 250)

  /* ---- persist position + state periodically ---- */
  setInterval(() => {
    if (!app.pet?.ready) return
    saveState({ petPos: { ...app.pet.pos }, lastSeen: Date.now() })
  }, 20000)
}

/* ---------------------------------------------------------------- *
 * Commands pushed from the main process (tray, global shortcuts)
 * ---------------------------------------------------------------- */
function wireMainCommands() {
  bridge.on('ui:command', (cmd) => {
    if (!cmd || !cmd.type) return
    switch (cmd.type) {
      case 'open-chat':
        app.chatPanel.open()
        break
      case 'open-settings':
        app.settingsPanel.open(cmd.section, cmd.group)
        break
      case 'toggle-record':
        app.chatPanel.open({ focus: false })
        app.chatPanel.toggleRecord()
        break
      case 'reset-position':
        bus.emit('ui:reset-position')
        break
      case 'display-changed':
        app.pet.relayout()
        break
      case 'click-through-override':
        app.overrideClickThrough = !!cmd.value
        toast(cmd.value ? t('Click-through on — clicks pass through the pet') : t('Mouse interaction restored'), '', 3500)
        break
      case 'settings-changed-externally':
        app.settings = cmd.settings
        app.pet.applySettings(app.settings)
        updateDockSpeakIcon()
        break
      default:
        break
    }
  })
}

/* ---------------------------------------------------------------- *
 * Lifecycle / global keys
 * ---------------------------------------------------------------- */
function wireLifecycle() {
  document.addEventListener('visibilitychange', () => {
    const hidden = document.hidden
    app.pet?.setPaused(hidden)
    if (!hidden) app.interaction?.refresh()
  })

  window.addEventListener('beforeunload', () => {
    saveState({
      petPos: app.pet ? { ...app.pet.pos } : undefined,
      lastSeen: Date.now(),
    })
  })

  window.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || '')
    if (e.key === 'Escape') {
      app.menu.hide()
      if (app.settingsPanel?.visible) app.settingsPanel.close()
      else if (typing) document.activeElement.blur()
      return
    }
    if (typing) return
    const k = e.key.toLowerCase()
    if (k === 'c' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault()
      app.chatPanel.toggle()
    } else if (k === 's' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault()
      app.settingsPanel.toggle()
    } else if (k === 'm' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault()
      app.chatPanel.toggleRecord()
    } else if (k === 'h' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault()
      bridge.win.hide()
    }
  })

  window.addEventListener('error', (e) => {
    console.error('[app] window error', e.error || e.message)
  })
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[app] unhandled rejection', e.reason)
  })
}

/* ---------------------------------------------------------------- */
boot()
