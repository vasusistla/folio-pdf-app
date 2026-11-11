/**
 * Scan: make PDFs from the camera or from photos, and make scanned PDFs searchable.
 *
 *   File → Scan to PDF… (Ctrl+Shift+N)        camera, then review, then save
 *   File → PDF from Photos…                     pick photos, review, save
 *   Pages → Add Pages from Camera or Photos…    the same, adding to the open PDF
 *   Pages → Recognize Text (Make Searchable)…   OCR for image-only pages of the open PDF
 *   Drop photos on the window                   opens the scanner with them
 *
 * Provides the 'scan' service: ctx.use('scan').open({ start, files, addTo }), .addFiles(files), .isOpen
 */
import { Scanner } from './scanner.js';
import { recognize, addTextLayer } from './ocr.js';

export const PHOTO = /\.(jpe?g|png|webp|bmp|gif|heic|heif)$/i;

export default {
  id: 'scan',
  activate(ctx) {
    const { commands, ui, reader, h } = ctx;
    let current = null;

    async function open(opts = {}) {
      if (current) { if (opts.files?.length) current.addFiles(opts.files); return; }
      current = new Scanner(ctx, opts);
      try {
        await current.open();
      } finally {
        current = null;
        commands.refresh();
      }
    }
    ctx.provide('scan', {
      open,
      addFiles: (files) => (current ? current.addFiles(files) : open({ files })),
      get isOpen() { return !!current; },
    });

    const canAdd = () => reader.hasDocument && reader.canEdit;
    commands.register({
      id: 'scan.camera', label: 'Scan to PDF…', menu: 'File', group: 'open', order: 40, accelerator: 'CmdOrCtrl+Shift+N',
      run: () => open({ start: 'camera' }),
    });
    commands.register({
      id: 'scan.photos', label: 'PDF from Photos…', menu: 'File', group: 'open', order: 41,
      run: () => open({ start: 'photos' }),
    });
    commands.register({
      id: 'scan.add', label: 'Add Pages from Camera or Photos…', menu: 'Pages', group: 'scan', order: 300,
      enabled: canAdd, run: () => open({ start: 'camera', addTo: true }),
    });
    commands.register({
      id: 'scan.recognize', label: 'Recognize Text (Make Searchable)…', menu: 'Pages', group: 'scan', order: 310,
      enabled: canAdd, run: recognizeDocument,
    });
    ui.addButton({ slot: 'file', command: 'scan.camera', icon: 'camera', title: 'Scan to PDF', order: 12 });
    ui.addPageAction({ label: 'Insert Scanned Pages After…', group: 'insert', enabled: canAdd, run: (n) => { reader.goToPage(n); open({ start: 'camera', addTo: true }); } });

    // the welcome screen: Scan next to Open
    const openBtn = document.getElementById('welcomeOpen');
    if (openBtn) {
      openBtn.after(h('button', { class: 'btn big', id: 'welcomeScan', type: 'button', html: `${ctx.icon('camera', { size: 18 })}<span>Scan a document…</span>`, onClick: () => open({ start: 'camera' }) }));
      const hint = document.querySelector('.welcome-hint');
      if (hint) hint.textContent = 'or drag a PDF, or photos of pages, anywhere onto this window';
    }

    // ---------------------------------------------------------------- Recognize Text
    /**
     * Read the text on pages that are only pictures (scans), and add it as invisible
     * text so the PDF can be searched and copied. Pages that already have text are left alone.
     */
    async function recognizeDocument() {
      const doc = reader.doc;
      const n = reader.pageCount;
      const prog = ui.progress('Recognizing text');
      const found = new Map();
      let skipped = 0;
      try {
        for (let i = 1; i <= n; i++) {
          if (prog.cancelled) return;
          prog.update((i - 1) / n, `Page ${i} of ${n}: looking for text`);
          const page = await doc.getPage(i);
          const content = await page.getTextContent();
          const chars = content.items.reduce((s, it) => s + (it.str?.trim().length || 0), 0);
          if (chars > 20) { skipped++; continue; }                 // already has real text
          // render upright at about 300 dpi
          const base = page.getViewport({ scale: 1 });
          const scale = Math.min(300 / 72, 3300 / Math.max(base.width, base.height));
          const vp = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
          const g = canvas.getContext('2d');
          g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: g, viewport: vp, annotationMode: ctx.lib.pdfjs.AnnotationMode.DISABLE }).promise;
          prog.update((i - 0.5) / n, `Page ${i} of ${n}: reading the text`);
          const ocr = await recognize(canvas, { width: canvas.width, height: canvas.height });
          if (ocr.lines.length) found.set(i, { ocr, vp });
          canvas.width = canvas.height = 0;
        }
        prog.update(1, 'Adding the text to the PDF');
        if (!found.size) {
          prog.close();
          ui.alert('Recognize text', skipped === n
            ? 'Every page already has text you can search and select, so there was nothing to do.'
            : 'No readable text was found on the picture-only pages. Recognition works best on clear, upright pages in English.');
          return;
        }
        const { pdfLib } = ctx.lib;
        await ctx.use('pages').editDocument(async (pdf) => {
          const font = await pdf.embedFont(pdfLib.StandardFonts.Helvetica);
          for (const [i, { ocr, vp }] of found) {
            const map = { scale: 1 / vp.scale, point: (x, y) => { const [px, py] = vp.convertToPdfPoint(x, y); return { x: px, y: py }; } };
            addTextLayer(pdfLib, pdf.getPage(i - 1), font, ocr, map);
          }
        });
        prog.close();
        ui.toast(`Text recognized on ${found.size} ${found.size === 1 ? 'page' : 'pages'}${skipped ? ` (${skipped} already had text)` : ''}. Save to keep it.`, { timeout: 5000 });
      } catch (err) {
        prog.close();
        throw err;
      }
    }
  },
};
