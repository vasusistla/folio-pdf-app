/**
 * View rotation, page layout (continuous / single page / two-page) and full screen.
 * Rotation here only changes the view; use Pages → Rotate Page to save a rotation.
 */
export default {
  id: 'layout',
  activate(ctx) {
    const { reader, commands, ui } = ctx;
    const { ScrollMode, SpreadMode } = ctx.lib.viewer;
    const hasDoc = () => reader.hasDocument;
    const v = reader.pdfViewer;

    commands.register({ id: 'view.rotate-cw', label: 'Rotate View Clockwise', menu: 'View', group: 'rotate', order: 200, accelerator: 'CmdOrCtrl+]', enabled: hasDoc, run: () => reader.rotate(90) });
    commands.register({ id: 'view.rotate-ccw', label: 'Rotate View Counterclockwise', menu: 'View', group: 'rotate', order: 210, accelerator: 'CmdOrCtrl+[', enabled: hasDoc, run: () => reader.rotate(-90) });
    ui.addButton({ slot: 'view', command: 'view.rotate-cw', icon: 'rotateCw', title: 'Rotate view', order: 10 });

    commands.defineSubmenu({ menu: 'View', label: 'Page Layout', group: 'layout', order: 300 });
    const layouts = [
      ['continuous', 'Continuous Scrolling', ScrollMode.VERTICAL, SpreadMode.NONE],
      ['single', 'Single Page', ScrollMode.PAGE, SpreadMode.NONE],
      ['two', 'Two Pages', ScrollMode.VERTICAL, SpreadMode.ODD],
      ['two-cover', 'Two Pages with Cover Page', ScrollMode.VERTICAL, SpreadMode.EVEN],
      ['horizontal', 'Horizontal Scrolling', ScrollMode.HORIZONTAL, SpreadMode.NONE],
      ['wrapped', 'Wrapped (Grid)', ScrollMode.WRAPPED, SpreadMode.NONE],
    ];
    layouts.forEach(([id, label, scroll, spread], i) => {
      commands.register({
        id: `view.layout.${id}`, label, menu: 'View/Page Layout', group: 'modes', order: i, type: 'radio',
        enabled: hasDoc, checked: () => v.scrollMode === scroll && v.spreadMode === spread,
        run: () => { v.scrollMode = scroll; if (scroll !== ScrollMode.HORIZONTAL) v.spreadMode = spread; },
      });
    });
    reader.eventBus.on('scrollmodechanged', () => commands.refresh());
    reader.eventBus.on('spreadmodechanged', () => commands.refresh());

    commands.addRole({ role: 'togglefullscreen', label: 'Full Screen', accelerator: 'F11', menu: 'View', group: 'window', order: 900 });
  },
};
