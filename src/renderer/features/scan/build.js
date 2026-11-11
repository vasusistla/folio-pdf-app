/**
 * Turning processed scan pages into PDF pages with pdf-lib.
 */
import { addTextLayer, boxMap } from './ocr.js';

const IN = 72;
export const PAPER = {
  letter: { label: 'Letter (8.5 × 11 in)', w: 8.5 * IN, h: 11 * IN },
  a4: { label: 'A4 (210 × 297 mm)', w: 595.28, h: 841.89 },
  legal: { label: 'Legal (8.5 × 14 in)', w: 8.5 * IN, h: 14 * IN },
};

/**
 * The page size for a scanned picture.
 *  auto:   Letter, A4 or Legal when the page is that shape (portrait or landscape);
 *          otherwise the picture's own shape, fitting within Letter (receipts, cards).
 *  letter / a4 / legal: that paper, turned to match the picture, the picture fitted inside.
 * Returns { width, height, box: { x, y, width, height } } in points.
 */
export function pageLayout(aspect, size = 'auto') {
  const landscape = aspect > 1;
  const fitIn = (W, H) => {
    const s = Math.min(W / aspect, H);           // picture height that fits
    const ih = s, iw = s * aspect;
    return { width: W, height: H, box: { x: (W - iw) / 2, y: (H - ih) / 2, width: iw, height: ih } };
  };
  const paper = (p) => (landscape ? [p.h, p.w] : [p.w, p.h]);
  if (size !== 'auto' && PAPER[size]) return fitIn(...paper(PAPER[size]));
  for (const key of ['letter', 'a4', 'legal']) {
    const [W, H] = paper(PAPER[key]);
    if (Math.abs(aspect / (W / H) - 1) < 0.035) return { width: W, height: H, box: { x: 0, y: 0, width: W, height: H } };
  }
  // its own shape: as big as fits on a Letter page
  const [W, H] = paper(PAPER.letter);
  const s = Math.min(W / aspect, H);
  const w = Math.round(s * aspect * 100) / 100, h = Math.round(s * 100) / 100;
  return { width: w, height: h, box: { x: 0, y: 0, width: w, height: h } };
}

/**
 * Add scanned pages to a pdf-lib document.
 * pages: [{ blob (JPEG), width, height, ocr? }] in order; `at` = index to insert at (default: the end).
 */
export async function addScannedPages(pdfLib, pdf, pages, { size = 'auto', at } = {}) {
  const font = pages.some((p) => p.ocr) ? await pdf.embedFont(pdfLib.StandardFonts.Helvetica) : null;
  let index = at ?? pdf.getPageCount();
  for (const p of pages) {
    const bytes = new Uint8Array(await p.blob.arrayBuffer());
    const img = p.blob.type === 'image/png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
    const layout = pageLayout(p.width / p.height, size);
    const page = pdf.insertPage(index++, [layout.width, layout.height]);
    page.drawImage(img, layout.box);
    if (p.ocr && font) addTextLayer(pdfLib, page, font, p.ocr, boxMap(p.ocr, layout.box));
  }
  return index;
}

/** A new PDF from scanned pages. */
export async function buildPdf(pdfLib, pages, { size = 'auto', title } = {}) {
  const pdf = await pdfLib.PDFDocument.create();
  await addScannedPages(pdfLib, pdf, pages, { size });
  if (title) pdf.setTitle(title, { showInWindowTitleBar: false });
  pdf.setCreator('Folio PDF (scanned)');
  pdf.setProducer('Folio PDF');
  const now = new Date();
  pdf.setCreationDate(now);
  pdf.setModificationDate(now);
  return pdf.save();
}
