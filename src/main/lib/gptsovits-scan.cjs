'use strict'
/**
 * Locates a GPT-SoVITS installation, its fine-tuned weights and usable
 * reference clips, so the settings panel can offer one-click detection instead
 * of asking the user to type long Windows paths.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** Places the official Windows package is commonly extracted to. */
function candidateRoots() {
  const home = os.homedir()
  const desktop = path.join(home, 'Desktop')
  const out = [
    path.join(desktop, 'work', 'GPT-SoVITS'),
    path.join(desktop, 'GPT-SoVITS'),
    'C:\\GPT-SoVITS',
    'D:\\GPT-SoVITS',
    'E:\\GPT-SoVITS',
    path.join(home, 'GPT-SoVITS'),
    path.join(home, 'Documents', 'GPT-SoVITS'),
    path.join(desktop, 'work', 'aiL2d', 'GPT-SoVITS'),
  ]
  return out.filter((p, i) => out.indexOf(p) === i)
}

/** A GPT-SoVITS root is any folder that contains api_v2.py (directly or one level down). */
function looksLikeRoot(dir) {
  try {
    if (fs.existsSync(path.join(dir, 'api_v2.py'))) return dir
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const sub = path.join(dir, entry.name)
      if (fs.existsSync(path.join(sub, 'api_v2.py'))) return sub
    }
  } catch {
    /* unreadable */
  }
  return null
}

function listFiles(dir, filter, limit = 60) {
  const out = []
  const stack = [[dir, 0]]
  while (stack.length && out.length < limit) {
    const [cur, depth] = stack.pop()
    if (depth > 4) continue
    let entries = []
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = path.join(cur, e.name)
      if (e.isDirectory()) {
        if (/(pretrained_models|runtime|__pycache__|\.git|node_modules|TEMP|logs)/i.test(e.name)) continue
        stack.push([p, depth + 1])
      } else if (filter(e.name)) {
        out.push({ path: p, size: safeSize(p), name: e.name })
      }
    }
  }
  return out
}

function safeSize(p) {
  try {
    return fs.statSync(p).size
  } catch {
    return 0
  }
}

/**
 * @returns {{
 *   root: string|null,
 *   gptWeights: Array, sovitsWeights: Array, references: Array,
 *   pretrained: { gpt: string|null, sovits: string|null },
 *   candidates: string[]
 * }}
 */
function scan(extraRoot) {
  const roots = [extraRoot, ...candidateRoots()].filter(Boolean)
  let root = null
  const tried = []
  for (const r of roots) {
    tried.push(r)
    if (!fs.existsSync(r)) continue
    const hit = looksLikeRoot(r)
    if (hit) {
      root = hit
      break
    }
  }

  const result = {
    root,
    searched: tried,
    gptWeights: [],
    sovitsWeights: [],
    references: [],
    pretrained: { gpt: null, sovits: null },
  }
  if (!root) return result

  // Fine-tuned models the user trained / downloaded.
  for (const folder of ['GPT_weights_v2ProPlus', 'GPT_weights_v2Pro', 'GPT_weights_v2', 'GPT_weights_v3', 'GPT_weights_v4', 'GPT_weights']) {
    const dir = path.join(root, folder)
    if (fs.existsSync(dir)) {
      for (const f of listFiles(dir, (n) => n.endsWith('.ckpt'), 40)) result.gptWeights.push(f)
    }
  }
  for (const folder of ['SoVITS_weights_v2ProPlus', 'SoVITS_weights_v2Pro', 'SoVITS_weights_v2', 'SoVITS_weights_v3', 'SoVITS_weights_v4', 'SoVITS_weights']) {
    const dir = path.join(root, folder)
    if (fs.existsSync(dir)) {
      for (const f of listFiles(dir, (n) => n.endsWith('.pth'), 40)) result.sovitsWeights.push(f)
    }
  }

  // Anything the user dropped in as a zero-shot reference.
  for (const folder of ['refs', 'reference', 'ref', '参考音频', 'TEMP']) {
    const dir = path.join(root, folder)
    if (!fs.existsSync(dir)) continue
    for (const f of listFiles(dir, (n) => /\.(wav|mp3|flac|m4a|ogg)$/i.test(n), 30)) {
      if (f.size > 2 * 1024 && f.size < 30 * 1024 * 1024) {
        // A clip may ship with its transcript beside it (`foo.wav` + `foo.txt`),
        // which saves the user from typing the prompt text by hand.
        const sidecar = f.path.replace(/\.[^.]+$/, '.txt')
        if (fs.existsSync(sidecar)) {
          try {
            const t = fs.readFileSync(sidecar, 'utf8').trim()
            if (t) f.transcript = t
          } catch {
            /* ignore */
          }
        }
        result.references.push(f)
      }
    }
  }

  // Bundled base models — usable for zero-shot right away.
  const base = path.join(root, 'GPT_SoVITS', 'pretrained_models')
  const gpt = path.join(base, 's1v3.ckpt')
  const sovits = path.join(base, 'v2Pro', 's2Gv2ProPlus.pth')
  if (fs.existsSync(gpt)) result.pretrained.gpt = gpt
  if (fs.existsSync(sovits)) result.pretrained.sovits = sovits

  // Sort newest first so a freshly trained model is the first suggestion.
  const byNewest = (a, b) => {
    try {
      return fs.statSync(b.path).mtimeMs - fs.statSync(a.path).mtimeMs
    } catch {
      return 0
    }
  }
  result.gptWeights.sort(byNewest)
  result.sovitsWeights.sort(byNewest)
  result.references.sort(byNewest)
  return result
}

module.exports = { scan, candidateRoots }
