'use strict'
/**
 * GPT-SoVITS client (api_v2).
 *
 * GPT-SoVITS is a local voice-cloning service: hand it a fine-tuned GPT +
 * SoVITS weight pair (a resident model) or a short reference clip (zero-shot
 * cloning) and it speaks in that voice. It runs as a small local HTTP service,
 * so the pet can call it directly. Nothing is bundled or downloaded here — the
 * app only talks to the API.
 *
 * Reference: https://github.com/RVC-Boss/GPT-SoVITS
 *
 * Endpoints used:
 *   GET  /tts?text=..&text_lang=..&ref_audio_path=..&prompt_text=..&prompt_lang=..
 *        -> audio/wav
 *   GET  /set_gpt_weights?weights_path=..
 *   GET  /set_sovits_weights?weights_path=..
 *   GET  /docs  (availability probe; falls back to /tts HEAD-less probe)
 */
const DEFAULT_BASE_URL = 'http://127.0.0.1:9880'

/** Reference modes supported by api_v2. */
const REF_MODES = [
  { value: 'audio', label: 'Reference audio (sent with every request)' },
  { value: 'weights', label: 'Resident model (set weights, then synthesize)' },
]

const TEXT_LANGS = [
  { value: 'zh', label: 'Chinese' },
  { value: 'ja', label: 'Japanese' },
  { value: 'en', label: 'English' },
  { value: 'ko', label: 'Korean' },
  { value: 'yue', label: 'Cantonese' },
  { value: 'auto', label: 'Auto-split (mixed Chinese/English)' },
  { value: 'auto_yue', label: 'Auto-split (mixed Cantonese/English)' },
  { value: 'all_ja', label: 'Japanese first' },
  { value: 'all_zh', label: 'Chinese first' },
]

function normaliseBase(url) {
  const base = String(url || DEFAULT_BASE_URL).trim().replace(/\/+$/, '')
  if (!base) return DEFAULT_BASE_URL
  return /^https?:\/\//i.test(base) ? base : `http://${base}`
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 120000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** @returns {Promise<{ok:boolean, version?:string, message?:string}>} */
async function probe(baseUrl, timeoutMs = 2500) {
  const base = normaliseBase(baseUrl)
  try {
    // `/docs` is served by the FastAPI app api_v2.py exposes.
    const res = await fetchWithTimeout(`${base}/docs`, {}, timeoutMs)
    if (res.ok) return { ok: true }
    return { ok: false, message: `HTTP ${res.status}` }
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'Connection timed out' : err.message
    return { ok: false, message: msg }
  }
}

/** Loads a fine-tuned model so later requests need no reference audio. */
async function setWeights(baseUrl, { gptWeights, sovitsWeights }) {
  const base = normaliseBase(baseUrl)
  const done = []
  if (gptWeights) {
    const res = await fetchWithTimeout(
      `${base}/set_gpt_weights?weights_path=${encodeURIComponent(gptWeights)}`,
      {},
      60000
    )
    if (!res.ok) throw new Error(`set_gpt_weights failed HTTP ${res.status}`)
    done.push('gpt')
  }
  if (sovitsWeights) {
    const res = await fetchWithTimeout(
      `${base}/set_sovits_weights?weights_path=${encodeURIComponent(sovitsWeights)}`,
      {},
      60000
    )
    if (!res.ok) throw new Error(`set_sovits_weights failed HTTP ${res.status}`)
    done.push('sovits')
  }
  return done
}

/**
 * On Windows the GPT-SoVITS server handles text as GBK: any character **without a
 * GBK encoding** fails the whole request with 400/500 (the server reports
 * `'gbk' codec can't encode character …`). Measured triggers include the middle
 * dot U+30FB in "ロキシー・ミグルディア", the symbols ♪ ♥ ✓ ©, and every emoji,
 * whereas ★ → ① ℃ … all work fine — they do have GBK encodings, so the rule
 * matches GBK coverage character for character.
 *
 * Node has no GBK encoder, but `TextDecoder('gbk')` can be run over every byte
 * pair to enumerate all 23939 encodable characters; building that set once at
 * runtime gives the exact set (character for character identical to Python's
 * gbk codec).
 */
const GBK_CHARS = (() => {
  try {
    const dec = new TextDecoder('gbk', { fatal: true })
    const set = new Set()
    const pair = new Uint8Array(2)
    for (let lead = 0x81; lead <= 0xfe; lead++) {
      for (let trail = 0x40; trail <= 0xfe; trail++) {
        if (trail === 0x7f) continue
        pair[0] = lead
        pair[1] = trail
        try {
          const s = dec.decode(pair)
          if (s) set.add(s)
        } catch {
          /* not a valid GBK byte pair */
        }
      }
    }
    return set.size > 0 ? set : null
  } catch {
    return null // no GBK support at runtime → return the text unchanged
  }
})()

/**
 * Replaces the characters the server cannot encode with a space (which keeps word
 * breaks) and collapses the runs of whitespace that creates.
 * Only the text actually sent to the service is affected; the chat bubble and
 * the history keep the original characters.
 */
function toGbkSafe(text) {
  if (!GBK_CHARS) return text
  let out = ''
  let replaced = 0
  for (const ch of text) {
    if (ch.codePointAt(0) < 0x80 || GBK_CHARS.has(ch)) out += ch
    else {
      out += ' '
      replaced += 1
    }
  }
  if (!replaced) return text
  return out.replace(/[ \t]{2,}/g, ' ').trim()
}

/**
 * Synthesizes to a WAV buffer.
 * @param {string} text
 * @param {object} opts
 * @returns {Promise<Buffer>}
 */
async function synthesize(text, opts = {}) {
  const clean = toGbkSafe(String(text || '').trim())
  if (!clean) return Buffer.alloc(0)
  const base = normaliseBase(opts.baseUrl)

  // 1. Optionally (re)load the fine-tuned weights once per session.
  if (opts.useWeights && (opts.gptWeights || opts.sovitsWeights)) {
    const key = `${opts.gptWeights}|${opts.sovitsWeights}`
    if (global.__petGsvWeights !== key) {
      await setWeights(base, opts)
      global.__petGsvWeights = key
    }
  }

  const params = new URLSearchParams()
  params.set('text', clean.slice(0, 1500))
  params.set('text_lang', opts.textLang || 'zh')
  params.set('text_split_method', opts.splitMethod || 'cut5')
  params.set('batch_size', '1')
  params.set('media_type', 'wav')
  params.set('streaming_mode', 'false')

  if (opts.useWeights) {
    // Weights mode: reference fields are optional once weights are loaded.
    if (opts.refAudio) {
      params.set('ref_audio_path', opts.refAudio)
      params.set('prompt_text', opts.promptText || '')
      params.set('prompt_lang', opts.promptLang || opts.textLang || 'zh')
    }
  } else {
    if (!opts.refAudio) {
      throw new Error('GPT-SoVITS needs a reference audio path (or switch to "resident model" mode and set the weight paths)')
    }
    params.set('ref_audio_path', opts.refAudio)
    params.set('prompt_text', opts.promptText || '')
    params.set('prompt_lang', opts.promptLang || opts.textLang || 'zh')
  }

  if (opts.speed && Math.abs(opts.speed - 1) > 0.001) params.set('speed_factor', String(opts.speed))

  const res = await fetchWithTimeout(`${base}/tts?${params.toString()}`, {}, 180000)
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    let msg = detail
    try {
      const j = JSON.parse(detail)
      msg = j.message || j.detail || detail
    } catch {
      /* raw */
    }
    const hint =
      res.status === 400
        ? ' (common causes: the reference audio path does not exist, prompt_text does not match the audio, or the weights are not set)'
        : res.status === 404
          ? ' (wrong endpoint; the GPT-SoVITS API port defaults to 9880)'
          : ''
    throw new Error(`GPT-SoVITS /tts failed HTTP ${res.status}${hint}: ${String(msg).slice(0, 300)}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length) throw new Error('GPT-SoVITS returned empty audio')
  return buf
}

/** Clears the cached weights so the next call reloads them. */
function resetWeightsCache() {
  global.__petGsvWeights = null
}

module.exports = {
  synthesize,
  probe,
  setWeights,
  resetWeightsCache,
  toGbkSafe,
  GBK_CHARS,
  REF_MODES,
  TEXT_LANGS,
  DEFAULT_BASE_URL,
}
