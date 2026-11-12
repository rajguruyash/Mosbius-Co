"""Write the painted world into the app: backdrop, occluder atlas, Tiled map
(collision + spawn points only), and the metadata the scene reads."""
import json, os
from collections import deque
from PIL import Image
from px import T, ASSETS
from world import WORLD_W, WORLD_H, ORDER

OUT_DIR = os.path.join(ASSETS, 'himym')


def pack(pieces, width=1024):
    """Shelf-pack the occluder sprites into one atlas."""
    order = sorted(range(len(pieces)), key=lambda i: -pieces[i]['h'])
    x = y = row_h = 0
    pos = {}
    for i in order:
        p = pieces[i]
        if x + p['w'] + 1 > width:
            x = 0; y += row_h + 1; row_h = 0
        pos[i] = (x, y)
        x += p['w'] + 1
        row_h = max(row_h, p['h'])
    atlas = Image.new('RGBA', (width, y + row_h + 1), (0, 0, 0, 0))
    out = []
    for i, p in enumerate(pieces):
        ax, ay = pos[i]
        atlas.paste(p['img'], (ax, ay))
        out.append({'x': p['x'], 'y': p['y'], 'w': p['w'], 'h': p['h'], 'base': p['base'], 'ax': ax, 'ay': ay})
    return atlas, out


def portals(w):
    L = w.locations
    street = [L[n]['door'] for n in ('apartment', 'maclarens', 'gnb', 'barney', 'columbia', 'lasertag')]
    pairs = []
    for i in range(len(street)):
        for j in range(i + 1, len(street)):
            pairs.append([street[i], street[j]])
    pairs.append([w.extra['apartment']['fireEscape'], L['rooftop']['door']])
    # the hall door in the apartment's back wall leads to the bedrooms
    pairs.append([{'x': L['apartment']['x'] + 8, 'y': L['apartment']['y'] + 3}, L['bedrooms']['door']])
    return pairs


def validate(w, pairs):
    walk = [[not b for b in row] for row in w.blocked]
    link = {}
    for a, b in pairs:
        link.setdefault((a['x'], a['y']), []).append((b['x'], b['y']))
        link.setdefault((b['x'], b['y']), []).append((a['x'], a['y']))
        walk[a['y']][a['x']] = True; walk[b['y']][b['x']] = True
    start = w.spawns['entrance@apartment']
    seen = {start}
    q = deque([start])
    while q:
        x, y = q.popleft()
        nb = [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)] + link.get((x, y), [])
        for nx, ny in nb:
            if 0 <= nx < WORLD_W and 0 <= ny < WORLD_H and (nx, ny) not in seen and walk[ny][nx]:
                seen.add((nx, ny)); q.append((nx, ny))
    bad = [n for n, t in w.spawns.items() if tuple(t) not in seen]
    for e in w.errands:
        if (e['stand']['x'], e['stand']['y']) not in seen:
            bad.append('errand %s@%s' % (e['kind'], e['stand']))
    for loc, ex in w.extra.items():
        for k in ('coffee', 'anchors'):
            for name, t in (ex.get(k) or {}).items():
                if name.endswith('Stand') and (t['x'], t['y']) not in seen:
                    bad.append('%s.%s' % (k, name))
    return bad


def write(w):
    os.makedirs(OUT_DIR, exist_ok=True)
    w.bg.img.save(os.path.join(OUT_DIR, 'world-bg.png'))
    atlas, occ = pack(w.pieces)
    atlas.save(os.path.join(OUT_DIR, 'world-ov.png'))
    pairs = portals(w)
    bad = validate(w, pairs)
    if bad:
        raise SystemExit('UNREACHABLE: ' + ', '.join(bad))

    oid = [1]
    def obj(name, x, y, wd=0, h=0):
        o = {'id': oid[0], 'name': name, 'x': x * T, 'y': y * T, 'width': wd * T, 'height': h * T,
             'rotation': 0, 'type': '', 'visible': True}
        oid[0] += 1
        return o
    spawns = [obj(n.split('@')[0] if n.endswith('@apartment') else n, x, y) for n, (x, y) in w.spawns.items()]
    zones = [obj(n, x, y, wd, h) for n, (x, y, wd, h) in w.zones.items()]
    coll = [1 if w.blocked[y][x] else 0 for y in range(WORLD_H) for x in range(WORLD_W)]
    tmj = {'compressionlevel': -1, 'infinite': False, 'orientation': 'orthogonal', 'renderorder': 'right-down',
           'width': WORLD_W, 'height': WORLD_H, 'tilewidth': T, 'tileheight': T, 'type': 'map', 'version': '1.10',
           'tiledversion': '1.10.2', 'nextlayerid': 9, 'nextobjectid': oid[0], 'tilesets': [],
           'layers': [
               {'id': 5, 'name': 'collision', 'type': 'tilelayer', 'data': coll, 'width': WORLD_W, 'height': WORLD_H,
                'x': 0, 'y': 0, 'opacity': 1, 'visible': True},
               {'id': 6, 'name': 'spawn-points', 'type': 'objectgroup', 'objects': spawns, 'draworder': 'topdown',
                'opacity': 1, 'visible': True, 'x': 0, 'y': 0},
               {'id': 7, 'name': 'zones', 'type': 'objectgroup', 'objects': zones, 'draworder': 'topdown',
                'opacity': 1, 'visible': True, 'x': 0, 'y': 0}]}
    json.dump(tmj, open(os.path.join(OUT_DIR, 'world.tmj'), 'w'))

    seat_names = [s['name'] for s in w.seats]
    primary = ['desk-ceo'] + ['pc-%d' % i for i in range(1, 21)] + ['conf-%d' % i for i in range(1, 7)] + ['roof-%d' % i for i in range(1, 5)] + ['room-1', 'room-2']
    cafe = ['cafe-seat-%d' % i for i in range(1, 17)]
    missing = [n for n in primary + cafe if n not in seat_names]
    if missing:
        raise SystemExit('MISSING SEATS: ' + ', '.join(missing))
    meta = {
        'tile': T, 'width': WORLD_W, 'height': WORLD_H,
        'order': ['rooftop', 'apartment', 'bedrooms', 'maclarens', 'gnb', 'barney', 'columbia', 'lasertag'],
        'hq': {n: w.extra[n]['hq'] for n in ('barney', 'columbia', 'lasertag')},
        'locations': w.locations, 'portals': pairs,
        'seats': w.seats, 'occluders': occ, 'errands': w.errands,
        'primarySeatNames': primary, 'cafeSeatNames': cafe,
        'coffee': w.extra['maclarens']['coffee'], 'anchors': w.extra['gnb']['anchors'],
        'fx': {'fire': w.extra['apartment']['fire'], 'grill': w.extra['rooftop']['grill'],
               'jukebox': w.extra['maclarens']['jukebox'], 'bartender': w.extra['maclarens']['bartender']},
    }
    json.dump(meta, open(os.path.join(OUT_DIR, 'world.json'), 'w'))
    import street
    street.paint().save(os.path.join(OUT_DIR, 'street.png'))
    street.cab().save(os.path.join(OUT_DIR, 'cab.png'))
    print('wrote', OUT_DIR, '| bg', w.bg.img.size, '| atlas', atlas.size, '|', len(occ), 'occluders |',
          len(w.seats), 'seats |', len(w.errands), 'errands | all reachable')
