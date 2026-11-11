/**
 * Bookmarks (the PDF's built-in table of contents) in the sidebar.
 */
export default {
  id: 'outline',
  activate(ctx) {
    const { reader, ui, h } = ctx;
    let root = null;

    ui.addPanel({
      id: 'outline', title: 'Bookmarks', icon: 'outline', order: 20,
      create(container) {
        root = h('div', { class: 'outline' });
        container.append(root);
        build();
      },
    });

    async function build() {
      if (!root) return;
      root.replaceChildren();
      const doc = reader.doc;
      if (!doc) return;
      const outline = await doc.getOutline().catch(() => null);
      if (doc !== reader.doc) return;
      if (!outline?.length) {
        root.append(h('p', { class: 'panel-empty', text: 'This document has no bookmarks.' }));
        return;
      }
      root.append(tree(outline, 0));
    }

    function tree(nodes, depth) {
      const ul = h('ul', { role: depth ? 'group' : 'tree' });
      for (const node of nodes) {
        const hasKids = node.items?.length > 0;
        const li = h('li', { role: 'treeitem', 'aria-expanded': hasKids ? String(depth < 1) : null });
        const toggle = h('button', {
          type: 'button', class: 'ol-toggle' + (hasKids ? '' : ' leaf'), tabindex: '-1', 'aria-hidden': 'true',
          html: hasKids ? ctx.icon('right', { size: 14 }) : '',
          onClick: (e) => { e.stopPropagation(); li.setAttribute('aria-expanded', li.getAttribute('aria-expanded') === 'true' ? 'false' : 'true'); },
        });
        const label = h('button', {
          type: 'button', class: 'ol-item', title: node.title, text: node.title || '(untitled)',
          style: { fontWeight: node.bold ? '600' : null, fontStyle: node.italic ? 'italic' : null },
          onClick: () => go(node),
        });
        li.append(h('div', { class: 'ol-row', style: { paddingLeft: `${depth * 14}px` } }, toggle, label));
        if (hasKids) li.append(tree(node.items, depth + 1));
        ul.append(li);
      }
      return ul;
    }

    function go(node) {
      if (node.dest) reader.linkService.goToDestination(node.dest);
      else if (node.url) ctx.use('links').show(node.url);
    }

    reader.on('open', build);
    reader.on('close', build);
  },
};
