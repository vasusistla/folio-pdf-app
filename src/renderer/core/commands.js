/**
 * Command registry: the backbone that features plug into.
 *
 * A command is a named action. Registering one can, in a single call:
 *   - put it in the native menu      (menu, group, order, accelerator)
 *   - give it extra keyboard keys    (keys: ['F3', 'Shift+F3'], keyWhen(e) to limit when they fire,
 *                                     allowInInput to fire while typing in a text box)
 *   - drive a toolbar button's state (enabled(), checked())
 *
 * Example:
 *   ctx.commands.register({
 *     id: 'zoom.in', label: 'Zoom In', menu: 'View', group: 'zoom', order: 10,
 *     accelerator: 'CmdOrCtrl+=', enabled: () => ctx.reader.hasDocument,
 *     run: () => ctx.reader.zoomIn(),
 *   });
 */
import { Emitter, debounce } from './emitter.js';

const MENU_ORDER = ['File', 'Edit', 'View', 'Annotate', 'Pages', 'Help'];

export class Commands extends Emitter {
  #commands = new Map();
  #modal = null;
  #roles = [];
  #submenus = new Map();
  #keys = new Map();
  #host;

  constructor(host) {
    super();
    this.#host = host;
    this.publishMenu = debounce(() => this.#host.setMenu(this.menuModel()), 30);
    this.refresh = debounce(() => this.#refreshNow(), 16);
  }

  /** Register a command. Returns a function that unregisters it. */
  register(def) {
    if (!def.id || typeof def.run !== 'function') throw new Error('A command needs an id and a run() function');
    this.#commands.set(def.id, def);
    for (const k of def.keys || []) {
      const key = normalizeKey(k);
      this.#keys.set(key, [...(this.#keys.get(key) || []).filter((x) => x !== def.id), def.id]);
    }
    this.publishMenu();
    this.refresh();
    return () => this.unregister(def.id);
  }

  unregister(id) {
    const def = this.#commands.get(id);
    if (!def) return;
    this.#commands.delete(id);
    for (const k of def.keys || []) {
      const key = normalizeKey(k);
      this.#keys.set(key, (this.#keys.get(key) || []).filter((x) => x !== id));
    }
    this.publishMenu();
  }

  /** Add a built-in Electron role (copy, selectAll, quit, toggleDevTools...) to a menu. */
  addRole(def) {
    this.#roles.push(def);
    this.publishMenu();
  }

  /** Declare a submenu, e.g. { menu: 'View', label: 'Theme', group: 'look', order: 50 }.
   *  Commands whose menu is 'View/Theme' then appear inside it. */
  defineSubmenu(def) {
    this.#submenus.set(`${def.menu}/${def.label}`, def);
    this.publishMenu();
  }

  get(id) { return this.#commands.get(id); }
  all() { return [...this.#commands.values()]; }

  /**
   * While a full-window screen (the scanner) is open, only `allowed` command ids run;
   * menu items and shortcuts for everything else are greyed out. Pass null to end.
   */
  setModal(allowed) {
    this.#modal = allowed ? new Set(allowed) : null;
    this.refresh();
  }

  isEnabled(id) {
    const c = this.#commands.get(id);
    if (!c) return false;
    if (this.#modal && !this.#modal.has(id)) return false;
    try { return c.enabled ? !!c.enabled() : true; } catch { return false; }
  }

  isChecked(id) {
    const c = this.#commands.get(id);
    try { return c?.checked ? !!c.checked() : false; } catch { return false; }
  }

  async run(id, ...args) {
    const c = this.#commands.get(id);
    if (!c) { console.warn('Unknown command', id); return; }
    if (!this.isEnabled(id)) return;
    try {
      return await c.run(...args);
    } catch (err) {
      console.error(`Command ${id} failed`, err);
      this.emit('error', err, c);
    } finally {
      this.refresh();
    }
  }

  /** Keydown handler for keys that are not menu accelerators. */
  handleKeydown(e) {
    if (e.defaultPrevented) return false;
    const candidates = [keyString(e, e.key), keyString(e, e.code)];
    for (const k of candidates) {
      // Most recently registered first, so a specific mode (e.g. presentation) can override a general key.
      for (const id of [...(this.#keys.get(k) || [])].reverse()) {
        const def = this.#commands.get(id);
        if (!def) continue;
        if (isTyping(e.target) && !def.allowInInput) continue;
        if (def.keyWhen && !def.keyWhen(e)) continue;
        if (!this.isEnabled(id)) continue;
        e.preventDefault();
        this.run(id);
        return true;
      }
    }
    return false;
  }

  /** Human-readable shortcut for tooltips and the shortcuts dialog. */
  shortcutFor(id) {
    const c = this.#commands.get(id);
    if (!c) return '';
    const list = [];
    if (c.accelerator || c.displayAccelerator) list.push(formatAccelerator(c.accelerator || c.displayAccelerator));
    for (const k of c.keys || []) if (!c.hideKeys) list.push(formatAccelerator(k));
    return [...new Set(list)].join(' / ');
  }

  #refreshNow() {
    const states = {};
    for (const c of this.#commands.values()) {
      if (!c.menu) continue;
      states[c.id] = { enabled: this.isEnabled(c.id), ...(c.checked ? { checked: this.isChecked(c.id) } : {}) };
    }
    this.#host.updateMenu(states);
    this.emit('refresh');
  }

  /** Builds the serialisable menu model sent to the main process. */
  menuModel() {
    const entries = [];
    for (const c of this.#commands.values()) {
      if (!c.menu) continue;
      entries.push({
        menu: c.menu, group: c.group || '', order: c.order ?? 500,
        item: {
          id: c.id, label: c.menuLabel || c.label,
          accelerator: c.accelerator || c.displayAccelerator || (c.keys?.[0] && c.showKeyInMenu ? c.keys[0].replace('Ctrl+', 'CmdOrCtrl+') : undefined),
          registerAccelerator: !!c.accelerator, type: c.type,
          checked: c.checked ? this.isChecked(c.id) : undefined, enabled: this.isEnabled(c.id),
        },
      });
    }
    for (const r of this.#roles) {
      entries.push({ menu: r.menu, group: r.group || '', order: r.order ?? 500, item: { role: r.role, label: r.label, accelerator: r.accelerator } });
    }
    for (const [key, s] of this.#submenus) {
      entries.push({ menu: s.menu, group: s.group || '', order: s.order ?? 500, submenuKey: key, item: { label: s.label } });
    }

    const build = (menuPath) => {
      const own = entries.filter((e) => e.menu === menuPath).sort((a, b) => a.order - b.order);
      const items = [];
      let lastGroup = null;
      for (const e of own) {
        if (lastGroup !== null && e.group !== lastGroup) items.push({ separator: true });
        lastGroup = e.group;
        if (e.submenuKey) {
          const sub = build(e.submenuKey);
          if (sub.length) items.push({ label: e.item.label, submenu: sub });
        } else {
          items.push(e.item);
        }
      }
      return items;
    };

    const tops = [...new Set(entries.map((e) => e.menu.split('/')[0]))];
    tops.sort((a, b) => rank(a) - rank(b));
    return tops.map((label) => ({ label, items: build(label) })).filter((m) => m.items.length);
  }
}

function rank(name) {
  const i = MENU_ORDER.indexOf(name);
  if (i >= 0) return name === 'Help' ? 1000 : i;
  return 100; // custom menus go before Help
}

function keyString(e, key) {
  if (!key) return '';
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey && key.length > 1) mods.push('Shift'); // Shift is implied by printable keys like '+'
  const k = key.length === 1 ? key.toUpperCase() : key;
  return [...mods, k].join('+');
}

function normalizeKey(k) {
  const parts = k.replace(/CmdOrCtrl|CommandOrControl|Cmd/g, 'Ctrl').split('+');
  const key = parts.pop();
  const mods = ['Ctrl', 'Alt', 'Shift'].filter((m) => parts.includes(m));
  const kk = key === 'Plus' ? '+' : key.length === 1 ? key.toUpperCase() : key;
  return [...mods, kk].join('+');
}

export function formatAccelerator(a) {
  return a.replace(/CmdOrCtrl|CommandOrControl|Cmd/g, 'Ctrl')
    .replace('ArrowLeft', '←').replace('ArrowRight', '→').replace('ArrowUp', '↑').replace('ArrowDown', '↓')
    .replace('Plus', '+').replace('=', '+').replace('NumpadAdd', 'Num +').replace('NumpadSubtract', 'Num -');
}

export function isTyping(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}
