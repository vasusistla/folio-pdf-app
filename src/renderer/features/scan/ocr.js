/**
 * Text recognition (OCR) for scanned pages, entirely on this device.
 *
 * Uses Tesseract (tesseract.js) with the English language data shipped inside
 * the app; nothing is downloaded. The recognised words are written into the PDF
 * as invisible text over the picture, so the scan can be searched, selected and
 * copied like a normal PDF while looking exactly the same.
 */
const BASE = new URL('../../../../node_modules', import.meta.url).href;
let enginePromise = null;
let idleTimer = null;

/** One shared recogniser, started on first use and shut down after a minute idle. */
function engine() {
  clearTimeout(idleTimer);
  if (!enginePromise) {
    enginePromise = (async () => {
      const { default: Tesseract } = await import(`${BASE}/tesseract.js/dist/tesseract.esm.min.js`);
      return Tesseract.createWorker('eng', 1, {
        workerPath: `${BASE}/tesseract.js/dist/worker.min.js`,
        corePath: `${BASE}/tesseract.js-core/tesseract-core-simd-lstm.wasm.js`,
        langPath: `${BASE}/@tesseract.js-data/eng/4.0.0_best_int`,
        workerBlobURL: false,
        cacheMethod: 'none',
        gzip: true,
      });
    })().catch((err) => { enginePromise = null; throw err; });
  }
  return enginePromise;
}

function release() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const p = enginePromise;
    enginePromise = null;
    try { (await p)?.terminate(); } catch { /* already gone */ }
  }, 60000);
}

function parse(data) {
  const lines = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs) for (const l of p.lines) {
    const words = l.words
      .filter((wd) => wd.text.trim() && wd.confidence > 35)
      .map((wd) => ({ text: wd.text.trim(), conf: wd.confidence, ...wd.bbox }));
    if (!words.length) continue;
    lines.push({ words, baseline: l.baseline, height: l.rowAttributes?.row_height || (l.bbox.y1 - l.bbox.y0) });
  }
  return lines;
}

/** How convincingly a result reads: characters in confidently read words. */
const score = (lines) => lines.reduce((s, l) => s + l.words.reduce((t, w) => t + (w.conf > 70 ? w.text.length : 0), 0), 0);
const weak = (lines) => {
  const words = lines.flatMap((l) => l.words);
  if (words.length < 8) return true;
  return words.reduce((s, w) => s + w.conf, 0) / words.length < 72;
};

async function canvasOf(image, maxSide = Infinity) {
  const src = image instanceof Blob ? await createImageBitmap(image) : image;
  const s = Math.min(1, maxSide / Math.max(src.width, src.height));
  const c = document.createElement('canvas');
  c.width = Math.round(src.width * s); c.height = Math.round(src.height * s);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  if (src !== image) src.close?.();
  return c;
}

/** The canvas turned `t` quarter turns clockwise. */
function turned(c, t) {
  const o = document.createElement('canvas');
  o.width = t % 2 ? c.height : c.width; o.height = t % 2 ? c.width : c.height;
  const g = o.getContext('2d');
  g.translate(o.width / 2, o.height / 2);
  g.rotate((t * Math.PI) / 2);
  g.drawImage(c, -c.width / 2, -c.height / 2);
  return o;
}

/**
 * Recognise the text in an image (Blob, canvas or ImageBitmap) of `width` × `height` pixels.
 * Pages that are sideways or upside down are found and read the right way up.
 * Returns { width, height, turn, lines: [{ words: [{ text, x0, y0, x1, y1 }], baseline, height }] };
 * when `turn` (quarter turns clockwise) is set, the line coordinates are in the turned picture.
 */
export async function recognize(image, { width, height }, { autoRotate = true } = {}) {
  const w = await engine();
  try {
    const read = async (img) => parse((await w.recognize(img, {}, { blocks: true, text: false })).data);
    let lines = await read(image);
    let turn = 0;
    if (autoRotate && weak(lines)) {
      // try the other three ways up on a small copy; keep one only if it reads clearly better
      const full = await canvasOf(image);
      const small = await canvasOf(full, 1400);
      let best = score(await read(small)), pick = 0;
      for (const t of [1, 3, 2]) {
        const sc = score(await read(turned(small, t)));
        if (sc > Math.max(40, best * 1.6)) { best = sc; pick = t; }
      }
      if (pick) { lines = await read(turned(full, pick)); turn = pick; }
      full.width = full.height = small.width = small.height = 0;
    }
    return { width, height, turn, lines };
  } finally {
    release();
  }
}

/** Point in the picture as it was read (turned `turn` times) → point in the picture as it is. */
function unturn(ocr, X, Y) {
  const { width: W, height: H, turn } = ocr;
  if (turn === 1) return [Y, H - 1 - X];
  if (turn === 2) return [W - 1 - X, H - 1 - Y];
  if (turn === 3) return [W - 1 - Y, X];
  return [X, Y];
}

/**
 * Write recognised text into a pdf-lib page as invisible text over the picture.
 * `map` places image pixels on the page: { point(x, y) → { x, y } in PDF points, scale (points per pixel) }.
 * Use boxMap() for a picture drawn in a box; a pdf.js viewport works for existing pages (any rotation).
 */
export function addTextLayer(pdfLib, page, font, ocr, map) {
  const { pushGraphicsState, popGraphicsState, beginText, endText, setFontAndSize, setTextRenderingMode,
    TextRenderingMode, setCharacterSqueeze, setTextMatrix, showText } = pdfLib;
  if (ocr.turn) { const base = map; map = { scale: base.scale, point: (x, y) => base.point(...unturn(ocr, x, y)) }; }
  const key = page.node.newFontDictionary(font.name, font.ref);
  const ok = new Set(font.getCharacterSet());
  const clean = (s) => [...s.normalize('NFKC')].map((ch) => (ok.has(ch.codePointAt(0)) ? ch : '?')).join('');
  const ops = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
  for (const line of ocr.lines) {
    const size = Math.max(2, line.height * map.scale * 0.9);
    const bl = line.baseline;
    const baseAt = (x) => (!bl || bl.x1 === bl.x0 ? null : bl.y0 + ((bl.y1 - bl.y0) * (x - bl.x0)) / (bl.x1 - bl.x0));
    line.words.forEach((wd, i) => {
      const word = clean(wd.text);
      const natural = font.widthOfTextAtSize(word, size);
      if (!natural) return;
      const b0 = baseAt(wd.x0) ?? wd.y1, b1 = baseAt(wd.x1) ?? wd.y1;
      const p0 = map.point(wd.x0, b0), p1 = map.point(wd.x1, b1);
      const len = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      if (!len) return;
      const c = (p1.x - p0.x) / len, s = (p1.y - p0.y) / len;
      const squeeze = Math.max(10, Math.min(400, (100 * len) / natural));
      const text = word + (i < line.words.length - 1 ? ' ' : '');
      ops.push(setFontAndSize(key, size), setCharacterSqueeze(squeeze), setTextMatrix(c, s, -s, c, p0.x, p0.y), showText(font.encodeText(text)));
    });
  }
  ops.push(endText(), popGraphicsState());
  page.pushOperators(...ops);
}

/** Image pixels → a box on the page (PDF points, origin bottom-left). */
export function boxMap(ocr, box) {
  const sx = box.width / ocr.width, sy = box.height / ocr.height;
  return { scale: (sx + sy) / 2, point: (x, y) => ({ x: box.x + x * sx, y: box.y + box.height - y * sy }) };
}

/** Warm the recogniser up in the background (e.g. while the user reviews pages). */
export function prewarm() { engine().then(release, () => {}); }
