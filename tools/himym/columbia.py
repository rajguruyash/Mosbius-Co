"""Columbia University — Professor Mosby's Architecture 101.

The big chalkboard, the lectern, rows of student desks either side of the
aisle, Columbia-blue banners. Here Ted teaches and the class works.
544x352 (34x22 tiles).
"""
from px import T, OUT, OUT2, lighten, darken, text_w
from world import hash2
import props as P
from apartment import desk_up, blinds_window

W, H = 34 * T, 22 * T
BLUE = (140, 190, 232)
WOODW = (150, 104, 72)


def paint(L):
    c = L.bg
    P.wood_floor(c, 6, 48, W - 12, H - 60, base=(176, 130, 88), seed=71, length=80)
    # the aisle runner
    c.rect(248, 112, 48, 228, (70, 110, 160)); c.frame(248, 112, 48, 228, (44, 76, 120)); c.frame(251, 115, 42, 222, BLUE)
    # wood-panelled lecture wall
    c.rect(6, 0, W - 12, 48, (222, 208, 176))
    c.rect(6, 30, W - 12, 14, WOODW)
    for xx in range(8, W - 8, 20):
        c.frame(xx, 32, 18, 11, darken(WOODW, 0.25))
    P.wall_trim(c, 6, 0, W - 12, wood=(104, 68, 52))
    P.room_shell(c, W, H, wall_top=(214, 202, 180), door=(256, 288))
    L.block(0, 0, 33, 2)

    # ── the board ────────────────────────────────────────────────────────────
    bx, bw = 132, 280
    c.rect(bx, 3, bw, 38, (120, 80, 58)); c.frame(bx, 3, bw, 38, OUT)
    c.rect(bx + 3, 6, bw - 6, 30, (40, 76, 62))
    for i in range(60):                                                  # chalk dust
        c.px(bx + 6 + hash2(i, 1, 4) % (bw - 12), 8 + hash2(i, 2, 4) % 26, (120, 150, 136))
    chalk = (236, 240, 232)
    s = 'ARCHITECTURE 101'
    c.text(bx + 10, 9, s, chalk); c.hline(bx + 10, 16, text_w(s), chalk, 160)
    c.text(bx + 10, 20, 'PROF. MOSBY', (250, 214, 130))
    c.text(bx + 10, 28, 'FORM FOLLOWS FUNCTION', (170, 220, 230))
    # a sketched skyline + an arch
    sx = bx + 150
    for (dx, hh) in ((0, 12), (9, 18), (18, 9), (27, 22), (38, 14), (47, 10)):
        c.frame(sx + dx, 34 - hh, 8, hh, chalk)
        for wy in range(36 - hh, 32, 4):
            c.px(sx + dx + 3, wy, chalk)
    c.vline(sx + 31, 8, 4, chalk)
    import math
    for k in range(0, 181, 3):                                           # a chalk arch
        ax = bx + 244 + int(round(14 * math.cos(math.radians(k)))); ay = 33 - int(round(22 * math.sin(math.radians(k))))
        c.px(ax, ay, chalk)
    c.hline(bx + 226, 33, 38, chalk)
    c.rect(bx + 4, 37, bw - 8, 3, (150, 104, 72))                        # chalk tray
    for i, col in enumerate((chalk, (250, 214, 130), (240, 150, 150))):
        c.rect(bx + 20 + i * 8, 36, 5, 2, col)
    c.rect(bx + 60, 35, 10, 3, (60, 60, 80))
    L.extra['screen'] = L.gpx(bx + 3, 6)

    # banners + clock + door + windows
    for bxx in (44, 470):
        c.rect(bxx, 4, 22, 30, (110, 170, 222)); c.frame(bxx, 4, 22, 30, OUT)
        c.rect(bxx + 2, 6, 18, 26, BLUE)
        for (dx, dy) in ((4, 14), (8, 10), (11, 13), (14, 10), (17, 14)):   # the crown
            c.px(bxx + dx, dy, (250, 250, 252))
        c.rect(bxx + 5, 15, 12, 4, (250, 250, 252))
        c.px(bxx + 4, 34, BLUE); c.px(bxx + 11, 36, BLUE); c.px(bxx + 17, 34, BLUE)
        c.line(bxx, 34, bxx + 11, 38, OUT); c.line(bxx + 21, 34, bxx + 11, 38, OUT)
    cx, cy = 100, 16
    c.ellipse(cx, cy, 8, 8, OUT); c.ellipse(cx, cy, 7, 7, (250, 250, 252)); c.line(cx, cy, cx, cy - 5, OUT); c.line(cx, cy, cx + 3, cy + 2, (200, 60, 56))
    blinds_window(c, 500, 3, 34, 38, drop=10, seed=51)

    # ── the professor: lectern desk facing the class ─────────────────────────
    x, y = 232, 60
    c.box(x, y, 80, 18, 8, (132, 86, 62), (96, 60, 50))
    c.rect(x + 6, y + 5, 12, 9, (236, 232, 222)); c.frame(x + 6, y + 5, 12, 9, OUT2)        # notes
    c.rect(x + 60, y + 3, 9, 11, (60, 84, 60)); c.frame(x + 59, y + 2, 11, 13, OUT)        # a textbook
    P.mug(c, x + 46, y + 9)
    L.block(14, 4, 19, 4)
    lid = [None]

    def lap(t):
        lid[0] = P.laptop_back(t, 16 * T + 8 - 7, y - 2)
    L.tall(y + 12, lap)
    L.seat('columbia-boss', 16, 3, 'down', screen=lid[0], kind='lid', sit={'dx': 0, 'dy': 10, 'crop': 8})
    # a scale model on a stand beside the lectern
    def model(t):
        t.rect(2, 22, 16, 3, (150, 104, 72)); t.vline(9, 25, 8, (110, 72, 54)); t.hline(4, 33, 11, (110, 72, 54))
        t.rect(4, 8, 6, 14, (240, 238, 230)); t.rect(11, 14, 6, 8, (240, 238, 230)); t.rect(6, 2, 2, 6, (240, 238, 230))
        for yy in range(10, 22, 3):
            t.hline(5, yy, 4, (170, 190, 214))
    L.tall(96, lambda t: P.stamp(t, model, 196, 60, 20, 34))
    L.block(12, 4, 12, 5)

    # ── the class: three rows either side of the aisle ───────────────────────
    seats = []
    for ty in (9, 13, 17):
        for side in ((2, 5, 8, 11, 14), (20, 23, 26, 29, 32)):
            x0 = side[0] * T - 12; x1 = side[-1] * T + 28
            dy = (ty - 1) * T - 6
            c.box(x0, dy, x1 - x0, 15, 7, (206, 160, 104), (150, 104, 72))                 # one long bench desk
            for i in range(x0 + 10, x1 - 6, 48):
                c.vline(i, dy + 16, 5, darken((150, 104, 72), 0.2))
            L.block(x0 // T, ty - 1, (x1 - 1) // T, ty - 1)
            for tx in side:
                cx_ = tx * T + 8
                k = (tx + ty) % 4
                if k == 0:                                                                # some take notes by hand
                    c.rect(cx_ - 6, dy + 4, 11, 8, (250, 246, 238)); c.frame(cx_ - 6, dy + 4, 11, 8, OUT2)
                    c.hline(cx_ - 4, dy + 7, 7, (150, 170, 200)); c.hline(cx_ - 4, dy + 9, 6, (150, 170, 200))
                    scr = None
                else:
                    scr = P.laptop_front(c, cx_ - 7, dy - 3)
                P.chair_seat(c, cx_ - 6, ty * T + 2, wood=(120, 76, 58))
                L.tall(ty * T + 22, lambda t, cx_=cx_, ty=ty: P.chair_back_front(t, cx_ - 6, ty * T + 9, wood=(120, 76, 58)))
                name = 'columbia-%d' % (len(seats) + 1)
                L.seat(name, tx, ty, 'up', screen=scr, cup=(cx_ + 9, dy + 9) if scr else None, kind='laptop' if scr else 'none')
                seats.append(name)

    L.tall(338, lambda t: P.potted_plant(t, 24, 338, 0))
    L.block(1, 20)
    P.trash_bin(c, 323, 324)
    L.block(20, 20)
    L.spawn('entrance', 16, 20)
    L.free(16, 21, 17, 21)
    L.door(16, 21)
    L.extra['hq'] = {'boss': 'columbia-boss', 'seats': seats, 'cast': ['ted'], 'crowd': 'students'}
    L.errand('water', (2, 20), 'left', (1, 20), 4.5)
    L.errand('bin', (21, 20), 'left', (20, 20), 2.6)
