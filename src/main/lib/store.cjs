'use strict'
/**
 * Tiny debounced JSON store with atomic writes and deep-merge defaults.
 * Used for settings.json and state.json in the Electron userData directory.
 */
const fs = require('node:fs')
const path = require('node:path')

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Map-like settings that the user edits by *removal* (unlocking a setting,
 * deleting a language profile). A deep merge can only add or overwrite keys, so
 * these are replaced wholesale instead — otherwise `patch({ locks: {} })` would
 * silently keep every existing lock.
 */
const REPLACE_KEYS = new Set(['locks'])

function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    // An explicit null removes the key — the only way to delete through a patch.
    if (v === null) {
      delete out[k]
      continue
    }
    if (REPLACE_KEYS.has(k) && isPlainObject(v)) {
      out[k] = { ...v }
      continue
    }
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v
  }
  return out
}

/**
 * Removes keys from `data` that do not exist in `schema` (keeps the file tidy).
 * An empty object in the schema (`{}`) marks a free-form map whose sub-keys are
 * dynamic — e.g. `voiceFailures: { edge: 1712345678 }` — so those are kept as-is.
 */
function pruneToSchema(schema, data) {
  if (!isPlainObject(schema) || !isPlainObject(data)) return data
  const out = {}
  for (const [k, v] of Object.entries(data)) {
    if (!(k in schema)) continue
    const s = schema[k]
    if (isPlainObject(s) && isPlainObject(v)) {
      out[k] = Object.keys(s).length === 0 ? { ...v } : pruneToSchema(s, v)
    } else {
      out[k] = v
    }
  }
  return out
}

class JsonStore {
  /**
   * @param {string} filePath absolute path to the JSON file
   * @param {object} defaults default values (also acts as the schema whitelist)
   */
  constructor(filePath, defaults) {
    this.filePath = filePath
    this.defaults = defaults
    this.data = this.#load()
    this._timer = null
  }

  #load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw)
      return pruneToSchema(this.defaults, deepMerge(this.defaults, parsed))
    } catch {
      return JSON.parse(JSON.stringify(this.defaults))
    }
  }

  get() {
    return this.data
  }

  /** Shallow-per-section deep merge patch. */
  patch(partial) {
    this.data = pruneToSchema(this.defaults, deepMerge(this.data, partial || {}))
    this.save()
    return this.data
  }

  replace(next) {
    this.data = pruneToSchema(this.defaults, deepMerge(this.defaults, next || {}))
    this.save()
    return this.data
  }

  reset() {
    this.data = JSON.parse(JSON.stringify(this.defaults))
    this.save()
    return this.data
  }

  save() {
    if (this._timer) clearTimeout(this._timer)
    this._timer = setTimeout(() => this.flush(), 180)
  }

  flush() {
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      fs.renameSync(tmp, this.filePath)
    } catch (err) {
      console.error('[store] failed to write', this.filePath, err)
    }
  }
}

module.exports = { JsonStore, deepMerge, pruneToSchema, isPlainObject }
