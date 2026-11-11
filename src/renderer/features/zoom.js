/**
 * Zoom: toolbar zoom box, fit width / page, actual size, Ctrl + mouse wheel.
 */
const PRESETS = [
  ['auto', 'Automatic'], ['page-actual', 'Actual size'], ['page-fit', 'Fit page'], ['page-width', 'Fit width'],
  null,
  ['0.5', '50%'], ['0.75', '75%'], ['1', '100%'], ['1.25', '125%'], ['1.5', '150%'], ['2', '200%'], ['3', '300%'], ['4', '400%'],
];

export default {
  id: 'zoom',
  activate(ctx) {
    const { reader, commands, ui, h } = ctx;
    const hasDoc = () => reader.hasDocument;
    const is = (v) => () => hasDoc() && reader.scaleValue === v;

    commands.register({ id: 'zoom.in', label: 'Zoom In', menu: 'View', group: 'zoom', order: 100, accelerator: 'CmdOrCtrl+=', keys: ['Ctrl+NumpadAdd', 'Ctrl+Plus'], hideKeys: true, enabled: hasDoc, run: () => reader.zoomIn() });
    commands.register({ id: 'zoom.out', label: 'Zoom Out', menu: 'View', group: 'zoom', order: 110, accelerator: 'CmdOrCtrl+-', keys: ['Ctrl+NumpadSubtract'], hideKeys: true, enabled: hasDoc, run: () => reader.zoomOut() });
    commands.register({ id: 'zoom.actual', label: 'Actual Size', menu: 'View', group: 'zoom', order: 120, accelerator: 'CmdOrCtrl+1', type: 'checkbox', checked: is('page-actual'), enabled: hasDoc, run: () => reader.setScale('page-actual') });
    commands.register({ id: 'zoom.fit-page', label: 'Fit Page', menu: 'View', group: 'zoom', order: 130, accelerator: 'CmdOrCtrl+0', type: 'checkbox', checked: is('page-fit'), enabled: hasDoc, run: () => reader.setScale('page-fit') });
    commands.register({ id: 'zoom.fit-width', label: 'Fit Width', menu: 'View', group: 'zoom', order: 140, accelerator: 'CmdOrCtrl+2', type: 'checkbox', checked: is('page-width'), enabled: hasDoc, run: () => reader.setScale('page-width') });
    commands.register({ id: 'zoom.auto', label: 'Automatic Zoom', menu: 'View', group: 'zoom', order: 150, type: 'checkbox', checked: is('auto'), enabled: hasDoc, run: () => reader.setScale('auto') });

    // Toolbar: − [ 125% ▾ ] +
    ui.addButton({ slot: 'zoom', command: 'zoom.out', icon: 'minus', title: 'Zoom out', order: 10 });
    const select = h('select', { class: 'zoom-select', 'aria-label': 'Zoom' });
    const custom = h('option', { value: 'custom', hidden: true, text: '' });
    select.append(custom);
    for (const p of PRESETS) {
      if (!p) { select.append(h('option', { disabled: true, text: '──────' })); continue; }
      select.append(h('option', { value: p[0], text: p[1] }));
    }
    ui.addToolbarElement('zoom', select, 20);
    ui.addButton({ slot: 'zoom', command: 'zoom.in', icon: 'plus', title: 'Zoom in', order: 30 });

    select.addEventListener('change', () => {
      if (select.value !== 'custom') reader.setScale(select.value);
      reader.container.focus();
    });

    const sync = () => {
      select.disabled = !hasDoc();
      const v = String(reader.scaleValue);
      const match = [...select.options].find((o) => o.value === v || (o.value !== 'custom' && Number(o.value) === Number(v)));
      if (match && isNaN(Number(v))) {
        // keep the preset selected but show the live percentage in its label
        select.value = match.value;
      } else if (match) {
        select.value = match.value;
      } else {
        custom.textContent = `${Math.round(reader.scale * 100)}%`;
        select.value = 'custom';
      }
    };
    reader.on('scale', sync);
    reader.on('open', sync);
    reader.on('close', sync);
    sync();

    // Ctrl + wheel (and touchpad pinch, which Chromium reports as Ctrl + wheel).
    let acc = 0;
    reader.container.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey) || !hasDoc()) return;
      e.preventDefault();
      const origin = [e.clientX, e.clientY];
      const pinch = e.deltaMode === 0 && Math.abs(e.deltaY) < 40 && !Number.isInteger(e.deltaY);
      if (pinch) {
        reader.pdfViewer.updateScale({ scaleFactor: Math.exp(-e.deltaY / 100), origin, drawingDelay: 300 });
        return;
      }
      acc += e.deltaY;
      if (Math.abs(acc) < 40) return;
      const steps = acc < 0 ? 1 : -1;
      acc = 0;
      reader.pdfViewer.updateScale({ steps, origin, drawingDelay: 200 });
    }, { passive: false });
  },
};
