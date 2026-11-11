/**
 * Printing. Each page is rendered to an image at print resolution
 * (including annotations and form values) and then sent to the Windows print dialog.
 */
const PRINT_DPI = 150;

export default {
  id: 'print',
  activate(ctx) {
    const { host, reader, commands, ui } = ctx;
    const { AnnotationMode, getDocument } = ctx.lib.pdfjs;
    let busy = false;

    async function print() {
      if (!reader.doc || busy) return;
      busy = true;
      // If features (e.g. Fill & Sign) add content on save, print exactly what would be saved.
      let doc = reader.doc;
      let tempDoc = null;
      if (reader.hasPendingTransforms) {
        tempDoc = await getDocument({ ...ctx.lib.documentOptions, data: await reader.getBytes() }).promise;
        doc = tempDoc;
      }
      const container = document.getElementById('printContainer');
      const urls = [];
      const progress = ui.progress('Preparing to print…');
      const style = document.createElement('style');
      try {
        const printStorage = tempDoc ? null : doc.annotationStorage.print;
        const first = await doc.getPage(1);
        const fv = first.getViewport({ scale: 1 });
        style.textContent = `@page { size: ${fv.width}pt ${fv.height}pt; margin: 0; }`;
        document.head.append(style);

        for (let n = 1; n <= doc.numPages; n++) {
          if (progress.cancelled) return;
          progress.update((n - 1) / doc.numPages, `Page ${n} of ${doc.numPages}`);
          const page = await doc.getPage(n);
          const viewport = page.getViewport({ scale: PRINT_DPI / 72 });
          const canvas = document.createElement('canvas');
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          const context = canvas.getContext('2d', { alpha: false });
          context.fillStyle = '#fff';
          context.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({
            canvasContext: context, viewport, intent: 'print',
            annotationMode: tempDoc ? AnnotationMode.ENABLE_FORMS : AnnotationMode.ENABLE_STORAGE, printAnnotationStorage: printStorage,
          }).promise;
          const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
          canvas.width = canvas.height = 0;
          const url = URL.createObjectURL(blob);
          urls.push(url);
          const img = new Image();
          img.src = url;
          const wrap = document.createElement('div');
          wrap.className = 'printed-page';
          wrap.append(img);
          container.append(wrap);
          await img.decode().catch(() => {});
        }
        progress.close();
        if (progress.cancelled) return;
        document.body.classList.add('printing');
        await host.print();
      } catch (err) {
        ctx.showError('Printing failed', err);
      } finally {
        progress.close();
        document.body.classList.remove('printing');
        container.replaceChildren();
        style.remove();
        urls.forEach((u) => URL.revokeObjectURL(u));
        tempDoc?.destroy();
        busy = false;
      }
    }

    commands.register({ id: 'file.print', label: 'Print…', menu: 'File', group: 'print', order: 300, accelerator: 'CmdOrCtrl+P', enabled: () => reader.hasDocument, run: print });
    ui.addButton({ slot: 'file', command: 'file.print', icon: 'print', title: 'Print', order: 30 });
  },
};
