/**
 * Finds the blanks on a page that a person would write in:
 *   - lines: drawn underlines and runs of underscores  ("Name: ________", "made on ______, 2026")
 *   - boxes: empty rectangles and empty table cells
 *   - checks: small squares (checkboxes)
 *   - signature fields from real PDF forms
 *
 * It works from what the page *looks like*: the page is rendered off-screen and scanned for
 * straight dark strokes, which covers PDFs made by any program. The page's text is used to
 * ignore underlines beneath words and to recognise "Signature", "Initials" and "Date" labels.
 *
 * All coordinates are in "base display space": PDF points, origin top-left, with the page's own
 * /Rotate applied (what you see at 100% with no extra view rotation).
 */

const K = 2;               // render scale (pixels per point) used for scanning
const DARK = 150;          // luminance below this counts as ink
const GAP = 1 * K;         // allowed gap inside a stroke (joins between underscore glyphs)
const MIN_RUN = 5 * K;     // shortest stroke kept
const MAX_THICK = 3.5 * K; // thicker than this is a filled bar, not a line
const MIN_LINE = 18;       // shortest blank line, in points

export async function detectBlanks(pdfPage, { AnnotationMode }) {
  const rotate = pdfPage.rotate;
  const vp = pdfPage.getViewport({ scale: 1, rotation: rotate });
  const W = vp.width;
  const H = vp.height;

  const [texts, widgets] = await Promise.all([readText(pdfPage, vp), readWidgets(pdfPage, vp)]);
  const { dark, w, h } = await rasterize(pdfPage, rotate, AnnotationMode);
  // A real line has blank paper just above and below it; strokes inside words, filled bars or
  // pictures don't. Then drop anything that overlaps actual text.
  const rowFrac = (y, x0, x1) => {
    if (y < 0 || y >= h) return 0;
    let n = 0;
    for (let x = x0; x <= x1; x++) n += dark[y * w + x];
    return n / (x1 - x0 + 1);
  };
  const inkBoxes = texts.flatMap((t) => t.ink.map(([a, b]) => ({ x0: a, x1: b, y0: t.base - t.size * 0.75, y1: t.base + t.size * 0.22 })));
  const inkOverlapX = (x0, x1, y) => inkBoxes.reduce((sum, b) => (y >= b.y0 - 1 && y <= b.y1 + 1 ? sum + Math.max(0, Math.min(b.x1, x1) - Math.max(b.x0, x0)) : sum), 0);
  const segments = horizontalSegments(dark, w, h).filter((sg) => {
    const pad = Math.round(1.5 * K);
    if (rowFrac(sg.y0 - pad, sg.x0, sg.x1) > 0.4 || rowFrac(sg.y1 + pad, sg.x0, sg.x1) > 0.4) return false;
    const x0 = sg.x0 / K, x1 = sg.x1 / K;
    return inkOverlapX(x0, x1, sg.yc / K) <= (x1 - x0) * 0.3;
  });
  const rectInk = (r) => inkBoxes.some((b) => {
    const ix = Math.max(0, Math.min(b.x1, r.x1) - Math.max(b.x0, r.x0)), iy = Math.max(0, Math.min(b.y1, r.y1) - Math.max(b.y0, r.y0));
    const inter = ix * iy;
    return inter > 0.25 * (b.x1 - b.x0) * (b.y1 - b.y0) || inter > 0.15 * (r.x1 - r.x0) * (r.y1 - r.y0);
  });

  const vFrac = (x, y0, y1) => {
    let hits = 0, n = 0;
    for (let y = Math.max(0, y0); y <= Math.min(h - 1, y1); y++, n++) {
      let any = false;
      for (let dx = -2; dx <= 2 && !any; dx++) { const xx = x + dx; if (xx >= 0 && xx < w && dark[y * w + xx]) any = true; }
      if (any) hits++;
    }
    return n ? hits / n : 0;
  };

  // ---- rectangles: pair a top and bottom stroke that share left/right ends and have both side edges
  const cand = segments.filter((s) => s.x1 - s.x0 >= 5 * K).sort((a, b) => a.yc - b.yc);
  const used = new Set();
  const rects = [];
  for (let i = 0; i < cand.length; i++) {
    const top = cand[i];
    for (let j = i + 1; j < cand.length; j++) {
      const bot = cand[j];
      const gap = bot.yc - top.yc;
      if (gap < 5 * K) continue;
      if (gap > 80 * K) break;
      if (Math.abs(bot.x0 - top.x0) > 2.5 * K || Math.abs(bot.x1 - top.x1) > 2.5 * K) continue;
      const x0 = Math.round((top.x0 + bot.x0) / 2), x1 = Math.round((top.x1 + bot.x1) / 2);
      if (vFrac(x0, Math.round(top.yc), Math.round(bot.yc)) < 0.85 || vFrac(x1, Math.round(top.yc), Math.round(bot.yc)) < 0.85) continue;
      used.add(top); used.add(bot);
      // split into cells at internal vertical lines (tables)
      const splits = [x0];
      let runStart = -1;
      for (let x = x0 + 3 * K; x <= x1 - 3 * K; x++) {
        const on = vFrac(x, Math.round(top.yc + 1), Math.round(bot.yc - 1)) >= 0.85;
        if (on && runStart < 0) runStart = x;
        if (!on && runStart >= 0) { if (x - runStart <= 4 * K) splits.push(Math.round((runStart + x) / 2)); runStart = -1; }
      }
      splits.push(x1);
      for (let k = 0; k < splits.length - 1; k++) {
        rects.push({ x0: splits[k] / K, x1: splits[k + 1] / K, y0: top.yc / K, y1: bot.yc / K });
      }
      break; // the nearest matching bottom edge closes this box
    }
  }

  const blanks = [];
  const overlapsWidget = (r) => widgets.some((wd) => r.x0 < wd.x1 && r.x1 > wd.x0 && r.y0 < wd.y1 && r.y1 > wd.y0);
  const medianSize = median(texts.map((t) => t.size)) || 11;
  const sizeNear = (x, y) => {
    const row = texts.filter((t) => Math.abs(t.base - y) <= Math.max(6, t.size * 0.7) && t.x0 < x + 2);
    const near = row.sort((a, b) => b.x1 - a.x1)[0];
    return clamp(near ? near.size : medianSize, 8, 14);
  };

  for (const r of rects) {
    const bw = r.x1 - r.x0, bh = r.y1 - r.y0;
    if (bw < 6 || bh < 6) continue;
    if (rectInk(r) || overlapsWidget(r)) continue;
    const square = bw <= 24 && bh <= 24 && bw / bh > 0.7 && bw / bh < 1.4;
    if (square) blanks.push({ type: 'check', ...r });
    else if (bh >= 10) blanks.push({ type: 'box', ...r, size: clamp(Math.min(sizeNear(r.x0, r.y1), bh * 0.6), 7, 14), kind: labelKind(texts, r) });
  }

  // ---- lines: long thin strokes that are not the underline of a word
  for (const s of segments) {
    if (used.has(s)) continue;
    const x0 = s.x0 / K, x1 = s.x1 / K, y = s.yc / K, len = x1 - x0;
    if (len < MIN_LINE || len > W * 0.85) continue;
    const r = { x0, x1, y0: y - 14, y1: y + 1 };
    if (overlapsWidget(r)) continue;
    blanks.push({ type: 'line', x0, x1, y, size: sizeNear(x0, y), kind: labelKind(texts, { x0, x1, y0: y, y1: y }) });
  }

  // ---- real PDF signature fields
  for (const wd of widgets) {
    if (wd.fieldType === 'Sig') blanks.push({ type: 'box', kind: 'signature', x0: wd.x0, x1: wd.x1, y0: wd.y0, y1: wd.y1, size: 11 });
  }

  // stable ids, reading order
  for (const b of blanks) b.id = `${b.type}-${Math.round(b.x0)}-${Math.round(b.y ?? b.y0)}`;
  blanks.sort((a, b) => rowY(a) - rowY(b) || a.x0 - b.x0);
  return { blanks, W, H };
}

export const rowY = (b) => (b.type === 'line' ? b.y : b.y1);

function labelKind(texts, r) {
  // label to the left on the same row, or just below / above the blank
  const near = texts.filter((t) => {
    const sameRow = Math.abs(t.base - r.y1) < 10 && t.ink.some(([, b]) => b <= r.x0 + 8 && b > r.x0 - 160);
    const below = t.base > r.y1 && t.base - r.y1 < 18 && t.x0 < r.x1 && t.x1 > r.x0;
    const above = t.base < r.y0 && r.y0 - t.base < 12 && t.x0 < r.x1 && t.x1 > r.x0 && r.y1 - r.y0 > 0;
    return sameRow || below || above;
  }).map((t) => t.str).join(' ');
  if (/\binitials?\b/i.test(near)) return 'initials';
  if (/\bsign(ature|ed|ing)?\b|\bsign here\b/i.test(near)) return 'signature';
  if (/\bdate\b/i.test(near)) return 'date';
  return null;
}

async function readText(pdfPage, vp) {
  const tc = await pdfPage.getTextContent();
  const out = [];
  for (const it of tc.items) {
    if (!it.str || !it.transform || !it.width) continue;
    const [a, b, c, d, e, f] = it.transform;
    const n = Math.hypot(a, b) || 1;
    const size = Math.hypot(c, d) || it.height || 10;
    const p0 = vp.convertToViewportPoint(e, f);
    const p1 = vp.convertToViewportPoint(e + (a / n) * it.width, f + (b / n) * it.width);
    if (Math.abs(p1[1] - p0[1]) > 1 || p1[0] < p0[0]) continue; // horizontal, left-to-right only
    const t = { str: it.str, x0: p0[0], x1: p1[0], base: p0[1], size };
    t.ink = inkRanges(t);
    out.push(t);
  }
  return out;
}

/**
 * Approximate x-ranges of the visible characters in a text run, skipping underscores, spaces and
 * empty-box glyphs. Character widths are estimated by kind, which is close enough for overlap tests.
 */
const BLANK_CHARS = /[_\s\u2610\u25A1\u274F]/;
function charWidth(ch) {
  if (ch === '_') return 0.53;
  if (ch === ' ') return 0.27;
  if (/[.,:;'|!iIl]/.test(ch)) return 0.28;
  if (/[A-Z0-9mwMW$%&@#]/.test(ch)) return 0.66;
  return 0.5;
}
function inkRanges(t) {
  const s = t.str;
  const widths = [...s].map(charWidth);
  const total = widths.reduce((a, b) => a + b, 0) || 1;
  const scale = (t.x1 - t.x0) / total;
  const out = [];
  let pos = t.x0, start = null;
  [...s].forEach((ch, i) => {
    const blank = BLANK_CHARS.test(ch);
    if (!blank && start === null) start = pos;
    if (blank && start !== null) { out.push([start, pos]); start = null; }
    pos += widths[i] * scale;
  });
  if (start !== null) out.push([start, pos]);
  return out;
}

async function readWidgets(pdfPage, vp) {
  const annots = await pdfPage.getAnnotations({ intent: 'display' }).catch(() => []);
  return annots.filter((a) => a.subtype === 'Widget' && a.rect).map((a) => {
    const [x0, y0, x1, y1] = vp.convertToViewportRectangle(a.rect);
    return { x0: Math.min(x0, x1), x1: Math.max(x0, x1), y0: Math.min(y0, y1), y1: Math.max(y0, y1), fieldType: a.fieldType };
  });
}

async function rasterize(pdfPage, rotate, AnnotationMode) {
  const vp = pdfPage.getViewport({ scale: K, rotation: rotate });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  await pdfPage.render({ canvasContext: g, viewport: vp, annotationMode: AnnotationMode.DISABLE }).promise;
  const { data } = g.getImageData(0, 0, canvas.width, canvas.height);
  const w = canvas.width, h = canvas.height;
  const dark = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < dark.length; i++, p += 4) {
    if (data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114 < DARK) dark[i] = 1;
  }
  canvas.width = canvas.height = 0;
  return { dark, w, h };
}

/** Horizontal strokes: runs of ink per row, merged across neighbouring rows. */
function horizontalSegments(dark, w, h) {
  const done = [];
  let open = [];
  for (let y = 0; y < h; y++) {
    const runs = [];
    let x = 0;
    while (x < w) {
      if (!dark[y * w + x]) { x++; continue; }
      let end = x, gap = 0, xx = x;
      while (xx < w && gap <= GAP) {
        if (dark[y * w + xx]) { end = xx; gap = 0; } else gap++;
        xx++;
      }
      if (end - x + 1 >= MIN_RUN) runs.push([x, end]);
      x = end + 1;
    }
    const next = [];
    for (const [x0, x1] of runs) {
      const seg = open.find((s) => s.y1 === y - 1 && Math.min(s.x1, x1) - Math.max(s.x0, x0) >= 0.8 * Math.max(s.x1 - s.x0, x1 - x0));
      if (seg) { seg.y1 = y; seg.x0 = Math.min(seg.x0, x0); seg.x1 = Math.max(seg.x1, x1); next.push(seg); open = open.filter((s) => s !== seg); }
      else next.push({ x0, x1, y0: y, y1: y });
    }
    done.push(...open);
    open = next;
  }
  done.push(...open);
  return done
    .filter((s) => s.y1 - s.y0 + 1 <= MAX_THICK)
    .map((s) => ({ ...s, yc: (s.y0 + s.y1 + 1) / 2 }));
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
