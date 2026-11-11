/**
 * UI helpers shared by all features: toolbar buttons, sidebar panels,
 * dialogs, toasts, progress, context menus and the tool-options bar.
 */
import { icon } from './icons.js';
import { Emitter } from './emitter.js';

const $ = (sel, root = document) => root.querySelector(sel);

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Return this from a modal button's getValue() to keep the dialog open (e.g. failed validation). */
export const KEEP_OPEN = Symbol('keep-open');

export class UI extends Emitter {
  #commands;
  #panels = new Map();
  #pageActions = [];
  #activePanel = null;
  #optionsOwner = null;

  constructor(commands) {
    super();
    this.#commands = commands;
    this.icon = icon;
    this.h = h;
    this.KEEP_OPEN = KEEP_OPEN;
    commands.on('refresh', () => this.#refreshButtons());
  }

  // ---------------------------------------------------------------- toolbar
  /** Toolbar slots, left to right: sidebar, file, nav, zoom, view, annotate, history, (spacer), tools, end */
  slot(name) {
    let el = $(`#toolbar [data-slot="${name}"]`);
    if (!el) {
      el = h('div', { class: 'tb-group', 'data-slot': name });
      $('#toolbar [data-slot="end"]').before(el);
    }
    return el;
  }

  /**
   * Add a toolbar button bound to a command.
   * { slot, command, icon, title, label, toggle } → HTMLButtonElement
   */
  addButton({ slot, command, icon: iconName, title, label, toggle = false, order = 500, onClick }) {
    const def = this.#commands.get(command);
    const shortcut = command ? this.#commands.shortcutFor(command) : '';
    const tip = (title || def?.label || '') + (shortcut ? ` (${shortcut})` : '');
    const btn = h('button', {
      class: 'tb-btn' + (label ? ' has-label' : ''), type: 'button', title: tip, 'aria-label': title || def?.label,
      'data-command': command || null, 'data-toggle': toggle ? 'true' : null,
      html: (iconName ? icon(iconName) : '') + (label ? `<span>${label}</span>` : ''),
    });
    btn.style.order = order;
    btn.addEventListener('click', () => (onClick ? onClick() : this.#commands.run(command)));
    this.slot(slot).append(btn);
    this.#refreshButtons();
    return btn;
  }

  addToolbarElement(slot, el, order = 500) {
    el.style.order = order;
    this.slot(slot).append(el);
    return el;
  }

  #refreshButtons() {
    for (const btn of document.querySelectorAll('#toolbar [data-command], #toolOptions [data-command]')) {
      const id = btn.dataset.command;
      btn.disabled = !this.#commands.isEnabled(id);
      if (btn.dataset.toggle) btn.setAttribute('aria-pressed', this.#commands.isChecked(id) ? 'true' : 'false');
    }
  }

  /**
   * Content shown in the thin bar under the toolbar (e.g. colour/size for the active tool).
   * Pass an owner name so that clearing (content = null) only removes your own bar.
   */
  setToolOptions(content, owner = 'default') {
    if (!content && this.#optionsOwner && owner !== this.#optionsOwner) return;
    this.#optionsOwner = content ? owner : null;
    const bar = $('#toolOptions');
    bar.replaceChildren();
    if (content) bar.append(content);
    bar.hidden = !content;
  }

  // ---------------------------------------------------------------- sidebar
  /**
   * Register a sidebar panel.
   * { id, title, icon, create(container) → { onShow?(), onHide?() } }
   */
  addPanel({ id, title, icon: iconName, order = 500, create }) {
    const tab = h('button', { class: 'sb-tab', type: 'button', role: 'tab', title, 'aria-label': title, html: icon(iconName, { size: 17 }), onClick: () => this.showPanel(id) });
    tab.style.order = order;
    const body = h('div', { class: 'sb-panel', role: 'tabpanel', hidden: true, 'data-panel': id });
    $('#sidebarTabs').append(tab);
    $('#sidebarPanels').append(body);
    const panel = { id, title, tab, body, api: null, create };
    this.#panels.set(id, panel);
    if (!this.#activePanel) this.showPanel(id, { silent: true });
    return panel;
  }

  showPanel(id, { silent = false } = {}) {
    const p = this.#panels.get(id);
    if (!p) return;
    if (!p.api) p.api = p.create(p.body) || {};
    for (const other of this.#panels.values()) {
      const on = other === p;
      other.tab.setAttribute('aria-selected', on ? 'true' : 'false');
      if (other.body.hidden === on) {
        other.body.hidden = !on;
        if (on) other.api?.onShow?.(); else other.api?.onHide?.();
      }
    }
    this.#activePanel = id;
    if (!silent) this.emit('panel', id);
  }

  get activePanel() { return this.#activePanel; }

  /** Actions offered when right-clicking a page thumbnail: { label, run(pageNumber), group, enabled?(pageNumber) } */
  addPageAction(action) {
    this.#pageActions.push(action);
  }

  get pageActions() { return [...this.#pageActions]; }

  // ---------------------------------------------------------------- dialogs
  /** Generic modal. buttons: [{ label, value, primary, danger }]. Resolves with the clicked value (or null on Esc). */
  modal({ title, body, buttons = [{ label: 'OK', value: true, primary: true }], width, onOpen }) {
    return new Promise((resolve) => {
      const prevFocus = document.activeElement;
      const backdrop = h('div', { class: 'modal-backdrop' });
      const footer = h('div', { class: 'modal-footer' });
      const dialog = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('div', { class: 'modal-header' }, h('h2', { text: title })),
        h('div', { class: 'modal-body' }, body instanceof Node ? body : h('p', { text: body || '' })),
        footer);
      if (width) dialog.style.width = width;
      const done = async (valueOrPromise) => {
        const value = await valueOrPromise;
        if (value === KEEP_OPEN) return;
        document.removeEventListener('keydown', onKey, true);
        backdrop.remove();
        prevFocus?.focus?.();
        resolve(value);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); }
        if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') {
          const primary = buttons.find((b) => b.primary);
          if (primary) { e.preventDefault(); e.stopPropagation(); done(primary.getValue ? primary.getValue() : primary.value); }
        }
      };
      for (const b of buttons) {
        footer.append(h('button', {
          type: 'button', class: 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : ''), text: b.label,
          onClick: () => done(b.getValue ? b.getValue() : b.value),
        }));
      }
      backdrop.append(dialog);
      document.body.append(backdrop);
      document.addEventListener('keydown', onKey, true);
      onOpen?.(dialog, done);
      (dialog.querySelector('[autofocus]') || footer.querySelector('.primary') || footer.querySelector('button'))?.focus();
    });
  }

  alert(title, message) {
    return this.modal({ title, body: message });
  }

  async confirm(title, message, { okLabel = 'OK', danger = false } = {}) {
    const v = await this.modal({ title, body: message, buttons: [{ label: 'Cancel', value: false }, { label: okLabel, value: true, primary: true, danger }] });
    return v === true;
  }

  /** Text prompt. Resolves with the string, or null if cancelled. */
  prompt({ title, label, value = '', placeholder = '', okLabel = 'OK', type = 'text', hint }) {
    const input = h('input', { type, class: 'input', value, placeholder, autofocus: true, spellcheck: 'false' });
    const body = h('div', { class: 'form' }, label ? h('label', { text: label }) : null, input, hint ? h('p', { class: 'hint', text: hint }) : null);
    return this.modal({
      title, body,
      buttons: [{ label: 'Cancel', value: null }, { label: okLabel, primary: true, getValue: () => input.value }],
      onOpen: () => setTimeout(() => { input.focus(); input.select(); }, 0),
    });
  }

  // ---------------------------------------------------------------- feedback
  toast(message, { type = 'info', timeout = 3500, action } = {}) {
    const el = h('div', { class: `toast ${type}`, role: 'status' }, h('span', { text: message }));
    if (action) el.append(h('button', { class: 'toast-action', type: 'button', text: action.label, onClick: () => { action.run(); el.remove(); } }));
    $('#toasts').append(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 250); }, timeout);
  }

  /** Progress overlay: const p = ui.progress('Printing…'); p.update(0.5); p.close(); p.cancelled */
  progress(title, { cancellable = true } = {}) {
    const bar = h('div', { class: 'progress-fill' });
    const text = h('div', { class: 'progress-text', text: '' });
    const state = { cancelled: false };
    const box = h('div', { class: 'modal progress-modal', role: 'dialog' },
      h('div', { class: 'modal-header' }, h('h2', { text: title })),
      h('div', { class: 'modal-body' }, h('div', { class: 'progress' }, bar), text),
      cancellable ? h('div', { class: 'modal-footer' }, h('button', { class: 'btn', type: 'button', text: 'Cancel', onClick: () => { state.cancelled = true; close(); } })) : null);
    const backdrop = h('div', { class: 'modal-backdrop' }, box);
    document.body.append(backdrop);
    const close = () => backdrop.remove();
    return Object.assign(state, {
      update(fraction, label) { bar.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`; if (label) text.textContent = label; },
      close,
    });
  }

  /** Context menu at (x, y). items: [{ label, run, disabled, danger } | { separator: true }] */
  contextMenu(x, y, items) {
    document.querySelector('.ctx-menu')?.remove();
    const menu = h('div', { class: 'ctx-menu', role: 'menu' });
    for (const it of items) {
      if (it.separator) { menu.append(h('div', { class: 'ctx-sep' })); continue; }
      menu.append(h('button', {
        type: 'button', role: 'menuitem', class: 'ctx-item' + (it.danger ? ' danger' : ''), disabled: !!it.disabled, text: it.label,
        onClick: () => { close(); it.run(); },
      }));
    }
    document.body.append(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, window.innerWidth - r.width - 6)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - r.height - 6)}px`;
    const close = () => { menu.remove(); document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', esc, true); };
    const outside = (e) => { if (!menu.contains(e.target)) close(); };
    const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    setTimeout(() => { document.addEventListener('mousedown', outside, true); document.addEventListener('keydown', esc, true); }, 0);
    menu.querySelector('button:not([disabled])')?.focus();
  }
}
