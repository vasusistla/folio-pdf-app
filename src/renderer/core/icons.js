/**
 * Line icons (24×24, drawn with currentColor). Add your own here and use
 * them via ctx.ui.icon('name') or the `icon` option of toolbar buttons.
 */
const P = {
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  open: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z"/>',
  save: '<path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v5h8V3"/><path d="M7 21v-7h10v7"/>',
  print: '<path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/>',
  left: '<path d="M15 18l-6-6 6-6"/>',
  right: '<path d="M9 18l6-6-6-6"/>',
  up: '<path d="M18 15l-6-6-6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  rotateCw: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/>',
  rotateCcw: '<path d="M4 12a8 8 0 1 0 2.34-5.66"/><path d="M4 4v5h5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/>',
  moon: '<path d="M20.5 13.5A8.5 8.5 0 1 1 10.5 3.5a6.5 6.5 0 0 0 10 10z"/>',
  pointer: '<path d="M5 3.5l13 6.2-5.6 1.7-2 5.6z"/><path d="M12.4 11.4L18 17"/>',
  highlight: '<path d="M14.5 4.5l5 5L11 18H6v-5z"/><path d="M4 21h16" stroke-opacity=".45" stroke-width="3"/>',
  text: '<path d="M5 7V5h14v2"/><path d="M12 5v14"/><path d="M9 19h6"/>',
  draw: '<path d="M3 17c2.5-5 4.5-7 6.2-7 2.3 0 1.6 5 3.9 5 2 0 3-6 5.2-6 1.2 0 1.9 1 2.7 2.2"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-9 9"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  present: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4M8 20h8"/><path d="M10.5 8v4l3-2z"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  camera: '<path d="M4 8.5A2 2 0 0 1 6 6.5h2l1.4-2h5.2l1.4 2h2a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><circle cx="12" cy="12.6" r="3.4"/>',
  crop: '<path d="M7 3v14h14"/><path d="M3 7h14v14"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  thumbnails: '<rect x="4" y="3" width="7" height="8" rx="1.2"/><rect x="13" y="3" width="7" height="8" rx="1.2"/><rect x="4" y="13" width="7" height="8" rx="1.2"/><rect x="13" y="13" width="7" height="8" rx="1.2"/>',
  outline: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" stroke-width="2.6"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  filePlus: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 11v6M9 14h6"/>',
  fitWidth: '<path d="M3 12h18"/><path d="M7 8l-4 4 4 4M17 8l4 4-4 4"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  pages: '<rect x="7" y="3" width="12" height="15" rx="1.5"/><path d="M5 6.5V19a2 2 0 0 0 2 2h9"/>',
  sign: '<path d="M14.5 3.5l6 6-9.5 9.5H5v-6z"/><path d="M12.5 5.5l6 6"/><path d="M3 21h18"/>',
  check: '<path d="M4.5 12.5l4.5 4.5L19.5 6.5"/>',
  cross: '<path d="M6 6l12 12M18 6L6 18"/>',
  dot: '<circle cx="12" cy="12" r="4.5" fill="currentColor"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  signature: '<path d="M3 16c2-1 3.5-7 5.5-7S9 16 11 16s2.5-5 4-5 1 4 2.5 4 2-1.5 3.5-2"/><path d="M3 20h18"/>',
  initials: '<path d="M4 18l3.5-10L11 18M5.3 14.5h4.4"/><path d="M14 8h3.2a2.5 2.5 0 0 1 0 5H14zm0 5h3.8a2.5 2.5 0 0 1 0 5H14z"/>',
  logo: '<path d="M6 2.8h8.2L19 7.6V19a2.2 2.2 0 0 1-2.2 2.2H6A2.2 2.2 0 0 1 3.8 19V5A2.2 2.2 0 0 1 6 2.8z"/><path d="M14 2.8V8h5"/><path d="M8 17c0-4.5 2.6-7 7-7-.2 4.4-2.6 7-7 7zM8 17l3.6-3.6"/>',
};

export function icon(name, { size = 18, className = '' } = {}) {
  const body = P[name] || P.file;
  return `<svg class="icon ${className}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export function registerIcon(name, svgBody) {
  P[name] = svgBody;
}
