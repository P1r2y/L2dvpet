/** Assorted DOM / math helpers shared by every renderer module. */

export const $ = (sel, root = document) => root.querySelector(sel)
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
export const lerp = (a, b, t) => a + (b - a) * t
export const rand = (a, b) => a + Math.random() * (b - a)
export const randInt = (a, b) => Math.floor(rand(a, b + 1))
export const pick = (arr) => (arr && arr.length ? arr[Math.floor(Math.random() * arr.length)] : undefined)
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const round = (v, n = 2) => Math.round(v * 10 ** n) / 10 ** n

/** Frame-rate independent exponential smoothing factor. */
export function smoothFactor(perFrameAt60, dtSeconds) {
  const f = clamp(perFrameAt60, 0.0001, 1)
  return 1 - Math.pow(1 - f, dtSeconds * 60)
}

export function debounce(fn, ms) {
  let t = null
  const wrapped = (...args) => {
    if (t) clearTimeout(t)
    t = setTimeout(() => {
      t = null
      fn(...args)
    }, ms)
  }
  wrapped.cancel = () => t && clearTimeout(t)
  return wrapped
}

export function throttle(fn, ms) {
  let last = 0
  let timer = null
  let pending = null
  return (...args) => {
    pending = args
    const now = performance.now()
    if (now - last >= ms) {
      last = now
      fn(...pending)
      pending = null
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null
        last = performance.now()
        if (pending) fn(...pending)
        pending = null
      }, ms - (now - last))
    }
  }
}

/** Creates an element with attributes/props and children in one call. */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue
    if (k === 'class') node.className = v
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v)
    else if (k === 'dataset' && typeof v === 'object') Object.assign(node.dataset, v)
    else if (k === 'html') node.innerHTML = v
    else if (k === 'text') node.textContent = v
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v)
    else if (k === 'value') node.value = v
    else if (k === 'checked' || k === 'disabled' || k === 'selected') node[k] = !!v
    else node.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of children.flat(4)) {
    if (c === null || c === undefined || c === false) continue
    node.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return node
}

/** Normalises mixed full-width / half-width punctuation for cleaner TTS input. */
export function cleanForSpeech(text) {
  return String(text || '')
    .replace(/\[[^\]]{1,24}\]/g, '') // strip [emotion] / [motion:x] tags
    .replace(/[*_`~#>|]/g, '')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/\s*\n+\s*/g, '，')
    .replace(/[，。！？、；：]{2,}/g, (m) => m[0])
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** Rough token-aware truncation that never splits a surrogate pair. */
export function truncate(text, max) {
  const s = String(text || '')
  if (s.length <= max) return s
  return `${s.slice(0, max - 1)}…`
}

export function formatClock(d = new Date()) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
