/**
 * Page thumbnails in the sidebar. Click to jump; right-click for page actions
 * (other features add those with ctx.ui.addPageAction).
 */
const THUMB_W = 132;

export default {
  id: 'thumbnails',
  activate(ctx) {
    const { reader, ui, h } = ctx;
    let list = null;
    let items = [];
    let observer = null;
    let generation = 0;
    const queue = [];
    let running = 0;
    let current = 0;

    ui.addPanel({
      id: 'thumbnails', title: 'Pages', icon: 'thumbnails', order: 10,
      create(container) {
        list = h('div', { class: 'thumbs', role: 'list' });
        container.append(list);
        build();
        return { onShow: () => scrollToCurrent(true) };
      },
    });

    async function build() {
      if (!list) return;
      generation++;
      observer?.disconnect();
      queue.length = 0;
      list.replaceChildren();
      items = [];
      const doc = reader.doc;
      if (!doc) return;
      const gen = generation;
      const first = await doc.getPage(1);
      if (gen !== generation) return;
      const vp = first.getViewport({ scale: 1, rotation: (first.rotate + reader.rotation) % 360 });
      const ratio = vp.height / vp.width;

      observer = new IntersectionObserver((entries) => {
        for (const e of entries) if (e.isIntersecting) enqueue(Number(e.target.dataset.page), gen);
      }, { root: list.parentElement, rootMargin: '300px 0px' });

      const frag = document.createDocumentFragment();
      for (let n = 1; n <= doc.numPages; n++) {
        const box = h('div', { class: 'thumb-img', style: { width: `${THUMB_W}px`, height: `${Math.round(THUMB_W * ratio)}px` } });
        const item = h('button', {
          type: 'button', class: 'thumb', role: 'listitem', 'data-page': n, title: `Page ${n}`,
          onClick: () => reader.goToPage(n),
          onContextmenu: (e) => { e.preventDefault(); openMenu(n, e.clientX, e.clientY); },
        }, box, h('span', { class: 'thumb-label', text: String(n) }));
        frag.append(item);
        items.push({ item, box, rendered: false });
        observer.observe(item);
      }
      list.append(frag);
      markCurrent(reader.pageNumber);
      scrollToCurrent(true);
    }

    function enqueue(n, gen) {
      const it = items[n - 1];
      if (!it || it.rendered || it.queued) return;
      it.queued = true;
      queue.push(() => render(n, gen));
      pump();
    }

    function pump() {
      while (running < 2 && queue.length) {
        running++;
        queue.shift()().finally(() => { running--; pump(); });
      }
    }

    async function render(n, gen) {
      const doc = reader.doc;
      const it = items[n - 1];
      if (!doc || gen !== generation || !it) return;
      try {
        const page = await doc.getPage(n);
        const rotation = (page.rotate + reader.rotation) % 360;
        const base = page.getViewport({ scale: 1, rotation });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale: (THUMB_W * dpr) / base.width, rotation });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        await page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport, background: '#fff' }).promise;
        if (gen !== generation) return;
        it.box.style.height = `${Math.round((THUMB_W * base.height) / base.width)}px`;
        it.box.replaceChildren(canvas);
        it.rendered = true;
      } catch (err) {
        if (err?.name !== 'RenderingCancelledException') console.warn('Thumbnail failed', n, err);
      } finally {
        it.queued = false;
      }
    }

    function markCurrent(n) {
      items[current - 1]?.item.classList.remove('current');
      items[current - 1]?.item.removeAttribute('aria-current');
      current = n;
      items[n - 1]?.item.classList.add('current');
      items[n - 1]?.item.setAttribute('aria-current', 'page');
    }

    function scrollToCurrent(instant) {
      const el = items[current - 1]?.item;
      if (!el || !list?.offsetParent) return;
      const parent = list.parentElement;
      const top = el.offsetTop - parent.offsetTop;
      if (top < parent.scrollTop || top + el.offsetHeight > parent.scrollTop + parent.clientHeight) {
        parent.scrollTo({ top: top - parent.clientHeight / 3, behavior: instant ? 'instant' : 'smooth' });
      }
    }

    function openMenu(n, x, y) {
      const groups = new Map();
      for (const a of ui.pageActions) {
        if (!groups.has(a.group)) groups.set(a.group, []);
        groups.get(a.group).push(a);
      }
      const menuItems = [{ label: `Go to page ${n}`, run: () => reader.goToPage(n) }];
      for (const actions of groups.values()) {
        menuItems.push({ separator: true });
        for (const a of actions) {
          menuItems.push({ label: a.label, danger: a.danger, disabled: a.enabled ? !a.enabled(n) : false, run: () => Promise.resolve().then(() => a.run(n)).catch((err) => ctx.showError(`${a.label} failed`, err)) });
        }
      }
      ui.contextMenu(x, y, menuItems);
    }

    reader.on('open', build);
    reader.on('close', build);
    reader.on('rotation', build);
    reader.on('page', (n) => { markCurrent(n); scrollToCurrent(false); });
  },
};
