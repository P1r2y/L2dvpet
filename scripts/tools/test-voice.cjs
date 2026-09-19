'use strict'
/**
 * Verifies the voice layer end to end at the synthesis boundary:
 *   - which engines exist on this machine
 *   - language detection + per-language voice profile resolution
 *   - the Roxy presets produce the intended voice for each language
 *   - pitch-shift ("声线") compensation
 *
 *   node scripts/tools/test-voice.cjs
 */
const tts = require('../../src/main/lib/tts.cjs')
const sapi = require('../../src/main/lib/sapi.cjs')
const voicevox = require('../../src/main/lib/voicevox.cjs')
const vp = require('../../src/main/lib/voice-profile.cjs')
const defaults = require('../../src/shared/defaults.json')
const presets = require('../../src/shared/voice-presets.json').presets

const SAMPLES = {
  'zh-CN': '你好，我是洛琪希·米格路迪亚，从今天起由我来教你魔术。',
  'ja-JP': 'こんにちは、私はロキシー・ミグルディアです。これから魔法を教えますね。',
  'en-US': 'Hello, I am Roxy Migurdia. I will be teaching you magic from today.',
}
const TEXT = SAMPLES['zh-CN']

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
  return merge(defaults, p ? p.patch : {})
}

;(async () => {
  /* ── engines ─────────────────────────────────────────────────────── */
  console.log('=== 引擎可用性 ===')
  let sapiVoices = []
  try {
    sapiVoices = await sapi.listVoices()
  } catch {
    /* ignore */
  }
  console.log(`  sapi      : ${sapiVoices.length ? '可用' : '不可用'} (${sapiVoices.length} 个音色)`)
  const vv = await voicevox.probe(defaults.voice.voicevoxBaseUrl, 2500)
  console.log(`  voicevox  : ${vv.ok ? `运行中 v${vv.version}` : `未运行 (${vv.message})`} — 可选安装，装了就有动漫音色`)

  /* ── language profiles ───────────────────────────────────────────── */
  console.log('\n=== 每个预设 × 每种语言，实际会选到什么音色 ===')
  for (const presetId of ['roxy-ja', 'roxy-zh', 'roxy-auto', 'roxy-voicevox']) {
    const s = settingsFor(presetId)
    console.log(`\n[${presetId}]  languageMode=${s.voice.languageMode}  pitch=${s.voice.pitchShift}`)
    for (const [lang, text] of Object.entries(SAMPLES)) {
      const r = vp.resolveProfile(s, text)
      const forced = s.voice.languageMode !== 'auto'
      const used = forced ? s.voice.languageMode : r.detected
      const prof = vp.profileFor(s, used)
      console.log(
        `   ${lang} -> 判定=${r.detected.padEnd(6)} 实际用=${used.padEnd(6)}` +
          ` edge=${prof.edge || '-'} sapi=${prof.sapi || '-'} voicevox=${prof.voicevox ?? '-'}`
      )
    }
  }

  /* ── real synthesis through the resolved profile ─────────────────── */
  console.log('\n=== 真实合成（走 profile 解析 + 音调补偿）===')
  for (const lang of ['zh-CN', 'ja-JP', 'en-US']) {
    const s = settingsFor('roxy-auto')
    s.voice.languageMode = lang // pin so we can check one language at a time
    const t0 = Date.now()
    const { result, failed } = await tts.synthesizeWithFallback(s, SAMPLES[lang])
    const ms = Date.now() - t0
    if (result.kind !== 'audio' && result.kind !== 'webspeech') {
      console.log(`  ${lang} -> 失败 ${result.message?.slice(0, 80) || result.kind}`)
      continue
    }
    if (result.kind === 'webspeech') {
      console.log(`  ${lang} -> webspeech (无音频可测) via=${result.provider}`)
      continue
    }
    const info = wavInfo(Buffer.from(result.base64, 'base64'))
    console.log(
      `  ${lang} -> ${String(result.provider).padEnd(9)} 判定=${result.detected ?? '-'} ` +
        `源时长 ${info ? info.seconds.toFixed(2) + 's' : 'n/a(mp3)'} 倍率 ${result.playbackRate} (${ms}ms)`
    )
  }

  /* ── pitch compensation ──────────────────────────────────────────── */
  console.log('\n=== 音调补偿（洛琪希设定 1.15）===')
  const rows = []
  for (const pitch of [0.85, 1.0, 1.15, 1.35]) {
    const s = settingsFor('roxy-auto')
    s.voice.languageMode = 'zh-CN'
    s.voice.pitchShift = pitch
    const { result } = await tts.synthesizeWithFallback(s, TEXT)
    if (result.kind !== 'audio') continue
    const info = wavInfo(Buffer.from(result.base64, 'base64'))
    rows.push({ pitch, dur: info ? info.seconds : null, rate: result.playbackRate })
    console.log(
      `  音调 ${pitch.toFixed(2)} -> 源 ${info ? info.seconds.toFixed(2) + 's' : 'n/a'} × 倍率 ${result.playbackRate}` +
        (info ? ` = 最终 ${(info.seconds / result.playbackRate).toFixed(2)}s` : '')
    )
  }
  if (rows.length >= 3 && rows.every((r) => r.dur)) {
    const grows = rows.every((r, i) => i === 0 || r.dur > rows[i - 1].dur)
    const finals = rows.map((r) => r.dur / r.rate)
    const spread = (Math.max(...finals) - Math.min(...finals)) / (finals[1] || 1)
    console.log(
      `  => 源时长随音调单调增长: ${grows ? '是 ✅' : '否 ❌'}；补偿后语速偏差 ${(spread * 100).toFixed(1)}% ` +
        `${spread < 0.12 ? '✅' : '⚠️'}`
    )
  }

  /* ── off / auto ──────────────────────────────────────────────────── */
  console.log('\n=== 边界情况 ===')
  const off = await tts.synthesizeWithFallback(merge(defaults, { voice: { ttsProvider: 'off' } }), '不该有声音')
  console.log(`  ttsProvider=off -> kind=${off.result.kind} (应为 none)`)
  const auto = await tts.synthesizeWithFallback(settingsFor('roxy-auto'), SAMPLES['ja-JP'])
  console.log(
    `  auto + 日语文本 -> 引擎=${auto.result.provider} 判定=${auto.result.detected}` +
      (auto.failed.length ? `  跳过: ${auto.failed.map((f) => f.provider).join(',')}` : '')
  )
})()
