/**
 * Page editing with pdf-lib: rotate, delete, move, insert blank, extract, and
 * combine (append other PDFs). Changes appear immediately and are written
 * to disk when you Save.
 *
 * This is the template for any future "edit the PDF structure" feature:
 *   await editDocument(async (pdf) => { ...change pdf (a pdf-lib PDFDocument)... });
 */
export default {
  id: 'pages',
  activate(ctx) {
    const { reader, commands, ui, host } = ctx;
    const { PDFDocument, degrees } = ctx.lib.pdfLib;
    const hasDoc = () => reader.hasDocument && reader.canEdit;
    const cur = () => reader.pageNumber;

    /** Load the current document into pdf-lib, let `mutate` change it, then show the result. */
    async function editDocument(mutate, { page } = {}) {
      const bytes = await reader.getBytes();
      let pdf;
      try {
        pdf = await PDFDocument.load(bytes, { updateMetadata: false });
      } catch (err) {
        if (/encrypt/i.test(err?.message || err?.name)) {
          throw new Error('Page editing isn’t available for password-protected or encrypted PDFs. You can still annotate them.');
        }
        throw err;
      }
      const result = await mutate(pdf);
      const out = await pdf.save();
      await reader.replaceBytes(out, { page: result?.page ?? page });
      return result;
    }
    ctx.provide('pages', { editDocument, parseRange });

    async function rotate(n, delta) {
      await editDocument((pdf) => {
        const p = pdf.getPage(n - 1);
        p.setRotation(degrees((((p.getRotation().angle + delta) % 360) + 360) % 360));
        return { page: n };
      });
    }

    async function remove(pages) {
      const sorted = [...new Set(pages)].sort((a, b) => b - a);
      if (sorted.length >= reader.pageCount) throw new Error('A PDF needs at least one page, so you can’t delete every page.');
      await editDocument((pdf) => {
        sorted.forEach((n) => pdf.removePage(n - 1));
        return { page: Math.min(Math.min(...sorted), pdf.getPageCount()) };
      });
      ui.toast(sorted.length === 1 ? `Page ${sorted[0]} deleted` : `${sorted.length} pages deleted`);
    }

    async function confirmDelete(n) {
      if (await ui.confirm('Delete page', `Delete page ${n}? You can get it back by closing without saving.`, { okLabel: 'Delete', danger: true })) await remove([n]);
    }

    async function move(n, delta) {
      const to = n + delta;
      if (to < 1 || to > reader.pageCount) return;
      await editDocument((pdf) => {
        const page = pdf.getPage(n - 1);
        pdf.removePage(n - 1);
        pdf.insertPage(to - 1, page);
        return { page: to };
      });
    }

    async function insertBlank(after) {
      await editDocument((pdf) => {
        const { width, height } = pdf.getPage(after - 1).getSize();
        pdf.insertPage(after, [width, height]);
        return { page: after + 1 };
      });
    }

    async function extract(pages) {
      const src = await PDFDocument.load(await reader.getBytes(), { updateMetadata: false }).catch((err) => {
        throw new Error(/encrypt/i.test(err?.message) ? 'Pages can’t be extracted from encrypted PDFs.' : err.message);
      });
      const out = await PDFDocument.create();
      const copied = await out.copyPages(src, pages.map((n) => n - 1));
      copied.forEach((p) => out.addPage(p));
      const base = (reader.file.name || 'document.pdf').replace(/\.pdf$/i, '');
      const label = pages.length === 1 ? `page ${pages[0]}` : `pages ${compactRange(pages)}`;
      const target = await host.showSaveDialog({ defaultPath: `${base} (${label}).pdf`, title: 'Save extracted pages as' });
      if (!target) return;
      const info = await host.writeFile(target, await out.save());
      ui.toast(`Saved ${info.name}`, { type: 'success', timeout: 6000, action: { label: 'Open', run: () => host.openPaths([info.path]) } });
    }

    async function appendFiles() {
      const paths = await host.showOpenDialog({ multi: true, title: 'Choose PDFs to add at the end' });
      if (!paths.length) return;
      const firstNew = reader.pageCount + 1;
      await editDocument(async (pdf) => {
        for (const p of paths) {
          const file = await host.readFile(p);
          const other = await PDFDocument.load(file.data, { updateMetadata: false }).catch(() => {
            throw new Error(`"${file.name}" can’t be added: it’s encrypted or damaged.`);
          });
          const copied = await pdf.copyPages(other, other.getPageIndices());
          copied.forEach((pg) => pdf.addPage(pg));
        }
        return { page: firstNew };
      });
      ui.toast(`Added ${paths.length === 1 ? '1 file' : `${paths.length} files`}`, { type: 'success' });
    }

    async function askRange(title, okLabel) {
      const v = await ui.prompt({
        title, okLabel, label: `Pages (1–${reader.pageCount})`, value: String(cur()),
        placeholder: 'e.g. 1-3, 5, 8-10', hint: 'Use commas and dashes, e.g. 1-3, 5, 8-10',
      });
      if (v === null) return null;
      const pages = parseRange(v, reader.pageCount);
      if (!pages.length) { ui.alert(title, 'Please enter page numbers that exist in this document.'); return null; }
      return pages;
    }

    // ------------------------------------------------------------ menu
    const reg = (id, label, group, order, run, extra = {}) => commands.register({ id, label, menu: 'Pages', group, order, enabled: hasDoc, run, ...extra });
    reg('pages.rotate-cw', 'Rotate Page Clockwise', 'rotate', 10, () => rotate(cur(), 90));
    reg('pages.rotate-ccw', 'Rotate Page Counterclockwise', 'rotate', 20, () => rotate(cur(), -90));
    reg('pages.move-up', 'Move Page Up', 'move', 30, () => move(cur(), -1), { enabled: () => hasDoc() && cur() > 1 });
    reg('pages.move-down', 'Move Page Down', 'move', 40, () => move(cur(), 1), { enabled: () => hasDoc() && cur() < reader.pageCount });
    reg('pages.insert-blank', 'Insert Blank Page After', 'insert', 50, () => insertBlank(cur()));
    reg('pages.append', 'Add PDF Files at the End…', 'insert', 60, appendFiles);
    reg('pages.extract', 'Extract Pages to a New File…', 'extract', 70, async () => { const p = await askRange('Extract pages', 'Extract'); if (p) await extract(p); });
    reg('pages.delete', 'Delete Page…', 'delete', 80, () => confirmDelete(cur()), { enabled: () => hasDoc() && reader.pageCount > 1 });
    reg('pages.delete-range', 'Delete Pages…', 'delete', 90, async () => {
      const p = await askRange('Delete pages', 'Delete');
      if (p && await ui.confirm('Delete pages', `Delete ${p.length === 1 ? 'page ' + p[0] : p.length + ' pages'}?`, { okLabel: 'Delete', danger: true })) await remove(p);
    }, { enabled: () => hasDoc() && reader.pageCount > 1 });

    // ------------------------------------------------------------ thumbnail right-click
    const act = (label, group, run, extra = {}) => ui.addPageAction({ label, group, run, enabled: () => hasDoc(), ...extra });
    act('Rotate clockwise', 'rotate', (n) => rotate(n, 90));
    act('Rotate counterclockwise', 'rotate', (n) => rotate(n, -90));
    act('Move up', 'move', (n) => move(n, -1), { enabled: (n) => hasDoc() && n > 1 });
    act('Move down', 'move', (n) => move(n, 1), { enabled: (n) => hasDoc() && n < reader.pageCount });
    act('Insert blank page after', 'insert', (n) => insertBlank(n));
    act('Extract this page…', 'insert', (n) => extract([n]));
    act('Delete page', 'delete', (n) => confirmDelete(n), { danger: true, enabled: () => hasDoc() && reader.pageCount > 1 });
  },
};

/** "1-3, 5, 8-" → [1,2,3,5,8,9,…] limited to 1..max */
export function parseRange(text, max) {
  const out = new Set();
  for (const part of String(text).replace(/\s*[-–]\s*/g, '-').split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d*)-(\d*)$/);
    if (m) {
      const a = m[1] ? parseInt(m[1], 10) : 1;
      const b = m[2] ? parseInt(m[2], 10) : max;
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 1 && i <= max) out.add(i);
    } else if (/^\d+$/.test(part)) {
      const n = parseInt(part, 10);
      if (n >= 1 && n <= max) out.add(n);
    }
  }
  return [...out].sort((a, b) => a - b);
}

function compactRange(pages) {
  const parts = [];
  for (let i = 0; i < pages.length; i++) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
    parts.push(i === j ? `${pages[i]}` : `${pages[i]}-${pages[j]}`);
    i = j;
  }
  return parts.join(',');
}
