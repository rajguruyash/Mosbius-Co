/* Mosbius & Co — the short reels.
 *
 * Each reel is a timeline of cues over one of the painted backdrops, with a
 * slow camera pan where the backdrop is wider than the frame. They loop, they
 * are silent, and they are made entirely of the same sprites and rooms as the
 * app — no footage, no music.
 */
(function (M) {
  'use strict';

  const W = 544, H = 352;
  const rooms = (window.ROOMS && window.ROOMS.rooms) || {};
  const file = (id) => (rooms[id] ? rooms[id].file : 'assets/rooms/' + id + '.png');

  // Street reel geometry — same crop as the hero.
  // Matches the hero's view of the same elevation: the apartment, the pub
  // under it and the stoop, all in one frame.
  const CROP_Y = 18;
  const STREET_H = 284;
  const STREET_FEET = 264 - CROP_Y;

  const REELS = [
    {
      id: 'arrive',
      title: 'The gang arrives',
      note: 'A cab goes past, Ted turns up with the umbrella, and the five of them ' +
            'collect outside MacLaren\'s. The backdrop is the app\'s own street.',
      bg: 'assets/scene/street.png', crop: CROP_Y, height: STREET_H, pan: 'right',
      // the stoop's near handrail, drawn over the cast so Ted climbs between
      // the two railings rather than behind both
      ov: 'assets/scene/street-ov.png',
      // …except the pub's green railing, which the cast stands in front of
      ovBehind: ((window.ROOMS && window.ROOMS.street && window.ROOMS.street.pubSteps) || {}).ov,
      cast: [
        { name: 'ted', x: -30, y: STREET_FEET - M.CELL.h, umbrella: true },
        { name: 'marshall', x: -70, y: STREET_FEET - M.CELL.h },
        { name: 'lily', x: -100, y: STREET_FEET - M.CELL.h },
        { name: 'robin', x: -130, y: STREET_FEET - M.CELL.h },
        { name: 'barney', x: -160, y: STREET_FEET - M.CELL.h },
      ],
      length: 14000,
      cues: [
        { at: 200, run: (r) => { r.cab(); r.a('ted').walkTo(150, () => r.a('ted').setState('idle')); } },
        { at: 900, run: (r) => r.a('marshall').walkTo(196, () => r.a('marshall').setState('idle')) },
        { at: 1600, run: (r) => r.a('lily').walkTo(240, () => r.a('lily').setState('idle')) },
        { at: 2400, run: (r) => r.a('robin').walkTo(284, () => r.a('robin').setState('idle')) },
        { at: 3200, run: (r) => r.a('barney').walkTo(330, () => { r.a('barney').setState('wave'); }) },
        { at: 5200, run: (r) => r.say('ted', 'idle') },
        { at: 7600, run: (r) => { r.say('barney', 'catch'); r.cab(); } },
        { at: 10200, run: (r) => r.say('robin', 'catch') },
        { at: 9400, run: (r) => { r.say('ted', 'home'); r.toward('ted', 386, 202); } },
        { at: 11400, run: (r) => r.toward('ted', 478, 148) },
        { at: 12600, run: (r) => r.say('lily', 'idle') },
      ],
    },
    {
      id: 'office',
      title: 'The office comes alive',
      note: 'Agents are hired, cross the bank floor, sit down and the monitors come ' +
            'on. This is the same sequence as the demonstration above, uninterrupted.',
      bg: file('gnb'), room: 'gnb', pan: 'left',
      cast: [
        { name: 'ted', seat: 'conf-1' },
        { name: 'barney', x: 250, y: 320, alpha: 0 },
        { name: 'marshall', x: 280, y: 320, alpha: 0 },
        { name: 'lily', x: 160, y: 150 },
      ],
      length: 15000,
      cues: [
        { at: 300, run: (r) => r.say('ted', 'spawn') },
        { at: 1600, run: (r) => { r.fadeIn('barney'); r.say('barney', 'spawn'); } },
        { at: 2200, run: (r) => r.toSeat('barney', 'pc-14', true) },
        { at: 4200, run: (r) => { r.fadeIn('marshall'); r.say('marshall', 'spawn'); } },
        { at: 4800, run: (r) => r.toSeat('marshall', 'pc-12', true) },
        { at: 7400, run: (r) => r.say('barney', 'code') },
        { at: 9800, run: (r) => r.say('marshall', 'code') },
        { at: 12200, run: (r) => r.say('lily', 'code') },
      ],
    },
    {
      id: 'night',
      title: 'The late-night session',
      note: 'Rain on the window, two sessions still running, and the shape of a long ' +
            'evening. The apartment is the app\'s own room.',
      bg: file('apartment'), room: 'apartment', fx: 'night', pan: 'right',
      cast: [
        { name: 'ted', seat: 'desk-ceo', state: 'work' },
        { name: 'marshall', seat: 'pc-2', state: 'work' },
        { name: 'lily', x: 300, y: 200 },
      ],
      length: 13000,
      cues: [
        { at: 600, run: (r) => r.say('marshall', 'idle') },
        { at: 3400, run: (r) => r.say('ted', 'code') },
        { at: 6000, run: (r) => { const a = r.a('lily'); a.walkTo(200, 210, () => a.setState('idle')); } },
        { at: 7600, run: (r) => r.say('lily', 'code') },
        { at: 10400, run: (r) => r.say('ted', 'idle') },
      ],
    },
    {
      id: 'ship',
      title: 'The legendary deployment',
      note: 'Green tests, a deploy, and everyone downstairs in the booth. The pub is ' +
            'the app\'s own room, lit the way the app lights it.',
      bg: file('maclarens'), room: 'maclarens', fx: 'warm', pan: 'left',
      cast: [
        { name: 'carl', x: 110, y: 100 },
        { name: 'ted', x: 240, y: 300 },
        { name: 'barney', x: 200, y: 300 },
        { name: 'marshall', x: 280, y: 300 },
        { name: 'robin', x: 320, y: 300 },
        { name: 'lily', x: 160, y: 300 },
      ],
      length: 14000,
      cues: [
        { at: 300, run: (r) => r.say('marshall', 'pass') },
        { at: 1800, run: (r) => { r.say('barney', 'deploy'); r.cheer(); } },
        { at: 4200, run: (r) => { r.calm(); r.say('robin', 'pass'); } },
        { at: 6000, run: (r) => { for (const n of ['ted', 'barney', 'marshall', 'robin', 'lily']) r.toward(n, 170 + Math.random() * 180, 150 + Math.random() * 90); } },
        { at: 9000, run: (r) => r.say('carl', 'room') },
        { at: 11000, run: (r) => r.say('lily', 'pass') },
      ],
    },
  ];

  M.REELS = REELS;

  M.initCinema = function initCinema(els, onReel) {
    let reel = REELS[0];
    let backdrop = null, overlay = null;
    let actors = [];
    let clock = 0;
    let fired = 0;
    let cabX = -200, cabOn = false;
    let cabImg = null;
    let cam = 0;

    const api = {
      a: (name) => actors.find((x) => x.name === name) || new M.Actor(name, {}),
      say: (name, kind) => { const a = api.a(name); if (a) a.say(M.line(name, kind, reel.room), 2800); },
      cab: () => { cabOn = true; cabX = -180; },
      fadeIn: (name) => { const a = api.a(name); a.hidden = false; a.alpha = 0; },
      toSeat: (name, seatName, work) => {
        const a = api.a(name);
        const room = rooms[reel.room];
        const s = room && room.seats.find((x) => x.name === seatName);
        if (!s) return;
        a.walkTo(s.x - 1, s.y - M.CELL.h + 10, () => a.setState(work ? 'work' : 'idle'));
      },
      toward: (name, x, y) => { const a = api.a(name); a.walkTo(x, y, () => a.setState('idle')); },
      cheer: () => actors.forEach((a) => { if (!a.hidden) a.setState('cheer'); }),
      calm: () => actors.forEach((a) => { if (a.state === 'cheer') a.setState('idle'); }),
    };

    const scene = new M.Scene(els.canvas, {
      width: W, height: H, actors, bubbleLayer: els.bubbles,
      fit(avail) {
        const scale = avail >= 1120 ? 2 : 1;
        // Show a window into the backdrop so the camera has somewhere to pan.
        const width = Math.max(260, Math.min(W, Math.ceil(avail / scale)));
        return { scale, width, height: reel.height || H };
      },
      update(dt, now, sc) { step(dt, sc); },
      draw(ctx, s, sc) { paint(ctx, s, sc); },
    });

    scene.onPick = (a) => { if (!a.hidden) a.say(M.line(a.name, 'catch', reel.room), 2200); };

    function build() {
      actors.length = 0;
      clock = 0; fired = 0; cabOn = false; cam = 0;
      for (const c of reel.cast) {
        const room = rooms[reel.room];
        const s = c.seat && room ? room.seats.find((x) => x.name === c.seat) : null;
        const a = new M.Actor(c.name, {
          x: s ? s.x - 1 : c.x,
          y: s ? s.y - M.CELL.h + 10 : c.y,
          state: c.state || 'idle',
        });
        if (c.alpha === 0) { a.alpha = 0; a.hidden = true; }
        a.umbrella = !!c.umbrella;
        actors.push(a);
      }
      scene.world.h = reel.height || H;
      scene.resize();
    }

    function step(dt, sc) {
      for (const a of actors) if (!a.hidden && a.alpha !== undefined && a.alpha < 1) a.alpha = Math.min(1, a.alpha + dt / 400);

      if (M.reducedMotion()) {
        if (fired === 0) { reel.cues.forEach((c) => { try { c.run(api); } catch (e) { /* skip */ } }); fired = reel.cues.length; }
        return;
      }

      clock += dt;
      while (fired < reel.cues.length && clock >= reel.cues[fired].at) {
        reel.cues[fired].run(api);
        fired++;
      }
      if (clock >= reel.length) { build(); }

      if (cabOn) {
        cabX += dt * 0.09;
        if (cabX > W + 40) cabOn = false;
      }

      // Slow camera drift across whatever is not on screen.
      const span = Math.max(0, W - sc.world.w);
      if (span > 0) {
        const p = 0.5 - 0.5 * Math.cos((clock / reel.length) * Math.PI * 2);
        cam = Math.round((reel.pan === 'left' ? 1 - p : p) * span);
      } else cam = 0;

      if (els.progress) els.progress.style.width = Math.min(100, (clock / reel.length) * 100) + '%';
    }

    function paint(ctx, s, sc) {
      const t = sc.elapsed;
      ctx.save();
      ctx.translate(-cam * s, 0);

      if (backdrop) {
        const cy = reel.crop || 0;
        ctx.drawImage(backdrop, 0, cy, W, sc.world.h, 0, 0, W * s, sc.world.h * s);
      } else {
        ctx.fillStyle = '#20202c';
        ctx.fillRect(0, 0, W * s, sc.world.h * s);
      }

      if (cabOn) M.cab(ctx, cabImg, cabX, STREET_FEET + 26, s, false);

      const room = rooms[reel.room];
      if (room) {
        for (const a of actors) {
          if (a.state !== 'work') continue;
          const seat = room.seats.find((x) => x.screen && Math.abs(x.x - 1 - a.x) < 3);
          if (seat) M.screenGlow(ctx, seat.screen, s, t + seat.x * 5);
        }
      }

      const ted = actors.find((a) => a.umbrella);
      if (ted) M.umbrella(ctx, ted.x - 9, ted.y + 8, s, ted.state === 'walk');

      if (reel.fx === 'night') {
        ctx.globalAlpha = 0.26; ctx.fillStyle = '#121a33';
        ctx.fillRect(0, 0, W * s, sc.world.h * s); ctx.globalAlpha = 1;
        M.rain(ctx, W, sc.world.h, s, t, 34);
      }
      if (reel.fx === 'warm') M.warmWash(ctx, W, sc.world.h, s, t);
      ctx.restore();

      // Letterbox bars, so a reel reads as a reel.
      ctx.fillStyle = '#26222e';
      ctx.fillRect(0, 0, sc.canvas.width, 4 * s);
      ctx.fillRect(0, sc.canvas.height - 4 * s, sc.canvas.width, 4 * s);
    }

    // The camera pan lives in paint, so actors must be drawn panned too.
    const baseDraw = scene.draw.bind(scene);
    scene.draw = function draw() {
      const { ctx } = this;
      this.camX = cam;
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.imageSmoothingEnabled = false;
      paint(ctx, this.scale, this);
      ctx.save();
      ctx.translate(-cam * this.scale, 0);
      const slice = (x0, x1) => {
        if (overlay && reel.ov && x1 > x0) {
          ctx.drawImage(overlay, x0, reel.crop || 0, x1 - x0, this.world.h,
            x0 * this.scale, 0, (x1 - x0) * this.scale, this.world.h * this.scale);
        }
      };
      const B = reel.ovBehind;
      if (B) slice(B.x, B.x + B.w);
      for (const a of [...actors].sort((p, q) => p.y - q.y)) a.draw(ctx, this.scale);
      if (B) { slice(0, B.x); slice(B.x + B.w, W); } else slice(0, W);
      ctx.restore();
      this.syncBubbles();
    };

    scene.show = function show(id) {
      const next = REELS.find((r) => r.id === id);
      if (!next || next === reel) return;
      reel = next;
      overlay = null;
      M.image(reel.bg).then((img) => { backdrop = img; build(); scene.renderOnce(); scene.sync(); });
      if (reel.ov) M.image(reel.ov).then((img) => { overlay = img; scene.renderOnce(); });
      if (onReel) onReel(reel);
    };

    Promise.all([M.loadAtlas(), M.image(reel.bg), M.image('assets/scene/cab.png')]).then(([, img, cb]) => {
      backdrop = img; cabImg = cb;
      if (reel.ov) M.image(reel.ov).then((o) => { overlay = o; scene.renderOnce(); });
      build();
      if (onReel) onReel(reel);
      scene.renderOnce();
      scene.sync();
    });

    return scene;
  };
})(window.M);
