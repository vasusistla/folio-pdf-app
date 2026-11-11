/**
 * Folio PDF in a web browser (the iPhone and iPad version, or any modern browser).
 *
 * The app's screens (src/renderer) are the same as on Windows. On Windows they talk to the
 * computer through `window.host` (src/main/preload.js). Here this file provides the same
 * `window.host`, using what a phone browser offers:
 *
 *   Open      the Files picker (iCloud Drive, On My iPhone, other apps' folders)
 *   Save      the document is kept in Folio on this phone (Recent files), and you can
 *             share it or save a copy to Files from the sheet that appears
 *   Settings  kept in this browser (localStorage); documents in IndexedDB
 *   Menu      the Windows menu bar becomes a ☰ menu in the toolbar
 *
 * Nothing is uploaded: documents are only ever read and written on the device.
 * Documents are named with "phone://<id>/<name>" paths so the rest of the app can treat
 * them like files on disk.
 */
const VERSION = '1.5.0';
const SETTINGS_KEY = 'folio.settings';
const DEFAULTS = { theme: 'system', nightPages: false, sidebarOpen: false, sidebarTab: 'thumbnails', sidebarWidth: 220, recent: [], positions: {} };
const KEEP_DOCS = 40;                         // documents kept on the phone for Recent files
const WEB_HIDDEN = new Set(['file.new-window', 'file.show-in-folder', 'view.fullscreen', 'help.devtools']);

// ---------------------------------------------------------------- tiny event hub
const listeners = new Map();
const on = (name) => (fn) => {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(fn);
  return () => listeners.get(name).delete(fn);
};
const emit = (name, ...args) => { for (const fn of listeners.get(name) || []) fn(...args); };

// ---------------------------------------------------------------- settings
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}
let settings = loadSettings();
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage full or blocked */ }
}

// ---------------------------------------------------------------- documents kept on the phone (IndexedDB)
let dbPromise = null;
function db() {
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open('folio', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('docs');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
async function idb(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('docs', mode);
    const req = fn(tx.objectStore('docs'));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Storage is full'));
  });
}
const putDoc = (path, rec) => idb('readwrite', (s) => s.put(rec, path));
const getDoc = (path) => idb('readonly', (s) => s.get(path));
const delDoc = (path) => idb('readwrite', (s) => s.delete(path));
const clearDocs = () => idb('readwrite', (s) => s.clear());

// files picked or dropped in this session, before they're stored
const pending = new Map();

const nameOf = (p) => decodeURIComponent(String(p).split('/').pop() || 'document.pdf');
const isPdfName = (n) => /\.pdf$/i.test(n);
let seq = 0;
const newId = () => `${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
/** The same file picked again gets the same path, so Recent files and "last page" still match. */
function stableId(file) {
  let h = 2166136261;
  for (const ch of `${file.name}|${file.size}|${file.lastModified}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
const pathFor = (id, name) => `phone://${id}/${encodeURIComponent(name)}`;

function registerFile(file) {
  const path = pathFor(stableId(file), file.name);
  pending.set(path, file);
  return path;
}

/** Ask the browser not to clear Folio's storage when space runs low (best effort). */
navigator.storage?.persist?.().catch(() => {});

// ---------------------------------------------------------------- picking files
function pick({ accept, multiple }) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = !!multiple;
    input.style.display = 'none';
    document.body.append(input);
    const done = (files) => { input.remove(); resolve(files); };
    input.addEventListener('change', () => done([...(input.files || [])]), { once: true });
    input.addEventListener('cancel', () => done([]), { once: true });
    input.click();                             // must run inside the tap that asked for it
  });
}

// ---------------------------------------------------------------- the save / share sheet
/**
 * After saving: the document is kept in Folio; this offers to send a copy out
 * (Files, Mail, Messages, AirDrop…). Sharing needs a fresh tap, hence the sheet.
 */
function offerCopy(name, bytes) {
  const file = new File([bytes], name, { type: 'application/pdf' });
  document.querySelector('.web-sheet')?.remove();
  const canShare = !!navigator.canShare?.({ files: [file] });
  const sheet = document.createElement('div');
  sheet.className = 'web-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.innerHTML = `<div class="web-sheet-card">
      <p class="web-sheet-title"></p>
      <p class="web-sheet-text">Saved in Folio on this ${/iPad/.test(navigator.userAgent) ? 'iPad' : 'phone'}. To keep a copy in Files or send it, use the button below.</p>
      <div class="web-sheet-actions">
        <button type="button" class="btn primary" data-act="share">${canShare ? 'Share or Save to Files…' : 'Download a copy'}</button>
        <button type="button" class="btn" data-act="close">Done</button>
      </div></div>`;
  sheet.querySelector('.web-sheet-title').textContent = name;
  sheet.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act && e.target !== sheet) return;
    if (act === 'share') {
      if (canShare) {
        try { await navigator.share({ files: [file], title: name }); } catch { /* cancelled */ }
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(file); a.download = name;
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      }
    }
    sheet.remove();
  });
  document.body.append(sheet);
  requestAnimationFrame(() => sheet.classList.add('show'));
}

// ---------------------------------------------------------------- the ☰ menu (instead of the menu bar)
let menuModel = [];
let menuStates = {};
const clean = (l) => String(l || '').replace(/&&/g, '&');

function menuButton() {
  if (document.getElementById('webMenuBtn')) return;
  const tb = document.getElementById('toolbar');
  if (!tb) return;
  const b = document.createElement('button');
  b.id = 'webMenuBtn';
  b.type = 'button';
  b.className = 'tb-btn web-menu-btn';
  b.title = 'Menu';
  b.setAttribute('aria-label', 'Menu');
  b.innerHTML = '<svg class="icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
  b.addEventListener('click', openMenu);
  tb.prepend(b);
}

function openMenu() {
  document.querySelector('.web-menu')?.remove();
  const panel = document.createElement('div');
  panel.className = 'web-menu';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Menu');
  const card = document.createElement('nav');
  card.className = 'web-menu-card';
  const close = () => panel.remove();
  const head = document.createElement('div');
  head.className = 'web-menu-head';
  head.innerHTML = '<strong>Folio PDF</strong><button type="button" class="btn small" data-close>Close</button>';
  card.append(head);
  const addItems = (items, into, depth) => {
    for (const it of items) {
      if (it.separator) { into.append(Object.assign(document.createElement('hr'), { className: 'web-menu-sep' })); continue; }
      if (it.role) continue;
      if (it.submenu) {
        const det = document.createElement('details');
        det.className = 'web-menu-sub';
        const sum = document.createElement('summary');
        sum.textContent = clean(it.label);
        det.append(sum);
        addItems(it.submenu, det, depth + 1);
        if (det.querySelector('button')) into.append(det);
        continue;
      }
      if (!it.id || WEB_HIDDEN.has(it.id)) continue;
      const st = menuStates[it.id] || {};
      const enabled = st.enabled ?? it.enabled !== false;
      const checked = st.checked ?? it.checked;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'web-menu-item';
      btn.disabled = !enabled;
      btn.innerHTML = `<span class="web-menu-check">${(it.type === 'checkbox' || it.type === 'radio') && checked ? '✓' : ''}</span><span></span>`;
      btn.lastChild.textContent = clean(it.label);
      btn.addEventListener('click', () => { close(); emit('command', it.id); });
      into.append(btn);
    }
  };
  for (const top of menuModel) {
    const sec = document.createElement('section');
    sec.className = 'web-menu-section';
    const h = document.createElement('h3');
    h.textContent = clean(top.label);
    sec.append(h);
    addItems(top.items, sec, 0);
    // drop leading, trailing and doubled separators
    const kids = [...sec.children];
    kids.forEach((k, i) => { if (k.tagName === 'HR' && (i === 1 || i === kids.length - 1 || kids[i + 1]?.tagName === 'HR')) k.remove(); });
    if (sec.querySelector('button, details')) card.append(sec);
  }
  panel.append(card);
  panel.addEventListener('click', (e) => { if (e.target === panel || e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
  document.body.append(panel);
}

// ---------------------------------------------------------------- web links inside PDFs
// Never leave the app by accident: show the address (as on Windows) instead of following it.
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href]');
  if (!a || !/^(https?|mailto|ftp|tel):/i.test(a.getAttribute('href') || '')) return;
  if (a.closest('.web-sheet, .modal')) return;
  e.preventDefault();
  emit('external-link', a.href);
}, true);

// warn before leaving with unsaved changes (closing the tab; a Home Screen app just pauses)
let dirty = false;
window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('focus', () => emit('window-focus'));

// ---------------------------------------------------------------- window.host
window.host = {
  info: async () => {
    const release = { version: VERSION, date: '', notes: [] };
    try {
      const lines = (await (await fetch(new URL('../../CHANGELOG.md', import.meta.url))).text()).split(/\r?\n/);
      const start = lines.findIndex((l) => new RegExp(`^##\\s+${VERSION.replace(/\./g, '\\.')}(\\s|$)`).test(l));
      if (start >= 0) {
        const m = lines[start].match(/^##\s+\S+\s+[—–-]\s+(.+)$/);
        if (m) release.date = m[1].trim();
        for (let i = start + 1; i < lines.length && !lines[i].startsWith('## '); i++) if (/^\s*-\s+/.test(lines[i])) release.notes.push(lines[i].replace(/^\s*-\s+/, '').trim());
      }
    } catch { /* notes are optional */ }
    return { name: 'Folio PDF', version: VERSION, release, platform: 'web', browser: navigator.userAgent };
  },
  getInitialFile: async () => null,

  // files
  showOpenDialog: async ({ multi = true } = {}) => {
    const files = await pick({ accept: '.pdf,application/pdf', multiple: multi });
    return files.map(registerFile);
  },
  showSaveDialog: async ({ defaultPath } = {}) => {
    let name = nameOf(defaultPath || 'document.pdf');
    if (!isPdfName(name)) name += '.pdf';
    return pathFor(newId(), name);
  },
  pickImage: async () => {
    const [f] = await pick({ accept: 'image/png,image/jpeg', multiple: false });
    return f ? { path: f.name, name: f.name, type: f.type, data: new Uint8Array(await f.arrayBuffer()) } : null;
  },
  pickImages: async () => {
    const files = await pick({ accept: 'image/*', multiple: true });
    return Promise.all(files.map(async (f) => ({ path: f.name, name: f.name, type: f.type, data: new Uint8Array(await f.arrayBuffer()) })));
  },
  readFile: async (path) => {
    let rec;
    const f = pending.get(path);
    if (f) {
      if (!isPdfName(f.name) && f.type !== 'application/pdf') throw new Error('Only .pdf files can be opened.');
      rec = { name: f.name, data: new Uint8Array(await f.arrayBuffer()), modified: f.lastModified };
      pending.delete(path);
      putDoc(path, rec).catch(() => {});      // keep it for Recent files
    } else {
      rec = await getDoc(path);
      if (!rec) throw new Error(`ENOENT: "${nameOf(path)}" is no longer kept on this device.`);
    }
    return { path, name: rec.name, size: rec.data.byteLength, modified: rec.modified || Date.now(), data: rec.data };
  },
  writeFile: async (path, data) => {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const name = nameOf(path);
    try {
      await putDoc(path, { name, data: bytes, modified: Date.now() });
    } catch {
      throw new Error('There isn’t enough free space on this device to keep the document. Use Share to save it to Files instead.');
    }
    // a scan or extract saved as a new document is opened next; offer the copy after it opens
    setTimeout(() => offerCopy(name, bytes), 400);
    return { path, name, size: bytes.byteLength };
  },
  showInFolder: async () => {},
  openPaths: async (paths) => {
    const p = paths[0];
    if (!p) return;
    const ok = await (window.folio?.use('save')?.confirmDiscard?.() ?? true);
    if (ok) emit('open-file', p);
  },
  pathForFile: (file) => registerFile(file),

  // settings & recent files
  getSettings: async () => structuredClone(settings),
  setSettings: async (patch) => { Object.assign(settings, patch); saveSettings(); return structuredClone(settings); },
  addRecent: async (p) => {
    const list = (settings.recent || []).filter((r) => r.path !== p);
    list.unshift({ path: p, name: nameOf(p), openedAt: Date.now() });
    const dropped = list.splice(KEEP_DOCS);
    settings.recent = list; saveSettings();
    for (const r of dropped) delDoc(r.path).catch(() => {});
    return settings.recent;
  },
  removeRecent: async (p) => {
    settings.recent = (settings.recent || []).filter((r) => r.path !== p); saveSettings();
    delDoc(p).catch(() => {});
    return settings.recent;
  },
  clearRecent: async () => { settings.recent = []; saveSettings(); clearDocs().catch(() => {}); return []; },
  getPosition: async (p) => settings.positions?.[p] || null,
  setPosition: async (p, pos) => {
    settings.positions ||= {};
    settings.positions[p] = { ...pos, at: Date.now() };
    const keys = Object.keys(settings.positions);
    if (keys.length > 200) keys.sort((a, b) => settings.positions[a].at - settings.positions[b].at).slice(0, keys.length - 200).forEach((k) => delete settings.positions[k]);
    saveSettings();
  },

  // window
  newWindow: async () => {},
  setWindowState: async (patch) => {
    if ('dirty' in patch) dirty = !!patch.dirty;
    if (patch.title) document.title = patch.title;
  },
  closeWindow: async () => {},
  setFullScreen: async (on) => {
    const el = document.documentElement;
    try {
      if ((on ?? !document.fullscreenElement) && el.requestFullscreen) await el.requestFullscreen();
      else if (document.fullscreenElement) await document.exitFullscreen();
    } catch { /* not offered on iPhone */ }
    return !!document.fullscreenElement;
  },
  print: async () => { window.print(); return { ok: true }; },
  copyText: async (text) => { try { await navigator.clipboard.writeText(String(text).slice(0, 10000)); } catch { /* not allowed */ } },

  // menu
  setMenu: async (model) => { menuModel = model; menuButton(); },
  updateMenu: async (states) => { Object.assign(menuStates, states); },

  // events
  onOpenFile: on('open-file'),
  onCommand: on('command'),
  onWindowFocus: on('window-focus'),
  onExternalLink: on('external-link'),
};

// ---------------------------------------------------------------- offline, and updates
// The app's files are kept on the device by sw.js. When a newer version has been
// downloaded in the background, offer to switch to it.
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  const root = new URL('../../', import.meta.url);
  navigator.serviceWorker.register(new URL('sw.js', root), { scope: root.pathname }).then((reg) => {
    const watch = (w) => w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(w); });
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => watch(reg.installing));
    // look for a new version whenever the app comes back to the front
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => { /* offline use won't be available; the app still works online */ });
  // reload only after "Update" (the first install also changes the controller, quietly)
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (updating) { updating = false; location.reload(); } });
}
let updating = false;

function offerUpdate(worker) {
  if (document.querySelector('.web-update')) return;
  const bar = document.createElement('div');
  bar.className = 'web-update';
  bar.innerHTML = '<span>A new version of Folio is ready.</span><button type="button" class="btn small primary">Update</button><button type="button" class="btn small">Later</button>';
  const [update, later] = bar.querySelectorAll('button');
  update.addEventListener('click', () => {
    if (dirty && !confirm('You have unsaved changes. Update anyway? They will be lost.')) return;
    updating = true;
    worker.postMessage('skip-waiting');
  });
  later.addEventListener('click', () => bar.remove());
  document.body.append(bar);
}
