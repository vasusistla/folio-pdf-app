/**
 * Help menu: Keyboard Shortcuts (built automatically from every registered
 * command, so new features appear here on their own), About, Developer Tools.
 */
export default {
  id: 'help',
  activate(ctx) {
    const { commands, ui, h, host } = ctx;

    function shortcuts() {
      const byMenu = new Map();
      for (const c of commands.all()) {
        const keys = commands.shortcutFor(c.id);
        if (!keys || !c.menu) continue;
        const top = c.menu.split('/')[0];
        if (!byMenu.has(top)) byMenu.set(top, []);
        byMenu.get(top).push([c.label.replace('…', ''), keys]);
      }
      byMenu.set('Mouse & keyboard', [
        ['Zoom with the mouse', 'Ctrl + wheel'],
        ['Previous / next page', '← / →'],
        ['Move a selected annotation', 'Arrow keys'],
        ['Highlight selected text', 'Select text, then click Highlight'],
      ]);
      const body = h('div', { class: 'shortcuts' });
      for (const [menu, rows] of byMenu) {
        body.append(h('h3', { text: menu }), h('table', {}, ...rows.map(([l, k]) => h('tr', {}, h('td', { text: l }), h('td', {}, h('kbd', { text: k }))))));
      }
      ui.modal({ title: 'Keyboard shortcuts', body, width: '620px', buttons: [{ label: 'Close', value: true, primary: true }] });
    }

    let info = null;
    const getInfo = async () => (info ||= await host.info());

    function formatDate(iso) {
      const d = iso && new Date(`${iso}T12:00:00`);
      return d && !isNaN(d) ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '';
    }

    async function about() {
      const { version, release, electron, chrome, platform } = await getInfo();
      const web = platform === 'web';
      const date = formatDate(release?.date);
      const body = h('div', { class: 'about' },
        h('div', { class: 'about-logo', html: ctx.icon('logo', { size: 44 }) }),
        h('p', { class: 'about-version' }, h('strong', { text: `Folio PDF ${version}` }), date ? h('span', { class: 'muted', text: `  ·  released ${date}` }) : null),
        h('p', { text: web
          ? 'A free, open-source PDF reader and light editor. Once added to your Home Screen it works offline, and your documents never leave this device. No accounts, no ads, no tracking.'
          : 'A free, open-source PDF reader and light editor. It works fully offline and never connects to the internet. No accounts, no ads, no tracking.' }),
        release?.notes?.length ? h('h3', { text: `What's new in ${version}` }) : null,
        release?.notes?.length ? h('ul', {}, ...release.notes.map((n) => h('li', { text: n }))) : null,
        h('h3', { text: 'Built with' }),
        h('ul', {},
          h('li', { text: 'PDF.js by Mozilla (Apache License 2.0)' }),
          h('li', { text: 'pdf-lib (MIT License)' }),
          h('li', { text: 'Signature fonts: Dancing Script, Great Vibes, Allura, Caveat (SIL Open Font License) and Homemade Apple (Apache License 2.0)' }),
          h('li', { text: 'Text recognition: Tesseract and tesseract.js (Apache License 2.0)' }),
          web ? h('li', { text: 'Runs in your web browser; the app is saved on this device for offline use' })
            : h('li', { text: `Electron ${electron} with Chromium ${chrome} (MIT and BSD licences)` })));
      ui.modal({ title: 'About Folio PDF', body, width: '520px', buttons: [{ label: 'Close', value: true, primary: true }] });
    }

    // Version on the start screen, plus a one-time notice after an upgrade.
    getInfo().then(({ version }) => {
      const el = document.getElementById('welcomeVersion');
      if (el) el.textContent = `Version ${version}`;
      const previous = ctx.settings.lastVersion || (ctx.settings.recent?.length ? 'earlier' : null);
      if (previous && previous !== version) {
        ui.toast(`Folio PDF was updated to version ${version}`, { timeout: 9000, action: { label: "What's new", run: about } });
      }
      if (ctx.settings.lastVersion !== version) ctx.saveSettings({ lastVersion: version });
    });

    commands.register({ id: 'help.shortcuts', label: 'Keyboard Shortcuts', menu: 'Help', group: 'help', order: 10, keys: ['F1'], showKeyInMenu: true, run: shortcuts });
    commands.register({ id: 'help.whats-new', label: "What's New", menu: 'Help', group: 'help', order: 20, run: about });
    commands.register({ id: 'help.about', label: 'About Folio PDF', menu: 'Help', group: 'about', order: 100, run: about });
    commands.addRole({ role: 'toggleDevTools', label: 'Developer Tools', accelerator: 'F12', menu: 'Help', group: 'dev', order: 50 });
  },
};
