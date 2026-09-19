/** Transient toast notifications. */

let timer = null

export function toast(message, kind = '', durationMs = 2600) {
  const el = document.getElementById('toast')
  if (!el) return
  el.textContent = String(message || '')
  el.className = `toast ${kind}`.trim()
  if (timer) clearTimeout(timer)
  const d = Math.max(900, durationMs)
  timer = setTimeout(() => el.classList.add('hidden'), d)
}

export const toastOk = (m, d) => toast(m, 'ok', d)
export const toastErr = (m, d = 4200) => toast(m, 'err', d)
