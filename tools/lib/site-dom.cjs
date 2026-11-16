'use strict';

/**
 * A very small stand-in for a browser page: just enough to run the website's two data-driven scripts
 * (website/js/integrations.js and website/js/ecosystem.js) against the generated catalogue and read back what they put
 * on the page. The website build and the tests use it to check the page as a visitor would get it, instead of only
 * checking the files it is made from: that every provider is drawn, that a group filter shows that group and nothing
 * else, and that no sentence on the rendered page claims more than the data does.
 *
 * It is deliberately not a browser. An element is a tag, some attributes, a text and a list of children; a page knows
 * the ids that index.html really has and answers `getElementById` only for those, so a script that asks for an id the
 * page does not have is caught (the scripts guard a missing element and would otherwise skip it silently).
 */

const vm = require('node:vm');

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.handlers = {};
    this.className = '';
    this.id = '';
    this.ownText = '';
  }
  set textContent(v) { this.children = []; this.ownText = String(v); }
  get textContent() { return this.ownText + this.children.map((c) => c.textContent).join(''); }
  appendChild(c) { this.children.push(c); return c; }
  append(...cs) { this.children.push(...cs); }
  replaceChildren(...cs) { this.ownText = ''; this.children = cs; }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'id') this.id = String(v); }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn); }
  click() { for (const fn of this.handlers.click ?? []) fn({ target: this, preventDefault() {} }); }
}

/** Every piece of text under an element, one entry per element that holds text of its own. */
function leaves(el, out = []) {
  if (el.ownText.trim()) out.push(el.ownText.trim());
  for (const c of el.children) leaves(c, out);
  return out;
}

/** Every element under (and including) `el` that `pred` accepts. */
function find(el, pred, out = []) {
  if (pred(el)) out.push(el);
  for (const c of el.children) find(c, pred, out);
  return out;
}

const hasClass = (el, cls) => el.className.split(/\s+/).includes(cls);

/** The ids an HTML document declares. */
function idsOf(html) {
  return new Set([...html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/\sid\s*=\s*"([^"]+)"/g)].map((m) => m[1]));
}

/**
 * Runs scripts as a page would: in order, in one shared scope, then fires DOMContentLoaded.
 * `scripts` is a list of { name, source }. Returns the page: `get(id)` for an element the scripts filled,
 * `asked` (every id a script asked for) and `missing` (the ones index.html does not have).
 */
function runSite({ html, scripts }) {
  const ids = idsOf(html);
  const byId = new Map();
  const asked = new Set();
  const ready = [];
  const document = {
    createElement: (tag) => new El(tag),
    getElementById(id) {
      asked.add(id);
      if (!ids.has(id)) return null;
      if (!byId.has(id)) { const e = new El('div'); e.id = id; byId.set(id, e); }
      return byId.get(id);
    },
    addEventListener(type, fn) { if (type === 'DOMContentLoaded') ready.push(fn); },
    querySelectorAll: () => [],
    querySelector: () => null
  };
  const window = { document };
  const context = vm.createContext({ window, document, console });
  for (const s of scripts) vm.runInContext(s.source, context, { filename: s.name });
  for (const fn of ready) fn();
  return {
    window,
    get: (id) => byId.get(id) ?? null,
    asked,
    missing: [...asked].filter((id) => !ids.has(id)),
    filled: [...byId.values()]
  };
}

module.exports = { runSite, leaves, find, hasClass, idsOf, El };
