'use strict';

/**
 * The landing page draws its characters from files, so the export has to keep
 * producing them — and keep producing the SAME characters the app renders.
 *
 * These tests go through the same exported API tools/export-sprites.cjs uses,
 * so a recipe change, a renamed pose or a regressed draw order shows up here
 * rather than as a blank square on the website.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const art = loadTs('src/renderer/src/scene/office/portraitArt.ts');
const { PORTRAIT_NAMES, portraitBuf, poseBuf, sceneFrameBufs, PORTRAIT_W, PORTRAIT_H, SCENE_W, SCENE_H } = art;
const { OFFICE_CAST } = loadTs('src/renderer/src/scene/office/cast.ts');

const POSES = ['idle', 'walk-a', 'walk-b', 'talk', 'wave', 'work', 'cheer', 'blink', 'back'];
const WEB = path.resolve(__dirname, '..', 'website');
const SRC_ASSETS = path.resolve(__dirname, '..', 'src/renderer/src/assets/himym');

const opaque = (buf) => {
  let n = 0;
  for (let i = 3; i < buf.length; i += 4) if (buf[i] !== 0) n++;
  return n;
};
/** Decode an 8-bit, non-interlaced RGB/RGBA PNG to RGBA bytes, so a test can look
 *  at the pixels the page and the app actually draw. */
function readPng(file) {
  const zlib = require('node:zlib');
  const buf = fs.readFileSync(file);
  assert.equal(buf.subarray(1, 4).toString(), 'PNG', `${file} is not a PNG`);
  let pos = 8, w = 0, h = 0, ct = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.subarray(pos + 4, pos + 8).toString();
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = body.readUInt32BE(0); h = body.readUInt32BE(4); ct = body[9]; assert.equal(body[8], 8); assert.equal(body[12], 0, 'interlaced'); }
    if (type === 'IDAT') idat.push(body);
    pos += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3;
  assert.ok(ct === 6 || ct === 2, `unsupported PNG colour type ${ct}`);
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp;
  const out = Buffer.alloc(w * h * 4, 255);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let add = 0;
      if (f === 1) add = a; else if (f === 2) add = b; else if (f === 3) add = (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[i] = (line[i] + add) & 255;
    }
    for (let x = 0; x < w; x++) for (let k = 0; k < bpp; k++) out[(y * w + x) * 4 + k] = line[x * bpp + k];
    prev = line;
  }
  return { w, h, px: (x, y) => { const o = (y * w + x) * 4; return [out[o], out[o + 1], out[o + 2], out[o + 3]]; } };
}

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

test('every character in the cast can be exported', () => {
  for (const member of OFFICE_CAST) {
    assert.ok(
      PORTRAIT_NAMES.includes(member.name),
      `${member.name} is in the cast but has no portrait recipe, so the export would skip them`
    );
  }
  assert.equal(PORTRAIT_NAMES.length >= OFFICE_CAST.length, true);
});

test('every pose draws something, at the agreed size', () => {
  for (const name of PORTRAIT_NAMES) {
    for (const pose of POSES) {
      const buf = poseBuf(name, pose);
      assert.equal(buf.length, SCENE_W * SCENE_H * 4, `${name}/${pose} is the wrong size`);
      assert.ok(opaque(buf) > 120, `${name}/${pose} is almost empty — ${opaque(buf)} pixels`);
    }
    const p = portraitBuf(name);
    assert.equal(p.length, PORTRAIT_W * PORTRAIT_H * 4);
    assert.ok(opaque(p) > 120, `${name} portrait is almost empty`);
  }
});

test('the poses that should differ do differ', () => {
  // A pose that renders identically to idle is a pose that does not exist.
  for (const name of ['ted', 'lily', 'barney', 'randy']) {
    const idle = poseBuf(name, 'idle');
    for (const pose of ['walk-a', 'walk-b', 'talk', 'wave', 'work', 'cheer', 'blink', 'back']) {
      assert.equal(same(idle, poseBuf(name, pose)), false, `${name}/${pose} is identical to idle`);
    }
    assert.equal(
      same(poseBuf(name, 'walk-a'), poseBuf(name, 'walk-b')), false,
      `${name} has only one walk frame, so the walk cycle would not read`
    );
  }
});

test('an exported pose adds a limb without moving the character', () => {
  // wave/work/cheer must be the same body in the same place — only the arms
  // change — or the sprite jumps when the state changes mid-animation.
  for (const name of ['ted', 'robin']) {
    const idle = poseBuf(name, 'idle');
    for (const pose of ['wave', 'work', 'cheer']) {
      const other = poseBuf(name, pose);
      let moved = 0;
      // the torso and legs columns, away from the arms
      for (let y = 18; y < SCENE_H; y++) {
        for (let x = 5; x < 13; x++) {
          const i = (y * SCENE_W + x) * 4;
          if (idle[i] !== other[i] || idle[i + 3] !== other[i + 3]) moved++;
        }
      }
      assert.ok(moved < 14, `${name}/${pose} redrew ${moved} body pixels; it should only add arms`);
    }
  }
});

test('the in-app renderer is untouched by the export poses', () => {
  // sceneFrameBufs is what the running app calls. Its walk frames must still
  // be the gentle one-pixel gait, not the exaggerated exported stride.
  for (const name of ['ted', 'marshall']) {
    const frames = sceneFrameBufs(name);
    assert.equal(frames.front.length, 3);
    assert.equal(frames.back.length, 3);
    assert.equal(
      same(frames.front[1], poseBuf(name, 'walk-a')), false,
      'the exported stride leaked into the in-scene walk frames'
    );
    assert.equal(frames.front[0].length, SCENE_W * SCENE_H * 4);
  }
});

test('the exported files and manifests on disk match the catalogue', { skip: !fs.existsSync(path.join(WEB, 'assets/cast/manifest.json')) }, () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(WEB, 'assets/cast/manifest.json'), 'utf8'));
  assert.deepEqual(manifest.poses, POSES, 'the exported poses drifted from this test');
  assert.deepEqual(Object.keys(manifest.characters).sort(), [...PORTRAIT_NAMES].sort());

  for (const name of PORTRAIT_NAMES) {
    for (const pose of POSES.concat('portrait')) {
      const rel = manifest.characters[name][pose];
      assert.ok(rel, `${name}/${pose} is missing from the manifest`);
      assert.ok(fs.existsSync(path.join(WEB, rel)), `${rel} is in the manifest but not on disk`);
    }
  }

  // The atlas the page actually loads must cover every character and pose.
  const atlas = manifest.atlas;
  assert.equal(Object.keys(atlas.rows).length, PORTRAIT_NAMES.length);
  assert.equal(atlas.cols, POSES.length + 1);
  assert.ok(fs.existsSync(path.join(WEB, atlas.file)), 'the atlas image is missing');

  // and the generated script the page reads instead of fetching the JSON
  const js = fs.readFileSync(path.join(WEB, 'js/cast-manifest.js'), 'utf8');
  assert.match(js, /window\.CAST_ATLAS/);
  for (const pose of POSES) assert.match(js, new RegExp(`"${pose}"`), `${pose} missing from cast-manifest.js`);
});

test('the exported room backdrops line up with the rooms the page shows', { skip: !fs.existsSync(path.join(WEB, 'assets/rooms/rooms.json')) }, () => {
  const rooms = JSON.parse(fs.readFileSync(path.join(WEB, 'assets/rooms/rooms.json'), 'utf8'));
  const world = require('../src/renderer/src/assets/himym/world.json');
  assert.equal(Object.keys(rooms.rooms).length, 7, 'the page promises seven locations');

  for (const [id, room] of Object.entries(rooms.rooms)) {
    assert.ok(world.locations[id], `${id} is not a location in the app's world`);
    assert.ok(fs.existsSync(path.join(WEB, room.file)), `${room.file} is missing`);
    assert.equal(room.w, world.locations[id].w * world.tile);
    assert.equal(room.h, world.locations[id].h * world.tile);
    assert.ok(room.label && room.blurb, `${id} has no label or description`);
    for (const seat of room.seats) {
      assert.ok(seat.x >= 0 && seat.x < room.w, `${id}/${seat.name} sits outside the room`);
      assert.ok(seat.y >= 0 && seat.y < room.h, `${id}/${seat.name} sits outside the room`);
    }
  }
});

test("the stoop's near handrail is exported as its own layer", {
  skip: !fs.existsSync(path.join(WEB, 'assets/rooms/rooms.json'))
}, () => {
  // The hero scene draws this over the cast so a climber passes BETWEEN the two
  // railings. If the overlay stops being exported the page silently loses a
  // handrail and nobody notices, so the file, its anchors and the slope it has
  // to follow are all pinned here.
  const rooms = JSON.parse(fs.readFileSync(path.join(WEB, 'assets/rooms/rooms.json'), 'utf8'));
  const ov = path.join(WEB, 'assets/scene/street-ov.png');
  assert.ok(fs.existsSync(ov), 'street-ov.png is missing from the site assets');
  assert.ok(fs.existsSync(path.join(SRC_ASSETS, 'street-ov.png')), 'street-ov.png is missing from the app assets');

  const street = rooms.street;
  for (const key of ['paveY', 'stair', 'landing', 'apartmentDoor', 'pubDoor', 'pubSteps', 'neons', 'mailbox']) {
    assert.ok(street[key] !== undefined, `the street anchors are missing ${key}`);
  }
  // the stoop climbs from the pavement to the landing
  assert.equal(street.stair.y0, street.paveY);
  assert.ok(street.stair.y1 < street.stair.y0, 'the stoop must climb');
  assert.equal(street.landing.y, street.stair.y1);
  assert.equal(street.apartmentDoor.y, street.stair.y1);
  // MacLaren's is a basement bar: its door is below the pavement, at the foot
  // of its own flight, which goes DOWN and shares nothing with the stoop
  const ps = street.pubSteps;
  assert.ok(street.pubDoor.y > street.paveY, "the pub's door must be below the pavement");
  assert.equal(ps.y0, street.paveY);
  assert.equal(ps.y1, street.pubDoor.y, 'the pub steps end at the level of its door');
  assert.ok(ps.y1 > ps.y0, 'the pub steps must descend');
  assert.ok(ps.x1 <= street.pubDoor.x && street.pubDoor.x < ps.landingX1, 'the door opens off the landing');
  assert.ok(ps.landingX1 < street.stair.x0 - 100, 'the pub steps and the stoop are separate staircases');
  assert.ok(ps.lip > ps.y1 && ps.lip < 264, 'the well must leave the walked strip of pavement alone');
  assert.ok(ps.ov.x <= ps.x0 && ps.ov.x + ps.ov.w >= ps.landingX1, 'the railing slice must cover the whole well');
  assert.ok(ps.ov.x + ps.ov.w < street.stair.x0, 'the railing slice must not take the stoop handrail with it');
  // The corner entry that used to sit at the bottom left is gone for good:
  // MacLaren's has the one way in, and nothing may bring a second one back.
  assert.equal(street.cellar, undefined, 'the bottom-left cellar entry was removed on purpose');
  // the door leaf the app highlights and opens is the one the painter drew
  assert.equal(street.pubDoor.y - street.pubDoor.top, 52, 'the door leaf is as tall as the well is deep plus its head');
  assert.ok(street.pubDoor.w > 0 && street.neons.glass.x > street.pubDoor.x && street.neons.shamrock.x < street.pubDoor.x);
  // and the mailbox stands clear of both the pub door and the foot of the stoop
  assert.ok(street.mailbox.x > street.pubDoor.x + 40, 'the mailbox crowds the pub door');
  assert.ok(street.mailbox.x + street.mailbox.w < street.stair.x0, 'the mailbox crowds the stoop');
});

test("the bottom-left corner is plain pavement, and the pub's entrance is the only way in", {
  skip: !fs.existsSync(path.join(WEB, 'assets/scene/street.png'))
}, () => {
  // Looked at in the artwork itself, in BOTH places it ships: the page and the
  // app must show the same building.
  for (const dir of [path.join(WEB, 'assets/scene'), SRC_ASSETS]) {
    const base = readPng(path.join(dir, 'street.png'));
    const ov = readPng(path.join(dir, 'street-ov.png'));
    assert.deepEqual([base.w, base.h], [544, 352]);

    // Where the cellar well used to be cut (x 14-58, y 243-258) there is now
    // nothing but flagstones. The well was near-black and its kerb a pale slab,
    // so a dark pixel anywhere in this box means it is back.
    for (let y = 243; y <= 258; y++) {
      for (let x = 14; x <= 58; x++) {
        const [r, g, b] = base.px(x, y);
        assert.ok(0.3 * r + 0.59 * g + 0.11 * b > 95, `pixel ${x},${y} in ${dir} is dark: the corner entry is back`);
      }
    }

    // The pub's door is green, below the pavement line.
    const street = JSON.parse(fs.readFileSync(path.join(WEB, 'assets/rooms/rooms.json'), 'utf8')).street;
    const [dr, dg, db] = base.px(street.pubDoor.x, street.pubDoor.y - 8);
    assert.ok(dg > dr + 20 && dg > db, `the pub door should be green at its foot, got ${[dr, dg, db]}`);

    // The street-side railing is on the overlay and is green iron; the stoop's
    // handrail beside it is dark iron, so green only shows up in the pub's slice.
    const { x, y, w, h } = street.pubSteps.ov;
    let green = 0;
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      const [r, g, b, a] = ov.px(xx, yy);
      if (a > 200 && g > r + 25 && g > b + 8) green++;
    }
    assert.ok(green > 150, `the green railing is missing from the overlay in ${dir} (${green} px)`);
  }
});
