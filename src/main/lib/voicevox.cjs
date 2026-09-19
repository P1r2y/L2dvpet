'use strict'
/**
 * VOICEVOX-compatible engine client.
 *
 * VOICEVOX ENGINE (and the API-compatible COEIROINK / LMROID / AivisSpeech)
 * is free, runs fully offline and offers dozens of *anime-style* Japanese
 * voices — far closer to a character voice than any generic neural TTS. It is an
 * optional download the user installs separately; we only talk to its HTTP API.
 *
 *   POST /audio_query?text=...&speaker=<styleId>   -> query JSON
 *   POST /synthesis?speaker=<styleId>  (body=query) -> WAV
 *   GET  /speakers                                  -> voice catalogue
 *   GET  /version                                   -> availability probe
 *
 * Nothing is downloaded or installed by this app.
 */
const DEFAULT_BASE_URL = 'http://127.0.0.1:50021'

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
    const res = await fetchWithTimeout(`${base}/version`, {}, timeoutMs)
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` }
    const version = (await res.text()).replace(/"/g, '').trim()
    return { ok: true, version }
  } catch (err) {
    const msg = err.name === 'AbortError' ? '连接超时' : err.message
    return { ok: false, message: msg }
  }
}

/**
 * Voice catalogue. Each VOICEVOX character exposes several "styles"; we flatten
 * them into one entry per style because the style id is what the API wants.
 * @returns {Promise<Array<{id:number,name:string,locale:string,gender:string,style:string,character:string}>>}
 */
async function listSpeakers(baseUrl) {
  const base = normaliseBase(baseUrl)
  const res = await fetchWithTimeout(`${base}/speakers`, {}, 15000)
  if (!res.ok) throw new Error(`VOICEVOX /speakers 返回 HTTP ${res.status}`)
  const speakers = await res.json()
  const out = []
  for (const sp of Array.isArray(speakers) ? speakers : []) {
    for (const style of sp.styles || []) {
      out.push({
        // The style id is the `speaker` query parameter.
        id: style.id,
        name: `${sp.name} · ${style.name}`,
        character: sp.name,
        style: style.name,
        locale: 'ja-JP',
        gender: /female|女/i.test(style.name) ? 'Female' : '',
      })
    }
  }
  return out
}

/**
 * Synthesizes to a WAV buffer.
 * @param {string} text
 * @param {{ baseUrl?:string, speaker?:number|string, speedScale?:number,
 *           pitchScale?:number, intonationScale?:number, volumeScale?:number }} opts
 * @returns {Promise<Buffer>}
 */
async function synthesize(text, opts = {}) {
  const clean = String(text || '').trim()
  if (!clean) return Buffer.alloc(0)
  const base = normaliseBase(opts.baseUrl)
  const speaker = Number.isFinite(Number(opts.speaker)) ? Number(opts.speaker) : 0

  const queryUrl =
    `${base}/audio_query?speaker=${speaker}&text=${encodeURIComponent(clean.slice(0, 1500))}`
  const qRes = await fetchWithTimeout(queryUrl, { method: 'POST' }, 30000)
  if (!qRes.ok) {
    const detail = await qRes.text().catch(() => '')
    throw new Error(`VOICEVOX /audio_query 失败 HTTP ${qRes.status}: ${detail.slice(0, 200)}`)
  }
  const query = await qRes.json()

  // Style knobs. speedScale is compensated by the renderer's pitch shift, so we
  // only apply the user's own intonation/volume preferences here.
  if (Number.isFinite(Number(opts.speedScale))) query.speedScale = Number(opts.speedScale)
  if (Number.isFinite(Number(opts.intonationScale))) query.intonationScale = Number(opts.intonationScale)
  if (Number.isFinite(Number(opts.volumeScale))) query.volumeScale = Number(opts.volumeScale)
  if (Number.isFinite(Number(opts.pitchScale))) query.pitchScale = Number(opts.pitchScale)

  const sRes = await fetchWithTimeout(
    `${base}/synthesis?speaker=${speaker}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query) },
    120000
  )
  if (!sRes.ok) {
    const detail = await sRes.text().catch(() => '')
    throw new Error(`VOICEVOX /synthesis 失败 HTTP ${sRes.status}: ${detail.slice(0, 200)}`)
  }
  const buf = Buffer.from(await sRes.arrayBuffer())
  if (!buf.length) throw new Error('VOICEVOX 返回了空音频')
  return buf
}

module.exports = { synthesize, listSpeakers, probe, normaliseBase, DEFAULT_BASE_URL }
