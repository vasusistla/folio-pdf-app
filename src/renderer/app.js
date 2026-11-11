/**
 * Folio PDF: renderer entry point.
 *
 * Builds the shared context (ctx) and activates every feature listed in
 * features/index.js. A feature is a plain module:
 *
 *   export default {
 *     id: 'my-feature',
 *     activate(ctx) {
 *       ctx.commands.register({ ... });   // menu item, shortcut, action
 *       ctx.ui.addButton({ ... });         // toolbar button
 *       ctx.reader.on('open', doc => ...); // react to documents
 *     },
 *   };
 *
 * See DEVELOPER.md for the full guide.
 */
import { Commands } from './core/commands.js';
import { UI, h } from './core/ui.js';
import { Reader } from './core/reader.js';
import { pdfjsLib, viewer, pdfLib, DOCUMENT_OPTIONS } from './core/pdf.js';
import { icon } from './core/icons.js';
import { FEATURES } from './features/index.js';

async function main() {
  const host = window.host;
  const settings = await host.getSettings();
  const commands = new Commands(host);
  const ui = new UI(commands);
  const reader = new Reader({
    container: document.getElementById('viewerContainer'),
    viewerEl: document.getElementById('viewer'),
    host,
    ui,
  });

  const services = new Map();
  const ctx = {
    host, commands, ui, reader, h, icon,
    lib: { pdfjs: pdfjsLib, viewer, pdfLib, documentOptions: DOCUMENT_OPTIONS },
    settings,
    /** Persist a settings change: ctx.saveSettings({ theme: 'dark' }) */
    saveSettings(patch) { Object.assign(settings, patch); return host.setSettings(patch); },
    /** Share an API between features: ctx.provide('search', api) / ctx.use('search') */
    provide(name, api) { services.set(name, api); },
    use(name) { return services.get(name); },
    /** Show an error to the user in a consistent way. */
    showError(title, err) { console.error(title, err); ui.alert(title, err?.message || String(err)); },
  };
  window.folio = ctx; // handy in Developer Tools (Help → Developer Tools)

  commands.on('error', (err, cmd) => ctx.showError(`${cmd.label || 'Action'} failed`, err));
  reader.on('loading', (on) => { document.getElementById('loading').hidden = !on; });
  for (const evt of ['open', 'close', 'page', 'scale', 'dirty', 'rotation', 'editor-mode', 'editor-state']) {
    reader.on(evt, () => commands.refresh());
  }
  document.body.classList.toggle('no-doc', true);
  reader.on('open', () => document.body.classList.remove('no-doc'));
  reader.on('close', () => document.body.classList.add('no-doc'));

  for (const feature of FEATURES) {
    try {
      await feature.activate(ctx);
    } catch (err) {
      console.error(`Feature "${feature.id}" failed to start`, err);
    }
  }

  host.onCommand((id) => commands.run(id));
  host.onWindowFocus(() => { commands.publishMenu(); commands.refresh(); });
  window.addEventListener('keydown', (e) => commands.handleKeydown(e));

  ui.emit('ready');
  commands.publishMenu();
  commands.refresh();
  ctx.ready = true;
  document.body.classList.add('ready');

  const initial = await host.getInitialFile();
  if (initial) ctx.use('files').openPath(initial);
}

main().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<pre style="padding:24px;color:#b00">Folio PDF failed to start:\n${err?.stack || err}</pre>`;
});
