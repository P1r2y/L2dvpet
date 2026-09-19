'use strict'
/**
 * OpenAI-compatible Chat Completions client with SSE streaming.
 * Works with OpenAI, DeepSeek, Moonshot, Zhipu, SiliconFlow, Ollama, LM Studio, vLLM, ...
 */

/** Accepts base ("https://api.x.com/v1") or full endpoint URLs. */
function resolveEndpoint(baseUrl, suffix) {
  let base = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!base) throw new Error('API base URL is empty — fill it in the settings panel')
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`
  if (base.endsWith(suffix)) return base
  return `${base}${suffix}`
}

function parseExtraHeaders(raw) {
  const out = {}
  if (!raw) return out
  const text = String(raw).trim()
  if (!text) return out
  try {
    // allow JSON object form
    if (text.startsWith('{')) {
      const obj = JSON.parse(text)
      for (const [k, v] of Object.entries(obj)) out[k] = String(v)
      return out
    }
  } catch {
    /* fall through to line form */
  }
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return out
}

function buildHeaders(cfg) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream, application/json',
    'User-Agent': 'AI-DesktopPet/1.0',
    ...parseExtraHeaders(cfg.extraHeaders),
  }
  const key = String(cfg.apiKey || '').trim()
  if (key) headers.Authorization = `Bearer ${key}`
  return headers
}

/**
 * Streams a chat completion.
 * @returns {AsyncGenerator<{type:'delta'|'done'|'usage', text?:string, usage?:object, raw?:any}>}
 */
async function* streamChat(cfg, messages, signal) {
  const url = resolveEndpoint(cfg.baseUrl, '/chat/completions')
  const body = {
    model: cfg.model,
    messages,
    temperature: Number(cfg.temperature ?? 0.85),
    top_p: Number(cfg.topP ?? 0.95),
    max_tokens: Number(cfg.maxTokens ?? 512) || undefined,
    stream: true,
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(cfg),
    body: JSON.stringify(body),
    signal,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(httpError(res.status, text, url))
  }
  if (!res.body) throw new Error('Server returned no response stream')

  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let sawContent = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE frames are separated by a blank line; be tolerant of \r\n and lone \n.
      let sep
      while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const frame = buffer.slice(0, sep)
        buffer = buffer.slice(sep + (buffer[sep] === '\r' ? 4 : 2))
        const payload = sseData(frame)
        if (payload === null) continue
        if (payload === '[DONE]') {
          yield { type: 'done' }
          return
        }
        let json
        try {
          json = JSON.parse(payload)
        } catch {
          continue
        }
        if (json.error) throw new Error(json.error.message || JSON.stringify(json.error))
        const choice = json.choices && json.choices[0]
        const piece =
          (choice && choice.delta && typeof choice.delta.content === 'string' && choice.delta.content) ||
          (choice && choice.message && typeof choice.message.content === 'string' && choice.message.content) ||
          (choice && typeof choice.text === 'string' && choice.text) ||
          ''
        if (piece) {
          sawContent = true
          yield { type: 'delta', text: piece }
        }
        if (json.usage) yield { type: 'usage', usage: json.usage }
        if (choice && choice.finish_reason) {
          yield { type: 'done', raw: choice.finish_reason }
          return
        }
      }
    }

    // Flush any trailing frame without a blank-line terminator.
    const tail = sseData(buffer)
    if (tail && tail !== '[DONE]') {
      try {
        const json = JSON.parse(tail)
        const piece = json.choices?.[0]?.delta?.content
        if (piece) {
          sawContent = true
          yield { type: 'delta', text: piece }
        }
      } catch {
        /* ignore */
      }
    }
    if (!sawContent) {
      // Some servers return a plain JSON body when they ignore stream:true.
      if (buffer.trim().startsWith('{')) {
        try {
          const json = JSON.parse(buffer)
          const text = json.choices?.[0]?.message?.content
          if (text) yield { type: 'delta', text }
        } catch {
          /* ignore */
        }
      }
    }
    yield { type: 'done' }
  } finally {
    try {
      reader.cancel()
    } catch {
      /* ignore */
    }
  }
}

function sseData(frame) {
  const lines = frame.split(/\r?\n/)
  const parts = []
  for (const line of lines) {
    const trimmed = line.trimStart()
    if (!trimmed.startsWith('data:')) continue
    parts.push(trimmed.slice(5).trimStart())
  }
  if (!parts.length) return null
  return parts.join('\n')
}

function httpError(status, bodyText, url) {
  let detail = bodyText
  try {
    const j = JSON.parse(bodyText)
    detail = j.error?.message || j.message || j.detail || bodyText
  } catch {
    /* keep raw */
  }
  detail = String(detail || '').slice(0, 500)
  const hint =
    status === 401
      ? ' (invalid or missing API key)'
      : status === 404
        ? ' (endpoint or model does not exist — check that the base URL includes /v1)'
        : status === 429
          ? ' (too many requests, or out of credit)'
          : ''
  return `Request failed HTTP ${status}${hint}: ${detail || url}`
}

/** Non-streaming request, used by the "test connection" button. */
async function chatOnce(cfg, messages, signal) {
  const url = resolveEndpoint(cfg.baseUrl, '/chat/completions')
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...buildHeaders(cfg), Accept: 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: Number(cfg.temperature ?? 0.85),
      max_tokens: Number(cfg.maxTokens ?? 512) || undefined,
      stream: false,
    }),
    signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(httpError(res.status, text, url))
  }
  const json = await res.json()
  return json.choices?.[0]?.message?.content ?? ''
}

/** Fetches the model list so the settings panel can offer a dropdown. */
async function listModels(cfg, signal) {
  const url = resolveEndpoint(cfg.baseUrl, '/models')
  const res = await fetch(url, { headers: buildHeaders(cfg), signal })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(httpError(res.status, text, url))
  }
  const json = await res.json()
  const arr = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : []
  return arr.map((m) => m.id || m.name || m.model).filter(Boolean)
}

module.exports = { streamChat, chatOnce, listModels, resolveEndpoint, parseExtraHeaders }
