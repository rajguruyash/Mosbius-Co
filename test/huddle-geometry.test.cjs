'use strict';

/**
 * Where the Huddle window goes: sizes for each level, docking to a screen edge, staying on a screen that still
 * exists, and what a display being added, removed or rescaled does to a saved position. Made-up displays.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const H = loadTs('src/shared/huddle.ts');

// a laptop screen (menu bar takes 25px) and a larger monitor to its right, and a portrait one to the left
const laptop = { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 25, width: 1440, height: 875 }, scaleFactor: 2 };
const monitor = { id: 2, bounds: { x: 1440, y: 0, width: 2560, height: 1440 }, workArea: { x: 1440, y: 0, width: 2560, height: 1400 }, scaleFactor: 1 };
const portrait = { id: 3, bounds: { x: -1080, y: -400, width: 1080, height: 1920 }, workArea: { x: -1080, y: -400, width: 1080, height: 1920 }, scaleFactor: 1 };
const inside = (r, wa) => r.x >= wa.x && r.y >= wa.y && r.x + r.width <= wa.x + wa.width && r.y + r.height <= wa.y + wa.height;

test('the compact window fits its agents: empty, one, a few, and a cap after which the list scrolls', () => {
  const wa = laptop.workArea;
  const sizes = [0, 1, 2, 3, 6, 7, 30].map((n) => H.levelSize('compact', n, wa).height);
  assert.deepEqual(sizes.slice(0, 1), [H.COMPACT.empty]);
  assert.equal(sizes[1], H.COMPACT.header + H.COMPACT.cardSingle + H.COMPACT.footer, 'one agent gets a roomier card');
  assert.ok(sizes[2] < sizes[3] && sizes[3] < sizes[4], 'it grows with the crew');
  assert.equal(sizes[4], sizes[5], 'and stops growing at the cap');
  assert.equal(sizes[5], sizes[6]);
  assert.equal(H.levelSize('compact', 3, wa).width, H.COMPACT.width);
});

test('the expanded and agent windows are bigger, and every level is smaller than a small screen', () => {
  const wa = laptop.workArea;
  assert.ok(H.levelSize('expanded', 5, wa).width > H.levelSize('compact', 5, wa).width);
  assert.ok(H.levelSize('agent', 5, wa).width > H.levelSize('expanded', 5, wa).width);
  const tiny = { x: 0, y: 0, width: 360, height: 400 };
  for (const level of ['compact', 'expanded', 'agent']) {
    const s = H.levelSize(level, 10, tiny);
    assert.ok(s.width <= tiny.width - 2 * H.EDGE_MARGIN && s.height <= tiny.height - 2 * H.EDGE_MARGIN, level);
  }
});

test('letting go near an edge docks to it, exactly against the margin; away from the edges it stays free', () => {
  const near = H.snapAfterMove({ x: 14, y: 200, width: 312, height: 300 }, [laptop, monitor]);
  assert.equal(near.dock, 'left');
  assert.equal(near.rect.x, laptop.workArea.x + H.EDGE_MARGIN);
  const far = H.snapAfterMove({ x: 1440 - 312 - 14, y: 200, width: 312, height: 300 }, [laptop, monitor]);
  assert.equal(far.dock, 'right');
  assert.equal(far.rect.x, 1440 - 312 - H.EDGE_MARGIN);
  assert.equal(far.displayId, 1);
  const mid = H.snapAfterMove({ x: 600, y: 200, width: 312, height: 300 }, [laptop, monitor]);
  assert.equal(mid.dock, null);
  assert.equal(mid.rect.x, 600);
});

test('docking follows the display the window is on, not display zero', () => {
  const onMonitor = H.snapAfterMove({ x: 1440 + 2560 - 312 - 10, y: 100, width: 312, height: 300 }, [laptop, monitor]);
  assert.equal(onMonitor.displayId, 2);
  assert.equal(onMonitor.dock, 'right');
  assert.equal(onMonitor.rect.x, 1440 + 2560 - 312 - H.EDGE_MARGIN);
  const seam = H.snapAfterMove({ x: 1440 - 100, y: 100, width: 312, height: 300 }, [laptop, monitor]);
  assert.equal(seam.displayId, 2, 'the display with most of the window wins');
});

test('a window dragged off the top or bottom of a screen comes back inside the work area', () => {
  const r = H.snapAfterMove({ x: 600, y: -300, width: 312, height: 300 }, [laptop]);
  assert.ok(inside(r.rect, laptop.workArea), JSON.stringify(r.rect));
  const b = H.snapAfterMove({ x: 600, y: 2000, width: 312, height: 300 }, [laptop]);
  assert.ok(inside(b.rect, laptop.workArea));
});

test('changing level keeps a docked window on its edge (the right edge grows leftwards) and a free one on its corner', () => {
  const docked = { x: 1440 - 312 - 8, y: 100, width: 312, height: 300 };
  const bigger = H.resizeAnchored(docked, { width: 432, height: 580 }, 'right', [laptop]);
  assert.equal(bigger.x + bigger.width, docked.x + docked.width, 'the right edge did not move');
  assert.equal(bigger.y, 100);
  const free = H.resizeAnchored({ x: 300, y: 120, width: 312, height: 300 }, { width: 432, height: 580 }, null, [laptop]);
  assert.deepEqual([free.x, free.y], [300, 120]);
  const nearBottom = H.resizeAnchored({ x: 300, y: 700, width: 312, height: 150 }, { width: 432, height: 580 }, null, [laptop]);
  assert.ok(inside(nearBottom, laptop.workArea), 'a bigger window is pulled back up rather than hanging off the screen');
});

test('opening: nothing saved docks on the right of the main screen; a saved spot is restored; one on an unplugged monitor comes back', () => {
  const size = { width: 312, height: 300 };
  const fresh = H.placeFromSaved(undefined, size, [laptop, monitor], 1);
  assert.equal(fresh.x, 1440 - 312 - H.EDGE_MARGIN);
  assert.ok(inside(fresh, laptop.workArea));

  const kept = H.placeFromSaved({ x: 2000, y: 300, displayId: 2, dock: null }, size, [laptop, monitor], 1);
  assert.deepEqual([kept.x, kept.y], [2000, 300]);

  // the big monitor has been unplugged: the saved spot is on no screen
  const unplugged = H.placeFromSaved({ x: 2000, y: 300, displayId: 2, dock: null }, size, [laptop], 1);
  assert.ok(inside(unplugged, laptop.workArea), JSON.stringify(unplugged));

  const dockedRight = H.placeFromSaved({ x: 3500, y: 300, displayId: 2, dock: 'right' }, size, [laptop, monitor], 1);
  assert.equal(dockedRight.x, 1440 + 2560 - 312 - H.EDGE_MARGIN, 'a docked window keeps its edge on its own monitor');
  const moved = H.placeFromSaved({ x: 3500, y: 300, displayId: 2, dock: 'right' }, size, [laptop], 1);
  assert.ok(inside(moved, laptop.workArea) && moved.x + moved.width === 1440 - H.EDGE_MARGIN, 'and falls back to the nearest edge when its monitor is gone');
});

test('a monitor to the left (negative coordinates) and a resolution change are handled', () => {
  const size = { width: 312, height: 300 };
  const onLeft = H.placeFromSaved({ x: -900, y: 100, displayId: 3, dock: null }, size, [laptop, portrait], 1);
  assert.deepEqual([onLeft.x, onLeft.y], [-900, 100]);
  // the laptop switches to a smaller scaled resolution: what was inside the old work area is pulled inside the new
  const smaller = { ...laptop, bounds: { x: 0, y: 0, width: 1024, height: 640 }, workArea: { x: 0, y: 25, width: 1024, height: 615 } };
  const adjusted = H.placeFromSaved({ x: 1100, y: 800, displayId: 1, dock: null }, size, [smaller], 1);
  assert.ok(inside(adjusted, smaller.workArea), JSON.stringify(adjusted));
  const dockedAfter = H.placeFromSaved({ x: 1100, y: 100, displayId: 1, dock: 'right' }, size, [smaller], 1);
  assert.equal(dockedAfter.x, 1024 - 312 - H.EDGE_MARGIN, 'a docked window re-docks to the new edge');
});

test('with no display at all (a hot-plug in progress) there is still a plausible rectangle', () => {
  const r = H.placeFromSaved({ x: 10, y: 10 }, { width: 312, height: 300 }, [], undefined);
  assert.ok(Number.isFinite(r.x) && Number.isFinite(r.y));
  assert.equal(H.chooseDisplay([], { x: 0, y: 0, width: 1, height: 1 }).id, 0);
});

test('saved preferences are sanitised: unknown levels fall back, the agent view is never restored, positions must be numbers', () => {
  assert.deepEqual(H.sanitizeHuddlePrefs(undefined), H.defaultHuddlePrefs());
  assert.equal(H.sanitizeHuddlePrefs({ level: 'agent' }).level, 'compact', 'the agent it showed may be gone');
  assert.equal(H.sanitizeHuddlePrefs({ level: 'expanded' }).level, 'expanded');
  assert.equal(H.sanitizeHuddlePrefs({ level: 'nonsense' }).level, 'compact');
  assert.equal(H.sanitizeHuddlePrefs({ dock: 'top' }).dock, 'right');
  assert.equal(H.sanitizeHuddlePrefs({ dock: null }).dock, null);
  const p = H.sanitizeHuddlePrefs({ x: '5', y: 12.6, displayId: NaN });
  assert.equal('x' in p, false);
  assert.equal(p.y, 13);
  assert.equal('displayId' in p, false);
});

test('outgoing text is the same as the composer\'s', () => {
  assert.equal(H.formatOutgoing('hello', []), 'hello');
  assert.equal(H.formatOutgoing('look', [{ path: '/a/b.png', name: 'b.png' }, { path: '/c d.txt', name: 'c d.txt' }]), 'look\n\nAttached files:\n- /a/b.png (b.png)\n- /c d.txt (c d.txt)');
  assert.equal(H.formatOutgoing('  ', [{ path: '/x', name: 'x' }]), 'Attached files:\n- /x (x)');
  // the main window's composer builds the identical string; keep them one function
  const fs = require('node:fs');
  const composer = fs.readFileSync(require('node:path').join(__dirname, '..', 'src/renderer/src/components/MessageQueueComposer.tsx'), 'utf8');
  assert.match(composer, /formatOutgoing/, 'the composer uses the shared formatter');
});
