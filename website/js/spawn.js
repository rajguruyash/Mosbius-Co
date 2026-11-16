/* Mosbius & Co — "watch your coding team come to life".
 *
 * An eleven-beat sequence in the bank floor: a task arrives, Ted hands it out,
 * two agents spawn, walk to real desks, turn the monitors on and work, and the
 * room celebrates when the task lands.
 *
 * It is an animation of the product. Nothing here starts a CLI, and the
 * terminal panel beside it prints a scripted transcript, not live output — the
 * section says so in its own copy.
 */
(function (M) {
  'use strict';

  const ROOM = 'gnb';
  const W = 544, H = 352;

  M.initSpawn = function initSpawn(els) {
    const room = (window.ROOMS && window.ROOMS.rooms[ROOM]) || { seats: [] };
    const seat = (name) => room.seats.find((s) => s.name === name) || { x: 200, y: 200 };
    const standAt = (s) => ({ x: s.x - 1, y: s.y - M.CELL.h + 10 });

    const DOOR = { x: Math.round(W / 2) - 9, y: H - 34 };
    const deskA = seat('pc-12');
    const deskB = seat('pc-14');

    const ted = new M.Actor('ted', Object.assign({ state: 'idle' }, standAt(seat('conf-1'))));
    const lily = new M.Actor('lily', { x: 150, y: 150, state: 'idle' });
    const barney = new M.Actor('barney', { x: DOOR.x, y: DOOR.y, state: 'idle' });
    const marshall = new M.Actor('marshall', { x: DOOR.x + 24, y: DOOR.y, state: 'idle' });
    barney.alpha = 0; barney.hidden = true;
    marshall.alpha = 0; marshall.hidden = true;

    const actors = [ted, lily, barney, marshall];
    const lit = new Set();          // seat names whose screen is on
    let backdrop = null;
    let term = [];
    let beat = -1, beatT = 0, done = false;

    const say = (a, text, ms) => a.say(text, ms || 3000);
    const print = (line, cls) => {
      term.push({ line, cls: cls || '' });
      if (term.length > 7) term.shift();
      if (els.term) {
        els.term.innerHTML = term
          .map((l) => `<span class="${l.cls}">${l.line.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}</span>`)
          .join('\n');
      }
    };

    // The beats. `hold` is how long the beat lasts before the next one starts.
    const BEATS = [
      {
        label: 'Ted opens the command centre', hold: 1700,
        run() {
          print('$ mosbius', 'pre');
          print('command centre ready — 1 agent signed in');
          lit.add('conf-1');
          say(ted, M.line('ted', 'idle'), 1800);
        },
      },
      {
        label: 'A task comes in', hold: 1900,
        run() {
          print('task: "ship the billing migration"', 'warn');
          say(ted, 'We have got a big assignment.', 2400);
        },
      },
      {
        label: 'Ted hands it out', hold: 1800,
        run() {
          print('planning — splitting into 2 pieces');
          say(lily, M.line('lily', 'spawn'), 2400);
        },
      },
      {
        label: 'An agent is hired', hold: 1700,
        run() {
          barney.hidden = false;
          print('hire ▸ barney  (claude code)', 'pre');
          say(barney, M.line('barney', 'spawn'), 2400);
        },
      },
      {
        label: 'It walks to a free desk', hold: 2600,
        run() {
          const p = standAt(deskB);
          barney.walkTo(p.x, p.y, () => { barney.setState('idle'); });
        },
      },
      {
        label: 'The machine comes on', hold: 1200,
        run() { lit.add(deskB.name); print('desk ' + deskB.name + ' ▸ session started'); },
      },
      {
        label: 'It starts working', hold: 2200,
        run() {
          barney.setState('work');
          print('barney ▸ reading src/billing/*.ts');
          say(barney, M.line('barney', 'code'), 2600);
        },
      },
      {
        label: 'A second agent spawns', hold: 2800,
        run() {
          marshall.hidden = false;
          print('hire ▸ marshall  (claude code)', 'pre');
          say(marshall, M.line('marshall', 'spawn'), 2400);
          const p = standAt(deskA);
          marshall.walkTo(p.x, p.y, () => {
            marshall.setState('work');
            lit.add(deskA.name);
            print('desk ' + deskA.name + ' ▸ session started');
          });
        },
      },
      {
        label: 'Both work independently', hold: 3000,
        run() {
          print('marshall ▸ writing tests');
          say(marshall, M.line('marshall', 'code'), 2600);
          setTimeout(() => say(barney, M.line('barney', 'idle'), 2200), 1500);
        },
      },
      {
        label: 'The task lands', hold: 2000,
        run() {
          print('tests 128 passed, 0 failed');
          print('task complete ✓', 'warn');
          say(marshall, M.line('marshall', 'pass'), 2400);
        },
      },
      {
        label: 'The room celebrates', hold: 3200,
        run() {
          for (const a of [ted, lily, barney, marshall]) { if (!a.hidden) a.setState('cheer'); }
          say(lily, M.line('lily', 'pass'), 2800);
          setTimeout(() => say(barney, 'Legendary!', 2600), 700);
        },
      },
    ];

    function renderSteps(now) {
      if (!els.steps) return;
      els.steps.innerHTML = BEATS.map((b, i) => {
        const cls = i === now ? 'is-now' : i < now ? 'is-done' : '';
        return `<li class="${cls}"><span class="n">${String(i + 1).padStart(2, '0')}</span><span>${b.label}</span></li>`;
      }).join('');
    }

    function reset() {
      beat = -1; beatT = 0; done = false;
      term = [];
      lit.clear();
      Object.assign(ted, standAt(seat('conf-1')));
      ted.setState('idle'); ted.target = null; ted.bubble = null;
      lily.x = 150; lily.y = 150; lily.setState('idle'); lily.target = null; lily.bubble = null;
      for (const a of [barney, marshall]) {
        a.hidden = true; a.alpha = 0; a.target = null; a.bubble = null; a.setState('idle');
      }
      barney.x = DOOR.x; barney.y = DOOR.y;
      marshall.x = DOOR.x + 24; marshall.y = DOOR.y;
      renderSteps(-1);
      if (els.term) els.term.textContent = '';
      if (els.state) els.state.textContent = '';
      scene.sync();
    }

    const scene = new M.Scene(els.canvas, {
      width: W, height: H, actors, bubbleLayer: els.bubbles,
      fit(avail) { return { scale: avail >= 1120 ? 2 : 1, width: W, height: H }; },
      update(dt, now, sc) { step(dt, sc); },
      draw(ctx, s, sc) { paint(ctx, s, sc); },
    });

    scene.onPick = (a) => { if (!a.hidden) say(a, M.line(a.name, 'catch'), 2200); };

    function step(dt, sc) {
      // Spawning agents fade in where they appear.
      for (const a of [barney, marshall]) {
        if (!a.hidden && a.alpha < 1) a.alpha = Math.min(1, a.alpha + dt / 420);
      }

      if (M.reducedMotion()) {
        // Still frame: the finished state, with the steps list as the story.
        if (!done) {
          print('$ mosbius', 'pre');
          print('task: "ship the billing migration"', 'warn');
          print('hire ▸ barney, marshall  (claude code)', 'pre');
          print('tests 128 passed, 0 failed');
          print('task complete ✓', 'warn');
          barney.hidden = marshall.hidden = false;
          barney.alpha = marshall.alpha = 1;
          Object.assign(barney, standAt(deskB)); barney.setState('work');
          Object.assign(marshall, standAt(deskA)); marshall.setState('work');
          lit.add(deskA.name); lit.add(deskB.name);
          renderSteps(BEATS.length - 1);
          if (els.state) els.state.textContent = 'Animation paused — you asked for reduced motion.';
          done = true;
        }
        return;
      }

      beatT -= dt;
      if (beatT <= 0) {
        beat++;
        if (beat >= BEATS.length) { beat = BEATS.length - 1; beatT = 1e9; done = true;
          if (els.state) els.state.textContent = 'That is the whole loop.';
          for (const a of actors) if (a.state === 'cheer') a.setState('idle');
          return;
        }
        BEATS[beat].run();
        beatT = BEATS[beat].hold;
        renderSteps(beat);
      }
    }

    function paint(ctx, s, sc) {
      const t = sc.elapsed;
      if (backdrop) ctx.drawImage(backdrop, 0, 0, W * s, H * s);
      else { ctx.fillStyle = '#20202c'; ctx.fillRect(0, 0, sc.canvas.width, sc.canvas.height); }
      for (const name of lit) {
        const st = room.seats.find((x) => x.name === name);
        if (st && st.screen) M.screenGlow(ctx, st.screen, s, t + st.x * 9);
      }
      // the doorway the agents arrive through
      ctx.globalAlpha = 0.25 + 0.1 * Math.sin(t / 700);
      ctx.fillStyle = '#ffc94a';
      ctx.fillRect(DOOR.x * s, (DOOR.y + M.CELL.h - 3) * s, M.CELL.w * 2 * s, 2 * s);
      ctx.globalAlpha = 1;
    }

    Promise.all([M.loadAtlas(), M.image(room.file || 'assets/rooms/gnb.png')]).then(([, img]) => {
      backdrop = img;
      reset();
      scene.renderOnce();
    });

    if (els.replay) els.replay.addEventListener('click', reset);
    return scene;
  };
})(window.M);
