'use strict'
/**
 * Checks whether a GPT-SoVITS api_v2 service is reachable and whether the
 * configured weight / reference-audio files exist on disk.
 *
 *   node scripts/tools/check-gptsovits.cjs [baseUrl] [gptWeights] [sovitsWeights]
 *
 * With no arguments it reads the paths from %APPDATA%\ai-computer-pet\settings.json.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const gsv = require('../../src/main/lib/gptsovits.cjs')

/**
 * The probe sentence must be written in the language the request declares:
 * the text's language is what the model reads, so an English line with
 * `textLang: 'zh'` would audition the wrong voice and can sound like a failure.
 */
const PROBE_TEXT = {
  zh: '你好，这是当前音色的试听。',
  ja: 'こんにちは。これは現在の声のサンプルです。',
  en: 'Hello, this is a preview of the current voice.',
}

function loadSettings() {
  const p = path.join(os.homedir(), 'AppData', 'Roaming', 'ai-computer-pet', 'settings.json')
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

function checkFile(label, p) {
  if (!p) return console.log(`  ${label.padEnd(14)} (not set)`)
  const ok = fs.existsSync(p)
  const size = ok ? `${(fs.statSync(p).size / 1048576).toFixed(1)} MB` : ''
  console.log(`  ${label.padEnd(14)} ${ok ? '✅ exists' : '❌ not found'}  ${size}  ${p}`)
}

;(async () => {
  const s = loadSettings()
  const cfg = s?.voice?.gptsovits || {}
  const baseUrl = process.argv[2] || cfg.baseUrl || gsv.DEFAULT_BASE_URL

  console.log('=== GPT-SoVITS connectivity check ===\n')
  console.log(`Service URL: ${baseUrl}`)
  const probe = await gsv.probe(baseUrl, 3000)
  if (probe.ok) {
    console.log('  Service: ✅ running')
  } else {
    console.log(`  Service: ❌ unreachable (${probe.message})`)
    console.log('\n  How to start it (from the GPT-SoVITS directory):')
    console.log('    python api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml')
  }

  console.log('\nModel files:')
  checkFile('GPT weights', process.argv[3] || cfg.gptWeights)
  checkFile('SoVITS weights', process.argv[4] || cfg.sovitsWeights)
  checkFile('Reference audio', cfg.refAudio)

  console.log('\nConfig:')
  console.log(`  Reference mode  ${cfg.mode || 'weights'}`)
  console.log(`  Synthesis lang  ${cfg.textLang || 'zh'}`)
  console.log(`  Split method    ${cfg.splitMethod || 'cut5'}`)
  if (cfg.promptText) console.log(`  Prompt text     ${cfg.promptText.slice(0, 40)}${cfg.promptText.length > 40 ? '…' : ''}`)

  if (probe.ok) {
    console.log('\nTest synthesis:')
    const textLang = cfg.textLang || 'zh'
    try {
      const buf = await gsv.synthesize(PROBE_TEXT[textLang] || PROBE_TEXT.en, {
        baseUrl,
        useWeights: cfg.mode === 'weights',
        gptWeights: process.argv[3] || cfg.gptWeights,
        sovitsWeights: process.argv[4] || cfg.sovitsWeights,
        refAudio: cfg.refAudio,
        promptText: cfg.promptText,
        promptLang: cfg.promptLang || 'zh',
        textLang,
        splitMethod: cfg.splitMethod || 'cut5',
      })
      const isWav = buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF'
      console.log(`  ✅ generated ${buf.length} bytes  ${isWav ? '(WAV)' : '(bad format)'}`)
      const out = path.join(__dirname, 'gptsovits-test.wav')
      fs.writeFileSync(out, buf)
      console.log(`  Saved to ${out} — play it to preview`)
    } catch (err) {
      console.log(`  ❌ ${err.message}`)
    }
  }

  console.log('\nNo weights yet? Fine-tune your own GPT-SoVITS weights, or use "reference audio" mode for zero-shot cloning.')
  console.log('Put the GPT weights / SoVITS weights (or reference audio) paths in Settings → Voice → GPT-SoVITS.')
})()
