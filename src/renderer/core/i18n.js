/**
 * UI localisation (renderer half).
 *
 * Keys ARE the English source strings. That keeps the code readable, makes an
 * untranslated string fall back to English instead of showing a raw key, and
 * means each table only carries the strings that actually differ from English.
 *
 * The tables live in `src/shared/i18n.<lang>.json` so the main process can load
 * the same file (see `src/main/lib/i18n.cjs`).
 */
import ZH from '../../shared/i18n.zh.json'
import { bus } from './bus.js'

const TABLES = { 'zh-CN': ZH }

/** Values the interface-language setting accepts; anything else falls back to English. */
export const UI_LANGS = ['auto', 'en', 'zh-CN']

let lang = 'en'

/** Resolves `auto` from the OS/browser locale. */
export function systemLang() {
  return String(navigator.language || '').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

/**
 * Applies a value from the `ui.language` setting and returns the language that
 * ended up active (`auto` is resolved here, not stored).
 */
export function setLang(value) {
  const want = !value || value === 'auto' ? systemLang() : value
  const next = TABLES[want] ? want : 'en'
  if (next !== lang) {
    lang = next
    // Anything that renders strings outside the settings panel (dock tooltips,
    // context menu, status HUD) re-renders on this.
    bus.emit('i18n:changed', next)
  }
  return lang
}

export function getLang() {
  return lang
}

/**
 * Translates one string. `{name}` placeholders are filled from `vars`, so a
 * message with runtime values stays a single table entry instead of a pile of
 * concatenated fragments.
 */
export function t(s, vars) {
  const table = TABLES[lang]
  let out = (table && table[s]) || s
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
  return out
}
