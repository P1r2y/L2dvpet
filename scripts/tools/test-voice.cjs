'use strict'
/**
 * Verifies the voice layer end to end at the synthesis boundary:
 *   - which engines exist on this machine
 *   - language detection + per-language voice profile resolution
 *   - the local presets produce the intended voice for each language
 *   - pitch-shift ("voice pitch") compensation
 *
 *   node scripts/tools/test-voice.cjs
 */
const tts = require('../../src/main/lib/tts.cjs')
const gptsovits = require('../../src/main/lib/gptsovits.cjs')
const vp = require('../../src/main/lib/voice-profile.cjs')
const defaults = require('../../src/shared/defaults.json')
const presets = readPresets()

/**
 * The preset file is local-only (voice content is not distributed), so it may
 * simply not be there — the script then just has nothing to test.
 */
function readPresets() {
  try {
    return require('../../src/shared/voice-presets.json').presets || []
  } catch {
    return []
  }
}
const fs = require('node:fs')
const path = require('node:path')

/**
 * The app's own settings.json when it exists. Without it the GPT-SoVITS weight
 * and reference-audio paths are empty (they are machine-specific), and every
 * synthesis attempt answers HTTP 500 — which looks like a broken engine rather
 * than a script reading the wrong file.
 */
function userSettings() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(process.env.APPDATA || '', 'ai-computer-pet', 'settings.json'), 'utf8')
    )
  } catch {
    return {}
  }
}

const SAMPLES = {
  'zh-CN': '你好，这是当前音色的试听，一二三四五六七八九十。',
  'ja-JP': 'こんにちは、これは現在の声のサンプルです。',
  'en-US': 'Hello, this is a sample of the current voice.',
}
const TEXT = SAMPLES['zh-CN']

/** Which preset the synthesis cases use: the first local one, or the current settings when there are none. */
const BASE_PRESET = presets.length ? presets[0].id : ''

function wavInfo(buf) {
  if (buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF') return null
  const ch = buf.readUInt16LE(22)
  const sr = buf.readUInt32LE(24)
  const bits = buf.readUInt16LE(34)
  return { seconds: (buf.length - 44) / (sr * ch * (bits / 8)) }
}

/** Deep merge that mirrors the app's settings store. */
function merge(base, patch) {
  const out = { ...base }
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(base[k] || {}, v) : v
  }
  return out
}

function settingsFor(presetId) {
  const p = presets.find((x) => x.id === presetId)
  return merge(merge(defaults, userSettings()), p ? p.patch : {})
}

;(async () => {
  /* ── engines ─────────────────────────────────────────────────────── */
  console.log('=== engine availability ===')
  const base = merge(defaults, userSettings()).voice
  const gsv = await gptsovits.probe(base.gptsovits.baseUrl, 2500)
  console.log(
    `  gptsovits : ${gsv.ok ? 'running' : `not running (${gsv.message || 'no response'})`} — ${base.gptsovits.baseUrl}` +
      ` (mode=${base.gptsovits.mode}, weights=${base.gptsovits.gptWeights ? 'set' : 'unset'}, reference audio=${base.gptsovits.refAudio ? 'set' : 'unset'})`
  )
  console.log(
    `  openai    : ${base.openaiApiKey ? 'key set' : 'no key (skipped)'} — ${base.openaiBaseUrl}`
  )

  /* ── language profiles ───────────────────────────────────────────── */
  console.log('\n=== per preset × per language: which voice is actually picked ===')
  if (!presets.length) {
    console.log('  (no voice-presets.json — voice presets are local files, not shipped with the repo; skipping)')
  }
  for (const presetId of presets.map((p) => p.id)) {
    const s = settingsFor(presetId)
    console.log(`\n[${presetId}]  languageMode=${s.voice.languageMode}  pitch=${s.voice.pitchShift}`)
    for (const [lang, text] of Object.entries(SAMPLES)) {
      const r = vp.resolveProfile(s, text)
      const forced = s.voice.languageMode !== 'auto'
      const used = forced ? s.voice.languageMode : r.detected
      const prof = vp.profileFor(s, used)
      console.log(
        `   ${lang} -> detected=${r.detected.padEnd(6)} using=${used.padEnd(6)} openai=${prof.openai || '-'}`
      )
    }
  }

  /* ── real synthesis through the resolved profile ─────────────────── */
  console.log('\n=== real synthesis (through profile resolution + pitch compensation) ===')
  for (const lang of ['zh-CN', 'ja-JP', 'en-US']) {
    const s = settingsFor(BASE_PRESET)
    s.voice.languageMode = lang // pin so we can check one language at a time
    const t0 = Date.now()
    const { result, failed } = await tts.synthesizeWithFallback(s, SAMPLES[lang])
    const ms = Date.now() - t0
    if (result.kind !== 'audio') {
      console.log(`  ${lang} -> failed ${result.message?.slice(0, 80) || result.kind}`)
      continue
    }
    const info = wavInfo(Buffer.from(result.base64, 'base64'))
    console.log(
      `  ${lang} -> ${String(result.provider).padEnd(9)} detected=${result.detected ?? '-'} ` +
        `source ${info ? info.seconds.toFixed(2) + 's' : 'n/a(mp3)'} rate ${result.playbackRate} (${ms}ms)`
    )
  }

  /* ── pitch compensation ──────────────────────────────────────────── */
  console.log('\n=== pitch compensation (1.15 is the "young female" step) ===')
  const rows = []
  for (const pitch of [0.85, 1.0, 1.15, 1.35]) {
    const s = settingsFor(BASE_PRESET)
    s.voice.languageMode = 'zh-CN'
    s.voice.pitchShift = pitch
    const { result } = await tts.synthesizeWithFallback(s, TEXT)
    if (result.kind !== 'audio') continue
    const info = wavInfo(Buffer.from(result.base64, 'base64'))
    rows.push({ pitch, dur: info ? info.seconds : null, rate: result.playbackRate })
    console.log(
      `  pitch ${pitch.toFixed(2)} -> source ${info ? info.seconds.toFixed(2) + 's' : 'n/a'} × rate ${result.playbackRate}` +
        (info ? ` = final ${(info.seconds / result.playbackRate).toFixed(2)}s` : '')
    )
  }
  if (rows.length >= 3 && rows.every((r) => r.dur)) {
    const grows = rows.every((r, i) => i === 0 || r.dur > rows[i - 1].dur)
    const finals = rows.map((r) => r.dur / r.rate)
    const spread = (Math.max(...finals) - Math.min(...finals)) / (finals[1] || 1)
    console.log(
      `  => source duration grows monotonically with pitch: ${grows ? 'yes ✅' : 'no ❌'}; speed drift after compensation ${(spread * 100).toFixed(1)}% ` +
        `${spread < 0.12 ? '✅' : '⚠️'}`
    )
  }

  /* ── off / auto ──────────────────────────────────────────────────── */
  console.log('\n=== edge cases ===')
  const off = await tts.synthesizeWithFallback(merge(defaults, { voice: { ttsProvider: 'off' } }), 'this should not be spoken')
  console.log(`  ttsProvider=off -> kind=${off.result.kind} (expected none)`)
  const auto = await tts.synthesizeWithFallback(settingsFor(BASE_PRESET), SAMPLES['ja-JP'])
  console.log(
    `  auto + Japanese text -> engine=${auto.result.provider} detected=${auto.result.detected}` +
      (auto.failed.length ? `  skipped: ${auto.failed.map((f) => f.provider).join(',')}` : '')
  )
})()
