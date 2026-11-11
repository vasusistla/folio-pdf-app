/**
 * Document Properties (Ctrl+D): title, author, dates, page size, file size…
 */
export default {
  id: 'properties',
  activate(ctx) {
    const { reader, commands, ui, h } = ctx;
    const { PDFDateString } = ctx.lib.pdfjs;

    async function show() {
      const doc = reader.doc;
      if (!doc) return;
      const [{ info }, page] = await Promise.all([doc.getMetadata().catch(() => ({ info: {} })), doc.getPage(reader.pageNumber || 1)]);
      const [x1, y1, x2, y2] = page.view;
      const wPt = Math.abs(x2 - x1), hPt = Math.abs(y2 - y1);
      const rows = [
        ['File name', reader.file.name],
        ['Location', reader.file.path || 'Not saved yet'],
        ['File size', formatBytes(reader.file.size)],
        ['Title', info?.Title],
        ['Author', info?.Author],
        ['Subject', info?.Subject],
        ['Keywords', info?.Keywords],
        ['Created', formatDate(info?.CreationDate)],
        ['Modified', formatDate(info?.ModDate)],
        ['Application', info?.Creator],
        ['PDF producer', info?.Producer],
        ['PDF version', info?.PDFFormatVersion],
        ['Pages', String(doc.numPages)],
        ['Page size', `${(wPt / 72 * 25.4).toFixed(0)} × ${(hPt / 72 * 25.4).toFixed(0)} mm  (${(wPt / 72).toFixed(2)} × ${(hPt / 72).toFixed(2)} in)${paperName(wPt, hPt)}`],
        ['Fast web view', info?.IsLinearized ? 'Yes' : 'No'],
        ['Has forms', info?.IsAcroFormPresent ? 'Yes' : 'No'],
      ];
      const table = h('table', { class: 'props' }, ...rows.map(([k, v]) => h('tr', {}, h('th', { text: k }), h('td', { text: v || '—' }))));
      ui.modal({ title: 'Document properties', body: table, width: '560px', buttons: [{ label: 'Close', value: true, primary: true }] });
    }

    function formatDate(s) {
      if (!s) return '';
      const d = PDFDateString.toDateObject(s);
      return d ? d.toLocaleString() : s;
    }

    commands.register({ id: 'file.properties', label: 'Document Properties…', menu: 'File', group: 'info', order: 600, accelerator: 'CmdOrCtrl+D', enabled: () => reader.hasDocument, run: show });
  },
};

function formatBytes(b) {
  if (!b && b !== 0) return '';
  if (b < 1024) return `${b} bytes`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

function paperName(w, h) {
  const [a, b] = [Math.min(w, h), Math.max(w, h)];
  const near = (x, y) => Math.abs(x - y) < 3;
  const sizes = { Letter: [612, 792], Legal: [612, 1008], A4: [595, 842], A3: [842, 1191], A5: [420, 595], Tabloid: [792, 1224] };
  for (const [name, [sw, sh]] of Object.entries(sizes)) if (near(a, sw) && near(b, sh)) return `, ${name}${w > h ? ' landscape' : ''}`;
  return '';
}
