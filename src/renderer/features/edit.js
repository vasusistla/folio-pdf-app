/**
 * Edit menu: Undo / Redo, Copy, Select All.
 *
 * Undo is shared: any feature can register its own history with
 *   ctx.use('history').register({ id, canUndo(), undo(), canRedo(), redo(), lastChange() })
 * and Ctrl+Z undoes whichever feature changed something most recently.
 */
import { isTyping } from '../core/commands.js';

export default {
  id: 'edit',
  activate(ctx) {
    const { reader, commands } = ctx;
    const providers = [];

    // PDF.js annotation editor (highlight, text boxes, drawing, images)
    let pdfjsChangedAt = 0;
    reader.on('editor-state', (s) => { if (s.hasSomethingToUndo) pdfjsChangedAt = Date.now(); });
    providers.push({
      id: 'annotations',
      canUndo: () => !!(reader.uiManager && reader.editorState.hasSomethingToUndo),
      canRedo: () => !!(reader.uiManager && reader.editorState.hasSomethingToRedo),
      undo: () => reader.uiManager.undo(),
      redo: () => reader.uiManager.redo(),
      lastChange: () => pdfjsChangedAt,
    });

    const pick = (can) => providers.filter((p) => p[can]()).sort((a, b) => b.lastChange() - a.lastChange())[0];
    const typingInField = () => isTyping(document.activeElement) && !document.activeElement.closest?.('.annotationEditorLayer');

    ctx.provide('history', {
      register(p) { providers.push(p); commands.refresh(); },
      changed() { commands.refresh(); },
    });

    commands.register({
      id: 'edit.undo', label: 'Undo', menu: 'Edit', group: 'history', order: 10, accelerator: 'CmdOrCtrl+Z',
      run: () => { if (typingInField()) return document.execCommand('undo'); const p = pick('canUndo'); if (p) p.undo(); else document.execCommand('undo'); },
    });
    commands.register({
      id: 'edit.redo', label: 'Redo', menu: 'Edit', group: 'history', order: 20, accelerator: 'CmdOrCtrl+Y', keys: ['Ctrl+Shift+Z'], hideKeys: true,
      run: () => { if (typingInField()) return document.execCommand('redo'); const p = pick('canRedo'); if (p) p.redo(); else document.execCommand('redo'); },
    });
    commands.addRole({ role: 'cut', menu: 'Edit', group: 'clipboard', order: 100 });
    commands.addRole({ role: 'copy', menu: 'Edit', group: 'clipboard', order: 110 });
    commands.addRole({ role: 'paste', menu: 'Edit', group: 'clipboard', order: 120 });
    commands.addRole({ role: 'selectAll', label: 'Select All', menu: 'Edit', group: 'clipboard', order: 130 });

    // Toolbar undo / redo light up when any feature has something to undo.
    commands.register({ id: 'edit.undo-change', label: 'Undo', enabled: () => !!pick('canUndo'), run: () => pick('canUndo')?.undo() });
    commands.register({ id: 'edit.redo-change', label: 'Redo', enabled: () => !!pick('canRedo'), run: () => pick('canRedo')?.redo() });
    ctx.ui.addButton({ slot: 'history', command: 'edit.undo-change', icon: 'undo', title: 'Undo (Ctrl+Z)', order: 10 });
    ctx.ui.addButton({ slot: 'history', command: 'edit.redo-change', icon: 'redo', title: 'Redo (Ctrl+Y)', order: 20 });
  },
};
