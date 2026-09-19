/**
 * Pet — the central controller. Owns the stage and the behaviour controllers,
 * runs the animation loop, and applies every parameter exactly once per frame
 * through PetStage's `beforeModelUpdate` hook.
 */
import { PetStage, PARAMS } from './live2d/stage.js'
import { PHYSICS_INPUTS, PARAM_IDS } from './live2d/params.js'
import { GazeController } from './live2d/gaze.js'

/** Samples kept per parameter for the live curve (~2 s at 60 fps). */
const TRACE_SAMPLES = 120
import { BlinkController, MotionScheduler } from './live2d/idle.js'
import { EmotionController } from './live2d/emotion.js'
import { clamp, pick, smoothFactor } from './core/util.js'
import { bus } from './core/bus.js'

export class Pet {
  constructor() {
    this.stage = new PetStage()
    this.gaze = new GazeController()
    this.blink = new BlinkController()
    this.emotion = new EmotionController()
    this.motions = new MotionScheduler(
      (group) => this.playMotion(group),
      () => this.stage.getUsableMotionGroups()
    )

    this.settings = null
    this.pointer = null
    this.pos = { x: 0.8, y: 1.0 }
    this.screen = { width: window.innerWidth, height: window.innerHeight }

    this.ready = false
    this.speaking = false
    this.mouthTarget = 0
    this.mouthValue = 0
    this.petting = false
    this.petIntensity = 0
    this.headPat = false
    /** Short-lived additive eye offset for reactions (e.g. surprise). */
    this.eyeKick = { x: 0, y: 0 }
    this._kickUntil = 0
    this._tickFn = null
    this._paused = false
    this._frameCount = 0
    this._fpsSample = { t: performance.now(), frames: 0, fps: 0 }
    this.lastMotionAt = 0
    /** Parameters as applied to the model this frame (see _applyParameters). */
    this.applied = null
    this._captureApplied = false
    /** Eye-open composition: what a motion authored, and what we last wrote. */
    this._eyeBase = {}
    this._eyeWritten = {}
    /** Own breathing oscillator (the library's built-in breath is detached). */
    this.breathPhase = 0
    this._lastDt = 1 / 60
    /** Per-parameter ring buffers for the settings panel's live curves. */
    this._traced = false
    this._traceHead = 0
    this._traceBuffers = new Map()
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */
  async load({ canvas, layer, fxLayer, modelUrl, onProgress }) {
    await this.stage.load({ canvas, layer, fxLayer, modelUrl, onProgress })
    this.stage.installEarlyParameterHook((core) => this._applyEarlyParameters(core))
    this.stage.installParameterHook((core) => this._applyParameters(core))
    this.ready = true
    // Record the parameter ranges psd2live baked into this model, for the UI.
    this.paramRanges = {}
    for (const id of Object.keys(PARAMS).map((k) => PARAMS[k])) {
      try {
        this.paramRanges[id] = this.stage.getParamBounds(id)
      } catch {
        /* ignore */
      }
    }
    bus.emit('pet:loaded', {
      motionGroups: this.stage.getUsableMotionGroups(),
      size: { width: this.stage.baseWidth, height: this.stage.baseHeight },
      paramRanges: this.paramRanges,
    })
    return this
  }

  /**
   * Measures the character's true silhouette and re-lays-out around it.
   * Must run after the ticker is started so frames are actually rendered.
   */
  async measure({ delayFrames = 34 } = {}) {
    const content = await this.stage.measureContentBounds({ delayFrames })
    if (content) {
      this.relayout()
      bus.emit('pet:measured', { content })
    }
    return content
  }

  /** Applies a full settings object and re-lays-out the pet. */
  applySettings(settings) {
    this.settings = settings
    const s = settings
    this.gaze.applySettings(s.gaze)
    this.gaze.setPettingFollow(s.petting?.headFollow)
    this.blink.applySettings(s.idle)
    this.motions.applySettings(s.idle)

    if (this.stage.app) {
      this.stage.app.ticker.maxFPS = clamp(Number(s.display?.fps) || 60, 10, 144)
    }
    this.stage.setPhysics(s.idle?.physics !== false)
    this.stage.setBreath(s.idle?.breath !== false, s.idle?.breathSpeed)
    this.stage.setMotionSpeed(s.idle?.motionSpeed)
    this.stage.setMotionsEnabled(s.idle?.motionsEnabled !== false)

    if (this.stage.layer) {
      this.stage.layer.classList.toggle('no-shadow', s.model?.shadow === false)
    }
    this.relayout()
  }

  relayout() {
    if (!this.ready || !this.settings) return
    this.screen = { width: window.innerWidth, height: window.innerHeight }
    this.stage.layout(this.settings.model, this.screen, this.pos)
  }

  setPosition(x, y, { notify = true } = {}) {
    this.pos.x = clamp(x, -0.1, 1.1)
    this.pos.y = clamp(y, -0.1, 1.2)
    this.relayout()
    if (notify) bus.emit('pet:moved', { ...this.pos })
  }

  nudge(dxPx, dyPx) {
    if (!this.screen.width) return
    this.setPosition(this.pos.x + dxPx / this.screen.width, this.pos.y + dyPx / this.screen.height)
  }

  start() {
    if (!this.stage.app || this._tickFn) return
    this._tickFn = () => this._tick()
    this.stage.app.ticker.add(this._tickFn)
  }

  stop() {
    if (this.stage.app && this._tickFn) this.stage.app.ticker.remove(this._tickFn)
    this._tickFn = null
  }

  setPaused(paused) {
    this._paused = !!paused
    if (!this.stage.app) return
    // Freezing the ticker stops both model updates and rendering, which keeps
    // an occluded/hidden pet from burning CPU.
    if (paused) this.stage.app.ticker.stop()
    else this.stage.app.ticker.start()
  }

  /* ---------------------------------------------------------------- *
   * Frame loop
   * ---------------------------------------------------------------- */
  _tick() {
    if (!this.ready || this._paused) return
    const ticker = this.stage.app.ticker
    const dt = clamp((ticker.elapsedMS || 16.667) / 1000, 0.001, 0.1)
    this._lastDt = dt
    this._frameCount++

    // rolling FPS estimate
    const fs = this._fpsSample
    fs.frames++
    const now = performance.now()
    if (now - fs.t >= 500) {
      fs.fps = Math.round((fs.frames * 1000) / (now - fs.t))
      fs.frames = 0
      fs.t = now
    }

    const cfg = this.settings
    if (!cfg) return

    /* gaze ------------------------------------------------------------ */
    const origin = this.stage.getHeadAnchor(0.16)
    this.gaze.update(dt, {
      pointer: this.pointer,
      origin,
      screen: this.screen,
    })

    /* blink ----------------------------------------------------------- */
    // 舒服地眯眼 (设置 → 抚摸): the steady half-close that lasts as long as the
    // stroking does. Off means the eyes stay open throughout.
    const squintOn = this.settings?.petting?.squint !== false
    const blinkScale = this.petting && squintOn ? 0.58 : 1
    this.blink.scale += (blinkScale - this.blink.scale) * smoothFactor(0.2, dt)
    this.blinkValue = this.blink.update(dt)

    /* emotion --------------------------------------------------------- */
    this.emotion.update(dt)

    /* mouth / lip-sync ------------------------------------------------ */
    const lsCfg = cfg.voice || {}
    const mouthSmoothing = clamp(Number(lsCfg.lipSyncSmoothing) ?? 0.4, 0.02, 1)
    const k = smoothFactor(mouthSmoothing, dt)
    const target = this.speaking ? this.mouthTarget : 0
    this.mouthValue += (target - this.mouthValue) * k

    /* eye kick decay -------------------------------------------------- */
    if (now > this._kickUntil) {
      this.eyeKick.x *= 1 - smoothFactor(0.15, dt)
      this.eyeKick.y *= 1 - smoothFactor(0.15, dt)
    }

    /* idle motions ---------------------------------------------------- */
    this.motions.update(dt)

    /* petting intensity decay ---------------------------------------- */
    if (this.petting) this.petIntensity = Math.min(1, this.petIntensity + dt * 2.2)
    else this.petIntensity *= 1 - smoothFactor(0.08, dt)

    bus.emit('pet:frame', {
      fps: fs.fps,
      mouth: this.mouthValue,
      gaze: this.gaze.output,
      emotion: this.emotion.current,
    })
  }

  /** True when the user pinned this parameter to a fixed value. */
  _isParamFixed(id) {
    const mp = this.settings?.modelParams
    if (!mp?.enabled) return false
    const o = (mp.items || {})[id]
    return !!o && o.mode === 'fixed'
  }

  /**
   * Manual per-parameter overrides from 设置 → 模型参数.
   *
   * Modes:
   *  - `auto`   engine drives it; `min`/`max` (when set) clamp the result.
   *  - `offset` nudge the engine result by a fixed amount.
   *  - `fixed`  pin the parameter outright.
   *
   * `phase` decides when the write happens:
   *  - `early` runs before the physics step, and only writes *absolute* values
   *    (the two eye-open parameters, which `PhysicsEyeJelly` reads). Absolute
   *    writes are idempotent, so repeating them later is harmless.
   *  - `final` runs last and applies everything, so an `offset` is never
   *    applied twice.
   */
  _applyManual(core, phase) {
    const mp = this.settings?.modelParams
    if (!mp?.enabled) return
    const items = mp.items || {}
    const st = this.stage
    for (const [id, o] of Object.entries(items)) {
      if (!o || !o.mode || o.mode === 'auto') continue
      const isEye = PHYSICS_INPUTS.includes(id)
      if (phase === 'early' && !(isEye && o.mode === 'fixed')) continue
      const v = Number(o.value)
      if (!Number.isFinite(v)) continue
      if (o.mode === 'fixed') st.setParam(core, id, v)
      else st.addParamClamped(core, id, v)
    }
  }

  /**
   * Clamps every engine-driven parameter into the user's per-parameter auto
   * limits. Runs as a post-pass so all 18 parameters are handled uniformly.
   */
  _applyAutoClamps(core) {
    const mp = this.settings?.modelParams
    if (!mp?.enabled) return
    const items = mp.items || {}
    const st = this.stage
    for (const [id, o] of Object.entries(items)) {
      if (!o || o.mode !== 'auto') continue
      const lo = Number(o.min)
      const hi = Number(o.max)
      if (!Number.isFinite(lo) && !Number.isFinite(hi)) continue
      const cur = st.getParam(core, id)
      let v = cur
      if (Number.isFinite(lo)) v = Math.max(lo, v)
      if (Number.isFinite(hi)) v = Math.min(hi, v)
      if (v !== cur) st.setParam(core, id, v)
    }
  }

  /** Records a value for the live curve shown in the settings panel. */
  _trace(id, value) {
    if (!this._traced) return
    let buf = this._traceBuffers.get(id)
    if (!buf) {
      buf = new Float32Array(TRACE_SAMPLES)
      this._traceBuffers.set(id, buf)
    }
    buf[this._traceHead % TRACE_SAMPLES] = value
    this._traceHead++
  }

  /** Enables/disables per-parameter tracing (only while the panel is open). */
  setTracing(on) {
    this._traced = !!on
    if (!on) {
      this._traceBuffers.clear()
      this._traceHead = 0
    }
  }

  /** Latest trace window for a parameter, oldest first. */
  getTrace(id) {
    const buf = this._traceBuffers.get(id)
    if (!buf) return null
    const n = TRACE_SAMPLES
    const out = new Array(n)
    for (let i = 0; i < n; i++) out[i] = buf[(this._traceHead + i) % n]
    return out
  }

  /**
   * Called by the stage right after the motion manager, before eye-blink,
   * the focus controller and physics.
   *
   * For psd2live models this is where the blink must land: `PhysicsEyeJelly`
   * derives `ParamEyeBallForm` from `ParamEyeL/ROpen`, and the physics step runs
   * before the final hook. Writing the blink here is what keeps the authored
   * jelly-eye squash alive.
   */
  _applyEarlyParameters(core) {
    const P = PARAMS
    if (this._captureApplied) {
      // Value right after the motion manager, before keep/saveParameters.
      this._earlyProbe = {
        angleX: this.stage.getParam(core, P.angleX),
        angleY: this.stage.getParam(core, P.angleY),
        bodyX: this.stage.getParam(core, P.bodyX),
      }
    }
    const open = this.eyeFactor
    for (const id of [P.eyeLOpen, P.eyeROpen]) {
      /*
       * Runs immediately after the motion manager, which is the only moment the
       * channels hold what a motion authored rather than what we wrote. Capture
       * that as the base; multiplying it later is stable, whereas multiplying
       * the live value in place is not — a channel nothing rewrites (playback
       * off, motion finished) decays geometrically to 0 and the eyes shut.
       */
      const raw = this.stage.getParam(core, id)
      const last = this._eyeWritten?.[id]
      this._eyeBase[id] = last !== undefined && Math.abs(raw - last) < 1e-4 ? 1 : raw
    }
    this._writeEyeOpen(core, P.eyeLOpen, open)
    this._writeEyeOpen(core, P.eyeROpen, open)
    this._applyManual(core, 'early')
  }

  /**
   * The app's own eye-open factor: the blink curve times the current
   * expression's squint.
   *
   * While the pet is being stroked, 设置 → 抚摸 → 舒服地眯眼 is authoritative:
   * with it off the eyes stay open whatever wants to narrow them — our blink
   * curve, the stroking squint, or the expression a pet reaction sets.
   */
  get eyeFactor() {
    if (this.petting && this.settings?.petting?.squint === false) return 1
    return clamp(this.blinkValue * this.emotion.eyeScale, 0, 1)
  }

  /**
   * Writes one eye-open channel.
   *
   * The value is `base × open`, where `base` is what a motion authored this
   * frame (captured in `_applyEarlyParameters`, defaulting to fully open) and
   * `open` is the app's own blink/expression factor. Writing the product
   * outright — rather than scaling the live value in place — is what keeps
   * authored detail (the Nod curve presses the eyes to 0.75) *and* stays stable
   * when nothing rewrites the channel.
   *
   * A pinned parameter is left alone — 固定 means fixed.
   */
  _writeEyeOpen(core, id, open) {
    if (this._isParamFixed(id)) return
    const base = this._eyeBase?.[id] ?? 1
    const value = clamp(base * open, 0, 1)
    this.stage.setParam(core, id, value)
    if (!this._eyeWritten) this._eyeWritten = {}
    this._eyeWritten[id] = value
  }

  /**
   * Called by the stage at the end of every model update, just before the mesh
   * is deformed.
   *
   * Composition rule taken from the psd2live parameter spec: the generated
   * idle/nod/shake motions own ParamAngleX/Y/Z and ParamBodyAngleX/Y, so the
   * gaze contributes an *offset* on top of them. Writing absolute values here
   * would silently flatten every nod and shake to nothing.
   */
  _applyParameters(core) {
    const P = PARAMS
    const st = this.stage
    const g = this.gaze.output
    const emo = this.emotion.cur
    const cfg = this.settings

    // Values the engine produced *before* we touch them — used by the self-test
    // to tell "our gaze is weak" apart from "something else drives this too".
    const pre = this._captureApplied
      ? { angleX: st.getParam(core, P.angleX), eyeBallX: st.getParam(core, P.eyeBallX), bodyX: st.getParam(core, P.bodyX) }
      : null

    /* ---- head / body: additive, so the authored motions survive ---- */
    st.addParamClamped(core, P.angleX, g.headX)
    st.addParamClamped(core, P.angleY, g.headY)
    st.addParamClamped(core, P.angleZ, g.headZ + emo.headZ)
    st.addParamClamped(core, P.bodyX, g.bodyX)
    st.addParamClamped(core, P.bodyY, g.bodyY)
    // Nothing else drives BodyAngleZ, so it is ours to set (±10° per the spec).
    st.setParam(core, P.bodyZ, clamp(emo.bodyZ, -10, 10))

    /* ---- gaze: nobody else writes these ---- */
    st.setParam(core, P.eyeBallX, clamp(g.eyeX + this.eyeKick.x, -1, 1))
    st.setParam(core, P.eyeBallY, clamp(g.eyeY + this.eyeKick.y, -1, 1))

    /* ---- re-assert the blink after eye-blink/focus.
           ParamEyeBallForm is deliberately NOT written: psd2live's
           PhysicsEyeJelly owns it (driven by ParamEyeL/ROpen, scale 0.32). ---- */
    const open = this.eyeFactor
    this._writeEyeOpen(core, P.eyeLOpen, open)
    this._writeEyeOpen(core, P.eyeROpen, open)

    st.setParam(core, P.browLY, clamp(emo.browY, -1, 1))
    st.setParam(core, P.browRY, clamp(emo.browY, -1, 1))

    const maxOpen = clamp(Number(cfg?.voice?.mouthMax ?? 0.85), 0.05, 1)
    st.setParam(core, P.mouthOpen, clamp(this.mouthValue, 0, 1) * maxOpen)
    st.setParam(core, P.mouthForm, clamp(emo.mouthForm + (this.petting ? 0.15 : 0), -1, 1))

    // ParamHairFront / ParamHairBack are left to the physics settings. Breathing
    // is driven here rather than by the library's built-in breath, which would
    // also wag the head by ±15° (see PetStage.load).
    if (cfg && cfg.idle && cfg.idle.breath === false) {
      st.setParam(core, P.breath, 0)
    } else {
      const speed = clamp(Number(cfg?.idle?.breathSpeed) || 1, 0.1, 4)
      // One breath cycle ≈ 3.4 s at speed 1 — a calm resting rate.
      this.breathPhase = (this.breathPhase + this._lastDt * speed * 1.85) % (Math.PI * 2)
      const amount = clamp(Number(cfg?.idle?.breathAmount ?? 1), 0, 1)
      // Amplitude scales the swing around the resting midpoint, so 0 % holds a
      // still chest and 100 % keeps the authored 0↔1 range.
      st.setParam(core, P.breath, 0.5 - amount * 0.5 * Math.cos(this.breathPhase))
    }

    /* ---- manual overrides win over everything above ---- */
    this._applyManual(core, 'rest')
    // Auto-mode limits win over the engine, but not over an explicit override.
    this._applyAutoClamps(core)

    if (this._traced) {
      const st2 = this.stage
      for (const id of PARAM_IDS) this._trace(id, st2.getParam(core, id))
    }

    // Read back what the model actually holds at this instant. The Cubism
    // pipeline calls loadParameters() right after model.update(), which reverts
    // these values for the next frame — so this is the only point at which the
    // applied parameters are observable, and it is what the self-test asserts on.
    if (this._captureApplied) {
      const read = (id) => st.getParam(core, id)
      this.applied = {
        mouthOpenY: read(P.mouthOpen),
        mouthForm: read(P.mouthForm),
        eyeBallX: read(P.eyeBallX),
        eyeBallY: read(P.eyeBallY),
        eyeLOpen: read(P.eyeLOpen),
        eyeROpen: read(P.eyeROpen),
        eyeBallForm: read(P.eyeBallForm),
        browLY: read(P.browLY),
        browRY: read(P.browRY),
        angleX: read(P.angleX),
        angleY: read(P.angleY),
        angleZ: read(P.angleZ),
        bodyX: read(P.bodyX),
        bodyY: read(P.bodyY),
        bodyZ: read(P.bodyZ),
        breath: read(P.breath),
        hairFront: read(P.hairFront),
        hairBack: read(P.hairBack),
        // gaze the controller asked for, and what the engine had before we wrote
        gazeHeadX: g.headX,
        gazeHeadY: g.headY,
        gazeEyeX: g.eyeX,
        preAngleX: pre?.angleX,
        preEyeBallX: pre?.eyeBallX,
        preBodyX: pre?.bodyX,
        earlyAngleX: this._earlyProbe?.angleX,
        earlyBodyX: this._earlyProbe?.bodyX,
        focusX: (() => {
          try {
            return this.stage.model?.internalModel?.focusController?.x ?? null
          } catch {
            return null
          }
        })(),
        at: performance.now(),
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * Interaction entry points
   * ---------------------------------------------------------------- */
  setPointer(x, y) {
    this.pointer = x === null ? null : { x, y }
  }

  hitTest(x, y) {
    return this.stage.hitTest(x, y)
  }

  getHeadAnchor() {
    return this.stage.getHeadAnchor(0.16)
  }

  getModelBounds() {
    return this.stage.getModelBounds()
  }

  /** Visual + behavioural state while the user strokes the pet. */
  setPettingVisual(active, { head = false } = {}) {
    if (active === this.petting && head === this.headPat) return
    this.petting = active
    this.headPat = head
    if (active) {
      this.gaze.suppress(true)
      this.emotion.setSticky(head ? 'happy' : 'shy')
      this.motions.hold(2600)
      this.eyeKick.y = 0.05
    } else {
      this.gaze.suppress(false)
      this.emotion.relax(1400)
      this.motions.hold(600)
    }
  }

  /** Level of the ongoing stroke, 0..1 — increases eye squint / tilt. */
  setPetIntensity(v) {
    this.petIntensity = clamp(v, 0, 1)
  }

  setSpeaking(on) {
    this.speaking = !!on
    if (on) this.motions.hold(1500)
  }

  /**
   * Feeds a live audio amplitude (0..1) into the mouth parameter.
   * Ignored while not in the "speaking" state.
   */
  setMouthLevel(level) {
    this.mouthTarget = clamp(level, 0, 1)
  }

  setEmotion(name, holdMs = 6000) {
    this.emotion.set(name, holdMs)
    bus.emit('pet:emotion', { emotion: this.emotion.current })
  }

  playMotion(group, index) {
    if (!group) return Promise.resolve(false)
    this.lastMotionAt = performance.now()
    return this.stage.playMotion(group, index, 3)
  }

  /** Semantic reactions used by chat, petting and voice events. */
  react(kind) {
    // 播放动作 is off: no motion may start, whatever asked for it.
    if (this.settings?.idle?.motionsEnabled === false) return Promise.resolve(false)
    const groups = this.stage.getUsableMotionGroups()
    const has = (g) => groups.some((x) => x.toLowerCase() === g.toLowerCase())
    const run = (g) => (has(g) ? this.playMotion(g) : Promise.resolve(false))

    switch (kind) {
      case 'nod':
        this.emotion.set('smile', 2600)
        return run('Nod')
      case 'shake':
        this.emotion.set('angry', 2400)
        return run('Shake')
      case 'happy':
        this.emotion.set('happy', 4200)
        return run(pick(['Nod', 'Shake']) === 'Nod' ? 'Nod' : 'Shake')
      case 'love':
        this.emotion.setSticky('love')
        this.eyeKick = { x: (Math.random() - 0.5) * 0.1, y: 0.08 }
        this._kickUntil = performance.now() + 900
        return run('Nod')
      case 'surprised':
        this.blink.trigger(true)
        this.emotion.set('surprised', 2200)
        this.eyeKick = { x: 0, y: 0.12 }
        this._kickUntil = performance.now() + 700
        return Promise.resolve(true)
      case 'shy':
        this.emotion.set('shy', 4000)
        return run('Shake')
      case 'sad':
        this.emotion.set('sad', 5000)
        return Promise.resolve(true)
      case 'think':
        this.emotion.set('think', 4000)
        this.gaze.lookAt(-0.35, 0.5, 2200)
        return Promise.resolve(true)
      case 'sleepy':
        this.emotion.set('sleepy', 6000)
        return Promise.resolve(true)
      default:
        return Promise.resolve(true)
    }
  }

  get fps() {
    return this._fpsSample.fps
  }
}
