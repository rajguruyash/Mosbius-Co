/* The integrations section.
 *
 * Nothing about a provider is typed in this file. Every group, card, count and status word comes from
 * window.MOSBIUS_CATALOGUE (js/catalogue.js), which tools/build-website.cjs writes from the app's own data: the provider
 * list, how each connects, and how far each has been checked. So this page cannot list a provider the app does not have,
 * miss one it does, or call one checked when it is not. `npm run website:build` runs this file against that data and
 * reads what it renders, and fails if a card is missing or a sentence claims too much.
 *
 * The only thing kept here is presentation: a tile colour and initials per provider, with a fallback, so a provider added
 * to the app still gets a card the day it is added.
 */
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
    salesforce: ['#0b6fa4', 'SF'],
    'custom-rest': ['#0066cc', '+']
  };

  /* which existing tag style each state uses; the words themselves come from the data */
  const CHIP_CLASS = {
    'locally-tested': 'tag-on',
    'partly-tested': 'tag-consent',
    'stand-in-tested': 'tag-consent',
    'not-implemented': 'tag-planned'
  };

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function termLabel(id) {
    const t = C.terms.find((x) => x.id === id);
    return t ? t.label : id;
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
    const card = el('li', 'card' + (p.notImplemented ? ' is-planned' : ''));
    card.appendChild(tileFor(p));
    card.appendChild(el('span', 'name', p.label));
    card.appendChild(el('span', 'meta', p.connectsBy.length ? p.connectsBy.join(' · ') : 'not available yet'));
    card.appendChild(el('p', 'desc', p.description));

    const status = el('span', 'status');
    status.appendChild(el('span', 'tag ' + (CHIP_CLASS[p.chip] || 'tag-optin'), p.chipLabel.toUpperCase()));
    if (p.notYetVerified) status.appendChild(el('span', 'tag tag-optin', termLabel('not-yet-verified').toUpperCase()));
    card.appendChild(status);

    if (p.note) {
      const more = el('details', 'checked');
      more.appendChild(el('summary', null, 'What was checked'));
      more.appendChild(el('p', null, p.note));
      card.appendChild(more);
    }
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

  /* One sentence about what is on screen, counted from the cards themselves. */
  function tally(list) {
    const count = (fn) => list.filter(fn).length;
    const parts = [];
    const local = count((p) => p.chip === 'locally-tested');
    const partly = count((p) => p.chip === 'partly-tested');
    const standIn = count((p) => p.chip === 'stand-in-tested');
    const absent = count((p) => p.notImplemented);
    if (local) parts.push(local + ' locally tested');
    if (partly) parts.push(partly + ' partly tested locally');
    if (standIn) parts.push(standIn + ' stand-in tested');
    if (absent) parts.push(absent + ' not implemented');

    const needAccount = list.filter((p) => p.realAccountVerified !== 'na' && !p.notImplemented);
    const real = count((p) => p.realAccountVerified === 'yes');
    let account = 'None of these needs an account.';
    if (needAccount.length) {
      account = real === 0
        ? (needAccount.length === 1 ? 'It has not been verified with a real account.' : 'None of them has been verified with a real account.')
        : real + ' of ' + needAccount.length + ' verified with a real account.';
    }
    return 'Showing ' + list.length + ': ' + parts.join(', ') + '. ' + account;
  }

  const chips = [];

  function show(groupId) {
    const host = $('cards');
    const caption = $('cards-caption');
    if (!host) return;
    const groups = groupId === 'all' ? C.groups : C.groups.filter((g) => g.id === groupId);
    host.replaceChildren(...groups.map(groupBlock));
    if (caption) caption.textContent = tally(groups.flatMap((g) => g.providers));
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

  function renderLegend() {
    const host = $('legend');
    if (host) {
      for (const t of C.terms) {
        host.appendChild(el('dt', null, t.label));
        host.appendChild(el('dd', null, t.meaning));
      }
    }
    const counts = $('catalogue-counts');
    if (counts) {
      counts.textContent = C.countsSentence + (C.engineKeys.length
        ? ' The Discover tab in the app also lists the keys the agents\' own engines use (' + C.engineKeys.join(', ') +
          '); those are set under AI engines and are not integrations, so they are not counted here.'
        : '');
    }
  }

  /* A new agent can reach nothing. The panel says so, instead of listing servers as if they were on:
   * nothing is switched on at install, and switching one on still gives no agent access to it. */
  function renderPanel() {
    const slots = $('slots');
    if (slots) slots.replaceChildren(el('li', 'slot is-empty', 'nothing until you allow it'));
    const count = $('slot-count');
    if (count) count.textContent = 'NOTHING AT FIRST';
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!C) return;
    renderFilters();
    renderLegend();
    renderPanel();
    show('all');
  });
})();
