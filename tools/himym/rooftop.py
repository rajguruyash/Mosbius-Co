"""The rooftop — where the gang goes to think, smoke a cigar, watch the city.

Reached from the apartment's fire-escape window: the ladder comes up over the
parapet at the bottom edge. Night sky and skyline along the top, the water
tower, string lights, a deck with a picnic table, lawn chairs, the grill.
Local pixels, 544x352 (34x22 tiles).
"""
from px import T, OUT, OUT2, lighten, darken, mix
from world import hash2
import props as P

W, H = 34 * T, 22 * T

ROOF = (86, 90, 106)
DECK = (150, 108, 76)
PARA = (140, 72, 60)
COPING = (176, 170, 168)


def paint(L):
    c = L.bg
    # ── roof surface: membrane, gravel, tar seams ────────────────────────────
    for yy in range(48, H - 12):
        for xx in range(6, W - 6):
            n = hash2(xx, yy, 3) % 19
            col = lighten(ROOF, 0.10) if n == 0 else darken(ROOF, 0.12) if n == 1 else ROOF
            c.px(xx, yy, col)
    for yy in range(96, H - 12, 64):
        c.hline(6, yy, W - 12, darken(ROOF, 0.22)); c.hline(6, yy + 1, W - 12, lighten(ROOF, 0.08))
    for xx in range(118, W - 6, 136):
        c.vline(xx, 48, H - 60, darken(ROOF, 0.22))
    # the deck
    P.wood_floor(c, 152, 128, 240, 128, base=DECK, seed=23, length=48)
    c.frame(152, 128, 240, 128, darken(DECK, 0.4)); c.rect(152, 256, 240, 3, darken(DECK, 0.3)); c.hline(152, 259, 240, OUT)
    c.rect(152, 260, 240, 3, (10, 8, 20), 60)

    sky(c)
    parapet(L)
    water_tower(L)
    deck_things(L)
    roof_things(L)
    string_lights(L)

    L.block(0, 0, 33, 2)
    L.spawn('entrance', 11, 19)
    L.door(11, 20)                          # top of the fire-escape ladder
    L.free(11, 20)
    L.errand('smoke', (20, 3), 'up', (20, 1), 18, god_only=True)
    L.errand('window', (14, 3), 'up', (14, 1), 5)
    L.errand('window', (25, 3), 'up', (25, 1), 5)
    L.errand('water', (2, 12), 'left', (1, 12), 4.5)
    L.errand('water', (31, 9), 'right', (32, 9), 4.5)
    L.errand('dispenser', (27, 11), 'up', (27, 10), 3.5)
    L.errand('bin', (30, 19), 'right', (31, 19), 2.6)


def sky(c):
    grad = [(18, 20, 52), (34, 34, 84), (74, 56, 120), (150, 84, 124), (226, 130, 104)]
    for yy in range(0, 40):
        t = yy / 39.0
        seg = min(int(t * 4), 3)
        c.hline(6, yy, W - 12, mix(grad[seg], grad[seg + 1], t * 4 - seg))
    for i in range(70):                                         # stars
        sx = 8 + hash2(i, 1, 2) % (W - 16); sy = 1 + hash2(i, 2, 2) % 20
        c.px(sx, sy, (255, 255, 240), 120 + hash2(i, 3, 2) % 130)
    c.ellipse(470, 10, 6, 6, (250, 246, 220)); c.ellipse(473, 8, 5, 5, mix(grad[0], grad[1], 0.6))   # crescent moon
    # far skyline
    bx, k = 6, 0
    while bx < W - 6:
        bw = min(6 + hash2(k, 1, 6) % 12, W - 6 - bx)
        bh = 8 + hash2(k, 2, 6) % 16
        c.rect(bx, 40 - bh, bw, bh, (58, 50, 104))
        bx += bw + hash2(k, 3, 6) % 3; k += 1
    # near skyline with lit windows
    bx, k = 6, 0
    while bx < W - 6:
        bw = min(10 + hash2(k, 1, 9) % 18, W - 6 - bx)
        bh = 10 + hash2(k, 2, 9) % 22
        c.rect(bx, 40 - bh, bw, bh, (30, 28, 62))
        c.hline(bx, 40 - bh, bw, (52, 48, 96))
        for wy in range(40 - bh + 3, 39, 3):
            for wx in range(bx + 2, bx + bw - 1, 3):
                if hash2(wx, wy, 5) % 3 == 0:
                    c.px(wx, wy, (255, 220, 130)); c.px(wx, wy + 1, (240, 190, 100))
        if hash2(k, 4, 9) % 4 == 0 and bw > 12:               # a rooftop water tank
            c.rect(bx + 3, 40 - bh - 5, 6, 4, (30, 28, 62)); c.vline(bx + 4, 40 - bh - 1, 1, (30, 28, 62))
        bx += bw + 1 + hash2(k, 3, 9) % 4; k += 1
    # the tall one with the spire
    c.rect(258, 6, 16, 34, (26, 24, 56)); c.rect(262, 0, 8, 8, (26, 24, 56)); c.vline(266, -6, 6, (26, 24, 56))
    for wy in range(9, 38, 3):
        for wx in range(260, 273, 3):
            if hash2(wx, wy, 8) % 2 == 0:
                c.px(wx, wy, (255, 220, 130))
    c.px(266, 0, (255, 90, 80))


def parapet(L):
    c = L.bg
    # the far parapet: a low brick wall with a stone coping
    P.brick_wall(c, 6, 39, W - 12, 9, base=PARA, mortar=(92, 48, 48), seed=13)
    c.rect(6, 36, W - 12, 4, COPING); c.hline(6, 36, W - 12, (214, 210, 206)); c.hline(6, 39, W - 12, (120, 114, 118))
    c.hline(6, 35, W - 12, OUT); c.hline(6, 47, W - 12, OUT)
    c.rect(6, 48, W - 12, 4, (10, 8, 20), 70)
    # side and near parapets, seen from above
    for sx in (0, W - 6):
        c.rect(sx, 36, 6, H - 36, COPING); c.vline(sx, 36, H - 36, OUT); c.vline(sx + 5, 36, H - 36, OUT)
        c.vline(sx + 1, 36, H - 36, (214, 210, 206))
        for yy in range(52, H, 24):
            c.hline(sx + 1, yy, 4, (120, 114, 118))
    by = H - 12
    c.rect(0, by, W, 12, COPING); c.hline(0, by, W, OUT); c.hline(0, H - 1, W, OUT)
    c.hline(1, by + 1, W - 2, (214, 210, 206)); c.rect(0, by + 8, W, 3, (130, 124, 128))
    for xx in range(20, W, 28):
        c.vline(xx, by + 1, 7, (120, 114, 118))
    # the fire-escape ladder hooks over the near parapet at tile 11
    lx = 11 * T
    iron, iron_l = (26, 24, 36), (90, 90, 114)

    def ladder(t):
        for x in (2, 13):
            t.vline(x, 4, 30, iron); t.vline(x + 1, 4, 30, iron_l)
            t.line(x, 4, x + 3, 0, iron); t.line(x + 3, 0, x + 3, 6, iron)
        for y in range(8, 34, 5):
            t.hline(3, y, 10, iron)
    L.tall(H + 40, ladder, x=lx, y=H - 30)
    c.rect(lx - 4, by - 14, 24, 14, (60, 62, 80), 90)          # worn patch where everyone climbs up


def water_tower(L):
    def tower(t):
        wood, wd, wl = (136, 92, 66), (96, 62, 50), (176, 126, 88)
        # legs + cross braces
        for x in (6, 49):
            t.rect(x, 62, 3, 34, (60, 58, 74)); t.frame(x - 1, 61, 5, 36, OUT)
        t.line(8, 66, 49, 92, (60, 58, 74)); t.line(49, 66, 8, 92, (60, 58, 74))
        t.rect(2, 58, 54, 5, (80, 78, 96)); t.frame(2, 58, 54, 5, OUT)
        # tank
        t.rect(4, 18, 50, 40, wood)
        for x in range(4, 54, 5):
            t.vline(x, 18, 40, wd)
        for x in range(6, 54, 10):
            t.vline(x, 19, 38, wl)
        for y in (26, 38, 50):
            t.hline(4, y, 50, (70, 68, 86)); t.hline(4, y + 1, 50, (40, 38, 52))
        t.frame(3, 17, 52, 42, OUT)
        # conical roof
        for i in range(14):
            t.hline(29 - 2 * i - 1, 4 + i, 4 * i + 3, (90, 88, 108) if i % 3 else (120, 118, 140))
        t.line(29, 3, 1, 17, OUT); t.line(29, 3, 57, 17, OUT); t.hline(1, 18, 57, OUT)
        t.vline(29, 0, 4, OUT)
    L.tall(152, tower, x=22, y=54)
    L.bg.ellipse(51, 152, 30, 7, (10, 8, 20), 60)
    L.block(1, 7, 4, 9)


def deck_things(L):
    c = L.bg
    # picnic table (rows 9-11) with benches: 4 seats
    x, y = 232, 152
    c.box(x, y + 12, 80, 18, 5, (176, 128, 88), (126, 86, 62))
    for px_ in range(x + 2, x + 78, 16):
        c.vline(px_, y + 13, 17, (140, 98, 68))
    for by in (y - 4, y + 40):
        c.box(x + 4, by, 72, 8, 4, (160, 114, 78), (116, 78, 58))
    P.bottle(c, x + 20, y + 14); P.bottle(c, x + 52, y + 17)
    c.rrect(x + 32, y + 18, 12, 7, (236, 226, 200), 2); c.rframe(x + 32, y + 18, 12, 7, OUT, 2)
    c.px(x + 35, y + 20, (226, 90, 70)); c.px(x + 39, y + 21, (240, 190, 70))
    L.block(14, 10, 19, 11)
    for i, t_ in enumerate((15, 18)):
        L.seat('roof-%d' % (i * 2 + 1), t_, 9, 'down', kind='none')
        L.seat('roof-%d' % (i * 2 + 2), t_, 12, 'up', kind='none')

    # two striped lawn chairs, facing the city
    for (lx, col) in ((168, (226, 90, 70)), (196, (80, 140, 220))):
        ly = 140
        c.shadow(lx + 1, ly + 34, 18, 2)
        c.rrect(lx, ly, 18, 34, (236, 236, 240), 2)
        for yy in range(ly + 2, ly + 32, 4):
            c.rect(lx + 2, yy, 14, 2, col)
        c.hline(lx + 2, ly + 12, 14, (150, 156, 172))
        c.rframe(lx, ly, 18, 34, OUT, 2)
    L.block(10, 9, 13, 10)

    # the grill
    gx, gy = 344, 138
    def grill(t):
        t.rect(3, 12, 2, 16, (60, 58, 74)); t.rect(17, 12, 2, 16, (60, 58, 74)); t.hline(2, 27, 18, (40, 38, 52))
        t.rrect(0, 2, 22, 11, (40, 38, 52), 3); t.rect(2, 3, 18, 3, (90, 88, 108))
        for x in range(4, 19, 3):
            t.vline(x, 4, 2, (240, 130, 50))
        t.rframe(0, 2, 22, 11, OUT, 3); t.rect(9, 0, 4, 2, (150, 104, 72))
    L.tall(gy + 28, grill, x=gx, y=gy)
    L.block(21, 9, 22, 10)
    L.extra['grill'] = L.gpx(gx + 11, gy + 2)

    # the cooler (tile 27, row 10)
    kx, ky = 27 * T, 10 * T
    c.box(kx, ky - 2, 16, 9, 8, (226, 60, 56), (170, 40, 44)); c.rect(kx + 1, ky - 1, 14, 3, (250, 250, 252))
    c.rect(kx + 6, ky + 9, 4, 2, (250, 250, 252))
    L.block(27, 10)


def roof_things(L):
    c = L.bg
    # stairwell bulkhead, top right
    bx, by = 444, 30
    P.brick_wall(c, bx, by, 72, 50, base=(150, 80, 66), mortar=(100, 54, 52), seed=29)
    c.rect(bx - 2, by - 4, 76, 5, COPING); c.frame(bx - 2, by - 4, 76, 5, OUT); c.frame(bx, by, 72, 51, OUT)
    c.rect(bx + 26, by + 12, 22, 38, (70, 84, 96)); c.frame(bx + 26, by + 12, 22, 39, OUT)
    c.rect(bx + 29, by + 16, 16, 12, (40, 50, 62)); c.rect(bx + 43, by + 32, 2, 3, (226, 190, 110))
    c.rect(bx + 52, by + 8, 8, 5, (255, 220, 130)); c.frame(bx + 51, by + 7, 10, 7, OUT)       # light over the door
    c.ellipse(bx + 37, by + 56, 22, 8, (255, 200, 120), 26)
    L.block(27, 3, 32, 4)
    # telescope at the far parapet
    def scope(t):
        t.line(6, 22, 2, 30, (60, 58, 74)); t.line(6, 22, 10, 30, (60, 58, 74)); t.vline(6, 16, 14, (60, 58, 74))
        t.line(0, 14, 12, 6, (200, 206, 216)); t.line(0, 15, 12, 7, (150, 156, 172)); t.line(1, 16, 13, 8, (150, 156, 172))
        t.rect(11, 4, 4, 5, (226, 190, 110))
    L.tall(64, lambda t: P.stamp(t, scope, 396, 34, 16, 31))
    L.block(24, 3)
    # air-conditioning unit + vent pipes, left
    ax, ay = 20, 250
    c.box(ax, ay, 44, 22, 12, (170, 176, 190), (120, 126, 146))
    c.ellipse(ax + 14, ay + 11, 8, 7, (60, 62, 80)); c.ring(ax + 14, ay + 11, 8, 7, OUT, 1)
    c.line(ax + 8, ay + 11, ax + 20, ay + 11, (150, 156, 172)); c.line(ax + 14, ay + 5, ax + 14, ay + 17, (150, 156, 172))
    for yy in range(ay + 4, ay + 20, 3):
        c.hline(ax + 28, yy, 12, (110, 116, 136))
    L.block(1, 15, 3, 17)
    for (vx, vy) in ((96, 286), (476, 196)):
        c.rect(vx, vy, 8, 12, (150, 156, 172)); c.rect(vx - 2, vy - 3, 12, 4, (190, 196, 210)); c.frame(vx - 2, vy - 3, 12, 4, OUT); c.frame(vx, vy, 8, 13, OUT)
    L.block(6, 18); L.block(29, 12, 30, 12)
    # skylight glowing from the apartment below
    sx, sy = 420, 256
    c.rect(sx, sy, 60, 36, (70, 72, 92)); c.rect(sx + 3, sy + 3, 54, 30, (255, 214, 130))
    for i in range(1, 3):
        c.vline(sx + 3 + i * 18, sy + 3, 30, (70, 72, 92))
    c.hline(sx + 3, sy + 18, 54, (70, 72, 92))
    c.frame(sx, sy, 60, 36, OUT)
    c.rect(sx - 6, sy - 6, 72, 48, (255, 200, 120), 22)
    L.block(26, 16, 29, 17)
    # planters
    for (px_, py_, tx, ty) in ((8, 180, 1, 12), (514, 132, 32, 9)):
        c.box(px_, py_ + 8, 22, 6, 8, (150, 100, 72), (110, 72, 58))
        L.tall(py_ + 22, lambda t, px_=px_, py_=py_: P.potted_plant(t, px_ + 11, py_ + 14, 1))
        L.block(tx, ty)
    P.trash_bin(c, 31 * T + 3, 19 * T)
    L.block(31, 19)


def string_lights(L):
    c = L.bg
    cols = [(255, 214, 120), (255, 150, 130), (150, 220, 255), (190, 255, 170)]
    runs = [((150, 96), (394, 104)), ((150, 262), (394, 254)), ((150, 96), (150, 262)), ((394, 104), (394, 254))]

    def poles(t):
        for (px_, py_) in ((150, 96), (394, 104), (150, 262), (394, 254)):
            t.rect(px_ - 1, py_ - 34, 2, 36, (60, 58, 74)); t.frame(px_ - 2, py_ - 35, 4, 38, OUT)
    L.tall(100, poles)

    def wires(t):
        k = 0
        for (a, b) in runs[:2]:
            n = 14
            for i in range(n + 1):
                u = i / float(n)
                x = int(a[0] + (b[0] - a[0]) * u)
                y = int(a[1] - 34 + (b[1] - a[1]) * u + 14 * (1 - (2 * u - 1) ** 2))
                if i:
                    t.line(px0, py0, x, y, (30, 26, 40))
                px0, py0 = x, y
                if 0 < i < n:
                    col = cols[k % 4]; k += 1
                    t.rect(x - 1, y + 1, 2, 3, col); t.px(x - 1, y + 1, (255, 255, 255))
    L.tall(H + 100, wires)
    # their glow on the deck
    for (a, b) in runs[:2]:
        for i in range(1, 14):
            u = i / 14.0
            x = int(a[0] + (b[0] - a[0]) * u); y = int(a[1] + (b[1] - a[1]) * u) - 6
            c.ellipse(x, y + 12, 16, 9, (255, 206, 130), 7)
