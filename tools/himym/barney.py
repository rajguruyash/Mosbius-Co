"""Barney's apartment — laid out from the owner's floor-plan drawing.

  left half        the living room: front door on the far-left wall, the big
                   balcony window and the stormtrooper top-left, the couch in
                   the middle facing the screen along the bottom
  upper middle     bedroom 1            upper right   the suit room
  middle band      the corridor (door from the living room) running right
                   into the collection passage
  lower middle     the kitchen          lower right   bedroom 2

Walls are real: every room is entered through a doorway. 544x352 (34x22 tiles).
"""
from px import T, OUT, OUT2, lighten, darken, text_w
from world import hash2
import props as P
from apartment import desk_up, sofa
from bedrooms import bed

W, H = 34 * T, 22 * T
WALLC = (58, 60, 76)
STEEL = (170, 178, 194)
GOLD = (226, 190, 110)
PART = (104, 106, 126)


def vwall(L, col, r0, r1, gaps=()):
    """A wall along tile column `col`, rows r0..r1, with doorway rows in `gaps`."""
    c = L.bg
    x = col * T + 6
    for r in range(r0, r1 + 1):
        if r in gaps:
            continue
        y = r * T
        c.rect(x, y, 4, T, PART); c.vline(x, y, T, OUT); c.vline(x + 3, y, T, OUT); c.vline(x + 1, y, T, lighten(PART, 0.3))
        c.rect(x + 4, y, 2, T, (10, 8, 20), 50)
        L.block(col, r)
        if r - 1 in gaps or r == r0:
            c.hline(x, y, 4, OUT)
        if r + 1 in gaps or r == r1:
            c.hline(x, y + T - 1, 4, OUT)


def hwall(L, row, c0, c1, gaps=()):
    """A wall along tile row `row`, columns c0..c1, with doorway columns in `gaps`."""
    c = L.bg
    y = row * T + 4
    for col in range(c0, c1 + 1):
        if col in gaps:
            continue
        x = col * T
        c.rect(x, y, T, 8, PART); c.hline(x, y, T, OUT); c.hline(x, y + 7, T, OUT); c.hline(x, y + 1, T, lighten(PART, 0.3))
        c.rect(x, y + 5, T, 2, darken(PART, 0.2)); c.rect(x, y + 8, T, 2, (10, 8, 20), 60)
        L.block(col, row)
        if col - 1 in gaps or col == c0:
            c.vline(x, y, 8, OUT)
        if col + 1 in gaps or col == c1:
            c.vline(x + T - 1, y, 8, OUT)


def cases(c, x, y, w, h, seed):
    """A shelf of video cases, spines out."""
    c.rect(x, y, w, h, (36, 34, 46)); c.frame(x, y, w, h, OUT)
    cols = [(200, 60, 70), (236, 190, 80), (70, 120, 200), (230, 230, 236), (150, 80, 170), (40, 40, 52), (220, 120, 60)]
    for row in range(h // 6):
        xx = x + 2
        k = 0
        while xx < x + w - 3:
            col = cols[hash2(k, row, seed) % len(cols)]
            c.rect(xx, y + 1 + row * 6, 2, 5, col); c.px(xx, y + 2 + row * 6, lighten(col, 0.4))
            xx += 3; k += 1
        c.hline(x + 1, y + 6 + row * 6 - 0, w - 2, (90, 90, 110)) if row < h // 6 - 1 else None


def paint(L):
    c = L.bg
    P.wood_floor(c, 6, 48, W - 12, H - 60, base=(62, 60, 74), seed=61, length=72)
    for i in range(40):
        x = 10 + hash2(i, 1, 6) % (W - 40); y = 56 + hash2(i, 2, 6) % (H - 80)
        c.hline(x, y, 10 + hash2(i, 3, 6) % 14, (120, 120, 150), 36)
    c.rect(6, 0, W - 12, 48, WALLC)
    for xx in range(6, W - 6, 28):
        c.vline(xx, 4, 40, darken(WALLC, 0.18)); c.vline(xx + 1, 4, 40, lighten(WALLC, 0.08))
    P.wall_trim(c, 6, 0, W - 12, wood=(36, 36, 48), ceil=(24, 24, 36))
    P.room_shell(c, W, H, wall_top=PART, door=None)
    L.block(0, 0, 33, 2)

    # ── walls and doorways first ─────────────────────────────────────────────
    vwall(L, 17, 3, 20, gaps=(10, 11, 16, 17))      # living room | the rest: corridor door, kitchen opening
    hwall(L, 9, 18, 32, gaps=(19, 32))               # bedroom 1 and the suit room above the corridor
    vwall(L, 26, 3, 8)                               # bedroom 1 | suit room
    hwall(L, 12, 18, 32, gaps=(21, 28))              # kitchen and bedroom 2 below the corridor
    vwall(L, 25, 13, 20)                             # kitchen | bedroom 2
    for (dx, dy) in ((17 * T + 2, 10 * T), (17 * T + 2, 16 * T)):   # thresholds
        c.rect(dx, dy, 12, 32, (90, 88, 108), 120)

    # ── LIVING ROOM ──────────────────────────────────────────────────────────
    # front door, far-left wall
    c.rect(0, 114, 6, 36, (74, 56, 62)); c.frame(0, 113, 6, 38, OUT); c.rect(1, 116, 4, 32, (150, 112, 78))
    c.rect(8, 116, 14, 32, (40, 40, 52)); c.frame(8, 116, 14, 32, STEEL)
    L.spawn('entrance', 2, 8)
    L.door(1, 8)
    # the big balcony window: skyline, and the balcony rail outside
    P.night_window(c, 58, 3, 204, 37, frame=(40, 40, 52), seed=33, panes=6, sill=False)
    for bx in range(62, 258, 5):
        c.vline(bx, 27, 10, (22, 20, 32))
    c.hline(61, 27, 198, (22, 20, 32)); c.hline(61, 26, 198, (90, 90, 114))
    # the stormtrooper, by the window
    def trooper(t):
        w_, sh, bk = (240, 240, 244), (176, 180, 194), (26, 26, 36)
        t.rrect(4, 0, 12, 12, w_, 3); t.rect(5, 5, 10, 2, bk); t.rect(7, 9, 6, 2, bk); t.px(6, 10, sh); t.px(13, 10, sh)
        t.rect(3, 12, 14, 12, w_); t.rect(7, 14, 6, 4, sh); t.rect(3, 22, 14, 2, bk)
        t.rect(0, 13, 3, 12, w_); t.rect(17, 13, 3, 12, w_); t.rect(0, 19, 3, 2, bk); t.rect(17, 19, 3, 2, bk)
        t.rect(4, 24, 5, 14, w_); t.rect(11, 24, 5, 14, w_); t.rect(4, 30, 5, 2, bk); t.rect(11, 30, 5, 2, bk)
        t.rect(3, 38, 7, 3, w_); t.rect(10, 38, 7, 3, w_)
        t.rect(18, 20, 8, 3, bk); t.rect(20, 23, 2, 3, bk)
    c.rect(20, 58, 30, 6, (40, 40, 52)); c.frame(20, 58, 30, 6, OUT)
    c.rect(18, 20, 34, 40, (255, 240, 200), 16)
    L.tall(64, lambda t: P.stamp(t, trooper, 23, 17, 26, 41))
    L.block(1, 3, 2, 3)

    def bdesk(c_, x, y, w):
        c_.rect(x + 4, y + 5, 9, 7, (236, 236, 240)); c_.frame(x + 4, y + 5, 9, 7, OUT2)
        c_.rect(x + w - 12, y + 4, 7, 8, (120, 40, 44)); c_.frame(x + w - 13, y + 3, 9, 10, OUT)
    desk_up(L, 'barney-boss', 13, 5, w=64, deco=bdesk, kind='monitor', top=(150, 190, 210), front=(60, 62, 80))
    seats = ['barney-1']
    desk_up(L, 'barney-1', 7, 5, w=44, top=(150, 190, 210), front=(60, 62, 80))

    # couch, middle of the room, facing the screen
    sofa(c, 80, 188, 112, (40, 38, 50), (70, 68, 88), (22, 22, 30))
    L.block(5, 12, 11, 13)
    tx_, ty_ = 92, 246
    c.box(tx_, ty_, 88, 14, 6, (150, 190, 210), (60, 62, 80))
    c.line(tx_ + 6, ty_ + 10, tx_ + 20, ty_ + 3, (236, 248, 255))
    P.bottle(c, tx_ + 78, ty_ + 1, col=(170, 120, 50))
    L.block(6, 15, 11, 16)
    for t_ in (6, 8, 10):
        cx = t_ * T + 8
        lid = [None]
        def lap(t, cx=cx, lid=lid):
            lid[0] = P.laptop_back(t, cx - 7, ty_ - 6)
        L.tall(ty_ + 14, lap)
        name = 'barney-%d' % (len(seats) + 1)
        L.seat(name, t_, 13, 'down', screen=lid[0], cup=(cx + 9, ty_ + 8), kind='lid', sit={'dx': 0, 'dy': 7, 'crop': 0})
        seats.append(name)
    # the screen along the bottom
    sx, sw, sy = 56, 196, 298
    c.rect(sx - 2, sy + 34, sw + 4, 8, (30, 30, 40)); c.frame(sx - 2, sy + 34, sw + 4, 8, OUT)
    c.rect(sx, sy, sw, 36, (16, 16, 24)); c.frame(sx, sy, sw, 36, OUT); c.frame(sx - 1, sy - 1, sw + 2, 38, STEEL)
    for yy in range(sy + 2, sy + 34):
        for xx in range(sx + 2, sx + sw - 2):
            c.px(xx, yy, (26 + (xx - sx) // 12, 40 + (yy - sy) * 2, 96 + (xx - sx) // 6))
    c.rect(sx + 2, sy + 22, sw - 4, 12, (30, 110, 60))
    for i in range(sx + 20, sx + sw - 10, 34):
        c.vline(i, sy + 22, 12, (220, 240, 220))
    c.text(sx + 6, sy + 4, 'LIVE', (255, 90, 80)); c.text(sx + sw - 30, sy + 4, '21-17', (250, 250, 252))
    c.rect(sx - 10, sy - 20, sw + 20, 20, (90, 150, 220), 14)
    L.block(3, 19, 15, 20)
    # the Bro Code on its lit pedestal, beside the screen
    px_ = 30
    c.rect(px_ - 4, 286, 26, 30, (255, 220, 130), 26)
    c.rect(px_ + 2, 306, 14, 20, (40, 40, 52)); c.frame(px_ + 2, 306, 14, 21, OUT); c.rect(px_, 304, 18, 4, STEEL); c.frame(px_, 304, 18, 4, OUT)
    c.rect(px_ + 2, 290, 14, 14, (120, 40, 44)); c.frame(px_ + 2, 290, 14, 14, OUT); c.frame(px_ + 4, 292, 10, 10, GOLD)
    c.text(px_ + 5, 294, 'BRO', GOLD)
    L.block(1, 19, 2, 20)

    # ── BEDROOM 1 (upper middle) ─────────────────────────────────────────────
    bed(c, 330, 44, 70, 84, (30, 30, 42), (236, 236, 240), n=1, fold=(120, 40, 44))
    L.block(20, 3, 24, 7)
    for nx in (312, 402):
        c.box(nx, 48, 14, 12, 6, (40, 40, 52), (26, 26, 36))
    L.tall(64, lambda t: P.table_lamp(t, 319, 57, 1))
    L.tall(64, lambda t: P.table_lamp(t, 409, 57, 1))
    L.block(19, 3); L.block(25, 3)
    c.rect(296, 10, 26, 18, (26, 28, 44)); c.frame(296, 10, 26, 18, OUT); c.text(300, 16, 'NO.1', GOLD)

    # ── THE SUIT ROOM (upper right) ──────────────────────────────────────────
    c.rect(432, 48, 106, 100, (86, 70, 62), 90)
    s = 'SUIT UP'
    c.rect(452, 8, 64, 16, (24, 30, 58)); c.frame(452, 8, 64, 16, GOLD); c.frame(451, 7, 66, 18, OUT)
    cx = 452 + (64 - text_w(s) * 2) // 2
    from px import FONT
    for ch in s:
        g = FONT.get(ch)
        if g is None:
            cx += 4; continue
        for r, row in enumerate(g):
            for i, bit in enumerate(row):
                if bit == '#':
                    c.rect(cx + i * 2, 11 + r * 2, 2, 2, (246, 214, 130))
        cx += (len(g[0]) + 1) * 2
    suits = [(60, 62, 78), (40, 52, 92), (150, 60, 70), (92, 76, 64), (30, 30, 40), (120, 124, 140), (58, 110, 80), (120, 70, 130), (190, 160, 80)]
    for row, ry in enumerate((58, 100)):
        c.rect(436, ry - 4, 80, 2, STEEL); c.frame(436, ry - 5, 80, 4, OUT)
        for i in range(6):
            sx_ = 440 + i * 12
            col = suits[(i + row * 4) % len(suits)]
            c.rect(sx_, ry, 10, 22, col); c.vline(sx_, ry, 22, lighten(col, 0.25)); c.vline(sx_ + 9, ry, 22, darken(col, 0.3))
            c.rect(sx_ + 4, ry, 2, 8, (238, 238, 236)); c.rect(sx_ + 4, ry + 2, 2, 8, ((158, 58, 72), (60, 100, 170), (226, 190, 110))[i % 3])
            c.frame(sx_, ry - 1, 10, 24, OUT)
    L.block(27, 3, 31, 4); L.block(27, 6, 31, 7)
    c.rect(528, 56, 8, 40, (150, 190, 210)); c.frame(528, 56, 8, 40, STEEL); c.line(530, 90, 534, 60, (236, 248, 255))   # full-length mirror
    c.rrect(522, 110, 12, 12, (120, 40, 44), 2); c.rframe(522, 110, 12, 12, OUT, 2)                                       # dressing stool

    # ── THE CORRIDOR and THE COLLECTION PASSAGE (middle band) ────────────────
    c.rect(288, 160, 250, 32, (74, 40, 52), 70)                                   # a long red runner
    c.frame(290, 162, 246, 28, (150, 110, 70))
    cases(c, 432, 148, 78, 13, 5)                                                 # shelving on the passage's upper wall
    cases(c, 464, 195, 68, 13, 9)                                                 # and its lower wall
    c.rect(420, 150, 10, 8, (24, 30, 58)); c.frame(420, 150, 10, 8, GOLD)

    # ── THE KITCHEN (lower middle) ───────────────────────────────────────────
    P.checker_floor(c, 294, 210, 106, 130, (70, 70, 86), (54, 54, 68), 8)
    kx = 384
    c.box(kx, 212, 16, 96, 0, STEEL, (110, 116, 134), r=0)
    c.rect(kx + 2, 218, 12, 22, (40, 40, 52)); c.frame(kx + 2, 218, 12, 22, OUT)
    for sy_ in (221, 227, 233):
        c.rect(kx + 5, sy_, 6, 3, (90, 90, 110))
    c.rrect(kx + 2, 250, 12, 20, (130, 138, 156), 1); c.rframe(kx + 2, 250, 12, 20, OUT, 1)
    c.rect(kx + 3, 280, 10, 10, (30, 30, 40)); c.frame(kx + 2, 279, 12, 12, OUT); c.px(kx + 7, 283, (255, 90, 80))
    L.block(24, 13, 24, 18)
    c.rect(kx - 8, 310, 24, 28, (220, 224, 232)); c.frame(kx - 8, 310, 24, 28, OUT); c.vline(kx + 3, 312, 24, (150, 156, 170))   # fridge
    L.block(23, 19, 24, 20)
    c.box(310, 244, 44, 30, 8, (40, 40, 52), (26, 26, 36))                        # island
    c.rrect(316, 250, 12, 6, (214, 120, 60), 2); c.rframe(316, 250, 12, 6, OUT, 2)
    L.block(19, 15, 21, 16)
    for sx_ in (20,):
        P.stool(c, sx_ * T + 2, 17 * T + 6, top=(60, 58, 74), leg=(120, 124, 140))
    c.rect(300, 200, 50, 8, (44, 44, 58)); c.frame(300, 200, 50, 8, OUT)          # wall cabinets under the corridor wall

    # ── BEDROOM 2 (lower right) ──────────────────────────────────────────────
    bed(c, 466, 226, 62, 84, (56, 70, 120), (236, 236, 240), n=2, fold=(150, 60, 70))
    L.block(29, 14, 32, 19)
    c.box(448, 232, 14, 12, 6, (40, 40, 52), (26, 26, 36))
    L.tall(248, lambda t: P.table_lamp(t, 455, 241, 0))
    L.block(28, 14)
    c.box(420, 300, 30, 12, 10, (40, 40, 52), (26, 26, 36))                       # dresser
    L.block(26, 19, 27, 19)

    L.extra['hq'] = {'boss': 'barney-boss', 'seats': seats, 'cast': ['barney', 'robin', 'james', 'ranjit', 'quinn']}
    L.extra['rooms'] = {'bedroom1': L.tile(19, 6), 'suit': L.tile(32, 5), 'passage': L.tile(30, 10),
                        'kitchen': L.tile(19, 14), 'bedroom2': L.tile(27, 16)}
