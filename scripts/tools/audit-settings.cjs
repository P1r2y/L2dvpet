'use strict'
/**
 * 设置落实审计 — 列出每个设置字段的消费者，并标出可疑的那些。
 *
 *   node scripts/tools/audit-settings.cjs
 *
 * 为什么需要它：设置面板里一个开关「存在」不代表它「有用」。曾经有两个开关
 * （显示托盘图标 / 显示快捷按钮条）在 UI 和 defaults 里都在，代码里却从没人读；
 * 另一个（舒服地眯眼）被读了，但读它去触发一次无关的反应，真正的持续眯眼是硬编码
 * 的常量 —— 静态检查只能查到前者那一类，所以这里同时把「只在注释/字符串里出现过」
 * 的引用单独标出来，那种引用不是消费者。
 *
 * 局限（写清楚免得误信）：本工具证明的是「这个字段被代码读到了」，证明不了
 * 「读到的值真的改变了行为」。后者只能靠运行时断言，见自测里的「抚摸·眯眼」
 * 「开关落实」等条目。
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const SCHEMA = path.join(ROOT, 'src', 'renderer', 'ui', 'settings', 'schema.js')

/** 剥掉注释；字符串字面量保留（第二遍再剥，用来区分「只在字符串里出现」）。 */
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

/** 再把字符串字面量剥掉，得到一个「只剩代码」的版本。 */
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
  if (file === SCHEMA || file.endsWith('panel.js')) continue // 面板只是渲染，不算消费者
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
  const mark = !r.anyRef.length ? '✗ 无消费者' : !r.strong.length ? '⚠ 只在注释/字符串里出现' : ''
  console.log(`  ${r.key.padEnd(width)}  ${String(r.strong.length).padStart(2)} 处  ${mark}`)
}

console.log(`\n字段总数 ${keys.length}`)
console.log(`  无消费者            ${dead.length}${dead.length ? `  ← ${dead.join(', ')}` : ''}`)
console.log(`  只在注释/字符串里出现  ${weak.length}${weak.length ? `  ← ${weak.map((w) => w.key).join(', ')}` : ''}`)
console.log('\n注意：本脚本只验证「被读到」，不验证「读到的值改变了行为」。')
