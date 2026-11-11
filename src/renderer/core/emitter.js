/** Minimal event emitter used by the core objects. */
export class Emitter {
  #handlers = new Map();

  on(event, fn) {
    if (!this.#handlers.has(event)) this.#handlers.set(event, new Set());
    this.#handlers.get(event).add(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    this.#handlers.get(event)?.delete(fn);
  }

  emit(event, ...args) {
    for (const fn of [...(this.#handlers.get(event) || [])]) {
      try { fn(...args); } catch (err) { console.error(`Error in "${event}" handler`, err); }
    }
  }
}

export function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}
