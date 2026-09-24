/**
 * ChatPanel — the conversation window: message log, streaming replies, text
 * input and the push-to-talk microphone control.
 */
import { $, clamp, el, formatClock, truncate } from '../core/util.js'
import { bus } from '../core/bus.js'
import { getLang, t } from '../core/i18n.js'
import { toastErr } from './notify.js'

/**
 * Re-labels the static markup in `index.html` (window title, tooltips,
 * `aria-label`s, placeholders, the chat/settings title bars and the dock).
 *
 * The markup itself stays English-only — the English string IS the i18n key —
 * and every translatable element opts in with an attribute saying which part of
 * it to fill:
 *
 *   data-i18n              → textContent
 *   data-i18n-title        → title (tooltip)
 *   data-i18n-aria-label   → aria-label
 *   data-i18n-placeholder  → placeholder
 *
 * Runs at startup and again on every `i18n:changed`, so it is idempotent.
 * `#loading-text` / `#loading-sub` are deliberately skipped: the boot sequence
 * owns them and rewrites them with load progress.
 */
export function applyStaticI18n(root = document) {
  for (const node of root.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n)
  for (const node of root.querySelectorAll('[data-i18n-title]')) node.title = t(node.dataset.i18nTitle)
  for (const node of root.querySelectorAll('[data-i18n-aria-label]')) {
    node.setAttribute('aria-label', t(node.dataset.i18nAriaLabel))
  }
  for (const node of root.querySelectorAll('[data-i18n-placeholder]')) {
    node.placeholder = t(node.dataset.i18nPlaceholder)
  }
  // Screen readers should read the Chinese UI with a Chinese voice.
  document.documentElement.lang = getLang()
}

export class ChatPanel {
  constructor({ pet, chat, voice, getSettings, onStateChange }) {
    this.pet = pet
    this.chat = chat
    this.voice = voice
    this.getSettings = getSettings
    this.onStateChange = onStateChange

    this.el = $('#chat-panel')
    this.log = $('#chat-log')
    this.input = $('#chat-input')
    this.sendBtn = $('#chat-send')
    this.micBtn = $('#chat-mic')
    this.typing = $('#chat-typing')
    this.recordHint = $('#chat-record-hint')
    this.recordText = $('#record-text')
    this.title = $('#chat-title')
    this.avatar = this.el.querySelector('.avatar-dot')

    this.streamEl = null
    this.streamText = ''
    this.open_ = false
    this.pinned = false

    this._wire()
    this._wireBus()
    this._autosize()

    // The static markup is translated from here (this runs before the boot
    // sequence applies the language setting, so the `i18n:changed` listener
    // below picks up the first real language and every later switch), and the
    // runtime strings this panel writes itself go through `t()` at the source.
    applyStaticI18n()
    bus.on('i18n:changed', () => applyStaticI18n())
  }

  _wire() {
    this.el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]')
      if (!btn) return
      const a = btn.dataset.action
      if (a === 'chat-close') this.close()
      else if (a === 'chat-clear') {
        this.chat.clear()
        this.clear()
        this.addMessage('system', t('Chat history cleared'))
      } else if (a === 'chat-settings') bus.emit('ui:open-settings', { tab: 'chat' })
      else if (a === 'record-cancel') this.voice.stopRecording({ cancel: true })
    })

    this.sendBtn.addEventListener('click', () => this.submit())
    this.micBtn.addEventListener('click', () => this.toggleRecord())

    this.input.addEventListener('keydown', (e) => {
      const sendOnEnter = this.getSettings()?.chat?.sendOnEnter !== false
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.isComposing) {
        if (sendOnEnter) {
          e.preventDefault()
          this.submit()
        }
      } else if (e.key === 'Enter' && (e.ctrlKey || (!sendOnEnter && !e.shiftKey))) {
        e.preventDefault()
        this.submit()
      }
    })

    this.input.addEventListener('input', () => this._autosize())
    this.input.addEventListener('focus', () => bus.emit('ui:focus-input'))

    // dragging
    const handle = this.el.querySelector('[data-drag-handle="chat"]')
    let drag = null
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return
      const r = this.el.getBoundingClientRect()
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top }
      handle.setPointerCapture(e.pointerId)
      e.preventDefault()
    })
    handle.addEventListener('pointermove', (e) => {
      if (!drag) return
      const r = this.el.getBoundingClientRect()
      const left = clamp(e.clientX - drag.dx, 4, window.innerWidth - r.width - 4)
      const top = clamp(e.clientY - drag.dy, 4, window.innerHeight - r.height - 4)
      this._setPosition(left, top)
    })
    const endDrag = (e) => {
      if (!drag) return
      drag = null
      try {
        handle.releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      this._persistPosition()
    }
    handle.addEventListener('pointerup', endDrag)
    handle.addEventListener('pointercancel', endDrag)

    // Auto-scroll only when the user is already near the bottom.
    this.log.addEventListener('scroll', () => {
      const gap = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight
      this.pinned = gap < 60
    })
  }

  _wireBus() {
    bus.on('chat:start', () => {
      this.setBusy(true)
      this.beginStream()
    })
    bus.on('chat:delta', ({ text }) => this.appendStream(text))
    bus.on('chat:done', ({ text, error }) => {
      this.setBusy(false)
      this.endStream(text)
      if (error && error !== 'aborted') this.addMessage('error', error)
    })
    bus.on('chat:error', ({ message }) => {
      this.setBusy(false)
      this.addMessage('error', message)
    })
    bus.on('chat:user', ({ text }) => this.addMessage('user', text))
    bus.on('stt:state', ({ state, maxSeconds }) => {
      if (state === 'recording') {
        this.micBtn.classList.add('recording')
        this.recordHint.classList.remove('hidden')
        this.recordText.textContent = t('Listening… (up to {n}s)', { n: maxSeconds || 30 })
      } else if (state === 'transcribing') {
        this.micBtn.classList.remove('recording')
        this.recordText.textContent = t('Transcribing…')
      } else {
        this.micBtn.classList.remove('recording')
        this.recordHint.classList.add('hidden')
      }
    })
    bus.on('stt:result', ({ text }) => {
      if (this.getSettings()?.voice?.sttAutoSend !== false) {
        this.input.value = text
        this._autosize()
        this.submit()
      } else {
        this.input.value = this.input.value ? `${this.input.value} ${text}` : text
        this._autosize()
        this.input.focus()
      }
    })
    bus.on('stt:error', ({ message }) => {
      this.recordHint.classList.add('hidden')
      this.micBtn.classList.remove('recording')
      toastErr(message)
    })
  }

  /* ---------------------------------------------------------------- */
  get visible() {
    return !this.el.classList.contains('hidden')
  }

  open({ focus = true } = {}) {
    this.el.classList.remove('hidden')
    this.open_ = true
    this._place()
    if (focus) setTimeout(() => this.input.focus(), 60)
    bus.emit('ui:panel', { panel: 'chat', open: true })
  }

  close() {
    this.el.classList.add('hidden')
    this.open_ = false
    bus.emit('ui:panel', { panel: 'chat', open: false })
  }

  toggle() {
    if (this.visible) this.close()
    else this.open()
  }

  _place() {
    const saved = this.onStateChange?.()?.uiPos?.chat
    if (saved && Number.isFinite(saved.x) && (saved.x || saved.y)) {
      this._setPosition(saved.x, saved.y)
      return
    }
    const b = this.pet.getModelBounds()
    const r = this.el.getBoundingClientRect()
    const w = r.width || 380
    const h = r.height || 520
    let left = (b?.left ?? window.innerWidth - w - 40) - w - 18
    if (left < 8) left = Math.min((b?.left ?? 0) + (b?.width ?? 0) + 18, window.innerWidth - w - 8)
    const top = clamp((b?.top ?? 40) + (b?.height ?? 400) * 0.06, 8, window.innerHeight - h - 8)
    this._setPosition(clamp(left, 8, window.innerWidth - w - 8), top)
  }

  _setPosition(left, top) {
    this.el.style.left = `${Math.round(left)}px`
    this.el.style.top = `${Math.round(top)}px`
  }

  _persistPosition() {
    const r = this.el.getBoundingClientRect()
    this.onStateChange?.({ uiPos: { chat: { x: Math.round(r.left), y: Math.round(r.top) } } })
  }

  _autosize() {
    this.input.style.height = 'auto'
    this.input.style.height = `${Math.min(this.input.scrollHeight, 120)}px`
  }

  /* ---------------------------------------------------------------- */
  setBusy(busy) {
    const showThinking = this.getSettings()?.chat?.showThinking !== false
    this.typing.classList.toggle('hidden', !busy || !showThinking)
    this.avatar?.classList.toggle('busy', !!busy)
    this.sendBtn.disabled = !!busy
    if (busy) this._scroll()
  }

  _scroll(force = false) {
    if (!force && !this.pinned && this.log.scrollTop > 0) return
    this.log.scrollTop = this.log.scrollHeight
  }

  addMessage(role, text) {
    const isStream = role === 'assistant' && this.streamEl
    const node = el(
      'div',
      { class: `msg ${role}` },
      role === 'system' || role === 'error'
        ? null
        : el('div', { class: 'msg-emotion', text: `${role === 'user' ? t('You') : this.personaName()} · ${formatClock()}` }),
      el('div', { class: 'msg-body', text: String(text || '') })
    )
    this.log.appendChild(node)
    if (this.log.children.length > 400) this.log.firstElementChild?.remove()
    this._scroll(true)
    return node
  }

  personaName() {
    return this.getSettings()?.chat?.personaName || t('Assistant')
  }

  beginStream() {
    this.streamText = ''
    const node = el(
      'div',
      { class: 'msg assistant' },
      el('div', { class: 'msg-emotion', text: `${this.personaName()} · ${formatClock()}` }),
      el('div', { class: 'msg-body', text: '' })
    )
    this.log.appendChild(node)
    this.streamEl = node.querySelector('.msg-body')
    this._scroll(true)
  }

  appendStream(text) {
    if (!this.streamEl) this.beginStream()
    this.streamText += text
    this.streamEl.textContent = this.streamText
    this._scroll()
  }

  endStream(finalText) {
    const text = (finalText || this.streamText || '').trim()
    if (this.streamEl) {
      if (text) this.streamEl.textContent = text
      else this.streamEl.closest('.msg')?.remove()
    } else if (text) {
      this.addMessage('assistant', text)
    }
    this.streamEl = null
    this.streamText = ''
    this._scroll()
  }

  clear() {
    this.log.textContent = ''
    this.streamEl = null
    this.streamText = ''
  }

  /** Renders persisted history into the log (called on startup). */
  renderHistory(history) {
    this.clear()
    const items = Array.isArray(history) ? history.slice(-30) : []
    if (!items.length) {
      this.addMessage('system', t('No messages yet — say hi to get started.'))
      return
    }
    for (const m of items) {
      if (m.role === 'user') this.addMessage('user', m.content)
      else if (m.role === 'assistant') this.addMessage('assistant', m.content)
    }
    this._scroll(true)
  }

  /* ---------------------------------------------------------------- */
  async submit() {
    const text = this.input.value.trim()
    if (!text) return
    if (this.chat.streaming) this.chat.abort()
    this.input.value = ''
    this._autosize()
    this.pinned = true
    await this.chat.send(text)
  }

  async toggleRecord() {
    if (!this.getSettings()?.voice?.sttEnabled) {
      toastErr(t('Voice input is disabled in settings'))
      return
    }
    if (this.voice.recording) await this.voice.stopRecording()
    else {
      const ok = await this.voice.startRecording()
      if (ok) this.input.focus()
    }
  }

  setAlwaysOnTopHint() {
    this.el.style.zIndex = '50'
  }
}
