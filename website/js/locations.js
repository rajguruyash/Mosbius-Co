/* Mosbius & Co — the locations.
 *
 * One canvas, one room at a time. Each room is the app's own painted backdrop with a
 * cast that belongs there, standing on the seats the world file actually
 * defines. Switching rooms fades out, swaps the backdrop and cast, and fades
 * back in, so it reads as a cut rather than a jump.
 */
(function (M) {
  'use strict';

  const ROOMS = (window.ROOMS && window.ROOMS.rooms) || {};

  // Who is in which room, and the ambient effect that room runs. Positions are
  // seat names from the world file where a seat makes sense, or a fraction of
  // the room width where the character is just standing about.
  const PLAN = {
    apartment: {
      order: 1,
      fx: 'umbrella',
      cast: [
        { name: 'ted', seat: 'desk-ceo', state: 'work' },
        { name: 'marshall', at: 0.40, y: 0.56, state: 'idle' },
        { name: 'lily', at: 0.52, y: 0.60, state: 'idle' },
        { name: 'robin', at: 0.72, y: 0.46, state: 'idle' },
      ],
      script: [
        ['ted', 'room'], ['marshall', 'room'], ['lily', 'room'], ['robin', 'code'],
      ],
    },
    maclarens: {
      order: 2, fx: 'warm',
      cast: [
        { name: 'carl', at: 0.22, y: 0.30, state: 'idle' },
        { name: 'barney', at: 0.44, y: 0.52, state: 'idle' },
        { name: 'ted', at: 0.56, y: 0.52, state: 'idle' },
        { name: 'robin', at: 0.68, y: 0.52, state: 'idle' },
      ],
      script: [['carl', 'room'], ['barney', 'catch'], ['ted', 'idle'], ['robin', 'catch']],
    },
    gnb: {
      order: 3, fx: 'screens',
      cast: [
        { name: 'barney', at: 0.30, y: 0.34, state: 'talk' },
        { name: 'arthur', at: 0.46, y: 0.34, state: 'idle' },
        { name: 'marshall', seat: 'pc-12', state: 'work' },
        { name: 'randy', seat: 'pc-13', state: 'work' },
      ],
      script: [['barney', 'room'], ['arthur', 'room'], ['marshall', 'code']],
    },
    rooftop: {
      order: 4, fx: 'skyline',
      cast: [
        { name: 'robin', at: 0.42, y: 0.52, state: 'idle' },
        { name: 'ted', at: 0.54, y: 0.52, state: 'idle' },
      ],
      script: [['robin', 'room'], ['ted', 'idle']],
    },
    barney: {
      order: 5, fx: 'screens',
      cast: [
        { name: 'barney', seat: 'barney-boss', state: 'work' },
        { name: 'ted', at: 0.58, y: 0.62, state: 'idle' },
      ],
      script: [['barney', 'room'], ['ted', 'idle']],
    },
    columbia: {
      order: 6, fx: 'none',
      cast: [
        { name: 'ted', at: 0.50, y: 0.22, state: 'talk' },
        { name: 'student1', at: 0.30, y: 0.60, state: 'idle' },
        { name: 'student2', at: 0.44, y: 0.60, state: 'idle' },
        { name: 'student5', at: 0.58, y: 0.60, state: 'idle' },
        { name: 'student6', at: 0.72, y: 0.60, state: 'idle' },
      ],
      script: [['ted', 'room'], ['student1', 'idle']],
    },
    lasertag: {
      order: 7, fx: 'lasers',
      cast: [
        { name: 'barney', at: 0.36, y: 0.52, state: 'idle' },
        { name: 'robin', at: 0.52, y: 0.44, state: 'idle' },
        { name: 'kid1', at: 0.66, y: 0.62, state: 'idle' },
        { name: 'kid2', at: 0.26, y: 0.66, state: 'idle' },
      ],
      script: [['barney', 'room'], ['robin', 'catch']],
    },
  };

  M.ROOM_PLAN = PLAN;

  M.initRooms = function initRooms(canvas, bubbleLayer, onRoom) {
    const W = 544, H = 352;
    let backdrop = null;
    let current = null;
    let fade = 1;          // 1 = fully visible
    let fadingTo = null;
    let nextLine = 1500;
    let scriptAt = 0;
    const actors = [];

    const scene = new M.Scene(canvas, {
      width: W, height: H, actors, bubbleLayer,
      fit(avail) {
        const scale = avail >= 1120 ? 2 : 1;
        return { scale, width: W, height: H };
      },
      update(dt, now, sc) { step(dt, sc); },
      draw(ctx, s, sc) { paint(ctx, s, sc); },
    });

    scene.onPick = (a) => {
      const kind = M.hasRoomLine(a.name, current) ? 'room' : 'catch';
      a.say(M.line(a.name, kind, current), 2600);
      a.setState('wave');
      setTimeout(() => { if (a.state === 'wave') a.setState(a.home || 'idle'); }, 1300);
    };

    function wander(a) {
      if (a.home === 'work' || a.target !== null || a.bubble) return;
      if (Math.random() > 0.012) return;
      const dx = (Math.random() - 0.5) * 90;
      const x = Math.max(16, Math.min(W - M.CELL.w - 16, a.x + dx));
      a.walkTo(x, () => a.setState(a.home || 'idle'));
    }

    function step(dt, sc) {
      if (fadingTo) {
        fade -= dt / 180;
        if (fade <= 0) { apply(fadingTo); fadingTo = null; fade = 0; }
        return;
      }
      if (fade < 1) fade = Math.min(1, fade + dt / 220);
      if (M.reducedMotion()) return;

      for (const a of actors) wander(a);

      nextLine -= dt;
      if (nextLine <= 0) {
        nextLine = 2800 + Math.random() * 2400;
        const plan = PLAN[current];
        if (plan && plan.script.length) {
          const [who, kind] = plan.script[scriptAt % plan.script.length];
          scriptAt++;
          const a = actors.find((x) => x.name === who);
          if (a && !a.bubble) a.say(M.line(who, kind, current), 2800);
        }
      }
    }

    function paint(ctx, s, sc) {
      const t = sc.elapsed;
      ctx.globalAlpha = fade;
      if (backdrop) ctx.drawImage(backdrop, 0, 0, W * s, H * s);
      else { ctx.fillStyle = '#20202c'; ctx.fillRect(0, 0, sc.canvas.width, sc.canvas.height); }

      const plan = PLAN[current] || {};
      const room = ROOMS[current];

      // Lit screens, wherever the world file says there is one.
      if ((plan.fx === 'screens' || plan.fx === 'umbrella' || plan.fx === 'night') && room) {
        for (const seat of room.seats) {
          if (!seat.screen) continue;
          const taken = actors.some((a) => a.seat === seat.name);
          if (!taken) continue;
          M.screenGlow(ctx, seat.screen, s, t + seat.x * 7);
        }
      }

      if (plan.fx === 'warm') M.warmWash(ctx, W, H, s, t);
      if (plan.fx === 'lasers') M.lasers(ctx, W, H, s, t);
      if (plan.fx === 'night') {
        ctx.globalAlpha = 0.22; ctx.fillStyle = '#121a33';
        ctx.fillRect(0, 0, sc.canvas.width, sc.canvas.height); ctx.globalAlpha = fade;
        M.rain(ctx, W, H, s, t, 30);
      }
      if (plan.fx === 'skyline') M.windowLights(ctx, 10, 26, W - 20, s, t, 3);
      if (plan.fx === 'umbrella') {
        // the yellow umbrella, parked by the apartment door
        M.umbrella(ctx, 452, 196, s, false);
      }
      ctx.globalAlpha = 1;
    }

    function apply(name) {
      current = name;
      const room = ROOMS[name];
      const plan = PLAN[name];
      actors.length = 0;
      scriptAt = 0;
      nextLine = 1200;
      if (!plan) return;
      for (const c of plan.cast) {
        const seat = c.seat && room ? room.seats.find((s) => s.name === c.seat) : null;
        const x = seat ? seat.x - 1 : Math.round(c.at * (W - M.CELL.w));
        const y = seat ? seat.y - M.CELL.h + 10 : Math.round(c.y * H);
        const a = new M.Actor(c.name, { x, y, state: c.state || 'idle' });
        a.home = c.state || 'idle';
        a.seat = c.seat || null;
        actors.push(a);
      }
      if (onRoom) onRoom(name, room);
    }

    /** Switch rooms with a short fade. */
    scene.show = function show(name) {
      if (name === current || !ROOMS[name]) return;
      const first = !current;
      M.image(ROOMS[name].file).then((img) => {
        backdrop = img;
        if (first || M.reducedMotion()) {
          apply(name);
          fade = 1;
          scene.renderOnce();
          scene.sync();
        } else {
          fadingTo = name;
          scene.sync();
        }
      });
    };

    M.loadAtlas().then(() => scene.renderOnce());
    return scene;
  };
})(window.M);
