"""World container for the HIMYM backdrop: two pixel layers + the map data.

  bg   — floors, walls, rugs and everything a character can never stand behind.
  ov   — "occluders": tall pieces a character CAN walk behind (chair backs,
         plants, lamps, bar stools). Each is cut out as its own sprite at run
         time and y-sorted with the characters, so depth is always right.

Each location (apartment / maclarens / gnb) paints into a `Loc`, a view with
its own tile origin that also records collision, seats, and anchors in world
coordinates.
"""
from PIL import Image
from px import Canvas, T, OUT, lighten, darken, mix

LOC_W, LOC_H = 34, 22          # tiles per location
GAP = 3                        # void tiles between locations
ORDER = ['apartment', 'maclarens', 'gnb', 'rooftop', 'bedrooms', 'barney', 'columbia', 'lasertag']
WORLD_W = LOC_W * len(ORDER) + GAP * (len(ORDER) - 1)
WORLD_H = LOC_H


def hash2(x, y, s=0):
    h = (x * 73856093) ^ (y * 19349663) ^ (s * 83492791)
    h = (h ^ (h >> 13)) * 1274126177
    return (h ^ (h >> 16)) & 0xFFFF


class World:
    def __init__(self):
        self.bg = Canvas(WORLD_W * T, WORLD_H * T)
        # collision: True = blocked. Everything starts blocked (void).
        self.blocked = [[True] * WORLD_W for _ in range(WORLD_H)]
        self.pieces = []        # occluders: {img,x,y,w,h,base}
        self.seats = []         # {name,x,y,facing,screen,cup,sit}
        self.spawns = {}        # name -> (tx,ty)
        self.zones = {}         # name -> (tx,ty,tw,th)
        self.locations = {}     # id -> {x,y,w,h,door:{x,y},label}
        self.anchors = {}
        self.errands = []
        self.extra = {}

    def loc(self, name, label):
        i = ORDER.index(name)
        return Loc(self, name, label, i * (LOC_W + GAP), 0)


class Loc:
    def __init__(self, world, name, label, tx0, ty0):
        self.world = world
        self.name = name
        self.tx0, self.ty0 = tx0, ty0
        self.bg = world.bg.sub(tx0 * T, ty0 * T)
        self.W, self.H = LOC_W * T, LOC_H * T
        self.extra = world.extra.setdefault(name, {})
        world.locations[name] = {'x': tx0, 'y': ty0, 'w': LOC_W, 'h': LOC_H, 'label': label}
        # interior floor is walkable by default; walls blocked
        for y in range(3, LOC_H - 1):
            for x in range(1, LOC_W - 1):
                world.blocked[ty0 + y][tx0 + x] = False

    # ── collision ───────────────────────────────────────────────────────────
    def block(self, tx0, ty0, tx1=None, ty1=None):
        tx1 = tx0 if tx1 is None else tx1
        ty1 = ty0 if ty1 is None else ty1
        for y in range(ty0, ty1 + 1):
            for x in range(tx0, tx1 + 1):
                if 0 <= x < LOC_W and 0 <= y < LOC_H:
                    self.world.blocked[self.ty0 + y][self.tx0 + x] = True

    def free(self, tx0, ty0, tx1=None, ty1=None):
        tx1 = tx0 if tx1 is None else tx1
        ty1 = ty0 if ty1 is None else ty1
        for y in range(ty0, ty1 + 1):
            for x in range(tx0, tx1 + 1):
                self.world.blocked[self.ty0 + y][self.tx0 + x] = False

    def block_px(self, x, y, w, h, inset=3):
        """Block every tile a pixel rect meaningfully covers."""
        tx0 = (x + inset) // T; tx1 = (x + w - 1 - inset) // T
        ty0 = (y + inset) // T; ty1 = (y + h - 1 - inset) // T
        self.block(tx0, ty0, tx1, ty1)

    # ── occluders ───────────────────────────────────────────────────────────
    def tall(self, base_y, draw, x=0, y=0):
        """Paint a y-sorted piece. `draw(canvas)` paints in LOCAL pixels onto a
        scratch canvas; the tight bounding box becomes one occluder sprite whose
        depth is `base_y` (local px — where the piece meets the floor)."""
        tmp = Canvas(self.W, self.H)
        draw(tmp.sub(x, y))
        bbox = tmp.img.getbbox()
        if not bbox:
            return
        x0, y0, x1, y1 = bbox
        region = tmp.img.crop(bbox)
        gx, gy = self.tx0 * T + x0, self.ty0 * T + y0
        self.world.pieces.append({'img': region, 'x': gx, 'y': gy, 'w': x1 - x0, 'h': y1 - y0,
                                  'base': self.ty0 * T + base_y})

    # ── map data ────────────────────────────────────────────────────────────
    def seat(self, name, tx, ty, facing='up', screen=None, cup=None, sit=None, kind='laptop'):
        gx, gy = self.tx0 * T, self.ty0 * T
        s = {'name': name, 'x': self.tx0 + tx, 'y': self.ty0 + ty, 'facing': facing, 'kind': kind}
        if screen:
            s['screen'] = {'x': gx + screen[0], 'y': gy + screen[1], 'w': screen[2], 'h': screen[3]}
        if cup:
            s['cup'] = {'x': gx + cup[0], 'y': gy + cup[1]}
        if sit:
            s['sit'] = sit
        self.world.seats.append(s)
        self.world.spawns[name] = (self.tx0 + tx, self.ty0 + ty)
        self.free(tx, ty)

    def spawn(self, name, tx, ty):
        if name == 'entrance':
            name = 'entrance@' + self.name
        self.world.spawns[name] = (self.tx0 + tx, self.ty0 + ty)

    def zone(self, name, tx, ty, tw, th):
        self.world.zones[name] = (self.tx0 + tx, self.ty0 + ty, tw, th)

    def door(self, tx, ty):
        self.world.locations[self.name]['door'] = {'x': self.tx0 + tx, 'y': self.ty0 + ty}

    def tile(self, tx, ty):
        return {'x': self.tx0 + tx, 'y': self.ty0 + ty}

    def errand(self, kind, stand, facing, fx, duration, god_only=False):
        e = {'kind': kind, 'stand': self.tile(*stand), 'facing': facing, 'fx': self.tile(*fx),
             'duration': duration}
        if god_only:
            e['godOnly'] = True
        self.world.errands.append(e)

    def gpx(self, x, y):
        """Local px -> world px."""
        return {'x': self.tx0 * T + x, 'y': self.ty0 * T + y}
