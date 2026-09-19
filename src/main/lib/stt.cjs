'use strict'
/**
 * Speech-to-text via any OpenAI-compatible POST /v1/audio/transcriptions
 * (OpenAI Whisper, SiliconFlow SenseVoice, Groq, local faster-whisper servers…).
 */
const { resolveEndpoint } = require('./llm.cjs')

const EXT_BY_MIME = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
}

function pickExtension(mime, fallback = 'webm') {
  const base = String(mime || '').split(';')[0].trim().toLowerCase()
  return EXT_BY_MIME[base] || fallback
}

/**
 * @param {object} settings
 * @param {{ base64: string, mime?: string, language?: string }} audio
 * @returns {Promise<{ text: string, provider: string }>}
 */
async function transcribe(settings, audio) {
  const v = settings.voice || {}
  const baseUrl = v.sttBaseUrl
  const apiKey = String(v.sttApiKey || v.openaiApiKey || settings.chat?.apiKey || '').trim()
  const model = v.sttModel || 'whisper-1'
  const language = audio.language || v.sttLanguage || ''

  if (!audio || !audio.base64) throw new Error('没有录到声音')
  const buffer = Buffer.from(audio.base64, 'base64')
  if (buffer.length < 1200) throw new Error('录音太短了，再说一次吧')

  const url = resolveEndpoint(baseUrl, '/audio/transcriptions')
  const ext = pickExtension(audio.mime)
  const mime = audio.mime || 'audio/webm'

  const form = new FormData()
  form.append('file', new Blob([buffer], { type: mime }), `speech.${ext}`)
  form.append('model', model)
  if (language && language !== 'auto') form.append('language', language)
  form.append('response_format', 'json')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 90000)
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      body: form,
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    if (err.name === 'AbortError') throw new Error('语音识别超时')
    throw new Error(`语音识别请求失败: ${err.message}`)
  }
  clearTimeout(timer)

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    let msg = detail
    try {
      const j = JSON.parse(detail)
      msg = j.error?.message || j.message || detail
    } catch {
      /* raw */
    }
    const hint = res.status === 401 ? '（API Key 无效）' : res.status === 404 ? '（地址或模型名错误）' : ''
    throw new Error(`语音识别失败 HTTP ${res.status}${hint}: ${String(msg).slice(0, 300)}`)
  }

  const json = await res.json().catch(async () => ({ text: await res.text().catch(() => '') }))
  const text = String(json.text ?? json.result ?? json.data?.text ?? '').trim()
  if (!text) throw new Error('没有识别出内容，换个说法试试？')
  return { text, provider: 'openai-compatible' }
}

module.exports = { transcribe, pickExtension }
