/**
 * Sidebar shell: show/hide, resize, and remember the active panel.
 * Panels themselves (thumbnails, bookmarks…) are added with ctx.ui.addPanel().
 */
export default {
  id: 'sidebar',
  activate(ctx) {
    const { commands, ui, reader } = ctx;
    const body = document.body;
    const sidebar = document.getElementById('sidebar');
    const resizer = document.getElementById('sidebarResizer');
    let open = ctx.settings.sidebarOpen !== false;

    const apply = () => {
      body.classList.toggle('sidebar-open', open);
      document.documentElement.style.setProperty('--sidebar-w', `${ctx.settings.sidebarWidth || 220}px`);
      // Let the viewer re-fit after the layout change.
      requestAnimationFrame(() => reader.pdfViewer.update?.());
    };
    const toggle = (force) => {
      open = typeof force === 'boolean' ? force : !open;
      ctx.saveSettings({ sidebarOpen: open });
      apply();
      commands.refresh();
    };

    commands.register({
      id: 'view.sidebar', label: 'Sidebar', menu: 'View', group: 'panes', order: 10, type: 'checkbox',
      keys: ['F4'], showKeyInMenu: true, checked: () => open, run: () => toggle(),
    });
    ui.addButton({ slot: 'sidebar', command: 'view.sidebar', icon: 'sidebar', title: 'Show or hide sidebar', toggle: true, order: 10 });

    ui.on('panel', (id) => {
      ctx.saveSettings({ sidebarTab: id });
      if (!open) toggle(true);
    });
    ctx.provide('sidebar', { toggle, get open() { return open; } });

    // Drag to resize
    resizer.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      resizer.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = sidebar.getBoundingClientRect().width;
      body.classList.add('resizing');
      const move = (ev) => {
        const w = Math.max(150, Math.min(480, startW + ev.clientX - startX));
        document.documentElement.style.setProperty('--sidebar-w', `${w}px`);
      };
      const up = () => {
        resizer.removeEventListener('pointermove', move);
        resizer.removeEventListener('pointerup', up);
        body.classList.remove('resizing');
        ctx.saveSettings({ sidebarWidth: Math.round(sidebar.getBoundingClientRect().width) });
        reader.pdfViewer.update?.();
        ui.emit('sidebar-resized');
      };
      resizer.addEventListener('pointermove', move);
      resizer.addEventListener('pointerup', up);
    });

    // Restore the last-used panel once all panels have registered.
    ui.on('ready', () => {
      if (ctx.settings.sidebarTab) ui.showPanel(ctx.settings.sidebarTab, { silent: true });
    });
    apply();
  },
};
