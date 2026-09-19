'use strict'
/**
 * Verifies the voice layer end to end at the synthesis boundary:
 *   - which engines exist on this machine
 *   - language detection + per-language voice profile resolution
 *   - the local presets produce the intended voice for each language
 *   - pitch-shift ("声线") compensation
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

/** 合成用例走哪个预设：有本地预设就用第一个，没有就按当前设置来。 */
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
  console.log('=== 引擎可用性 ===')
  const base = merge(defaults, userSettings()).voice
  const gsv = await gptsovits.probe(base.gptsovits.baseUrl, 2500)
  console.log(
    `  gptsovits : ${gsv.ok ? '运行中' : `未运行 (${gsv.message || '无响应'})`} — ${base.gptsovits.baseUrl}` +
      ` (mode=${base.gptsovits.mode}, 权重=${base.gptsovits.gptWeights ? '已配' : '未配'}, 参考音频=${base.gptsovits.refAudio ? '已配' : '未配'})`
  )
  console.log(
    `  openai    : ${base.openaiApiKey ? '已配置 Key' : '未配置 Key（会跳过）'} — ${base.openaiBaseUrl}`
  )

  /* ── language profiles ───────────────────────────────────────────── */
  console.log('\n=== 每个预设 × 每种语言，实际会选到什么音色 ===')
  if (!presets.length) {
    console.log('  （没有 voice-presets.json —— 声线预设是本地文件，不随仓库分发，跳过）')
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
        `   ${lang} -> 判定=${r.detected.padEnd(6)} 实际用=${used.padEnd(6)} openai=${prof.openai || '-'}`
      )
    }
  }

  /* ── real synthesis through the resolved profile ─────────────────── */
  console.log('\n=== 真实合成（走 profile 解析 + 音调补偿）===')
  for (const lang of ['zh-CN', 'ja-JP', 'en-US']) {
    const s = settingsFor(BASE_PRESET)
    s.voice.languageMode = lang // pin so we can check one language at a time
    const t0 = Date.now()
    const { result, failed } = await tts.synthesizeWithFallback(s, SAMPLES[lang])
    const ms = Date.now() - t0
    if (result.kind !== 'audio') {
      console.log(`  ${lang} -> 失败 ${result.message?.slice(0, 80) || result.kind}`)
      continue
    }
    const info = wavInfo(Buffer.from(result.base64, 'base64'))
    console.log(
      `  ${lang} -> ${String(result.provider).padEnd(9)} 判定=${result.detected ?? '-'} ` +
        `源时长 ${info ? info.seconds.toFixed(2) + 's' : 'n/a(mp3)'} 倍率 ${result.playbackRate} (${ms}ms)`
    )
  }

  /* ── pitch compensation ──────────────────────────────────────────── */
  console.log('\n=== 音调补偿（1.15 为「年轻女声」档）===')
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
  const auto = await tts.synthesizeWithFallback(settingsFor(BASE_PRESET), SAMPLES['ja-JP'])
  console.log(
    `  auto + 日语文本 -> 引擎=${auto.result.provider} 判定=${auto.result.detected}` +
      (auto.failed.length ? `  跳过: ${auto.failed.map((f) => f.provider).join(',')}` : '')
  )
})()
