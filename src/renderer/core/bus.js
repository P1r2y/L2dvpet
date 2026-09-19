/** Minimal synchronous event bus used to decouple renderer modules. */
export class Bus {
  constructor() {
    this._map = new Map()
  }

  on(event, fn) {
    if (!this._map.has(event)) this._map.set(event, new Set())
    this._map.get(event).add(fn)
    return () => this.off(event, fn)
  }

  once(event, fn) {
    const off = this.on(event, (...args) => {
      off()
      fn(...args)
    })
    return off
  }

  off(event, fn) {
    this._map.get(event)?.delete(fn)
  }

  emit(event, ...args) {
    const set = this._map.get(event)
    if (!set) return
    for (const fn of Array.from(set)) {
      try {
        fn(...args)
      } catch (err) {
        console.error(`[bus] handler for "${event}" threw:`, err)
      }
    }
  }
}

export const bus = new Bus()
