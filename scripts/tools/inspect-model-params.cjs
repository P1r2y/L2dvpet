'use strict'
/**
 * Summarises a set of .motion3.json / .cdi3.json files: which parameters each
 * motion drives, over what value range, and how the parameter list compares
 * between a generated model and the reference psd2live outputs.
 *
 *   node scripts/tools/inspect-model-params.cjs <dir-or-file> [...]
 */
const fs = require('node:fs')
const path = require('node:path')

function walk(dir) {
  const out = []
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = path.join(cur, e.name)
      if (e.isDirectory()) {
        if (!/build|node_modules|\.git/i.test(e.name)) stack.push(p)
      } else if (/\.(motion3|cdi3)\.json$/i.test(e.name)) out.push(p)
    }
  }
  return out.sort()
}

/**
 * Decodes a Cubism `.motion3.json` Segments array.
 *
 * Layout:  [ t0, v0,  type1, t1, v1, [ctrl...],  type2, t2, v2, ... ]
 *   type 0 = linear          -> time, value                    (3 slots)
 *   type 1 = bezier          -> time, value, c1x,c1y,c2x,c2y   (7 slots)
 *   type 2 = stepped         -> time, value                    (3 slots)
 *   type 3 = inverse stepped -> time, value                    (3 slots)
 */
function decodeSegments(seg) {
  const m = seg.Meta || {}
  const pts = []
  if (!Array.isArray(seg.Segments) || seg.Segments.length < 2) return { pts, duration: 0 }
  pts.push({ t: seg.Segments[0], v: seg.Segments[1] })
  let i = 2
  while (i < seg.Segments.length) {
    const type = seg.Segments[i]
    if (type === 0 || type === 2 || type === 3) {
      pts.push({ t: seg.Segments[i + 1], v: seg.Segments[i + 2] })
      i += 3
    } else if (type === 1) {
      pts.push({ t: seg.Segments[i + 1], v: seg.Segments[i + 2] })
      i += 7
    } else {
      break // unknown type — stop decoding
    }
  }
  return { pts, duration: m.Duration ?? 0 }
}

function summariseMotion(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'))
  const meta = j.Meta || {}
  const params = []
  for (const c of j.Curves || []) {
    if (c.Target !== 'Parameter') continue
    const { pts } = decodeSegments(c)
    if (!pts.length) continue
    const vals = pts.map((p) => p.v)
    params.push({
      id: c.Id,
      n: pts.length,
      min: Math.min(...vals),
      max: Math.max(...vals),
      first: vals[0],
      last: vals[vals.length - 1],
      trace: pts,
    })
  }
  const lastT = params.reduce((a, p) => Math.max(a, p.trace[p.trace.length - 1].t), 0)
  return {
    file,
    duration: meta.Duration ?? lastT,
    lastKeyTime: lastT,
    fps: meta.Fps,
    loop: meta.Loop,
    fadeIn: meta.FadeInTime,
    fadeOut: meta.FadeOutTime,
    curveCount: meta.CurveCount,
    params,
  }
}

function summariseCdi(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'))
  const params = (j.Parameters || []).map((p) => `${p.Id}`)
  const groups = (j.ParameterGroups || []).map((g) => `${g.Id}(${g.Name || ''})`)
  const combined = j.CombinedParameters || []
  const parts = (j.Parts || []).map((p) => p.Id)
  return { file, params, groups, combined, parts }
}

const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(3))

const targets = process.argv.slice(2)
if (!targets.length) {
  console.error('Usage: node scripts/tools/inspect-model-params.cjs <dir-or-file> [...]')
  process.exit(1)
}

for (const target of targets) {
  const abs = path.resolve(target)
  if (!fs.existsSync(abs)) {
    console.log(`\n### ${target} — does not exist\n`)
    continue
  }
  const files = fs.statSync(abs).isDirectory() ? walk(abs) : [abs]
  console.log(`\n${'='.repeat(78)}\n### ${abs}\n${'='.repeat(78)}`)

  const cdi = files.filter((f) => f.endsWith('.cdi3.json'))
  for (const f of cdi) {
    const s = summariseCdi(f)
    console.log(`\n[cdi3] ${path.basename(f)}`)
    console.log(`  Parameters (${s.params.length}): ${s.params.join(', ')}`)
    console.log(`  Groups: ${s.groups.join(', ')}`)
    console.log(`  Combined parameters: ${JSON.stringify(s.combined)}`)
  }

  const motions = files.filter((f) => f.endsWith('.motion3.json'))
  for (const f of motions) {
    const s = summariseMotion(f)
    console.log(
      `\n[motion] ${path.basename(f)}  duration ${s.duration}s  last key ${s.lastKeyTime}s  Loop=${s.loop}  Fps=${s.fps}  curves ${s.curveCount}`
    )
    if (!s.params.length) {
      console.log('  (no Parameter curves)')
      continue
    }
    console.log(`  ${'Parameter'.padEnd(20)} ${'Keys'.padStart(6)}  ${'Min'.padStart(9)} ${'Max'.padStart(9)}   Trace`)
    for (const p of s.params) {
      const trace = p.trace.map((q) => `${fmt(q.t)}s:${fmt(q.v)}`).join('  ')
      console.log(
        `  ${p.id.padEnd(20)} ${String(p.n).padStart(6)}  ${fmt(p.min).padStart(9)} ${fmt(p.max).padStart(9)}   ${trace}`
      )
    }
  }
}
