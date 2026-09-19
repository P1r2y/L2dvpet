/**
 * Idle behaviours: automatic blinking and random idle motions.
 */
import { clamp, rand } from '../core/util.js'

/**
 * Produces a 0..1 "eye open" value. 1 = wide open, 0 = fully closed.
 * Blinks are shaped with a sine arc so they read naturally, and occasionally
 * fire twice in a row the way real blinks do.
 */
export class BlinkController {
  constructor() {
    this.cfg = {
      autoBlink: true,
      blinkMin: 2.4,
      blinkMax: 6.5,
      blinkDuration: 0.12,
      doubleBlinkChance: 0.22,
    }
    this.phase = 'idle' // idle | closing | opening
    this.value = 1
    this.progress = 0
    this.nextAt = rand(1.5, 4)
    this.queueDouble = false
    this.t = 0
    /** Forced eye closing, e.g. while being petted. 1 = no effect. */
    this.scale = 1
  }

  applySettings(idleSettings) {
    this.cfg = { ...this.cfg, ...(idleSettings || {}) }
  }

  /** Immediately trigger a blink (used by "surprised" reactions). */
  trigger(force = false) {
    if (this.phase !== 'idle' && !force) return
    this.phase = 'closing'
    this.progress = 0
  }

  update(dt) {
    const cfg = this.cfg
    this.t += dt

    if (!cfg.autoBlink) {
      // still honour a manually triggered blink
      if (this.phase === 'idle') {
        this.value += (1 - this.value) * Math.min(1, dt * 12)
        return this.value * this.scale
      }
    }

    if (this.phase === 'idle') {
      this.value += (1 - this.value) * Math.min(1, dt * 14)
      if (cfg.autoBlink && this.t >= this.nextAt) {
        this.trigger(true)
      }
      return this.value * this.scale
    }

    const dur = Math.max(0.05, Number(cfg.blinkDuration) || 0.12)
    this.progress += dt / dur

    if (this.phase === 'closing') {
      const p = clamp(this.progress, 0, 1)
      this.value = Math.cos((p * Math.PI) / 2) // 1 → 0
      if (p >= 1) {
        this.phase = 'opening'
        this.progress = 0
      }
    } else {
      const p = clamp(this.progress, 0, 1)
      this.value = Math.sin((p * Math.PI) / 2) // 0 → 1
      if (p >= 1) {
        this.value = 1
        this.phase = 'idle'
        if (this.queueDouble) {
          this.queueDouble = false
          this.nextAt = this.t + 0.13
        } else {
          this.queueDouble = Math.random() < Number(cfg.doubleBlinkChance ?? 0.22)
          this.nextAt = this.t + rand(
            Math.max(0.6, Number(cfg.blinkMin) || 2.4),
            Math.max(1.2, Number(cfg.blinkMax) || 6.5)
          )
        }
      }
    }
    return this.value * this.scale
  }
}

/** Plays random motions from a configured set of groups on a timer. */
export class MotionScheduler {
  constructor(playFn, groupsFn) {
    this.play = playFn
    this.getGroups = groupsFn
    this.cfg = { autoMotion: true, motionMin: 20, motionMax: 45 }
    this.nextAt = null
    this.t = 0
    this.busyUntil = 0
  }

  applySettings(idleSettings) {
    this.cfg = { ...this.cfg, ...(idleSettings || {}) }
    if (this.nextAt === null) this.schedule()
  }

  schedule() {
    const lo = Math.max(3, Number(this.cfg.motionMin) || 20)
    const hi = Math.max(lo + 1, Number(this.cfg.motionMax) || 45)
    this.nextAt = this.t + rand(lo, hi)
  }

  /** Blocks auto motions for `ms` (e.g. while chatting or being petted). */
  hold(ms) {
    this.busyUntil = Math.max(this.busyUntil, performance.now() + ms)
  }

  update(dt) {
    this.t += dt
    if (!this.cfg.autoMotion) return
    if (this.nextAt === null) this.schedule()
    if (performance.now() < this.busyUntil) return
    if (this.t < this.nextAt) return

    this.schedule()
    const groups = (this.getGroups() || []).filter((g) => g && g.toLowerCase() !== 'idle')
    if (!groups.length) return
    // Weight the model's own "Blink" group out — it is handled elsewhere.
    const pool = groups.filter((g) => !/blink/i.test(g))
    const group = (pool.length ? pool : groups)[Math.floor(Math.random() * (pool.length ? pool.length : groups.length))]
    try {
      this.play(group)
    } catch {
      /* ignore */
    }
  }
}
