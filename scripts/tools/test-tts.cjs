'use strict'
// Standalone smoke test for the Edge TTS client.
const { synthesize, listVoices } = require('../../src/main/lib/edge-tts.cjs')
const fs = require('node:fs')

;(async () => {
  const t0 = Date.now()
  try {
    const voices = await listVoices()
    console.log(`[voices] ${voices.length} voices; first:`, voices.slice(0, 3).map((v) => v.id).join(', '))
  } catch (e) {
    console.log('[voices] failed:', e.message)
  }

  try {
    const buf = await synthesize('你好呀，我是你的桌面小精灵，很高兴见到你！', {
      voice: 'zh-CN-XiaoxiaoNeural',
      rate: '+8%',
      pitch: '+14Hz',
    })
    console.log(`[tts] OK ${buf.length} bytes in ${Date.now() - t0}ms`)
    // MP3 frame sync check
    const isMp3 = buf.length > 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0
    const isId3 = buf.subarray(0, 3).toString('latin1') === 'ID3'
    console.log(`[tts] mp3? ${isMp3} id3? ${isId3}`)
    fs.writeFileSync(require('node:path').join(__dirname, 'tts-test.mp3'), buf)
  } catch (e) {
    console.error('[tts] FAILED:', e.message)
    process.exitCode = 1
  }
})()
