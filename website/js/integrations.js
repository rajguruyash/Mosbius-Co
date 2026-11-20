/* The integrations catalogue.
 *
 * Every group and card comes from window.MOSBIUS_CATALOGUE (js/catalogue.js), which tools/build-website.cjs writes from the
 * app's own provider data, so the page lists exactly what the app offers. Only a tile colour and initials are kept here. */
(function () {
  'use strict';

  const C = window.MOSBIUS_CATALOGUE;
  const $ = (id) => document.getElementById(id);

  /* presentation only: [tile colour, initials] */
  const TILE = {
    'sequential-thinking': ['#5b53d6', 'S'],
    time: ['#6b7a4b', 'T'],
    fetch: ['#2f6fb0', 'W'],
    filesystem: ['#3f7f4f', 'F'],
    git: ['#d9643a', 'G'],
    context7: ['#111827', 'C7'],
    playwright: ['#2d7d46', 'B'],
    github: ['#24292f', 'GH'],
    sentry: ['#362d59', 'SE'],
    notion: ['#000000', 'N'],
    linear: ['#5e6ad2', 'L'],
    jira: ['#0052cc', 'J'],
    confluence: ['#1868db', 'CF'],
    slack: ['#4a154b', 'SL'],
    gmail: ['#c5221f', 'M'],
    'google-calendar': ['#1a73e8', 'GC'],
    'google-drive': ['#188038', 'GD'],
    'brave-search': ['#c8401f', 'BR'],
    stripe: ['#635bff', 'ST'],
    hubspot: ['#c4532f', 'H'],
    'custom-rest': ['#0066cc', '+']
  };

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* how a visitor sets each one up, in plain words */
  const HOW = { local: 'Runs on your computer', account: 'Sign in', device: 'Sign in with a code', 'own-app': 'Your own OAuth app', key: 'API key' };
  function howText(p) {
    return p.ways.map((w) => HOW[w]).filter(Boolean).join(' or ');
  }

  function tileFor(p) {
    const fallback = p.label.split(/\s+/).slice(0, 2).map((w) => w.charAt(0)).join('').toUpperCase();
    const t = TILE[p.id] || ['#3a3a50', fallback];
    const s = el('span', 'tile', t[1]);
    s.style.background = t[0];
    s.setAttribute('aria-hidden', 'true');
    return s;
  }

  function cardFor(p) {
    const card = el('li', 'card');
    card.appendChild(tileFor(p));
    card.appendChild(el('span', 'name', p.label));
    card.appendChild(el('span', 'meta', howText(p)));
    card.appendChild(el('p', 'desc', p.description));
    return card;
  }

  function groupBlock(g) {
    const block = el('div', 'card-group');
    block.appendChild(el('h3', 'card-group-title', g.title));
    block.appendChild(el('p', 'card-group-blurb', g.blurb));
    const list = el('ul', 'cards');
    for (const p of g.providers) list.appendChild(cardFor(p));
    block.appendChild(list);
    return block;
  }

  const chips = [];

  function show(groupId) {
    const host = $('cards');
    if (!host) return;
    const groups = groupId === 'all' ? C.groups : C.groups.filter((g) => g.id === groupId);
    host.replaceChildren(...groups.map(groupBlock));
    for (const c of chips) c.setAttribute('aria-pressed', String(c.dataset.group === groupId));
  }

  function renderFilters() {
    const host = $('filters');
    if (!host) return;
    const items = [{ id: 'all', title: 'All' }].concat(C.groups.map((g) => ({ id: g.id, title: g.title })));
    for (const it of items) {
      const b = el('button', 'chip', it.title.toUpperCase());
      b.type = 'button';
      b.dataset.group = it.id;
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => show(it.id));
      chips.push(b);
      host.appendChild(b);
    }
  }

  /* A new agent starts with no access; the panel shows that starting point. */
  function renderPanel() {
    const slots = $('slots');
    if (slots) slots.replaceChildren(el('li', 'slot is-empty', 'nothing until you allow it'));
    const count = $('slot-count');
    if (count) count.textContent = 'NONE AT FIRST';
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!C) return;
    renderFilters();
    renderPanel();
    show('all');
  });
})();
