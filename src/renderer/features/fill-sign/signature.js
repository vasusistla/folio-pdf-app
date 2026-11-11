/**
 * "Adopt your signature": create a signature or initials by typing (in a handwriting style),
 * drawing, or uploading a photo. The result is a transparent PNG kept on this device only.
 */

export const SIGNATURE_STYLES = [
  { id: 'dancing', family: 'Folio Sig Dancing', scale: 1.0 },
  { id: 'vibes', family: 'Folio Sig Vibes', scale: 1.2 },
  { id: 'allura', family: 'Folio Sig Allura', scale: 1.2 },
  { id: 'apple', family: 'Folio Sig Apple', scale: 0.78 },
  { id: 'caveat', family: 'Folio Sig Caveat', scale: 1.05 },
];

export const INK = { black: '#111111', blue: '#1b3b8f' };

/**
 * Show the adopt dialog. Resolves to { dataUrl, width, height, method, name, initials, remember }
 * or null if cancelled.
 *   kind: 'signature' | 'initials'
 */
export function openAdoptDialog(ctx, { kind = 'signature', name = '', initials = '', ink = 'black', style = 'dancing' } = {}) {
  const { ui, h, host } = ctx;
  const isInitials = kind === 'initials';
  const state = { tab: 'type', style, ink, upload: null, initialsEdited: !!initials };

  // ---- name fields
  const nameInput = h('input', { class: 'input', type: 'text', value: name, placeholder: 'e.g. Srinivas Sistla', autofocus: !isInitials, spellcheck: 'false', maxlength: '60' });
  const initialsInput = h('input', { class: 'input sig-initials-input', type: 'text', value: initials || initialsOf(name), placeholder: 'e.g. SS', autofocus: isInitials, spellcheck: 'false', maxlength: '6' });
  nameInput.addEventListener('input', () => {
    if (!state.initialsEdited) initialsInput.value = initialsOf(nameInput.value);
    renderStyles();
  });
  initialsInput.addEventListener('input', () => { state.initialsEdited = true; renderStyles(); });
  const text = () => (isInitials ? initialsInput.value : nameInput.value).trim();

  // ---- tabs
  const tabBtn = (id, label) => h('button', { type: 'button', class: 'sig-tab', role: 'tab', 'data-tab': id, text: label, onClick: () => setTab(id) });
  const tabs = h('div', { class: 'sig-tabs', role: 'tablist' }, tabBtn('type', 'Type'), tabBtn('draw', 'Draw'), tabBtn('upload', 'Upload image'));

  // ---- type panel
  const styleGrid = h('div', { class: 'sig-styles', role: 'radiogroup', 'aria-label': 'Signature style' });
  function renderStyles() {
    const t = text() || (isInitials ? 'AB' : 'Your Name');
    styleGrid.replaceChildren(...SIGNATURE_STYLES.map((s) => h('button', {
      type: 'button', class: 'sig-style', role: 'radio', 'aria-checked': String(s.id === state.style),
      style: { fontFamily: `"${s.family}"`, fontSize: `${(isInitials ? 34 : 30) * s.scale}px`, color: INK[state.ink] },
      text: t, onClick: () => { state.style = s.id; renderStyles(); },
    })));
  }
  const typePanel = h('div', { class: 'sig-panel', 'data-panel': 'type' }, styleGrid);

  // ---- draw panel
  const pad = h('canvas', { class: 'sig-pad', 'aria-label': 'Draw your signature here' });
  const strokes = [];
  let current = null;
  const padPoint = (e) => { const r = pad.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  pad.addEventListener('pointerdown', (e) => { pad.setPointerCapture(e.pointerId); current = [padPoint(e)]; strokes.push(current); drawPad(); });
  pad.addEventListener('pointermove', (e) => { if (!current) return; current.push(padPoint(e)); drawPad(); });
  const endStroke = () => { current = null; };
  pad.addEventListener('pointerup', endStroke);
  pad.addEventListener('pointercancel', endStroke);
  function drawPad() {
    const dpr = window.devicePixelRatio || 1;
    const g = pad.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, pad.width, pad.height);
    const cssH = pad.height / dpr, cssW = pad.width / dpr;
    g.strokeStyle = 'rgba(128,128,140,0.45)';
    g.lineWidth = 1;
    g.setLineDash([4, 4]);
    g.beginPath(); g.moveTo(24, cssH * 0.72); g.lineTo(cssW - 24, cssH * 0.72); g.stroke();
    g.setLineDash([]);
    strokeAll(g, strokes, INK[state.ink], isInitials ? 3 : 2.6);
    padHint.hidden = strokes.length > 0;
  }
  const padHint = h('div', { class: 'sig-pad-hint', text: isInitials ? 'Draw your initials here' : 'Draw your signature here' });
  const drawPanel = h('div', { class: 'sig-panel', 'data-panel': 'draw' },
    h('div', { class: 'sig-pad-wrap' }, pad, padHint),
    h('div', { class: 'sig-row' },
      h('button', { type: 'button', class: 'link-btn', text: 'Undo stroke', onClick: () => { strokes.pop(); drawPad(); } }),
      h('button', { type: 'button', class: 'link-btn', text: 'Clear', onClick: () => { strokes.length = 0; drawPad(); } })));

  // ---- upload panel
  const removeBg = h('input', { type: 'checkbox', checked: true });
  const uploadPreview = h('div', { class: 'sig-upload-preview', text: 'No image chosen' });
  async function chooseImage() {
    const img = await host.pickImage();
    if (!img) return;
    state.upload = img;
    await refreshUpload();
  }
  async function refreshUpload() {
    if (!state.upload) return;
    const canvas = await imageToCanvas(state.upload, removeBg.checked);
    uploadPreview.replaceChildren(canvas ? h('img', { src: canvas.toDataURL('image/png'), alt: 'Signature preview' }) : 'This image looks empty');
  }
  removeBg.addEventListener('change', refreshUpload);
  const uploadPanel = h('div', { class: 'sig-panel', 'data-panel': 'upload' },
    h('div', { class: 'sig-row' },
      h('button', { type: 'button', class: 'btn', text: 'Choose image…', onClick: chooseImage }),
      h('label', { class: 'sig-check' }, removeBg, ' Remove white background')),
    uploadPreview,
    h('p', { class: 'hint', text: 'Tip: sign on white paper, take a photo, and crop it close to the signature.' }));

  // ---- ink + remember
  const inkBtn = (id, label) => h('button', {
    type: 'button', class: 'sig-ink', role: 'radio', 'data-ink': id, title: label, 'aria-label': label,
    style: { background: INK[id] }, onClick: () => { state.ink = id; syncInk(); renderStyles(); drawPad(); },
  });
  const inkRow = h('div', { class: 'sig-ink-row' }, h('span', { text: 'Ink' }), inkBtn('black', 'Black ink'), inkBtn('blue', 'Blue ink'));
  const syncInk = () => inkRow.querySelectorAll('.sig-ink').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.ink === state.ink)));
  const remember = h('input', { type: 'checkbox', checked: true });

  const body = h('div', { class: 'sig-dialog' },
    h('div', { class: 'sig-names' },
      h('label', { class: 'sig-field' }, h('span', { text: 'Full name' }), nameInput),
      h('label', { class: 'sig-field small' }, h('span', { text: 'Initials' }), initialsInput)),
    tabs, typePanel, drawPanel, uploadPanel,
    h('div', { class: 'sig-footer-row' }, inkRow, h('label', { class: 'sig-check' }, remember, ' Remember on this device')),
    h('p', { class: 'sig-legal', text: `By selecting "Adopt and use", you agree that this ${isInitials ? 'mark' : 'signature'} is your electronic ${isInitials ? 'initials' : 'signature'} for documents you sign in Folio PDF. It is stored only on this device.` }));

  function setTab(id) {
    state.tab = id;
    tabs.querySelectorAll('.sig-tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === id)));
    for (const p of [typePanel, drawPanel, uploadPanel]) p.hidden = p.dataset.panel !== id;
    if (id === 'draw') requestAnimationFrame(sizePad);
  }
  function sizePad() {
    const dpr = window.devicePixelRatio || 1;
    const r = pad.getBoundingClientRect();
    if (!r.width) return;
    pad.width = Math.round(r.width * dpr);
    pad.height = Math.round(r.height * dpr);
    drawPad();
  }

  async function produce() {
    let canvas = null;
    let method = state.tab;
    if (state.tab === 'type') {
      if (!text()) { ui.toast(isInitials ? 'Type your initials first' : 'Type your name first', { type: 'error' }); return ui.KEEP_OPEN; }
      const style = SIGNATURE_STYLES.find((s) => s.id === state.style) || SIGNATURE_STYLES[0];
      canvas = await renderTyped(text(), style, INK[state.ink]);
      method = `type:${style.id}`;
    } else if (state.tab === 'draw') {
      if (!strokes.length) { ui.toast('Draw in the box first', { type: 'error' }); return ui.KEEP_OPEN; }
      canvas = renderStrokes(strokes, pad, INK[state.ink], isInitials ? 3 : 2.6);
    } else {
      if (!state.upload) { ui.toast('Choose an image first', { type: 'error' }); return ui.KEEP_OPEN; }
      canvas = await imageToCanvas(state.upload, removeBg.checked);
    }
    if (!canvas) { ui.toast('That came out empty. Please try again.', { type: 'error' }); return ui.KEEP_OPEN; }
    return {
      dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height, method,
      name: nameInput.value.trim(), initials: initialsInput.value.trim(), remember: remember.checked, ink: state.ink, style: state.style,
    };
  }

  syncInk();
  setTab('type');
  renderStyles();
  ensureFonts().then(renderStyles);

  return ui.modal({
    title: isInitials ? 'Adopt your initials' : 'Adopt your signature',
    body,
    width: '640px',
    buttons: [{ label: 'Cancel', value: null }, { label: 'Adopt and use', primary: true, getValue: produce }],
    onOpen: () => setTimeout(() => (isInitials ? initialsInput : nameInput).focus(), 0),
  });
}

export function initialsOf(name) {
  return String(name || '').trim().split(/\s+/).filter(Boolean).map((p) => p[0].toUpperCase()).slice(0, 3).join('');
}

let fontsReady = null;
function ensureFonts() {
  fontsReady ||= Promise.all(SIGNATURE_STYLES.map((s) => document.fonts.load(`40px "${s.family}"`).catch(() => null)));
  return fontsReady;
}

async function renderTyped(text, style, color) {
  await ensureFonts();
  const size = 120 * style.scale;
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  g.font = `${size}px "${style.family}"`;
  const width = Math.ceil(g.measureText(text).width);
  c.width = width + size;
  c.height = Math.ceil(size * 2);
  g.font = `${size}px "${style.family}"`;
  g.fillStyle = color;
  g.textBaseline = 'alphabetic';
  g.fillText(text, size / 2, size * 1.3);
  return trim(c);
}

function strokeAll(g, strokes, color, width) {
  g.strokeStyle = color;
  g.lineWidth = width;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const s of strokes) {
    g.beginPath();
    if (s.length === 1) { g.arc(s[0][0], s[0][1], width / 2, 0, Math.PI * 2); g.fillStyle = color; g.fill(); continue; }
    g.moveTo(s[0][0], s[0][1]);
    for (let i = 1; i < s.length - 1; i++) {
      const mx = (s[i][0] + s[i + 1][0]) / 2, my = (s[i][1] + s[i + 1][1]) / 2;
      g.quadraticCurveTo(s[i][0], s[i][1], mx, my);
    }
    const last = s[s.length - 1];
    g.lineTo(last[0], last[1]);
    g.stroke();
  }
}

function renderStrokes(strokes, pad, color, width) {
  const scale = 3; // export at 3x for crisp printing
  const r = pad.getBoundingClientRect();
  const c = document.createElement('canvas');
  c.width = Math.round(r.width * scale);
  c.height = Math.round(r.height * scale);
  const g = c.getContext('2d');
  g.scale(scale, scale);
  strokeAll(g, strokes, color, width);
  return trim(c);
}

async function imageToCanvas(img, removeBackground) {
  const blob = new Blob([img.data], { type: /\.png$/i.test(img.name) ? 'image/png' : 'image/jpeg' });
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, 1600 / bitmap.width);
  const c = document.createElement('canvas');
  c.width = Math.round(bitmap.width * scale);
  c.height = Math.round(bitmap.height * scale);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bitmap, 0, 0, c.width, c.height);
  bitmap.close?.();
  if (removeBackground) {
    const data = g.getImageData(0, 0, c.width, c.height);
    const d = data.data;
    for (let i = 0; i < d.length; i += 4) {
      const lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      if (lum >= 225) d[i + 3] = 0;
      else if (lum > 170) d[i + 3] = Math.round(d[i + 3] * (225 - lum) / 55);
    }
    g.putImageData(data, 0, 0);
  }
  return trim(c);
}

/** Crop to the visible pixels (plus a small margin). Returns null if nothing is visible. */
function trim(c) {
  const g = c.getContext('2d', { willReadFrequently: true });
  const { data, width, height } = g.getImageData(0, 0, c.width, c.height);
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 10) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const m = Math.round(Math.max(width, height) * 0.01) + 4;
  x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m);
  x1 = Math.min(width - 1, x1 + m); y1 = Math.min(height - 1, y1 + m);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}
