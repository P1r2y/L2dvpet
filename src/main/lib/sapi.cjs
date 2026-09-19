'use strict'
/**
 * Windows SAPI 5 speech synthesis via a PowerShell helper.
 *
 * Why this exists: Chromium's speechSynthesis on this platform reports **zero**
 * voices (so the UI cannot offer a picker) even though the default voice can
 * speak. Driving SAPI ourselves gives us
 *   - a real, enumerable voice list (Huihui / Kangkang / Yaoyao / Zira / …)
 *   - actual WAV bytes, so lip-sync can be driven from the waveform
 *   - fully offline operation
 *
 * One PowerShell process is spawned per utterance (~450 ms) which keeps things
 * simple and cannot leave a stuck child process behind.
 */
const { execFile } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const ROOT = path.resolve(__dirname, '..', '..', '..')
const SCRIPT = path.join(ROOT, 'scripts', 'ps', 'sapi-tts.ps1')

/** PowerShell 5.1 reads BOM-less UTF-8 as ANSI, so make sure the helper has one. */
function ensureBom(file) {
  try {
    const buf = fs.readFileSync(file)
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return
    const text = buf.toString('utf8')
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]))
  } catch {
    /* best effort */
  }
}

let available = null

function powershellExe() {
  const candidates = [
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'powershell.exe',
  ]
  for (const c of candidates) {
    try {
      if (c === 'powershell.exe' || fs.existsSync(c)) return c
    } catch {
      /* ignore */
    }
  }
  return 'powershell.exe'
}

/** Parses "OK 1234" / "ERR reason" from the helper's stdout. */
function parseResult(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  for (const line of lines) {
    if (line.startsWith('OK ')) return { ok: true, bytes: Number(line.slice(3)) || 0 }
    if (line.startsWith('ERR ')) return { ok: false, message: line.slice(4) }
  }
  return { ok: false, message: lines.join(' ').slice(0, 300) || 'PowerShell 未返回结果' }
}

function run(args, timeoutMs = 30000) {
  ensureBom(SCRIPT)
  return new Promise((resolve, reject) => {
    execFile(
      powershellExe(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          reject(new Error(`PowerShell 调用失败: ${err.message}${stderr ? ` — ${String(stderr).slice(0, 200)}` : ''}`))
          return
        }
        resolve(parseResult(stdout))
      }
    )
  })
}

/** True when SAPI is usable on this machine (checked once, then cached). */
async function isAvailable() {
  if (available !== null) return available
  try {
    const voices = await listVoices()
    available = voices.length > 0
  } catch {
    available = false
  }
  return available
}

/**
 * @returns {Promise<Array<{id:string,name:string,locale:string,gender:string,age:string}>>}
 */
async function listVoices() {
  if (!fs.existsSync(SCRIPT)) throw new Error('缺少 scripts/ps/sapi-tts.ps1')
  ensureBom(SCRIPT)
  const raw = await new Promise((resolve, reject) => {
    execFile(
      powershellExe(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-List'],
      { timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => (err && !stdout ? reject(err) : resolve(stdout))
    )
  })
  return String(raw || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.includes('|'))
    .map((line) => {
      const [name, locale, gender, age] = line.split('|')
      const label = gender === 'Male' ? '男声' : gender === 'Female' ? '女声' : gender || '?'
      return {
        id: name,
        name: `${name.replace(/^Microsoft\s+/, '').replace(/\s+Desktop$/, '')} · ${label} · ${locale}`,
        locale,
        gender,
        age,
      }
    })
}

/**
 * Synthesizes to a WAV buffer.
 * @param {string} text
 * @param {{voice?:string, rate?:number, volume?:number}} opts
 *        `rate` is the already-compensated speed multiplier (1 = normal).
 *        The caller folds the pitch shift in; we must NOT apply it again.
 * @returns {Promise<Buffer>}
 */
async function synthesize(text, opts = {}) {
  const clean = String(text || '').trim()
  if (!clean) return Buffer.alloc(0)

  // Measured band of the SAPI rate parameter on Windows:
  //   +20% is where speeding up saturates, and slowing down stays roughly
  //   linear down to about -45%. Outside this range the engine clamps and the
  //   resulting duration no longer matches the playbackRate compensation.
  const speed = Math.max(0.55, Math.min(1.19, Number(opts.rate) || 1))
  const ratePercent = Math.round((speed - 1) * 100)

  const out = path.join(
    os.tmpdir(),
    `pet-sapi-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.wav`
  )
  const request = Buffer.from(
    JSON.stringify({
      text: clean,
      voice: opts.voice || '',
      rate: `${ratePercent >= 0 ? '+' : ''}${ratePercent}%`,
      pitch: '+0%', // SAPI desktop voices ignore prosody pitch; see tts.cjs pitchOf()
      volume: Math.round(Math.max(0, Math.min(1, Number(opts.volume ?? 1))) * 100),
    }),
    'utf8'
  ).toString('base64')

  try {
    const res = await run(['-Request', request, '-Out', out], 40000)
    if (!res.ok) throw new Error(res.message)
    const buf = fs.readFileSync(out)
    if (!buf.length) throw new Error('SAPI 生成了空音频')
    return buf
  } finally {
    fs.promises.unlink(out).catch(() => {})
  }
}

module.exports = { synthesize, listVoices, isAvailable }
