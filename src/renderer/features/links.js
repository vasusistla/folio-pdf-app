/**
 * Web links inside PDFs. Folio PDF is offline by design, so a click on a
 * website or e-mail link never opens anything: it shows the address so you
 * can decide yourself whether to copy it into a browser.
 * Links to other pages in the same PDF work normally.
 */
export default {
  id: 'links',
  activate(ctx) {
    const { host, ui, h } = ctx;
    let open = false;

    async function show(url) {
      if (open) return;
      open = true;
      const body = h('div', { class: 'form' },
        h('p', { text: 'This PDF links to a web address. Folio PDF works offline and never opens the internet, so the link was not opened.' }),
        h('code', { class: 'link-url', text: url }),
        h('p', { class: 'hint', text: 'If you trust it, copy the address and paste it into your browser yourself.' }));
      const choice = await ui.modal({
        title: 'Web link not opened',
        body,
        buttons: [{ label: 'Close', value: null }, { label: 'Copy address', value: 'copy', primary: true }],
      });
      open = false;
      if (choice === 'copy') {
        await host.copyText(url);
        ui.toast('Address copied');
      }
    }

    host.onExternalLink(show);
    ctx.provide('links', { show });
  },
};
