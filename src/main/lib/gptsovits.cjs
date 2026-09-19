'use strict'
/**
 * GPT-SoVITS client (api_v2).
 *
 * GPT-SoVITS is a local voice-cloning service: hand it a fine-tuned GPT +
 * SoVITS weight pair（常驻模型）or a short reference clip（零样本克隆）, and it
 * speaks in that voice. It runs as a small local HTTP service, so the pet can
 * call it directly. Nothing is bundled or downloaded here — the app only
 * talks to the API.
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
  { value: 'audio', label: '参考音频（每次请求带上）' },
  { value: 'weights', label: '常驻模型（先设置权重，再合成）' },
]

const TEXT_LANGS = [
  { value: 'zh', label: '中文' },
  { value: 'ja', label: '日本語' },
  { value: 'en', label: 'English' },
  { value: 'ko', label: '한국어' },
  { value: 'yue', label: '粵語' },
  { value: 'auto', label: '自动切分（中英混合）' },
  { value: 'auto_yue', label: '自动切分（粤英混合）' },
  { value: 'all_ja', label: '日语优先' },
  { value: 'all_zh', label: '中文优先' },
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
    const msg = err.name === 'AbortError' ? '连接超时' : err.message
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
    if (!res.ok) throw new Error(`set_gpt_weights 失败 HTTP ${res.status}`)
    done.push('gpt')
  }
  if (sovitsWeights) {
    const res = await fetchWithTimeout(
      `${base}/set_sovits_weights?weights_path=${encodeURIComponent(sovitsWeights)}`,
      {},
      60000
    )
    if (!res.ok) throw new Error(`set_sovits_weights 失败 HTTP ${res.status}`)
    done.push('sovits')
  }
  return done
}

/**
 * GPT-SoVITS 服务端在 Windows 上以 GBK 处理文本：凡是**没有 GBK 编码**的字符，
 * 都会让整条请求以 400/500 失败（服务端报 `'gbk' codec can't encode character …`）。
 * 实测触发字符包括「ロキシー・ミグルディア」的间隔号 U+30FB、♪ ♥ ✓ ©，以及全部 emoji；
 * 而 ★ → ① ℃ … 这些有 GBK 编码的符号一切正常 —— 规则与 GBK 编码能力逐字符吻合。
 *
 * Node 没有 GBK 编码器，但 `TextDecoder('gbk')` 可以反向枚举出全部 23939 个可编码字符，
 * 运行时构建一次即可得到精确集合（与 Python 的 gbk 编解码器逐字符一致）。
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
          /* 不是合法 GBK 字节对 */
        }
      }
    }
    return set.size > 0 ? set : null
  } catch {
    return null // 运行时不带 GBK 支持 → 原样返回，不做处理
  }
})()

/**
 * 把服务端编码不了的字符换成空格（保住断词），并合并因此产生的连续空白。
 * 只影响真正发给服务的文本；聊天气泡与历史记录里显示的原样保留。
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
      throw new Error('GPT-SoVITS 需要参考音频路径（或改用「常驻模型」模式并设置权重路径）')
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
        ? '（常见原因：参考音频路径不存在、prompt_text 与音频不匹配、或模型权重未设置）'
        : res.status === 404
          ? '（接口地址不对，GPT-SoVITS 的 API 端口默认是 9880）'
          : ''
    throw new Error(`GPT-SoVITS /tts 失败 HTTP ${res.status}${hint}: ${String(msg).slice(0, 300)}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length) throw new Error('GPT-SoVITS 返回了空音频')
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
