/**
 * One place that loads the third-party PDF libraries, so features import
 * them from here rather than from node_modules paths.
 *
 *   pdfjsLib  Mozilla PDF.js: parsing, rendering, text, annotation editing (Apache-2.0)
 *   viewer    PDF.js viewer components: PDFViewer, find controller, links
 *   pdfLib    pdf-lib: page-level editing such as delete, rotate, merge (MIT)
 */
import * as pdfjsLib from '../../../node_modules/pdfjs-dist/legacy/build/pdf.min.mjs';
import * as viewer from '../../../node_modules/pdfjs-dist/legacy/web/pdf_viewer.mjs';
import * as pdfLib from '../../../node_modules/pdf-lib/dist/pdf-lib.esm.min.js';

const base = (p) => new URL(`../../../node_modules/pdfjs-dist/${p}`, import.meta.url).href;

pdfjsLib.GlobalWorkerOptions.workerSrc = base('legacy/build/pdf.worker.min.mjs');

/** Options passed to every pdfjsLib.getDocument() call. */
export const DOCUMENT_OPTIONS = {
  cMapUrl: base('cmaps/'),
  cMapPacked: true,
  standardFontDataUrl: base('standard_fonts/'),
  wasmUrl: base('wasm/'),
  iccUrl: base('iccs/'),
  isEvalSupported: false,   // keeps the strict Content-Security-Policy intact
  enableXfa: true,
  useSystemFonts: true,
};

export const IMAGE_RESOURCES = base('legacy/web/images/');

export { pdfjsLib, viewer, pdfLib };
