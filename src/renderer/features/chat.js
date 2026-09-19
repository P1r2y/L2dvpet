/**
 * ChatService — conversation state, streaming LLM calls and emotion extraction.
 *
 * The model is asked to prefix replies with `[emotion]` and optionally
 * `[motion:nod]`; a small incremental parser peels those off as soon as they
 * arrive so the character reacts while the rest of the sentence is still
 * streaming in.
 */
import { bus } from '../core/bus.js'
import { normalizeEmotion } from '../live2d/emotion.js'
import { debounce, truncate } from '../core/util.js'

const bridge = window.pet

const KNOWN_TAGS = new Set([
  'happy', 'smile', 'sad', 'angry', 'surprised', 'shy', 'think', 'neutral',
  'love', 'sleepy', 'joy', 'excited', 'mad', 'annoyed', 'embarrassed',
  'thinking', 'curious', 'tired', 'calm', 'shock', 'cry', 'unhappy',
  'motion', 'action', 'emotion',
])

/**
 * Removes every known `[tag]` / `[tag:arg]` marker from `text`, returning both
 * the cleaned text and the tags in the order they appeared.
 */
export function stripKnownTags(text) {
  const tags = []
  const out = String(text || '').replace(/\[([^[\]]{1,32})\]/g, (match, body) => {
    const [name, arg = ''] = String(body).split(':')
    const key = name.toLowerCase().trim()
    if (!KNOWN_TAGS.has(key)) return match
    tags.push({ name: key, arg: arg.trim() })
    return ''
  })
  // Tidy the gaps the removed markers leave behind.
  return { text: out.replace(/[ \t]{2,}/g, ' ').replace(/\s+([，。！？、；：])/g, '$1'), tags }
}

/**
 * Incrementally splits `[tag]` markers from streamed text.
 *
 * Tags are recognised anywhere (not just at the start), and a trailing,
 * still-unterminated `[` is held back so a half-received marker is never
 * rendered. `push()` returns only the newly-visible text.
 */
export class StreamTagParser {
  constructor() {
    this.raw = ''
    this.visible = ''
    this.tags = []
    this._emitted = 0
  }

  /** @returns {{ text: string, tags: Array<{name:string,arg:string}> }} */
  push(chunk) {
    if (!chunk) return { text: '', tags: [] }
    const had = this.tags.length
    this.raw += chunk
    this._reparse(true)
    const text = this.visible.slice(this._emitted)
    this._emitted = this.visible.length
    return { text, tags: this.tags.slice(had) }
  }

  /** Emits anything still held back (call once the stream has finished). */
  flush() {
    const had = this.tags.length
    this._reparse(false)
    const text = this.visible.slice(this._emitted)
    this._emitted = this.visible.length
    return { text, tags: this.tags.slice(had) }
  }

  _reparse(holdPartialTag) {
    let cut = this.raw.length
    if (holdPartialTag) {
      const open = this.raw.lastIndexOf('[')
      // Hold back an unterminated marker, but never hold more than ~32 chars
      // (the model may legitimately write a bare "[").
      if (open !== -1 && this.raw.indexOf(']', open) === -1 && this.raw.length - open <= 32) {
        cut = open
      }
    }
    const parsed = stripKnownTags(this.raw.slice(0, cut))
    this.visible = parsed.text
    this.tags = parsed.tags
  }

  /** Full accumulated visible text so far. */
  get text() {
    return this.visible
  }
}

/** Extracts tags + body from a complete (non-streamed) string. */
export function parseMessage(text) {
  return stripKnownTags(text)
}

export class ChatService {
  constructor({ getSettings, state, voice }) {
    this.getSettings = getSettings
    this.voice = voice
    this.state = state || { chatHistory: [] }
    this.history = Array.isArray(this.state.chatHistory) ? this.state.chatHistory.slice(-40) : []
    this.streaming = false
    this.currentId = null
    this.currentText = ''
    this.parser = null
    this._unsubs = []
    this._saveSoon = debounce(() => this._persist(), 800)
  }

  attach() {
    this._unsubs.push(
      bridge.llm.onDelta(({ id, text }) => {
        if (id !== this.currentId) return
        this._onDelta(text || '')
      }),
      bridge.llm.onDone(({ id }) => {
        if (id !== this.currentId) return
        this._onDone()
      }),
      bridge.llm.onError(({ id, message, aborted }) => {
        if (id !== this.currentId) return
        this._onError(message, aborted)
      })
    )
    return this
  }

  detach() {
    this._unsubs.forEach((fn) => fn())
    this._unsubs = []
  }

  /* ---------------------------------------------------------------- */
  buildMessages(userText) {
    const s = this.getSettings()
    const cfg = s.chat || {}
    const max = Math.max(2, Number(cfg.maxHistory) || 20)
    const messages = []
    const sys = String(cfg.systemPrompt || '').trim()
    if (sys) messages.push({ role: 'system', content: sys })
    for (const m of this.history.slice(-max * 2)) {
      if (m.role === 'user' || m.role === 'assistant') messages.push({ role: m.role, content: m.content })
    }
    if (userText) messages.push({ role: 'user', content: userText })
    return messages
  }

  /**
   * Sends a user message and streams the reply.
   * @returns {Promise<{text:string, emotion:string}|null>}
   */
  async send(userText, { silent = false } = {}) {
    const s = this.getSettings()
    if (!s?.chat?.enabled) {
      bus.emit('chat:error', { message: '对话功能已在设置中关闭' })
      return null
    }
    const cfg = s.chat
    if (!cfg.apiKey) {
      bus.emit('chat:error', {
        message: '还没有填写 API Key —— 打开「设置 → 对话」填入后即可聊天',
      })
      return null
    }

    const text = String(userText || '').trim()
    if (!text) return null

    this.abort()

    this.history.push({ role: 'user', content: text, at: Date.now() })
    this._saveSoon()
    bus.emit('chat:user', { text })

    this.currentText = ''
    this.parser = new StreamTagParser()
    this.streaming = true
    bus.emit('chat:start', { text })

    const id = `c${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    this.currentId = id

    try {
      const started = await bridge.llm.start({
        id,
        messages: this.buildMessages(),
        config: {
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          model: cfg.model,
          temperature: cfg.temperature,
          topP: cfg.topP,
          maxTokens: cfg.maxTokens,
          timeoutMs: cfg.timeoutMs,
          extraHeaders: cfg.extraHeaders,
          stream: cfg.stream !== false,
        },
      })
      if (started?.id && started.id !== id) this.currentId = started.id
    } catch (err) {
      this._onError(String(err?.message || err), false)
      return null
    }

    return new Promise((resolve) => {
      this._resolve = resolve
      this._silent = silent
    })
  }

  _onDelta(chunk) {
    this.currentText += chunk
    const { text, tags } = this.parser.push(chunk)
    for (const tag of tags) this._applyTag(tag)
    if (text) bus.emit('chat:delta', { id: this.currentId, text, full: this.parser.text })
  }

  _applyTag(tag) {
    if (tag.name === 'motion' || tag.name === 'action') {
      const motion = (tag.arg || '').toLowerCase()
      if (motion.includes('nod')) bus.emit('chat:motion', { motion: 'nod' })
      else if (motion.includes('shake')) bus.emit('chat:motion', { motion: 'shake' })
      return
    }
    if (tag.name === 'emotion') {
      bus.emit('chat:emotion', { emotion: normalizeEmotion(tag.arg) })
      return
    }
    bus.emit('chat:emotion', { emotion: normalizeEmotion(tag.name) })
  }

  _finalise() {
    const body = (this.parser?.text || this.currentText).trim()
    const emotion =
      this.parser?.tags.map((t) => t.name).filter((n) => n !== 'motion' && n !== 'action').pop() || 'neutral'
    this.streaming = false
    const id = this.currentId
    this.currentId = null

    if (body) {
      this.history.push({ role: 'assistant', content: body, emotion, at: Date.now() })
      this._saveSoon()
      this.state.stats = { ...(this.state.stats || {}), messages: (this.state.stats?.messages || 0) + 1 }
    }
    return { text: body, emotion: normalizeEmotion(emotion), id }
  }

  _onDone() {
    this._flushParser()
    const result = this._finalise()
    bus.emit('chat:done', result)
    this._finish(result)
  }

  /** Emits any text still held back waiting for a tag to close. */
  _flushParser() {
    if (!this.parser) return
    const tail = this.parser.flush()
    for (const tag of tail.tags) this._applyTag(tag)
    if (tail.text) {
      bus.emit('chat:delta', { id: this.currentId, text: tail.text, full: this.parser.text })
    }
  }

  _onError(message, aborted) {
    this._flushParser()
    const result = this._finalise()
    this.streaming = false
    this.currentId = null
    if (!aborted) bus.emit('chat:error', { message })
    bus.emit('chat:done', { ...result, error: aborted ? 'aborted' : message })
    this._finish({ ...result, error: aborted ? 'aborted' : message })
  }

  _finish(result) {
    const resolve = this._resolve
    this._resolve = null
    this._silent = false
    resolve?.(result)
  }

  abort() {
    if (this.currentId) {
      bridge.llm.abort(this.currentId).catch(() => {})
      this._flushParser()
      const result = this._finalise()
      if (result.text) bus.emit('chat:done', { ...result, aborted: true })
      this._finish({ ...result, aborted: true })
    }
    this.streaming = false
    this.currentId = null
  }

  clear() {
    this.abort()
    this.history = []
    this._persist()
    bus.emit('chat:cleared')
  }

  _persist() {
    const trimmed = this.history.slice(-40)
    this.history = trimmed
    this.state.chatHistory = trimmed
    bus.emit('state:changed', { chatHistory: trimmed, stats: this.state.stats })
  }

  /** Compact transcript for the system prompt / debugging. */
  summary(maxItems = 6) {
    const who = this.getSettings()?.chat?.personaName || '助手'
    return this.history
      .slice(-maxItems)
      .map((m) => `${m.role === 'user' ? '用户' : who}: ${truncate(m.content, 80)}`)
      .join('\n')
  }
}
