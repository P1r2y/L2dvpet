/**
 * SettingsPanel — a VS Code style settings UI.
 *
 * Layout: title bar → search box → [sidebar tree | settings content] → status bar.
 * Each setting row carries a lock toggle; locked settings are read-only and are
 * skipped when a voice preset is applied.
 */
import { $, clamp, debounce, el } from '../../core/util.js'
import { bus } from '../../core/bus.js'
import { toast, toastErr, toastOk } from '../notify.js'
import { VoiceService } from '../../features/voice.js'
import { SETTINGS_TREE, ALL_FIELDS } from './schema.js'

/**
 * Draws a parameter's recent history as a filled sparkline.
 * Dashed guides mark the model's own min/max so an auto limit is visible
 * against the full travel.
 */
function drawCurve(canvas, data, lo, hi) {
  const ctx = canvas.getContext('2d')
  const w = canvas.width
  const h = canvas.height
  if (!ctx) return
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = '#1e1e1e'
  ctx.fillRect(0, 0, w, h)

  const span = Math.max(1e-6, hi - lo)
  const y = (v) => h - 2 - ((Math.max(lo, Math.min(hi, v)) - lo) / span) * (h - 4)

  // zero line
  if (lo < 0 && hi > 0) {
    ctx.strokeStyle = '#3c3c3c'
    ctx.beginPath()
    ctx.moveTo(0, y(0))
    ctx.lineTo(w, y(0))
    ctx.stroke()
  }

  const n = data.length
  ctx.beginPath()
  for (let i = 0; i < n; i++) {
    const px = (i / (n - 1)) * w
    const py = y(data[i])
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.strokeStyle = '#4daafc'
  ctx.lineWidth = 1.2
  ctx.stroke()

  ctx.lineTo(w, h)
  ctx.lineTo(0, h)
  ctx.closePath()
  ctx.fillStyle = 'rgba(0,122,204,0.22)'
  ctx.fill()
}
import presetData from '../../../shared/voice-presets.json'

const VOICE_PRESETS = presetData.presets || []

/* ---------------------------------------------------------------- *
 * Path helpers
 * ---------------------------------------------------------------- */
export function getPath(obj, path) {
  return String(path)
    .split('.')
    .reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

export function setPath(path, value) {
  const parts = String(path).split('.')
  const out = {}
  let cur = out
  parts.forEach((k, i) => {
    if (i === parts.length - 1) cur[k] = value
    else cur = cur[k] = {}
  })
  return out
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** Removes every locked path from a patch, so presets cannot clobber them. */
export function stripLocked(patch, locks, prefix = '') {
  const out = {}
  for (const [k, v] of Object.entries(patch || {})) {
    const path = prefix ? `${prefix}.${k}` : k
    if (locks[path]) continue // whole subtree locked
    if (isPlainObject(v)) {
      const sub = stripLocked(v, locks, path)
      if (Object.keys(sub).length) out[k] = sub
    } else {
      out[k] = v
    }
  }
  return out
}

const fmtValue = (field, value) => {
  if (field.fmt) return String(field.fmt(Number(value)))
  return String(value)
}

export class SettingsPanel {
  constructor({ getSettings, patchSettings, app, chat, voice, onStateChange, getParamRanges, setTrace, getTrace }) {
    this.getSettings = getSettings
    this.patch = patchSettings
    this.app = app
    this.chat = chat
    this.voice = voice
    this.onStateChange = onStateChange
    this.getParamRanges = getParamRanges || (() => ({}))
    /** Tracing is only switched on while the 模型参数 section is on screen. */
    this.setTrace = setTrace
    this.getTrace = getTrace

    this.el = $('#settings-panel')
    this.body = $('#settings-body')
    this.nav = $('#settings-nav')
    this.search = $('#settings-search')
    this.statusEl = $('#settings-status')
    this.countEl = $('#settings-count')

    this.sectionId = 'display'
    this.groupId = null
    this.query = ''
    this.info = null
    this.expanded = new Set(['display'])
    this.presets = VOICE_PRESETS
    /** Live curve canvases, keyed by parameter id. */
    this._curves = new Map()
    this._curveRaf = null
    this._saveSoon = debounce(() => this._flashSaved(), 400)
    this._wire()

    bus.on('ui:open-settings', ({ section, group } = {}) => this.open(section, group))
  }

  /* ---------------------------------------------------------------- *
   * Wiring
   * ---------------------------------------------------------------- */
  _wire() {
    this.nav.addEventListener('click', (e) => {
      const caret = e.target.closest('.vs-caret')
      if (caret) {
        const id = caret.dataset.section
        if (this.expanded.has(id)) this.expanded.delete(id)
        else this.expanded.add(id)
        this._renderNav()
        return
      }
      const link = e.target.closest('[data-nav]')
      if (!link) return
      this.sectionId = link.dataset.section
      this.groupId = link.dataset.group || null
      if (link.dataset.group) this.expanded.add(link.dataset.section)
      this.query = ''
      this.search.value = ''
      this.render()
    })

    this.search.addEventListener('input', () => {
      this.query = this.search.value.trim().toLowerCase()
      this.render()
    })

    this.el.addEventListener('click', async (e) => {
      const lock = e.target.closest('[data-lock]')
      if (lock) {
        e.stopPropagation()
        await this._toggleLock(lock.dataset.lock)
        return
      }
      const btn = e.target.closest('[data-action]')
      if (!btn) return
      const a = btn.dataset.action
      if (a === 'settings-close') this.close()
      else if (a === 'settings-open-file') {
        const p = await window.pet.settings.openFile()
        toast(p, '', 5000)
      } else if (a === 'settings-reset') await this._reset()
    })

    this.body.addEventListener('click', (e) => this._onBodyClick(e))
    this.body.addEventListener('change', (e) => this._onBodyChange(e))
    this.body.addEventListener('input', (e) => this._onBodyChange(e, true))

    this.body.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !e.target.matches('input[type="text"], input[type="password"], input[type="number"]')) return
      e.preventDefault()
      e.target.blur()
      this._onBodyChange({ target: e.target })
    })

    this._wireDrag()
  }

  /** The title bar drags the panel; position is persisted in state.json. */
  _wireDrag() {
    const handle = this.el.querySelector('.vs-titlebar')
    let drag = null
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button') || e.target.closest('input')) return
      const r = this.el.getBoundingClientRect()
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top }
      this.el.style.transform = 'none'
      handle.setPointerCapture(e.pointerId)
      e.preventDefault()
    })
    handle.addEventListener('pointermove', (e) => {
      if (!drag) return
      const r = this.el.getBoundingClientRect()
      const left = clamp(e.clientX - drag.dx, 4, Math.max(4, window.innerWidth - r.width - 4))
      const top = clamp(e.clientY - drag.dy, 4, Math.max(4, window.innerHeight - r.height - 4))
      this.el.style.left = `${Math.round(left)}px`
      this.el.style.top = `${Math.round(top)}px`
    })
    const end = (e) => {
      if (!drag) return
      drag = null
      try {
        handle.releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      const r = this.el.getBoundingClientRect()
      this.onStateChange?.({ uiPos: { settings: { x: Math.round(r.left), y: Math.round(r.top) } } })
    }
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }

  /* ---------------------------------------------------------------- *
   * Locking
   * ---------------------------------------------------------------- */
  locks() {
    return this.getSettings()?.locks || {}
  }

  isLocked(path) {
    /** A parent path being locked locks everything beneath it. */
    const locks = this.locks()
    const parts = String(path).split('.')
    for (let i = 1; i <= parts.length; i++) {
      if (locks[parts.slice(0, i).join('.')]) return true
    }
    return false
  }

  async _toggleLock(path) {
    const locks = { ...this.locks() }
    if (locks[path]) delete locks[path]
    else locks[path] = true
    // `locks` has replace semantics in the store, so an empty object clears it.
    await this.patch({ locks })
    this.render()
    toastOk(locks[path] ? `已锁定 ${path}` : `已解锁 ${path}`, 1600)
  }

  async _unlockAll() {
    await this.patch({ locks: {} })
    this.render()
    toastOk('已全部解锁')
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */
  get visible() {
    return !this.el.classList.contains('hidden')
  }

  async open(section, group) {
    if (!this.info) {
      try {
        this.info = await window.pet.app.info()
      } catch {
        this.info = { version: '?', electron: '?', chrome: '?' }
      }
    }
    if (section) {
      this.sectionId = section
      this.groupId = group || null
      this.expanded.add(section)
    }
    this.el.classList.remove('hidden')
    const saved = this.onStateChange?.()?.uiPos?.settings
    if (saved && (saved.x || saved.y)) {
      const r = this.el.getBoundingClientRect()
      this.el.style.left = `${clamp(saved.x, 4, Math.max(4, window.innerWidth - r.width - 4))}px`
      this.el.style.top = `${clamp(saved.y, 4, Math.max(4, window.innerHeight - r.height - 4))}px`
      this.el.style.transform = 'none'
    }
    this.render()
    bus.emit('ui:panel', { panel: 'settings', open: true })
  }

  close() {
    this.el.classList.add('hidden')
    bus.emit('ui:panel', { panel: 'settings', open: false })
  }

  toggle() {
    if (this.visible) this.close()
    else this.open()
  }

  /* ---------------------------------------------------------------- *
   * Rendering
   * ---------------------------------------------------------------- */
  render() {
    this._renderNav()
    this._renderContent()
    this._loadDynamicOptions()
  }

  _renderNav() {
    this.nav.textContent = ''
    const q = this.query
    for (const section of SETTINGS_TREE) {
      const isOpen = this.expanded.has(section.id) || !!q
      const active = this.sectionId === section.id && !this.groupId
      const row = el(
        'div',
        {
          class: `vs-nav-section${active ? ' active' : ''}`,
          onclick: () => {
            this.sectionId = section.id
            this.groupId = null
            this.expanded.add(section.id)
            this.query = ''
            this.search.value = ''
            this.render()
          },
        },
        el('span', {
          class: 'vs-caret',
          dataset: { section: section.id },
          text: isOpen ? '▾' : '▸',
        }),
        el('span', { text: section.label })
      )
      this.nav.appendChild(row)

      if (!isOpen || section.groups.length <= 1) continue
      for (const group of section.groups) {
        const gActive = this.sectionId === section.id && this.groupId === group.id
        this.nav.appendChild(
          el('div', {
            class: `vs-nav-group${gActive ? ' active' : ''}`,
            text: group.label,
            onclick: () => {
              this.sectionId = section.id
              this.groupId = group.id
              this.expanded.add(section.id)
              this.query = ''
              this.search.value = ''
              this.render()
            },
          })
        )
      }
    }
  }

  _visibleGroups() {
    const q = this.query
    const out = []
    for (const section of SETTINGS_TREE) {
      if (q) {
        const groups = section.groups
          .map((g) => ({
            ...g,
            fields: g.fields.filter((f) => this._matches(f, section, g, q)),
          }))
          .filter((g) => g.fields.length)
        if (groups.length) out.push({ section, groups, heading: true })
        continue
      }
      if (section.id !== this.sectionId) continue
      const groups = this.groupId ? section.groups.filter((g) => g.id === this.groupId) : section.groups
      out.push({ section, groups, heading: !this.groupId })
    }
    return out
  }

  _matches(field, section, group, q) {
    if (!field.key) return false
    const hay = `${section.label} ${group.label} ${field.label} ${field.key}`.toLowerCase()
    return hay.includes(q)
  }

  _renderContent() {
    const keep = this.body.scrollTop
    this.body.textContent = ''
    // Curve canvases are rebuilt below; drop the stale references first.
    if (this._curveRaf) cancelAnimationFrame(this._curveRaf)
    this._curveRaf = null
    this._curves.clear()
    const blocks = this._visibleGroups()

    if (!blocks.length) {
      this.body.appendChild(el('div', { class: 'vs-empty', text: '没有匹配的设置' }))
      this.countEl.textContent = '0 项'
      return
    }

    let count = 0
    for (const { section, groups, heading } of blocks) {
      if (heading) {
        this.body.appendChild(el('h2', { class: 'vs-h1', text: section.label }))
        const leaves = section.groups.map((g) => g.label).join('、')
        if (leaves) this.body.appendChild(el('div', { class: 'vs-sub', text: leaves }))
      } else if (groups.length) {
        this.body.appendChild(el('h2', { class: 'vs-h1', text: `${section.label} · ${groups[0].label}` }))
        const sub = groups[0].sub
        if (sub) this.body.appendChild(el('div', { class: 'vs-sub', text: sub }))
      }

      for (const group of groups) {
        // When a section is shown whole, each group gets its own small heading.
        if (heading && blocks.length && section.groups.length > 1) {
          this.body.appendChild(el('div', { class: 'vs-h2', text: group.label }))
        }
        for (const f of group.fields) {
          const row = this._renderField(f)
          if (row) {
            this.body.appendChild(row)
            if (f.key) count++
          }
        }
      }
      if (this.sectionId === 'locks') this._renderLockList()
      if (this.sectionId === 'params') {
        this._refreshRigRanges()
        this._startCurveLoop()
      }
    }
    if (this.sectionId !== 'params') this.setTrace?.(false)
    this.countEl.textContent = `${count} 项`
    this.body.scrollTop = keep
  }

  /* ---------------------------------------------------------------- *
   * Field rendering
   * ---------------------------------------------------------------- */
  _modified(field) {
    if (!field.key) return false
    const def = this.app?.defaults
    if (!def) return false
    const cur = getPath(this.getSettings(), field.key)
    const base = getPath(def, field.key)
    return JSON.stringify(cur) !== JSON.stringify(base)
  }

  _renderField(f) {
    if (f.type === 'about') return this._renderAbout()
    if (f.type === 'result') return el('div', { class: 'vs-result', id: f.id })
    if (f.type === 'info') return el('div', { class: 'vs-info', id: f.id, text: f.text, html: f.html })
    if (f.type === 'buttons') {
      const box = el('div', { class: 'vs-buttons', id: f.id })
      for (const b of f.items) box.appendChild(el('button', { class: 'vs-btn', text: b.label, dataset: { cmd: b.id } }))
      return box
    }
    if (f.type === 'presets') {
      const box = el('div', { class: 'vs-presets', id: f.id })
      const cur = getPath(this.getSettings(), 'voice.voicePreset')
      for (const p of VOICE_PRESETS) {
        box.appendChild(
          el(
            'button',
            { class: `vs-preset${p.id === cur ? ' active' : ''}`, onclick: () => this._applyVoicePreset(p) },
            el('span', { class: 'vs-preset-name', text: p.label }),
            el('span', { class: 'vs-preset-desc', text: p.desc })
          )
        )
      }
      return el('div', { class: 'vs-row vs-row-block' }, el('div', { class: 'vs-label', text: f.label || '' }), box)
    }

    const locked = f.key ? this.isLocked(f.key) : false
    const row = el('div', { class: `vs-row${locked ? ' locked' : ''}${this._modified(f) ? ' modified' : ''}` })

    const head = el('div', { class: 'vs-label' })
    head.appendChild(el('span', { class: 'vs-name', text: f.label }))
    if (f.key) {
      head.appendChild(el('span', { class: 'vs-key', text: f.key }))
      head.appendChild(
        el('button', {
          class: 'vs-lock',
          dataset: { lock: f.key },
          title: locked ? '解锁' : '锁定（锁定后不可编辑，也不被预设覆盖）',
          text: locked ? '🔒' : '🔓',
        })
      )
    }
    row.appendChild(head)

    const control = el('div', { class: 'vs-control' })
    this._buildControl(control, f, locked)
    row.appendChild(control)
    return row
  }

  _buildControl(box, f, locked) {
    const s = this.getSettings()
    const dis = locked

    switch (f.type) {
      case 'switch': {
        const input = el('input', {
          type: 'checkbox',
          checked: !!getPath(s, f.key),
          disabled: dis,
          dataset: { path: f.key, kind: 'bool' },
        })
        box.appendChild(el('label', { class: 'vs-check' }, input, el('span', { text: '' })))
        return
      }

      case 'range': {
        const value = Number(getPath(s, f.key) ?? f.min)
        const out = el('span', { class: 'vs-value', text: `${fmtValue(f, value)}${f.unit || ''}` })
        const input = el('input', {
          type: 'range',
          min: f.min,
          max: f.max,
          step: f.step ?? 0.01,
          value,
          disabled: dis,
          dataset: { path: f.key, kind: 'number' },
        })
        input._field = f
        input._out = out
        box.append(input, out)
        return
      }

      case 'number': {
        const input = el('input', {
          type: 'number',
          class: 'vs-input vs-input-num',
          value: getPath(s, f.key) ?? 0,
          step: f.step ?? 1,
          min: f.min,
          max: f.max,
          disabled: dis,
          dataset: { path: f.key, kind: 'number' },
        })
        box.appendChild(input)
        if (f.unit) box.appendChild(el('span', { class: 'vs-unit', text: f.unit }))
        return
      }

      case 'text':
      case 'password': {
        const input = el('input', {
          type: f.type === 'password' ? 'password' : 'text',
          class: `vs-input${f.wide ? ' wide' : ''}`,
          value: getPath(s, f.key) ?? '',
          spellcheck: 'false',
          disabled: dis,
          dataset: { path: f.key, kind: 'string' },
        })
        box.appendChild(input)
        if (f.type === 'password') {
          box.appendChild(
            el('button', {
              class: 'vs-btn',
              text: '显示',
              onclick: (e) => {
                const b = e.currentTarget
                const show = input.type === 'password'
                input.type = show ? 'text' : 'password'
                b.textContent = show ? '隐藏' : '显示'
              },
            })
          )
        }
        return
      }

      case 'textarea': {
        box.appendChild(
          el('textarea', {
            class: 'vs-textarea',
            rows: f.rows || 6,
            value: getPath(s, f.key) ?? '',
            spellcheck: 'false',
            disabled: dis,
            dataset: { path: f.key, kind: 'string' },
          })
        )
        return
      }

      case 'lines': {
        const v = getPath(s, f.key)
        box.appendChild(
          el('textarea', {
            class: 'vs-textarea',
            rows: f.rows || 4,
            value: Array.isArray(v) ? v.join('\n') : '',
            spellcheck: 'false',
            disabled: dis,
            dataset: { path: f.key, kind: 'lines' },
          })
        )
        return
      }

      case 'select': {
        const value = getPath(s, f.key)
        const select = el('select', { class: 'vs-input', disabled: dis, dataset: { path: f.key, kind: 'select' } })
        const opts = Array.isArray(f.options) ? f.options : []
        let matched = false
        for (const o of opts) {
          const ov = typeof o === 'object' ? o.value : o
          const ol = typeof o === 'object' ? o.label : String(o)
          const sel = String(ov) === String(value)
          if (sel) matched = true
          select.appendChild(el('option', { value: ov, text: ol, selected: sel }))
        }
        if (!matched && value !== undefined && value !== null && String(value) !== '') {
          select.appendChild(el('option', { value, text: `${value}（当前）`, selected: true }))
        }
        select._dynamic = f.dynamic || null
        select._editable = !!f.editable
        box.appendChild(select)
        return
      }

      case 'color': {
        const value = getPath(s, f.key) ?? '#007acc'
        box.appendChild(
          el('input', {
            type: 'color',
            class: 'vs-color',
            value,
            disabled: dis,
            dataset: { path: f.key, kind: 'string' },
          })
        )
        box.appendChild(
          el('input', {
            type: 'text',
            class: 'vs-input vs-input-sm',
            value,
            disabled: dis,
            dataset: { path: f.key, kind: 'string' },
          })
        )
        return
      }

      case 'chips': {
        const value = Number(getPath(s, f.key))
        for (const o of f.options) {
          box.appendChild(
            el('button', {
              class: `vs-chip${Math.abs(value - Number(o.value)) < 0.001 ? ' active' : ''}`,
              text: o.label,
              disabled: dis,
              onclick: async () => {
                await this.patch(setPath(f.key, Number(o.value)))
                bus.emit('settings:changed', { path: f.key })
                this.render()
              },
            })
          )
        }
        return
      }

      case 'param': {
        const id = f.id
        const ranges = this.getParamRanges() || {}
        const r = ranges[id] || { min: -1, max: 1 }
        const span = Math.max(0.0001, r.max - r.min)
        const step = span <= 2.5 ? 0.01 : Math.max(0.5, Math.round(span / 200))
        const cur = getPath(s, f.key) || { mode: 'auto', value: 0 }
        const mode = cur.mode || 'auto'
        const value = Number(cur.value ?? 0)
        const hasLimits = Number.isFinite(Number(cur.min)) || Number.isFinite(Number(cur.max))

        const set = async (patch) => {
          await this.patch(setPath(f.key, { mode, value, ...patch }))
          bus.emit('settings:changed', { path: f.key })
        }

        /* ---- mode ---- */
        const modeSel = el('select', {
          class: 'vs-input vs-input-sm',
          disabled: locked,
          dataset: { paramMode: id },
          onchange: async (e) => {
            await set({ mode: e.target.value })
            this.render()
          },
        })
        for (const o of [
          { value: 'auto', label: '自动' },
          { value: 'offset', label: '偏移' },
          { value: 'fixed', label: '固定' },
        ]) {
          modeSel.appendChild(el('option', { value: o.value, text: o.label, selected: o.value === mode }))
        }
        box.appendChild(modeSel)

        if (mode === 'auto') {
          /* ---- auto: upper/lower limits + a live curve ---- */
          const num = (which, def) =>
            el('input', {
              type: 'number',
              class: 'vs-input vs-num',
              min: r.min,
              max: r.max,
              step,
              value: Number.isFinite(Number(cur[which])) ? Number(cur[which]) : '',
              placeholder: String(def),
              disabled: locked,
              dataset: { paramLimit: `${id}:${which}` },
              onchange: async (e) => {
                const raw = e.target.value.trim()
                await set({ [which]: raw === '' ? null : Number(raw) })
              },
            })

          box.appendChild(el('span', { class: 'vs-unit', text: '下限' }))
          box.appendChild(num('min', r.min))
          box.appendChild(el('span', { class: 'vs-unit', text: '上限' }))
          box.appendChild(num('max', r.max))

          const reset = el('button', {
            class: 'vs-chip',
            text: '清除',
            disabled: locked || !hasLimits,
            onclick: async () => {
              await set({ min: null, max: null })
              this.render()
            },
          })
          box.appendChild(reset)

          /* live curve of the value the engine is producing */
          const canvas = el('canvas', { class: 'vs-curve', width: 210, height: 30, dataset: { curve: id } })
          box.appendChild(canvas)

          const readout = el('span', { class: 'vs-value', dataset: { curveVal: id } })
          box.appendChild(readout)
          this._curves.set(id, { canvas, readout, min: r.min, max: r.max })
          if (this._curves.size === 1) this._startCurveLoop()
          return
        }

        /* ---- offset / fixed: a single value slider ---- */
        const out = el('span', { class: 'vs-value', text: `${value.toFixed(2)}  (${r.min}~${r.max})` })
        const slider = el('input', {
          type: 'range',
          class: 'vs-range',
          min: r.min,
          max: r.max,
          step,
          value,
          disabled: locked,
          oninput: (e) => {
            out.textContent = `${Number(e.target.value).toFixed(2)}  (${r.min}~${r.max})`
          },
          onchange: async (e) => {
            await set({ value: Number(e.target.value) })
          },
        })
        box.append(slider, out)
        box.appendChild(el('span', { class: 'vs-unit', text: `自动时由 ${f.owner} 驱动` }))
        return
      }

      default:
        return
    }
  }

  /* ---------------------------------------------------------------- *
   * Change handling
   * ---------------------------------------------------------------- */
  _onBodyChange(e, isInput) {
    const t = e.target
    const path = t.dataset?.path
    if (!path) return
    if (this.isLocked(path)) return
    const kind = t.dataset.kind

    let value
    if (kind === 'bool') value = t.checked
    else if (kind === 'number') value = t.value === '' ? 0 : Number(t.value)
    else if (kind === 'lines') value = t.value.split('\n').map((x) => x.trim()).filter(Boolean)
    else if (kind === 'select') {
      if (t.value === '__custom__') {
        const cur = String(getPath(this.getSettings(), path) || '')
        const next = window.prompt('自定义值', cur) || cur
        t.value = next
        value = next
      } else value = t.value
    } else value = t.value

    if (kind === 'number' && !Number.isFinite(value)) return
    if (t._field && t._out) t._out.textContent = `${fmtValue(t._field, Number(value))}${t._field.unit || ''}`

    this.patch(setPath(path, value))

    if (kind === 'string' || kind === 'lines') {
      if (!isInput) this._afterPatch(path)
      else this._saveSoon()
      return
    }
    this._afterPatch(path)
  }

  _afterPatch(path) {
    bus.emit('settings:changed', { path })
    this._flashSaved()
    if (path.startsWith('ui.')) bus.emit('ui:theme')
    if (path === 'voice.languageMode' || path === 'voice.ttsProvider' || path === 'voice.speakOnPet') {
      this.render()
    }
  }

  async _onBodyClick(e) {
    const btn = e.target.closest('[data-cmd]')
    if (!btn) return
    switch (btn.dataset.cmd) {
      case 'reset-position':
        bus.emit('ui:reset-position')
        break
      case 'motion-nod':
      case 'motion-shake':
        bus.emit('ui:test-motion', { motion: btn.dataset.cmd.split('-')[1] })
        break
      case 'test-llm':
        await this._withBusy(btn, () => this._testLlm())
        break
      case 'list-models':
        await this._withBusy(btn, () => this._listModels())
        break
      case 'test-tts':
        await this._withBusy(btn, () => this._testTts(null))
        break
      case 'test-tts-ja':
        await this._withBusy(btn, () =>
          this._testTtsLang('ja-JP', 'こんにちは。私はロキシー・ミグルディア。今日も一緒に頑張りましょう。')
        )
        break
      case 'test-tts-zh':
        await this._withBusy(btn, () =>
          this._testTtsLang('zh-CN', '你好，我是洛琪希·米格路迪亚。今天也一起加油吧。')
        )
        break
      case 'refresh-tts':
        await this._refreshTtsStatus(true)
        break
      case 'reset-tts':
        this.voice.clearFailure()
        await this._refreshTtsStatus()
        toastOk('已清除降级记录')
        break
      case 'apply-hotkey':
        await this._withBusy(btn, () => this._applyHotkey())
        break
      case 'scan-gsv':
        await this._withBusy(btn, () => this._scanGptsovits())
        break
      case 'start-gsv':
        await this._withBusy(btn, () => this._startGptsovits())
        break
      case 'unlock-all':
        await this._unlockAll()
        break
      default:
        break
    }
  }

  _result(id, text, kind) {
    const node = document.getElementById(id)
    if (!node) return
    node.textContent = text
    node.className = `vs-result ${kind || ''}`.trim()
  }

  async _withBusy(btn, fn) {
    const label = btn.textContent
    btn.disabled = true
    btn.textContent = '…'
    try {
      await fn()
    } catch (err) {
      toastErr(String(err?.message || err))
    } finally {
      btn.disabled = false
      btn.textContent = label
    }
  }

  /* ---------------------------------------------------------------- *
   * Voice presets
   * ---------------------------------------------------------------- */
  async _applyVoicePreset(preset) {
    const locks = this.locks()
    const patch = stripLocked(JSON.parse(JSON.stringify(preset.patch || {})), locks)
    const skipped = JSON.stringify(patch) !== JSON.stringify(preset.patch || {})
    if (!patch.voice) patch.voice = {}
    if (!locks['voice.voicePreset']) patch.voice.voicePreset = preset.id

    await this.patch(patch)
    this._edgeVoices = null
    this._sapiVoices = null
    this._voicevoxVoices = null
    bus.emit('settings:changed', { path: 'voice.preset' })
    this.render()
    this._result(
      'preset-result',
      `已套用「${preset.label}」${skipped ? '（部分项已锁定，未覆盖）' : ''}`,
      'ok'
    )

    if (preset.requires) {
      const st = await this.voice.engineStatus().catch(() => null)
      const up = preset.requires === 'gptsovits' ? st?.gptsovitsAvailable : st?.voicevoxAvailable
      if (st && !up) {
        this._result(
          'preset-result',
          `已套用「${preset.label}」，但未检测到 ${preset.requires === 'gptsovits' ? 'GPT-SoVITS' : 'VOICEVOX'} 服务，暂时不会出声`,
          'err'
        )
      }
    }
  }

  /** Public entry point used by the automation hook. */
  applyPresetById(id) {
    const preset = VOICE_PRESETS.find((p) => p.id === id)
    if (!preset) return Promise.resolve(false)
    return this._applyVoicePreset(preset)
  }

  /* ---------------------------------------------------------------- *
   * Live parameter curves
   * ---------------------------------------------------------------- */

  /**
   * Tracing costs a getParameterValueById per parameter per frame, so it only
   * runs while the 模型参数 section is on screen.
   */
  _startCurveLoop() {
    this.setTrace?.(true)
    const tick = () => {
      if (!this._curves.size || this.sectionId !== 'params') {
        this._curveRaf = null
        this.setTrace?.(false)
        return
      }
      for (const [id, c] of this._curves) {
        const data = this.getTrace?.(id)
        if (!data) continue
        drawCurve(c.canvas, data, c.min, c.max)
        const last = data[data.length - 1]
        c.readout.textContent = Number.isFinite(last) ? last.toFixed(2) : '—'
      }
      this._curveRaf = requestAnimationFrame(tick)
    }
    if (!this._curveRaf) this._curveRaf = requestAnimationFrame(tick)
  }

  _stopCurves() {
    this._curves.clear()
    if (this._curveRaf) cancelAnimationFrame(this._curveRaf)
    this._curveRaf = null
    this.setTrace?.(false)
  }

  /* ---------------------------------------------------------------- *
   * Dynamic option sources
   * ---------------------------------------------------------------- */
  _voiceSource(path) {
    if (path === 'voice.webSpeechVoice') return { provider: 'webspeech' }
    const m = /^voice\.languageProfiles\.([A-Za-z-]+)\.(\w+)$/.exec(path)
    if (m) return { provider: m[2], lang: m[1] }
    return null
  }

  async _catalogue(provider) {
    const key = `_cat_${provider}`
    if (this[key]) return this[key]
    let voices = []
    if (provider === 'webspeech') voices = await VoiceService.waitForSystemVoices()
    else {
      const res = await window.pet.tts.voices({ provider })
      voices = res?.ok && res.voices?.length ? res.voices : []
    }
    this[key] = voices
    return voices
  }

  async _loadDynamicOptions() {
    const s = this.getSettings()

    for (const select of this.body.querySelectorAll('select[data-path]')) {
      const path = select.dataset.path

      if (select._dynamic === 'screens') {
        const info = this.info || (await window.pet.app.info())
        this.info = info
        const cur = Number(s.display.screenIndex) || 0
        select.textContent = ''
        for (const d of info.displays || []) {
          select.appendChild(
            el('option', {
              value: d.index,
              text: `${d.label} ${d.bounds.width}×${d.bounds.height}${d.primary ? ' 主屏' : ''}`,
              selected: d.index === cur,
            })
          )
        }
        continue
      }

      const src = this._voiceSource(path)
      if (!src) continue
      const current = getPath(s, path)
      const voices = await this._catalogue(src.provider)
      select.textContent = ''

      if (!voices.length) {
        const why =
          src.provider === 'sapi'
            ? '未检测到系统语音'
            : src.provider === 'voicevox'
              ? '未连接到 VOICEVOX'
              : src.provider === 'webspeech'
                ? '本机 Chromium 未提供语音'
                : src.provider === 'openai'
                  ? '—'
                  : '无可用音色'
        select.appendChild(el('option', { value: '', text: why }))
        continue
      }

      const autoLabel = src.provider === 'sapi' ? '系统默认' : src.provider === 'webspeech' ? '自动' : src.provider === 'openai' ? '默认' : null
      if (autoLabel) select.appendChild(el('option', { value: '', text: autoLabel }))

      const two = src.lang ? src.lang.slice(0, 2).toLowerCase() : null
      const matching = two ? voices.filter((v) => String(v.locale || '').toLowerCase().startsWith(two)) : []
      const others = voices.filter((v) => !matching.includes(v))

      const add = (list, parent) => {
        for (const v of list) {
          parent.appendChild(
            el('option', { value: String(v.id), text: v.name || String(v.id), selected: String(v.id) === String(current) })
          )
        }
      }
      if (matching.length) {
        const og = el('optgroup', { label: `${src.lang} (${matching.length})` })
        add(matching, og)
        select.appendChild(og)
      }
      if (others.length) {
        const og = el('optgroup', { label: `其他 (${others.length})` })
        add(others, og)
        select.appendChild(og)
      }
      const has = Array.from(select.options).some((o) => o.value === String(current ?? ''))
      if (!has && current !== undefined && current !== null && String(current) !== '') {
        select.appendChild(el('option', { value: String(current), text: `${current}（当前）`, selected: true }))
      }
    }

    if (this.sectionId === 'voice') {
      await this._refreshTtsStatus()
      this._refreshLangStatus()
      this._refreshRigRanges()
    }
    if (this.sectionId === 'gaze') this._refreshRigRanges()
    if (this.sectionId === 'locks') this._renderLockList()
  }

  /* ---------------------------------------------------------------- *
   * Status readouts
   * ---------------------------------------------------------------- */
  async _refreshTtsStatus(verbose = false) {
    const node = document.getElementById('tts-status')
    if (!node) return
    const st = await this.voice.engineStatus().catch(() => null)
    if (!st) return
    this._lastSpokenLanguage = st.lastSpokenLanguage || this._lastSpokenLanguage
    const labels = {
      gptsovits: 'GPT-SoVITS',
      edge: 'Edge TTS',
      voicevox: 'VOICEVOX',
      openai: '在线 TTS',
      sapi: '系统语音',
      webspeech: '浏览器语音',
    }
    const parts = (st.engines || []).map((e) => {
      const name = labels[e.provider] || e.provider
      if (e.cooling) return `${name} · 冷却 ${e.retryInMin} 分`
      if (e.provider === 'openai' && !st.hasOpenaiKey) return `${name} · 未配置 Key`
      if (e.provider === 'sapi' && !st.sapiAvailable) return `${name} · 不可用`
      if (e.provider === 'voicevox' && !st.voicevoxAvailable) return `${name} · 未启动`
      if (e.provider === 'gptsovits' && !st.gptsovitsAvailable) return `${name} · 未启动`
      return `${name} · 可用`
    })
    node.className = 'vs-result'
    node.textContent = parts.join('　')
    if (verbose) toastOk('已刷新引擎状态')
  }

  _refreshLangStatus() {
    const node = document.getElementById('lang-status')
    if (!node) return
    const s = this.getSettings()
    const labels = { 'zh-CN': '中文', 'ja-JP': '日语', 'en-US': '英语', 'ko-KR': '韩语' }
    const mode = s.voice?.languageMode || 'auto'
    const t = mode === 'auto' ? '自动识别' : labels[mode] || mode
    const last = this._lastSpokenLanguage ? `　上次：${labels[this._lastSpokenLanguage] || this._lastSpokenLanguage}` : ''
    node.className = 'vs-result'
    node.textContent = `模式：${t}${last}`
  }

  _refreshRigRanges() {
    for (const node of document.querySelectorAll('#rig-ranges, #params-ranges')) {
      const ranges = this.getParamRanges() || {}
      const keys = Object.keys(ranges)
      if (!keys.length) {
        node.className = 'vs-result'
        node.textContent = '尚未读取到模型参数范围'
        continue
      }
      node.className = 'vs-result'
      node.textContent = keys.map((id) => `${id.replace(/^Param/, '')} ${ranges[id].min}~${ranges[id].max}`).join('　')
    }
  }

  _renderLockList() {
    const node = document.getElementById('lock-list')
    if (!node) return
    const locks = Object.keys(this.locks())
    node.className = 'vs-result'
    node.textContent = locks.length ? locks.join('\n') : '（没有锁定的设置）'
    node.style.whiteSpace = 'pre-wrap'
  }

  /* ---------------------------------------------------------------- *
   * Actions
   * ---------------------------------------------------------------- */
  async _testLlm() {
    this._result('llm-result', '连接中…')
    const s = this.getSettings()
    const res = await window.pet.llm.test({
      config: {
        baseUrl: s.chat.baseUrl,
        apiKey: s.chat.apiKey,
        model: s.chat.model,
        temperature: s.chat.temperature,
        maxTokens: 32,
        timeoutMs: 30000,
      },
    })
    if (res.ok) this._result('llm-result', `连接成功：${res.reply || '(空)'}`, 'ok')
    else this._result('llm-result', res.message, 'err')
  }

  async _listModels() {
    this._result('llm-result', '获取中…')
    const s = this.getSettings()
    const res = await window.pet.llm.models({ config: { baseUrl: s.chat.baseUrl, apiKey: s.chat.apiKey } })
    if (!res.ok) return this._result('llm-result', res.message, 'err')
    if (!res.models.length) return this._result('llm-result', '接口未返回模型列表', 'err')
    const input = this.body.querySelector('input[data-path="chat.model"]')
    if (input) {
      let dl = document.getElementById('model-datalist')
      if (!dl) {
        dl = el('datalist', { id: 'model-datalist' })
        input.setAttribute('list', 'model-datalist')
        this.body.appendChild(dl)
      }
      dl.textContent = ''
      for (const m of res.models.slice(0, 500)) dl.appendChild(el('option', { value: m }))
    }
    this._result('llm-result', `获取到 ${res.models.length} 个模型，输入框可下拉选择`, 'ok')
  }

  async _testTts(btn) {
    this._result('tts-result', '合成中…')
    const ok = await this.voice.speak(
      `你好，我是${this.getSettings().chat?.personaName || '洛琪希'}，这是当前音色的试听。`,
      { force: true }
    )
    const d = this.voice.debug
    this._result(
      'tts-result',
      ok ? `${d.provider || '?'} · ${d.duration ? d.duration.toFixed(1) : '?'}s · 电平 ${d.maxLevel.toFixed(2)}` : '合成或播放失败',
      ok ? 'ok' : 'err'
    )
    await this._refreshTtsStatus()
  }

  async _testTtsLang(lang, text) {
    const mode = this.getSettings().voice.languageMode
    this._result('tts-result', `${lang} 合成中…`)
    try {
      await this.patch({ voice: { languageMode: lang } })
      const ok = await this.voice.speak(text, { force: true })
      const d = this.voice.debug
      this._result(
        'tts-result',
        ok ? `${lang} · ${d.provider || '?'} · ${d.duration ? d.duration.toFixed(1) : '?'}s` : `${lang} 合成失败`,
        ok ? 'ok' : 'err'
      )
    } finally {
      await this.patch({ voice: { languageMode: mode } })
    }
    await this._refreshTtsStatus()
  }

  async _applyHotkey() {
    const acc = this.getSettings().voice.sttHotkey
    const res = await window.pet.app.registerHotkey(acc)
    this._result('stt-result', res.ok ? (res.accelerator ? `已注册 ${res.accelerator}` : '已清除快捷键') : res.message, res.ok ? 'ok' : 'err')
  }

  /** Finds a GPT-SoVITS install and fills in every path it can. */
  async _scanGptsovits() {
    const st = this.getSettings()
    const scan = await window.pet.tts.scanGptsovits({ root: st.voice.gptsovits?.root })
    if (!scan?.root) {
      this._result(
        'gsv-result',
        `未找到 GPT-SoVITS。请把「安装目录」填成包含 api_v2.py 的文件夹。\n已搜索：${(scan?.searched || []).join('、')}`,
        'err'
      )
      return
    }

    const patch = {
      voice: {
        gptsovits: {
          root: scan.root,
          baseUrl: st.voice.gptsovits?.baseUrl || 'http://127.0.0.1:9880',
        },
      },
    }
    const g = patch.voice.gptsovits
    const notes = []

    // Prefer user-trained weights; fall back to the bundled base models.
    if (scan.gptWeights.length && scan.sovitsWeights.length) {
      g.mode = 'weights'
      g.gptWeights = scan.gptWeights[0].path
      g.sovitsWeights = scan.sovitsWeights[0].path
      notes.push(`微调模型：${scan.gptWeights[0].name} + ${scan.sovitsWeights[0].name}`)
    } else if (scan.pretrained.gpt && scan.pretrained.sovits) {
      // Base models can only do zero-shot, so a reference clip is required.
      g.mode = scan.references.length ? 'audio' : 'weights'
      g.gptWeights = scan.pretrained.gpt
      g.sovitsWeights = scan.pretrained.sovits
      notes.push('未发现微调模型，已选用内置底模')
    }

    if (scan.references.length) {
      const ref = scan.references[0]
      g.refAudio = ref.path
      notes.push(`参考音频：${ref.name}`)
      if (ref.transcript) {
        g.promptText = ref.transcript
        // Guess the prompt language from the transcript's script.
        g.promptLang = /[\u3040-\u30ff]/.test(ref.transcript)
          ? 'ja'
          : /[\uac00-\ud7af]/.test(ref.transcript)
            ? 'ko'
            : /[\u4e00-\u9fff]/.test(ref.transcript)
              ? 'zh'
              : 'en'
        notes.push(`参考文本：${ref.transcript.slice(0, 24)}${ref.transcript.length > 24 ? '…' : ''}`)
      } else {
        notes.push('⚠ 该音频没有同名 .txt 文稿，请手动填「参考音频文本」')
      }
    } else if (g.mode === 'audio') {
      g.mode = 'weights'
      notes.push('没有找到参考音频，已切到「常驻模型」模式')
    }

    await this.patch(patch)
    this.render()

    const probe = await window.pet.tts.status().catch(() => null)
    const running = probe?.gptsovitsAvailable
    this._result(
      'gsv-result',
      `安装目录：${scan.root}\n${notes.join('\n')}\n服务：${running ? '正在运行 ✅' : '未启动 ❌（点「启动服务」或运行 start-gptsovits-api.ps1）'}`,
      running ? 'ok' : 'err'
    )
    toastOk('已检测并填入 GPT-SoVITS 配置')
  }

  /** Starts GPT-SoVITS through the main process (it owns the child process). */
  async _startGptsovits() {
    const st = this.getSettings()
    this._result('gsv-result', '正在启动 GPT-SoVITS…（首次加载权重约需 20–60 秒）', 'ok')
    const res = await window.pet.tts.ensureGptsovits()
    const status = await window.pet.tts.gptsovitsStatus().catch(() => null)
    const lines = [res.message]
    if (status) {
      lines.push(`安装目录：${status.root || '（未设置）'}`)
      lines.push(`服务：${status.running ? `运行中 ${status.host}:${status.port}` : '未运行'}`)
    }
    if (!res.ok) this._result('gsv-result', lines.join('\n'), 'err')
    else this._result('gsv-result', lines.join('\n'), 'ok')
  }

  async _reset() {
    if (!window.confirm('恢复所有设置为默认值？锁定的项也会被一并重置。')) return
    await window.pet.settings.reset()
    bus.emit('settings:reloaded')
    this.render()
    toastOk('已恢复默认设置')
  }

  _flashSaved() {
    if (!this.statusEl) return
    this.statusEl.textContent = '已保存'
    setTimeout(() => {
      if (this.statusEl.textContent === '已保存') this.statusEl.textContent = ''
    }, 1500)
  }

  /* ---------------------------------------------------------------- *
   * About
   * ---------------------------------------------------------------- */
  _renderAbout() {
    const i = this.info || {}
    const box = el('div', { class: 'vs-about' })
    const modelPath = this.getSettings()?.model?.path || '—'
    const modelShort = modelPath.split(/[\\/]/).filter(Boolean).slice(-2).join('/')
    box.appendChild(
      el('div', {
        html:
          `<div><b>Live2D 桌面宠物</b> v${i.version || '1.0.0'}</div>` +
          `<div class="vs-dim">Electron ${i.electron || '?'} · Chromium ${i.chrome || '?'} · Node ${i.node || '?'} · ${i.platform || '-'}</div>` +
          `<div class="vs-dim">配置：${i.settingsPath || '-'}</div>` +
          `<div class="vs-dim">模型：${modelShort}（psd2live 生成 · Cubism 5）</div>` +
          `<div class="vs-dim">操作：左键按住=抚摸　右键拖动=移动　右键单击=菜单</div>` +
          `<div class="vs-dim">快捷键：Ctrl+Shift+H 显隐　Ctrl+Shift+C 对话　Ctrl+Shift+S 设置　Esc 取消</div>`,
      })
    )
    const row = el('div', { class: 'vs-buttons' })
    const launch = el('input', { type: 'checkbox' })
    window.pet.app.getAutoLaunch().then((on) => (launch.checked = !!on))
    launch.addEventListener('change', async () => {
      const v = await window.pet.app.setAutoLaunch(launch.checked)
      toastOk(v ? '已设置开机自启' : '已取消开机自启')
    })
    row.append(
      el('label', { class: 'vs-check' }, launch, el('span', { text: '开机自启' })),
      el('button', { class: 'vs-btn', text: '配置文件', onclick: () => window.pet.settings.openFile() }),
      el('button', { class: 'vs-btn', text: '开发者工具', onclick: () => window.pet.win.devtools() }),
      el('button', { class: 'vs-btn', text: '重载界面', onclick: () => window.pet.win.reload() }),
      el('button', { class: 'vs-btn', text: '隐藏桌宠', onclick: () => window.pet.win.hide() }),
      el('button', { class: 'vs-btn danger', text: '退出', onclick: () => window.pet.win.quit() })
    )
    box.appendChild(row)
    return box
  }
}
