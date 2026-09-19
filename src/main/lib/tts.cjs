'use strict'
/**
 * Text-to-speech dispatch. Every provider resolves to the same shape:
 *   { kind: 'audio', mime, base64 }  — renderer plays it through Web Audio
 * Throws Error with a human-readable Chinese message on failure.
 *
 * Two engines only:
 *   gptsovits — a locally hosted GPT-SoVITS instance, for cloned character voices
 *   openai    — any OpenAI-compatible POST /audio/speech endpoint
 */
const gptsovits = require('./gptsovits.cjs')
const { resolveProfile, voiceForProvider } = require('./voice-profile.cjs')
const { resolveEndpoint, parseExtraHeaders } = require('./llm.cjs')

/* ------------------------------------------------------------------ *
 * Pitch shifting ("声线") — provider independent
 *
 * Neither engine exposes a usable pitch control, so we do it the way a
 * voice changer does: ask the engine for a *slower* rendition, then play it
 * back faster. `playbackRate` restores the original duration while raising the
 * pitch, and `preservesPitch = false` in the renderer keeps the pitch change.
 * The renderer applies `playbackRate = pitchShift`; here we only pre-compensate
 * the engine's own speed.
 * ------------------------------------------------------------------ */
function pitchOf(settings) {
  const p = Number(settings?.voice?.pitchShift)
  return Number.isFinite(p) && p > 0 ? Math.max(0.5, Math.min(2, p)) : 1
}

/** `'+10%'` -> `1.1`, `'-5%'` -> `0.95`. Used for the per-language speed hint. */
function percentToMultiplier(value) {
  const m = /^\s*([+-]?[\d.]+)\s*%?\s*$/.exec(String(value ?? ''))
  return m ? 1 + Number(m[1]) / 100 : 1
}

/** OpenAI-compatible POST /v1/audio/speech. */
async function openaiSpeech(cfg, text, speedMul = 1) {
  const url = resolveEndpoint(cfg.baseUrl, '/audio/speech')
  const headers = { 'Content-Type': 'application/json' }
  const key = String(cfg.apiKey || '').trim()
  if (key) headers.Authorization = `Bearer ${key}`
  Object.assign(headers, parseExtraHeaders(cfg.extraHeaders))

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: cfg.model || 'tts-1',
      input: text,
      voice: cfg.voice || 'nova',
      response_format: cfg.format || 'mp3',
      speed: Math.max(0.25, Math.min(4, Number(cfg.speed ?? 1) * speedMul)) || 1,
    }),
  })
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
    throw new Error(`TTS 请求失败 HTTP ${res.status}${hint}: ${String(msg).slice(0, 300)}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length) throw new Error('TTS 返回了空音频')
  // Trust the server's content type when it sends one — some gateways ignore
  // the requested `response_format` and answer with WAV or Opus regardless.
  const served = String(res.headers.get('content-type') || '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  const fmt = String(cfg.format || 'mp3').toLowerCase()
  const mime = served.startsWith('audio/')
    ? served
    : fmt === 'wav'
      ? 'audio/wav'
      : fmt === 'opus'
        ? 'audio/ogg'
        : fmt === 'aac'
          ? 'audio/aac'
          : 'audio/mpeg'
  return { kind: 'audio', mime, base64: buf.toString('base64'), provider: 'openai' }
}

/**
 * Maps an app language tag ("zh-CN") to the code GPT-SoVITS expects ("zh").
 * Anything the model's G2P does not know falls back to Chinese.
 */
function gsvLangFor(lang) {
  const two = String(lang || '').slice(0, 2).toLowerCase()
  if (two === 'zh') return String(lang).toLowerCase().includes('yue') ? 'yue' : 'zh'
  if (['ja', 'en', 'ko', 'yue'].includes(two)) return two
  return 'zh'
}

/**
 * @param {object} settings full settings object
 * @param {string} text
 * @returns {Promise<object>}
 */
async function synthesize(settings, text) {
  const v = settings.voice || {}
  const provider = v.ttsProvider || 'auto'
  const clean = String(text || '').trim()
  if (!clean) throw new Error('没有可朗读的文本')

  const pitch = pitchOf(settings)
  // The renderer plays audio at `playbackRate = pitch`; compensate the engine.
  const speedMul = 1 / pitch
  // Which language are we about to speak, and with which voice?
  const { lang, mode, detected, profile } = resolveProfile(settings, clean)

  switch (provider) {
    case 'off':
      return { kind: 'none' }

    case 'gptsovits': {
      const g = v.gptsovits || {}
      /*
       * The reference clip's language and the spoken language are independent in
       * GPT-SoVITS (`prompt_lang` vs `text_lang`), and v2ProPlus is multilingual.
       * So follow the language of the text being spoken unless the user pinned
       * one explicitly — otherwise Chinese lines get read by the Japanese G2P.
       */
      const autoLang = String(v.languageMode ?? 'auto') === 'auto'
      const gsvLang = autoLang ? gsvLangFor(lang) : g.textLang || gsvLangFor(lang)
      const buf = await gptsovits.synthesize(clean, {
        baseUrl: g.baseUrl,
        useWeights: g.mode === 'weights',
        gptWeights: g.gptWeights,
        sovitsWeights: g.sovitsWeights,
        refAudio: g.refAudio,
        promptText: g.promptText,
        promptLang: g.promptLang || 'ja',
        textLang: gsvLang,
        splitMethod: g.splitMethod,
        speed: speedMul,
      })
      if (!buf.length) throw new Error('GPT-SoVITS 未返回音频')
      return {
        kind: 'audio',
        mime: 'audio/wav',
        base64: buf.toString('base64'),
        playbackRate: pitch,
        provider: 'gptsovits',
        lang: gsvLang,
        mode,
        detected,
      }
    }

    case 'openai':
    default: {
      const result = await openaiSpeech(
        {
          baseUrl: v.openaiBaseUrl,
          apiKey: v.openaiApiKey || settings.chat?.apiKey || '',
          model: v.openaiModel,
          voice: voiceForProvider(profile, 'openai') || v.openaiVoice,
          format: 'mp3',
          // The profile's per-language speed hint is the base; the global pitch
          // compensation multiplies it.
          speed: percentToMultiplier(profile.rate),
          extraHeaders: settings.chat?.extraHeaders || '',
        },
        clean,
        speedMul
      )
      result.playbackRate = pitch
      Object.assign(result, { lang, mode, detected })
      return result
    }
  }
}

/**
 * Voice catalogue for the settings panel.
 * @returns {Promise<Array<{id:string,name:string,locale:string,gender:string}>>}
 */
async function listVoices(provider) {
  if (provider === 'openai') return OPENAI_VOICES
  return []
}

/** Curated OpenAI / gpt-4o-mini-tts voice set (the API has no list endpoint). */
const OPENAI_VOICES = [
  { id: 'nova', name: 'nova · 温暖女声', locale: 'multi', gender: 'Female' },
  { id: 'shimmer', name: 'shimmer · 清亮女声', locale: 'multi', gender: 'Female' },
  { id: 'coral', name: 'coral · 亲和女声', locale: 'multi', gender: 'Female' },
  { id: 'sage', name: 'sage · 沉稳女声', locale: 'multi', gender: 'Female' },
  { id: 'alloy', name: 'alloy · 中性', locale: 'multi', gender: 'Neutral' },
  { id: 'ballad', name: 'ballad · 柔和男声', locale: 'multi', gender: 'Male' },
  { id: 'echo', name: 'echo · 清朗男声', locale: 'multi', gender: 'Male' },
  { id: 'fable', name: 'fable · 叙事男声', locale: 'multi', gender: 'Male' },
  { id: 'onyx', name: 'onyx · 低沉男声', locale: 'multi', gender: 'Male' },
  { id: 'ash', name: 'ash · 从容男声', locale: 'multi', gender: 'Male' },
]

/** Providers that need a key before they are worth trying. */
const KEYED_PROVIDERS = ['openai']

/**
 * Whether an engine can actually voice a given language.
 *
 * This matters for the online engine: a Chinese-only TTS endpoint cannot speak
 * a Japanese line, and hearing Japanese read by the wrong voice is worse than
 * saying nothing — as long as the user is told why.
 */
function providerSupportsLanguage(provider, lang, settings) {
  if (!lang) return true
  const profile = require('./voice-profile.cjs').profileFor(settings, lang)
  switch (provider) {
    case 'gptsovits': {
      /*
       * v2ProPlus is multilingual, and the reference clip's language is a
       * separate parameter (`prompt_lang`) from the spoken one (`text_lang`).
       * Capability is therefore a property of the *model*, not of whichever
       * text_lang happens to be selected. Gating on that mismatch used to
       * demote GPT-SoVITS behind the generic engine for every Chinese line.
       */
      const profileLang = String(profile.lang || lang).slice(0, 2)
      return ['zh', 'ja', 'en', 'ko', 'yue'].includes(profileLang)
    }
    case 'openai':
      return true // voice catalogues are multilingual
    default:
      return true
  }
}

/**
 * Tries the requested engine, then degrades to the other one until something
 * works. Failures are remembered in `failures` (provider -> timestamp) so a
 * blocked engine is not retried on every single sentence.
 *
 * @param {object} settings
 * @param {string} text
 * @param {{ failures?: object, cooldownMs?: number }} [opts]
 * @returns {Promise<{result: object, failed: Array<{provider:string,message:string}>}>}
 */
async function synthesizeWithFallback(settings, text, opts = {}) {
  const v = settings.voice || {}
  const requested = v.ttsProvider || 'auto'

  // "不朗读" is a hard stop, not something to fall back from.
  if (requested === 'off') return { result: { kind: 'none', provider: 'off', requested }, failed: [] }

  const failures = opts.failures || {}

  /*
   * Escalating cooldown. A flat 30-minute lockout turned one transient failure
   * into half an hour of silence — the engine is usually fine on the very next
   * attempt, so only a *repeat offender* backs off for long.
   * Entries are `{ at, count, error }`; a bare timestamp from an older state
   * file is still understood.
   */
  const FAILURE_BACKOFF_MS = [20_000, 60_000, 5 * 60_000, 30 * 60_000]
  const entryOf = (p) => {
    const e = failures[p]
    if (!e) return null
    return typeof e === 'number' ? { at: e, count: 1 } : e
  }
  const isFresh = (p) => {
    const e = entryOf(p)
    if (!e) return true
    const wait = FAILURE_BACKOFF_MS[Math.min(e.count - 1, FAILURE_BACKOFF_MS.length - 1)]
    return Date.now() - e.at > wait
  }

  const hasOpenaiKey = !!(v.openaiApiKey || settings.chat?.apiKey)
  const gsv = v.gptsovits?.baseUrl
    ? await gptsovits.probe(v.gptsovits.baseUrl, 1500).catch(() => ({ ok: false }))
    : { ok: false }

  const { lang } = resolveProfile(settings, text)

  const chain = []
  const push = (p) => {
    if (p && p !== 'off' && !chain.includes(p)) chain.push(p)
  }
  // An explicitly chosen engine is always tried first, even if it failed before
  // — that is how the user forces a retry from the settings panel.
  if (requested !== 'auto') push(requested)
  // GPT-SoVITS is a cloned character voice, so when it is running it is the
  // most faithful option and goes ahead of the generic engine.
  if (gsv.ok) push('gptsovits')
  if (hasOpenaiKey) push('openai')

  // Engines that can speak this language are tried first. If every one of them
  // fails we still fall back to the rest, but flag it.
  const capable = chain.filter((p) => providerSupportsLanguage(p, lang, settings))
  const rest = chain.filter((p) => !capable.includes(p))
  const ordered = [...capable, ...rest]

  const failed = []
  for (let i = 0; i < ordered.length; i++) {
    const provider = ordered[i]
    const languageMismatch = i >= capable.length
    const isRequested = provider === requested
    if (!isRequested && !isFresh(provider)) continue
    /*
     * One immediate retry. A clone service that is still loading weights, or a
     * connection that was dropped mid-request, usually works on the second try —
     * and retrying here is far cheaper than locking the engine out.
     */
    let lastErr = null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await synthesize({ ...settings, voice: { ...v, ttsProvider: provider } }, text)
        if (!result || result.kind === 'none') break
        return {
          result: {
            ...result,
            provider,
            requested,
            fellBack: requested !== 'auto' && provider !== requested,
            languageMismatch,
            retried: attempt > 0,
          },
          failed,
        }
      } catch (err) {
        lastErr = err
        if (attempt === 0) await new Promise((r) => setTimeout(r, 400))
      }
    }
    if (lastErr) failed.push({ provider, message: String(lastErr?.message || lastErr) })
  }

  const hint =
    'GPT-SoVITS 需要本机服务在运行（设置 → 语音 → GPT-SoVITS 可一键启动）；在线 TTS 接口需要填好地址与 API Key。'
  return {
    result: {
      kind: 'error',
      provider: requested,
      requested,
      lang,
      languageMismatch: capable.length === 0,
      message:
        (failed.length > 0
          ? failed.map((f) => `${f.provider}: ${f.message}`).join(' | ')
          : `没有可用的语音引擎${lang ? `（需要 ${lang} 音色）` : ''}`) + ` 【${hint}】`,
    },
    failed,
  }
}

module.exports = {
  synthesize,
  synthesizeWithFallback,
  providerSupportsLanguage,
  listVoices,
  pitchOf,
  OPENAI_VOICES,
  KEYED_PROVIDERS,
}
