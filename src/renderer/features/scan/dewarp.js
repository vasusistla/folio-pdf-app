/**
 * Flattening bent pages: curls, bows and creases.
 *
 * The four corners fix the perspective (imaging.js). A page that isn't flat also needs:
 *   1. its edges followed where they curve (traceEdges), and the page stretched between those
 *      curved edges with a Coons patch, on top of the perspective;
 *   2. its lines of text made straight again (textLineField): each line is followed across the
 *      page, and a smooth vertical shift is worked out that lays every line flat. This also takes
 *      out the kink a fold puts in the lines.
 * warpPage() does both in one resampling, so the text is only interpolated once and stays sharp.
 *
 * Plain JavaScript, no browser APIs (runs in the scan worker). Images are { width, height, data }.
 */
import { homography, boxBlur, otsu } from './imaging.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function luminance(img, blur = 0) {
  const { width: w, height: h, data } = img;
  const L = new Float32Array(w * h);
  for (let i = 0, j = 0; i < L.length; i++, j += 4) L[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  if (blur) boxBlur(L, w, h, blur);
  return L;
}

// ---------------------------------------------------------------- 1. curved edges
const SAMPLES = 24;

/**
 * Follow each side of the page between its corners. On a bent page the straight-line corners sit a
 * little inside the real ones, so the traced edges are followed out to their ends and the corners
 * moved there first. Returns { corners, sides }: corners (0..1) to use, and 4 lists of points running
 * corner to corner (top: TL→TR, right: TR→BR, bottom: BR→BL, left: BL→TL); sides is null when every
 * side is straight (the corners alone then describe the page).
 */
export function traceEdges(img, corners) {
  const { width: w, height: h } = img;
  const L = luminance(img, Math.max(1, Math.round(Math.min(w, h) / 600)));
  const at = (x, y) => L[clamp(Math.round(y), 0, h - 1) * w + clamp(Math.round(x), 0, w - 1)];
  const reach = Math.max(6, Math.round(Math.hypot(w, h) * 0.035));
  const maxMove = Math.hypot(w, h) * 0.012;           // a corner moves this far at most
  let q = corners.map((c) => ({ x: c.x * (w - 1), y: c.y * (h - 1) }));

  /** Offsets of the real edge from the straight side, at SAMPLES−1 points (null where unclear). */
  const trace = (a, b) => {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
    const off = [];
    for (let s = 1; s < SAMPLES; s++) {
      const t = s / SAMPLES, x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
      if (x < 4 || y < 4 || x > w - 5 || y > h - 5) { off.push(null); continue; }   // the page runs off the photo here
      let best = -1, bestD = 0;
      for (let d = -reach; d <= reach; d++) {
        const px = x + nx * d, py = y + ny * d;
        if (px < 2 || py < 2 || px > w - 3 || py > h - 3) continue;
        const g = Math.abs(at(px + nx * 1.5, py + ny * 1.5) - at(px - nx * 1.5, py - ny * 1.5)) - Math.abs(d) * 0.08;
        if (g > best) { best = g; bestD = d; }
      }
      off.push(best > 9 ? bestD : null);
    }
    return { off, len, nx, ny };
  };
  const pointAt = (a, b, tr, i) => {
    const t = (i + 1) / SAMPLES;
    return { x: a.x + (b.x - a.x) * t + tr.nx * tr.off[i], y: a.y + (b.y - a.y) * t + tr.ny * tr.off[i] };
  };

  // 1. move each corner to where the two edges meeting there actually meet
  const first = [0, 1, 2, 3].map((k) => trace(q[k], q[(k + 1) % 4]));
  const ends = (k, fromStart) => {
    const tr = first[k], a = q[k], b = q[(k + 1) % 4];
    const idx = fromStart ? [0, 1, 2, 3, 4] : [SAMPLES - 6, SAMPLES - 5, SAMPLES - 4, SAMPLES - 3, SAMPLES - 2];
    const pts = idx.filter((i) => tr.off[i] !== null).map((i) => pointAt(a, b, tr, i));
    return pts.length >= 3 ? lineThrough(pts) : null;
  };
  q = q.map((c, k) => {
    const into = ends((k + 3) % 4, false), out = ends(k, true);
    const p = into && out ? cross(into, out) : null;
    return p && Math.hypot(p.x - c.x, p.y - c.y) < maxMove && p.x >= 0 && p.y >= 0 && p.x <= w - 1 && p.y <= h - 1 ? p : c;
  });

  // 2. follow the sides again between the corrected corners
  let curved = false;
  const sides = [];
  for (let k = 0; k < 4; k++) {
    const a = q[k], b = q[(k + 1) % 4];
    const tr = trace(a, b);
    const valid = tr.off.filter((v) => v !== null).length;
    let o = median(fillGaps(tr.off), 5);
    const rough = o.reduce((s, v, i) => (i > 0 && i < o.length - 1 ? s + Math.abs(o[i - 1] - 2 * v + o[i + 1]) : s), 0) / Math.max(1, o.length - 2);
    const bow = Math.max(...o.map(Math.abs));
    // a bent edge leaves its corners gradually; a jump to another line (a header's edge, a fold)
    // shows as a sudden step near a corner, or a shape no gentle bend makes
    const full = [0, ...o, 0];
    let jump = 0; for (let i = 1; i < full.length; i++) jump = Math.max(jump, Math.abs(full[i] - full[i - 1]));
    const gentle = jump <= bow * 0.3 + 2 && bendFit(full) <= bow * 0.22 + 1;
    const isCurved = valid >= (SAMPLES - 1) * 0.6 && rough < 1.6 && gentle && bow >= Math.max(3, tr.len * 0.006);
    if (!isCurved) o = o.map(() => 0);
    else curved = true;
    const pts = [{ x: a.x, y: a.y }, ...o.map((d, i) => pointAt(a, b, { ...tr, off: o }, i)), { x: b.x, y: b.y }];
    sides.push(pts.map((p) => ({ x: p.x / (w - 1), y: p.y / (h - 1) })));
  }
  return { corners: q.map((p) => ({ x: p.x / (w - 1), y: p.y / (h - 1) })), sides: curved ? sides : null };
}

/** Least-squares line through points: { px, py, dx, dy }. */
function lineThrough(pts) {
  const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length, my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) { sxx += (p.x - mx) ** 2; sxy += (p.x - mx) * (p.y - my); syy += (p.y - my) ** 2; }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { px: mx, py: my, dx: Math.cos(ang), dy: Math.sin(ang) };
}
function cross(l1, l2) {
  const det = l1.dx * l2.dy - l1.dy * l2.dx;
  if (Math.abs(det) < 1e-6) return null;
  const t = ((l2.px - l1.px) * l2.dy - (l2.py - l1.py) * l2.dx) / det;
  return { x: l1.px + l1.dx * t, y: l1.py + l1.dy * t };
}

/** How far a side's offsets are from a gentle bend (the first three sine shapes between the corners): RMS. */
function bendFit(o) {
  const n = o.length - 1;
  const modes = [1, 2, 3].map((m) => o.map((_, i) => Math.sin((Math.PI * m * i) / n)));
  const fit = o.map(() => 0);
  for (const md of modes) {
    let num = 0, den = 0;
    for (let i = 0; i <= n; i++) { num += o[i] * md[i]; den += md[i] * md[i]; }
    const a = den ? num / den : 0;
    for (let i = 0; i <= n; i++) fit[i] += a * md[i];
  }
  let e = 0; for (let i = 0; i <= n; i++) e += (o[i] - fit[i]) ** 2;
  return Math.sqrt(e / (n + 1));
}

/** Fill unknown values (null) by straight lines between known ones; the ends (corners) are 0. */
function fillGaps(v) {
  const o = [0, ...v, 0];
  let last = 0;
  for (let i = 1; i < o.length; i++) {
    if (o[i] === null) continue;
    for (let j = last + 1; j < i; j++) o[j] = o[last] + ((o[i] - o[last]) * (j - last)) / (i - last);
    last = i;
  }
  return o.slice(1, -1);
}

function median(v, win) {
  const r = win >> 1;
  return v.map((_, i) => {
    const s = v.slice(Math.max(0, i - r), i + r + 1).sort((a, b) => a - b);
    return s[s.length >> 1];
  });
}

// ---------------------------------------------------------------- 2. straight lines of text
/** Blur along rows only (a running mean of 2r+1 pixels), so letters join up into lines but lines stay apart. */
function smearAcross(a, w, h, r) {
  const row = new Float32Array(w), div = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += a[o + clamp(i, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      row[x] = acc / div;
      acc += a[o + Math.min(x + r + 1, w - 1)] - a[o + Math.max(x - r, 0)];
    }
    a.set(row, o);
  }
}

/**
 * Work out how far each part of the page must move up or down so the lines of text lie straight.
 * Pass the flattened page with its light evened out (enhance 'gray'), about 1400 px. Returns a grid of vertical shifts
 * { cols, rows, d } (d in fractions of the page height, sampled over the page) or null when the
 * lines are already straight or can't be followed reliably.
 */
export function textLineField(img, { measureOnly = false } = {}) {
  const { width: w, height: h } = img;
  const L = luminance(img, 0);
  // ink: the page has had its light evened out (paper is white), so ink is simply the dark part
  const ink = new Float32Array(w * h);
  const mx = Math.round(w * 0.03), my = Math.round(h * 0.02);
  for (let y = my; y < h - my; y++) for (let x = mx; x < w - mx; x++) {
    const i = y * w + x;
    if (L[i] < 165) ink[i] = 1;
  }
  // smear each line of text into a band
  smearAcross(ink, w, h, Math.max(3, Math.round(w / 70)));

  // the spacing between lines, from the whole page
  // (in narrow strips: across a bent page the lines tilt, and a wide strip would blur them together)
  const profs = [0.15, 0.32, 0.5, 0.68, 0.85].map((c) => {
    const prof = new Float32Array(h), xa = Math.round(w * (c - 0.06)), xb = Math.round(w * (c + 0.06));
    for (let y = 0; y < h; y++) { let s = 0; for (let x = xa; x < xb; x++) s += ink[y * w + x]; prof[y] = s; }
    return prof;
  });
  const P = linePeriod(profs);
  if (!P) return null;

  // follow lines across vertical strips
  const K = 20, x0 = w * 0.04, x1 = w * 0.96, sw = (x1 - x0) / K;
  const peaks = [];
  const sm = Math.max(1, Math.round(P / 10));
  for (let k = 0; k < K; k++) {
    const p = new Float32Array(h);
    const xa = Math.round(x0 + k * sw), xb = Math.round(x0 + (k + 1) * sw);
    for (let y = 0; y < h; y++) { let s = 0; for (let x = xa; x < xb; x++) s += ink[y * w + x]; p[y] = s / (xb - xa); }
    boxBlur(p, 1, h, sm, 2);
    // a line counts if it has at least a third of the ink of a typical line here (not of the darkest block)
    const humps = [];
    for (let y = 1; y < h - 1; y++) if (p[y] > 0.02 && p[y] > p[y - 1] && p[y] >= p[y + 1]) humps.push(p[y]);   // a flat top counts once
    humps.sort((a, b) => a - b);
    const typical = humps.length ? humps[humps.length >> 1] : 1;
    const list = [];
    for (let y = 2; y < h - 2; y++) {
      if (p[y] < typical * 0.33 || p[y] < 0.02 || p[y] > 0.8 || p[y] < p[y - 1] || p[y] < p[y + 1]) continue;   // not solid blocks
      const a = p[y - 1], b = p[y], c = p[y + 1], den = a - 2 * b + c;
      const yy = den ? y + (0.5 * (a - c)) / den : y;          // centre of the peak, to a fraction of a pixel
      const prev = list[list.length - 1];
      if (prev && yy - prev.y < P * 0.6) { if (b > prev.v) list[list.length - 1] = { y: yy, v: b }; continue; }
      list.push({ y: yy, v: b });
    }
    peaks.push(list.map((q) => ({ y: q.y, used: false })));
  }
  const cx = (k) => x0 + (k + 0.5) * sw;
  // start lines from the strips with the most text, so columns and short lines are found too
  const order = [...peaks.keys()].sort((a, b) => peaks[b].length - peaks[a].length);
  const tracks = [];
  for (const seed of order) for (const start of peaks[seed]) {
    if (start.used) continue;
    const pts = [{ k: seed, y: start.y }];
    start.used = true;
    for (const dir of [1, -1]) {
      let k = seed, y = start.y, slope = 0, miss = 0;
      while (true) {
        k += dir;
        if (k < 0 || k >= K) break;
        const want = y + slope * dir;
        let best = null;
        for (const q of peaks[k]) if (!q.used && Math.abs(q.y - want) < P * 0.3 && (!best || Math.abs(q.y - want) < Math.abs(best.y - want))) best = q;
        if (best) {
          best.used = true;
          slope = 0.6 * slope + 0.4 * (best.y - y) * dir;
          y = best.y; miss = 0;
          pts.push({ k, y });
        } else if (++miss > 1) break;
        else y = want;
      }
    }
    if (pts.length < 6) continue;
    const deg = pts.length >= 12 ? 3 : pts.length >= 8 ? 2 : 1;
    const fit = polyFit(pts.map((p) => (cx(p.k) / w) * 2 - 1), pts.map((p) => p.y), deg);
    if (!fit || fit.rms > P * 0.1) continue;
    const ks = pts.map((p) => p.k);
    tracks.push({ fit, from: Math.min(...ks), to: Math.max(...ks), n: pts.length });
  }
  if (tracks.length < 3) return null;

  // the shift for each line where it runs: where the line is, minus where it should be
  const cols = K + 1, rows = 48;
  const colX = (c) => x0 + (c / (cols - 1)) * (x1 - x0);
  const lines = tracks.map((tr) => {
    const xa = cx(tr.from) - sw, xb = cx(tr.to) + sw;
    const ys = [];
    for (let c = 0; c < cols; c++) {
      const x = colX(c);
      ys.push(x < xa || x > xb ? null : evalPoly(tr.fit.c, (clamp(x, cx(tr.from), cx(tr.to)) / w) * 2 - 1));
    }
    const known = ys.filter((v) => v !== null);
    const ref = known.reduce((s, v) => s + v, 0) / known.length;
    return { ref, d: ys.map((y) => (y === null ? null : y - ref)), span: known.length };
  }).sort((a, b) => a.ref - b.ref);
  // a line that bends unlike its neighbours was followed wrongly (it slipped onto the next line)
  const kept = lines.filter((l, i) => {
    const near = lines.filter((m, j) => j !== i && Math.abs(j - i) <= 3);
    if (near.length < 2) return true;
    let worst = 0;
    for (let c = 0; c < cols; c++) {
      if (l.d[c] === null) continue;
      const vals = near.map((m) => m.d[c]).filter((v) => v !== null).sort((a, b) => a - b);
      if (vals.length >= 2) worst = Math.max(worst, Math.abs(l.d[c] - vals[vals.length >> 1]));
    }
    return worst <= Math.max(3, P * 0.3);
  });
  if (kept.length < 3) return null;
  // how bent: the typical long line, so a few badly followed lines cannot set it off
  const long = kept.filter((l) => l.span >= cols * 0.5);
  const typical = (f) => { const v = long.map(f).sort((a, b) => a - b); return v.length >= 4 ? v[v.length >> 1] : 0; };
  const bend = typical((l) => { const k = l.d.filter((v) => v !== null); return Math.max(...k) - Math.min(...k); });
  // curved, not just tilted: how far a line strays from the straight line through it. A flat page
  // whose corners are a little off has slightly tilted but straight lines; that is left alone.
  const curve = typical((l) => {
    const pts = []; l.d.forEach((v, c) => { if (v !== null) pts.push([c, v]); });
    const fit = polyFit(pts.map((p) => p[0]), pts.map((p) => p[1]), 1);
    return fit ? Math.max(...pts.map((p) => Math.abs(p[1] - evalPoly(fit.c, p[0])))) : 0;
  });
  if (measureOnly) return { bend, curve, lines: kept.length, period: P };
  // lines that fan out a lot (the corners were well off) are worth evening out too
  if (curve < Math.max(3, P * 0.1) && bend < Math.max(9, P * 0.3)) return null;   // flat: leave it alone
  lines.splice(0, lines.length, ...kept);
  const d = new Float32Array(rows * cols);
  const colLines = [];
  for (let c = 0; c < cols; c++) colLines.push(lines.filter((l) => l.d[c] !== null));
  for (let c = 0; c < cols; c++) {
    // a column no line crosses (a gap between text columns) borrows from the nearest that has lines
    let cc = c;
    for (let k = 1; !colLines[cc].length && k < cols; k++) cc = colLines[c - k]?.length ? c - k : colLines[c + k]?.length ? c + k : cc;
    const ls = colLines[cc];
    if (!ls.length) continue;
    for (let r = 0; r < rows; r++) {
      const y = (r / (rows - 1)) * (h - 1);
      let i = 0;
      while (i < ls.length && ls[i].ref < y) i++;
      let v;
      // above the first line and below the last, ease back to no shift at the page's edge, so the
      // edge stays put and nothing from beyond the page is pulled in
      if (i === 0) v = ls[0].d[cc] * clamp(y / Math.max(1, ls[0].ref), 0, 1);
      else if (i === ls.length) { const l = ls[ls.length - 1]; v = l.d[cc] * clamp((h - 1 - y) / Math.max(1, h - 1 - l.ref), 0, 1); }
      else { const a = ls[i - 1], b = ls[i], f = (y - a.ref) / (b.ref - a.ref); v = a.d[cc] + (b.d[cc] - a.d[cc]) * f; }
      d[r * cols + c] = v / (h - 1);
    }
  }
  boxBlur(d, cols, rows, 1, 2);
  return { cols, rows, d, bend, curve, lines: lines.length };
}

/**
 * The distance between lines of text, from a vertical ink profile, or 0: each line of text is a
 * hump with a dip before the next; the typical gap between neighbouring humps is the spacing.
 */
function linePeriod(profiles) {
  const gaps = [];
  for (const raw of profiles) gaps.push(...lineGaps(raw));
  if (gaps.length < 6) return 0;
  gaps.sort((a, b) => a - b);
  // the lower-middle gap: blank lines and paragraph breaks only ever make gaps longer
  const P = gaps[Math.floor(gaps.length * 0.2)];
  return P >= 5 && P < profiles[0].length / 6 ? P : 0;
}

/** The gaps between neighbouring lines of text in one vertical ink profile. */
function lineGaps(raw) {
  const n = raw.length;
  // cap it, so a solid block (a dark header, a photo) looks like any other line
  const sorted = Array.from(raw).filter((v) => v > 0).sort((a, b) => a - b);
  if (sorted.length < n * 0.05) return [];
  const cap = sorted[Math.floor(sorted.length * 0.8)];
  const p = Float32Array.from(raw, (v) => Math.min(v, cap));
  boxBlur(p, 1, n, Math.max(1, Math.round(n / 450)), 2);   // an underline belongs to its line
  // each line of text is a hump; neighbouring humps only count as two lines when there is a real
  // dip between them (a faint line next to a dark one still counts, a wobble on one line does not)
  let tops = [];
  for (let y = 1; y < n - 1; y++) {
    if (p[y] <= cap * 0.12 || p[y] <= p[y - 1] || p[y] < p[y + 1]) continue;
    let e = y; while (e + 1 < n && p[e + 1] === p[y]) e++;          // a flat top counts once, at its middle
    tops.push({ y: (y + e) / 2, v: p[y] });
    y = e;
  }
  const merged = [];
  for (const t of tops) {
    const prev = merged[merged.length - 1];
    if (prev) {
      let low = Infinity;
      for (let y = Math.round(prev.y); y <= Math.round(t.y); y++) low = Math.min(low, p[y]);
      if (low > Math.min(prev.v, t.v) * 0.7) { if (t.v > prev.v) merged[merged.length - 1] = t; continue; }
    }
    merged.push(t);
  }
  tops = merged.map((t) => t.y);
  const gaps = [];
  for (let i = 1; i < tops.length; i++) gaps.push(tops[i] - tops[i - 1]);
  return gaps;
}

/** Least-squares polynomial; returns { c, rms } (coefficients lowest power first). */
function polyFit(xs, ys, deg) {
  const n = deg + 1;
  const A = Array.from({ length: n }, () => new Float64Array(n + 1));
  for (let i = 0; i < xs.length; i++) {
    const pw = [1]; for (let k = 1; k < 2 * n; k++) pw.push(pw[k - 1] * xs[i]);
    for (let r = 0; r < n; r++) { for (let c = 0; c < n; c++) A[r][c] += pw[r + c]; A[r][n] += ys[i] * pw[r]; }
  }
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return null;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < n; r++) { if (r === c) continue; const f = A[r][c] / A[c][c]; for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k]; }
  }
  const coef = A.map((r, i) => r[n] / r[i]);
  let e = 0; for (let i = 0; i < xs.length; i++) e += (evalPoly(coef, xs[i]) - ys[i]) ** 2;
  return { c: coef, rms: Math.sqrt(e / xs.length) };
}
const evalPoly = (c, x) => c.reduceRight((s, v) => s * x + v, 0);

// ---------------------------------------------------------------- 3. one resampling for everything
/**
 * Straighten the page into a W×H image: perspective from the 4 corners, curved edges (Coons patch)
 * when `edges` is given, and straight text lines when `field` is given. `trim` cuts a sliver off
 * each side so no table shows at the edges.
 */
export function warpPage(src, corners, W, H, { edges = null, field = null, trim = 0 } = {}) {
  const { width: sw, height: sh, data: sd } = src;
  const img = corners.map((c) => ({ x: c.x * (sw - 1), y: c.y * (sh - 1) }));
  const unit = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const m = homography(unit, img);                 // flat page (0..1) → photo
  const out = new Uint8ClampedArray(W * H * 4);
  if (!m) return { width: W, height: H, data: out };
  // the curved edges, in flat-page coordinates
  let T = null, B = null, Lc = null, R = null;
  if (edges) {
    const inv = homography(img, unit);
    const toUnit = (p) => {
      const x = p.x * (sw - 1), y = p.y * (sh - 1), z = inv[6] * x + inv[7] * y + inv[8];
      return { x: (inv[0] * x + inv[1] * y + inv[2]) / z, y: (inv[3] * x + inv[4] * y + inv[5]) / z };
    };
    const side = (k) => edges[k].map(toUnit);
    T = side(0); R = side(1); B = side(2).reverse(); Lc = side(3).reverse();
  }
  const along = (pts, t) => {                       // point at t (0..1) along a list of equally spaced samples
    const f = clamp(t, 0, 1) * (pts.length - 1), i = Math.min(pts.length - 2, Math.floor(f)), r = f - i;
    return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * r, y: pts[i].y + (pts[i + 1].y - pts[i].y) * r };
  };
  const shift = (u, v) => {                         // the text-line shift at (u, v)
    const fx = clamp(u, 0, 1) * (field.cols - 1), fy = clamp(v, 0, 1) * (field.rows - 1);
    const x0 = Math.min(field.cols - 2, Math.floor(fx)), y0 = Math.min(field.rows - 2, Math.floor(fy)), ax = fx - x0, ay = fy - y0;
    const g = field.d, c = field.cols;
    return (g[y0 * c + x0] * (1 - ax) + g[y0 * c + x0 + 1] * ax) * (1 - ay) + (g[(y0 + 1) * c + x0] * (1 - ax) + g[(y0 + 1) * c + x0 + 1] * ax) * ay;
  };
  const tu = trim, span = 1 - 2 * trim;
  const Tu = [], Bu = [];
  for (let x = 0; x < W; x++) {
    const u = tu + (x / (W - 1)) * span;
    if (T) { Tu.push(along(T, u)); Bu.push(along(B, u)); }
  }
  for (let y = 0; y < H; y++) {
    const v0 = tu + (y / (H - 1)) * span;
    let o = y * W * 4;
    for (let x = 0; x < W; x++, o += 4) {
      const u = tu + (x / (W - 1)) * span;
      const v = field ? clamp(v0 + shift(u, v0), 0, 1) : v0;
      let X = u, Y = v;
      if (T) {
        const t = Tu[x], b = Bu[x], l = along(Lc, v), r = along(R, v);
        X = (1 - v) * t.x + v * b.x + (1 - u) * l.x + u * r.x - (u * (1 - v) + u * v);
        Y = (1 - v) * t.y + v * b.y + (1 - u) * l.y + u * r.y - ((1 - u) * v + u * v);
      }
      const Z = m[6] * X + m[7] * Y + m[8];
      const px = (m[0] * X + m[1] * Y + m[2]) / Z, py = (m[3] * X + m[4] * Y + m[5]) / Z;
      const x0 = px < 0 ? 0 : px > sw - 1.001 ? sw - 2 : px | 0, y0 = py < 0 ? 0 : py > sh - 1.001 ? sh - 2 : py | 0;
      const fx = clamp(px - x0, 0, 1), fy = clamp(py - y0, 0, 1);
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

/** A measure of how straight the text lines are: the largest bend of any line, in pixels (for tests). */
export function lineBend(img) {
  const f = textLineField(img, { measureOnly: true });
  return f ? f.bend : 0;
}
