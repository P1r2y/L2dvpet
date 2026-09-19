/**
 * QuickDock — the little button column that fades in beside the pet and gives
 * one-click access to chat, microphone, voice and settings.
 */
export class QuickDock {
  constructor({ el, pet }) {
    this.el = el
    this.pet = pet
    this._raf = null
    this._last = 0
    this.handlers = new Map()
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]')
      if (!btn) return
      const fn = this.handlers.get(btn.dataset.action)
      if (fn) fn()
    })
  }

  on(action, fn) {
    this.handlers.set(action, fn)
    return this
  }

  setActive(action, active) {
    const btn = this.el.querySelector(`[data-action="${action}"]`)
    btn?.classList.toggle('active', !!active)
  }

  setIcon(action, glyph) {
    const span = this.el.querySelector(`[data-action="${action}"] span`)
    if (span) span.textContent = glyph
  }

  show() {
    this.el.classList.remove('hidden')
    this.el.classList.add('visible')
    this._follow()
  }

  hide() {
    this.el.classList.remove('visible')
    setTimeout(() => {
      if (!this.el.classList.contains('visible')) this.el.classList.add('hidden')
    }, 220)
  }

  _follow() {
    if (this._raf) return
    const loop = () => {
      this._raf = requestAnimationFrame(loop)
      const now = performance.now()
      if (now - this._last < 90) return
      this._last = now
      const b = this.pet.getModelBounds()
      if (!b) return
      const w = this.el.offsetWidth || 38
      const h = this.el.offsetHeight || 190
      let left = b.left + b.width + 8
      if (left + w > window.innerWidth - 6) left = b.left - w - 8
      left = Math.max(6, Math.min(left, window.innerWidth - w - 6))
      const top = Math.max(6, Math.min(b.top + b.height * 0.36, window.innerHeight - h - 6))
      this.el.style.left = `${Math.round(left)}px`
      this.el.style.top = `${Math.round(top)}px`
    }
    this._raf = requestAnimationFrame(loop)
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf)
    this._raf = null
  }
}
