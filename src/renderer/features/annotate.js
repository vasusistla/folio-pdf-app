/**
 * Annotation tools: Highlight, Add Text, Draw and Add Image, built on the
 * PDF.js annotation editor. Annotations are saved into the PDF on Save.
 *
 * To add another tool, add an entry to TOOLS (and an options builder below).
 */
export default {
  id: 'annotate',
  activate(ctx) {
    const { reader, commands, ui, h, host } = ctx;
    const { AnnotationEditorType: T, AnnotationEditorParamsType: P } = ctx.lib.pdfjs;
    const prefs = Object.assign({
      highlightColor: '#FFFF98', textColor: '#000000', textSize: 14,
      inkColor: '#D32F2F', inkThickness: 3, inkOpacity: 100,
    }, ctx.settings.annotate || {});
    const savePrefs = () => ctx.saveSettings({ annotate: { ...prefs } });

    const TOOLS = [
      { id: 'select', mode: T.NONE, label: 'Select & Read', icon: 'pointer', title: 'Select text and read' },
      { id: 'highlight', mode: T.HIGHLIGHT, label: 'Highlight', icon: 'highlight', accelerator: 'CmdOrCtrl+Shift+H' },
      { id: 'text', mode: T.FREETEXT, label: 'Add Text', icon: 'text', accelerator: 'CmdOrCtrl+Shift+T' },
      { id: 'draw', mode: T.INK, label: 'Draw', icon: 'draw', accelerator: 'CmdOrCtrl+Shift+D' },
      { id: 'image', mode: T.STAMP, label: 'Add Image…', icon: 'image', title: 'Add image', run: addImage },
    ];

    const setParam = (type, value) => reader.eventBus.dispatch('switchannotationeditorparams', { source: null, type, value });

    function setMode(mode) {
      if (!reader.canEdit) return;
      ctx.use('presentation')?.exit?.();
      reader.setEditorMode(mode);
    }

    function waitForMode(mode) {
      if (reader.editorMode === mode) return Promise.resolve();
      return new Promise((resolve) => {
        const off = reader.on('editor-mode', (m) => { if (m === mode) { off(); resolve(); } });
        setTimeout(() => { off(); resolve(); }, 1500);
      });
    }

    async function addImage() {
      const img = await host.pickImage();
      if (!img) return;
      const ext = img.name.split('.').pop().toLowerCase();
      const file = new File([img.data], img.name, { type: ext === 'png' ? 'image/png' : 'image/jpeg' });
      setMode(T.STAMP);
      await waitForMode(T.STAMP);
      setParam(P.CREATE, { bitmapFile: file });
    }

    // ------------------------------------------------------------ commands & buttons
    TOOLS.forEach((tool, i) => {
      const id = `annotate.${tool.id}`;
      commands.register({
        id, label: tool.label, menu: 'Annotate', group: 'tools', order: i * 10, accelerator: tool.accelerator,
        type: tool.run ? undefined : 'checkbox',
        enabled: () => reader.canEdit,
        checked: tool.run ? undefined : () => reader.hasDocument && reader.editorMode === tool.mode,
        run: tool.run || (() => setMode(reader.editorMode === tool.mode && tool.mode !== T.NONE ? T.NONE : tool.mode)),
      });
      ui.addButton({ slot: 'annotate', command: id, icon: tool.icon, title: tool.title || tool.label.replace('…', ''), toggle: !tool.run, order: i * 10 });
    });

    commands.register({
      id: 'annotate.delete', label: 'Delete Selected Annotation', menu: 'Annotate', group: 'selection', order: 100,
      displayAccelerator: 'Delete', enabled: () => !!reader.editorState.hasSelectedEditor, run: () => reader.uiManager?.delete(),
    });
    commands.register({
      id: 'annotate.done', label: 'Finish Annotating', menu: 'Annotate', group: 'selection', order: 110,
      keys: ['Escape'], showKeyInMenu: true,
      keyWhen: () => reader.editorMode !== T.NONE && !reader.editorState.hasSelectedEditor,
      enabled: () => reader.hasDocument && reader.editorMode !== T.NONE, run: () => setMode(T.NONE),
    });

    // ------------------------------------------------------------ tool options bar
    const COLORS = {
      highlight: ['#FFFF98', '#53FFBC', '#80EBFF', '#FFCBE6', '#FF4F5F'],
      ink: ['#000000', '#D32F2F', '#1565C0', '#2E7D32', '#F9A825', '#6A1B9A'],
    };

    function swatches(colors, current, onPick, { custom = true } = {}) {
      const wrap = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Colour' });
      const mark = (val) => wrap.querySelectorAll('.swatch').forEach((s) => s.setAttribute('aria-checked', String(s.dataset.color.toLowerCase() === val.toLowerCase())));
      for (const c of colors) {
        wrap.append(h('button', {
          type: 'button', class: 'swatch', role: 'radio', 'data-color': c, title: c, style: { background: c },
          onClick: () => { onPick(c); mark(c); },
        }));
      }
      if (custom) {
        const input = h('input', { type: 'color', class: 'swatch-custom', title: 'Custom colour', value: current.length === 7 ? current : '#000000' });
        input.addEventListener('input', () => { onPick(input.value); mark(input.value); });
        wrap.append(input);
      }
      mark(current);
      return wrap;
    }

    const field = (label, control) => h('label', { class: 'opt-field' }, h('span', { text: label }), control);
    const hint = (text) => h('span', { class: 'opt-hint', text });
    const actions = () => h('div', { class: 'opt-actions' },
      h('button', { type: 'button', class: 'btn small', 'data-command': 'annotate.delete', text: 'Delete selected', onClick: () => commands.run('annotate.delete') }),
      h('button', { type: 'button', class: 'btn small primary', text: 'Done', onClick: () => setMode(T.NONE) }));

    function optionsFor(mode) {
      if (mode === T.HIGHLIGHT) {
        return h('div', { class: 'tool-options' },
          field('Colour', swatches(COLORS.highlight, prefs.highlightColor, (c) => { prefs.highlightColor = c; setParam(P.HIGHLIGHT_COLOR, c); savePrefs(); }, { custom: false })),
          hint('Select text on the page to highlight it.'), actions());
      }
      if (mode === T.FREETEXT) {
        const size = h('select', { class: 'opt-select' }, ...[8, 10, 12, 14, 16, 18, 20, 24, 32, 48, 72].map((s) => h('option', { value: s, text: `${s} pt`, selected: s === prefs.textSize })));
        size.addEventListener('change', () => { prefs.textSize = Number(size.value); setParam(P.FREETEXT_SIZE, prefs.textSize); savePrefs(); });
        return h('div', { class: 'tool-options' },
          field('Colour', swatches(COLORS.ink, prefs.textColor, (c) => { prefs.textColor = c; setParam(P.FREETEXT_COLOR, c); savePrefs(); })),
          field('Size', size),
          hint('Click on the page where you want to type.'), actions());
      }
      if (mode === T.INK) {
        const thick = h('input', { type: 'range', min: 1, max: 20, value: prefs.inkThickness, class: 'opt-range', 'aria-label': 'Thickness' });
        thick.addEventListener('input', () => { prefs.inkThickness = Number(thick.value); setParam(P.INK_THICKNESS, prefs.inkThickness); savePrefs(); });
        const opacity = h('input', { type: 'range', min: 10, max: 100, step: 5, value: prefs.inkOpacity, class: 'opt-range', 'aria-label': 'Opacity' });
        opacity.addEventListener('input', () => { prefs.inkOpacity = Number(opacity.value); setParam(P.INK_OPACITY, prefs.inkOpacity / 100); savePrefs(); });
        return h('div', { class: 'tool-options' },
          field('Colour', swatches(COLORS.ink, prefs.inkColor, (c) => { prefs.inkColor = c; setParam(P.INK_COLOR, c); savePrefs(); })),
          field('Thickness', thick), field('Opacity', opacity),
          hint('Drag on the page to draw.'), actions());
      }
      if (mode === T.STAMP) {
        return h('div', { class: 'tool-options' },
          h('button', { type: 'button', class: 'btn small', text: 'Add another image…', onClick: addImage }),
          hint('Drag an image to move it, or drag its corners to resize it.'), actions());
      }
      return null;
    }

    /** Apply the remembered colour/size so new annotations use them. */
    function applyDefaults(mode) {
      if (reader.editorState.hasSelectedEditor) return;
      if (mode === T.HIGHLIGHT) setParam(P.HIGHLIGHT_COLOR, prefs.highlightColor);
      if (mode === T.FREETEXT) { setParam(P.FREETEXT_COLOR, prefs.textColor); setParam(P.FREETEXT_SIZE, prefs.textSize); }
      if (mode === T.INK) { setParam(P.INK_COLOR, prefs.inkColor); setParam(P.INK_THICKNESS, prefs.inkThickness); setParam(P.INK_OPACITY, prefs.inkOpacity / 100); }
    }

    reader.on('editor-mode', (mode) => {
      applyDefaults(mode);
      ui.setToolOptions(optionsFor(mode), 'annotate');
      document.body.classList.toggle('annotating', mode !== T.NONE);
      commands.refresh();
    });
    reader.on('open', () => { ui.setToolOptions(null, 'annotate'); document.body.classList.remove('annotating'); });
    reader.on('close', () => { ui.setToolOptions(null, 'annotate'); document.body.classList.remove('annotating'); });
  },
};
