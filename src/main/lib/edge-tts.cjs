'use strict'
/**
 * Minimal, dependency-free Microsoft Edge "Read Aloud" TTS client.
 *
 * Uses Node's built-in global WebSocket (Node >= 22) so no `ws` dependency is
 * required. Handles the Sec-MS-GEC anti-abuse token, including the ±5 minute
 * clock-skew retry that the service enforces.
 */
const crypto = require('node:crypto')

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const CHROMIUM_VERSION = '130.0.2849.68'
const WSS_BASE =
  'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'
const VOICES_URL =
  'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list'
const WIN_EPOCH_SECONDS = 11644473600n

/** Sec-MS-GEC = SHA256(WindowsFileTimeRoundedTo5Min + TRUSTED_CLIENT_TOKEN), uppercase hex. */
function secMsGec(offsetSeconds = 0) {
  let seconds = BigInt(Math.floor(Date.now() / 1000) + offsetSeconds)
  seconds += WIN_EPOCH_SECONDS
  seconds -= seconds % 300n // round down to a 5 minute bucket
  const ticks = seconds * 10000000n // 100-nanosecond intervals
  return crypto
    .createHash('sha256')
    .update(`${ticks}${TRUSTED_CLIENT_TOKEN}`, 'ascii')
    .digest('hex')
    .toUpperCase()
}

function uuid() {
  return crypto.randomUUID().replace(/-/g, '')
}

function jsDateString(d = new Date()) {
  // "Fri Oct 25 2024 13:45:00 GMT+0000 (Coordinated Universal Time)"
  return d.toString()
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function buildSSML(text, opts) {
  const voice = opts.voice || 'zh-CN-XiaoxiaoNeural'
  const locale = voice.split('-').slice(0, 2).join('-') || 'zh-CN'
  const rate = opts.rate || '+0%'
  const pitch = opts.pitch || '+0Hz'
  const volume = opts.volume || '+0%'
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${locale}'>` +
    `<voice name='${escapeXml(voice)}'>` +
    `<prosody pitch='${escapeXml(pitch)}' rate='${escapeXml(rate)}' volume='${escapeXml(volume)}'>` +
    escapeXml(text) +
    `</prosody></voice></speak>`
  )
}

function getWebSocketCtor() {
  if (typeof globalThis.WebSocket === 'function') return globalThis.WebSocket
  try {
    return require('ws')
  } catch {
    throw new Error('当前运行环境不支持 WebSocket，无法使用 Edge TTS')
  }
}

/**
 * Synthesizes `text` into an MP3 buffer.
 * @param {string} text
 * @param {{voice?:string, rate?:string, pitch?:string, volume?:string, format?:string, timeoutMs?:number}} opts
 * @returns {Promise<Buffer>}
 */
function synthesize(text, opts = {}) {
  const clean = String(text || '').trim()
  if (!clean) return Promise.resolve(Buffer.alloc(0))
  // Edge TTS rejects very long single requests; keep chunks reasonable.
  const payload = clean.length > 4000 ? `${clean.slice(0, 4000)}…` : clean

  const attempt = (offsetSeconds, retriesLeft) =>
    new Promise((resolve, reject) => {
      const WebSocketImpl = getWebSocketCtor()
      const connectionId = uuid()
      const requestId = uuid()
      const url =
        `${WSS_BASE}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
        `&Sec-MS-GEC=${secMsGec(offsetSeconds)}` +
        `&Sec-MS-GEC-Version=1-${CHROMIUM_VERSION}` +
        `&ConnectionId=${connectionId}`

      const chunks = []
      let settled = false
      let audioStarted = false
      const timeoutMs = opts.timeoutMs ?? 30000

      const ws = new WebSocketImpl(url)
      ws.binaryType = 'arraybuffer'

      const timer = setTimeout(() => finish(new Error('Edge TTS 超时，请检查网络连接')), timeoutMs)

      function finish(err, value) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          ws.close()
        } catch {
          /* ignore */
        }
        if (err) reject(err)
        else resolve(value)
      }

      ws.addEventListener('open', () => {
        const ts = jsDateString()
        ws.send(
          `X-Timestamp:${ts}\r\n` +
            `Content-Type:application/json; charset=utf-8\r\n` +
            `Path:speech.config\r\n\r\n` +
            JSON.stringify({
              context: {
                synthesis: {
                  audio: {
                    metadataoptions: {
                      sentenceBoundaryEnabled: 'false',
                      wordBoundaryEnabled: 'false',
                    },
                    outputFormat: opts.format || 'audio-24khz-48kbitrate-mono-mp3',
                  },
                },
              },
            })
        )
        ws.send(
          `X-RequestId:${requestId}\r\n` +
            `Content-Type:application/ssml+xml\r\n` +
            `X-Timestamp:${ts}Z\r\n` +
            `Path:ssml\r\n\r\n` +
            buildSSML(payload, opts)
        )
      })

      ws.addEventListener('message', (event) => {
        const data = event.data
        if (typeof data === 'string') {
          if (data.includes('Path:turn.end')) {
            if (chunks.length) finish(null, Buffer.concat(chunks))
            else finish(new Error('Edge TTS 未返回音频数据'))
          }
          return
        }
        // Binary frame: [2-byte BE header length][header][audio payload]
        const buf = Buffer.from(data)
        if (buf.length < 2) return
        const headerLen = buf.readUInt16BE(0)
        const header = buf.subarray(2, 2 + headerLen).toString('utf8')
        if (!/Path:\s*audio/i.test(header)) return
        audioStarted = true
        chunks.push(buf.subarray(2 + headerLen))
      })

      ws.addEventListener('error', () => {
        // The `close` handler produces the richer error; avoid double-settling.
        if (!settled && !audioStarted) finish(new Error('Edge TTS 连接失败'))
      })

      ws.addEventListener('close', (ev) => {
        if (settled) return
        if (chunks.length) {
          finish(null, Buffer.concat(chunks))
          return
        }
        // 403 usually means the Sec-MS-GEC token was rejected — retry with a
        // shifted clock bucket before giving up.
        if (retriesLeft > 0 && (ev.code === 1006 || ev.code === 1008 || ev.code === 403)) {
          const next = offsetSeconds === 0 ? -300 : offsetSeconds > 0 ? 0 : 300
          settled = true
          clearTimeout(timer)
          resolve(attempt(next, retriesLeft - 1))
          return
        }
        finish(new Error(`Edge TTS 连接被关闭 (code ${ev.code})`))
      })
    })

  return attempt(0, 2)
}

const FALLBACK_VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓 · 温柔女声', locale: 'zh-CN', gender: 'Female' },
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊 · 活泼女声', locale: 'zh-CN', gender: 'Female' },
  { id: 'zh-CN-YunxiNeural', name: '云希 · 阳光男声', locale: 'zh-CN', gender: 'Male' },
  { id: 'zh-CN-YunjianNeural', name: '云健 · 沉稳男声', locale: 'zh-CN', gender: 'Male' },
  { id: 'zh-CN-YunxiaNeural', name: '云夏 · 少年音', locale: 'zh-CN', gender: 'Male' },
  { id: 'zh-CN-YunyangNeural', name: '云扬 · 播音男声', locale: 'zh-CN', gender: 'Male' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', name: '晓北 · 东北话', locale: 'zh-CN', gender: 'Female' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', name: '晓妮 · 陕西话', locale: 'zh-CN', gender: 'Female' },
  { id: 'zh-TW-HsiaoChenNeural', name: '曉臻 · 台灣女聲', locale: 'zh-TW', gender: 'Female' },
  { id: 'zh-TW-HsiaoYuNeural', name: '曉雨 · 台灣女聲', locale: 'zh-TW', gender: 'Female' },
  { id: 'zh-HK-HiuMaanNeural', name: '曉曼 · 粵語女聲', locale: 'zh-HK', gender: 'Female' },
  { id: 'ja-JP-NanamiNeural', name: 'Nanami · 日本語女性', locale: 'ja-JP', gender: 'Female' },
  { id: 'ja-JP-KeitaNeural', name: 'Keita · 日本語男性', locale: 'ja-JP', gender: 'Male' },
  { id: 'en-US-AriaNeural', name: 'Aria · English (US)', locale: 'en-US', gender: 'Female' },
  { id: 'en-US-GuyNeural', name: 'Guy · English (US)', locale: 'en-US', gender: 'Male' },
  { id: 'en-GB-SoniaNeural', name: 'Sonia · English (UK)', locale: 'en-GB', gender: 'Female' },
]

/** Fetches the live voice catalogue, falling back to a curated static list. */
async function listVoices() {
  try {
    const url = `${VOICES_URL}?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), 12000)
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(t)
    if (!res.ok) throw new Error(String(res.status))
    const json = await res.json()
    if (!Array.isArray(json) || !json.length) throw new Error('empty')
    return json
      .map((v) => ({
        id: v.ShortName,
        name: `${v.ShortName} · ${v.Gender === 'Female' ? '女' : '男'} · ${v.Locale}`,
        locale: v.Locale,
        gender: v.Gender,
      }))
      .sort((a, b) => {
        const rank = (x) => (x.locale?.startsWith('zh-CN') ? 0 : x.locale?.startsWith('zh') ? 1 : 2)
        return rank(a) - rank(b) || a.id.localeCompare(b.id)
      })
  } catch {
    return FALLBACK_VOICES
  }
}

module.exports = { synthesize, listVoices, FALLBACK_VOICES, TRUSTED_CLIENT_TOKEN }
