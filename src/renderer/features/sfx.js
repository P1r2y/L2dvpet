/**
 * SfxService — the pet's own interaction sounds, synthesised rather than loaded.
 *
 * The repository ships no audio assets: models, voices and art all stay on the
 * machine that made them. A head-pat only needs one short, soft sound anyway, so
 * the "pat" is generated with Web Audio — a filtered noise burst with a fast
 * decay, which reads as a hand brushing hair rather than a drum hit.
 */

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0))

export class SfxService {
  constructor({ getSettings } = {}) {
    this.getSettings = getSettings || (() => ({}))
    this.ctx = null
    this._lastPat = 0
  }

  /** Settings → Petting → Petting sound, and the shared voice volume. */
  _config() {
    const s = this.getSettings() || {}
    return {
      enabled: s.petting?.sound !== false,
      volume: clamp01(s.voice?.volume ?? 0.9),
    }
  }

  /**
   * Created lazily, and resumed on use: browsers (and Electron) start an
   * AudioContext suspended until a user gesture, and the first pat IS that
   * gesture — so resuming here is enough.
   */
  _context() {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return null
    if (!this.ctx) this.ctx = new Ctx()
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {})
    return this.ctx
  }

  /**
   * A soft pat.
   *
   * @param {number} strength 0..1 — scales level and brightness
   * @param {{minGapMs?:number}} [opts] rate limit, so a long stroke reads as a
   *   rhythm instead of machine-gun fire
   * @returns {boolean} whether a sound was actually started
   */
  pat(strength = 1, { minGapMs = 340 } = {}) {
    const { enabled, volume } = this._config()
    if (!enabled || volume <= 0) return false

    const now = performance.now()
    if (now - this._lastPat < minGapMs) return false
    const ctx = this._context()
    if (!ctx) return false
    this._lastPat = now

    const s = clamp01(strength)
    const duration = 0.085 + 0.035 * s
    const start = ctx.currentTime

    // Noise with a steep decay — the body of the sound.
    const frames = Math.max(1, Math.floor(ctx.sampleRate * duration))
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < frames; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / frames, 2.6)
    }

    const source = ctx.createBufferSource()
    source.buffer = buffer

    // Lowpass keeps it soft; a harder stroke opens it up a little.
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 900 + 900 * s

    const gain = ctx.createGain()
    const peak = (0.1 + 0.12 * s) * volume
    gain.gain.setValueAtTime(0, start)
    gain.gain.linearRampToValueAtTime(peak, start + 0.008)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)

    source.connect(filter)
    filter.connect(gain)
    gain.connect(ctx.destination)
    source.start(start)
    source.stop(start + duration + 0.02)
    return true
  }

  /** Releases the audio context (window teardown). */
  dispose() {
    try {
      this.ctx?.close()
    } catch {
      /* ignore */
    }
    this.ctx = null
  }
}
