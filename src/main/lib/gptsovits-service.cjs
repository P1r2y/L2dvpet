'use strict'
/**
 * Starts / stops the GPT-SoVITS api_v2 service.
 *
 * The service is a long-running Python process, so it is spawned detached: it
 * must outlive this app if the user closes the pet while it is generating.
 * We only ever start it when the port is actually closed, so an instance the
 * user started by hand (or via go-webui.bat) is never disturbed.
 */
const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

/** True when something is already listening on host:port. */
function portOpen(host, port, timeout = 700) {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      sock.destroy()
      resolve(v)
    }
    sock.setTimeout(timeout)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
    sock.connect(port, host)
  })
}

function parseHostPort(baseUrl) {
  try {
    const u = new URL(baseUrl || 'http://127.0.0.1:9880')
    return { host: u.hostname || '127.0.0.1', port: Number(u.port) || 9880 }
  } catch {
    return { host: '127.0.0.1', port: 9880 }
  }
}

/**
 * Locates the api_v2.py entry point inside a GPT-SoVITS install.
 * The official Windows package nests it one level down (…/GPT-SoVITS-v2pro-…/),
 * so a plain root is searched as well as its immediate children.
 */
function launcherFor(root) {
  if (!root) return null
  const direct = path.join(root, 'api_v2.py')
  if (fs.existsSync(direct)) return direct
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const p = path.join(root, e.name, 'api_v2.py')
      if (fs.existsSync(p)) return p
    }
  } catch {
    /* ignore */
  }
  return null
}

/** The interpreter to run it with: the bundled runtime if present. */
function pythonFor(dir) {
  const bundled = path.join(dir, 'runtime', 'python.exe')
  if (fs.existsSync(bundled)) return bundled
  return 'python'
}

let child = null

/**
 * @returns {Promise<{ok:boolean, started:boolean, alreadyRunning:boolean, message:string}>}
 */
async function ensureRunning(settings, log = () => {}) {
  const cfg = settings?.voice?.gptsovits || {}
  const { host, port } = parseHostPort(cfg.baseUrl)

  if (await portOpen(host, port)) {
    return { ok: true, started: false, alreadyRunning: true, message: `服务已在 ${host}:${port} 运行` }
  }

  const script = launcherFor(cfg.root)
  if (!script) {
    return {
      ok: false,
      started: false,
      alreadyRunning: false,
      message: '未找到 GPT-SoVITS 的 api_v2.py（设置 → 语音 → GPT-SoVITS → 自动检测）',
    }
  }

  const dir = path.dirname(script)
  const py = pythonFor(dir)
  const cfgFile = path.join(dir, 'GPT_SoVITS', 'configs', 'tts_infer.yaml')
  const args = ['api_v2.py', '-a', host, '-p', String(port)]
  if (fs.existsSync(cfgFile)) args.push('-c', cfgFile)

  log(`[gptsovits] ${py} ${args.join(' ')}  (cwd ${dir})`)
  try {
    child = spawn(py, args, {
      cwd: dir,
      detached: true,
      // Detached + ignored stdio so the service outlives this app and never
      // holds a pipe open that would block it.
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
  } catch (err) {
    return { ok: false, started: false, alreadyRunning: false, message: `启动失败：${err.message}` }
  }

  // Wait for the port to come up — v2ProPlus needs a while to load weights.
  const deadline = Date.now() + 180000
  while (Date.now() < deadline) {
    if (await portOpen(host, port, 1000)) {
      return { ok: true, started: true, alreadyRunning: false, message: `GPT-SoVITS 已启动（${host}:${port}）` }
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  return { ok: false, started: true, alreadyRunning: false, message: '已拉起进程，但 180 秒内端口仍未就绪' }
}

module.exports = { ensureRunning, portOpen, launcherFor, parseHostPort }
