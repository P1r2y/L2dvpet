// esbuild-based build: bundles the renderer into dist/renderer.js, copies static assets,
// and generates the tray icon PNG from scratch (no image deps).
import { build, context } from 'esbuild'
import { mkdirSync, copyFileSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const DIST = join(ROOT, 'dist')
const watch = process.argv.includes('--watch')

mkdirSync(DIST, { recursive: true })

/* ------------------------------------------------------------------ *
 * Minimal PNG encoder (RGBA8, non-interlaced) — used for the tray icon
 * ------------------------------------------------------------------ */
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Draws a soft round pet head with two eyes, antialiased via 3x supersampling. */
function makeTrayIcon(size = 64) {
  const ss = 3
  const S = size * ss
  const px = (x, y, r, g, b, a) => {
    const o = (y * size + x) * 4
    acc[o] += r * a
    acc[o + 1] += g * a
    acc[o + 2] += b * a
    acc[o + 3] += a
  }
  // supersampled accumulation buffers
  const acc = new Float64Array(size * size * 4)
  const cov = new Float64Array(size * size * 4)

  const inEllipse = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1

  for (let sy = 0; sy < S; sy++) {
    for (let sx = 0; sx < S; sx++) {
      const x = (sx + 0.5) / ss
      const y = (sy + 0.5) / ss
      const tx = Math.floor(sx / ss)
      const ty = Math.floor(sy / ss)
      const o = (ty * size + tx) * 4

      let r = 0, g = 0, b = 0, a = 0

      // body / hair mass (dark violet-blue)
      if (inEllipse(x, y, size / 2, size * 0.60, size * 0.40, size * 0.36)) {
        r = 78; g = 76; b = 132; a = 1
      }
      // head (skin)
      if (inEllipse(x, y, size / 2, size * 0.44, size * 0.30, size * 0.27)) {
        r = 252; g = 231; b = 224; a = 1
      }
      // fringe / bangs
      if (inEllipse(x, y, size / 2, size * 0.30, size * 0.32, size * 0.20)) {
        r = 96; g = 92; b = 158; a = 1
      }
      if (inEllipse(x, y, size / 2, size * 0.24, size * 0.34, size * 0.16)) {
        r = 112; g = 106; b = 178; a = 1
      }
      // eyes
      if (inEllipse(x, y, size * 0.39, size * 0.47, size * 0.055, size * 0.075)) {
        r = 46; g = 40; b = 78; a = 1
      }
      if (inEllipse(x, y, size * 0.61, size * 0.47, size * 0.055, size * 0.075)) {
        r = 46; g = 40; b = 78; a = 1
      }
      // eye highlights
      if (inEllipse(x, y, size * 0.405, size * 0.445, size * 0.020, size * 0.026)) {
        r = 255; g = 255; b = 255; a = 1
      }
      if (inEllipse(x, y, size * 0.625, size * 0.445, size * 0.020, size * 0.026)) {
        r = 255; g = 255; b = 255; a = 1
      }
      // blush
      if (inEllipse(x, y, size * 0.30, size * 0.535, size * 0.055, size * 0.030)) {
        r = 246; g = 158; b = 174; a = 0.75
      }
      if (inEllipse(x, y, size * 0.70, size * 0.535, size * 0.055, size * 0.030)) {
        r = 246; g = 158; b = 174; a = 0.75
      }
      // smile (screen Y grows downward, so the centre must sit lower)
      const my = size * 0.60 - ((x - size / 2) ** 2) / (size * 0.62)
      if (Math.abs(y - my) < size * 0.016 && Math.abs(x - size / 2) < size * 0.075) {
        r = 160; g = 96; b = 110; a = 1
      }

      px(tx, ty, r, g, b, a)
      cov[o] += 1
      cov[o + 1] += 1
      cov[o + 2] += 1
      cov[o + 3] += 1
    }
  }

  const out = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    const o = i * 4
    const n = cov[o + 3] || 1
    const a = acc[o + 3] / n // coverage 0..1
    if (a <= 0.001) continue
    out[o] = Math.round(Math.min(255, acc[o] / acc[o + 3]))
    out[o + 1] = Math.round(Math.min(255, acc[o + 1] / acc[o + 3]))
    out[o + 2] = Math.round(Math.min(255, acc[o + 2] / acc[o + 3]))
    out[o + 3] = Math.round(Math.min(255, a * 255))
  }
  return encodePNG(size, size, out)
}

const trayPng = makeTrayIcon(64)
writeFileSync(join(DIST, 'tray.png'), trayPng)
writeFileSync(join(DIST, 'app.png'), makeTrayIcon(256))

/* ------------------------------------------------------------------ *
 * Renderer bundle
 *
 * Pixi and pixi-live2d-display are NOT bundled: their prebuilt UMD files are
 * copied to dist/vendor and loaded as classic scripts, so `window.PIXI` and
 * `window.PIXI.live2d` are the exact objects the library expects. Only the
 * app's own ES modules are bundled.
 * ------------------------------------------------------------------ */
const buildOptions = {
  entryPoints: [join(ROOT, 'src', 'renderer', 'main.js')],
  bundle: true,
  format: 'iife',
  target: ['chrome120'],
  platform: 'browser',
  outfile: join(DIST, 'renderer.js'),
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': '"production"',
    global: 'globalThis',
  },
  loader: { '.css': 'css' },
  // PIXI / PIXI.live2d come from the vendor scripts loaded before the bundle.
  external: [],
}

/** Vendor files copied verbatim from node_modules into dist/vendor. */
const VENDOR_FILES = [
  [join(ROOT, 'vendor', 'live2dcubismcore.min.js'), 'live2dcubismcore.min.js'],
  [join(ROOT, 'node_modules', 'pixi.js', 'dist', 'browser', 'pixi.min.js'), 'pixi.min.js'],
  [
    join(ROOT, 'node_modules', 'pixi-live2d-display', 'dist', 'cubism4.min.js'),
    'pixi-live2d-display.min.js',
  ],
]

function copyVendor() {
  mkdirSync(join(DIST, 'vendor'), { recursive: true })
  const missing = []
  for (const [src, name] of VENDOR_FILES) {
    if (existsSync(src)) copyFileSync(src, join(DIST, 'vendor', name))
    else missing.push(name)
  }
  if (missing.length) {
    console.error(`[build] MISSING vendor files: ${missing.join(', ')} — run "npm install" first`)
    process.exitCode = 1
  }
}

async function main() {
  if (watch) {
    const ctx = await context(buildOptions)
    await ctx.watch()
    console.log('[build] watching for changes...')
  } else {
    await build(buildOptions)
    console.log('[build] renderer bundle written to dist/renderer.js')
  }

  // copy static renderer assets
  for (const f of ['index.html', 'styles.css']) {
    const src = join(ROOT, 'src', 'renderer', f)
    if (existsSync(src)) copyFileSync(src, join(DIST, f))
  }
  copyVendor()
  console.log('[build] static assets + vendor copied')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
