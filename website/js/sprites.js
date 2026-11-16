/* Mosbius & Co — pixel scene engine.
 *
 * Everything animated on this page runs through here: one sprite atlas, one
 * actor class with a small state machine, and one scene loop that only ticks
 * while it is actually on screen.
 *
 * Why a 2D canvas and not a scene library: every character is an 18×32 sprite
 * blitted from one 24 KB atlas with smoothing off. A WebGL renderer would add
 * a dependency, a second code path and a context per section, and draw the
 * same rectangles. The desktop app uses Pixi because it runs one large world
 * continuously; a web page running six small scenes does not need it.
 *
 * No build step, no modules — classic scripts on one namespace, so the page
 * also works opened straight off disk.
 */
window.M = window.M || {};

(function (M) {
  'use strict';

  const A = window.CAST_ATLAS;

  // ─── atlas ────────────────────────────────────────────────────────────────

  let atlasImg = null;
  let atlasPromise = null;

  /** Load the one sprite sheet. Every scene awaits the same promise. */
  M.loadAtlas = function loadAtlas() {
    if (atlasPromise) return atlasPromise;
    atlasPromise = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => { atlasImg = img; resolve(img); };
      img.onerror = () => reject(new Error('cast atlas failed to load'));
      img.src = A.file;
    });
    return atlasPromise;
  };

  M.CELL = A.cell;

  /**
   * Blit one character frame. `flip` mirrors horizontally, which is how a
   * character faces left: the sprites are drawn front-on and symmetrical
   * enough that a mirror reads as a turn.
   */
  M.drawFrame = function drawFrame(ctx, name, pose, x, y, scale, flip) {
    if (!atlasImg) return;
    const row = A.rows[name];
    const col = A.columns[pose];
    if (row === undefined || col === undefined) return;
    const { w, h } = A.cell;
    const sx = col * w, sy = row * h;
    ctx.imageSmoothingEnabled = false;
    if (flip) {
      ctx.save();
      ctx.translate(Math.round(x + w * scale), Math.round(y));
      ctx.scale(-1, 1);
      ctx.drawImage(atlasImg, sx, sy, w, h, 0, 0, w * scale, h * scale);
      ctx.restore();
    } else {
      ctx.drawImage(atlasImg, sx, sy, w, h, Math.round(x), Math.round(y), w * scale, h * scale);
    }
  };

  /** Draw a character's portrait bust (the atlas's last column). */
  M.drawPortrait = function drawPortrait(ctx, name, x, y, scale) {
    if (!atlasImg) return;
    const row = A.rows[name];
    if (row === undefined) return;
    const ins = A.portraitInset;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      atlasImg,
      A.portraitColumn * A.cell.w + ins.x, row * A.cell.h + ins.y, ins.w, ins.h,
      Math.round(x), Math.round(y), ins.w * scale, ins.h * scale
    );
  };

  // ─── actors ───────────────────────────────────────────────────────────────

  // Each state names the frames it cycles and how long a frame holds (ms).
  const CYCLES = {
    idle:  { frames: ['idle'], hold: 1000 },
    walk:  { frames: ['walk-a', 'idle', 'walk-b', 'idle'], hold: 150 },
    talk:  { frames: ['talk', 'idle'], hold: 170 },
    wave:  { frames: ['wave', 'idle'], hold: 320 },
    work:  { frames: ['work', 'work', 'work', 'talk'], hold: 420 },
    cheer: { frames: ['cheer', 'idle'], hold: 240 },
    away:  { frames: ['back'], hold: 1000 },
  };

  let actorSeq = 0;

  M.Actor = class Actor {
    constructor(name, opts) {
      opts = opts || {};
      this.id = 'actor-' + (++actorSeq);
      this.name = name;
      this.label = opts.label || name;
      this.x = opts.x || 0;          // world pixels, left edge of the sprite
      this.y = opts.y || 0;          // world pixels, top edge
      this.facing = opts.facing === -1 ? -1 : 1;
      this.speed = opts.speed || 26; // world px per second
      this.state = opts.state || 'idle';
      this.visible = opts.visible !== false;
      this.hidden = false;           // not spawned yet
      this.t = 0;
      this.blinkIn = 1200 + Math.random() * 3600;
      this.blinking = 0;
      this.bob = Math.random() * Math.PI * 2;
      this.target = null;
      this.onArrive = null;
      this.bubble = null;            // { text, until, tone }
      this.queue = [];
    }

    setState(state) {
      if (this.state !== state) { this.state = state; this.t = 0; }
      return this;
    }

    /**
     * Walk to a world position, then run `then`. `y` is optional — in a
     * top-down room a character crosses the floor, on a sidewalk it only ever
     * moves sideways. Facing follows the horizontal direction.
     */
    walkTo(x, y, then) {
      if (typeof y === 'function') { then = y; y = undefined; }
      this.target = x;
      this.targetY = typeof y === 'number' ? y : null;
      this.onArrive = then || null;
      if (Math.abs(x - this.x) > 1) this.facing = x < this.x ? -1 : 1;
      this.setState('walk');
      return this;
    }

    /** Show a line above this character for `ms`, and animate the mouth. */
    say(text, ms, tone) {
      this.bubble = { text, until: performance.now() + (ms || 2600), tone: tone || '' };
      if (this.state === 'idle' || this.state === 'work') {
        this._resume = this.state;
        this.setState('talk');
      }
      return this;
    }

    update(dt, now) {
      this.t += dt;
      this.bob += dt / 420;

      if (this.target !== null) {
        const step = this.speed * (dt / 1000);
        const dx = this.target - this.x;
        const dy = this.targetY === null || this.targetY === undefined ? 0 : this.targetY - this.y;
        const dist = Math.hypot(dx, dy);
        if (dist <= step) {
          this.x = this.target;
          if (this.targetY !== null && this.targetY !== undefined) this.y = this.targetY;
          this.target = null;
          this.targetY = null;
          this.setState('idle');
          const cb = this.onArrive; this.onArrive = null;
          if (cb) cb(this);
        } else {
          this.x += (dx / dist) * step;
          this.y += (dy / dist) * step;
        }
      }

      if (this.bubble && now > this.bubble.until) {
        this.bubble = null;
        if (this.state === 'talk') this.setState(this._resume || 'idle');
      }

      // Blinking is its own one-frame interruption, not a state, so a
      // character can blink while walking or working.
      this.blinkIn -= dt;
      if (this.blinkIn <= 0) { this.blinking = 120; this.blinkIn = 2200 + Math.random() * 4200; }
      if (this.blinking > 0) this.blinking -= dt;
    }

    frame() {
      const cyc = CYCLES[this.state] || CYCLES.idle;
      const i = Math.floor(this.t / cyc.hold) % cyc.frames.length;
      const pose = cyc.frames[i];
      if (this.blinking > 0 && (pose === 'idle' || pose === 'work')) return 'blink';
      return pose;
    }

    draw(ctx, scale) {
      if (this.hidden || !this.visible) return;
      // A one-pixel vertical bob while idle, so nobody is ever perfectly still.
      const bob = this.state === 'idle' && Math.sin(this.bob) > 0.6 ? -1 : 0;
      const a = this.alpha === undefined ? 1 : this.alpha;
      if (a <= 0) return;
      if (a < 1) ctx.globalAlpha = a;
      M.drawFrame(ctx, this.name, this.frame(), this.x * scale, (this.y + bob) * scale, scale, this.facing === -1);
      if (a < 1) ctx.globalAlpha = 1;
    }

    /** Hit box in world pixels, for clicks and hovers. */
    hit(wx, wy) {
      return !this.hidden && this.visible &&
        wx >= this.x - 1 && wx <= this.x + A.cell.w + 1 &&
        wy >= this.y - 1 && wy <= this.y + A.cell.h + 1;
    }
  };

  // ─── scene ────────────────────────────────────────────────────────────────

  const reduced = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false, addEventListener: () => {} };

  M.reducedMotion = () => reduced.matches;

  /**
   * A canvas that draws a world of `width`×`height` pixels at an integer scale,
   * ticks only while on screen and the tab is visible, and renders a single
   * still frame when the visitor asked for reduced motion.
   */
  M.Scene = class Scene {
    constructor(canvas, opts) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: true });
      this.world = { w: opts.width, h: opts.height };
      this.maxScale = opts.maxScale || 4;
      this.onUpdate = opts.update || (() => {});
      this.onDraw = opts.draw || (() => {});
      this.actors = opts.actors || [];
      this.bubbleLayer = opts.bubbleLayer || null;
      this.scale = 1;
      this.running = false;
      this.onScreen = false;
      this.last = 0;
      this.elapsed = 0;
      this.bubbles = new Map();
      this.fit = opts.fit || null;
      this.onResize = opts.onResize || null;

      this._resize = this.resize.bind(this);
      this._tick = this.tick.bind(this);
      window.addEventListener('resize', this._resize);
      document.addEventListener('visibilitychange', () => this.sync());
      reduced.addEventListener && reduced.addEventListener('change', () => { this.sync(); this.renderOnce(); });

      if ('IntersectionObserver' in window) {
        new IntersectionObserver((entries) => {
          this.onScreen = entries[0].isIntersecting;
          this.sync();
        }, { rootMargin: '120px' }).observe(canvas);
      } else {
        this.onScreen = true;
      }

      this.resize();
      if (opts.pointer !== false) this.bindPointer();
    }

    resize() {
      const box = this.canvas.parentElement.getBoundingClientRect();
      const avail = box.width || this.world.w;
      if (this.fit) {
        // A scene that fills the width: pick the on-screen sprite size first,
        // then show as much of the world as fits. A phone sees a narrower slice
        // of the same street at the same sprite size, rather than the whole
        // street shrunk to nothing.
        const f = this.fit(avail);
        this.scale = f.scale;
        this.world.w = f.width;
        if (f.height) this.world.h = f.height;
        this.canvas.width = this.world.w * this.scale;
        this.canvas.height = this.world.h * this.scale;
        this.ctx.imageSmoothingEnabled = false;
        if (this.onResize) this.onResize(this);
        this.renderOnce();
        return;
      }
      // Integer scale keeps every sprite pixel square.
      this.scale = Math.max(1, Math.min(this.maxScale, Math.floor(avail / this.world.w)));
      this.canvas.width = this.world.w * this.scale;
      this.canvas.height = this.world.h * this.scale;
      this.ctx.imageSmoothingEnabled = false;
      this.renderOnce();
    }

    /** Start or stop the loop to match visibility, focus and motion settings. */
    sync() {
      // Goes through M.reducedMotion() rather than the media query directly so
      // the still-frame path can be exercised without changing OS settings.
      const still = M.reducedMotion();
      const want = this.onScreen && !document.hidden && !still;
      if (want && !this.running) {
        this.running = true;
        this.last = performance.now();
        requestAnimationFrame(this._tick);
      } else if (!want) {
        this.running = false;
        if (still) this.renderOnce();
      }
    }

    renderOnce() {
      this.onUpdate(0, performance.now(), this);
      this.draw();
    }

    tick(now) {
      if (!this.running) return;
      // Cap dt so a backgrounded tab does not teleport everyone on return.
      const dt = Math.min(64, now - this.last);
      this.last = now;
      this.elapsed += dt;
      for (const a of this.actors) a.update(dt, now);
      this.onUpdate(dt, now, this);
      this.draw();
      requestAnimationFrame(this._tick);
    }

    draw() {
      const { ctx, scale } = this;
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.imageSmoothingEnabled = false;
      this.onDraw(ctx, scale, this);
      // Painter's order: whoever stands lower is nearer the camera.
      for (const a of [...this.actors].sort((p, q) => p.y - q.y)) a.draw(ctx, scale);
      this.syncBubbles();
    }

    // Speech bubbles are DOM, not canvas: real text, selectable, readable by a
    // screen reader, and crisp at any zoom. They are positioned over the canvas
    // from the actor's world coordinates.
    syncBubbles() {
      if (!this.bubbleLayer) return;
      const cssW = this.canvas.getBoundingClientRect().width || this.canvas.width;
      const k = cssW / this.world.w;
      const seen = new Set();
      for (const a of this.actors) {
        if (!a.bubble || a.hidden) continue;
        seen.add(a.id);
        let el = this.bubbles.get(a.id);
        if (!el) {
          el = document.createElement('div');
          el.className = 'bubble';
          el.setAttribute('role', 'status');
          this.bubbleLayer.appendChild(el);
          this.bubbles.set(a.id, el);
        }
        if (el.dataset.text !== a.bubble.text) {
          el.dataset.text = a.bubble.text;
          el.textContent = a.bubble.text;
          el.className = 'bubble is-in ' + (a.bubble.tone || '');
        }
        // Keep the bubble inside the stage: a character near either edge would
        // otherwise have half their line cut off by the frame.
        const half = (el.offsetWidth || 120) / 2 + 4;
        const want = (a.x - (this.camX || 0) + M.CELL.w / 2) * k;
        el.style.left = Math.max(half, Math.min(cssW - half, want)) + 'px';
        el.style.top = ((a.y - 4) * k) + 'px';
      }
      for (const [id, el] of this.bubbles) {
        if (!seen.has(id)) { el.remove(); this.bubbles.delete(id); }
      }
    }

    /** World coordinates under a pointer event. */
    at(ev) {
      const r = this.canvas.getBoundingClientRect();
      return {
        x: (ev.clientX - r.left) / (r.width / this.world.w),
        y: (ev.clientY - r.top) / (r.height / this.world.h),
      };
    }

    bindPointer() {
      const hitTest = (ev) => {
        const p = this.at(ev);
        return [...this.actors].reverse().find((a) => a.hit(p.x, p.y)) || null;
      };
      this.canvas.addEventListener('pointermove', (ev) => {
        const a = hitTest(ev);
        this.canvas.style.cursor = a ? 'pointer' : '';
        if (a && a !== this.hovered && this.onHover) this.onHover(a);
        this.hovered = a;
      });
      this.canvas.addEventListener('pointerleave', () => { this.hovered = null; this.canvas.style.cursor = ''; });
      this.canvas.addEventListener('click', (ev) => {
        const a = hitTest(ev);
        if (a && this.onPick) this.onPick(a);
      });
    }
  };

  /** Load an image once, by url. Scenes share the cache. */
  const imgCache = new Map();
  M.image = function image(url) {
    let p = imgCache.get(url);
    if (!p) {
      p = new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);   // a missing backdrop must not stop a scene
        img.src = url;
      });
      imgCache.set(url, p);
    }
    return p;
  };
})(window.M);
