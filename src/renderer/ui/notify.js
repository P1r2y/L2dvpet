/** Transient toast notifications. */
import { t } from '../core/i18n.js'

let timer = null

/**
 * Shows a transient toast.
 *
 * The message is translated here, so callers can pass the English source text
 * straight through. A string with runtime values stays the caller's job: build
 * it with `t()` and placeholders (`{n}`, `{name}`, …) instead of concatenating
 * fragments. Re-translating an already-translated string is a no-op, since keys
 * are English.
 */
export function toast(message, kind = '', durationMs = 2600) {
  const el = document.getElementById('toast')
  if (!el) return
  el.textContent = t(String(message || ''))
  el.className = `toast ${kind}`.trim()
  if (timer) clearTimeout(timer)
  const d = Math.max(900, durationMs)
  timer = setTimeout(() => el.classList.add('hidden'), d)
}

export const toastOk = (m, d) => toast(m, 'ok', d)
export const toastErr = (m, d = 4200) => toast(m, 'err', d)
