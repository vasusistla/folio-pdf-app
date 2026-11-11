/**
 * Touch screens (iPhone, iPad, touchscreen laptops): pinch with two fingers to zoom the
 * pages, centred between your fingers, and double-tap to switch between fit-width and
 * a closer look. One finger scrolls as usual.
 */
export default {
  id: 'touch',
  activate(ctx) {
    const { reader } = ctx;
    const el = reader.container;
    let pinch = null;
    let lastTap = 0;

    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const mid = (t) => [(t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2];

    el.addEventListener('touchstart', (e) => {
      if (!reader.hasDocument) return;
      if (e.touches.length === 2) {
        pinch = { d: dist(e.touches) };
      } else if (e.touches.length === 1 && !e.target.closest('input, textarea, select, button, .annotationEditorLayer [contenteditable], .fs-layer')) {
        // double-tap: zoom in where tapped, or back to the page width
        const now = Date.now();
        if (now - lastTap < 300) {
          e.preventDefault();
          const origin = [e.touches[0].clientX, e.touches[0].clientY];
          const width = reader.pdfViewer.currentScaleValue === 'page-width';
          if (width || reader.scaleValue === 'auto') reader.pdfViewer.updateScale({ scaleFactor: 2, origin, drawingDelay: 150 });
          else reader.setScale('page-width');
          lastTap = 0;
        } else {
          lastTap = now;
        }
      }
    }, { passive: false });

    el.addEventListener('touchmove', (e) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();                       // the pages zoom, not the whole screen
      const d = dist(e.touches);
      const factor = d / pinch.d;
      if (Math.abs(factor - 1) < 0.02) return;
      pinch.d = d;
      reader.pdfViewer.updateScale({ scaleFactor: factor, origin: mid(e.touches), drawingDelay: 250 });
    }, { passive: false });

    const end = (e) => { if (e.touches.length < 2) pinch = null; };
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
    // Safari's own page zoom gesture: keep it from zooming the app itself
    for (const type of ['gesturestart', 'gesturechange']) document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  },
};
