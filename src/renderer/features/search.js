/**
 * Find in document (Ctrl+F): match case, whole words, highlight all, F3 / Shift+F3.
 */
export default {
  id: 'search',
  activate(ctx) {
    const { reader, commands, ui, h } = ctx;
    const { FindState } = ctx.lib.viewer;
    const hasDoc = () => reader.hasDocument;
    const opts = { caseSensitive: false, entireWord: false, highlightAll: true };

    const input = h('input', { class: 'input find-input', type: 'search', placeholder: 'Find in document', 'aria-label': 'Find in document', spellcheck: 'false' });
    const count = h('span', { class: 'find-count', 'aria-live': 'polite' });
    const optBtn = (key, label, title) => {
      const b = h('button', { type: 'button', class: 'find-opt', title, 'aria-pressed': String(opts[key]), text: label });
      b.addEventListener('click', () => {
        opts[key] = !opts[key];
        b.setAttribute('aria-pressed', String(opts[key]));
        dispatch(key === 'highlightAll' ? 'highlightallchange' : key === 'caseSensitive' ? 'casesensitivitychange' : 'entirewordchange');
        input.focus();
      });
      return b;
    };
    const iconBtn = (name, title, fn) => h('button', { type: 'button', class: 'tb-btn small', title, 'aria-label': title, html: ctx.icon(name, { size: 16 }), onClick: fn });

    const bar = h('div', { id: 'findbar', class: 'findbar', hidden: true, role: 'search' },
      h('span', { class: 'find-icon', html: ctx.icon('search', { size: 16 }) }),
      input, count,
      iconBtn('up', 'Previous match (Shift+F3)', () => findAgain(true)),
      iconBtn('down', 'Next match (F3)', () => findAgain(false)),
      h('span', { class: 'find-sep' }),
      optBtn('caseSensitive', 'Aa', 'Match case'),
      optBtn('entireWord', 'Whole', 'Whole words only'),
      optBtn('highlightAll', 'All', 'Highlight all matches'),
      iconBtn('close', 'Close (Esc)', () => close()));
    document.getElementById('stage').append(bar);

    function dispatch(type, findPrevious = false) {
      if (!hasDoc()) return;
      reader.eventBus.dispatch('find', {
        source: bar, type, query: input.value, caseSensitive: opts.caseSensitive, entireWord: opts.entireWord,
        highlightAll: opts.highlightAll, findPrevious, matchDiacritics: false,
      });
      if (!input.value) count.textContent = '';
    }
    const findAgain = (prev) => { if (input.value) dispatch('again', prev); };

    let t = null;
    input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => dispatch(''), 160); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); findAgain(e.shiftKey); }
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    });

    function open() {
      if (!hasDoc()) return;
      const sel = window.getSelection()?.toString().trim();
      if (sel && sel.length < 120 && !sel.includes('\n')) { input.value = sel; dispatch(''); }
      bar.hidden = false;
      input.focus();
      input.select();
      commands.refresh();
    }
    function close() {
      if (bar.hidden) return;
      bar.hidden = true;
      reader.eventBus.dispatch('findbarclose', { source: bar });
      count.textContent = '';
      reader.container.focus();
      commands.refresh();
    }

    reader.eventBus.on('updatefindmatchescount', ({ matchesCount }) => showCount(matchesCount));
    reader.eventBus.on('updatefindcontrolstate', ({ state, matchesCount }) => {
      bar.classList.toggle('not-found', state === FindState.NOT_FOUND);
      if (state === FindState.NOT_FOUND) count.textContent = 'No matches';
      else showCount(matchesCount);
    });
    function showCount(m) {
      if (!input.value || !m) return;
      count.textContent = m.total ? `${m.current} of ${m.total}` : (bar.classList.contains('not-found') ? 'No matches' : '');
    }

    reader.on('close', () => { input.value = ''; close(); });
    reader.on('open', (_doc, { replaced }) => { if (!replaced) { input.value = ''; close(); } });

    commands.register({ id: 'find.open', label: 'Find…', menu: 'Edit', group: 'find', order: 300, accelerator: 'CmdOrCtrl+F', enabled: hasDoc, run: open });
    commands.register({ id: 'find.next', label: 'Find Next', menu: 'Edit', group: 'find', order: 310, keys: ['F3'], showKeyInMenu: true, allowInInput: true, enabled: hasDoc, run: () => (input.value ? findAgain(false) : open()) });
    commands.register({ id: 'find.prev', label: 'Find Previous', menu: 'Edit', group: 'find', order: 320, keys: ['Shift+F3'], showKeyInMenu: true, allowInInput: true, enabled: hasDoc, run: () => (input.value ? findAgain(true) : open()) });
    commands.register({ id: 'find.toggle', label: 'Find', checked: () => !bar.hidden, enabled: hasDoc, run: () => (bar.hidden ? open() : close()) });
    ui.addButton({ slot: 'tools', command: 'find.toggle', icon: 'search', title: 'Find (Ctrl+F)', toggle: true, order: 10 });
    ctx.provide('search', { open, close, input });
  },
};
