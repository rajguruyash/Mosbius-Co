/* Mosbius & Co — the hero street scene.
 *
 * The backdrop is the app's own painted elevation of the building: MacLaren's
 * on the ground floor, Ted's apartment directly above it, and the stoop up the
 * right-hand side to his front door. The anchors below are not guessed — they
 * come from street.py by way of the exported manifest, so a character can
 * never climb a staircase that has moved.
 *
 * The five walk in, stand about outside the bar, and now and then one of them
 * goes somewhere: down the green-railed steps to MacLaren's door below the
 * pavement, or up the stoop to the apartment. Two separate staircases. They come back out again.
 */
(function (M) {
  'use strict';

  const STREET = { file: 'assets/scene/street.png', w: 544, h: 352 };
  // The near handrail of the stoop, on its own layer so it can be drawn over
  // the cast: a climber then passes between the two railings instead of behind
  // both of them. Every other pixel of it is transparent.
  const STREET_OV = 'assets/scene/street-ov.png';
  const A = (window.ROOMS && window.ROOMS.street) || {};
  const PAVE = A.paveY || 240;
  const STAIR = A.stair || { x0: 396, y0: 240, x1: 492, y1: 186 };
  const PUB_DOOR = (A.pubDoor || { x: 166 }).x;
  // MacLaren's is below the pavement: a short flight down to a landing by the
  // door, behind a kerb (`lip`) and a railing that is part of the overlay.
  const PUB_STEPS = A.pubSteps || { x0: 124, y0: 240, x1: 148, y1: 258, lip: 259, ov: { x: 112, y: 231, w: 90, h: 32 } };
  const APT_DOOR = (A.apartmentDoor || { x: 514 }).x;
  const CARL = A.carl || { x: 96, y: 198 };
  const PUB_WINDOW = (A.pubWindows || [{ x: 30, y: 184, w: 120, h: 54 }])[0];

  // The view: from above the apartment windows down past the pavement, so the
  // whole building — the apartment, the pub beneath it and the stoop — is in
  // one shot, with enough road for a passing cab.
  const CROP_Y = 18;
  const VIEW_H = 284;

  const SIDEWALK = 264;                 // where the cast's feet sit on the pavement
  const top = (feet) => feet - CROP_Y - M.CELL.h;
  const PAVE_TOP = top(SIDEWALK);

  // Standing marks along the pavement, in world pixels, clear of the pub door.
  const MARKS = [
    { name: 'ted', x: 64 },               // on the pavement left of the pub's window
    { name: 'marshall', x: 100 },
    { name: 'lily', x: 202 },
    { name: 'robin', x: 248 },
    { name: 'barney', x: 296 },
  ];

  // Waypoints for the two journeys, in feet coordinates on the elevation.
  // Clear of the near rail's bottom newel, which stands just inside the first
  // step: wait any closer and you are standing behind the post.
  const STAIR_FOOT = { x: STAIR.x0 - 22, feet: PAVE + 12 };
  const STAIR_HEAD = { x: STAIR.x1 - 14, feet: STAIR.y1 + 12 };
  const DOOR_MARK = { x: APT_DOOR - 9, feet: STAIR.y1 + 12 };
  // The pub's steps run along the back of the pavement, so the walk down them
  // is behind the railing: head of the flight, its foot, then the door.
  const PUB_DROP = PUB_STEPS.y1 - PUB_STEPS.y0;
  const PUB_HEAD = { x: PUB_STEPS.x0 - 13, feet: PAVE + 10 };
  const PUB_FOOT = { x: PUB_STEPS.x1 - 6, feet: PAVE + 10 + PUB_DROP };
  const PUB_MARK = { x: PUB_DOOR - 9, feet: PAVE + 10 + PUB_DROP };

  M.initHero = function initHero(canvas, bubbleLayer, onPick) {
    const actors = MARKS.map((m, i) => new M.Actor(m.name, {
      x: -24 - i * 18, y: PAVE_TOP, facing: 1, speed: 72 + i * 3,
      label: M.ROLE_OF[m.name].label,
    }));
    actors.forEach((a, i) => { a.mark = MARKS[i].x; a.busy = false; });

    // Carl works the bar behind the left window, and steps out of sight now
    // and then the way a bartender does.
    // Stood behind the bar: feet just above the window's bottom edge, so the
    // whole of him is inside the glass rather than clipped at the head.
    const carl = new M.Actor('carl', {
      x: CARL.x,
      y: PUB_WINDOW.y - CROP_Y + PUB_WINDOW.h - 6 - M.CELL.h,
    });
    let carlIn = true, carlTimer = 5200;

    let street = null, cabImg = null, streetOv = null;
    let cabX = -200, cabWait = 4200, cabDir = 1;
    let arrived = false;
    let nextLine = 2600;
    let nextErrand = 7000;
    let cam = 0, camTarget = 0;

    const scene = new M.Scene(canvas, {
      width: STREET.w, height: VIEW_H, actors, bubbleLayer,
      // The whole elevation, always: the apartment, the pub under it and the
      // stoop have to be readable as one building, so the scene never crops
      // horizontally. A wide screen gets two pixels per pixel; a phone fits
      // the same 544 across its width.
      fit(avail) {
        const scale = Math.max(1, Math.min(3, Math.floor(avail / STREET.w)));
        return { scale, width: STREET.w, height: VIEW_H };
      },
      update(dt, now, sc) { step(dt, now, sc); },
      draw() { /* replaced below, so the camera can pan actors and scenery together */ },
    });

    /** Make one of them wave and introduce themselves. */
    function poke(name, quiet) {
      const a = actors.find((x) => x.name === name);
      if (!a || a.hidden) return;
      a.setState('wave');
      a.say(M.line(name, 'catch'), 2200);
      setTimeout(() => {
        if (a.state === 'wave') a.setState('idle');
        const who = M.ROLE_OF[name];
        if (who) a.say(who.role + ' — ' + who.blurb.split('.')[0] + '.', 4200, 'tone-role');
      }, 2300);
      if (!quiet && onPick) onPick(name);
    }

    scene.poke = poke;
    scene.onPick = (a) => (a.name === 'carl' ? a.say(M.line('carl', 'catch'), 2200) : poke(a.name));
    scene.onHover = (a) => {
      if (!a.bubble && M.ROLE_OF[a.name]) a.say(M.ROLE_OF[a.name].role, 1600, 'tone-role');
    };

    // ── journeys ─────────────────────────────────────────────────────────────

    /** Go down MacLaren's steps and in through the door at the bottom. From
     *  the head of the flight on, the walker is behind the green railing and
     *  the kerb hides their legs (`inWell`). */
    function intoThePub(a) {
      a.busy = true;
      a.say(M.line(a.name, 'pub'), 2200);
      a.walkTo(PUB_HEAD.x, top(PUB_HEAD.feet), () => {
        a.inWell = true;
        a.walkTo(PUB_FOOT.x, top(PUB_FOOT.feet), () => {
          a.walkTo(PUB_MARK.x, top(PUB_MARK.feet), () => {
            a.facing = 1;
            setTimeout(() => {
              a.hidden = true;
              setTimeout(() => {                   // out again, a drink later
                a.hidden = false;
                a.x = PUB_MARK.x; a.y = top(PUB_MARK.feet);
                a.walkTo(PUB_FOOT.x, top(PUB_FOOT.feet), () => {
                  a.walkTo(PUB_HEAD.x, top(PUB_HEAD.feet), () => {
                    a.inWell = false;
                    a.walkTo(a.mark, top(SIDEWALK), () => {
                      a.busy = false; a.facing = 1; a.say(M.line(a.name, 'idle'), 2000);
                    });
                  });
                });
              }, 5200 + Math.random() * 3000);
            }, 420);
          });
        });
      });
    }

    /** Walk to the foot of the stoop, climb it, and let yourself in upstairs. */
    function upstairs(a) {
      a.busy = true;
      a.say(M.line(a.name, 'home'), 2200);
      a.walkTo(STAIR_FOOT.x, top(STAIR_FOOT.feet), () => {
        // One straight move up the flight: the stoop is a straight run, so the
        // diagonal walk lands every frame on the steps.
        a.walkTo(STAIR_HEAD.x, top(STAIR_HEAD.feet), () => {
          a.walkTo(DOOR_MARK.x, top(DOOR_MARK.feet), () => {
            a.facing = 1;
            setTimeout(() => {
              a.hidden = true;
              setTimeout(() => {                   // back down for another round
                a.hidden = false;
                a.x = DOOR_MARK.x; a.y = top(DOOR_MARK.feet);
                a.walkTo(STAIR_HEAD.x, top(STAIR_HEAD.feet), () => {
                  a.walkTo(STAIR_FOOT.x, top(STAIR_FOOT.feet), () => {
                    a.walkTo(a.mark, top(SIDEWALK), () => {
                      a.busy = false; a.facing = 1; a.say(M.line(a.name, 'idle'), 2000);
                    });
                  });
                });
              }, 6000 + Math.random() * 4000);
            }, 420);
          });
        });
      });
    }

    /** Send someone on an errand. `where` forces one, which is how the scene
     *  is checked without waiting for the timer to come round. */
    function sendSomeone(where) {
      const free = actors.filter((a) => !a.busy && !a.hidden && a.target === null);
      if (free.length < 3) return null;            // never empty the pavement
      const a = free[Math.floor(Math.random() * free.length)];
      const up = where ? where === 'upstairs' : Math.random() < 0.5;
      if (up) upstairs(a); else intoThePub(a);
      return a;
    }
    scene.send = sendSomeone;

    // ── loop ─────────────────────────────────────────────────────────────────

    function step(dt, now, sc) {
      const span = Math.max(0, STREET.w - sc.world.w);

      if (M.reducedMotion()) {
        actors.forEach((a) => {
          a.hidden = false; a.busy = false; a.target = null; a.inWell = false;
          a.x = a.mark; a.y = PAVE_TOP; a.setState('idle');
        });
        cam = Math.round(span / 2);
        return;
      }

      if (!arrived) {
        arrived = true;
        actors.forEach((a, i) => setTimeout(() => {
          a.walkTo(a.mark, () => {
            a.facing = 1;
            if (a.name === 'barney') { a.setState('wave'); a.say(M.line('barney', 'catch'), 2600); }
          });
        }, 220 * i));
      }

      // Carl, behind the bar.
      carlTimer -= dt;
      if (carlTimer <= 0) {
        carlIn = !carlIn;
        carl.hidden = !carlIn;
        carlTimer = carlIn ? 7000 + Math.random() * 5000 : 3000 + Math.random() * 2500;
      }
      carl.update(dt, now);

      // One person speaks at a time, on a human rhythm.
      nextLine -= dt;
      if (nextLine <= 0) {
        nextLine = 3200 + Math.random() * 2600;
        const free = actors.filter((a) => !a.bubble && !a.hidden && a.target === null);
        if (free.length) {
          const a = free[Math.floor(Math.random() * free.length)];
          const kind = Math.random() < 0.45 ? 'catch' : Math.random() < 0.6 ? 'code' : 'idle';
          a.say(M.line(a.name, kind), 2800);
          const near = actors
            .filter((o) => o !== a && !o.hidden && o.target === null)
            .sort((p, q) => Math.abs(p.x - a.x) - Math.abs(q.x - a.x))[0];
          if (near) near.facing = near.x < a.x ? 1 : -1;
        }
      }

      // Somebody goes somewhere.
      nextErrand -= dt;
      if (nextErrand <= 0) { nextErrand = 9000 + Math.random() * 7000; sendSomeone(); }

      // A cab goes past now and then.
      if (cabWait > 0) {
        cabWait -= dt;
        if (cabWait <= 0) {
          cabDir = Math.random() < 0.5 ? 1 : -1;
          cabX = cabDir === 1 ? -180 : STREET.w + 20;
        }
      } else {
        cabX += cabDir * dt * 0.085;
        if (cabX > STREET.w + 40 || cabX < -220) cabWait = 5200 + Math.random() * 6000;
      }

      // The camera: normally the group, but it follows whoever is on the stoop
      // so a phone, which cannot show the whole building at once, still sees
      // the staircase being used.
      if (span > 0) {
        const climber = actors.find((a) => a.busy && !a.hidden && a.x > STAIR.x0 - 70);
        const focus = climber ? climber.x + M.CELL.w / 2 : 200;
        camTarget = Math.max(0, Math.min(span, Math.round(focus - sc.world.w / 2)));
        cam += (camTarget - cam) * Math.min(1, dt / 420);
      } else cam = 0;
    }

    function paint(ctx, s, sc) {
      const t = sc.elapsed;
      if (street) {
        ctx.drawImage(street, 0, CROP_Y, STREET.w, VIEW_H, 0, 0, STREET.w * s, VIEW_H * s);
      } else {
        ctx.fillStyle = '#2b2f3d';
        ctx.fillRect(0, 0, STREET.w * s, VIEW_H * s);
      }

      // Carl, clipped to the pub window so he reads as being behind the glass.
      if (!carl.hidden) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(PUB_WINDOW.x * s, (PUB_WINDOW.y - CROP_Y) * s, PUB_WINDOW.w * s, PUB_WINDOW.h * s);
        ctx.clip();
        ctx.globalAlpha = 0.92;
        carl.draw(ctx, s);
        ctx.globalAlpha = 1;
        ctx.restore();
      }

      if (cabWait <= 0) M.cab(ctx, cabImg, cabX, SIDEWALK - CROP_Y + 26, s, cabDir === -1);

      // Ted's umbrella, carried at his side when he is on the pavement.
      const ted = actors[0];
      if (!ted.hidden && !ted.busy) {
        M.umbrella(ctx, ted.x - 9, ted.y + 8, s, ted.state === 'walk');
      }

      // Warm spill from the pub windows onto the pavement.
      ctx.globalAlpha = 0.12 + 0.03 * Math.sin(t / 1600);
      ctx.fillStyle = '#FFC94A';
      ctx.fillRect(20 * s, (SIDEWALK - CROP_Y - 10) * s, 300 * s, 12 * s);
      ctx.globalAlpha = 1;
    }

    // Draw scenery and actors under the same camera translation.
    scene.draw = function draw() {
      const { ctx, scale } = this;
      this.camX = cam;
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.imageSmoothingEnabled = false;
      ctx.save();
      ctx.translate(-Math.round(cam) * scale, 0);
      paint(ctx, scale, this);
      // The overlay goes down in two parts. Whoever is on the pub's steps is
      // drawn first, cut off at the kerb, and the green railing goes over
      // them; everyone on the pavement is in front of that railing. The rest
      // of the overlay (the stoop's near handrail) still goes on last.
      const ovSlice = (x0, x1) => {
        if (streetOv && x1 > x0) {
          ctx.drawImage(streetOv, x0, CROP_Y, x1 - x0, VIEW_H, x0 * scale, 0, (x1 - x0) * scale, VIEW_H * scale);
        }
      };
      const order = [...actors].sort((p, q) => p.y - q.y);
      const R = PUB_STEPS.ov;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, STREET.w * scale, (PUB_STEPS.lip - CROP_Y) * scale);
      ctx.clip();
      for (const a of order) if (a.inWell) a.draw(ctx, scale);
      ctx.restore();
      ovSlice(R.x, R.x + R.w);
      for (const a of order) if (!a.inWell) a.draw(ctx, scale);
      ovSlice(0, R.x);
      ovSlice(R.x + R.w, STREET.w);
      ctx.restore();
      this.syncBubbles();
    };

    Promise.all([M.loadAtlas(), M.image(STREET.file), M.image('assets/scene/cab.png'), M.image(STREET_OV)])
      .then(([, st, cb, ov]) => {
        street = st; cabImg = cb; streetOv = ov;
        if (M.reducedMotion()) actors.forEach((a) => { a.x = a.mark; a.y = PAVE_TOP; });
        scene.sync();
        scene.renderOnce();
      });

    return scene;
  };
})(window.M);
