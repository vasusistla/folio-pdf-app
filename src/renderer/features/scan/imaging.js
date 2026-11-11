/**
 * Scan imaging: find the page in a photo, straighten it, and clean it up.
 *
 * Plain JavaScript with no browser APIs, so the same code runs on the page
 * (live outline over the camera) and in the scan worker (full-size pages).
 * Images are { width, height, data: Uint8ClampedArray RGBA } (ImageData works).
 * Corners are always [top-left, top-right, bottom-right, bottom-left] as {x, y}
 * in 0..1 of the image's width and height, so they survive any resizing.
 */

// ---------------------------------------------------------------- small helpers
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Box blur in place, `passes` times (3 passes ≈ Gaussian). */
export function boxBlur(src, w, h, r, passes = 2) {
  if (r < 1) return src;
  let a = src, b = new Float32Array(src.length);
  const div = 2 * r + 1;
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {                       // horizontal
      const row = y * w;
      let acc = a[row] * (r + 1);
      for (let i = 1; i <= r; i++) acc += a[row + Math.min(i, w - 1)];
      for (let x = 0; x < w; x++) {
        b[row + x] = acc / div;
        acc += a[row + Math.min(x + r + 1, w - 1)] - a[row + Math.max(x - r, 0)];
      }
    }
    for (let x = 0; x < w; x++) {                       // vertical
      let acc = b[x] * (r + 1);
      for (let i = 1; i <= r; i++) acc += b[Math.min(i, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        a[y * w + x] = acc / div;
        acc += b[Math.min(y + r + 1, h - 1) * w + x] - b[Math.max(y - r, 0) * w + x];
      }
    }
  }
  return a;
}

/** Otsu's threshold for values 0..255. */
export function otsu(values) {
  const hist = new Float64Array(256);
  for (let i = 0; i < values.length; i++) hist[values[i] < 0 ? 0 : values[i] > 255 ? 255 : values[i] | 0]++;
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, t = 127;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; t = i; }
  }
  return t;
}

/** Erode or dilate a 0/1 mask with a square of radius r. */
function morph(mask, w, h, r, dilate) {
  const tmp = new Uint8Array(mask.length), out = new Uint8Array(mask.length);
  const want = dilate ? 1 : 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 1 - want;
    for (let k = -r; k <= r && v !== want; k++) { const xx = x + k; if (xx >= 0 && xx < w && mask[y * w + xx] === want) v = want; }
    tmp[y * w + x] = v;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 1 - want;
    for (let k = -r; k <= r && v !== want; k++) { const yy = y + k; if (yy >= 0 && yy < h && tmp[yy * w + x] === want) v = want; }
    out[y * w + x] = v;
  }
  return out;
}

/** Label 4-connected regions of 1s. Returns { labels, regions: [{ id, area, cx, cy, touches }] }. */
function regions(mask, w, h) {
  const labels = new Int32Array(mask.length);
  const out = [];
  const stack = new Int32Array(mask.length);
  let next = 1;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || labels[i]) continue;
    let sp = 0, area = 0, sx = 0, sy = 0, touches = 0;
    stack[sp++] = i; labels[i] = next;
    while (sp) {
      const j = stack[--sp], x = j % w, y = (j / w) | 0;
      area++; sx += x; sy += y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches++;
      if (x > 0 && mask[j - 1] && !labels[j - 1]) { labels[j - 1] = next; stack[sp++] = j - 1; }
      if (x < w - 1 && mask[j + 1] && !labels[j + 1]) { labels[j + 1] = next; stack[sp++] = j + 1; }
      if (y > 0 && mask[j - w] && !labels[j - w]) { labels[j - w] = next; stack[sp++] = j - w; }
      if (y < h - 1 && mask[j + w] && !labels[j + w]) { labels[j + w] = next; stack[sp++] = j + w; }
    }
    out.push({ id: next, area, cx: sx / area, cy: sy / area, touches });
    next++;
  }
  return { labels, regions: out };
}

const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** Convex hull (monotone chain), counter-clockwise in y-down coordinates. */
function hull(points) {
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

const polyArea = (q) => { let a = 0; for (let i = 0; i < q.length; i++) { const p = q[i], n = q[(i + 1) % q.length]; a += p.x * n.y - n.x * p.y; } return Math.abs(a) / 2; };

/** Douglas–Peucker on a closed polygon. */
function simplifyClosed(poly, eps) {
  if (poly.length <= 4) return poly;
  // start from the two points farthest apart so the split is stable
  let ia = 0, ib = 0, best = -1;
  for (let i = 0; i < poly.length; i++) for (let j = i + 1; j < poly.length; j++) {
    const d = (poly[i].x - poly[j].x) ** 2 + (poly[i].y - poly[j].y) ** 2;
    if (d > best) { best = d; ia = i; ib = j; }
  }
  const run = (pts) => {
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const st = [[0, pts.length - 1]];
    while (st.length) {
      const [s, e] = st.pop();
      const A = pts[s], B = pts[e], len = Math.hypot(B.x - A.x, B.y - A.y) || 1;
      let md = -1, mi = -1;
      for (let i = s + 1; i < e; i++) { const d = Math.abs(cross(A, B, pts[i])) / len; if (d > md) { md = d; mi = i; } }
      if (md > eps) { keep[mi] = 1; st.push([s, mi], [mi, e]); }
    }
    return pts.filter((_, i) => keep[i]);
  };
  const a = run(poly.slice(ia, ib + 1)), b = run([...poly.slice(ib), ...poly.slice(0, ia + 1)]);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

/** The largest quadrilateral with corners on the polygon's vertices. */
function maxQuad(poly) {
  const n = poly.length;
  if (n < 4) return null;
  if (n === 4) return poly;
  let best = null, bestA = -1;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++) for (let d = c + 1; d < n; d++) {
    const q = [poly[a], poly[b], poly[c], poly[d]];
    const ar = polyArea(q);
    if (ar > bestA) { bestA = ar; best = q; }
  }
  return best;
}

/** Order 4 points as top-left, top-right, bottom-right, bottom-left. */
export function orderCorners(pts) {
  const c = { x: pts.reduce((s, p) => s + p.x, 0) / 4, y: pts.reduce((s, p) => s + p.y, 0) / 4 };
  const byAngle = [...pts].sort((a, b) => Math.atan2(a.y - c.y, a.x - c.x) - Math.atan2(b.y - c.y, b.x - c.x));
  // byAngle runs clockwise on screen starting near the left; rotate so the top-left (smallest x+y) is first
  let start = 0, min = Infinity;
  byAngle.forEach((p, i) => { if (p.x + p.y < min) { min = p.x + p.y; start = i; } });
  return [0, 1, 2, 3].map((k) => byAngle[(start + k) % 4]);
}

function interiorAngles(q) {
  return q.map((p, i) => {
    const a = q[(i + 3) % 4], b = q[(i + 1) % 4];
    const v1 = { x: a.x - p.x, y: a.y - p.y }, v2 = { x: b.x - p.x, y: b.y - p.y };
    const cos = (v1.x * v2.x + v1.y * v2.y) / ((Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y)) || 1);
    return (Math.acos(clamp(cos, -1, 1)) * 180) / Math.PI;
  });
}

const isConvex = (q) => { let sign = 0; for (let i = 0; i < 4; i++) { const c = cross(q[i], q[(i + 1) % 4], q[(i + 2) % 4]); if (!c) continue; if (sign && Math.sign(c) !== sign) return false; sign = Math.sign(c); } return true; };

// ---------------------------------------------------------------- finding the page
/**
 * Find the page in a photo. Pass a small image (300–500 px on the long side).
 * Returns { corners (0..1), score } or null when no page-like shape is clear.
 *
 * Candidate outlines come from two places: straight edges found in the photo
 * (good with shadows, coloured headers and partly covered pages) and the bright
 * low-colour region a page makes. Each candidate is scored by how much of its
 * border is a real edge running the same way, so table edges and lines of
 * text inside the page lose to the page's own border.
 */
export function detectDocument(img) {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const lum = new Float32Array(n), paper = new Float32Array(n), R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = data[j], g = data[j + 1], b = data[j + 2];
    const mx = r > g ? (r > b ? r : b) : (g > b ? g : b), mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
    lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    paper[i] = clamp(lum[i] - 1.6 * (mx - mn), 0, 255);        // paper is bright and has little colour
    R[i] = r; G[i] = g; B[i] = b;
  }
  const r = Math.max(1, Math.round(Math.min(w, h) / 200));
  for (const f of [lum, paper, R, G, B]) boxBlur(f, w, h, r);
  const edges = edgeMap([R, G, B], w, h);

  const candidates = [];
  for (const q of houghQuads(edges, w, h)) candidates.push({ pts: q });
  for (const [field, offs] of [[paper, [0, -25]], [lum, [0]]]) {
    const t0 = otsu(field);
    for (const off of offs) { const q = quadFromMask(field, w, h, t0 + off); if (q) candidates.push(q); }
  }
  let best = null;
  for (const c of candidates) {
    const s = support(edges, w, h, c.pts);
    if (s.min < 0.35 || s.mean < 0.5) continue;
    const area = polyArea(c.pts) / n;
    const score = s.mean * s.mean * Math.sqrt(area) * (1 - 0.6 * s.over);
    if (!best || score > best.score) best = { pts: c.pts, score, mean: s.mean };
  }
  if (!best) return null;
  return { corners: best.pts.map((p) => ({ x: clamp(p.x / (w - 1), 0, 1), y: clamp(p.y / (h - 1), 0, 1) })), score: best.mean };
}

/**
 * Thin edges (Canny-style) from the colour channels: per pixel the strongest
 * gradient of R, G or B, its direction, and whether it's a local maximum
 * across the edge and strong enough to count.
 */
function edgeMap(chans, w, h) {
  const n = w * h;
  const mag = new Float32Array(n), dir = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    let bm = 0, bx = 0, by = 0;
    for (const f of chans) {
      const gx = f[i + 1] - f[i - 1] + 0.5 * (f[i - w + 1] - f[i - w - 1] + f[i + w + 1] - f[i + w - 1]);
      const gy = f[i + w] - f[i - w] + 0.5 * (f[i + w - 1] - f[i - w - 1] + f[i + w + 1] - f[i - w + 1]);
      const m = gx * gx + gy * gy;
      if (m > bm) { bm = m; bx = gx; by = gy; }
    }
    mag[i] = Math.sqrt(bm);
    dir[i] = Math.atan2(by, bx);
  }
  // keep only the ridge of each edge
  // An edge must stand out from this photo's own noise: a faint paper edge on a white
  // desk counts, the grain of a carpet or wood table doesn't.
  const on = new Uint8Array(n);
  const vals = [];
  for (let i = w + 1; i < n - w - 1; i += 5) vals.push(mag[i]);
  vals.sort((a, b) => a - b);
  const noise = vals.length ? vals[Math.floor(vals.length * 0.5)] : 1;
  const t = Math.max(3, noise * 3.5);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, m = mag[i];
    if (m < t) continue;
    const dx = Math.round(Math.cos(dir[i])), dy = Math.round(Math.sin(dir[i]));
    if (m >= mag[i + dy * w + dx] && m >= mag[i - dy * w - dx]) on[i] = 1;
  }
  // near[i]: which of 8 edge directions occur within 2 px (bit k = direction k·22.5°), for quick checks
  const bits = new Uint8Array(n), tmp = new Uint8Array(n), near = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (on[i]) { let a = dir[i]; if (a < 0) a += Math.PI; bits[i] = 1 << (Math.round(a / (Math.PI / 8)) % 8); }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0; for (let k = -2; k <= 2; k++) { const xx = x + k; if (xx >= 0 && xx < w) v |= bits[y * w + xx]; }
    tmp[y * w + x] = v;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0; for (let k = -2; k <= 2; k++) { const yy = y + k; if (yy >= 0 && yy < h) v |= tmp[yy * w + x]; }
    near[y * w + x] = v;
  }
  return { mag, dir, on, t, near };
}

/** Lines from the edges (Hough, each edge pixel voting near its own direction), then 4-line outlines. */
function houghQuads(edges, w, h) {
  const { mag, dir, on } = edges;
  const T = 180, diag = Math.ceil(Math.hypot(w, h)), RH = 2 * diag + 1;
  const acc = new Float32Array(T * RH);
  const cosT = new Float32Array(T), sinT = new Float32Array(T);
  for (let t = 0; t < T; t++) { cosT[t] = Math.cos((t * Math.PI) / T); sinT[t] = Math.sin((t * Math.PI) / T); }
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (!on[i]) continue;
    let th = dir[i]; if (th < 0) th += Math.PI;
    const tc = Math.round((th / Math.PI) * T);
    const v = Math.min(mag[i], edges.t * 2.5);                // long faint edges beat short strong ones
    for (let k = -7; k <= 7; k++) {                           // faint edges have noisy directions
      const t = (tc + k + T) % T;
      const rho = Math.round(x * cosT[t] + y * sinT[t]) + diag;
      acc[t * RH + rho] += v;
      if (rho > 0) acc[t * RH + rho - 1] += v * 0.5;
      if (rho < RH - 1) acc[t * RH + rho + 1] += v * 0.5;
    }
  }
  // strongest lines, one per neighbourhood
  const peaks = [];
  const minVote = Math.min(w, h) * 0.12 * edges.t * 2;
  for (let t = 0; t < T; t++) for (let rr = 0; rr < RH; rr++) {
    const v = acc[t * RH + rr];
    if (v < minVote) continue;
    let max = true;
    for (let dt = -4; dt <= 4 && max; dt++) for (let dr = -6; dr <= 6; dr++) {
      if (!dt && !dr) continue;
      let tt = t + dt, r2 = rr + dr;
      if (tt < 0) { tt += T; r2 = RH - 1 - r2; } else if (tt >= T) { tt -= T; r2 = RH - 1 - r2; }
      if (r2 < 0 || r2 >= RH) continue;
      if (acc[tt * RH + r2] > v) { max = false; break; }
    }
    if (max) peaks.push({ t, rho: rr - diag, v });
  }
  peaks.sort((a, b) => b.v - a.v);
  const lines = peaks.slice(0, 24).map((p) => {
    const th = (p.t * Math.PI) / T, c = Math.cos(th), s = Math.sin(th);
    return { px: c * p.rho, py: s * p.rho, dx: -s, dy: c, horiz: Math.abs(s) > Math.SQRT1_2 };
  });
  // the photo's own borders, for pages that run off the edge of the picture
  const border = [
    { px: 0, py: 0, dx: 1, dy: 0, horiz: true, edge: true }, { px: 0, py: h - 1, dx: 1, dy: 0, horiz: true, edge: true },
    { px: 0, py: 0, dx: 0, dy: 1, horiz: false, edge: true }, { px: w - 1, py: 0, dx: 0, dy: 1, horiz: false, edge: true },
  ];
  const hs = [...lines.filter((l) => l.horiz).slice(0, 10), ...border.filter((l) => l.horiz)];
  const vs = [...lines.filter((l) => !l.horiz).slice(0, 10), ...border.filter((l) => !l.horiz)];
  // where a line crosses the middle of the photo, to skip pairs too close to be a page's two sides
  const midY = (l) => (Math.abs(l.dx) > 1e-6 ? l.py + ((w / 2 - l.px) / l.dx) * l.dy : l.py);
  const midX = (l) => (Math.abs(l.dy) > 1e-6 ? l.px + ((h / 2 - l.py) / l.dy) * l.dx : l.px);
  const out = [];
  const n = w * h;
  for (let a = 0; a < hs.length; a++) for (let b = a + 1; b < hs.length; b++) {
    if (Math.abs(midY(hs[a]) - midY(hs[b])) < h * 0.22) continue;
    for (let c = 0; c < vs.length; c++) for (let d = c + 1; d < vs.length; d++) {
      if (Math.abs(midX(vs[c]) - midX(vs[d])) < w * 0.15) continue;
      const edgesUsed = [hs[a], hs[b], vs[c], vs[d]].filter((l) => l.edge).length;
      if (edgesUsed > 2) continue;
      const pts = [intersect(hs[a], vs[c]), intersect(hs[a], vs[d]), intersect(hs[b], vs[d]), intersect(hs[b], vs[c])];
      if (pts.some((p) => !p || p.x < -2 || p.y < -2 || p.x > w + 1 || p.y > h + 1)) continue;
      const q = orderCorners(pts);
      if (!isConvex(q) || polyArea(q) < n * 0.08) continue;
      if (interiorAngles(q).some((g) => g < 45 || g > 135)) continue;
      out.push(q);
    }
  }
  return out;
}

/**
 * How much of an outline's border is a real edge running the same way: per side,
 * the share of points with an edge pixel within 2 px whose direction is across
 * the side. Sides on the photo's border count as half-supported.
 */
function support(edges, w, h, q) {
  const { near } = edges;
  const per = [];
  let over = 0, overN = 0;
  for (let k = 0; k < 4; k++) {
    const a = q[k], b = q[(k + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    // the side's normal as one of 8 directions, and the ones either side of it (±34°)
    let ang = Math.atan2(b.x - a.x, -(b.y - a.y)); if (ang < 0) ang += Math.PI;
    const bin = Math.round(ang / (Math.PI / 8)) % 8;
    const want = (1 << bin) | (1 << ((bin + 1) % 8)) | (1 << ((bin + 7) % 8));
    const hitAt = (x, y) => (near[Math.round(y) * w + Math.round(x)] & want) !== 0;
    const inside = (x, y) => x >= 2 && y >= 2 && x <= w - 3 && y <= h - 3;
    const steps = Math.max(10, Math.round(len / 2));
    let hit = 0, cnt = 0, border = 0;
    for (let s = 1; s < steps; s++) {
      const t = s / steps, x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
      if (!inside(x, y)) { border++; continue; }
      cnt++;
      if (hitAt(x, y)) hit++;
    }
    // a side on the photo's border: the page runs off the picture there
    per.push(cnt + border ? (hit + border * 0.75) / (cnt + border) : 0);
    // past each end: a real corner is where the edge stops; if it keeps going, this isn't the corner
    const ext = Math.max(4, Math.round(len * 0.1 / 2));
    for (const [from, dirx, diry] of [[b, (b.x - a.x) / len, (b.y - a.y) / len], [a, (a.x - b.x) / len, (a.y - b.y) / len]]) {
      let eh = 0, ec = 0;
      for (let s = 3; s <= ext + 2; s++) {
        const x = from.x + dirx * s * 2, y = from.y + diry * s * 2;
        if (!inside(x, y)) break;
        ec++; if (hitAt(x, y)) eh++;
      }
      if (ec >= 3) { over += eh / ec; overN++; }
    }
  }
  return { min: Math.min(...per), mean: per.reduce((s, v) => s + v, 0) / 4, over: overN ? over / overN : 0 };
}

function quadFromMask(field, w, h, t) {
  const n = w * h;
  let mask = new Uint8Array(n);
  let on = 0;
  for (let i = 0; i < n; i++) if (field[i] > t) { mask[i] = 1; on++; }
  if (on < n * 0.08 || on > n * 0.97) return null;
  const r = Math.max(1, Math.round(Math.min(w, h) / 120));
  mask = morph(morph(mask, w, h, r, false), w, h, r, true);      // open: cut thin bridges to the background
  const { labels, regions: rs } = regions(mask, w, h);
  // the page: big, near the middle, not mostly made of the photo's border
  let pick = null, best = -1;
  for (const g of rs) {
    if (g.area < n * 0.06) continue;
    const dc = Math.hypot((g.cx - w / 2) / w, (g.cy - h / 2) / h);
    const s = g.area * (1 - dc) * (g.touches > (w + h) * 0.9 ? 0.3 : 1);
    if (s > best) { best = s; pick = g; }
  }
  if (!pick) return null;
  // outline points: leftmost and rightmost pixel of the region on each row
  const pts = [];
  for (let y = 0; y < h; y++) {
    let lo = -1, hi = -1;
    for (let x = 0; x < w; x++) if (labels[y * w + x] === pick.id) { if (lo < 0) lo = x; hi = x; }
    if (lo >= 0) { pts.push({ x: lo, y }); if (hi !== lo) pts.push({ x: hi, y }); }
  }
  const hl = hull(pts);
  const area = polyArea(hl);
  if (area < n * 0.06) return null;
  const quad = maxQuad(simplifyClosed(hl, Math.hypot(w, h) * 0.012));
  if (!quad) return null;
  const q = orderCorners(quad);
  const qa = polyArea(q);
  if (!isConvex(q) || qa < n * 0.06) return null;
  const ang = interiorAngles(q);
  if (ang.some((a) => a < 40 || a > 140)) return null;
  const fill = Math.min(pick.area / qa, qa / pick.area);          // how page-shaped the region is
  if (fill < 0.82) return null;
  return { pts: q, fill };
}

/**
 * Sharpen the corners on a larger image: slide each side onto the strongest
 * nearby edge and fit a straight line. Returns refined corners (0..1), or the
 * originals when the edges aren't clear enough to trust.
 */
export function refineCorners(img, corners) {
  const { width: w, height: h, data } = img;
  const lum = new Float32Array(w * h);
  for (let i = 0, j = 0; i < lum.length; i++, j += 4) lum[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  boxBlur(lum, w, h, Math.max(1, Math.round(Math.min(w, h) / 500)));
  const q = corners.map((c) => ({ x: c.x * (w - 1), y: c.y * (h - 1) }));
  const diag = Math.hypot(w, h), reach = Math.max(4, Math.round(diag * 0.012));
  const at = (x, y) => { const xi = clamp(Math.round(x), 0, w - 1), yi = clamp(Math.round(y), 0, h - 1); return lum[yi * w + xi]; };
  const lines = [];
  for (let k = 0; k < 4; k++) {
    const a = q[k], b = q[(k + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len, nx = -uy, ny = ux;
    const pts = [];
    const S = 28;
    for (let s = 3; s < S - 2; s++) {
      const t = s / S, x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
      if (x < 3 || y < 3 || x > w - 4 || y > h - 4) continue;
      let bestG = 0, bestD = 0;
      for (let d = -reach; d <= reach; d++) {
        const g = Math.abs(at(x + nx * (d + 1.5), y + ny * (d + 1.5)) - at(x + nx * (d - 1.5), y + ny * (d - 1.5)));
        if (g > bestG) { bestG = g; bestD = d; }
      }
      if (bestG > 14) pts.push({ x: x + nx * bestD, y: y + ny * bestD });
    }
    lines.push(pts.length >= 6 ? fitLine(pts) : null);
  }
  if (lines.some((l) => !l)) return corners;
  const out = [];
  for (let k = 0; k < 4; k++) {
    const p = intersect(lines[(k + 3) % 4], lines[k]);
    if (!p || Math.hypot(p.x - q[k].x, p.y - q[k].y) > diag * 0.03) return corners;
    out.push({ x: clamp(p.x / (w - 1), 0, 1), y: clamp(p.y / (h - 1), 0, 1) });
  }
  return out;
}

/** Least-squares line through points, dropping the worst quarter once. Line as { px, py, dx, dy }. */
function fitLine(pts) {
  const fit = (ps) => {
    const mx = ps.reduce((s, p) => s + p.x, 0) / ps.length, my = ps.reduce((s, p) => s + p.y, 0) / ps.length;
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of ps) { sxx += (p.x - mx) ** 2; sxy += (p.x - mx) * (p.y - my); syy += (p.y - my) ** 2; }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return { px: mx, py: my, dx: Math.cos(ang), dy: Math.sin(ang) };
  };
  const dist = (l, p) => Math.abs((p.x - l.px) * l.dy - (p.y - l.py) * l.dx);
  const l = fit(pts);
  const kept = [...pts].sort((a, b) => dist(l, a) - dist(l, b)).slice(0, Math.max(4, Math.ceil(pts.length * 0.75)));
  return fit(kept);
}

function intersect(l1, l2) {
  const det = l1.dx * l2.dy - l1.dy * l2.dx;
  if (Math.abs(det) < 1e-6) return null;
  const t = ((l2.px - l1.px) * l2.dy - (l2.py - l1.py) * l2.dx) / det;
  return { x: l1.px + l1.dx * t, y: l1.py + l1.dy * t };
}

// ---------------------------------------------------------------- straightening
/** 3×3 homography taking the 4 `from` points to the 4 `to` points. */
export function homography(from, to) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i], { x: u, y: v } = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const s = solve(A, b);
  return s ? [...s, 1] : null;
}

function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

/**
 * The page's real width : height from its four corners in the photo, allowing
 * for perspective (Zhang & He, "Whiteboard scanning"). Falls back to the average
 * side lengths when the photo has no measurable perspective.
 */
export function pageAspect(corners, imgW, imgH) {
  const P = corners.map((c) => [c.x * imgW, c.y * imgH, 1]);
  const [m1, m2, m4, m3] = P;                                    // m1 TL, m2 TR, m3 BL, m4 BR
  const crossV = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const simple = ((len(m1, m2) + len(m3, m4)) / 2) / ((len(m1, m3) + len(m2, m4)) / 2);
  const k2 = dot(crossV(m1, m4), m3) / dot(crossV(m2, m4), m3);
  const k3 = dot(crossV(m1, m4), m2) / dot(crossV(m3, m4), m2);
  const n2 = m2.map((v, i) => k2 * v - m1[i]), n3 = m3.map((v, i) => k3 * v - m1[i]);
  const u0 = imgW / 2, v0 = imgH / 2;
  if (Math.abs(n2[2]) < 1e-6 || Math.abs(n3[2]) < 1e-6) {
    const r = Math.sqrt((n2[0] ** 2 + n2[1] ** 2) / (n3[0] ** 2 + n3[1] ** 2));
    return Number.isFinite(r) && r > 0 ? r : simple;
  }
  const f2 = -((n2[0] * n3[0] - (n2[0] * n3[2] + n2[2] * n3[0]) * u0 + n2[2] * n3[2] * u0 * u0)
    + (n2[1] * n3[1] - (n2[1] * n3[2] + n2[2] * n3[1]) * v0 + n2[2] * n3[2] * v0 * v0)) / (n2[2] * n3[2]);
  if (!(f2 > 0)) return simple;
  const f = Math.sqrt(f2);
  // A^-T A^-1 applied as a quadratic form
  const q = (n) => {
    const x = (n[0] - u0 * n[2]) / f, y = (n[1] - v0 * n[2]) / f;
    return x * x + y * y + n[2] * n[2];
  };
  const r = Math.sqrt(q(n2) / q(n3));
  // a wild answer means the corners are off; trust the simple estimate then
  return Number.isFinite(r) && r > simple * 0.6 && r < simple * 1.6 ? r : simple;
}

/**
 * Output size for a page: keeps the detail the photo has, up to `maxSide` on the long side
 * (and at least `minSide`, enlarging if needed: text recognition reads small print better).
 */
export function outputSize(corners, imgW, imgH, maxSide, minSide = 0) {
  const P = corners.map((c) => ({ x: c.x * imgW, y: c.y * imgH }));
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const aspect = pageAspect(corners, imgW, imgH);
  const seenW = Math.max(d(P[0], P[1]), d(P[3], P[2])), seenH = Math.max(d(P[0], P[3]), d(P[1], P[2]));
  // as many pixels as the photo shows the page with, a little more for sharp text, capped
  let H = Math.max(seenH, seenW / aspect) * 1.15;
  let W = H * aspect;
  const s = Math.max(Math.min(1, maxSide / Math.max(W, H)), minSide / Math.max(W, H));
  W = Math.max(16, Math.round(W * s)); H = Math.max(16, Math.round(H * s));
  return { width: W, height: H, aspect };
}

/**
 * Straighten the page: map the 4 corners of `src` onto a W×H rectangle (bilinear).
 * `trim` (0..1) cuts that much off each side, so no sliver of the table shows at the edges.
 */
export function warp(src, corners, W, H, trim = 0) {
  const { width: sw, height: sh, data: sd } = src;
  const tx = trim * W, ty = trim * H;
  const from = [{ x: -tx, y: -ty }, { x: W - 1 + tx, y: -ty }, { x: W - 1 + tx, y: H - 1 + ty }, { x: -tx, y: H - 1 + ty }];
  const to = corners.map((c) => ({ x: c.x * (sw - 1), y: c.y * (sh - 1) }));
  const m = homography(from, to);
  const out = new Uint8ClampedArray(W * H * 4);
  if (!m) return { width: W, height: H, data: out };
  for (let y = 0; y < H; y++) {
    // per row, the projective map is incremental in x
    let X = m[1] * y + m[2], Y = m[4] * y + m[5], Z = m[7] * y + m[8];
    let o = y * W * 4;
    for (let x = 0; x < W; x++, X += m[0], Y += m[3], Z += m[6], o += 4) {
      const u = X / Z, v = Y / Z;
      const x0 = u < 0 ? 0 : u > sw - 1.001 ? sw - 2 : u | 0, y0 = v < 0 ? 0 : v > sh - 1.001 ? sh - 2 : v | 0;
      const fx = clamp(u - x0, 0, 1), fy = clamp(v - y0, 0, 1);
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      out[o] = sd[i00] * w00 + sd[i10] * w10 + sd[i01] * w01 + sd[i11] * w11;
      out[o + 1] = sd[i00 + 1] * w00 + sd[i10 + 1] * w10 + sd[i01 + 1] * w01 + sd[i11 + 1] * w11;
      out[o + 2] = sd[i00 + 2] * w00 + sd[i10 + 2] * w10 + sd[i01 + 2] * w01 + sd[i11 + 2] * w11;
      out[o + 3] = 255;
    }
  }
  return { width: W, height: H, data: out };
}

/** Rotate by a multiple of 90° clockwise. */
export function rotate(img, quarterTurns) {
  const t = ((quarterTurns % 4) + 4) % 4;
  if (!t) return img;
  const { width: w, height: h, data } = img;
  const W = t % 2 ? h : w, H = t % 2 ? w : h;
  const out = new Uint8ClampedArray(W * H * 4);
  const s32 = new Uint32Array(data.buffer, data.byteOffset, w * h), o32 = new Uint32Array(out.buffer);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const X = t === 1 ? h - 1 - y : t === 2 ? w - 1 - x : y;
    const Y = t === 1 ? x : t === 2 ? h - 1 - y : w - 1 - x;
    o32[Y * W + X] = s32[y * w + x];
  }
  return { width: W, height: H, data: out };
}

// ---------------------------------------------------------------- cleaning up
export const FILTERS = [
  { id: 'auto', label: 'Auto', hint: 'White paper, crisp ink, colours kept, shadows removed' },
  { id: 'gray', label: 'Grayscale', hint: 'Shades of gray, shadows removed' },
  { id: 'bw', label: 'Black & white', hint: 'Pure black text on white; smallest files' },
  { id: 'photo', label: 'Photo', hint: 'As photographed: for pictures, IDs and receipts with colour' },
];

/**
 * How bright the bare paper is at every point (per colour), from a coarse grid:
 * the brightest bits of each cell, spread out and smoothed so ink doesn't count.
 * Dividing by it removes shadows and uneven or tinted light.
 */
function paperLight(img) {
  const { width: w, height: h, data } = img;
  const cell = Math.max(6, Math.round(Math.min(w, h) / 36));
  const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
  const grid = [new Float32Array(gw * gh), new Float32Array(gw * gh), new Float32Array(gw * gh)];
  const lumHist = new Uint32Array(256);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    // the 90th-percentile brightness of the cell, and the colour of pixels that bright
    lumHist.fill(0);
    const x0 = gx * cell, y0 = gy * cell, x1 = Math.min(w, x0 + cell), y1 = Math.min(h, y0 + cell);
    let cnt = 0;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
      const i = (y * w + x) * 4;
      lumHist[(data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8]++; cnt++;
    }
    let acc = 0, t = 255;
    for (let v = 255; v >= 0; v--) { acc += lumHist[v]; if (acc >= cnt * 0.1) { t = v; break; } }
    let r = 0, g = 0, b = 0, k = 0;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
      const i = (y * w + x) * 4;
      if (((data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8) >= t) { r += data[i]; g += data[i + 1]; b += data[i + 2]; k++; }
    }
    const gi = gy * gw + gx;
    grid[0][gi] = r / k; grid[1][gi] = g / k; grid[2][gi] = b / k;
  }
  // Cells that are mostly ink or picture (a coloured header, a photo) are much darker than
  // the paper around them; shadows change gradually. Replace only the sharp outliers with
  // their neighbours, a few times so bigger dark areas fill in from the edges, then smooth.
  const lumOf = (i) => 0.299 * grid[0][i] + 0.587 * grid[1][i] + 0.114 * grid[2][i];
  for (let pass = 0; pass < 4; pass++) {
    const L = new Float32Array(gw * gh);
    for (let i = 0; i < L.length; i++) L[i] = lumOf(i);
    const fix = [];
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      const near = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = gy + dy, xx = gx + dx;
        if ((dx || dy) && yy >= 0 && xx >= 0 && yy < gh && xx < gw) near.push(yy * gw + xx);
      }
      near.sort((p, q) => L[q] - L[p]);
      const top = near.slice(0, Math.max(2, Math.ceil(near.length / 2)));      // the brighter half of the neighbours
      const ref = top.reduce((sum, i) => sum + L[i], 0) / top.length;
      if (L[gy * gw + gx] < ref * 0.78) fix.push([gy * gw + gx, top]);
    }
    if (!fix.length) break;
    for (const [i, top] of fix) for (const ch of grid) ch[i] = top.reduce((sum, j) => sum + ch[j], 0) / top.length;
  }
  for (const ch of grid) {
    boxBlur(ch, gw, gh, 1, 2);
    for (let i = 0; i < ch.length; i++) ch[i] = Math.max(ch[i], 30);
  }
  return { grid, gw, gh, cell };
}

/**
 * Narrow shadows that the paper-light grid is too coarse to follow: the band along a fold, the dark
 * edge of a curl. The paper's own brightness is found close up (the brightest nearby pixel, so text
 * doesn't count) and brought up to white. Only where it is gray, not coloured, and only a little
 * darker than the paper: a highlighter mark, a coloured box or a photo stays as it is.
 * Changes `rgb` (RGBA, paper ≈ 255) and `lum` in place.
 */
function liftShadows(rgb, lum, w, h) {
  // on a small copy (about 700 px across, whatever the page size): the paper between letters and
  // between lines is always within reach there
  const f = Math.max(1, Math.round(Math.min(w, h) / 700));
  const W = Math.max(1, Math.ceil(w / f)), H = Math.max(1, Math.ceil(h / f));
  const r = Math.max(3, Math.round(Math.min(W, H) / 120));
  const bright = new Float32Array(W * H), chroma = new Float32Array(W * H);
  const step = f >= 3 ? 2 : 1;                       // every other pixel is plenty on a big page
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let l = 0, c = 0, k = 0;
    for (let yy = y * f, ye = Math.min(h, yy + f); yy < ye; yy += step) for (let xx = x * f, xe = Math.min(w, xx + f); xx < xe; xx += step) {
      const p = yy * w + xx, i = p * 4;
      const a = rgb[i], b = rgb[i + 1], d = rgb[i + 2];
      l += lum[p]; c += (a > b ? (a > d ? a : d) : b > d ? b : d) - (a < b ? (a < d ? a : d) : b < d ? b : d); k++;
    }
    bright[y * W + x] = l / k; chroma[y * W + x] = c / k;
  }
  const light = extreme(extreme(bright, W, H, r, true), W, H, r, false);   // a closing: ink gone, edges kept
  boxBlur(light, W, H, Math.max(1, r >> 1), 2);
  boxBlur(chroma, W, H, r, 1);
  const gain = new Float32Array(W * H);
  let any = false;
  for (let i = 0; i < gain.length; i++) {
    const v = light[i] / 250;
    // 0.5–0.72 of white: from 'too dark to be a shadow' to 'surely a shadow'; gray only
    const sure = smooth(v, 0.5, 0.72) * (1 - smooth(chroma[i], 14, 34));
    gain[i] = v < 1 ? 1 + (Math.min(1.8, 1 / v) - 1) * sure : 1;
    if (gain[i] > 1.01) any = true;
  }
  if (!any) return;
  // spread the gain back over the page (bilinear), one row at a time
  const row = new Float32Array(W);
  for (let y = 0; y < h; y++) {
    const fy = clamp((y + 0.5) / f - 0.5, 0, H - 1), y0 = Math.min(fy | 0, Math.max(0, H - 2)), ty = H > 1 ? fy - y0 : 0;
    const a = y0 * W, c = a + (H > 1 ? W : 0);
    let lift = false;
    for (let x = 0; x < W; x++) { row[x] = gain[a + x] * (1 - ty) + gain[c + x] * ty; if (row[x] > 1.001) lift = true; }
    if (!lift) continue;
    for (let x = 0; x < w; x++) {
      const fx = clamp((x + 0.5) / f - 0.5, 0, W - 1), x0 = Math.min(fx | 0, Math.max(0, W - 2)), tx = W > 1 ? fx - x0 : 0;
      const g = row[x0] * (1 - tx) + row[x0 + (W > 1 ? 1 : 0)] * tx;
      if (g <= 1.001) continue;
      const p = y * w + x, i = p * 4;
      rgb[i] *= g; rgb[i + 1] *= g; rgb[i + 2] *= g;
      lum[p] *= g;
    }
  }
}

const smooth = (v, a, b) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** Running maximum (or minimum) over a (2r+1)² square, in two passes (van Herk / Gil–Werman). */
function extreme(src, w, h, r, max) {
  const n = 2 * r + 1;
  const pass = (from, to, len, count, step, stride) => {
    const g = new Float32Array(len), b = new Float32Array(len);
    for (let k = 0; k < count; k++) {
      const o = k * stride;
      for (let s = 0; s < len; s += n) {
        const e = Math.min(len, s + n) - 1;
        let v = from[o + s * step]; g[s] = v;
        for (let i = s + 1; i <= e; i++) { const u = from[o + i * step]; v = max ? (u > v ? u : v) : (u < v ? u : v); g[i] = v; }
        v = from[o + e * step]; b[e] = v;
        for (let i = e - 1; i >= s; i--) { const u = from[o + i * step]; v = max ? (u > v ? u : v) : (u < v ? u : v); b[i] = v; }
      }
      for (let i = 0; i < len; i++) {
        const p = b[i - r < 0 ? 0 : i - r], q = g[i + r >= len ? len - 1 : i + r];
        to[o + i * step] = max ? (p > q ? p : q) : (p < q ? p : q);
      }
    }
  };
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  pass(src, tmp, w, h, 1, w);        // along rows
  pass(tmp, out, h, w, w, 1);        // down columns
  return out;
}

/** Clean up a straightened page. Returns a new image. */
export function enhance(img, filter, { sharpen = true } = {}) {
  if (filter === 'photo') return img;
  const { width: w, height: h, data } = img;
  const { grid, gw, gh, cell } = paperLight(img);
  const out = new Uint8ClampedArray(data.length);
  const norm = new Float32Array(w * h);                         // normalised brightness, paper ≈ 255
  const bw = filter === 'bw', gray = filter === 'gray';
  for (let y = 0; y < h; y++) {
    const fy = clamp((y + 0.5) / cell - 0.5, 0, gh - 1), y0 = Math.min(fy | 0, gh - 2 < 0 ? 0 : gh - 2), ty = gh > 1 ? fy - y0 : 0;
    for (let x = 0; x < w; x++) {
      const fx = clamp((x + 0.5) / cell - 0.5, 0, gw - 1), x0 = Math.min(fx | 0, gw - 2 < 0 ? 0 : gw - 2), tx = gw > 1 ? fx - x0 : 0;
      const a = y0 * gw + x0, b = a + (gw > 1 ? 1 : 0), c = a + (gh > 1 ? gw : 0), d = c + (gw > 1 ? 1 : 0);
      const i = (y * w + x) * 4;
      let R = 0, G = 0, B = 0;
      for (let ch = 0; ch < 3; ch++) {
        const L = grid[ch];
        const light = (L[a] * (1 - tx) + L[b] * tx) * (1 - ty) + (L[c] * (1 - tx) + L[d] * tx) * ty;
        const v = (data[i + ch] / light) * 255;
        if (ch === 0) R = v; else if (ch === 1) G = v; else B = v;
      }
      out[i] = R; out[i + 1] = G; out[i + 2] = B; out[i + 3] = 255;
      norm[y * w + x] = 0.299 * R + 0.587 * G + 0.114 * B;
    }
  }
  liftShadows(out, norm, w, h);
  if (bw) {
    // threshold between ink and paper, with a 1–2 level ramp so letters stay smooth
    const sample = [];
    for (let i = 0; i < norm.length; i += 7) sample.push(Math.min(255, norm[i]));
    const t = clamp(otsu(Float32Array.from(sample)), 110, 205);
    for (let p = 0, i = 0; p < norm.length; p++, i += 4) {
      const v = clamp((norm[p] - (t - 18)) * (255 / 36), 0, 255);
      out[i] = out[i + 1] = out[i + 2] = v;
    }
    return { width: w, height: h, data: out };
  }
  // levels: paper → white, the darkest ink → near black; then a little extra colour for Auto
  const hist = new Uint32Array(256);
  for (let p = 0; p < norm.length; p += 3) hist[clamp(norm[p] | 0, 0, 255)]++;
  const total = Math.ceil(norm.length / 3);
  let acc = 0, black = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.005) { black = v; break; } }
  black = Math.min(black, 90);
  const white = 238, span = 255 / (white - black);
  // and a light sharpening, so letters come out crisp rather than soft from the straightening
  const soft = sharpen ? boxBlur(Float32Array.from(norm), w, h, 1, 1) : null;
  for (let p = 0, i = 0; p < norm.length; p++, i += 4) {
    const L = norm[p], edge = soft ? (L - soft[p]) * 0.6 : 0;
    if (gray) {
      const v = (L + edge - black) * span;
      out[i] = out[i + 1] = out[i + 2] = v;
    } else {
      for (let ch = 0; ch < 3; ch++) out[i + ch] = (L + (out[i + ch] - L) * 1.3 + edge - black) * span;
    }
  }
  return { width: w, height: h, data: out };
}

/** Shrink an image so its long side is at most `maxSide` (area averaging; fast and clean). */
export function downscale(img, maxSide) {
  const { width: w, height: h, data } = img;
  const s = maxSide / Math.max(w, h);
  if (s >= 1) return img;
  const W = Math.max(1, Math.round(w * s)), H = Math.max(1, Math.round(h * s));
  const out = new Uint8ClampedArray(W * H * 4);
  const fx = w / W, fy = h / H;
  for (let Y = 0; Y < H; Y++) {
    const y0 = Math.floor(Y * fy), y1 = Math.max(y0 + 1, Math.floor((Y + 1) * fy));
    for (let X = 0; X < W; X++) {
      const x0 = Math.floor(X * fx), x1 = Math.max(x0 + 1, Math.floor((X + 1) * fx));
      let r = 0, g = 0, b = 0, k = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * w + x) * 4; r += data[i]; g += data[i + 1]; b += data[i + 2]; k++; }
      const o = (Y * W + X) * 4;
      out[o] = r / k; out[o + 1] = g / k; out[o + 2] = b / k; out[o + 3] = 255;
    }
  }
  return { width: W, height: H, data: out };
}

/** The whole photo, a little in from the edges: the starting outline when no page is found. */
export const WHOLE = [{ x: 0.03, y: 0.03 }, { x: 0.97, y: 0.03 }, { x: 0.97, y: 0.97 }, { x: 0.03, y: 0.97 }];
export const FULL = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

/** True when two outlines are within `tol` (0..1 of the image) at every corner. */
export function sameOutline(a, b, tol) {
  return a && b && a.every((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y) <= tol);
}
