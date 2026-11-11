/**
 * Save / Save As. Annotations, form entries and page edits are written into
 * the PDF itself, so they show up in any other PDF reader.
 * Provides the 'save' service: save(), saveAs(), confirmDiscard()
 */
export default {
  id: 'save',
  activate(ctx) {
    const { host, reader, commands, ui } = ctx;
    const hasDoc = () => reader.hasDocument;

    async function writeTo(filePath) {
      const bytes = await reader.getBytes();
      const info = await host.writeFile(filePath, bytes);
      reader.markSaved(info);
      host.addRecent(info.path);
      ui.toast(`Saved ${info.name}`, { type: 'success' });
      return true;
    }

    async function save() {
      if (!hasDoc()) return false;
      if (!reader.file.path) return saveAs();
      if (!reader.dirty) { ui.toast('No changes to save'); return true; }
      return writeTo(reader.file.path);
    }

    async function saveAs() {
      if (!hasDoc()) return false;
      const target = await host.showSaveDialog({ defaultPath: reader.file.path || reader.file.name, title: 'Save a copy as' });
      if (!target) return false;
      return writeTo(target);
    }

    /** Ask what to do with unsaved changes. Resolves true if it's OK to continue. */
    async function confirmDiscard() {
      if (!hasDoc() || !reader.dirty) return true;
      const choice = await ui.modal({
        title: 'Unsaved changes',
        body: `Save changes to "${reader.file.name}" first?`,
        buttons: [
          { label: 'Cancel', value: null },
          { label: "Don't save", value: 'discard' },
          { label: 'Save', value: 'save', primary: true },
        ],
      });
      if (choice === 'save') return save();
      return choice === 'discard';
    }

    ctx.provide('save', { save, saveAs, confirmDiscard });

    commands.register({ id: 'file.save', label: 'Save', menu: 'File', group: 'save', order: 100, accelerator: 'CmdOrCtrl+S', enabled: hasDoc, run: save });
    commands.register({ id: 'file.save-as', label: 'Save As…', menu: 'File', group: 'save', order: 110, accelerator: 'CmdOrCtrl+Shift+S', enabled: hasDoc, run: saveAs });
    // Used by the main process when the window is closed with unsaved changes.
    commands.register({
      id: 'file.save-and-close',
      label: 'Save and Close',
      run: async () => { if (await save()) host.closeWindow({ force: true }); },
    });

    ui.addButton({ slot: 'file', command: 'file.save', icon: 'save', title: 'Save', order: 20 });
  },
};
