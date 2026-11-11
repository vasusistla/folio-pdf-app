/**
 * Page navigation: toolbar page box, previous/next, first/last, Go to Page.
 */
export default {
  id: 'navigation',
  activate(ctx) {
    const { reader, commands, ui, h } = ctx;
    const { AnnotationEditorType } = ctx.lib.pdfjs;
    const hasDoc = () => reader.hasDocument;
    const notEditing = () => reader.editorMode === AnnotationEditorType.NONE && !reader.editorState.hasSelectedEditor;
    const noHorizontalScroll = () => reader.container.scrollWidth <= reader.container.clientWidth + 1;

    commands.defineSubmenu({ menu: 'View', label: 'Go To', group: 'nav', order: 400 });
    commands.register({
      id: 'nav.prev', label: 'Previous Page', menu: 'View/Go To', group: 'step', order: 10,
      keys: ['ArrowLeft'], keyWhen: () => notEditing() && noHorizontalScroll(), hideKeys: true,
      enabled: () => hasDoc() && reader.pageNumber > 1, run: () => reader.previousPage(),
    });
    commands.register({
      id: 'nav.next', label: 'Next Page', menu: 'View/Go To', group: 'step', order: 20,
      keys: ['ArrowRight'], keyWhen: () => notEditing() && noHorizontalScroll(), hideKeys: true,
      enabled: () => hasDoc() && reader.pageNumber < reader.pageCount, run: () => reader.nextPage(),
    });
    commands.register({
      id: 'nav.first', label: 'First Page', menu: 'View/Go To', group: 'ends', order: 30, keys: ['Home', 'Ctrl+Home'], showKeyInMenu: true, keyWhen: notEditing,
      enabled: hasDoc, run: () => reader.goToPage(1),
    });
    commands.register({
      id: 'nav.last', label: 'Last Page', menu: 'View/Go To', group: 'ends', order: 40, keys: ['End', 'Ctrl+End'], showKeyInMenu: true, keyWhen: notEditing,
      enabled: hasDoc, run: () => reader.goToPage(reader.pageCount),
    });
    commands.register({
      id: 'nav.goto', label: 'Go to Page…', menu: 'View/Go To', group: 'goto', order: 50, accelerator: 'CmdOrCtrl+G', enabled: hasDoc,
      run: async () => {
        const v = await ui.prompt({ title: 'Go to page', label: `Page number (1–${reader.pageCount})`, value: String(reader.pageNumber), okLabel: 'Go' });
        const n = parseInt(v, 10);
        if (Number.isFinite(n)) reader.goToPage(n);
      },
    });

    // Toolbar: ‹ [ 3 ] / 12 ›
    ui.addButton({ slot: 'nav', command: 'nav.prev', icon: 'up', title: 'Previous page', order: 10 });
    const input = h('input', { class: 'page-input', type: 'text', inputmode: 'numeric', 'aria-label': 'Page number', value: '' });
    const total = h('span', { class: 'page-total', text: '' });
    ui.addToolbarElement('nav', h('div', { class: 'page-box' }, input, total), 20);
    ui.addButton({ slot: 'nav', command: 'nav.next', icon: 'down', title: 'Next page', order: 30 });

    const sync = () => {
      input.value = hasDoc() ? String(reader.pageNumber) : '';
      total.textContent = hasDoc() ? `/ ${reader.pageCount}` : '';
      input.style.width = `${Math.max(2, String(reader.pageCount).length) + 1.6}ch`;
    };
    const commit = () => {
      const n = parseInt(input.value, 10);
      if (Number.isFinite(n)) reader.goToPage(n);
      sync();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { commit(); reader.container.focus(); }
      if (e.key === 'Escape') { sync(); reader.container.focus(); }
    });
    input.addEventListener('blur', commit);
    input.addEventListener('focus', () => input.select());
    reader.on('page', sync);
    reader.on('open', sync);
    reader.on('close', sync);
  },
};
