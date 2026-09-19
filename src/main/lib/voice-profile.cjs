'use strict'
/**
 * Language-aware voice profiles.
 *
 * A single global "voice" cannot serve a companion that may answer in Chinese,
 * Japanese or English — the engine, the voice id and the speed all need to
 * change with the language. This module
 *
 *   1. detects the language of the text about to be spoken,
 *   2. resolves which voice to use for the engine that will speak it,
 *   3. keeps user overrides in `settings.voice.languageProfiles[lang]`.
 *
 * `voice.languageMode` may be `auto` or a concrete locale such as `ja-JP`.
 */

/** Locales offered in the settings panel, in display order. */
const LANGUAGES = [
  { id: 'zh-CN', label: '中文（普通话）', short: '中' },
  { id: 'ja-JP', label: '日本語', short: '日' },
  { id: 'en-US', label: 'English (US)', short: 'EN' },
  { id: 'zh-TW', label: '中文（台灣）', short: '繁' },
  { id: 'zh-HK', label: '粵語', short: '粵' },
  { id: 'ko-KR', label: '한국어', short: '한' },
  { id: 'fr-FR', label: 'Français', short: 'FR' },
  { id: 'de-DE', label: 'Deutsch', short: 'DE' },
  { id: 'es-ES', label: 'Español', short: 'ES' },
  { id: 'ru-RU', label: 'Русский', short: 'RU' },
]

const LANGUAGE_IDS = LANGUAGES.map((l) => l.id)

/**
 * Factory defaults per language. `rate` is the engine-neutral speed hint;
 * `sapiRate` overrides it for the offline Windows engine (which is slow and
 * robotic, so it usually wants a nudge).
 */
const BUILTIN_PROFILES = {
  'zh-CN': { edge: 'zh-CN-XiaoyiNeural', sapi: '', openai: 'nova', voicevox: null, rate: '+0%', sapiRate: '+5%' },
  'ja-JP': { edge: 'ja-JP-NanamiNeural', sapi: '', openai: 'nova', voicevox: 0, rate: '+0%', sapiRate: '+0%' },
  'en-US': { edge: 'en-US-AriaNeural', sapi: 'Microsoft Zira Desktop', openai: 'nova', voicevox: null, rate: '+0%', sapiRate: '+0%' },
  'zh-TW': { edge: 'zh-TW-HsiaoChenNeural', sapi: '', openai: 'nova', voicevox: null, rate: '+0%', sapiRate: '+0%' },
  'zh-HK': { edge: 'zh-HK-HiuMaanNeural', sapi: '', openai: 'nova', voicevox: null, rate: '+0%', sapiRate: '+0%' },
  'ko-KR': { edge: 'ko-KR-SunHiNeural', sapi: '', openai: 'nova', voicevox: null, rate: '+0%', sapiRate: '+0%' },
  'fr-FR': { edge: 'fr-FR-DeniseNeural', sapi: '', openai: 'nova', voicevox: null, rate: '+0%', sapiRate: '+0%' },
  'de-DE': { edge: 'de-DE-KatjaNeural', sapi: '', openai: 'nova', voicevox: null, rate: '+0%', sapiRate: '+0%' },
  'es-ES': { edge: 'es-ES-ElviraNeural', sapi: '', openai: 'nova', voicevox: null, rate: '+0%', sapiRate: '+0%' },
  'ru-RU': { edge: 'ru-RU-SvetlanaNeural', sapi: '', openai: 'nova', voicevox: null, rate: '+0%', sapiRate: '+0%' },
}

const FALLBACK_LANGUAGE = 'zh-CN'

const RE_KANA = /[\u3040-\u309F\u30A0-\u30FF\uFF66-\uFF9D]/g
const RE_HANGUL = /[\uAC00-\uD7AF\u1100-\u11FF]/g
const RE_HAN = /[\u4E00-\u9FFF\u3400-\u4DBF]/g
const RE_LATIN = /[A-Za-z]/g
const RE_CYRILLIC = /[\u0400-\u04FF]/g

function count(text, re) {
  const m = text.match(re)
  return m ? m.length : 0
}

/**
 * Script-based language detection. Kana and Hangul are unambiguous markers;
 * Han-only text is assumed Simplified Chinese (Traditional/HK are selectable
 * manually, since they cannot be told apart reliably by script alone).
 */
function detectLanguage(text) {
  const s = String(text || '')
  if (!s.trim()) return FALLBACK_LANGUAGE

  // Markup we strip before speaking must not skew the ratio.
  const clean = s.replace(/https?:\/\/\S+/g, ' ')

  const kana = count(clean, RE_KANA)
  if (kana > 0) return 'ja-JP'

  const hangul = count(clean, RE_HANGUL)
  if (hangul > 0) return 'ko-KR'

  const han = count(clean, RE_HAN)
  const latin = count(clean, RE_LATIN)
  const cyr = count(clean, RE_CYRILLIC)

  if (han === 0 && cyr > latin && cyr > 0) return 'ru-RU'
  // Chinese text is dense in Han characters; English with a few tags is not.
  if (han > 0 && han * 3 >= latin) return 'zh-CN'
  if (latin > 0) return 'en-US'
  return FALLBACK_LANGUAGE
}

/** Merged profile for a locale: built-in defaults overlaid with user overrides. */
function profileFor(settings, lang) {
  const saved = (settings?.voice?.languageProfiles || {})[lang] || {}
  const builtin = BUILTIN_PROFILES[lang] || BUILTIN_PROFILES[FALLBACK_LANGUAGE]
  const merged = { ...builtin, ...saved }
  // `null` in a saved profile means "inherit the built-in value".
  for (const k of Object.keys(merged)) if (merged[k] === null && k in builtin) merged[k] = builtin[k]
  return merged
}

/**
 * @param {object} settings
 * @param {string} text the text about to be spoken
 * @returns {{lang:string, mode:string, detected:string, profile:object}}
 */
function resolveProfile(settings, text) {
  const mode = settings?.voice?.languageMode || 'auto'
  const detected = detectLanguage(text)
  const lang = mode === 'auto' ? detected : mode
  return { lang, mode, detected, profile: profileFor(settings, lang) }
}

/** The voice id to hand to a given engine for this profile. */
function voiceForProvider(profile, provider) {
  if (!profile) return ''
  switch (provider) {
    case 'edge':
      return profile.edge || ''
    case 'sapi':
      return profile.sapi || ''
    case 'openai':
      return profile.openai || ''
    case 'voicevox':
      return profile.voicevox === null || profile.voicevox === undefined ? null : Number(profile.voicevox)
    default:
      return ''
  }
}

/** Shifts an Edge-style "+N%" string, used to fold in the global pitch compensation. */
function scalePercentString(value, multiplier, fallbackPercent = 0) {
  const m = /^\s*([+-]?[\d.]+)\s*%?\s*$/.exec(String(value ?? ''))
  const base = m ? Number(m[1]) / 100 : fallbackPercent / 100
  const pct = Math.round((1 + base) * multiplier * 100 - 100)
  return `${pct >= 0 ? '+' : ''}${pct}%`
}

module.exports = {
  LANGUAGES,
  LANGUAGE_IDS,
  BUILTIN_PROFILES,
  FALLBACK_LANGUAGE,
  detectLanguage,
  profileFor,
  resolveProfile,
  voiceForProvider,
  scalePercentString,
}
