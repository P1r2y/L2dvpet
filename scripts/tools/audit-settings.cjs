'use strict'
/**
 * Settings wiring audit — lists the consumer of every settings field and flags
 * the suspicious ones.
 *
 *   node scripts/tools/audit-settings.cjs
 *
 * Why it exists: a toggle "being there" in the settings panel does not mean it
 * "does anything". Two toggles (show tray icon / show shortcut dock) once
 * existed in both the UI and defaults while nobody read them in code; another
 * one (comfortable squint) was read, but reading it fired an unrelated reaction
 * while the real sustained squint was a hard-coded constant. A static check only
 * catches the former kind, so references that show up in comments/strings only
 * are listed separately — that kind of reference is not a consumer.
 *
 * Limitation (spelled out so it is not over-trusted): this tool proves "the
 * field is read by code", not "the value read actually changed behaviour". Only
 * a runtime assertion can show the latter — see the "petting·squint" and
 * "settings wiring" entries in the self-test.
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const SCHEMA = path.join(ROOT, 'src', 'renderer', 'ui', 'settings', 'schema.js')

/** Strips comments; string literals survive (a second pass strips them, so "string-only" references can be told apart). */
function stripComments(src) {
  let out = ''
  let state = null
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    const nxt = src[i + 1] || ''
    if (state === null) {
      if (ch === '/' && nxt === '/') {
        state = '//'
        i++
        continue
      }
      if (ch === '/' && nxt === '*') {
        state = '/*'
        i++
        continue
      }
      out += ch
      if (ch === '"' || ch === "'" || ch === '`') state = ch
    } else if (state === '//') {
      if (ch === '\n') {
        state = null
        out += ch
      }
    } else if (state === '/*') {
      if (ch === '*' && nxt === '/') {
        state = null
        i++
      }
    } else {
      out += ch
      if (ch === '\\') {
        out += nxt
        i++
      } else if (ch === state) {
        state = null
      }
    }
  }
  return out
}

/** Then strips the string literals too, leaving a code-only version. */
function stripStrings(src) {
  return src.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""')
}

function collectSources(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) collectSources(p, acc)
    else if (/\.(js|cjs|mjs)$/.test(entry.name)) acc.push(p)
  }
  return acc
}

const schemaSrc = fs.readFileSync(SCHEMA, 'utf8')
const keys = []
for (const m of schemaSrc.matchAll(/\b(?:SW|NUM|TXT|SEL|AREA|RNG|LINES)\(\s*['"]([^'"]+)['"]/g)) {
  if (!keys.includes(m[1])) keys.push(m[1])
}

const consumers = []
for (const file of [...collectSources(path.join(ROOT, 'src')), ...collectSources(path.join(ROOT, 'scripts'))]) {
  if (file === SCHEMA || file.endsWith('panel.js')) continue // the panel only renders, it is not a consumer
  const code = stripComments(fs.readFileSync(file, 'utf8'))
  consumers.push({ file: path.relative(ROOT, file), code, bare: stripStrings(code) })
}

const dead = []
const weak = []
const rows = []
for (const key of keys) {
  const leaf = key.split('.').pop()
  const re = new RegExp(`\\b${leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
  const strong = consumers.filter((c) => re.test(c.bare)).map((c) => c.file)
  const anyRef = consumers.filter((c) => re.test(c.code)).map((c) => c.file)
  rows.push({ key, strong, anyRef })
  if (!anyRef.length) dead.push(key)
  else if (!strong.length) weak.push({ key, where: anyRef })
}

const width = Math.max(...rows.map((r) => r.key.length))
for (const r of rows) {
  const mark = !r.anyRef.length ? '✗ no consumer' : !r.strong.length ? '⚠ comments/strings only' : ''
  console.log(`  ${r.key.padEnd(width)}  ${String(r.strong.length).padStart(2)} refs  ${mark}`)
}

console.log(`\nTotal fields ${keys.length}`)
console.log(`  no consumer                ${dead.length}${dead.length ? `  ← ${dead.join(', ')}` : ''}`)
console.log(`  comments/strings only      ${weak.length}${weak.length ? `  ← ${weak.map((w) => w.key).join(', ')}` : ''}`)
console.log('\nNote: this script only verifies "is read" — not "the value read changed behaviour".')
