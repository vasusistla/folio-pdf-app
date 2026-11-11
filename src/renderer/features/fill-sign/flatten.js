/**
 * Writes Fill & Sign items into the page content with pdf-lib ("flattening"), so they look the
 * same in every PDF reader and printer and can't be nudged around by accident afterwards.
 *
 * Items are stored in base display space (points, top-left origin, page /Rotate applied).
 * Each point is converted to PDF user space with PDF.js's own viewport maths, and text/images
 * are rotated with the page so they appear upright exactly where they were on screen.
 */

// Arial/Helvetica metrics: where the baseline sits in a line box of 1.2 × font size
export const LINE_HEIGHT = 1.2;
export const BASELINE = 0.9465;

// Mark shapes in a 0..1 box (shared with the on-screen SVG)
export const MARKS = {
  check: [[[0.14, 0.55], [0.4, 0.8], [0.88, 0.2]]],
  cross: [[[0.2, 0.2], [0.8, 0.8]], [[0.8, 0.2], [0.2, 0.8]]],
};

export async function flattenItems(bytes, pdfjsDoc, items, images, pdfLib) {
  const { PDFDocument, StandardFonts, rgb, degrees, LineCapStyle } = pdfLib;
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const embedded = new Map();
  const replaced = new Set();

  for (const it of items) {
    if (it.page < 1 || it.page > pdf.getPageCount()) continue;
    const pdfjsPage = await pdfjsDoc.getPage(it.page);
    const vp = pdfjsPage.getViewport({ scale: 1, rotation: pdfjsPage.rotate });
    const page = pdf.getPage(it.page - 1);
    const rotate = degrees(pdfjsPage.rotate);
    const at = (x, y) => { const [px, py] = vp.convertToPdfPoint(x, y); return { x: px, y: py }; };
    const color = hexToRgb(rgb, it.color || '#000000');

    if (it.type === 'text') {
      const lines = String(it.text || '').split('\n');
      lines.forEach((line, i) => {
        const safe = encodable(font, line, replaced);
        if (!safe.trim()) return;
        const p = at(it.x, it.y + i * LINE_HEIGHT * it.size + BASELINE * it.size);
        page.drawText(safe, { ...p, size: it.size, font, color, rotate });
      });
    } else if (it.type === 'mark') {
      const P = (fx, fy) => at(it.x + fx * it.w, it.y + fy * it.h);
      if (it.mark === 'dot') {
        page.drawCircle({ ...P(0.5, 0.5), size: it.w * 0.28, color });
      } else {
        const thickness = Math.max(0.8, it.w * 0.12);
        for (const poly of MARKS[it.mark] || []) {
          for (let k = 0; k < poly.length - 1; k++) {
            page.drawLine({ start: P(...poly[k]), end: P(...poly[k + 1]), thickness, color, lineCap: LineCapStyle.Round });
          }
        }
      }
    } else if (it.type === 'image') {
      const src = images.get(it.imageId);
      if (!src) continue;
      let img = embedded.get(it.imageId);
      if (!img) { img = await pdf.embedPng(src); embedded.set(it.imageId, img); }
      // anchor at the image's bottom-left as displayed, rotated with the page
      page.drawImage(img, { ...at(it.x, it.y + it.h), width: it.w, height: it.h, rotate });
    }
  }
  return { bytes: await pdf.save(), replaced: [...replaced] };
}

/** Standard PDF fonts only cover Western characters; anything else becomes "?" (and is reported). */
function encodable(font, text, replaced) {
  try {
    font.encodeText(text);
    return text;
  } catch {
    return [...text].map((ch) => {
      try { font.encodeText(ch); return ch; } catch { replaced.add(ch); return '?'; }
    }).join('');
  }
}

function hexToRgb(rgb, hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const n = m ? parseInt(m[1], 16) : 0;
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}
