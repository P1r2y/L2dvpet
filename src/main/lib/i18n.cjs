'use strict'
/**
 * UI localisation (main-process half).
 *
 * Keys ARE the English source strings — see `src/renderer/core/i18n.js` for the
 * rationale. Both processes read the same table file, so a string translated
 * once shows up in the window, the tray menu and the dialogs alike.
 */
const ZH = require('../shared/i18n.zh.json')

const TABLES = { 'zh-CN': ZH }
const LANGS = ['auto', 'en', 'zh-CN']

let lang = 'en'

/** Maps an Electron locale tag (`zh-CN`, `zh-TW`, …) onto a table we have. */
function fromLocale(locale) {
  return String(locale || '').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

/**
 * Applies a value from the `ui.language` setting. `auto` is resolved against the
 * application locale, which Electron only knows once the app is ready — callers
 * pass it in; anything unknown falls back to English.
 */
function setLang(value, appLocale) {
  const want = !value || value === 'auto' ? fromLocale(appLocale) : value
  lang = TABLES[want] ? want : 'en'
  return lang
}

function getLang() {
  return lang
}

/** Translates one string; `{name}` placeholders are filled from `vars`. */
function t(s, vars) {
  const table = TABLES[lang]
  let out = (table && table[s]) || s
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
  return out
}

module.exports = { t, setLang, getLang, LANGS }
