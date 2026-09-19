/**
 * PetStage — owns the PIXI application, the Live2D model and its on-screen
 * placement, and provides pixel-accurate hit testing via a 1×1 GPU read-back
 * performed inside the renderer's `postrender` hook.
 */
import { clamp } from '../core/util.js'
import { rangeOf } from './params.js'

const PIXI = window.PIXI

/** Parameter ids present in this model (see the model's cdi3.json). */
export const PARAMS = {
  angleX: 'ParamAngleX',
  angleY: 'ParamAngleY',
  angleZ: 'ParamAngleZ',
  bodyX: 'ParamBodyAngleX',
  bodyY: 'ParamBodyAngleY',
  bodyZ: 'ParamBodyAngleZ',
  eyeLOpen: 'ParamEyeLOpen',
  eyeROpen: 'ParamEyeROpen',
  eyeBallX: 'ParamEyeBallX',
  eyeBallY: 'ParamEyeBallY',
  eyeBallForm: 'ParamEyeBallForm',
  browLY: 'ParamBrowLY',
  browRY: 'ParamBrowRY',
  mouthForm: 'ParamMouthForm',
  mouthOpen: 'ParamMouthOpenY',
  breath: 'ParamBreath',
  hairFront: 'ParamHairFront',
  hairBack: 'ParamHairBack',
}

/** Extra headroom above the model so bubbles/hearts have room (CSS px). */
const PAD_TOP = 90
/** Horizontal breathing room either side of the model. */
const PAD_SIDE = 60

export class PetStage {
  constructor() {
    this.app = null
    this.model = null
    this.canvas = null
    this.layer = null
    this.fxLayer = null
    /** Native (unscaled) model size, captured right after load. */
    this.baseWidth = 0
    this.baseHeight = 0
    /** Layer size in CSS px. */
    this.layerWidth = 0
    this.layerHeight = 0
    this.ready = false
    this.lastError = null
    this._pendingHit = null
    this._hitStats = { count: 0, lastMs: 0 }
  }

  /* ---------------------------------------------------------------- *
   * Loading
   * ---------------------------------------------------------------- */
  async load({ canvas, layer, fxLayer, modelUrl, onProgress }) {
    this.canvas = canvas
    this.layer = layer
    this.fxLayer = fxLayer

    if (!PIXI) throw new Error('PIXI 未加载，请先执行 npm run build')
    if (!PIXI.live2d || !PIXI.live2d.Live2DModel) {
      throw new Error('pixi-live2d-display 未加载（缺少 PIXI.live2d）')
    }
    if (!window.Live2DCubismCore) {
      throw new Error('Live2D Cubism Core 未加载（vendor/live2dcubismcore.min.js）')
    }

    PIXI.live2d.Live2DModel.registerTicker(PIXI.Ticker)
    if (PIXI.settings) PIXI.settings.FAIL_IF_MAJOR_PERFORMANCE_CAVEAT = false

    const rect = { width: window.innerWidth, height: window.innerHeight }
    this.layerWidth = 320
    this.layerHeight = 480

    onProgress?.('创建渲染器…')
    // Render at device resolution so the model stays crisp on HiDPI displays.
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    this.app = new PIXI.Application({
      view: canvas,
      width: this.layerWidth,
      height: this.layerHeight,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: dpr,
      powerPreference: 'high-performance',
      hello: false,
      preserveDrawingBuffer: false,
      // The model auto-updates on PIXI.Ticker.shared, so render on that same
      // ticker to guarantee our updates land before the frame is drawn.
      sharedTicker: true,
    })
    // We render on demand from our own ticker callback so the read-back for
    // hit testing always happens immediately after a fresh frame.
    this.app.renderer.on('postrender', () => this._flushHitTest())

    onProgress?.('加载 Live2D 模型…')
    const t0 = performance.now()
    this.model = await PIXI.live2d.Live2DModel.from(modelUrl, {
      autoInteract: false,
      autoUpdate: true,
      motionPreload: 'ALL',
    })
    console.info(`[stage] model loaded in ${Math.round(performance.now() - t0)}ms`)

    this.model.anchor.set(0.5, 1)
    this.model.eventMode = 'none'
    this.app.stage.addChild(this.model)

    this.baseWidth = this.model.width
    this.baseHeight = this.model.height
    if (!(this.baseWidth > 0) || !(this.baseHeight > 0)) {
      throw new Error('模型尺寸异常，可能是 moc3 版本不受当前 Cubism Core 支持')
    }
    console.info(`[stage] native model size ${Math.round(this.baseWidth)}×${Math.round(this.baseHeight)}`)

    this.ready = true
    this.content = null
    // Keep references so physics/breath can be toggled off and restored.
    this._physics = this.model.internalModel.physics
    this._breath = this.model.internalModel.breath
    /*
     * pixi-live2d-display creates a *generic sample* breath that drives
     *   ParamAngleX ±15°, ParamAngleY ±8°, ParamAngleZ ±10°, ParamBodyAngleX ±4°
     * plus ParamBreath. None of that is part of a psd2live rig — its spec says
     * breathing is expressed through ParamBreath alone (a gaussian chest bulge),
     * and head/body sway belongs to the generated Idle motion. Left enabled, that
     * sample breath adds a phantom ±15° head wobble on top of everything.
     *
     * So the built-in breath is detached here and Pet drives ParamBreath itself.
     */
    this.model.internalModel.breath = null
    // Hidden default until measured, so the first layout is sane.
    this.charRect = null
    return this
  }

  /* ---------------------------------------------------------------- *
   * Content measurement
   *
   * A Live2D canvas is usually far larger than the character: this model's
   * canvas is 1024×1024 while the girl occupies roughly a third of it. Every
   * UI element (bubble, dock, HUD, gaze origin) must anchor to the *silhouette*
   * rather than the canvas, so the real alpha bounding box is measured once
   * from the GPU and cached as fractions of the model box.
   * ---------------------------------------------------------------- */
  _measureContent() {
    if (this._pendingMeasure) return this._pendingMeasure
    this._pendingMeasure = new Promise((resolve) => {
      this._measureResolve = resolve
    })
    return this._pendingMeasure
  }

  _flushMeasure() {
    if (!this._measureResolve) return
    const resolve = this._measureResolve
    this._measureResolve = null
    this._pendingMeasure = null
    try {
      resolve(this._readContentBounds())
    } catch (err) {
      console.warn('[stage] content measurement failed:', err.message)
      resolve(null)
    }
  }

  /** Reads the whole framebuffer and returns the alpha bounding box. */
  _readContentBounds() {
    const gl = this.app.renderer.gl
    const canvas = this.canvas
    const w = gl.drawingBufferWidth
    const h = gl.drawingBufferHeight
    if (!w || !h) return null
    if (gl.getParameter(gl.FRAMEBUFFER_BINDING) !== null) return null

    const buf = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf)

    const ALPHA_MIN = 26 // ~10% — ignores faint antialiasing fringes
    let minX = w
    let minY = h
    let maxX = -1
    let maxY = -1
    // Stride of 2 keeps this fast without meaningfully changing the box.
    for (let y = 0; y < h; y += 2) {
      const row = y * w * 4
      for (let x = 0; x < w; x += 2) {
        if (buf[row + x * 4 + 3] > ALPHA_MIN) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    if (maxX < 0 || maxY < 0) return null

    // GL origin is bottom-left; convert to CSS pixels within the canvas.
    const sx = w / (canvas.clientWidth || w)
    const sy = h / (canvas.clientHeight || h)
    const cssW = canvas.clientWidth || w
    const cssH = canvas.clientHeight || h
    const box = {
      left: minX / sx,
      top: cssH - (maxY + 1) / sy,
      right: (maxX + 1) / sx,
      bottom: cssH - minY / sy,
    }
    box.width = box.right - box.left
    box.height = box.bottom - box.top
    if (box.width < 4 || box.height < 4) return null
    console.info(
      `[stage] content box ${Math.round(box.width)}×${Math.round(box.height)} at (${Math.round(box.left)}, ${Math.round(box.top)}) of ${cssW}×${cssH}`
    )
    return box
  }

  /**
   * Runs a measurement once the model has settled into its idle pose, then
   * stores it as fractions of the model box so layout stays resolution-free.
   */
  async measureContentBounds({ delayFrames = 34 } = {}) {
    if (!this.ready) return null
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()))
    for (let i = 0; i < delayFrames; i++) await frame()
    const box = await this._measureContent()
    if (box && this.modelWidthPx > 0) {
      this.content = {
        x0: clamp((box.left - this.modelLeftPx) / this.modelWidthPx, 0, 1),
        y0: clamp((box.top - this.modelTopPx) / this.modelHeightPx, 0, 1),
        x1: clamp((box.right - this.modelLeftPx) / this.modelWidthPx, 0, 1),
        y1: clamp((box.bottom - this.modelTopPx) / this.modelHeightPx, 0, 1),
      }
      if (this.content.x1 - this.content.x0 < 0.05) this.content = null
    }
    return this.content
  }

  /* ---------------------------------------------------------------- *
   * Layout
   * ---------------------------------------------------------------- */
  /**
   * @param {object} modelSettings `settings.model`
   * @param {{width:number,height:number}} screen
   * @param {{x:number,y:number}} pos normalized centre-x / foot-y of the character
   */
  layout(modelSettings, screen, pos) {
    if (!this.ready) return
    const s = modelSettings || {}
    const scrW = screen.width
    const scrH = screen.height

    // `heightRatio` describes the visible character, not the model canvas.
    const c = this.content || { x0: 0.05, y0: 0.03, x1: 0.95, y1: 0.97 }
    const fracW = Math.max(0.05, c.x1 - c.x0)
    const fracH = Math.max(0.05, c.y1 - c.y0)

    const targetCharH = clamp(scrH * (Number(s.heightRatio) || 0.62) * (Number(s.scale) || 1), 80, scrH * 2)
    const scale = targetCharH / (this.baseHeight * fracH)

    this.model.scale.x = (s.mirror ? -1 : 1) * scale
    this.model.scale.y = scale
    this.model.alpha = clamp(Number(s.opacity ?? 1), 0.05, 1)

    this.modelWidthPx = this.baseWidth * scale
    this.modelHeightPx = this.baseHeight * scale
    this.layerWidth = Math.max(this.modelWidthPx, 160) + PAD_SIDE * 2
    this.layerHeight = this.modelHeightPx + PAD_TOP

    this.app.renderer.resize(this.layerWidth, this.layerHeight)

    // anchor (0.5, 1): model canvas sits bottom-centre in the layer
    this.model.position.set(this.layerWidth / 2, this.layerHeight)
    this.modelLeftPx = (this.layerWidth - this.modelWidthPx) / 2
    this.modelTopPx = this.layerHeight - this.modelHeightPx

    // character rect in layer-local coordinates
    const charLeft = this.modelLeftPx + c.x0 * this.modelWidthPx
    const charTop = this.modelTopPx + c.y0 * this.modelHeightPx
    const charW = fracW * this.modelWidthPx
    const charH = fracH * this.modelHeightPx
    this.charRect = { left: charLeft, top: charTop, width: charW, height: charH }

    const footX = clamp(pos.x, -0.2, 1.2) * scrW + (Number(s.offsetX) || 0)
    const footY = clamp(pos.y, -0.2, 1.2) * scrH + (Number(s.offsetY) || 0)

    let left = footX - (charLeft + charW / 2)
    let top = footY - (charTop + charH)

    if (s.keepInScreen !== false) {
      // Keep the character itself on screen, not the (much larger) canvas.
      left = clamp(left, -charW * 0.6, scrW - charW * 0.4)
      top = clamp(top, -charH * 0.3, scrH - charH * 0.5)
    }

    this.layer.style.width = `${Math.round(this.layerWidth)}px`
    this.layer.style.height = `${Math.round(this.layerHeight)}px`
    this.layer.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`
    this.layerRect = { left, top, width: this.layerWidth, height: this.layerHeight }
    this.footPoint = { x: footX, y: footY }
  }

  /** Screen-space rect of the character's silhouette. */
  getModelBounds() {
    if (!this.ready || !this.layerRect || !this.charRect) return null
    const b = this.layerRect
    const c = this.charRect
    return {
      left: b.left + c.left,
      top: b.top + c.top,
      width: c.width,
      height: c.height,
    }
  }

  /**
   * Estimated screen point of the character's head — used as the gaze origin
   * and to anchor the speech bubble. `faceY` is a fraction of character height.
   */
  getHeadAnchor(faceY = 0.16) {
    const b = this.getModelBounds()
    if (!b) return { x: window.innerWidth / 2, y: window.innerHeight / 2, radius: 60 }
    return {
      x: b.left + b.width / 2,
      y: b.top + b.height * faceY,
      radius: Math.max(b.width * 0.34, 40),
      modelBounds: b,
    }
  }

  /* ---------------------------------------------------------------- *
   * Hit testing
   * ---------------------------------------------------------------- */
  /**
   * Resolves with the model's alpha (0..1) at a client point.
   * One test is evaluated per rendered frame.
   */
  hitTest(clientX, clientY) {
    if (!this.ready || !this.layerRect) return Promise.resolve(0)
    const r = this.layerRect
    if (clientX < r.left || clientX > r.left + r.width || clientY < r.top || clientY > r.top + r.height) {
      return Promise.resolve(0)
    }
    return new Promise((resolve) => {
      // A stale pending test must never leak; resolve it as a miss.
      if (this._pendingHit) {
        this._pendingHit.resolve(0)
        this._pendingHit = null
      }
      this._pendingHit = { lx: clientX - r.left, ly: clientY - r.top, resolve, at: performance.now() }
    })
  }

  _flushHitTest() {
    if (this._measureResolve) this._flushMeasure()
    const pending = this._pendingHit
    if (!pending) return
    this._pendingHit = null
    const t0 = performance.now()
    let alpha = 0
    try {
      alpha = this._readAlpha(pending.lx, pending.ly)
    } catch (err) {
      alpha = 0
    }
    this._hitStats.lastMs = performance.now() - t0
    this._hitStats.count++
    pending.resolve(alpha)
  }

  _readAlpha(lx, ly) {
    const gl = this.app.renderer.gl
    const canvas = this.canvas
    // Derive the scale from the canvas itself: PIXI's autoDensity rounds the
    // backing store, so round(devicePixelRatio) is not always exact.
    const cssW = canvas.clientWidth || 1
    const cssH = canvas.clientHeight || 1
    const sx = canvas.width / cssW
    const sy = canvas.height / cssH
    const px = Math.floor(lx * sx)
    const py = Math.floor((cssH - ly) * sy)
    if (px < 0 || py < 0 || px >= gl.drawingBufferWidth || py >= gl.drawingBufferHeight) return 0
    if (gl.getParameter(gl.FRAMEBUFFER_BINDING) !== null) return 0
    const buf = new Uint8Array(4)
    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf)
    return buf[3] / 255
  }

  /* ---------------------------------------------------------------- *
   * Parameter access
   * ---------------------------------------------------------------- */
  get coreModel() {
    return this.model?.internalModel?.coreModel ?? null
  }

  /**
   * Runs `fn(coreModel)` at the very end of the model's update pipeline —
   * after motion, eye-blink, expressions and physics — so our values win.
   */
  installParameterHook(fn) {
    if (!this.model || this._hooked) return
    const im = this.model.internalModel
    this._hooked = true
    im.on('beforeModelUpdate', () => {
      const core = im.coreModel
      if (!core) return
      try {
        fn(core)
      } catch (err) {
        console.error('[stage] parameter hook failed', err)
      }
    })
  }

  /**
   * Installs a hook that runs right after the motion manager, i.e. *before*
   * `saveParameters()`, eye-blink, the focus controller and the physics step.
   *
   * This matters for psd2live models: `PhysicsEyeJelly` derives
   * `ParamEyeBallForm` from `ParamEyeL/ROpen`, and physics runs before the
   * final hook. Writing eye openness here — rather than only at the end — is
   * what makes the authored jelly-eye squash actually react to our blinks.
   */
  installEarlyParameterHook(fn) {
    if (!this.model || this._earlyHooked) return
    const im = this.model.internalModel
    this._earlyHooked = true
    im.on('afterMotionUpdate', () => {
      const core = im.coreModel
      if (!core) return
      try {
        fn(core)
      } catch (err) {
        console.error('[stage] early parameter hook failed', err)
      }
    })
  }

  /** Real min/max of a parameter as baked into the loaded model. */
  getParamBounds(id) {
    const cache = (this._boundsCache ||= new Map())
    if (cache.has(id)) return cache.get(id)
    let bounds = null
    try {
      // CubismModel exposes these on the wrapper; `_model.parameters` is the
      // internal array it reads from.
      const core = this.model?.internalModel?.coreModel
      if (core) {
        const idx = core.getParameterIndex(id)
        if (idx >= 0) {
          bounds = {
            min: core.getParameterMinimumValue(idx),
            max: core.getParameterMaximumValue(idx),
            index: idx,
          }
        }
      }
    } catch {
      /* fall through to the spec defaults */
    }
    if (!bounds) {
      const [min, max] = rangeOf(id)
      bounds = { min, max, index: -1 }
    }
    cache.set(id, bounds)
    return bounds
  }

  /** Current value of a parameter (0 when the model lacks it). */
  getParam(core, id) {
    try {
      const v = core.getParameterValueById(id)
      return typeof v === 'number' ? v : 0
    } catch {
      return 0
    }
  }

  setParam(core, id, value, weight = 1) {
    try {
      core.setParameterValueById(id, value, weight)
    } catch {
      /* parameter absent on this model — ignore */
    }
  }

  /**
   * Adds an offset on top of whatever the authored motion produced, clamped to
   * the model's own range. This is how the gaze must behave for psd2live
   * models: a nod (ParamAngleY → −18°) has to survive the cursor tracking.
   */
  addParamClamped(core, id, delta) {
    if (!delta) return
    try {
      const { min, max } = this.getParamBounds(id)
      const cur = this.getParam(core, id)
      core.setParameterValueById(id, Math.min(max, Math.max(min, cur + delta)))
    } catch {
      /* ignore */
    }
  }

  /** Multiplies the motion's value — used so blinks compose with eye dips. */
  scaleParam(core, id, factor) {
    try {
      const { min, max } = this.getParamBounds(id)
      const cur = this.getParam(core, id)
      core.setParameterValueById(id, Math.min(max, Math.max(min, cur * factor)))
    } catch {
      /* ignore */
    }
  }

  addParam(core, id, value) {
    try {
      core.addParameterValueById(id, value)
    } catch {
      /* ignore */
    }
  }

  /** Motion playback helpers. */
  playMotion(group, index, priority = 3) {
    if (!this.model) return Promise.resolve(false)
    try {
      if (index === undefined || index === null) return this.model.motion(group, undefined, priority)
      return this.model.motion(group, index, priority)
    } catch (err) {
      return Promise.resolve(false)
    }
  }

  getMotionGroups() {
    const defs = this.model?.internalModel?.motionManager?.definitions
    return defs ? Object.keys(defs) : []
  }

  /** Groups that actually contain at least one motion. */
  getUsableMotionGroups() {
    const defs = this.model?.internalModel?.motionManager?.definitions
    if (!defs) return []
    return Object.entries(defs)
      .filter(([, list]) => Array.isArray(list) && list.length > 0)
      .map(([name]) => name)
  }

  stopAllMotions() {
    try {
      this.model?.internalModel?.motionManager?.stopAllMotions()
    } catch {
      /* ignore */
    }
  }

  /**
   * The library's built-in breath stays detached permanently — Pet owns
   * ParamBreath instead (see the note in `load`). Settings are applied there.
   */
  setBreath() {
    const im = this.model?.internalModel
    if (!im) return
    try {
      im.breath = null
    } catch {
      /* ignore */
    }
  }

  /** Toggles hair/skirt physics (kept so it can be restored). */
  setPhysics(enabled) {
    const im = this.model?.internalModel
    if (!im) return
    try {
      if (!enabled) {
        if (im.physics) this._physics = im.physics
        im.physics = null
      } else if (!im.physics && this._physics) {
        im.physics = this._physics
      }
    } catch {
      /* ignore */
    }
  }

  /** Global motion playback speed multiplier. */
  setMotionSpeed(speed) {
    try {
      const mm = this.model?.internalModel?.motionManager
      if (mm) mm.timeScale = Math.max(0.1, Number(speed) || 1)
    } catch {
      /* ignore */
    }
  }

  destroy() {
    try {
      this.app?.destroy(true, { children: true, texture: true, baseTexture: true })
    } catch {
      /* ignore */
    }
    this.app = null
    this.model = null
    this.ready = false
  }
}
