/**
 * Scan worker: the heavy image work, off the UI thread so the camera view and
 * buttons stay smooth. Messages in: { id, op, ...args }; out: { id, result } or { id, error }.
 *
 *   detect   { bitmap }                         → { corners | null }   (live outline, small frames)
 *   prepare  { blob }                           → { width, height, corners, edges, found, view }
 *   render   { key, blob, corners, edges, flatten, rotation, filter, maxSide, quality }
 *                                               → { blob, width, height }
 *   filters  { key, blob, corners, edges, flatten, rotation, size } → { auto, gray, bw, photo } small previews
 *
 * `edges` are the page's traced (possibly curved) sides from prepare, or null; `flatten` (on unless
 * false) also lays bent lines of text straight (dewarp.js).
 */
import { detectDocument, refineCorners, downscale, outputSize, warp, enhance, rotate, WHOLE } from './imaging.js';
import { traceEdges, textLineField, warpPage } from './dewarp.js';

// "Keep the whole photo" keeps every pixel
const isWhole = (q) => q.every((p, i) => Math.abs(p.x - [0, 1, 1, 0][i]) < 1e-6 && Math.abs(p.y - [0, 0, 1, 1][i]) < 1e-6);

// The last few decoded photos, so changing a filter doesn't decode the photo again.
const decoded = new Map();
const KEEP = 2;

async function pixelsOf(key, blob) {
  if (key && decoded.has(key)) {
    const hit = decoded.get(key);
    decoded.delete(key); decoded.set(key, hit);           // most recently used last
    return hit;
  }
  const bmp = await createImageBitmap(blob);               // applies the photo's EXIF rotation
  const img = imageDataOf(bmp);
  bmp.close();
  if (key) {
    decoded.set(key, img);
    while (decoded.size > KEEP) decoded.delete(decoded.keys().next().value);
  }
  return img;
}

// iPhone Safari refuses canvases over about 16.7 million pixels (newer iPhones take 24 MP photos),
// so very large photos are scaled to just under that: still about 4,700 × 3,500, ample for a page.
const MAX_PIXELS = 16e6;

function imageDataOf(source, w = source.width, h = source.height) {
  if (w * h > MAX_PIXELS) { const s = Math.sqrt(MAX_PIXELS / (w * h)); w = Math.floor(w * s); h = Math.floor(h * s); }
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(source, 0, 0, w, h);
  return g.getImageData(0, 0, w, h);
}

function toCanvas(img) {
  const c = new OffscreenCanvas(img.width, img.height);
  c.getContext('2d').putImageData(img instanceof ImageData ? img : new ImageData(img.data, img.width, img.height), 0, 0);
  return c;
}

// How each page bends: worked out once per page and outline, then used for every size and look,
// so the preview, the saved page and the copy read for OCR all line up exactly.
const bends = new Map();

function bendOf(key, img, corners, edges) {
  const id = `${key}|${JSON.stringify(corners)}|${edges ? JSON.stringify(edges) : ''}`;
  if (key != null && bends.has(id)) return bends.get(id);
  const s = outputSize(corners, img.width, img.height, 1400);
  const look = enhance(warpPage(downscale(img, 1600), corners, s.width, s.height, { edges, trim: 0.004 }), 'gray', { sharpen: false });
  const field = textLineField(look);
  if (key != null) {
    bends.set(id, field);
    while (bends.size > KEEP * 2) bends.delete(bends.keys().next().value);
  }
  return field;
}

/** The page straightened: perspective only, or also flattened (curved edges, bent lines). */
function straighten(img, key, { corners, edges, flatten, width, height, trim, source = img }) {
  if (isWhole(corners)) return warp(source, corners, width, height, 0);
  if (flatten === false) return warp(source, corners, width, height, trim);
  const field = bendOf(key, img, corners, edges);
  if (!field && !edges) return warp(source, corners, width, height, trim);
  return warpPage(source, corners, width, height, { edges, field, trim });
}

const ops = {
  detect({ bitmap, image }) {
    const img = image || imageDataOf(bitmap);
    bitmap?.close();
    const d = detectDocument(img);
    return d ? { corners: d.corners, score: d.score } : { corners: null };
  },

  async prepare({ key, blob }) {
    const img = await pixelsOf(key, blob);
    const d = detectDocument(downscale(img, 400));
    let corners = WHOLE, edges = null, found = false;
    if (d) {
      const mid = downscale(img, 1400);
      corners = refineCorners(mid, d.corners); found = true;
      // follow the sides: a curled page has curved edges, and its true corners sit a little further out
      const traced = traceEdges(mid, corners);
      corners = traced.corners; edges = traced.sides;
    }
    // a screen-sized copy of the photo for the crop editor
    const view = await toCanvas(downscale(img, 1600)).convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    return { width: img.width, height: img.height, corners, edges, found, view };
  },

  async render({ key, blob, corners, edges = null, flatten = true, rotation = 0, filter = 'auto', maxSide = 2400, minSide = 0, quality = 0.8, type = 'image/jpeg', trim = 0.004, sharpen = true }) {
    const img = await pixelsOf(key, blob);
    const size = outputSize(corners, img.width, img.height, maxSide, minSide);
    // straighten at full detail, clean up, then turn
    let page = straighten(img, key, { corners, edges, flatten, width: size.width, height: size.height, trim });
    page = enhance(page, filter, { sharpen });
    page = rotate(page, rotation);
    const out = await toCanvas(page).convertToBlob({ type, quality });
    return { blob: out, width: page.width, height: page.height, aspect: page.width / page.height };
  },

  async filters({ key, blob, corners, edges = null, flatten = true, rotation = 0, size = 220 }) {
    const img = await pixelsOf(key, blob);
    const s = outputSize(corners, img.width, img.height, size * 2);
    const flat = straighten(img, key, { corners, edges, flatten, width: s.width, height: s.height, trim: 0.004, source: downscale(img, 900) });
    const out = {};
    for (const f of ['auto', 'gray', 'bw', 'photo']) {
      const page = rotate(downscale(enhance(flat, f), size), rotation);
      out[f] = await toCanvas(page).convertToBlob({ type: 'image/jpeg', quality: 0.8 });
    }
    return out;
  },

  forget({ key }) {
    decoded.delete(key);
    for (const id of [...bends.keys()]) if (id.startsWith(`${key}|`)) bends.delete(id);
    return true;
  },
};

self.onmessage = async (e) => {
  const { id, op, ...args } = e.data;
  try {
    const result = await ops[op](args);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
