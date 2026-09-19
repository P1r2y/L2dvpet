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
  { id: 'zh-CN', label: 'Chinese (Mandarin)', short: 'ZH' },
  { id: 'ja-JP', label: 'Japanese', short: 'JA' },
  { id: 'en-US', label: 'English (US)', short: 'EN' },
  { id: 'zh-TW', label: 'Chinese (Traditional, Taiwan)', short: 'ZH-T' },
  { id: 'zh-HK', label: 'Cantonese', short: 'YUE' },
  { id: 'ko-KR', label: 'Korean', short: 'KO' },
  { id: 'fr-FR', label: 'Français', short: 'FR' },
  { id: 'de-DE', label: 'Deutsch', short: 'DE' },
  { id: 'es-ES', label: 'Español', short: 'ES' },
  { id: 'ru-RU', label: 'Русский', short: 'RU' },
]

const LANGUAGE_IDS = LANGUAGES.map((l) => l.id)

/**
 * Factory defaults per language. `rate` is the engine-neutral speed hint;
 * `openai` is the voice id the online engine uses when the user has not
 * overridden it for this language.
 */
const BUILTIN_PROFILES = {
  'zh-CN': { openai: 'nova', rate: '+0%' },
  'ja-JP': { openai: 'nova', rate: '+0%' },
  'en-US': { openai: 'nova', rate: '+0%' },
  'zh-TW': { openai: 'nova', rate: '+0%' },
  'zh-HK': { openai: 'nova', rate: '+0%' },
  'ko-KR': { openai: 'nova', rate: '+0%' },
  'fr-FR': { openai: 'nova', rate: '+0%' },
  'de-DE': { openai: 'nova', rate: '+0%' },
  'es-ES': { openai: 'nova', rate: '+0%' },
  'ru-RU': { openai: 'nova', rate: '+0%' },
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
    case 'openai':
      return profile.openai || ''
    default:
      return ''
  }
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
}
