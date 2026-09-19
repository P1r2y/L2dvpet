/**
 * GazeController — drives eye-ball, head and body angles so the character
 * follows the mouse with a *small* amplitude, plus idle drift and micro
 * saccades so the eyes never look robotic.
 *
 * Amplitude limits are fractions of the ranges psd2live bakes into the model
 * (ParamAngleX ±45°, ParamAngleY ±30°, ParamBodyAngleX/Y ±10° — see
 * `params.js` and the psd2live parameter spec). Head yaw therefore tops out at
 * 31% of the rig's travel by default, which keeps the gaze subtle as intended
 * while leaving the rest of the range for the authored nod/shake motions.
 *
 * Output values are contributed *additively* by PetStage, so they compose with
 * those motions instead of replacing them.
 */
import { clamp, smoothFactor } from '../core/util.js'

const DEFAULTS = {
  enabled: true,
  intensity: 0.6,
  eyeAmount: 1,
  eyeMax: 0.7,
  headAmount: 0.45,
  // psd2live's 9-pose lat/long grid: ParamAngleX is keyed at ±45°, so this is 31% of travel.
  headYawMax: 14,
  // ParamAngleY range is ±30°.
  headPitchMax: 9,
  bodyAmount: 0.2,
  // ParamBodyAngleX/Y range is ±10°.
  bodyMax: 5,
  smoothing: 0.14,
  distanceFalloff: true,
  maxDistance: 1100,
  idleDrift: true,
  driftAmount: 0.28,
  driftSpeed: 0.35,
  saccade: true,
  saccadeMin: 1.4,
  saccadeMax: 4.5,
  invertX: false,
  invertY: false,
}

/** Travel available on this model, used to keep the defaults proportionate. */
export const RIG_TRAVEL = {
  headYawDeg: 45,
  headPitchDeg: 30,
  headRollDeg: 30,
  bodyDeg: 10,
}

export class GazeController {
  constructor() {
    this.cfg = { ...DEFAULTS }
    // smoothed current value
    this.cur = { x: 0, y: 0 }
    this.drift = { x: 0, y: 0 }
    this.saccade = { x: 0, y: 0 }
    this.t = 0
    this.nextSaccadeAt = 1
    this.saccadeUntil = 0
    /** Optional scripted override target (normalized -1..1). */
    this.override = null
    this.overrideUntil = 0
    /** While true, gaze relaxes to centre (e.g. while being petted). */
    this.suppressed = false
    /** How strongly the head follows the cursor while petting, 0..1
     * (Settings → Petting → Head follows cursor). */
    this.pettingFollow = 0
    this.output = { eyeX: 0, eyeY: 0, headX: 0, headY: 0, headZ: 0, bodyX: 0, bodyY: 0 }
  }

  applySettings(gazeSettings) {
    this.cfg = { ...DEFAULTS, ...(gazeSettings || {}) }
  }

  /** Scripted look-at for `durationMs`, in normalized -1..1 space. */
  lookAt(x, y, durationMs = 1200) {
    this.override = { x: clamp(x, -1, 1), y: clamp(y, -1, 1) }
    this.overrideUntil = performance.now() + durationMs
  }

  suppress(on) {
    this.suppressed = !!on
  }

  /**
   * While the pet is being stroked the eyes stop tracking — darting pupils with
   * a hand on her head read as broken — but the head keeps following the cursor
   * at this strength (Settings → Petting → Head follows cursor). 0 keeps the old behaviour of
   * a fully parked head.
   */
  setPettingFollow(amount) {
    this.pettingFollow = clamp(Number(amount) ?? 0, 0, 1)
  }

  /**
   * @param {number} dt seconds
   * @param {object} ctx
   * @param {{x:number,y:number}|null} ctx.pointer client coords of the cursor
   * @param {{x:number,y:number,radius:number}} ctx.origin head anchor on screen
   * @param {{width:number,height:number}} ctx.screen
   */
  update(dt, ctx) {
    const cfg = this.cfg
    const now = performance.now()
    this.t += dt

    let tx = 0
    let ty = 0
    let falloff = 1

    const pointer = ctx.pointer
    if (this.override && now < this.overrideUntil) {
      tx = this.override.x
      ty = this.override.y
    } else if (pointer && cfg.enabled && (!this.suppressed || this.pettingFollow > 0)) {
      const dx = pointer.x - ctx.origin.x
      const dy = pointer.y - ctx.origin.y
      const ref = Math.max(ctx.screen.height * 0.55, 260)
      tx = dx / ref
      ty = -dy / ref // screen Y grows downward; model Y is up-positive
      const mag = Math.hypot(tx, ty)
      if (mag > 1) {
        tx /= mag
        ty /= mag
      }
      if (cfg.distanceFalloff) {
        const dist = Math.hypot(dx, dy)
        const inner = ref * 0.6
        const outer = Math.max(Number(cfg.maxDistance) || 1100, inner + 1)
        // Never drops below 35%: the pet keeps glancing at a far cursor.
        falloff = clamp(1 - (dist - inner) / (outer - inner), 0.35, 1)
      }
    }
    if (this.override && now >= this.overrideUntil) this.override = null

    if (cfg.invertX) tx = -tx
    if (cfg.invertY) ty = -ty

    /* ---- idle drift: two summed sines per axis, cheap 1-D value noise ---- */
    let driftX = 0
    let driftY = 0
    if (cfg.idleDrift) {
      const s = (Number(cfg.driftSpeed) || 0.35) * 0.6
      const a = Number(cfg.driftAmount) || 0.28
      driftX = (Math.sin(this.t * 0.31 * s) * 0.55 + Math.sin(this.t * 0.17 * s + 1.3) * 0.3) * a
      driftY = (Math.cos(this.t * 0.23 * s + 0.7) * 0.5 + Math.sin(this.t * 0.41 * s + 2.1) * 0.25) * a
    }

    /* ---- micro saccades: tiny involuntary jumps of the eye ---- */
    let saccadeX = 0
    let saccadeY = 0
    if (cfg.saccade && !this.suppressed) {
      if (now >= this.nextSaccadeAt) {
        const lo = Number(cfg.saccadeMin) || 1.4
        const hi = Math.max(lo + 0.2, Number(cfg.saccadeMax) || 4.5)
        this.nextSaccadeAt = now + (lo + Math.random() * (hi - lo)) * 1000
        this.saccade = { x: (Math.random() - 0.5) * 0.13, y: (Math.random() - 0.5) * 0.09 }
        this.saccadeUntil = now + 220
      }
      if (now < this.saccadeUntil) {
        saccadeX = this.saccade.x
        saccadeY = this.saccade.y
      }
    }

    /* ---- smoothing toward the combined target ---- */
    const k = smoothFactor(clamp(Number(cfg.smoothing) || 0.14, 0.01, 1), dt)
    const targetX = tx * falloff + driftX + saccadeX
    const targetY = ty * falloff + driftY + saccadeY
    this.cur.x += (targetX - this.cur.x) * k
    this.cur.y += (targetY - this.cur.y) * k

    /* ---- map to parameter values ---- */
    const enabled = cfg.enabled !== false
    const intensity = enabled ? clamp(Number(cfg.intensity) ?? 1, 0, 3) : 0
    const x = this.cur.x * intensity
    const y = this.cur.y * intensity

    const eyeMax = Number(cfg.eyeMax) || 0.7
    const out = this.output
    out.eyeX = clamp(x * (Number(cfg.eyeAmount) ?? 1), -eyeMax, eyeMax)
    out.eyeY = clamp(y * (Number(cfg.eyeAmount) ?? 1), -eyeMax * 0.75, eyeMax * 0.75)

    const yawMax = Number(cfg.headYawMax) || 14
    const pitchMax = Number(cfg.headPitchMax) || 9
    out.headX = clamp(x * (Number(cfg.headAmount) ?? 0.45) * yawMax, -yawMax, yawMax)
    out.headY = clamp(y * (Number(cfg.headAmount) ?? 0.45) * pitchMax, -pitchMax, pitchMax)
    // Subtle roll: looking up-left / down-right tilts the head.
    out.headZ = clamp(out.eyeX * out.eyeY * -yawMax * 0.9, -yawMax, yawMax)

    const bodyMax = Number(cfg.bodyMax) || 5
    out.bodyX = clamp(x * (Number(cfg.bodyAmount) ?? 0.2) * bodyMax, -bodyMax, bodyMax)
    out.bodyY = clamp(y * (Number(cfg.bodyAmount) ?? 0.2) * bodyMax * 0.5, -bodyMax, bodyMax)

    /*
     * While petting: the eyes stop, and the head and body follow slightly per
     * "Head follows cursor". Scaling the finished
     * output keeps the follow proportional to whatever the gaze settings already
     * produce, so no second set of amounts has to be kept in sync.
     */
    if (this.suppressed) {
      const f = this.pettingFollow
      out.eyeX = 0
      out.eyeY = 0
      out.headX *= f
      out.headY *= f
      out.headZ *= f
      out.bodyX *= f
      out.bodyY *= f
    }
    return out
  }
}
