/* Mosbius & Co — page wiring.
 *
 * Builds the crew cards, starts each scene, and connects the tab strips. Every
 * scene manages its own loop and stops itself when it scrolls away.
 */
(function (M) {
  'use strict';

  const $ = (id) => document.getElementById(id);

  function teamCards(onPick) {
    const host = $('team-cards');
    if (!host) return;
    host.innerHTML = '';
    for (const c of M.CAST) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'member';
      card.dataset.name = c.name;
      card.setAttribute('aria-pressed', 'false');

      const cv = document.createElement('canvas');
      cv.width = 54; cv.height = 84; cv.setAttribute('aria-hidden', 'true');
      card.appendChild(cv);

      const who = document.createElement('span');
      who.className = 'who'; who.textContent = c.label;
      card.appendChild(who);

      const role = document.createElement('span');
      role.className = 'role'; role.textContent = c.role.toUpperCase();
      card.appendChild(role);

      const blurb = document.createElement('p');
      blurb.className = 'blurb'; blurb.textContent = c.blurb;
      card.appendChild(blurb);

      card.addEventListener('click', () => onPick(c.name));
      host.appendChild(card);

      M.loadAtlas().then(() => {
        const ctx = cv.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        M.drawPortrait(ctx, c.name, 0, 0, 3);
      });
    }
  }

  function highlight(name) {
    document.querySelectorAll('.member').forEach((el) => {
      el.setAttribute('aria-pressed', String(el.dataset.name === name));
    });
  }

  function tabs(host, items, onChoose, cls) {
    if (!host) return;
    host.innerHTML = '';
    items.forEach((it, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls || 'tab';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(i === 0));
      b.textContent = it.label;
      b.dataset.id = it.id;
      b.addEventListener('click', () => {
        host.querySelectorAll('[role=tab]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
        onChoose(it.id);
      });
      host.appendChild(b);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    // ── hero ──
    let hero = null;
    if ($('hero-canvas')) {
      // Clicking someone in the scene marks their card further down the page,
      // but does not drag you away from the bubble you just asked for.
      hero = M.initHero($('hero-canvas'), $('hero-bubbles'), (name) => highlight(name));
      M.hero = hero;      // so the scene can be driven from the console / checks
    }

    // ── crew cards ── clicking one sends you back to that character outside
    //    the bar, where they introduce themselves.
    teamCards((name) => {
      highlight(name);
      if (hero && hero.poke) {
        document.getElementById('top').scrollIntoView({ behavior: M.reducedMotion() ? 'auto' : 'smooth' });
        setTimeout(() => hero.poke(name, true), M.reducedMotion() ? 0 : 500);
      }
    });

    // ── the demonstration ──
    if ($('spawn-canvas')) {
      M.initSpawn({
        canvas: $('spawn-canvas'),
        bubbles: $('spawn-bubbles'),
        steps: $('spawn-steps'),
        term: $('spawn-term'),
        replay: $('spawn-replay'),
        state: $('spawn-state'),
      });
    }

    // ── locations ──
    if ($('room-canvas')) {
      const rooms = (window.ROOMS && window.ROOMS.rooms) || {};
      const order = Object.keys(M.ROOM_PLAN).sort((a, b) => M.ROOM_PLAN[a].order - M.ROOM_PLAN[b].order);
      const scene = M.initRooms($('room-canvas'), $('room-bubbles'), (id, room) => {
        if ($('room-title')) $('room-title').textContent = room ? room.label : id;
        if ($('room-blurb')) $('room-blurb').textContent = room ? room.blurb : '';
      });
      tabs($('room-tabs'), order.map((id) => ({ id, label: (rooms[id] || {}).label || id })), (id) => scene.show(id));
      scene.show(order[0]);
    }

    // ── reels ──
    if ($('reel-canvas')) {
      const scene = M.initCinema({
        canvas: $('reel-canvas'),
        bubbles: $('reel-bubbles'),
        progress: $('reel-progress'),
      }, (reel) => { if ($('reel-note')) $('reel-note').textContent = reel.note; });
      tabs($('reel-tabs'), M.REELS.map((r) => ({ id: r.id, label: r.title })), (id) => scene.show(id), 'tab');
    }

    // ── the portrait in the integrations panel ──
    const pp = $('plug-portrait');
    if (pp) {
      M.loadAtlas().then(() => {
        const ctx = pp.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        M.drawPortrait(ctx, 'ted', 0, 0, 2);
      });
    }
  });
})(window.M);
