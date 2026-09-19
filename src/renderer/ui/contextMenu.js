/** Right-click menu shown over the pet. */
import { el } from '../core/util.js'

export class ContextMenu {
  constructor(container) {
    this.el = container
    this.open = false
    this._onDocDown = (e) => {
      if (this.open && !this.el.contains(e.target)) this.hide()
    }
    this._onKey = (e) => {
      if (e.key === 'Escape') this.hide()
    }
    document.addEventListener('pointerdown', this._onDocDown, true)
    document.addEventListener('keydown', this._onKey)
    window.addEventListener('blur', () => this.hide())
  }

  /**
   * @param {number} x @param {number} y
   * @param {Array<{label?:string, icon?:string, action?:Function, type?:'sep'|'item', danger?:boolean, checked?:boolean, key?:string}>} items
   */
  show(x, y, items) {
    this.el.textContent = ''
    for (const item of items) {
      if (item.type === 'sep') {
        this.el.appendChild(el('div', { class: 'ctx-sep' }))
        continue
      }
      const row = el(
        'div',
        {
          class: `ctx-item${item.danger ? ' danger' : ''}`,
          onclick: () => {
            this.hide()
            item.action?.()
          },
        },
        el('span', { text: item.checked ? '✔' : item.icon || '' , style: { width: '14px', display: 'inline-block' } }),
        el('span', { text: item.label || '' }),
        item.key ? el('span', { class: 'ctx-key', text: item.key }) : null
      )
      this.el.appendChild(row)
    }
    this.el.classList.remove('hidden')
    this.open = true

    // Measure then clamp into the viewport.
    const r = this.el.getBoundingClientRect()
    const left = Math.min(x, window.innerWidth - r.width - 8)
    const top = Math.min(y, window.innerHeight - r.height - 8)
    this.el.style.left = `${Math.max(8, left)}px`
    this.el.style.top = `${Math.max(8, top)}px`
  }

  hide() {
    if (!this.open) return
    this.open = false
    this.el.classList.add('hidden')
  }
}
