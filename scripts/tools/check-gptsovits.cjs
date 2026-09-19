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

function loadSettings() {
  const p = path.join(os.homedir(), 'AppData', 'Roaming', 'ai-computer-pet', 'settings.json')
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

function checkFile(label, p) {
  if (!p) return console.log(`  ${label.padEnd(14)} （未设置）`)
  const ok = fs.existsSync(p)
  const size = ok ? `${(fs.statSync(p).size / 1048576).toFixed(1)} MB` : ''
  console.log(`  ${label.padEnd(14)} ${ok ? '✅ 存在' : '❌ 找不到'}  ${size}  ${p}`)
}

;(async () => {
  const s = loadSettings()
  const cfg = s?.voice?.gptsovits || {}
  const baseUrl = process.argv[2] || cfg.baseUrl || gsv.DEFAULT_BASE_URL

  console.log('=== GPT-SoVITS 接入检查 ===\n')
  console.log(`服务地址: ${baseUrl}`)
  const probe = await gsv.probe(baseUrl, 3000)
  if (probe.ok) {
    console.log('  服务状态: ✅ 正在运行')
  } else {
    console.log(`  服务状态: ❌ 连不上（${probe.message}）`)
    console.log('\n  启动方法（在 GPT-SoVITS 目录下）：')
    console.log('    python api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml')
  }

  console.log('\n模型文件:')
  checkFile('GPT 权重', process.argv[3] || cfg.gptWeights)
  checkFile('SoVITS 权重', process.argv[4] || cfg.sovitsWeights)
  checkFile('参考音频', cfg.refAudio)

  console.log('\n配置:')
  console.log(`  参考方式   ${cfg.mode || 'weights'}`)
  console.log(`  合成语言   ${cfg.textLang || 'zh'}`)
  console.log(`  切分方式   ${cfg.splitMethod || 'cut5'}`)
  if (cfg.promptText) console.log(`  参考文本   ${cfg.promptText.slice(0, 40)}${cfg.promptText.length > 40 ? '…' : ''}`)

  if (probe.ok) {
    console.log('\n试合成:')
    try {
      const buf = await gsv.synthesize('你好，这是当前音色的试听。', {
        baseUrl,
        useWeights: cfg.mode === 'weights',
        gptWeights: process.argv[3] || cfg.gptWeights,
        sovitsWeights: process.argv[4] || cfg.sovitsWeights,
        refAudio: cfg.refAudio,
        promptText: cfg.promptText,
        promptLang: cfg.promptLang || 'zh',
        textLang: cfg.textLang || 'zh',
        splitMethod: cfg.splitMethod || 'cut5',
      })
      const isWav = buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF'
      console.log(`  ✅ 生成 ${buf.length} 字节  ${isWav ? '(WAV)' : '(格式异常)'}`)
      const out = path.join(__dirname, 'gptsovits-test.wav')
      fs.writeFileSync(out, buf)
      console.log(`  已保存到 ${out}，可以直接播放试听`)
    } catch (err) {
      console.log(`  ❌ ${err.message}`)
    }
  }

  console.log('\n若还没有权重：用自己的 GPT-SoVITS 微调权重，或用「参考音频」模式做零样本克隆。')
  console.log('把 GPT 权重 / SoVITS 权重（或参考音频）路径填进 设置 → 语音 → GPT-SoVITS。')
})()
