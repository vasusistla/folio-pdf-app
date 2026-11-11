/**
 * Light / dark theme (or follow Windows), plus Night Reading, which shows
 * pages as light text on a dark background.
 */
export default {
  id: 'theme',
  activate(ctx) {
    const { commands, ui } = ctx;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    let theme = ctx.settings.theme || 'system';
    let night = !!ctx.settings.nightPages;

    const resolved = () => (theme === 'system' ? (media.matches ? 'dark' : 'light') : theme);
    function apply() {
      document.documentElement.dataset.theme = resolved();
      document.body.classList.toggle('night-pages', night);
      if (themeBtn) themeBtn.innerHTML = ctx.icon(resolved() === 'dark' ? 'sun' : 'moon');
      commands.refresh();
    }
    function setTheme(t) {
      theme = t;
      ctx.saveSettings({ theme: t });
      apply();
    }
    media.addEventListener('change', apply);

    commands.defineSubmenu({ menu: 'View', label: 'Theme', group: 'look', order: 600 });
    [['system', 'Match Windows'], ['light', 'Light'], ['dark', 'Dark']].forEach(([id, label], i) => {
      commands.register({ id: `theme.${id}`, label, menu: 'View/Theme', group: 't', order: i, type: 'radio', checked: () => theme === id, run: () => setTheme(id) });
    });
    commands.register({
      id: 'theme.toggle', label: 'Switch Light / Dark',
      run: () => setTheme(resolved() === 'dark' ? 'light' : 'dark'),
    });
    commands.register({
      id: 'view.night-pages', label: 'Night Reading (Dark Pages)', menu: 'View', group: 'look', order: 610, type: 'checkbox',
      checked: () => night, run: () => { night = !night; ctx.saveSettings({ nightPages: night }); apply(); },
    });

    const themeBtn = ui.addButton({ slot: 'end', command: 'theme.toggle', icon: 'moon', title: 'Switch light / dark theme', order: 50 });
    apply();
  },
};
