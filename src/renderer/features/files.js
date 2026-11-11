/**
 * Opening files: Open dialog, recent files, drag & drop, the welcome screen,
 * New Window and Close. Provides the 'files' service:
 *   ctx.use('files').openPath(path)
 */
export default {
  id: 'files',
  activate(ctx) {
    const { host, reader, commands, ui, h } = ctx;
    const hasDoc = () => reader.hasDocument;
    let recent = ctx.settings.recent || [];

    // ---------------------------------------------------------------- opening
    async function loadHere(filePath) {
      try {
        await reader.openPath(filePath);
      } catch (err) {
        host.setWindowState({ filePath: reader.file?.path ?? null });
        if (/ENOENT|no such file/i.test(err?.message)) {
          recent = await host.removeRecent(filePath);
          renderRecent();
          ctx.showError('File not found', new Error(`"${filePath}" no longer exists or was moved.`));
        } else {
          ctx.showError("Couldn't open file", err);
        }
      }
    }

    /** Open a path: here if this window is empty, otherwise in a new window. */
    function openPath(filePath) {
      if (!reader.hasDocument) return loadHere(filePath);
      return host.openPaths([filePath]);
    }

    async function openDialog() {
      const paths = await host.showOpenDialog({ multi: true });
      if (paths.length) await host.openPaths(paths);
    }

    async function openBytes(name, data) {
      try {
        await reader.open({ name, data, size: data.byteLength });
      } catch (err) {
        ctx.showError("Couldn't open file", err);
      }
    }

    host.onOpenFile((p) => loadHere(p));
    ctx.provide('files', { openPath, openDialog, loadHere });

    // ---------------------------------------------------------------- commands
    commands.register({ id: 'file.open', label: 'Open…', menu: 'File', group: 'open', order: 10, accelerator: 'CmdOrCtrl+O', run: openDialog });
    commands.register({ id: 'file.new-window', label: 'New Window', menu: 'File', group: 'open', order: 20, accelerator: 'CmdOrCtrl+N', run: () => host.newWindow() });
    commands.defineSubmenu({ menu: 'File', label: 'Open Recent', group: 'open', order: 30 });
    commands.register({
      id: 'file.show-in-folder', label: 'Show in Folder', menu: 'File', group: 'close', order: 700,
      enabled: () => hasDoc() && !!reader.file.path, run: () => host.showInFolder(reader.file.path),
    });
    commands.register({
      id: 'file.close', label: 'Close Document', menu: 'File', group: 'close', order: 710, accelerator: 'CmdOrCtrl+W',
      enabled: hasDoc,
      run: async () => {
        if (!(await ctx.use('save').confirmDiscard())) return;
        await reader.close();
      },
    });
    commands.addRole({ role: 'quit', label: 'Exit', menu: 'File', group: 'exit', order: 999 });

    ui.addButton({ slot: 'file', command: 'file.open', icon: 'open', title: 'Open', order: 10 });

    // ---------------------------------------------------------------- recent files
    let recentIds = [];
    function rebuildRecentMenu() {
      recentIds.forEach((id) => commands.unregister(id));
      recentIds = [];
      recent.slice(0, 10).forEach((r, i) => {
        const id = `file.recent.${i}`;
        recentIds.push(id);
        commands.register({ id, label: `${i + 1}  ${r.name}`.replace(/&/g, '&&'), menu: 'File/Open Recent', group: 'list', order: i, run: () => openPath(r.path) });
      });
      if (recent.length) {
        recentIds.push('file.recent.clear');
        commands.register({ id: 'file.recent.clear', label: 'Clear Recent Files', menu: 'File/Open Recent', group: 'clear', order: 100, run: clearRecent });
      }
    }

    async function clearRecent() {
      recent = await host.clearRecent();
      renderRecent();
    }

    const listEl = document.getElementById('recentList');
    function renderRecent() {
      document.getElementById('recentBlock').hidden = recent.length === 0;
      listEl.replaceChildren(...recent.slice(0, 8).map((r) => h('li', {},
        h('button', { type: 'button', class: 'recent-item', title: r.path, onClick: () => openPath(r.path) },
          h('span', { class: 'recent-icon', html: ctx.icon('file', { size: 18 }) }),
          h('span', { class: 'recent-text' }, h('span', { class: 'recent-name', text: r.name }), h('span', { class: 'recent-path', text: folderOf(r.path) })),
          h('span', { class: 'recent-when', text: timeAgo(r.openedAt) })),
        h('button', {
          type: 'button', class: 'recent-remove', title: 'Remove from list', 'aria-label': `Remove ${r.name} from recent files`, html: ctx.icon('close', { size: 14 }),
          onClick: async () => { recent = await host.removeRecent(r.path); renderRecent(); },
        }))));
      rebuildRecentMenu();
    }

    reader.on('open', async () => {
      const s = await host.getSettings();
      recent = s.recent || [];
      renderRecent();
    });
    reader.on('close', renderRecent);

    // ---------------------------------------------------------------- welcome screen
    document.getElementById('welcomeLogo').innerHTML = ctx.icon('logo', { size: 56 });
    document.getElementById('welcomeOpen').addEventListener('click', openDialog);
    document.getElementById('recentClear').addEventListener('click', clearRecent);
    renderRecent();

    // ---------------------------------------------------------------- drag & drop
    const overlay = document.getElementById('dropOverlay');
    let dragDepth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; dragDepth++; overlay.hidden = false; });
    window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) overlay.hidden = true; });
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('drop', async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      overlay.hidden = true;
      // Images dropped while annotating are handled by the editor itself.
      const all = [...e.dataTransfer.files];
      const files = all.filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
      // photos of pages (and no PDFs): make a PDF from them with the scanner
      const photos = all.filter((f) => /\.(jpe?g|png|webp|bmp|gif|heic|heif)$/i.test(f.name));
      if (!files.length && photos.length && reader.editorMode <= 0 && ctx.use('scan')) { ctx.use('scan').addFiles(photos); return; }
      if (!files.length) return;
      const paths = files.map((f) => host.pathForFile(f)).filter(Boolean);
      if (paths.length) await host.openPaths(paths);
      else await openBytes(files[0].name, new Uint8Array(await files[0].arrayBuffer()));
    });
  },
};

function folderOf(p) {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i > 0 ? p.slice(0, i) : p;
}

function timeAgo(t) {
  if (!t) return '';
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString();
}
