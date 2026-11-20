/* The screenshots section. Captions and files come from window.MOSBIUS_CATALOGUE (js/catalogue.js), written by
 * tools/build-website.cjs, which copies the images from the repository so a picture cannot be edited by hand. */
(function () {
  'use strict';

  const C = window.MOSBIUS_CATALOGUE;
  const $ = (id) => document.getElementById(id);

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function renderShots() {
    const host = $('shots');
    if (!host) return;
    host.replaceChildren(...C.screenshots.map((s) => {
      const fig = el('figure', 'shot');
      const img = el('img');
      img.setAttribute('src', s.file);
      img.setAttribute('alt', s.alt);
      img.setAttribute('width', String(s.width));
      img.setAttribute('height', String(s.height));
      img.setAttribute('loading', 'lazy');
      img.setAttribute('decoding', 'async');
      const link = el('a', 'shot-link');
      link.setAttribute('href', s.file);
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener');
      link.setAttribute('aria-label', s.title + ': open the full-size picture');
      link.appendChild(img);
      fig.appendChild(link);
      const cap = el('figcaption');
      cap.appendChild(el('b', null, s.title));
      cap.appendChild(el('span', null, s.caption));
      fig.appendChild(cap);
      return fig;
    }));
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!C) return;
    renderShots();
  });
})();
