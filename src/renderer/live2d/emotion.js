/**
 * EmotionController — this model ships no .exp3.json expressions, so emotions
 * are expressed directly through parameters (mouth shape, eye openness, brows
 * and head tilt) and blended smoothly between states.
 */
import { clamp, smoothFactor } from '../core/util.js'

/** Parameter targets per emotion. eyeOpen/browY are absolute; the rest is additive. */
const PRESETS = {
  neutral: { eyeOpen: 1.0, mouthForm: 0.0, browY: 0, headZ: 0, headY: 0, bodyZ: 0 },
  smile: { eyeOpen: 0.9, mouthForm: 0.75, browY: 0.25, headZ: 3, headY: 1, bodyZ: 0 },
  happy: { eyeOpen: 0.78, mouthForm: 0.95, browY: 0.45, headZ: -2.5, headY: 3, bodyZ: 1.5 },
  sad: { eyeOpen: 0.62, mouthForm: -0.7, browY: -0.75, headZ: 4, headY: -5, bodyZ: -2 },
  angry: { eyeOpen: 0.8, mouthForm: -0.8, browY: -1.0, headZ: -3, headY: 2, bodyZ: 0 },
  surprised: { eyeOpen: 1.0, mouthForm: 0.2, browY: 0.9, headZ: 0, headY: 5, bodyZ: 0 },
  shy: { eyeOpen: 0.55, mouthForm: 0.35, browY: -0.2, headZ: 7, headY: -4, bodyZ: 2.5 },
  think: { eyeOpen: 0.85, mouthForm: -0.15, browY: -0.15, headZ: -5, headY: 4, bodyZ: 0 },
  love: { eyeOpen: 0.65, mouthForm: 0.9, browY: 0.5, headZ: 5, headY: 4, bodyZ: 3 },
  sleepy: { eyeOpen: 0.35, mouthForm: 0.1, browY: -0.3, headZ: 3, headY: -6, bodyZ: 0 },
}

export const EMOTION_NAMES = Object.keys(PRESETS)

/** Normalises free-form model output into one of our preset keys. */
export function normalizeEmotion(raw) {
  const e = String(raw || '').toLowerCase().trim()
  if (!e) return 'neutral'
  if (PRESETS[e]) return e
  const aliases = {
    joy: 'happy',
    glad: 'happy',
    cheerful: 'happy',
    excited: 'happy',
    pleased: 'smile',
    friendly: 'smile',
    grin: 'smile',
    unhappy: 'sad',
    sorrow: 'sad',
    down: 'sad',
    cry: 'sad',
    mad: 'angry',
    annoyed: 'angry',
    upset: 'angry',
    shock: 'surprised',
    surprise: 'surprised',
    amazed: 'surprised',
    embarrassed: 'shy',
    bashful: 'shy',
    blush: 'shy',
    thinking: 'think',
    curious: 'think',
    ponder: 'think',
    affection: 'love',
    loving: 'love',
    tired: 'sleepy',
    calm: 'neutral',
    normal: 'neutral',
  }
  return aliases[e] || 'neutral'
}

export class EmotionController {
  constructor() {
    this.current = 'neutral'
    this.cur = { ...PRESETS.neutral }
    this.target = { ...PRESETS.neutral }
    this.holdUntil = 0
    this.returnTo = 'neutral'
  }

  /** @param {string} name @param {number} holdMs how long to stay before relaxing */
  set(name, holdMs = 6000) {
    const key = normalizeEmotion(name)
    const preset = PRESETS[key] || PRESETS.neutral
    this.current = key
    this.target = { ...preset }
    this.holdUntil = performance.now() + holdMs
  }

  /** Pins an emotion without auto-relax (used by petting). */
  setSticky(name) {
    const key = normalizeEmotion(name)
    this.current = key
    this.target = { ...(PRESETS[key] || PRESETS.neutral) }
    this.holdUntil = Infinity
  }

  relax(afterMs = 0) {
    this.holdUntil = performance.now() + afterMs
  }

  reset() {
    this.current = 'neutral'
    this.target = { ...PRESETS.neutral }
    this.holdUntil = 0
  }

  update(dt) {
    if (Number.isFinite(this.holdUntil) && performance.now() > this.holdUntil) {
      this.target = { ...PRESETS.neutral }
      this.current = 'neutral'
      this.holdUntil = 0
    }
    const k = smoothFactor(0.12, dt)
    for (const key of Object.keys(this.cur)) {
      this.cur[key] += (this.target[key] - this.cur[key]) * k
    }
    return this.cur
  }

  /** Eye-open multiplier so emotions and blinks compose correctly. */
  get eyeScale() {
    return clamp(this.cur.eyeOpen, 0.05, 1)
  }
}
