/**
 * InteractionManager — translates raw pointer input into pet behaviours.
 *
 * Because the window is a full-screen transparent overlay, every mouse event in
 * it would otherwise be swallowed. We therefore keep the window click-through by
 * default and only "capture" it while the cursor is over the pet or over real UI
 * (decided from the live element under the cursor plus a GPU alpha hit test on
 * the model).
 */
import { bus } from '../core/bus.js'
import { clamp } from '../core/util.js'

/** Fractions of model height treated as "head" for petting reactions. */
const HEAD_FRACTION = 0.44

export class InteractionManager {
  constructor({ pet, getSettings }) {
    this.pet = pet
    this.getSettings = getSettings
    this.enabled = true

    this.pointer = { x: -1, y: -1, inside: false }
    this.overModel = false
    this.overUI = false
    this.alpha = 0
    this.interactive = null

    this.petting = false
    this.petStartAt = 0
    this.petDistance = 0
    this.petHead = false
    this.lastStrokeAt = 0
    this.strokeBurst = 0

    this.dragging = false
    this.dragButton = -1
    this.dragLast = { x: 0, y: 0 }
    this.dragMoved = 0
    this.pendingMenu = null

    this.pointerDown = false
    this._dirty = true
    this._raf = null
    this._hitBusy = false
    this._lastHeartbeat = 0
    this._lastPointerEventAt = performance.now()
    /** Overridden by automation; see setGlobalPointerEnabled(). */
    this.globalPointerEnabled = true
    /** When false the manager stops steering the gaze entirely. */
    this.driveGaze = true
    this._bound = {}
  }

  /* ---------------------------------------------------------------- */
  attach() {
    const b = this._bound
    b.move = (e) => this._onMove(e)
    b.down = (e) => this._onDown(e)
    b.up = (e) => this._onUp(e)
    b.ctx = (e) => this._onContextMenu(e)
    b.leave = () => this._onLeave()
    b.key = (e) => this._onKey(e)
    b.blur = () => this._releaseAll('blur')
    b.resize = () => this.pet.relayout()

    window.addEventListener('pointermove', b.move, { passive: true })
    window.addEventListener('pointerdown', b.down, { passive: false })
    window.addEventListener('pointerup', b.up, { passive: true })
    window.addEventListener('pointercancel', b.up, { passive: true })
    window.addEventListener('contextmenu', b.ctx)
    window.addEventListener('pointerleave', b.leave)
    window.addEventListener('blur', b.blur)
    window.addEventListener('resize', b.resize)
    window.addEventListener('keydown', b.key)

    this._raf = requestAnimationFrame(() => this._loop())
    // The authoritative gaze target: the real OS cursor, straight from the main
    // process. DOM pointer events stop arriving when the cursor is over the
    // taskbar or another monitor, which used to make the gaze give up.
    this._unsubPointer = window.pet?.onGlobalPointer?.((p) => {
      if (!this.globalPointerEnabled) return
      this.globalPointer = p
      this.pet.setPointer(p.x, p.y)
      // Keep the hit-test cursor roughly in sync when DOM events are not flowing.
      if (performance.now() - this._lastPointerEventAt > 250) {
        this.pointer.x = p.x
        this.pointer.y = p.y
        this.pointer.inside = true
        this._dirty = true
      }
    })
    return this
  }

  /**
   * The OS-cursor feed is authoritative in normal use. Automation turns it off
   * so synthetic `sendInputEvent` moves (which neither move the real cursor nor
   * arrive with reliable coordinates) do not fight the gaze target.
   */
  setGlobalPointerEnabled(on) {
    this.globalPointerEnabled = !!on
    this.driveGaze = !!on
  }

  detach() {
    const b = this._bound
    window.removeEventListener('pointermove', b.move)
    window.removeEventListener('pointerdown', b.down)
    window.removeEventListener('pointerup', b.up)
    window.removeEventListener('pointercancel', b.up)
    window.removeEventListener('contextmenu', b.ctx)
    window.removeEventListener('pointerleave', b.leave)
    window.removeEventListener('blur', b.blur)
    window.removeEventListener('resize', b.resize)
    window.removeEventListener('keydown', b.key)
    this._unsubPointer?.()
    if (this._raf) cancelAnimationFrame(this._raf)
    this._raf = null
  }

  /* ---------------------------------------------------------------- *
   * Click-through control
   * ---------------------------------------------------------------- */
  _setInteractive(next) {
    if (next === this.interactive) return
    this.interactive = next
    window.pet?.win?.setInteractive(next)
    if (next) this._lastHeartbeat = performance.now()
    bus.emit('input:interactive', { interactive: next })
  }

  _heartbeat() {
    // Main process falls back to click-through if this stops arriving.
    if (this.interactive && performance.now() - this._lastHeartbeat > 1200) {
      this._lastHeartbeat = performance.now()
      window.pet?.win?.setInteractive(true)
    }
  }

  /* ---------------------------------------------------------------- *
   * Pointer bookkeeping
   * ---------------------------------------------------------------- */
  _onMove(e) {
    this._lastPointerEventAt = performance.now()
    this.pointer.x = e.clientX
    this.pointer.y = e.clientY
    this.pointer.inside = true
    // Feed the gaze controller — this is what makes her eyes follow the cursor.
    if (this.driveGaze) this.pet.setPointer(e.clientX, e.clientY)

    if (this.dragging) {
      const dx = e.clientX - this.dragLast.x
      const dy = e.clientY - this.dragLast.y
      this.dragLast = { x: e.clientX, y: e.clientY }
      this.dragMoved += Math.hypot(dx, dy)
      if (this.dragMoved > 3) {
        this.pet.nudge(dx, dy)
        bus.emit('input:drag-move', { x: e.clientX, y: e.clientY })
      }
      this._dirty = true
      return
    }

    if (this.petting) this._stroke(e)
    this._dirty = true
  }

  _onLeave() {
    // Do NOT clear the gaze target here: moving onto the taskbar (outside this
    // window's clamped bounds) fires pointerleave, and clearing it would make
    // her stop following the cursor entirely. The main-process cursor feed is
    // authoritative, so just stop treating it as "over the pet".
    this.pointer.inside = false
    this.overModel = false
    this.pet.stage.layer?.classList.remove('pettable')
    this._setInteractive(false)
  }

  _onDown(e) {
    this.pointerDown = true
    this._lastPointerEventAt = performance.now()
    const s = this.getSettings()
    const overModel = this.overModel
    const uiTarget = this._isUIAt(e.clientX, e.clientY)

    // Middle-button, right-button and Alt+left drag the pet around.
    const wantsDrag = e.button === 1 || e.button === 2 || (e.button === 0 && e.altKey)
    if (wantsDrag && (overModel || uiTarget === null)) {
      if (overModel) {
        this.dragging = true
        this.dragButton = e.button
        this.dragLast = { x: e.clientX, y: e.clientY }
        this.dragMoved = 0
        this.pet.stage.layer?.classList.add('dragging')
        bus.emit('input:drag-start', { x: e.clientX, y: e.clientY })
        e.preventDefault()
        this._setInteractive(true)
        return
      }
    }

    if (e.button === 0 && overModel && s?.petting?.enabled !== false && !this.dragging) {
      if (uiTarget) {
        // A real UI element is on top — let it handle the click.
        return
      }
      this._startPet(e)
    }
    this._dirty = true
  }

  _onUp(e) {
    this.pointerDown = false
    if (this.dragging) {
      const wasClick = this.dragMoved <= 3
      this.dragging = false
      this.pet.stage.layer?.classList.remove('dragging')
      bus.emit('input:drag-end', { x: e.clientX, y: e.clientY })
      if (wasClick && e.button === 2) {
        bus.emit('input:context-menu', { x: e.clientX, y: e.clientY })
      }
      this._dirty = true
      return
    }
    if (this.petting) this._endPet(e)
    this._dirty = true
  }

  _onContextMenu(e) {
    // Suppress the native menu everywhere; the pet raises its own.
    e.preventDefault()
    if (!this.dragging && this.overModel) {
      bus.emit('input:context-menu', { x: e.clientX, y: e.clientY })
    }
  }

  _onKey(e) {
    if (e.key === 'Escape') {
      if (this.petting) this._endPet({ clientX: this.pointer.x, clientY: this.pointer.y })
      if (this.dragging) {
        this.dragging = false
        this.pet.stage.layer?.classList.remove('dragging')
        bus.emit('input:drag-end', { x: this.pointer.x, y: this.pointer.y })
      }
    }
  }

  _releaseAll(reason) {
    if (this.petting) this._endPet({ clientX: this.pointer.x, clientY: this.pointer.y }, reason)
    if (this.dragging) {
      this.dragging = false
      this.pet.stage.layer?.classList.remove('dragging')
      bus.emit('input:drag-end', { x: this.pointer.x, y: this.pointer.y })
    }
    this.pointerDown = false
  }

  /* ---------------------------------------------------------------- *
   * Petting
   * ---------------------------------------------------------------- */
  _isHead(clientY) {
    const b = this.pet.getModelBounds()
    if (!b) return false
    return (clientY - b.top) / Math.max(b.height, 1) < HEAD_FRACTION
  }

  _startPet(e) {
    this.petting = true
    this.petStartAt = performance.now()
    this.petDistance = 0
    this.lastStrokeAt = 0
    this.petHead = this._isHead(e.clientY)
    this.pet.setPettingVisual(true, { head: this.petHead })
    bus.emit('input:pet-start', { x: e.clientX, y: e.clientY, head: this.petHead })
    this._setInteractive(true)
    e.preventDefault()
  }

  _stroke(e) {
    const now = performance.now()
    if (!this.lastStrokeAt) {
      this.lastStrokeAt = now
      this.strokeBurst = 0
      return
    }
    const dt = Math.max(now - this.lastStrokeAt, 1)
    this.lastStrokeAt = now

    // Approximate distance travelled since the previous sample.
    const cfg = this.getSettings()?.petting || {}
    const minDist = Math.max(1, Number(cfg.minStrokeDistance) || 6)
    const d = clamp((e.movementX ?? 0) ** 2 + (e.movementY ?? 0) ** 2, 0, 100000) ** 0.5 || 4
    this.petDistance += d
    this.strokeBurst += d

    const speed = d / dt // px per ms
    const intensity = clamp(speed / 1.6, 0.15, 1)
    this.pet.setPetIntensity(intensity)

    if (this.strokeBurst >= minDist) {
      const distance = this.strokeBurst
      this.strokeBurst = 0
      bus.emit('input:pet-stroke', {
        x: e.clientX,
        y: e.clientY,
        head: this.petHead,
        distance,
        intensity,
        speed,
        total: this.petDistance,
      })
    }
  }

  _endPet(e, reason = 'up') {
    const duration = performance.now() - this.petStartAt
    const total = this.petDistance
    this.petting = false
    this.pet.setPettingVisual(false)
    this.pet.setPetIntensity(0)
    bus.emit('input:pet-end', {
      x: e?.clientX ?? this.pointer.x,
      y: e?.clientY ?? this.pointer.y,
      head: this.petHead,
      duration,
      total,
      reason,
    })
    this._dirty = true
  }

  /* ---------------------------------------------------------------- *
   * Per-frame hit testing
   * ---------------------------------------------------------------- */
  _loop() {
    this._raf = requestAnimationFrame(() => this._loop())
    this._heartbeat()
    if (!this._dirty || this._hitBusy) return
    this._dirty = false

    const x = this.pointer.x
    const y = this.pointer.y
    // Safety net: keep the gaze target in sync even if a move event was missed.
    if (this.driveGaze) this.pet.setPointer(x, y)
    this._hitBusy = true
    this.pet
      .hitTest(x, y)
      .then((alpha) => {
        this._hitBusy = false
        if (x !== this.pointer.x || y !== this.pointer.y) {
          this._dirty = true // pointer moved while we were testing
        }
        this.alpha = alpha
        const wasOver = this.overModel
        this.overModel = alpha > 0.06
        if (wasOver !== this.overModel) {
          this.pet.stage.layer?.classList.toggle('pettable', this.overModel)
          bus.emit('input:hover', { over: this.overModel, alpha })
        }
        this._evaluateInteractivity()
      })
      .catch(() => {
        this._hitBusy = false
      })
  }

  /** Returns the interactive element under the point, or null. */
  _isUIAt(x, y) {
    const el = document.elementFromPoint(x, y)
    if (!el) return null
    const tag = el.tagName
    if (tag === 'BODY' || tag === 'HTML' || el.id === 'app' || el.id === 'pet-layer' || el.id === 'fx-layer' || tag === 'CANVAS') {
      return null
    }
    return el
  }

  _evaluateInteractivity() {
    if (this.getSettings()?.display?.clickThrough === false) {
      // "Always interactive" mode: the window captures clicks everywhere in it.
      this.overUI = !!this._isUIAt(this.pointer.x, this.pointer.y)
      this._setInteractive(true)
      return
    }
    const ui = this._isUIAt(this.pointer.x, this.pointer.y)
    this.overUI = !!ui
    const next =
      this.overUI ||
      this.overModel ||
      this.petting ||
      this.dragging ||
      this.pointerDown
    this._setInteractive(next)
  }

  /** Forces a re-evaluation (e.g. after a panel opens/closes under the cursor). */
  refresh() {
    this._dirty = true
  }
}
