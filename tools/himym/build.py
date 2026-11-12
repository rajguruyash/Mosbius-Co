#!/usr/bin/env python3
"""Paint the HIMYM world and write the theme's assets.

  python3 tools/himym/build.py            # write assets into src/renderer/src/assets/himym
  python3 tools/himym/build.py --preview out.png [location]
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from PIL import Image
from px import T, ASSETS
from world import World, WORLD_W, WORLD_H, LOC_W, LOC_H

import apartment
LOCS = [('apartment', "Ted's apartment", apartment)]
try:
    import maclarens
    LOCS.append(('maclarens', "MacLaren's Pub", maclarens))
except ImportError:
    pass
import gnb, rooftop
LOCS.append(('gnb', 'Goliath National Bank', gnb))
LOCS.append(('rooftop', 'The Rooftop', rooftop))
for (name, label) in (('bedrooms', 'The Bedrooms'), ('barney', "Barney's Apartment"), ('columbia', 'Columbia University'), ('lasertag', 'Laser Tag')):
    try:
        LOCS.append((name, label, __import__(name)))
    except ImportError:
        pass


def build():
    w = World()
    for (name, label, mod) in LOCS:
        mod.paint(w.loc(name, label))
    return w


def composite(w):
    """bg + every occluder in depth order — what the floor looks like empty."""
    img = w.bg.img.copy()
    for p in sorted(w.pieces, key=lambda p: p['base']):
        img.alpha_composite(p['img'], (p['x'], p['y']))
    return img


def preview(w, out, loc=None, scale=2, grid=False):
    img = composite(w)
    if loc:
        l = w.locations[loc]
        img = img.crop((l['x'] * T, l['y'] * T, (l['x'] + l['w']) * T, (l['y'] + l['h']) * T))
        ox, oy = l['x'], l['y']
    else:
        ox = oy = 0
    back = Image.new('RGBA', img.size, (26, 19, 32, 255))
    back.alpha_composite(img)
    img = back
    if grid:
        from PIL import ImageDraw
        d = ImageDraw.Draw(img, 'RGBA')
        for ty in range(img.height // T):
            for tx in range(img.width // T):
                if w.blocked[oy + ty][ox + tx]:
                    d.rectangle([tx * T, ty * T, tx * T + T - 1, ty * T + T - 1], fill=(255, 0, 0, 60))
        for s in w.seats:
            x, y = (s['x'] - ox) * T, (s['y'] - oy) * T
            d.rectangle([x + 2, y + 2, x + T - 3, y + T - 3], outline=(0, 255, 255, 255))
        for e in w.errands:
            x, y = (e['stand']['x'] - ox) * T, (e['stand']['y'] - oy) * T
            d.rectangle([x + 5, y + 5, x + T - 6, y + T - 6], outline=(255, 255, 0, 255))
    img = img.resize((img.width * scale, img.height * scale), Image.NEAREST)
    img.save(out)
    print('preview', out, img.size)


if __name__ == '__main__':
    w = build()
    if '--preview' in sys.argv:
        i = sys.argv.index('--preview')
        out = sys.argv[i + 1]
        loc = sys.argv[i + 2] if len(sys.argv) > i + 2 and not sys.argv[i + 2].startswith('--') else None
        preview(w, out, loc, grid='--grid' in sys.argv)
    else:
        import export
        export.write(w)
