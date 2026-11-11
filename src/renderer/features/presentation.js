/**
 * Presentation mode (F5): full screen, one page at a time, click or arrow keys to advance.
 */
export default {
  id: 'presentation',
  activate(ctx) {
    const { reader, commands, ui, host } = ctx;
    const { ScrollMode, SpreadMode } = ctx.lib.viewer;
    const { AnnotationEditorType } = ctx.lib.pdfjs;
    const v = reader.pdfViewer;
    let saved = null;
    let hideTimer = null;
    let wheelLock = 0;

    async function enter() {
      if (!reader.hasDocument || saved) return;
      if (reader.editorMode !== AnnotationEditorType.NONE) reader.setEditorMode(AnnotationEditorType.NONE);
      saved = { scroll: v.scrollMode, spread: v.spreadMode, scale: v.currentScaleValue, page: reader.pageNumber };
      document.body.classList.add('presenting');
      ctx.use('search')?.close();
      await host.setFullScreen(true);
      v.scrollMode = ScrollMode.PAGE;
      v.spreadMode = SpreadMode.NONE;
      setTimeout(() => { v.currentScaleValue = 'page-fit'; reader.goToPage(saved?.page || 1); }, 350);
      window.addEventListener('resize', refit);
      reader.container.addEventListener('mousemove', showCursor);
      reader.container.addEventListener('click', onClick);
      reader.container.addEventListener('wheel', onWheel, { passive: false });
      showCursor();
      ui.toast('Presentation mode: press Esc to exit', { timeout: 2200 });
    }

    async function exit() {
      if (!saved) return;
      const s = saved;
      saved = null;
      window.removeEventListener('resize', refit);
      reader.container.removeEventListener('mousemove', showCursor);
      reader.container.removeEventListener('click', onClick);
      reader.container.removeEventListener('wheel', onWheel);
      clearTimeout(hideTimer);
      document.body.classList.remove('presenting', 'hide-cursor');
      const page = reader.pageNumber;
      await host.setFullScreen(false);
      v.scrollMode = s.scroll;
      v.spreadMode = s.spread;
      setTimeout(() => { v.currentScaleValue = s.scale; reader.goToPage(page); }, 300);
    }

    const refit = () => { if (saved) v.currentScaleValue = 'page-fit'; };
    function showCursor() {
      document.body.classList.remove('hide-cursor');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => document.body.classList.add('hide-cursor'), 2000);
    }
    function onClick(e) {
      if (e.target.closest('a, .annotationLayer section')) return;
      if (e.clientX < window.innerWidth * 0.25) reader.previousPage(); else reader.nextPage();
    }
    function onWheel(e) {
      if (e.ctrlKey) return;
      e.preventDefault();
      const now = Date.now();
      if (now - wheelLock < 250 || Math.abs(e.deltaY) < 4) return;
      wheelLock = now;
      if (e.deltaY > 0) reader.nextPage(); else reader.previousPage();
    }

    const presenting = () => !!saved;
    commands.register({
      id: 'view.present', label: 'Presentation Mode', menu: 'View', group: 'window', order: 890,
      keys: ['F5'], showKeyInMenu: true, type: 'checkbox', checked: presenting, enabled: () => reader.hasDocument,
      run: () => (saved ? exit() : enter()),
    });
    commands.register({ id: 'present.exit', label: 'Exit Presentation', keys: ['Escape'], keyWhen: presenting, run: exit });
    commands.register({ id: 'present.next', label: 'Next Slide', keys: [' ', 'PageDown', 'ArrowDown', 'ArrowRight', 'Enter'], keyWhen: presenting, run: () => reader.nextPage() });
    commands.register({ id: 'present.prev', label: 'Previous Slide', keys: ['Backspace', 'PageUp', 'ArrowUp', 'ArrowLeft'], keyWhen: presenting, run: () => reader.previousPage() });
    ui.addButton({ slot: 'tools', command: 'view.present', icon: 'present', title: 'Presentation mode', order: 20 });
    ctx.provide('presentation', { enter, exit, get active() { return presenting(); } });
  },
};
