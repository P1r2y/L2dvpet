/**
 * SpeechBubble — the character's dialogue bubble. It tracks the model's head
 * every frame (throttled) and flips/clamps itself so it always stays on screen.
 */
import { clamp, truncate } from '../core/util.js'

export class SpeechBubble {
  constructor({ pet, el, textEl, actionsEl, getSettings }) {
    this.pet = pet
    this.el = el
    this.textEl = textEl
    this.actionsEl = actionsEl
    this.getSettings = getSettings
    this.visible = false
    this.hideTimer = null
    this._raf = null
    this._lastLayout = 0
    this.onAction = null
    this.text = ''

    actionsEl?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-bubble-action]')
      if (!btn) return
      this.onAction?.(btn.dataset.bubbleAction, this)
    })
  }

  /**
   * @param {string} text
   * @param {{duration?:number, actions?:boolean, keep?:boolean}} [opts]
   */
  show(text, opts = {}) {
    const clean = String(text || '').trim()
    if (!clean) return
    this.text = clean
    this.textEl.textContent = truncate(clean, 320)
    this.el.classList.remove('hidden')
    this.visible = true
    if (this.actionsEl) this.actionsEl.classList.toggle('hidden', !opts.actions)

    // restart the entrance animation
    this.el.style.animation = 'none'
    void this.el.offsetHeight
    this.el.style.animation = ''

    this.layout()
    this.startTracking()

    if (this.hideTimer) clearTimeout(this.hideTimer)
    const d = opts.duration ?? Number(this.getSettings()?.chat?.bubbleDuration ?? 9)
    if (d > 0 && !opts.keep) {
      this.hideTimer = setTimeout(() => this.hide(), Math.max(1.5, d) * 1000)
    }
  }

  append(chunk) {
    if (!this.visible) {
      this.show(chunk)
      return
    }
    this.text += chunk
    this.textEl.textContent = truncate(this.text, 320)
    this.layout()
  }

  setText(text) {
    this.text = String(text || '')
    this.textEl.textContent = truncate(this.text, 320)
    this.layout()
  }

  hide() {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer)
      this.hideTimer = null
    }
    this.visible = false
    this.el.classList.add('hidden')
    this.stopTracking()
  }

  startTracking() {
    if (this._raf) return
    const loop = () => {
      this._raf = requestAnimationFrame(loop)
      const now = performance.now()
      if (now - this._lastLayout < 90) return
      this._lastLayout = now
      this.layout()
    }
    this._raf = requestAnimationFrame(loop)
  }

  stopTracking() {
    if (this._raf) cancelAnimationFrame(this._raf)
    this._raf = null
  }

  layout() {
    if (!this.visible) return
    const head = this.pet.getHeadAnchor()
    const bounds = head.modelBounds
    const w = this.el.offsetWidth || 240
    const h = this.el.offsetHeight || 60
    const margin = 12
    const gap = 10

    // getModelBounds() hands back left/top/width/height only — there is no
    // `right`/`bottom`, and reading them yields undefined, which poisons the
    // layout into NaN and leaves the bubble stuck where it was last painted.
    const left0 = bounds ? bounds.left : head.x - head.radius
    const right0 = bounds ? bounds.left + bounds.width : head.x + head.radius
    const top0 = bounds ? bounds.top : head.y - head.radius
    const bottom0 = bounds ? bounds.top + bounds.height : head.y + head.radius

    /*
     * The bubble hangs off the model's top-right corner: its left edge starts at
     * the model's right edge and its bottom sits just above the model's head, so
     * it reads as speech coming from beside her. It mirrors to the top-left when
     * the right side of the screen is too narrow, and drops below the model when
     * there is no room above.
     */
    const fitsRight = left0 >= 0 && right0 + gap + w <= window.innerWidth - margin
    this.el.classList.toggle('tail-right', !fitsRight)
    let left = fitsRight
      ? right0 + gap
      : clamp(right0 - w, margin, Math.max(margin, window.innerWidth - w - margin))

    let top = top0 - h - gap
    let below = false
    if (top < margin) {
      top = clamp(bottom0 + gap, margin, Math.max(margin, window.innerHeight - h - margin))
      below = true
    }
    this.el.classList.toggle('below', below)

    this.el.style.left = `${Math.round(left)}px`
    this.el.style.top = `${Math.round(top)}px`

    // Point the tail at the head (measured from whichever edge it sits on).
    const tail = this.el.querySelector('.bubble-tail')
    if (tail) {
      const maxOff = Math.max(20, w - 36)
      if (this.el.classList.contains('tail-right')) {
        tail.style.right = `${Math.round(clamp(left + w - head.x - 9, 18, maxOff))}px`
        tail.style.left = 'auto'
      } else {
        tail.style.left = `${Math.round(clamp(head.x - left - 9, 18, maxOff))}px`
        tail.style.right = 'auto'
      }
    }
  }
}
