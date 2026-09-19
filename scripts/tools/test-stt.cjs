'use strict'
// Probes multipart upload the same way src/main/lib/stt.cjs does.
const base = process.argv[2] || 'http://127.0.0.1:8787/v1'

function makeWav(seconds = 1, rate = 16000) {
  const n = Math.floor(seconds * rate)
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0, 'latin1')
  buf.writeUInt32LE(36 + n * 2, 4)
  buf.write('WAVE', 8, 'latin1')
  buf.write('fmt ', 12, 'latin1')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(rate, 24)
  buf.writeUInt32LE(rate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'latin1')
  buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 220) * 9000), 44 + i * 2)
  return buf
}

;(async () => {
  console.log('globals:', {
    FormData: typeof FormData,
    Blob: typeof Blob,
    fetch: typeof fetch,
    File: typeof File,
  })
  const wav = makeWav(1)
  console.log('wav bytes:', wav.length)

  // Variant A: Buffer inside a Blob
  try {
    const form = new FormData()
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav')
    form.append('model', 'whisper-1')
    const res = await fetch(`${base}/audio/transcriptions`, { method: 'POST', body: form })
    console.log('A (Blob from Buffer):', res.status, (await res.text()).slice(0, 150))
  } catch (err) {
    console.log('A FAILED:', err.message, '| cause:', err.cause?.message || err.cause?.code || '-')
  }

  // Variant B: Uint8Array inside a Blob
  try {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'speech.wav')
    form.append('model', 'whisper-1')
    const res = await fetch(`${base}/audio/transcriptions`, { method: 'POST', body: form })
    console.log('B (Blob from Uint8Array):', res.status, (await res.text()).slice(0, 150))
  } catch (err) {
    console.log('B FAILED:', err.message, '| cause:', err.cause?.message || err.cause?.code || '-')
  }

  // Variant C: no Blob, hand-rolled multipart
  try {
    const boundary = '----petboundary' + Date.now()
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="speech.wav"\r\n` +
        `Content-Type: audio/wav\r\n\r\n`
    )
    const mid = Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${boundary}--\r\n`
    )
    const res = await fetch(`${base}/audio/transcriptions`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: Buffer.concat([head, wav, mid]),
    })
    console.log('C (manual multipart):', res.status, (await res.text()).slice(0, 150))
  } catch (err) {
    console.log('C FAILED:', err.message, '| cause:', err.cause?.message || err.cause?.code || '-')
  }
})()
