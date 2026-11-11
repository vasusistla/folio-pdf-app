/**
 * Pages → Add Page Numbers…
 *
 * Kept deliberately small: it is the worked example in DEVELOPER.md for
 * "how do I add a new edit feature?". It shows the three usual parts:
 *   1. register a command (menu item + action)
 *   2. ask the user for input with ctx.ui
 *   3. change the PDF with pdf-lib through ctx.use('pages').editDocument()
 */
export default {
  id: 'page-numbers',
  activate(ctx) {
    const { commands, reader, ui } = ctx;
    const { StandardFonts, rgb, degrees } = ctx.lib.pdfLib;

    commands.register({
      id: 'pages.add-numbers',
      label: 'Add Page Numbers…',
      menu: 'Pages',
      group: 'stamp',
      order: 75,
      enabled: () => reader.hasDocument && reader.canEdit,
      run: async () => {
        const format = await ui.prompt({
          title: 'Add page numbers',
          label: 'Text to print at the bottom of each page',
          value: 'Page {n} of {total}',
          hint: '{n} is replaced by the page number and {total} by the number of pages.',
          okLabel: 'Add',
        });
        if (format === null || !format.trim()) return;

        await ctx.use('pages').editDocument(async (pdf) => {
          const font = await pdf.embedFont(StandardFonts.Helvetica);
          const pages = pdf.getPages();
          const size = 10;
          const margin = 22;
          pages.forEach((page, i) => {
            const text = format.replaceAll('{n}', String(i + 1)).replaceAll('{total}', String(pages.length));
            const tw = font.widthOfTextAtSize(text, size);
            const { width: w, height: h } = page.getSize();
            const angle = ((page.getRotation().angle % 360) + 360) % 360;
            // Place the text at the bottom centre as the page is *displayed*, whatever its rotation.
            const pos = {
              0: { x: (w - tw) / 2, y: margin },
              90: { x: w - margin, y: (h - tw) / 2 },
              180: { x: (w + tw) / 2, y: h - margin },
              270: { x: margin, y: (h + tw) / 2 },
            }[angle] || { x: (w - tw) / 2, y: margin };
            page.drawText(text, { ...pos, size, font, color: rgb(0.35, 0.35, 0.38), rotate: degrees(angle) });
          });
        });
        ui.toast('Page numbers added. Save to keep them.', { type: 'success' });
      },
    });
  },
};
