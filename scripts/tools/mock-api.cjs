'use strict'
/**
 * Mock OpenAI-compatible server used to verify the pet's chat / TTS / STT
 * pipelines without needing a real API key.
 *
 *   node scripts/tools/mock-api.cjs [port]
 *
 * Endpoints:
 *   GET  /v1/models
 *   POST /v1/chat/completions        (streaming SSE + non-streaming)
 *   POST /v1/audio/speech            (returns a real WAV, amplitude modulated)
 *   POST /v1/audio/transcriptions    (returns a canned transcript)
 */
const http = require('node:http')

const PORT = Number(process.argv[2]) || 8787

/* ------------------------------------------------------------------ *
 * WAV helpers
 * ------------------------------------------------------------------ */
function encodeWav(samples, sampleRate = 22050) {
  const dataLen = samples.length * 2
  const buf = Buffer.alloc(44 + dataLen)
  buf.write('RIFF', 0, 'latin1')
  buf.writeUInt32LE(36 + dataLen, 4)
  buf.write('WAVE', 8, 'latin1')
  buf.write('fmt ', 12, 'latin1')
  buf.writeUInt32LE(16, 16) // PCM chunk size
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // mono
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28) // byte rate
  buf.writeUInt16LE(2, 32) // block align
  buf.writeUInt16LE(16, 34) // bits
  buf.write('data', 36, 'latin1')
  buf.writeUInt32LE(dataLen, 40)
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]))
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2)
  }
  return buf
}

/** Speech-like tone: syllable bursts with pauses, so lip-sync has real dynamics. */
function speechLikeWav(seconds = 4, sampleRate = 22050) {
  const n = Math.floor(seconds * sampleRate)
  const out = new Float32Array(n)
  let t = 0
  let syllableLeft = 0
  let envelope = 0
  for (let i = 0; i < n; i++) {
    const time = i / sampleRate
    if (syllableLeft <= 0) {
      // new syllable (or a pause) every 120-260 ms
      syllableLeft = 0.12 + Math.random() * 0.14
      envelope = Math.random() < 0.22 ? 0 : 0.45 + Math.random() * 0.55
      t = 0
    }
    syllableLeft -= 1 / sampleRate
    t += 1 / sampleRate
    const fade = Math.min(1, t * 14) * Math.min(1, Math.max(0, syllableLeft) * 14)
    const f0 = 150 + Math.sin(time * 2.1) * 40
    const s =
      Math.sin(2 * Math.PI * f0 * time) * 0.6 +
      Math.sin(2 * Math.PI * f0 * 2 * time) * 0.25 +
      Math.sin(2 * Math.PI * f0 * 3 * time) * 0.12
    out[i] = s * envelope * fade * 0.75
  }
  return encodeWav(out, sampleRate)
}

/* ------------------------------------------------------------------ *
 * Chat replies
 * ------------------------------------------------------------------ */
const REPLY =
  '[happy]Of course I remember! We were only just talking — you asked my name, and I said it is Xiaoxi.\n' +
  'Now it is my turn: did you have a good day?[motion:nod]'

function sseChunks(text) {
  // Split into small pieces the way a real token stream would arrive.
  const pieces = []
  let i = 0
  while (i < text.length) {
    const n = 1 + Math.floor(Math.random() * 3)
    pieces.push(text.slice(i, i + n))
    i += n
  }
  return pieces
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

/* ------------------------------------------------------------------ *
 * Server
 * ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const path = url.pathname
  console.log(`[mock] ${req.method} ${path}`)

  let body = Buffer.alloc(0)
  if (req.method === 'POST') body = await readBody(req)

  /* ---- models ---- */
  if (path === '/v1/models' && req.method === 'GET') {
    return sendJson(res, 200, {
      object: 'list',
      data: [
        { id: 'mock-chat', object: 'model' },
        { id: 'mock-chat-pro', object: 'model' },
        { id: 'mock-reasoner', object: 'model' },
      ],
    })
  }

  /* ---- chat ---- */
  if (path === '/v1/chat/completions' && req.method === 'POST') {
    let payload = {}
    try {
      payload = JSON.parse(body.toString('utf8'))
    } catch {
      /* ignore */
    }
    const lastUser = [...(payload.messages || [])].reverse().find((m) => m.role === 'user')
    const echo = lastUser ? lastUser.content.slice(0, 40) : ''
    const text = echo.includes('姓名') || echo.includes('名字')
      ? REPLY
      : `[smile]I heard you say "${echo}" — this is the mock reply, used to verify that streaming chat works.[motion:nod]`

    if (payload.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      const pieces = sseChunks(text)
      let i = 0
      const timer = setInterval(() => {
        if (i >= pieces.length) {
          clearInterval(timer)
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }
        const frame = {
          id: 'chatcmpl-mock',
          object: 'chat.completion.chunk',
          model: payload.model || 'mock-chat',
          choices: [{ index: 0, delta: { content: pieces[i] }, finish_reason: null }],
        }
        res.write(`data: ${JSON.stringify(frame)}\n\n`)
        i++
      }, 45)
      req.on('close', () => clearInterval(timer))
      return
    }

    return sendJson(res, 200, {
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      model: payload.model || 'mock-chat',
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 40, total_tokens: 50 },
    })
  }

  /* ---- TTS ---- */
  if (path === '/v1/audio/speech' && req.method === 'POST') {
    let payload = {}
    try {
      payload = JSON.parse(body.toString('utf8'))
    } catch {
      /* ignore */
    }
    const seconds = Math.min(8, Math.max(1.5, String(payload.input || '').length * 0.16))
    const wav = speechLikeWav(seconds)
    console.log(`[mock] tts -> ${seconds.toFixed(2)}s wav (${wav.length} bytes)`)
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length })
    return res.end(wav)
  }

  /* ---- STT ---- */
  if (path === '/v1/audio/transcriptions' && req.method === 'POST') {
    console.log(`[mock] stt upload ${body.length} bytes`)
    if (body.length < 500) return sendJson(res, 400, { error: { message: 'audio too short' } })
    return sendJson(res, 200, {
      text: 'This is the mock transcription, used to verify the voice-input pipeline.',
      provider: 'mock',
    })
  }

  return sendJson(res, 404, { error: { message: `no route for ${path}` } })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] OpenAI-compatible mock listening on http://127.0.0.1:${PORT}/v1`)
})
