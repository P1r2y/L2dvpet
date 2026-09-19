/**
 * Heart particles shown while the user strokes the character's head.
 *
 * Deliberately the only effect in the app: hearts appear on head-petting and
 * nowhere else, and there is no score / affection readout attached to them.
 */
import { rand } from '../core/util.js'

const HEARTS = ['💗', '💕', '💖', '💓', '🩷', '♡']

export class EffectsLayer {
  constructor(layer) {
    this.layer = layer
    this.lastSpawn = 0
  }

  /** Converts client coords into this layer's local coordinate space. */
  _local(clientX, clientY) {
    const r = this.layer.getBoundingClientRect()
    return { x: clientX - r.left, y: clientY - r.top }
  }

  /**
   * Spawns a heart at a client point. Rate-limited so a fast stroke does not
   * create hundreds of nodes.
   * @param {number} clientX @param {number} clientY
   * @param {{scale?:number, rate?:number}} [opts]
   */
  heart(clientX, clientY, opts = {}) {
    const rate = Math.max(0.1, Number(opts.rate) || 1)
    const now = performance.now()
    const interval = 110 / rate
    if (now - this.lastSpawn < interval) return false
    this.lastSpawn = now

    const { x, y } = this._local(clientX, clientY)
    const el = document.createElement('div')
    el.className = 'heart'
    el.textContent = HEARTS[Math.floor(Math.random() * HEARTS.length)]
    const scale = (Number(opts.scale) || 1) * rand(0.8, 1.3)
    el.style.left = `${x + rand(-14, 14)}px`
    el.style.top = `${y + rand(-10, 10)}px`
    el.style.fontSize = `${18 * scale}px`
    el.style.setProperty('--dx', `${rand(-40, 40)}px`)
    el.style.animationDuration = `${rand(1.25, 1.8)}s`
    this.layer.appendChild(el)
    setTimeout(() => el.remove(), 1900)
    return true
  }

  clear() {
    this.layer.textContent = ''
  }
}
