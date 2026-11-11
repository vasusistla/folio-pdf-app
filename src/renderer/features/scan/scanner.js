/**
 * The scanner screen: take pictures with the camera (or bring in photos), check
 * and adjust each page, then save them as a PDF or add them to the open one.
 *
 *   Camera  live view with the page outlined; Space or the round button takes a
 *           picture; Auto-capture takes it when the page holds still.
 *   Pages   the pages in order: drag to reorder; crop (drag the corners), turn,
 *           choose a look (Auto, Grayscale, Black & white, Photo), retake, delete.
 *   Save    page size, quality, searchable text; Save PDF… or add to the open PDF.
 *
 * Image work runs in two background workers (worker.js): a light one for the
 * live outline and one for full-size pages, so the screen never stutters.
 */
import { FILTERS, WHOLE, FULL, sameOutline } from './imaging.js';
import { recognize, prewarm } from './ocr.js';
import { buildPdf, addScannedPages, PAPER } from './build.js';

export const QUALITY = {
  small: { label: 'Smaller file', maxSide: 1700, q: 0.62 },
  balanced: { label: 'Balanced', maxSide: 2400, q: 0.74 },
  best: { label: 'Best quality', maxSide: 3300, q: 0.86 },
};
const PREVIEW = { maxSide: 1500, q: 0.82 };
const IMAGE_TYPES = /^image\/(jpeg|png|webp|bmp|gif)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|bmp|gif)$/i;
const HEIC = /\.(heic|heif)$/i;

/** Runs jobs in a worker; heavy jobs one at a time so memory stays modest. */
class Jobs {
  #w; #next = 1; #pending = new Map(); #chain = Promise.resolve();
  constructor() {
    this.#w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.#w.onmessage = (e) => {
      const p = this.#pending.get(e.data.id);
      if (!p) return;
      this.#pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data.result);
    };
    this.#w.onerror = (e) => { for (const p of this.#pending.values()) p.reject(new Error(e.message || 'Scan worker failed')); this.#pending.clear(); };
  }
  call(op, args = {}, transfer = []) {
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#w.postMessage({ id, op, ...args }, transfer);
    });
  }
  /** Queue behind earlier queued jobs. */
  queue(op, args) {
    const run = this.#chain.then(() => this.call(op, args));
    this.#chain = run.catch(() => {});
    return run;
  }
  stop() { this.#w.terminate(); for (const p of this.#pending.values()) p.reject(new Error('stopped')); this.#pending.clear(); }
}

let pageIds = 1;
const stamp = () => {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`;
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const mb = (bytes) => (bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);

export class Scanner {
  /**
   * opts: { start: 'camera' | 'pages', files?: File[], addTo?: boolean }
   * Resolves `closed` when the scanner closes.
   */
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.opts = opts;
    this.ui = ctx.ui;
    this.h = ctx.h;
    this.icon = ctx.icon;
    const s = ctx.settings.scan || {};
    this.prefs = {
      filter: s.filter || 'auto', quality: s.quality || 'balanced', size: s.size || 'auto',
      ocr: s.ocr !== false, auto: s.auto !== false, camera: s.camera || '', flatten: s.flatten !== false,
    };
    this.pages = [];
    this.sel = 0;
    this.mode = null;
    this.retakeId = null;
    this.urls = new Set();
    this.closed = new Promise((r) => { this.#resolveClosed = r; });
  }
  #resolveClosed;

  // ================================================================ open / close
  async open() {
    this.heavy = new Jobs();
    this.live = new Jobs();
    this.#build();
    document.body.append(this.el);
    document.body.classList.add('scanning');
    this.ctx.commands.setModal(new Set(['help.about', 'help.shortcuts']));
    this.onKey = (e) => this.#key(e);
    document.addEventListener('keydown', this.onKey);
    this.resizeObs = new ResizeObserver(() => { if (this.mode === 'pages' && this.cropping) this.#layoutCrop(); });
    this.resizeObs.observe(this.$canvas);
    if (this.opts.files?.length) {
      this.#show('pages');
      await this.addFiles(this.opts.files);
    } else if (this.opts.start === 'photos') {
      this.#show('pages');
      const added = await this.pickPhotos();
      if (!added && !this.pages.length) this.close(true);
    } else {
      await this.#show('camera');
    }
    return this.closed;
  }

  async close(force = false) {
    if (this.busy) return;
    if (!force && this.pages.length) {
      const ok = await this.ui.confirm('Close the scanner', `Discard ${plural(this.pages.length, 'scanned page')}? They haven't been saved.`, { okLabel: 'Discard', danger: true });
      if (!ok) return;
    }
    this.#stopCamera();
    clearInterval(this.liveTimer);
    this.heavy?.stop(); this.live?.stop();
    for (const u of this.urls) URL.revokeObjectURL(u);
    document.removeEventListener('keydown', this.onKey);
    this.resizeObs?.disconnect();
    this.el.remove();
    document.body.classList.remove('scanning');
    this.ctx.commands.setModal(null);
    this.#resolveClosed();
  }

  url(blob) { const u = URL.createObjectURL(blob); this.urls.add(u); return u; }
  drop(u) { if (u) { URL.revokeObjectURL(u); this.urls.delete(u); } }

  // ================================================================ layout
  #build() {
    const { h, icon } = this;
    const btn = (cls, label, iconName, onClick, extra = {}) => h('button', { type: 'button', class: cls, title: extra.title || label, 'aria-label': extra.title || label, html: (iconName ? icon(iconName, { size: 18 }) : '') + (label && !extra.iconOnly ? `<span>${label}</span>` : ''), onClick, ...extra.attrs });

    // ---- header
    this.$tabCamera = h('button', { type: 'button', class: 'sc-tab', role: 'tab', onClick: () => this.#show('camera') }, 'Camera');
    this.$tabPages = h('button', { type: 'button', class: 'sc-tab', role: 'tab', onClick: () => this.pages.length && this.#show('pages') }, 'Pages');
    const head = h('header', { class: 'sc-head' },
      h('div', { class: 'sc-title', html: `${icon('camera', { size: 18 })}<span>Scan to PDF</span>` }),
      h('div', { class: 'sc-tabs', role: 'tablist' }, this.$tabCamera, this.$tabPages),
      btn('sc-close', '', 'close', () => this.close(), { title: 'Close the scanner (Esc)', iconOnly: true }));

    // ---- camera
    this.$video = h('video', { class: 'sc-video', autoplay: true, muted: true, playsinline: true });
    this.$outline = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.$outline.setAttribute('class', 'sc-outline');
    this.$hint = h('div', { class: 'sc-hint', 'aria-live': 'polite' });
    this.$flash = h('div', { class: 'sc-flash' });
    this.$camMsg = h('div', { class: 'sc-cam-msg', hidden: true });
    this.$stage = h('div', { class: 'sc-stage' }, this.$video, this.$outline, this.$hint, this.$flash, this.$camMsg);
    this.$cameraSel = h('select', { class: 'sc-select', title: 'Camera', 'aria-label': 'Camera', hidden: true, onChange: () => { this.prefs.camera = this.$cameraSel.value; this.#savePrefs(); this.#startCamera(); } });
    this.$auto = h('input', { type: 'checkbox', checked: this.prefs.auto, onChange: () => { this.prefs.auto = this.$auto.checked; this.#savePrefs(); this.#resetStable(); } });
    this.$shutter = h('button', { type: 'button', class: 'sc-shutter', title: 'Take picture (Space)', 'aria-label': 'Take picture', onClick: () => this.capture() }, h('span', { class: 'sc-ring' }));
    this.$last = h('button', { type: 'button', class: 'sc-last', title: 'See the pages', 'aria-label': 'See the pages', hidden: true, onClick: () => this.#show('pages') });
    this.$done = h('button', { type: 'button', class: 'btn primary', disabled: true, onClick: () => this.#show('pages') }, 'Review');
    const camera = h('section', { class: 'sc-camera' }, this.$stage,
      h('div', { class: 'sc-bar' },
        h('div', { class: 'sc-bar-side' },
          btn('btn sc-import', 'Import photos', 'image', () => this.pickPhotos(), { title: 'Use photos from this device (for example from your phone)' }),
          this.$cameraSel),
        this.$shutter,
        h('div', { class: 'sc-bar-side end' },
          h('label', { class: 'sc-check', title: 'Take the picture by itself when the page holds still' }, this.$auto, h('span', { class: 'long', text: 'Auto-capture' }), h('span', { class: 'short', text: 'Auto' })),
          this.$last, this.$done)));

    // ---- pages
    this.$strip = h('div', { class: 'sc-strip-list', role: 'listbox', 'aria-label': 'Pages' });
    const strip = h('aside', { class: 'sc-strip' }, this.$strip,
      h('div', { class: 'sc-strip-add' },
        btn('btn small', 'Camera', 'camera', () => this.#show('camera'), { title: 'Add pages with the camera' }),
        btn('btn small', 'Photos', 'image', () => this.pickPhotos(), { title: 'Add photos from this device' })));
    this.$pageNo = h('span', { class: 'sc-pageno' });
    this.$viewTools = h('div', { class: 'sc-tools' },
      btn('btn small', 'Crop', 'crop', () => this.#startCrop(), { title: 'Adjust the corners' }),
      btn('btn small', '', 'rotateCcw', () => this.#turn(-1), { title: 'Turn left (Shift+R)', iconOnly: true }),
      btn('btn small', '', 'rotateCw', () => this.#turn(1), { title: 'Turn right (R)', iconOnly: true }),
      btn('btn small', 'Retake', 'camera', () => this.#retake(), { title: 'Take this page again' }),
      btn('btn small', '', 'trash', () => this.#deletePage(), { title: 'Delete this page (Delete)', iconOnly: true }));
    this.$cropTools = h('div', { class: 'sc-tools', hidden: true },
      h('span', { class: 'sc-crop-hint', text: 'Drag the corners onto the page’s corners' }),
      btn('btn small', 'Find page', 'search', () => this.#cropAuto(), { title: 'Find the page again' }),
      btn('btn small', 'Whole photo', 'expand', () => this.#cropSet(FULL), { title: 'Keep the whole photo' }),
      btn('btn small', 'Cancel', '', () => this.#endCrop(false)),
      btn('btn small primary', 'Done', 'check', () => this.#endCrop(true)));
    this.$canvas = h('div', { class: 'sc-canvas' });
    const view = h('main', { class: 'sc-view' }, h('div', { class: 'sc-viewbar' }, this.$pageNo, this.$viewTools, this.$cropTools), this.$canvas);

    this.$filters = h('div', { class: 'sc-filters', role: 'radiogroup', 'aria-label': 'Look' });
    for (const f of FILTERS) {
      const b = h('button', { type: 'button', class: 'sc-filter', role: 'radio', 'data-filter': f.id, title: f.hint, onClick: () => this.#setFilter(f.id) },
        h('span', { class: 'sc-filter-img' }), h('span', { class: 'sc-filter-name', text: f.label }));
      this.$filters.append(b);
    }
    this.$allLook = h('button', { type: 'button', class: 'link-btn sc-all', onClick: () => this.#filterAll() }, 'Use this look on every page');
    this.$flatten = h('input', { type: 'checkbox', checked: this.prefs.flatten, onChange: () => this.#setFlatten(this.$flatten.checked) });
    const sel = (key, options, label) => {
      const s = h('select', { class: 'sc-select wide', 'aria-label': label, onChange: () => { this.prefs[key] = s.value; this.#savePrefs(); } },
        ...Object.entries(options).map(([k, v]) => h('option', { value: k, selected: this.prefs[key] === k, text: v })));
      return h('label', { class: 'sc-field' }, h('span', { text: label }), s);
    };
    this.$ocr = h('input', { type: 'checkbox', checked: this.prefs.ocr, onChange: () => { this.prefs.ocr = this.$ocr.checked; this.#savePrefs(); } });
    const doc = this.ctx.reader;
    this.canAdd = doc.hasDocument && doc.canEdit;
    this.$dest = h('div', { class: 'sc-dest', hidden: !this.canAdd });
    if (this.canAdd) {
      const name = doc.file?.name || 'the open PDF';
      this.$destNew = h('input', { type: 'radio', name: 'sc-dest', value: 'new', checked: !this.opts.addTo, onChange: () => this.#saveLabel() });
      this.$destAdd = h('input', { type: 'radio', name: 'sc-dest', value: 'add', checked: !!this.opts.addTo, onChange: () => this.#saveLabel() });
      this.$where = h('select', { class: 'sc-select wide', 'aria-label': 'Where to add the pages', onFocus: () => { this.$destAdd.checked = true; this.#saveLabel(); } },
        h('option', { value: 'after', text: `After page ${doc.pageNumber}` }),
        h('option', { value: 'end', text: `At the end (after page ${doc.pageCount})` }),
        h('option', { value: 'start', text: 'At the start' }));
      this.$dest.append(
        h('label', { class: 'sc-radio' }, this.$destNew, h('span', { text: 'A new PDF' })),
        h('label', { class: 'sc-radio' }, this.$destAdd, h('span', {}, 'Add to ', h('b', { text: name }))),
        h('div', { class: 'sc-where' }, this.$where));
    }
    this.$save = h('button', { type: 'button', class: 'btn primary sc-save', onClick: () => this.save() }, 'Save PDF…');
    this.$saveNote = h('p', { class: 'sc-note' });
    const sheetHead = (title) => h('div', { class: 'sc-sheet-head' }, h('h3', { text: title }),
      h('button', { type: 'button', class: 'btn small', text: 'Done', onClick: () => this.#sheet(null) }));
    const side = h('aside', { class: 'sc-side' },
      h('div', { class: 'sc-lookbox' }, sheetHead('Look'), this.$filters, this.$allLook,
        h('label', { class: 'sc-check block', title: 'Lay curled, bowed or folded pages flat, so the lines of text run straight' }, this.$flatten, h('span', { text: 'Flatten bent pages' }))),
      h('div', { class: 'sc-savebox' }, sheetHead('Save'),
        sel('size', { auto: 'Match the paper (auto)', ...Object.fromEntries(Object.entries(PAPER).map(([k, v]) => [k, v.label])) }, 'Page size'),
        sel('quality', Object.fromEntries(Object.entries(QUALITY).map(([k, v]) => [k, v.label])), 'Quality'),
        h('label', { class: 'sc-check block', title: 'Recognise the words so you can search, select and copy them' }, this.$ocr, h('span', { text: 'Make text searchable (English)' })),
        this.$dest, this.$save, this.$saveNote));
    this.$side = side;
    // on a phone the Look and Save panels open from this bar
    this.$phoneSave = h('button', { type: 'button', class: 'btn primary', onClick: () => this.#sheet('save') }, 'Save…');
    const phonebar = h('div', { class: 'sc-phonebar' },
      h('button', { type: 'button', class: 'btn', onClick: () => this.#sheet('look') }, 'Look'), this.$phoneSave);
    const pages = h('section', { class: 'sc-pages', hidden: true }, strip, view, side, phonebar);

    this.$camera = camera; this.$pagesEl = pages;
    this.el = h('div', { class: 'scanner', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Scan to PDF' }, head, h('div', { class: 'sc-body' }, camera, pages));
    // photos dropped onto the scanner are added
    this.el.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); e.stopPropagation(); } });
    this.el.addEventListener('drop', (e) => {
      const files = [...(e.dataTransfer?.files || [])];
      if (!files.length) return;
      e.preventDefault(); e.stopPropagation();
      document.getElementById('dropOverlay').hidden = true;
      this.addFiles(files);
    });
    this.#saveLabel();
  }

  #savePrefs() { this.ctx.saveSettings({ scan: { ...this.prefs } }); }

  /** Phone: show the Look or Save panel as a sheet (null closes it). */
  #sheet(which) {
    this.$side.classList.toggle('sheet-look', which === 'look');
    this.$side.classList.toggle('sheet-save', which === 'save');
  }

  #saveLabel() {
    const add = this.canAdd && this.$destAdd?.checked;
    const n = this.pages.length;
    this.$save.textContent = add ? `Add ${plural(n, 'page')}` : 'Save PDF…';
    this.$save.disabled = !n;
    if (this.$phoneSave) { this.$phoneSave.disabled = !n; this.$phoneSave.textContent = add ? 'Add…' : 'Save…'; }
    if (this.$where) this.$where.disabled = !add;
  }

  async #show(mode) {
    if (this.cropping) this.#endCrop(false);
    this.mode = mode;
    this.$camera.hidden = mode !== 'camera';
    this.$pagesEl.hidden = mode !== 'pages';
    this.$tabCamera.setAttribute('aria-selected', String(mode === 'camera'));
    this.$tabPages.setAttribute('aria-selected', String(mode === 'pages'));
    if (mode === 'camera') {
      await this.#startCamera();
    } else {
      this.#stopCamera();
      this.retakeId = null;
      this.#renderStrip();
      this.#select(Math.min(this.sel, this.pages.length - 1));
      if (this.prefs.ocr) prewarm();
    }
  }

  // ================================================================ camera
  async #startCamera() {
    this.#stopCamera();
    this.$camMsg.hidden = true;
    this.$hint.textContent = 'Starting the camera…';
    if (!navigator.mediaDevices?.getUserMedia) return this.#cameraProblem('This computer doesn’t offer a camera to apps.');
    try {
      const want = this.prefs.camera;
      const video = { width: { ideal: 3840 }, height: { ideal: 2160 }, ...(want ? { deviceId: { exact: want } } : { facingMode: { ideal: 'environment' } }) };
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      } catch (err) {
        if (!want || err.name !== 'OverconstrainedError' && err.name !== 'NotFoundError') throw err;
        this.prefs.camera = ''; this.#savePrefs();                     // the saved camera was unplugged
        this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false });
      }
    } catch (err) {
      return this.#cameraProblem(cameraMessage(err));
    }
    if (this.mode !== 'camera') { this.#stopCamera(); return; }
    this.$video.srcObject = this.stream;
    await this.$video.play().catch(() => {});
    await this.#listCameras();
    this.$hint.textContent = 'Point the camera at a page';
    this.#resetStable();
    clearInterval(this.liveTimer);
    this.liveTimer = setInterval(() => this.#liveTick(), 140);
  }

  #stopCamera() {
    clearInterval(this.liveTimer);
    this.liveTimer = null;
    this.stream?.getTracks().forEach((t) => t.stop());   // the camera light goes off
    this.stream = null;
    this.$video.srcObject = null;
    this.liveQuad = null;
    this.#drawOutline(null);
  }

  #cameraProblem(text) {
    this.$hint.textContent = '';
    this.$camMsg.hidden = false;
    this.$camMsg.replaceChildren(
      this.h('div', { class: 'sc-cam-icon', html: this.icon('camera', { size: 34 }) }),
      this.h('p', { class: 'sc-cam-title', text: 'The camera isn’t available' }),
      this.h('p', { text }),
      this.h('p', { class: 'sc-cam-alt', text: 'You can still make a PDF from photos, for example ones taken on your phone and copied to this device.' }),
      this.h('div', { class: 'sc-cam-actions' },
        this.h('button', { type: 'button', class: 'btn primary', text: 'Import photos…', onClick: () => this.pickPhotos() }),
        this.h('button', { type: 'button', class: 'btn', text: 'Try again', onClick: () => this.#startCamera() })));
    this.$shutter.disabled = true;
  }

  async #listCameras() {
    this.$shutter.disabled = false;
    const cams = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter((d) => d.kind === 'videoinput');
    const current = this.stream?.getVideoTracks()[0]?.getSettings().deviceId;
    this.$cameraSel.replaceChildren(...cams.map((c, i) => this.h('option', { value: c.deviceId, selected: c.deviceId === current, text: c.label || `Camera ${i + 1}` })));
    this.$cameraSel.hidden = cams.length < 2;
  }

  /** The live outline: a small frame to the light worker a few times a second. */
  async #liveTick() {
    const v = this.$video;
    if (this.liveBusy || !this.stream || v.readyState < 2 || !v.videoWidth) return;
    this.liveBusy = true;
    try {
      const s = 360 / Math.max(v.videoWidth, v.videoHeight);
      const w = Math.round(v.videoWidth * s), hh = Math.round(v.videoHeight * s);
      const c = this.liveCanvas || (this.liveCanvas = document.createElement('canvas'));
      if (c.width !== w || c.height !== hh) { c.width = w; c.height = hh; }
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(v, 0, 0, w, hh);
      const image = g.getImageData(0, 0, w, hh);
      const sig = signature(image);
      const { corners } = await this.live.call('detect', { image }, [image.data.buffer]);
      if (this.mode !== 'camera') return;
      this.#onLive(corners, sig);
    } catch { /* a dropped frame is fine */ } finally {
      this.liveBusy = false;
    }
  }

  #resetStable() { this.history = []; this.armed = true; this.lostFrames = 0; this.$shutter.style.setProperty('--hold', '0'); }

  #onLive(corners, sig) {
    // smooth the outline a little so it doesn't jitter
    if (corners && this.liveQuad && sameOutline(corners, this.liveQuad, 0.04)) {
      corners = corners.map((p, i) => ({ x: this.liveQuad[i].x * 0.4 + p.x * 0.6, y: this.liveQuad[i].y * 0.4 + p.y * 0.6 }));
    }
    this.liveQuad = corners;
    this.#drawOutline(corners);
    // after a capture, wait for a new page: the page is taken away, moved, or what's on it changes
    if (!this.armed) {
      const changed = this.lastSig && sig && sig.reduce((s, v, i) => s + Math.abs(v - this.lastSig[i]), 0) / sig.length > 14;
      if (!corners) this.lostFrames++; else this.lostFrames = 0;
      if (this.lostFrames >= 3 || changed || (corners && this.lastCorners && !sameOutline(corners, this.lastCorners, 0.1))) { this.armed = true; this.history = []; }
    }
    if (!corners) {
      this.history = [];
      this.$shutter.style.setProperty('--hold', '0');
      this.$hint.textContent = this.pages.length ? 'Point the camera at the next page' : 'Point the camera at a page';
      return;
    }
    this.history.push(corners);
    if (this.history.length > 8) this.history.shift();
    const steady = this.history.length >= 3 && this.history.every((q) => sameOutline(q, corners, 0.015));
    if (!steady) this.history = this.history.filter((q) => sameOutline(q, corners, 0.015));
    if (!this.prefs.auto) {
      this.$hint.textContent = 'Page found — press Space or the round button';
      return;
    }
    if (!this.armed) { this.$hint.textContent = 'Captured. Put down the next page'; this.$shutter.style.setProperty('--hold', '0'); return; }
    const hold = Math.min(1, this.history.length / 8);
    this.$shutter.style.setProperty('--hold', String(hold));
    this.$hint.textContent = hold < 1 ? 'Hold still…' : 'Capturing';
    if (hold >= 1 && !this.capturing) {
      this.lastSig = sig;
      this.capture({ auto: true });
    }
  }

  #drawOutline(corners) {
    const svg = this.$outline;
    const v = this.$video;
    if (!corners || !v.videoWidth) { svg.replaceChildren(); this.$stage.classList.remove('found'); return; }
    // the video is shown "contain": find where its picture sits in the stage
    const box = this.$stage.getBoundingClientRect();
    const s = Math.min(box.width / v.videoWidth, box.height / v.videoHeight);
    const w = v.videoWidth * s, hgt = v.videoHeight * s, ox = (box.width - w) / 2, oy = (box.height - hgt) / 2;
    svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
    const pts = corners.map((p) => `${(ox + p.x * w).toFixed(1)},${(oy + p.y * hgt).toFixed(1)}`).join(' ');
    svg.innerHTML = `<polygon points="${pts}" class="sc-quad"/>` + corners.map((p) => `<circle cx="${(ox + p.x * w).toFixed(1)}" cy="${(oy + p.y * hgt).toFixed(1)}" r="5" class="sc-dot"/>`).join('');
    this.$stage.classList.add('found');
  }

  /** Take a picture of what the camera sees now. */
  async capture({ auto = false } = {}) {
    const v = this.$video;
    if (!this.stream || !v.videoWidth || this.capturing) return;
    this.capturing = true;
    try {
      const c = document.createElement('canvas');
      c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
      const corners = this.liveQuad;
      this.lastCorners = corners;
      this.armed = false; this.history = []; this.lostFrames = 0;
      this.$shutter.style.setProperty('--hold', '0');
      this.$flash.classList.remove('go'); void this.$flash.offsetWidth; this.$flash.classList.add('go');
      const page = this.#newPage(blob, 'Camera', corners);
      if (this.retakeId) {
        const i = this.pages.findIndex((p) => p.id === this.retakeId);
        const old = this.pages[i];
        if (old) { this.#forget(old); this.pages[i] = page; this.sel = i; }
        this.retakeId = null;
        this.#prepare(page);
        this.#updateCounts();
        this.#show('pages');
        return;
      }
      this.pages.push(page);
      this.sel = this.pages.length - 1;
      this.#prepare(page);
      this.#updateCounts();
      this.$hint.textContent = `Page ${this.pages.length} captured${auto ? '. Put down the next page' : ''}`;
    } finally {
      setTimeout(() => { this.capturing = false; }, 350);
    }
  }

  #updateCounts() {
    const n = this.pages.length;
    this.$tabPages.textContent = n ? `Pages (${n})` : 'Pages';
    this.$tabPages.disabled = !n;
    this.$done.disabled = !n;
    this.$done.replaceChildren(this.h('span', { class: 'long', text: n ? `Review ${plural(n, 'page')}` : 'Review' }), this.h('span', { class: 'short', text: n ? `Next (${n})` : 'Next' }));
    const last = this.pages[n - 1];
    this.$last.hidden = !last;
    if (last) {
      const src = last.previewUrl || last.thumbUrl;
      this.$last.replaceChildren(src ? this.h('img', { src, alt: '' }) : this.h('span', { class: 'sc-spin' }), this.h('span', { class: 'sc-count', text: String(n) }));
    }
    this.#saveLabel();
  }

  // ================================================================ pages
  #newPage(blob, from, corners = null) {
    const page = { id: pageIds++, from, source: blob, corners: corners || null, liveCorners: corners || null, rotation: 0, filter: this.prefs.filter, status: 'preparing' };
    page.thumbUrl = this.url(blob);
    return page;
  }

  #forget(page) {
    this.drop(page.thumbUrl); this.drop(page.viewUrl); this.drop(page.previewUrl);
    for (const u of Object.values(page.filterUrls || {})) this.drop(u);
    this.heavy.call('forget', { key: page.id }).catch(() => {});
  }

  /** Find and straighten the page in a new photo, then make its preview. */
  async #prepare(page) {
    try {
      const r = await this.heavy.queue('prepare', { key: page.id, blob: page.source });
      page.srcW = r.width; page.srcH = r.height;
      page.viewUrl = this.url(r.view);
      page.found = r.found || !!page.liveCorners;
      // the sharper outline from the full photo; the live one if only that found the page
      page.corners = r.found ? r.corners : page.liveCorners || WHOLE;
      page.edges = r.found ? r.edges : null;              // the traced sides, curved where the paper curls
      page.status = 'ready';
      await this.#renderPreview(page);
      if (!page.found && this.mode === 'pages' && this.pages[this.sel] === page) this.ui.toast('No clear page edges in this photo. Use Crop to set the corners.', { timeout: 4500 });
    } catch (err) {
      page.status = 'failed';
      page.error = err.message;
      this.#renderStrip();
      if (this.pages[this.sel] === page) this.#select(this.sel);
    }
  }

  async #renderPreview(page) {
    const key = JSON.stringify([page.corners, page.rotation, page.filter, this.prefs.flatten]);
    page.renderKey = key;
    page.rendering = true;
    this.#refreshPage(page);
    const r = await this.heavy.queue('render', { ...this.#shape(page), rotation: page.rotation, filter: page.filter, maxSide: PREVIEW.maxSide, quality: PREVIEW.q });
    if (page.renderKey !== key || !this.pages.includes(page)) return;   // changed again meanwhile, or deleted
    this.drop(page.previewUrl);
    page.previewUrl = this.url(r.blob);
    page.aspect = r.aspect;
    page.rendering = false;
    this.#refreshPage(page);
    if (this.pages[this.sel] === page && this.mode === 'pages') this.#loadFilterPreviews(page);
  }

  #refreshPage(page) {
    if (this.mode === 'pages') {
      this.#renderStrip();
      if (this.pages[this.sel] === page && !this.cropping) this.#showResult(page);
    }
    this.#updateCounts();
  }

  #renderStrip() {
    const { h } = this;
    this.$strip.replaceChildren(...this.pages.map((p, i) => {
      const item = h('div', {
        class: 'sc-thumb' + (i === this.sel ? ' on' : ''), role: 'option', 'aria-selected': String(i === this.sel), tabindex: '0', draggable: 'true',
        title: 'Click to see this page; drag to change the order',
        onClick: () => this.#select(i),
        onContextmenu: (e) => { e.preventDefault(); this.#select(i); this.#thumbMenu(e.clientX, e.clientY, i); },
      },
      h('div', { class: 'sc-thumb-img' },
        p.previewUrl ? h('img', { src: p.previewUrl, alt: `Page ${i + 1}` }) : h('span', { class: 'sc-spin' }),
        p.status === 'failed' ? h('span', { class: 'sc-thumb-bad', text: '!' }) : null,
        p.rendering && p.previewUrl ? h('span', { class: 'sc-spin small' }) : null),
      h('span', { class: 'sc-thumb-no', text: String(i + 1) }));
      item.addEventListener('dragstart', (e) => { this.dragFrom = i; e.dataTransfer.effectAllowed = 'move'; item.classList.add('dragging'); });
      item.addEventListener('dragend', () => { item.classList.remove('dragging'); this.$strip.querySelectorAll('.drop-before,.drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after')); });
      item.addEventListener('dragover', (e) => {
        if (this.dragFrom == null) return;
        e.preventDefault(); e.stopPropagation();
        const r = item.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
        this.$strip.querySelectorAll('.drop-before,.drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
        item.classList.add(after ? 'drop-after' : 'drop-before');
      });
      item.addEventListener('drop', (e) => {
        if (this.dragFrom == null) return;
        e.preventDefault(); e.stopPropagation();
        const r = item.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
        this.#move(this.dragFrom, i + (after ? 1 : 0));
        this.dragFrom = null;
      });
      return item;
    }));
  }

  #thumbMenu(x, y, i) {
    this.ui.contextMenu(x, y, [
      { label: 'Move up', disabled: i === 0, run: () => this.#move(i, i - 1) },
      { label: 'Move down', disabled: i === this.pages.length - 1, run: () => this.#move(i, i + 2) },
      { separator: true },
      { label: 'Retake', run: () => this.#retake() },
      { label: 'Delete page', danger: true, run: () => this.#deletePage() },
    ]);
  }

  /** Move page `from` so it sits before index `to` (in the current order). */
  #move(from, to) {
    if (to === from || to === from + 1) return;
    const [p] = this.pages.splice(from, 1);
    const at = to > from ? to - 1 : to;
    this.pages.splice(at, 0, p);
    this.sel = at;
    this.#renderStrip();
    this.#select(at);
  }

  #select(i) {
    if (!this.pages.length) { this.#emptyPages(); return; }
    this.sel = Math.max(0, Math.min(i, this.pages.length - 1));
    const page = this.pages[this.sel];
    this.$strip.querySelectorAll('.sc-thumb').forEach((el, k) => { el.classList.toggle('on', k === this.sel); el.setAttribute('aria-selected', String(k === this.sel)); });
    this.$strip.children[this.sel]?.scrollIntoView({ block: 'nearest' });
    this.$pageNo.textContent = `Page ${this.sel + 1} of ${this.pages.length}`;
    this.$filters.querySelectorAll('.sc-filter').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.filter === page.filter)));
    this.#showResult(page);
    this.#loadFilterPreviews(page);
  }

  #emptyPages() {
    this.$pageNo.textContent = '';
    this.$canvas.replaceChildren(this.h('div', { class: 'sc-empty' },
      this.h('p', { text: 'No pages yet.' }),
      this.h('div', { class: 'sc-cam-actions' },
        this.h('button', { type: 'button', class: 'btn primary', text: 'Use the camera', onClick: () => this.#show('camera') }),
        this.h('button', { type: 'button', class: 'btn', text: 'Import photos…', onClick: () => this.pickPhotos() }))));
    this.#saveLabel();
  }

  #showResult(page) {
    const { h } = this;
    if (page.status === 'failed') {
      this.$canvas.replaceChildren(h('div', { class: 'sc-empty' }, h('p', { text: `This photo couldn't be read (${page.error}).` }),
        h('button', { type: 'button', class: 'btn', text: 'Delete it', onClick: () => this.#deletePage() })));
      return;
    }
    if (!page.previewUrl) { this.$canvas.replaceChildren(h('div', { class: 'sc-empty' }, h('span', { class: 'sc-spin' }), h('p', { text: 'Straightening the page…' }))); return; }
    const img = h('img', { class: 'sc-result', src: page.previewUrl, alt: `Page ${this.sel + 1}`, draggable: 'false' });
    this.$canvas.replaceChildren(...[img, page.rendering ? h('span', { class: 'sc-spin corner' }) : null].filter(Boolean));
  }

  async #loadFilterPreviews(page) {
    if (!page.corners || page.status !== 'ready') return;
    const key = JSON.stringify([page.corners, page.rotation, this.prefs.flatten]);
    if (page.filterKey === key) { this.#paintFilters(page); return; }
    page.filterKey = key;
    try {
      const r = await this.heavy.queue('filters', { ...this.#shape(page), rotation: page.rotation, size: 200 });
      if (page.filterKey !== key) return;
      for (const u of Object.values(page.filterUrls || {})) this.drop(u);
      page.filterUrls = Object.fromEntries(Object.entries(r).map(([k, b]) => [k, this.url(b)]));
      if (this.pages[this.sel] === page) this.#paintFilters(page);
    } catch { /* previews are a nicety */ }
  }

  /** What the worker needs to straighten a page: the photo, its outline, and how to flatten it. */
  #shape(page) {
    return { key: page.id, blob: page.source, corners: page.corners, edges: page.edges || null, flatten: this.prefs.flatten };
  }

  #setFlatten(on) {
    this.prefs.flatten = on; this.#savePrefs();
    for (const p of this.pages) if (p.status === 'ready') this.#renderPreview(p);
    const page = this.pages[this.sel];
    if (page) this.#loadFilterPreviews(page);
  }

  #paintFilters(page) {
    for (const b of this.$filters.querySelectorAll('.sc-filter')) {
      const u = page.filterUrls?.[b.dataset.filter];
      b.querySelector('.sc-filter-img').style.backgroundImage = u ? `url("${u}")` : '';
    }
  }

  #setFilter(f) {
    const page = this.pages[this.sel];
    if (!page) return;
    this.prefs.filter = f; this.#savePrefs();
    if (page.filter === f) return;
    page.filter = f;
    this.$filters.querySelectorAll('.sc-filter').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.filter === f)));
    this.#renderPreview(page);
  }

  #filterAll() {
    const f = this.pages[this.sel]?.filter;
    if (!f) return;
    let n = 0;
    for (const p of this.pages) if (p.filter !== f) { p.filter = f; n++; if (p.status === 'ready') this.#renderPreview(p); }
    this.ui.toast(n ? `${FILTERS.find((x) => x.id === f).label} on every page` : 'Every page already has this look');
  }

  #turn(d) {
    const page = this.pages[this.sel];
    if (!page || page.status !== 'ready') return;
    page.rotation = (page.rotation + d + 4) % 4;
    this.#renderPreview(page);
    this.#loadFilterPreviews(page);
  }

  async #deletePage() {
    const page = this.pages[this.sel];
    if (!page) return;
    this.#forget(page);
    this.pages.splice(this.sel, 1);
    this.#renderStrip();
    this.#updateCounts();
    this.ui.toast(`Page deleted`);
    if (!this.pages.length) { this.#emptyPages(); return; }
    this.#select(Math.min(this.sel, this.pages.length - 1));
  }

  #retake() {
    const page = this.pages[this.sel];
    if (!page) return;
    this.retakeId = page.id;
    this.#show('camera').then(() => { if (this.retakeId) this.$hint.textContent = `Retaking page ${this.sel + 1}`; });
  }

  // ================================================================ crop editor
  #startCrop() {
    const page = this.pages[this.sel];
    if (!page || page.status !== 'ready' || !page.viewUrl) return;
    this.cropping = { page, corners: page.corners.map((p) => ({ ...p })) };
    this.$viewTools.hidden = true;
    this.$cropTools.hidden = false;
    const { h } = this;
    const img = h('img', { class: 'sc-crop-img', src: page.viewUrl, alt: 'The photo', draggable: 'false' });
    // the outline is made once and then only moved, so a drag is never interrupted
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'sc-crop-svg');
    const el = (tag, cls) => { const e = document.createElementNS(NS, tag); e.setAttribute('class', cls); svg.append(e); return e; };
    const shade = el('path', 'sc-crop-shade');
    shade.setAttribute('fill-rule', 'evenodd');
    const quad = el('polygon', 'sc-crop-quad');
    const mids = [0, 1, 2, 3].map(() => el('circle', 'sc-crop-mid'));
    const dots = [0, 1, 2, 3].map(() => el('circle', 'sc-crop-handle'));
    mids.forEach((m) => m.setAttribute('r', '8'));
    dots.forEach((d) => d.setAttribute('r', '11'));
    const loupe = h('div', { class: 'sc-loupe', hidden: true });
    // takes the touches, and reaches a little past the photo so corners at its edge are easy to catch
    const hit = h('div', { class: 'sc-crop-hit' });
    const wrap = h('div', { class: 'sc-crop' }, img, svg, hit, loupe);
    this.$canvas.replaceChildren(wrap);
    Object.assign(this.cropping, { img, svg, loupe, wrap, shade, quad, mids, dots, hit });
    hit.addEventListener('pointerdown', (e) => this.#dragStart(e));
    hit.addEventListener('pointermove', (e) => this.#hover(e));
    if (img.complete) this.#layoutCrop(); else img.onload = () => this.#layoutCrop();
  }

  #layoutCrop() {
    const c = this.cropping;
    if (!c) return;
    const box = this.$canvas.getBoundingClientRect();
    const iw = c.img.naturalWidth, ih = c.img.naturalHeight;
    if (!iw) return;
    const pad = 28;
    const s = Math.min((box.width - pad * 2) / iw, (box.height - pad * 2) / ih);
    c.w = iw * s; c.h = ih * s;
    Object.assign(c.wrap.style, { width: `${c.w}px`, height: `${c.h}px` });
    c.svg.setAttribute('viewBox', `0 0 ${c.w} ${c.h}`);
    this.#drawCrop();
  }

  /** Move the outline, the shading and the handles to the current corners. */
  #drawCrop() {
    const c = this.cropping;
    if (!c?.w) return;
    const P = c.corners.map((p) => ({ x: p.x * c.w, y: p.y * c.h }));
    const poly = P.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    c.shade.setAttribute('d', `M0 0H${c.w}V${c.h}H0Z M${P.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L')}Z`);
    c.quad.setAttribute('points', poly);
    P.forEach((p, i) => {
      const q = P[(i + 1) % 4];
      c.dots[i].setAttribute('cx', p.x.toFixed(1)); c.dots[i].setAttribute('cy', p.y.toFixed(1));
      c.mids[i].setAttribute('cx', ((p.x + q.x) / 2).toFixed(1)); c.mids[i].setAttribute('cy', ((p.y + q.y) / 2).toFixed(1));
    });
  }

  /**
   * The handle under or nearest the pointer: a corner first, then the middle of a side.
   * Fingers get a generous reach, a mouse a smaller one.
   */
  #handleAt(e) {
    const c = this.cropping;
    const r = c.svg.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const reach = e.pointerType === 'touch' ? 44 : e.pointerType === 'pen' ? 30 : 22;
    const P = c.corners.map((p) => ({ x: p.x * c.w, y: p.y * c.h }));
    let best = null;
    P.forEach((p, i) => { const d = Math.hypot(p.x - x, p.y - y); if (d <= reach && (!best || d < best.d)) best = { corner: i, d }; });
    if (best) return best;
    P.forEach((p, i) => {
      const q = P[(i + 1) % 4];
      const d = Math.hypot((p.x + q.x) / 2 - x, (p.y + q.y) / 2 - y);
      if (d <= reach * 0.8 && (!best || d < best.d)) best = { side: i, d };
    });
    return best;
  }

  #hover(e) {
    const c = this.cropping;
    if (!c || c.drag || e.pointerType !== 'mouse') return;
    const hit = this.#handleAt(e);
    c.hit.style.cursor = hit ? 'grab' : '';
    c.dots.forEach((d, i) => d.classList.toggle('hot', hit?.corner === i));
    c.mids.forEach((m, i) => m.classList.toggle('hot', hit?.side === i));
  }

  #dragStart(e) {
    const c = this.cropping;
    if (!c || e.button > 0) return;
    const hit = this.#handleAt(e);
    if (!hit) return;
    e.preventDefault();
    const area = c.hit;
    area.setPointerCapture(e.pointerId);
    area.style.cursor = 'grabbing';
    const { corner = null, side = null } = hit;
    const start = c.corners.map((p) => ({ ...p }));
    const sx = e.clientX, sy = e.clientY;
    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    let frame = 0, last = e;
    c.drag = true;
    (corner != null ? c.dots[corner] : c.mids[side]).classList.add('active');
    const apply = () => {
      frame = 0;
      const dx = (last.clientX - sx) / c.w, dy = (last.clientY - sy) / c.h;
      const next = start.map((p) => ({ ...p }));
      if (corner != null) next[corner] = { x: clamp01(start[corner].x + dx), y: clamp01(start[corner].y + dy) };
      else for (const k of [side, (side + 1) % 4]) next[k] = { x: clamp01(start[k].x + dx), y: clamp01(start[k].y + dy) };
      if (convex(next)) c.corners = next;             // a folded outline isn't allowed; the handle waits
      this.#drawCrop();
      if (corner != null) {
        const r = c.svg.getBoundingClientRect();
        this.#showLoupe(c.corners[corner], last.clientX - r.left, last.clientY - r.top, last.pointerType === 'touch');
      }
    };
    const move = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      last = ev;
      if (!frame) frame = requestAnimationFrame(apply);
    };
    const up = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      if (frame) { cancelAnimationFrame(frame); apply(); }
      c.drag = false;
      area.style.cursor = '';
      c.loupe.hidden = true;
      c.svg.querySelectorAll('.active').forEach((x) => x.classList.remove('active'));
      area.removeEventListener('pointermove', move);
      area.removeEventListener('pointerup', up);
      area.removeEventListener('pointercancel', up);
      try { area.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    };
    area.addEventListener('pointermove', move);
    area.addEventListener('pointerup', up);
    area.addEventListener('pointercancel', up);
  }

  /** A magnifier near the finger or pointer, so the corner can be placed exactly. */
  #showLoupe(at, px, py, touch = false) {
    const c = this.cropping, L = c.loupe, zoom = 3, size = 132;
    if (L.hidden) { L.hidden = false; L.style.backgroundImage = `url("${c.img.src}")`; }
    L.style.backgroundSize = `${c.w * zoom}px ${c.h * zoom}px`;
    L.style.backgroundPosition = `${size / 2 - at.x * c.w * zoom}px ${size / 2 - at.y * c.h * zoom}px`;
    // keep it clear of the corner being moved (and above a finger, which would hide it)
    let left = px > c.w / 2 ? px - size - 30 : px + 30, top = py > c.h / 2 ? py - size - 30 : py + 30;
    if (touch) { left = px - size / 2; top = py - size - 60; if (top < -20) top = py + 60; }
    L.style.left = `${Math.max(-20, Math.min(c.w - size + 20, left))}px`;
    L.style.top = `${Math.max(-20, Math.min(c.h - size + 20, top))}px`;
  }

  #cropSet(corners) { if (!this.cropping) return; this.cropping.corners = corners.map((p) => ({ ...p })); this.#drawCrop(); }

  async #cropAuto() {
    const c = this.cropping;
    if (!c) return;
    const r = await this.heavy.queue('prepare', { key: c.page.id, blob: c.page.source });
    if (!this.cropping) return;
    if (r.found) { this.#cropSet(r.corners); c.found = { corners: r.corners, edges: r.edges }; }
    else this.ui.toast('No clear page edges found. Drag the corners instead.');
  }

  #endCrop(apply) {
    const c = this.cropping;
    if (!c) return;
    this.cropping = null;
    this.$viewTools.hidden = false;
    this.$cropTools.hidden = true;
    if (apply && !sameOutline(c.corners, c.page.corners, 0.0005)) {
      c.page.corners = c.corners;
      c.page.found = true;
      // the traced (curved) sides belong to the outline that was found; a hand-set outline has straight sides
      c.page.edges = c.found && sameOutline(c.corners, c.found.corners, 0.0005) ? c.found.edges : null;
      this.#renderPreview(c.page);
      this.#loadFilterPreviews(c.page);
    }
    this.#showResult(c.page);
  }

  // ================================================================ photos
  async pickPhotos() {
    const files = await this.ctx.host.pickImages({ multi: true });
    if (!files?.length) return false;
    await this.addFiles(files.map((f) => new File([f.data], f.name, { type: f.type || '' })));
    return true;
  }

  /** Add photos (File objects): dropped, picked, or passed in when opening. */
  async addFiles(files) {
    let heic = files.filter((f) => HEIC.test(f.name));
    const readable = [];
    for (const f of heic) if (await decodes(f)) readable.push(f);   // Safari reads HEIC itself
    heic = heic.filter((f) => !readable.includes(f));
    const images = [...files.filter((f) => !HEIC.test(f.name) && (IMAGE_TYPES.test(f.type) || IMAGE_EXT.test(f.name))), ...readable];
    if (heic.length) {
      this.ui.alert('iPhone photos (HEIC)', `${plural(heic.length, 'photo is', 'photos are')} in Apple’s HEIC format, which Folio can’t read. On the iPhone, set Settings › Photos › Transfer to Mac or PC › Automatic and copy them again (they arrive as JPEG), or share them as JPEG.`);
    }
    if (!images.length) {
      if (!heic.length) this.ui.toast('Those files aren’t photos. Use JPEG, PNG, WebP, BMP or GIF.', { type: 'error' });
      return;
    }
    const first = this.pages.length;
    for (const f of images) this.pages.push(this.#newPage(f, f.name));
    if (this.mode !== 'pages') await this.#show('pages');
    this.#renderStrip();
    this.#updateCounts();
    this.#select(first);
    for (const p of this.pages.slice(first)) this.#prepare(p);
    this.ui.toast(`${plural(images.length, 'photo')} added`);
  }

  // ================================================================ save
  async save() {
    if (!this.pages.length || this.busy) return;
    if (this.cropping) this.#endCrop(true);
    const failed = this.pages.filter((p) => p.status === 'failed');
    if (failed.length) { this.ui.alert('Some photos couldn’t be read', `Delete ${plural(failed.length, 'page')} marked “!” first.`); return; }
    const add = this.canAdd && this.$destAdd?.checked;
    const reader = this.ctx.reader;
    let filePath = null;
    if (!add) {
      filePath = await this.ctx.host.showSaveDialog({ defaultPath: `Scan ${stamp()}.pdf`, title: 'Save the scan as a PDF' });
      if (!filePath) return;
    } else if (!reader.hasDocument) {
      this.ui.alert('The PDF was closed', 'Choose “A new PDF” instead.');
      return;
    }
    this.busy = true;
    const q = QUALITY[this.prefs.quality] || QUALITY.balanced;
    const ocr = this.prefs.ocr;
    const n = this.pages.length;
    const steps = n * (ocr ? 2 : 1) + 1;
    const prog = this.ui.progress(add ? 'Adding the scanned pages' : 'Saving the scan');
    let done = 0;
    const step = (label) => prog.update(done++ / steps, label);
    try {
      // wait for pages still being prepared
      while (this.pages.some((p) => p.status === 'preparing')) {
        step('Finishing the pages…'); done--;
        await new Promise((r) => setTimeout(r, 200));
        if (prog.cancelled) return;
      }
      const out = [];
      for (const [i, p] of this.pages.entries()) {
        step(`Preparing page ${i + 1} of ${n}`);
        const r = await this.heavy.queue('render', { ...this.#shape(p), rotation: p.rotation, filter: p.filter, maxSide: q.maxSide, quality: q.q });
        out.push({ blob: r.blob, width: r.width, height: r.height });
        if (prog.cancelled) return;
      }
      let readable = 0, turnedUp = 0;
      if (ocr) {
        for (const [i, r] of out.entries()) {
          step(`Reading the text on page ${i + 1} of ${n}`);
          try {
            // read from a large, clean grayscale copy of the page (about 300 dpi): fewer mistakes
            const p = this.pages[i];
            const big = await this.heavy.queue('render', { ...this.#shape(p), rotation: p.rotation, filter: 'gray', maxSide: 3300, minSide: 2800, quality: 0.9, sharpen: false });
            const ocrResult = await recognize(big.blob, big);
            if (ocrResult.turn) {
              // photographed sideways or upside down: save the page the right way up
              p.rotation = (p.rotation + ocrResult.turn) % 4;
              const upright = await this.heavy.queue('render', { ...this.#shape(p), rotation: p.rotation, filter: p.filter, maxSide: q.maxSide, quality: q.q });
              Object.assign(r, { blob: upright.blob, width: upright.width, height: upright.height });
              const odd = ocrResult.turn % 2;
              r.ocr = { width: odd ? big.height : big.width, height: odd ? big.width : big.height, turn: 0, lines: ocrResult.lines };
              turnedUp++;
            } else {
              r.ocr = ocrResult;
            }
            if (r.ocr.lines.length) readable++;
          } catch (err) {
            console.warn('Text recognition failed on page', i + 1, err);
          }
          if (prog.cancelled) return;
        }
      }
      step('Making the PDF');
      const { pdfLib } = this.ctx.lib;
      if (add) {
        const where = this.$where.value;
        const at = where === 'start' ? 0 : where === 'end' ? reader.pageCount : reader.pageNumber;
        await this.ctx.use('pages').editDocument(async (pdf) => {
          await addScannedPages(pdfLib, pdf, out, { size: this.prefs.size, at });
          return { page: at + 1 };
        });
        prog.close();
        this.busy = false;
        this.close(true);
        this.ctx.ui.toast(`${plural(n, 'scanned page')} added${where === 'start' ? ' at the start' : where === 'end' ? ' at the end' : ` after page ${at}`}${turnedUp ? ` (${turnedUp} turned upright)` : ''}. Save to keep them.`, { timeout: 5000 });
        return;
      }
      const title = filePath.split(/[\\/]/).pop().replace(/\.pdf$/i, '');
      const bytes = await buildPdf(pdfLib, out, { size: this.prefs.size, title });
      await this.ctx.host.writeFile(filePath, bytes);
      prog.close();
      this.busy = false;
      this.close(true);
      await this.ctx.use('files').openPath(filePath);
      const searchable = ocr ? (readable ? ' · text searchable' : ' · no text found to make searchable') : '';
      const upright = turnedUp ? ` · ${plural(turnedUp, 'page')} turned upright` : '';
      this.ctx.ui.toast(`Saved ${title}.pdf · ${plural(n, 'page')} · ${mb(bytes.byteLength)}${searchable}${upright}`, { timeout: 5000 });
    } catch (err) {
      prog.close();
      this.ctx.showError(add ? 'Couldn’t add the pages' : 'Couldn’t save the scan', err);
    } finally {
      if (this.busy) { this.busy = false; prog.close(); }
    }
  }

  // ================================================================ keys
  #key(e) {
    const typing = e.target.closest?.('input, select, textarea');
    const k = e.key;
    let handled = true;
    if (k === 'Escape') {
      if (document.querySelector('.modal-backdrop, .ctx-menu')) { handled = false; } else if (this.cropping) this.#endCrop(false); else this.close();
    } else if (this.mode === 'camera' && (k === ' ' || k === 'Enter') && !typing && !e.target.closest?.('button:not(.sc-shutter)')) {
      e.preventDefault(); this.capture();
    } else if (this.mode === 'pages' && !typing && !this.cropping) {
      if (k === 'ArrowDown' || k === 'ArrowRight' || k === 'PageDown') this.#select(this.sel + 1);
      else if (k === 'ArrowUp' || k === 'ArrowLeft' || k === 'PageUp') this.#select(this.sel - 1);
      else if (k === 'Delete') this.#deletePage();
      else if (k.toLowerCase() === 'r' && !e.ctrlKey) this.#turn(e.shiftKey ? -1 : 1);
      else if (k.toLowerCase() === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.save(); } else handled = false;
    } else if (this.cropping && k === 'Enter') {
      this.#endCrop(true);
    } else handled = false;
    // keep the app's own shortcuts (open, zoom, page keys) away while scanning
    if (!e.ctrlKey || handled || !['c', 'v', 'x', 'a', 'z'].includes(k.toLowerCase())) e.stopPropagation();
  }
}

/** A tiny grayscale thumbnail of a frame, to notice when a new page is put down. */
function signature(img) {
  const { width: w, height: h, data } = img, out = new Float32Array(192);
  for (let y = 0; y < 12; y++) for (let x = 0; x < 16; x++) {
    const i = (Math.floor(((y + 0.5) / 12) * h) * w + Math.floor(((x + 0.5) / 16) * w)) * 4;
    out[y * 16 + x] = (data[i] + data[i + 1] + data[i + 2]) / 3;
  }
  return out;
}

/** Can this browser read the picture (e.g. HEIC on an iPhone)? */
async function decodes(file) {
  try { const b = await createImageBitmap(file); b.close?.(); return true; } catch { return false; }
}

function convex(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cr) < 1e-6) return false;
    if (sign && Math.sign(cr) !== sign) return false;
    sign = Math.sign(cr);
  }
  return true;
}

function cameraMessage(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'The camera was blocked. On iPhone open Settings › Apps › Safari › Camera (on older iOS: Settings › Safari › Camera), choose Ask or Allow, then try again.';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'Another app is using the camera (for example Teams or Zoom). Close it, then try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
    case 'DevicesNotFoundError':
      return 'No camera was found on this device.';
    default:
      return err?.message || 'The camera couldn’t be started.';
  }
}
