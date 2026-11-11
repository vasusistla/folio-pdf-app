/**
 * Fill & Sign: fill in any PDF, including flat forms and contracts that have no form fields.
 *
 *   - Blanks (lines, underscores, boxes, table cells, checkboxes, signature fields) are found
 *     automatically and lightly highlighted. Click one to fill it; Tab jumps to the next.
 *   - Click anywhere else to add text, a ✓ / ✕ / ●, today's date, your signature or initials.
 *   - Everything can be moved, resized, deleted and undone.
 *   - On Save (and Print) the fill-ins are written into the page itself (see flatten.js).
 *
 * Items live in "base display space": PDF points, top-left origin, with the page's own rotation.
 */
import { detectBlanks, rowY } from './detect.js';
import { openAdoptDialog } from './signature.js';
import { flattenItems, MARKS, LINE_HEIGHT, BASELINE } from './flatten.js';

const TOOLS = [
  { id: 'text', label: 'Text', icon: 'text', menu: 'Add Text', hint: 'Click a blank (or anywhere) and type. Tab goes to the next blank.' },
  { id: 'check', label: '✓', icon: 'check', menu: 'Add Checkmark', title: 'Checkmark', hint: 'Click a box to tick it; click again to clear.' },
  { id: 'cross', label: '✕', icon: 'cross', menu: 'Add Cross', title: 'Cross', hint: 'Click a box (or anywhere) for a cross.' },
  { id: 'dot', label: '●', icon: 'dot', menu: 'Add Dot', title: 'Dot', hint: 'Click a box (or anywhere) for a dot.' },
  { id: 'date', label: 'Date', icon: 'calendar', menu: 'Add Date', hint: "Click where today's date should go." },
  { id: 'signature', label: 'Sign', icon: 'signature', menu: 'Add Signature', hint: 'Click a yellow signature line, or anywhere, to sign.' },
  { id: 'initials', label: 'Initials', icon: 'initials', menu: 'Add Initials', hint: 'Click where your initials go.' },
];
const MARK_TOOLS = new Set(['check', 'cross', 'dot']);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const uid = () => `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const pct = (v, total) => `${(v / total) * 100}%`;

export default {
  id: 'fill-sign',
  activate(ctx) {
    const { reader, commands, ui, h } = ctx;
    const { AnnotationEditorType: T } = ctx.lib.pdfjs;

    const prefs = Object.assign({ size: 11, markSize: 11, color: '#000000', showBlanks: true, dateFormat: 'short' }, ctx.settings.fill || {});
    const savePrefs = () => ctx.saveSettings({ fill: { ...prefs } });
    let signer = ctx.settings.signer || null; // remembered on this device
    let sessionSigner = null;                 // adopted with "Remember" unticked
    const currentSigner = () => sessionSigner || signer;

    const S = {
      active: false, tool: 'text', items: [], images: new Map(), selected: null,
      blankJobs: new Map(), blankResults: new Map(), pendingFocus: null, flattened: null,
    };
    const hist = { past: [], future: [], last: '[]', saved: '[]', at: 0 };
    const find = (id) => S.items.find((i) => i.id === id);

    // ================================================================ history & dirty state
    function snapshot() {
      const cur = JSON.stringify(S.items);
      if (cur === hist.last) return;
      hist.past.push(hist.last);
      if (hist.past.length > 200) hist.past.shift();
      hist.last = cur;
      hist.future = [];
      hist.at = Date.now();
      changed();
    }
    function restore(json) {
      S.items = JSON.parse(json);
      S.selected = null;
      renderAll();
      changed();
    }
    function undo() { if (!hist.past.length) return; hist.future.push(hist.last); hist.last = hist.past.pop(); restore(hist.last); }
    function redo() { if (!hist.future.length) return; hist.past.push(hist.last); hist.last = hist.future.pop(); restore(hist.last); }
    function changed() {
      reader.setFeatureDirty('fill-sign', hist.last !== hist.saved);
      ctx.use('history')?.changed();
      commands.refresh();
    }
    ctx.use('history')?.register({
      id: 'fill-sign', canUndo: () => hist.past.length > 0, canRedo: () => hist.future.length > 0,
      undo, redo, lastChange: () => hist.at,
    });
    function resetAll() {
      S.items = []; S.selected = null; S.blankJobs.clear(); S.blankResults.clear(); S.flattened = null;
      hist.past = []; hist.future = []; hist.last = hist.saved = '[]';
      reader.setFeatureDirty('fill-sign', false);
    }

    // ================================================================ blanks
    function ensureBlanks(n) {
      if (!S.blankJobs.has(n)) {
        const doc = reader.doc;
        const job = doc.getPage(n)
          .then((p) => detectBlanks(p, ctx.lib.pdfjs))
          .then((res) => { if (reader.doc === doc) S.blankResults.set(n, res); return res; })
          .catch((err) => { console.warn('Blank detection failed on page', n, err); return { blanks: [] }; });
        S.blankJobs.set(n, job);
      }
      return S.blankJobs.get(n);
    }
    const blankKey = (n, b) => `${n}:${b.id}`;
    function occupied(n, b) {
      const key = blankKey(n, b);
      return S.items.some((it) => it.page === n && (it.blankKey === key || (b.type === 'check' && it.type === 'mark' && it.x + it.w / 2 > b.x0 && it.x + it.w / 2 < b.x1 && it.y + it.h / 2 > b.y0 && it.y + it.h / 2 < b.y1)));
    }

    // ================================================================ page layers
    const pageView = (n) => reader.pdfViewer.getPageView(n - 1);
    function layerFor(n) {
      const pv = pageView(n);
      if (!pv?.div || !pv.pdfPage) return null;
      const vp = pv.pdfPage.getViewport({ scale: 1, rotation: pv.pdfPage.rotate });
      let layer = pv.div.querySelector(':scope > .fs-layer');
      if (!layer) {
        layer = h('div', { class: 'fs-layer', 'data-page': n });
        pv.div.append(layer);
      }
      layer.style.width = `calc(var(--total-scale-factor) * ${vp.width}px)`;
      layer.style.height = `calc(var(--total-scale-factor) * ${vp.height}px)`;
      layer.dataset.rotation = String(reader.rotation || 0);
      layer._dims = { W: vp.width, H: vp.height };
      return layer;
    }

    /** Screen point → base display space of that page (handles zoom and view rotation). */
    function toBase(layer, cx, cy) {
      const { W, H } = layer._dims;
      const rot = Number(layer.dataset.rotation) || 0;
      const r = layer.parentElement.getBoundingClientRect();
      const s = r.width / (rot % 180 ? H : W);
      const X = (cx - r.left) / s, Y = (cy - r.top) / s;
      switch (rot) {
        case 90: return [Y, H - X];
        case 180: return [W - X, H - Y];
        case 270: return [W - Y, X];
        default: return [X, Y];
      }
    }

    function renderAll() {
      if (!reader.hasDocument) return;
      for (let n = 1; n <= reader.pageCount; n++) if (pageView(n)?.pdfPage) render(n);
    }

    function render(n) {
      const layer = layerFor(n);
      if (!layer) return;
      const { W, H } = layer._dims;

      // highlighted blanks (only while Fill & Sign is on)
      let hints = layer.querySelector(':scope > .fs-hints');
      if (!hints) { hints = h('div', { class: 'fs-hints' }); layer.prepend(hints); }
      hints.replaceChildren();
      if (S.active && prefs.showBlanks) {
        const res = S.blankResults.get(n);
        if (res) for (const b of res.blanks) { if (!occupied(n, b)) hints.append(hintEl(n, b, W, H)); }
        else ensureBlanks(n).then(() => { if (S.active) render(n); });
      }

      // items
      const existing = new Map([...layer.querySelectorAll(':scope > .fs-item')].map((el) => [el.dataset.id, el]));
      for (const it of S.items) {
        if (it.page !== n) continue;
        let el = existing.get(it.id);
        existing.delete(it.id);
        if (!el) { el = itemEl(it); layer.append(el); }
        updateItemEl(el, it, W, H);
      }
      for (const el of existing.values()) el.remove();

      if (S.pendingFocus) {
        const el = layer.querySelector(`.fs-item[data-id="${S.pendingFocus.id}"]`);
        if (el) {
          const { selectAll } = S.pendingFocus;
          S.pendingFocus = null;
          el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          focusText(el, selectAll);
          const it = find(el.dataset.id);
          if (it) fitText(it, el);
        }
      }
    }

    function hintEl(n, b, W, H) {
      const r = b.type === 'line' ? { x0: b.x0, x1: b.x1, y0: b.y - LINE_HEIGHT * b.size - 1, y1: b.y + 1.5 } : b;
      const sign = b.kind === 'signature' || b.kind === 'initials';
      const title = sign ? (b.kind === 'signature' ? 'Click to sign here' : 'Click to add your initials')
        : b.type === 'check' ? 'Click to tick' : b.kind === 'date' ? "Click to add today's date" : 'Click to type here';
      const el = h('button', {
        type: 'button', class: `fs-hint ${b.type}${sign ? ' sign' : ''}`, title, 'aria-label': title,
        style: { left: pct(r.x0, W), top: pct(r.y0, H), width: pct(r.x1 - r.x0, W), height: pct(r.y1 - r.y0, H) },
        onClick: (e) => { e.stopPropagation(); fillBlank(n, b); },
      });
      if (sign) el.append(h('span', { class: 'fs-hint-tag', text: b.kind === 'signature' ? 'Sign' : 'Initial' }));
      return el;
    }

    function markSvg(mark) {
      if (mark === 'dot') return '<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><circle cx="50" cy="50" r="28" fill="currentColor"/></svg>';
      const lines = (MARKS[mark] || []).map((poly) => `<polyline points="${poly.map(([x, y]) => `${x * 100},${y * 100}`).join(' ')}"/>`).join('');
      return `<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="12" stroke-linecap="round" stroke-linejoin="round">${lines}</svg>`;
    }

    function itemEl(it) {
      const el = h('div', { class: `fs-item fs-${it.type}`, 'data-id': it.id, 'data-type': it.type });
      if (it.type === 'text') {
        const edit = h('span', { class: 'fs-text-edit', contenteditable: 'plaintext-only', spellcheck: 'false', role: 'textbox', 'aria-label': 'Filled-in text' });
        edit.textContent = it.text;
        el.append(h('span', { class: 'fs-grip', title: 'Drag to move' }), edit);
      } else if (it.type === 'mark') {
        el.innerHTML = markSvg(it.mark);
        el.append(h('span', { class: 'fs-resize', title: 'Drag to resize' }));
      } else if (it.type === 'image') {
        el.append(h('img', { src: S.images.get(it.imageId), alt: it.kind === 'initials' ? 'Initials' : 'Signature', draggable: 'false' }));
        el.append(h('span', { class: 'fs-resize', title: 'Drag to resize' }));
      }
      el.append(h('button', { type: 'button', class: 'fs-del', title: 'Remove', 'aria-label': 'Remove', html: ctx.icon('close', { size: 11 }) }));
      return el;
    }

    function updateItemEl(el, it, W, H) {
      el.style.left = pct(it.x, W);
      el.style.top = pct(it.y, H);
      if (it.type === 'text') {
        el.style.fontSize = `calc(var(--total-scale-factor) * ${it.size}px)`;
        el.style.color = it.color;
        const edit = el.querySelector('.fs-text-edit');
        if (document.activeElement !== edit && edit.textContent !== it.text) edit.textContent = it.text;
      } else {
        el.style.width = pct(it.w, W);
        el.style.height = pct(it.h, H);
        el.style.color = it.color || '#000';
      }
      el.classList.toggle('selected', S.selected === it.id);
    }

    function itemElement(id) { return reader.container.querySelector(`.fs-item[data-id="${id}"]`); }

    // ================================================================ selection & editing
    function select(id) {
      S.selected = id;
      reader.container.querySelectorAll('.fs-item.selected').forEach((el) => el.classList.remove('selected'));
      if (id) itemElement(id)?.classList.add('selected');
      syncOptions();
      commands.refresh();
    }

    function focusText(el, selectAll = false) {
      const edit = el.querySelector('.fs-text-edit');
      if (!edit) return;
      edit.focus({ preventScroll: true });
      const range = document.createRange();
      range.selectNodeContents(edit);
      if (!selectAll) range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }

    function removeItem(id) {
      const it = find(id);
      if (!it) return;
      S.items = S.items.filter((i) => i.id !== id);
      if (S.selected === id) S.selected = null;
      render(it.page);
      snapshot();
      syncOptions();
    }

    function addItem(item, { focus = false, selectAll = false } = {}) {
      S.items.push(item);
      if (item.type === 'text' && focus) S.pendingFocus = { id: item.id, selectAll };
      S.selected = item.id;
      render(item.page);
      if (item.type !== 'text' || item.text) snapshot();
      syncOptions();
      return item;
    }

    // text editing (delegated)
    reader.container.addEventListener('input', (e) => {
      const edit = e.target.closest?.('.fs-text-edit');
      if (!edit) return;
      const it = find(edit.parentElement.dataset.id);
      if (it) { it.text = edit.textContent; fitText(it, edit.parentElement); }
    });
    reader.container.addEventListener('focusin', (e) => {
      const edit = e.target.closest?.('.fs-text-edit');
      if (edit) select(edit.parentElement.dataset.id);
    });
    reader.container.addEventListener('focusout', (e) => {
      const edit = e.target.closest?.('.fs-text-edit');
      if (!edit) return;
      const it = find(edit.parentElement.dataset.id);
      if (!it) return;
      it.text = edit.textContent.replace(/\n+$/, '');
      if (!it.text.trim()) {
        S.items = S.items.filter((i) => i !== it);
        if (S.selected === it.id) S.selected = null;
        render(it.page);
      }
      snapshot();
    });
    reader.container.addEventListener('keydown', (e) => {
      const edit = e.target.closest?.('.fs-text-edit');
      if (!edit) return;
      const it = find(edit.parentElement.dataset.id);
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); edit.blur(); select(null); }
      else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); document.execCommand('insertText', false, '\n'); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); edit.blur(); select(null); }
      else if (e.key === 'Tab') { e.preventDefault(); if (it) nextBlank(it, e.shiftKey); }
    });

    // move / resize / delete (delegated)
    reader.container.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const del = e.target.closest('.fs-del');
      if (del) { e.preventDefault(); e.stopPropagation(); removeItem(del.closest('.fs-item').dataset.id); return; }
      const el = e.target.closest('.fs-item');
      if (!el) return;
      const it = find(el.dataset.id);
      if (!it) return;
      const edit = e.target.closest('.fs-text-edit');
      if (edit && document.activeElement === edit) return; // let the caret move
      e.preventDefault();
      e.stopPropagation();
      if (document.activeElement?.classList?.contains('fs-text-edit')) document.activeElement.blur();
      select(it.id);
      const layer = el.parentElement;
      const { W, H } = layer._dims;
      const resize = !!e.target.closest('.fs-resize');
      const start = toBase(layer, e.clientX, e.clientY);
      const sx = e.clientX, sy = e.clientY;
      const orig = { x: it.x, y: it.y, w: it.w, h: it.h };
      let moved = false;
      const move = (ev) => {
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
        moved = true;
        const p = toBase(layer, ev.clientX, ev.clientY);
        const dx = p[0] - start[0], dy = p[1] - start[1];
        if (resize) {
          const w = clamp(orig.w + dx, 6, W - it.x);
          it.w = w;
          it.h = w * (orig.h / orig.w);
        } else {
          const iw = it.w || el.offsetWidth / (layer.getBoundingClientRect().width / W) || 20;
          it.x = clamp(orig.x + dx, -2, W - Math.min(iw, W) + 2);
          it.y = clamp(orig.y + dy, -2, H - 6);
        }
        updateItemEl(el, it, W, H);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (moved) { reanchor(it); snapshot(); render(it.page); } else if (it.type === 'text') focusText(el);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    // keyboard for a selected (not being typed in) item
    document.addEventListener('keydown', (e) => {
      if (!S.selected || e.defaultPrevented) return;
      const t = document.activeElement;
      if (t && (t.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(t.tagName))) return;
      if (document.querySelector('.modal-backdrop')) return;
      const it = find(S.selected);
      if (!it) return;
      const step = e.shiftKey ? 10 : 1;
      const nudge = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeItem(it.id); }
      else if (nudge) { e.preventDefault(); it.x += nudge[0]; it.y += nudge[1]; reanchor(it); render(it.page); snapshot(); }
      else if (e.key === 'Escape') { e.preventDefault(); select(null); }
    });

    // click on the page (Fill & Sign on) → add something there
    reader.container.addEventListener('click', (e) => {
      if (!S.active || !reader.hasDocument) return;
      if (e.target.closest('.fs-item, .fs-hint, .annotationLayer a, .annotationLayer input, .annotationLayer textarea, .annotationLayer select, .annotationLayer button')) return;
      const pageEl = e.target.closest('.page');
      if (!pageEl) return;
      if (S.selected) { select(null); return; } // first click just finishes the current item
      const n = Number(pageEl.dataset.pageNumber);
      const layer = layerFor(n);
      if (!layer) return;
      createAt(n, ...toBase(layer, e.clientX, e.clientY));
    });

    // ================================================================ creating things
    function today() {
      const d = new Date();
      if (prefs.dateFormat === 'long') return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
      if (prefs.dateFormat === 'iso') return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return d.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' });
    }

    function textItem(n, x, y, size, text = '', extra = {}) {
      return { id: uid(), page: n, type: 'text', x, y, size, color: prefs.color, text, ...extra };
    }

    function createAt(n, x, y) {
      const tool = S.tool;
      if (tool === 'text' || tool === 'date') {
        const size = prefs.size;
        const text = tool === 'date' ? today() : '';
        addItem(textItem(n, x, y - (LINE_HEIGHT * size) / 2, size, text), { focus: true, selectAll: !!text });
      } else if (MARK_TOOLS.has(tool)) {
        const s = prefs.markSize;
        addItem({ id: uid(), page: n, type: 'mark', mark: tool, x: x - s / 2, y: y - s / 2, w: s, h: s, color: prefs.color });
      } else if (tool === 'signature' || tool === 'initials') {
        placeSignature(n, { point: [x, y] }, tool);
      }
    }

    function fillBlank(n, b) {
      if (b.type === 'check') {
        const existing = S.items.find((it) => it.page === n && it.type === 'mark' && it.x + it.w / 2 > b.x0 && it.x + it.w / 2 < b.x1 && it.y + it.h / 2 > b.y0 && it.y + it.h / 2 < b.y1);
        if (existing) { removeItem(existing.id); return; }
        const mark = MARK_TOOLS.has(S.tool) ? S.tool : 'check';
        const s = Math.min(b.x1 - b.x0, b.y1 - b.y0) * 0.9;
        addItem({ id: uid(), page: n, type: 'mark', mark, x: (b.x0 + b.x1) / 2 - s / 2, y: (b.y0 + b.y1) / 2 - s / 2, w: s, h: s, color: prefs.color, blankKey: blankKey(n, b) });
        return;
      }
      if (b.kind === 'signature' || b.kind === 'initials') { placeSignature(n, { blank: b }, b.kind); return; }
      const item = textForBlank(n, b);
      addItem(item, { focus: true, selectAll: !!item.text });
    }

    function textForBlank(n, b) {
      // a touch smaller than the printed text around the blank reads naturally
      const size = clamp(Math.round((b.size || prefs.size) * 0.92 * 2) / 2, 7, 14);
      const text = b.kind === 'date' ? today() : '';
      if (b.type === 'line') {
        const baseline = b.y - 2;
        return textItem(n, b.x0 + 2, baseline - BASELINE * size, size, text, {
          blankKey: blankKey(n, b), fit: { width: b.x1 - b.x0 - 3, baseline, max: size },
        });
      }
      const bh = b.y1 - b.y0;
      const multiLine = bh > LINE_HEIGHT * size * 2.2;
      const y = multiLine ? b.y0 + 3 : b.y0 + (bh - LINE_HEIGHT * size) / 2;
      return textItem(n, b.x0 + 3, y, size, text, {
        blankKey: blankKey(n, b), fit: { width: b.x1 - b.x0 - 6, max: size, ...(multiLine ? {} : { center: (b.y0 + b.y1) / 2 }) },
      });
    }

    /** After a manual move, keep shrink-to-fit anchored to where the text now is. */
    function reanchor(it) {
      if (!it.fit) return;
      if (it.fit.baseline !== undefined) it.fit.baseline = it.y + BASELINE * it.size;
      if (it.fit.center !== undefined) it.fit.center = it.y + (LINE_HEIGHT * it.size) / 2;
    }

    /** Shrink (or grow back) a blank's text so it stays inside the blank. */
    function fitText(it, el = itemElement(it.id)) {
      if (!it.fit || !el?.parentElement?._dims) return;
      const layer = el.parentElement;
      const edit = el.querySelector('.fs-text-edit');
      if (!edit || !layer.offsetWidth) return;
      const ptPerPx = layer._dims.W / layer.offsetWidth;
      const natural = edit.scrollWidth * ptPerPx * (it.fit.max / it.size);
      const size = clamp(Math.floor(Math.min(it.fit.max, (it.fit.max * it.fit.width) / Math.max(natural, 1)) * 4) / 4, 6, it.fit.max);
      if (Math.abs(size - it.size) < 0.01) return;
      it.size = size;
      if (it.fit.baseline !== undefined) it.y = it.fit.baseline - BASELINE * size;
      else if (it.fit.center !== undefined) it.y = it.fit.center - (LINE_HEIGHT * size) / 2;
      updateItemEl(el, it, layer._dims.W, layer._dims.H);
      syncOptions();
    }

    /** Tab / Shift+Tab from a text item: go to the next empty line or box. */
    async function nextBlank(from, back) {
      const fromRow = from.y + LINE_HEIGHT * from.size;
      const edit = itemElement(from.id)?.querySelector('.fs-text-edit');
      const pages = [];
      for (let k = 0; k < 12; k++) {
        const n = back ? from.page - k : from.page + k;
        if (n < 1 || n > reader.pageCount) break;
        pages.push(n);
      }
      for (const n of pages) {
        const { blanks } = await ensureBlanks(n);
        const list = blanks.filter((b) => (b.type === 'line' || b.type === 'box') && b.kind !== 'signature' && b.kind !== 'initials' && !occupied(n, b) && b.id !== from.blankKey?.split(':')[1]);
        const ordered = back ? [...list].reverse() : list;
        const after = (b) => {
          if (n !== from.page) return true;
          const r = rowY(b);
          const sameRow = Math.abs(r - fromRow) < Math.max(4, from.size * 0.6);
          if (back) return sameRow ? b.x0 < from.x - 1 : r < fromRow;
          return sameRow ? b.x0 > from.x + 1 : r > fromRow;
        };
        const target = ordered.find(after);
        if (target) {
          edit?.blur();
          if (n !== reader.pageNumber && !pageView(n)?.pdfPage) reader.goToPage(n);
          fillBlank(n, target);
          return;
        }
      }
      edit?.blur();
      select(null);
      ui.toast(back ? 'No earlier blanks' : 'No more blanks. Everything is filled in.');
    }

    // ================================================================ signatures
    async function adopt(kind) {
      const prev = currentSigner() || {};
      const res = await openAdoptDialog(ctx, { kind, name: prev.name || '', initials: prev.initials || '', ink: prev.ink || 'black', style: prev.style || 'dancing' });
      if (!res) return null;
      const mark = { dataUrl: res.dataUrl, width: res.width, height: res.height, method: res.method, at: Date.now() };
      const next = { ...prev, name: res.name, initials: res.initials, ink: res.ink, style: res.style, [kind === 'initials' ? 'initialsMark' : 'signature']: mark };
      if (res.remember) { signer = next; sessionSigner = null; await ctx.saveSettings({ signer: next }); }
      else sessionSigner = next;
      syncOptions();
      commands.refresh();
      return mark;
    }
    const savedMark = (kind) => currentSigner()?.[kind === 'initials' ? 'initialsMark' : 'signature'] || null;

    function imageIdFor(mark, kind) {
      const id = `${kind}-${mark.at}`;
      if (!S.images.has(id)) S.images.set(id, mark.dataUrl);
      return id;
    }

    async function placeSignature(n, where, kind) {
      const mark = savedMark(kind) || await adopt(kind);
      if (!mark) return;
      const aspect = mark.width / mark.height;
      let w, hh, x, y;
      if (where.blank) {
        const b = where.blank;
        if (b.type === 'line') {
          hh = kind === 'initials' ? clamp(b.size * 2.4, 16, 32) : clamp(b.size * 3.2, 22, 46);
          w = hh * aspect;
          const maxW = b.x1 - b.x0 - 4;
          if (w > maxW) { w = maxW; hh = w / aspect; }
          x = b.x0 + 4;
          y = b.y - hh * 0.82; // signatures sit on the line and dip slightly below it
        } else {
          const bw = (b.x1 - b.x0) * 0.86, bh = (b.y1 - b.y0) * 0.86;
          if (bw / bh > aspect) { hh = bh; w = hh * aspect; } else { w = bw; hh = w / aspect; }
          x = b.x0 + (b.x1 - b.x0 - w) / 2;
          y = b.y0 + (b.y1 - b.y0 - hh) / 2;
        }
      } else {
        hh = kind === 'initials' ? 24 : 36;
        w = hh * aspect;
        if (w > 220) { w = 220; hh = w / aspect; }
        x = where.point[0] - w / 2;
        y = where.point[1] - hh / 2;
      }
      addItem({ id: uid(), page: n, type: 'image', kind, imageId: imageIdFor(mark, kind), x, y, w, h: hh, blankKey: where.blank ? blankKey(n, where.blank) : undefined });
    }

    async function chooseTool(id) {
      if ((id === 'signature' || id === 'initials') && !savedMark(id)) {
        if (!(await adopt(id))) return;
      }
      S.tool = id;
      document.body.dataset.fillTool = id;
      if (!S.active) setActive(true); else syncOptions();
    }

    // ================================================================ mode & options bar
    function setActive(on) {
      if (on && !reader.hasDocument) return;
      if (on === S.active) return;
      S.active = on;
      if (on && reader.editorMode !== T.NONE) reader.setEditorMode(T.NONE);
      document.body.classList.toggle('fill-mode', on);
      document.body.dataset.fillTool = S.tool;
      if (!on) {
        if (document.activeElement?.classList?.contains('fs-text-edit')) document.activeElement.blur();
        select(null);
      }
      ui.setToolOptions(on ? optionsBar() : null, 'fill-sign');
      renderAll();
      commands.refresh();
      if (on && !ctx.settings.fillTipShown) {
        ctx.saveSettings({ fillTipShown: true });
        ui.toast('Blanks are highlighted in blue. Click one to fill it; signature lines are yellow.', { timeout: 6500 });
      }
    }

    let optionsEl = null;
    function optionsBar() {
      const toolBtn = (t) => h('button', {
        type: 'button', class: 'fs-tool', 'data-tool': t.id, title: t.title || t.menu, 'aria-label': t.title || t.menu,
        html: `${ctx.icon(t.icon, { size: 16 })}${['check', 'cross', 'dot'].includes(t.id) ? '' : `<span>${t.label}</span>`}`,
        onClick: () => chooseTool(t.id),
      });
      const sizeLabel = h('span', { class: 'fs-size-label' });
      const sizeBtn = (delta, label) => h('button', { type: 'button', class: 'fs-step', title: delta > 0 ? 'Bigger' : 'Smaller', text: label, onClick: () => changeSize(delta) });
      const swatch = (c, name) => h('button', { type: 'button', class: 'swatch', 'data-color': c, title: name, 'aria-label': name, style: { background: c }, onClick: () => changeColor(c) });
      const blanksToggle = h('input', { type: 'checkbox', checked: prefs.showBlanks });
      blanksToggle.addEventListener('change', () => { prefs.showBlanks = blanksToggle.checked; savePrefs(); renderAll(); commands.refresh(); });
      const dateSel = h('select', { class: 'opt-select fs-date-format', title: 'Date format' },
        h('option', { value: 'short', text: new Date().toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' }) }),
        h('option', { value: 'long', text: new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) }),
        h('option', { value: 'iso', text: 'YYYY-MM-DD' }));
      dateSel.value = prefs.dateFormat;
      dateSel.addEventListener('change', () => { prefs.dateFormat = dateSel.value; savePrefs(); });
      const manage = h('button', { type: 'button', class: 'link-btn fs-manage', text: 'Change signature…', onClick: (e) => manageMenu(e.currentTarget) });

      optionsEl = h('div', { class: 'tool-options fs-options' },
        h('div', { class: 'fs-tools' }, ...TOOLS.slice(0, 5).map(toolBtn)),
        h('span', { class: 'fs-sep' }),
        h('div', { class: 'fs-tools' }, ...TOOLS.slice(5).map(toolBtn), manage),
        h('span', { class: 'fs-sep' }),
        h('div', { class: 'opt-field' }, h('span', { text: 'Size' }), sizeBtn(-1, '−'), sizeLabel, sizeBtn(1, '+')),
        h('div', { class: 'opt-field swatches' }, swatch('#000000', 'Black'), swatch('#1b3b8f', 'Blue')),
        dateSel,
        h('label', { class: 'opt-field fs-blanks-toggle' }, blanksToggle, h('span', { text: 'Highlight blanks' })),
        h('span', { class: 'opt-hint fs-hint-text' }),
        h('div', { class: 'opt-actions' }, h('button', { type: 'button', class: 'btn small primary', text: 'Done', onClick: () => setActive(false) })));
      syncOptions();
      return optionsEl;
    }

    function syncOptions() {
      if (!optionsEl || !S.active) return;
      const sel = S.selected ? find(S.selected) : null;
      optionsEl.querySelectorAll('.fs-tool').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === S.tool)));
      const size = sel?.type === 'text' ? sel.size : sel?.type === 'mark' ? Math.round(sel.w) : (S.tool === 'text' || S.tool === 'date' ? prefs.size : MARK_TOOLS.has(S.tool) ? prefs.markSize : prefs.size);
      optionsEl.querySelector('.fs-size-label').textContent = `${Math.round(size * 10) / 10} pt`;
      const color = sel?.color || prefs.color;
      optionsEl.querySelectorAll('.swatch').forEach((s) => s.setAttribute('aria-checked', String(s.dataset.color.toLowerCase() === color.toLowerCase())));
      optionsEl.querySelector('.fs-date-format').hidden = S.tool !== 'date';
      const tool = TOOLS.find((t) => t.id === S.tool);
      optionsEl.querySelector('.fs-hint-text').textContent = sel ? 'Drag to move. Press Delete to remove.' : tool.hint;
      optionsEl.querySelector('.fs-manage').hidden = !currentSigner()?.signature && !currentSigner()?.initialsMark;
    }

    function changeSize(delta) {
      const sel = S.selected ? find(S.selected) : null;
      if (sel?.type === 'text') {
        sel.size = clamp(sel.size + delta, 6, 48);
        if (sel.fit) { sel.fit.max = sel.size; if (sel.fit.baseline !== undefined) sel.y = sel.fit.baseline - BASELINE * sel.size; }
        render(sel.page); fitText(sel); snapshot();
      }
      else if (sel && (sel.type === 'mark' || sel.type === 'image')) {
        const f = (sel.w + delta * (sel.type === 'image' ? 6 : 2)) / sel.w;
        sel.w = clamp(sel.w * f, 6, 400); sel.h = clamp(sel.h * f, 6, 400);
        render(sel.page); snapshot();
      } else if (MARK_TOOLS.has(S.tool)) { prefs.markSize = clamp(prefs.markSize + delta, 6, 30); savePrefs(); }
      else { prefs.size = clamp(prefs.size + delta, 6, 48); savePrefs(); }
      syncOptions();
    }

    function changeColor(c) {
      prefs.color = c;
      savePrefs();
      const sel = S.selected ? find(S.selected) : null;
      if (sel && sel.type !== 'image') { sel.color = c; render(sel.page); snapshot(); }
      syncOptions();
    }

    function manageMenu(anchor) {
      const r = anchor.getBoundingClientRect();
      ui.contextMenu(r.left, r.bottom + 4, [
        { label: 'Change signature…', run: () => adopt('signature') },
        { label: 'Change initials…', run: () => adopt('initials') },
        { separator: true },
        { label: 'Forget saved signature and initials', danger: true, run: forgetSigner },
      ]);
    }

    async function forgetSigner() {
      if (!(await ui.confirm('Forget signature', 'Remove your saved signature and initials from this device? Documents you already signed are not changed.', { okLabel: 'Forget', danger: true }))) return;
      signer = null;
      sessionSigner = null;
      await ctx.saveSettings({ signer: null });
      syncOptions();
      commands.refresh();
      ui.toast('Saved signature and initials removed');
    }

    // ================================================================ saving
    reader.addSaveTransform({
      id: 'fill-sign',
      needed: () => S.items.some((it) => it.type !== 'text' || it.text.trim()),
      apply: async (bytes, pdfjsDoc) => {
        const active = document.activeElement;
        if (active?.classList?.contains('fs-text-edit')) { const it = find(active.parentElement.dataset.id); if (it) it.text = active.textContent; }
        const items = S.items.filter((it) => it.type !== 'text' || it.text.trim());
        const { bytes: out, replaced } = await flattenItems(bytes, pdfjsDoc, items, S.images, ctx.lib.pdfLib);
        if (replaced.length) ui.toast(`These characters can't be written into the PDF and were saved as "?": ${replaced.join(' ')}`, { type: 'error', timeout: 9000 });
        S.flattened = hist.last;
        return out;
      },
    });

    reader.on('saved', () => { hist.saved = hist.last; changed(); });
    reader.on('open', (_doc, { replaced } = {}) => {
      if (replaced) {
        // A page edit rebuilt the PDF from bytes that already include the fill-ins: they're now part of the page.
        const baked = S.items.length > 0 && S.flattened === hist.last;
        if (baked) {
          S.items = []; S.selected = null; hist.past = []; hist.future = []; hist.last = '[]'; hist.saved = '[]';
          reader.setFeatureDirty('fill-sign', false);
          ui.toast('Your fill-ins were written into the page so the page change could be made.', { timeout: 6000 });
        }
        S.blankJobs.clear(); S.blankResults.clear();
        if (S.active) { ui.setToolOptions(optionsBar(), 'fill-sign'); renderAll(); }
        return;
      }
      resetAll();
      setActive(false);
    });
    reader.on('close', () => { setActive(false); resetAll(); });
    reader.on('rotation', () => setTimeout(renderAll, 0));
    reader.on('editor-mode', (mode) => { if (mode !== T.NONE && S.active) setActive(false); });
    reader.eventBus.on('pagerender', ({ pageNumber }) => render(pageNumber));
    reader.eventBus.on('pagerendered', ({ pageNumber }) => render(pageNumber));

    // ================================================================ commands & toolbar
    const hasDoc = () => reader.hasDocument;
    commands.register({
      id: 'fill.toggle', label: 'Fill & Sign', menu: 'Fill & Sign', group: 'mode', order: 0, type: 'checkbox', accelerator: 'CmdOrCtrl+Shift+F',
      enabled: hasDoc, checked: () => S.active, run: () => setActive(!S.active),
    });
    TOOLS.forEach((t, i) => commands.register({
      id: `fill.tool.${t.id}`, label: t.menu + (t.id === 'signature' || t.id === 'initials' ? '…' : ''), menu: 'Fill & Sign', group: 'tools', order: 10 + i,
      enabled: hasDoc, run: () => chooseTool(t.id),
    }));
    commands.register({ id: 'fill.adopt-signature', label: 'Adopt or Change Signature…', menu: 'Fill & Sign', group: 'signer', order: 50, run: () => adopt('signature') });
    commands.register({ id: 'fill.adopt-initials', label: 'Adopt or Change Initials…', menu: 'Fill & Sign', group: 'signer', order: 51, run: () => adopt('initials') });
    commands.register({ id: 'fill.forget', label: 'Forget Saved Signature and Initials…', menu: 'Fill & Sign', group: 'signer', order: 52, enabled: () => !!currentSigner(), run: forgetSigner });
    commands.register({
      id: 'fill.show-blanks', label: 'Highlight Blanks', menu: 'Fill & Sign', group: 'view', order: 60, type: 'checkbox',
      checked: () => prefs.showBlanks, run: () => { prefs.showBlanks = !prefs.showBlanks; savePrefs(); if (optionsEl) { const cb = optionsEl.querySelector('.fs-blanks-toggle input'); if (cb) cb.checked = prefs.showBlanks; } renderAll(); },
    });
    commands.register({
      id: 'fill.clear', label: 'Remove All Fill-ins…', menu: 'Fill & Sign', group: 'clear', order: 70, enabled: () => S.items.length > 0,
      run: async () => {
        if (!(await ui.confirm('Remove all fill-ins', 'Remove everything you have filled in on this document (text, marks, signatures) that has not been saved yet?', { okLabel: 'Remove all', danger: true }))) return;
        const pages = new Set(S.items.map((i) => i.page));
        S.items = []; S.selected = null;
        pages.forEach(render);
        snapshot();
      },
    });
    commands.register({
      id: 'fill.done', label: 'Finish Fill & Sign', keys: ['Escape'], keyWhen: () => S.active && !S.selected && !document.querySelector('.modal-backdrop'),
      run: () => setActive(false),
    });
    ui.addButton({ slot: 'annotate', command: 'fill.toggle', icon: 'sign', title: 'Fill & Sign', label: 'Fill & Sign', toggle: true, order: -10 });

    ctx.provide('fill-sign', {
      get items() { return S.items; }, setActive, chooseTool, adopt, ensureBlanks, fillBlank,
      get active() { return S.active; },
    });
  },
};
