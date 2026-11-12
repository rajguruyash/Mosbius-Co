"""Goliath National Bank — management and dashboards.

Cool corporate greys and navy: the conference room with the big screen (left),
the wall of boards under the GNB crest (centre), Barney's glass corner office
(right), and a floor of cubicles. Local pixels, 544x352 (34x22 tiles).
"""
from px import T, OUT, OUT2, lighten, darken, mix, text_w
from world import hash2
import props as P
from apartment import desk_up

W, H = 34 * T, 22 * T

CARPET = (88, 104, 130)
WALLC = (214, 218, 228)
NAVY = (36, 50, 92)
GOLD = (226, 190, 110)
GLASS = (170, 206, 226)
DESK = (206, 204, 200)
DESK_F = (150, 152, 166)
PART = (128, 138, 160)


def paint(L):
    c = L.bg
    P.carpet(c, 6, 48, W - 12, H - 60, CARPET, seed=7)
    for yy in range(48, H - 12, 16):
        c.hline(6, yy, W - 12, darken(CARPET, 0.07))
    for xx in range(16, W - 6, 16):
        c.vline(xx, 48, H - 60, darken(CARPET, 0.07))
    # marble lobby strip from the lifts
    for yy in range(288, 340):
        for xx in range(208, 336):
            t = ((xx - 208) // 16 + (yy - 288) // 16) % 2
            col = (226, 226, 232) if t else (200, 204, 216)
            if hash2(xx // 3, yy // 2, 4) % 17 == 0:
                col = darken(col, 0.08)
            c.px(xx, yy, col)
    c.frame(208, 288, 128, 52, (150, 156, 176))

    # ── back wall ────────────────────────────────────────────────────────────
    c.rect(6, 0, W - 12, 48, WALLC)
    for xx in range(6, W - 6, 34):
        c.vline(xx, 4, 40, darken(WALLC, 0.1))
    c.rect(6, 33, W - 12, 4, NAVY); c.hline(6, 33, W - 12, lighten(NAVY, 0.25))
    P.wall_trim(c, 6, 0, W - 12, wood=(120, 126, 146), ceil=(40, 44, 66))
    P.room_shell(c, W, H, wall_top=(196, 202, 216), door=(256, 288))

    crest(L)
    conference(L)
    barney(L)
    cubicles(L)
    lobby(L)

    L.block(0, 0, 33, 2)
    L.spawn('entrance', 16, 20)
    L.free(16, 21, 17, 21)
    L.door(16, 21)
    # the dashboards: where the scene pins the task boards, the calendar, the clock
    L.extra['anchors'] = {
        'boards': L.tile(13, 2), 'ask': L.tile(20, 2), 'calendar': L.tile(11, 1), 'clock': L.tile(23, 1),
        'pinStand': L.tile(15, 3), 'takeStand': L.tile(16, 3), 'archiveStand': L.tile(19, 3),
    }
    L.errand('water', (31, 20), 'right', (32, 20), 4.5)
    L.errand('water', (2, 20), 'left', (1, 20), 4.5)
    L.errand('dispenser', (31, 12), 'right', (32, 12), 3.5)
    L.errand('bin', (21, 20), 'left', (20, 20), 2.6)


def big_text(c, x, y, s, col, shadow):
    """3x5 caps drawn at double size."""
    from px import FONT
    cx = x
    for ch in s.upper():
        g = FONT.get(ch)
        if g is None:
            cx += 4
            continue
        for r, row in enumerate(g):
            for i, bit in enumerate(row):
                if bit == '#':
                    c.rect(cx + i * 2 + 1, y + r * 2 + 1, 2, 2, shadow)
        for r, row in enumerate(g):
            for i, bit in enumerate(row):
                if bit == '#':
                    c.rect(cx + i * 2, y + r * 2, 2, 2, col)
        cx += (len(g[0]) + 1) * 2


def crest(L):
    """The GNB crest, and the stretch of wall the live boards hang on."""
    c = L.bg
    c.rect(214, 4, 172, 26, (232, 236, 244)); c.frame(214, 4, 172, 26, (150, 156, 176))
    s = 'GOLIATH NATIONAL BANK'
    c.rect(246, 7, 108, 13, NAVY); c.frame(246, 7, 108, 13, GOLD); c.frame(245, 6, 110, 15, OUT)
    c.text(246 + (108 - text_w(s)) // 2, 11, s, (246, 214, 130))
    # wall clock (the scene makes it clickable)
    cx, cy = 23 * T + 8, 20
    c.ellipse(cx, cy, 8, 8, OUT); c.ellipse(cx, cy, 7, 7, (250, 250, 252))
    c.ring(cx, cy, 7, 7, NAVY, 1)
    c.line(cx, cy, cx, cy - 5, OUT); c.line(cx, cy, cx + 3, cy + 1, (200, 60, 56))
    for (dx, dy) in ((0, -6), (6, 0), (0, 6), (-6, 0)):
        c.px(cx + dx, cy + dy, NAVY)


def glass_wall(c, x, y0, y1, gap=None):
    """A glazed partition seen from above with a metal frame."""
    for yy in range(y0, y1):
        if gap and gap[0] <= yy < gap[1]:
            continue
        c.rect(x, yy, 4, 1, GLASS); c.px(x, yy, OUT); c.px(x + 3, yy, OUT); c.px(x + 1, yy, (236, 248, 255))
    for yy in range(y0, y1, 24):
        if not (gap and gap[0] <= yy < gap[1]):
            c.rect(x, yy, 4, 2, (120, 126, 146))
    c.hline(x, y0, 4, OUT); c.hline(x, y1 - 1, 4, OUT)
    if gap:
        c.hline(x, gap[0] - 1, 4, OUT); c.hline(x, gap[1], 4, OUT)


def conference(L):
    """Left: the conference room, its long table, and the big screen."""
    c = L.bg
    # the presentation screen: charts
    sx, sy, sw, sh = 34, 5, 104, 30
    c.rect(sx, sy, sw, sh, (40, 44, 66)); c.frame(sx, sy, sw, sh, OUT)
    c.rect(sx + 2, sy + 2, sw - 4, sh - 4, (22, 30, 60))
    for i, hh in enumerate((6, 10, 8, 14, 12, 18, 16, 21)):
        col = (90, 200, 160) if i % 2 else (90, 150, 240)
        c.rect(sx + 6 + i * 6, sy + sh - 4 - hh, 4, hh, col)
    pts = [(58, 20), (66, 16), (74, 18), (82, 11), (90, 13), (98, 7)]
    for a, b in zip(pts, pts[1:]):
        c.line(sx + a[0], sy + a[1], sx + b[0], sy + b[1], (250, 200, 90))
    c.text(sx + 58, sy + 22, 'Q4', (200, 210, 240))
    L.extra['screen'] = L.gpx(sx + 2, sy + 2)
    # table: rows 6-7
    x, y = 36, 92
    c.box(x, y, 104, 26, 7, (120, 80, 62), (84, 54, 50))
    c.hline(x + 6, y + 5, 40, (156, 108, 82)); c.hline(x + 50, y + 12, 30, (146, 100, 76))
    for px_ in (x + 18, x + 50, x + 82):
        c.rect(px_, y + 9, 8, 6, (236, 236, 240)); c.frame(px_, y + 9, 8, 6, OUT2)
    c.rect(x + 46, y + 2, 12, 5, (60, 62, 80)); c.frame(x + 45, y + 1, 14, 7, OUT)           # conference phone
    L.block(2, 6, 8, 7)
    for i, t_ in enumerate((3, 5, 7)):
        cx = t_ * T + 8
        P.chair_back_rear(c, cx - 6, 5 * T - 4, wood=(70, 76, 100))
        L.seat('conf-%d' % (i * 2 + 1), t_, 5, 'down', kind='none')
        P.chair_seat(c, cx - 6, 8 * T + 2, wood=(70, 76, 100))
        L.tall(8 * T + 22, lambda t, cx=cx: P.chair_back_front(t, cx - 6, 8 * T + 9, wood=(70, 76, 100)))
        L.seat('conf-%d' % (i * 2 + 2), t_, 8, 'up', kind='none')
    glass_wall(c, 164, 48, 160, gap=(96, 128))
    L.block(10, 3, 10, 5); L.block(10, 8, 10, 9)
    L.tall(64, lambda t: P.potted_plant(t, 150, 64, 1))
    L.block(9, 3)


def barney(L):
    """Right: Barney's glass corner office — big desk, the wall of screens,
    the motivational posters, the leather sofa."""
    c = L.bg
    glass_wall(c, 396, 48, 160, gap=(96, 128))
    L.block(24, 3, 24, 5); L.block(24, 8, 24, 9)
    # Barney's creed, framed in gold behind his desk
    bx, by, bw, bh = 404, 4, 92, 27
    c.rect(bx, by, bw, bh, (24, 30, 58)); c.frame(bx, by, bw, bh, GOLD); c.frame(bx - 1, by - 1, bw + 2, bh + 2, OUT)
    c.frame(bx + 2, by + 2, bw - 4, bh - 4, (120, 96, 50))
    big_text(c, bx + (bw - text_w('SUIT UP.') * 2) // 2, by + 5, 'SUIT UP.', (246, 214, 130), (12, 16, 36))
    s2 = 'GET THINGS DONE'
    c.text(bx + (bw - text_w(s2)) // 2, by + 18, s2, (250, 250, 252))
    # a tie on a hook, to the left of it — always a spare
    c.rect(398, 10, 3, 2, GOLD); c.rect(398, 12, 3, 12, (158, 58, 72)); c.px(399, 24, (158, 58, 72)); c.vline(398, 13, 10, (200, 96, 110))
    # wall of screens
    for i in range(2):
        for j in range(2):
            x, y = 500 + i * 17, 5 + j * 13
            c.rect(x, y, 16, 12, (30, 34, 56)); c.rect(x + 1, y + 1, 14, 10, ((60, 120, 200), (200, 80, 80), (80, 170, 130), (220, 180, 80))[i * 2 + j])
            c.frame(x, y, 16, 12, OUT); c.hline(x + 2, y + 3, 8, (255, 255, 255), 90)

    def deco(c_, x, y, w):
        c_.rect(x + 4, y + 6, 9, 6, (236, 236, 240)); c_.frame(x + 4, y + 6, 9, 6, OUT2)
        c_.rect(x + w - 12, y + 3, 7, 9, (60, 62, 80)); c_.frame(x + w - 13, y + 2, 9, 11, OUT)   # the Bro Code
        c_.hline(x + w - 11, y + 5, 5, GOLD)
    desk_up(L, 'pc-12', 29, 5, w=64, deco=deco, kind='monitor', top=(70, 60, 70), front=(44, 38, 50))
    # leather sofa on the right wall
    sx, sy = 510, 96
    c.shadow(sx + 2, sy + 60, 24, 3)
    c.rrect(sx, sy, 26, 60, (50, 46, 60), 2); c.rect(sx + 14, sy + 2, 10, 56, (74, 70, 90))
    c.rect(sx + 2, sy + 6, 12, 48, (88, 84, 106)); c.hline(sx + 2, sy + 30, 12, (50, 46, 60))
    c.rframe(sx, sy, 26, 60, OUT, 2)
    L.block(32, 6, 32, 9)


def cubicles(L):
    """Two rows of cubicles."""
    c = L.bg
    names = iter(['pc-13', 'pc-14', 'pc-15', 'pc-16', 'pc-17', 'pc-18', 'pc-19', 'pc-20'])
    for ty in (13, 18):
        for tx in (4, 10, 22, 28):
            cx = tx * T + 8
            dy = (ty - 1) * T - 6
            # back panel + side wings
            c.rect(cx - 27, dy - 9, 54, 9, PART); c.hline(cx - 26, dy - 8, 52, lighten(PART, 0.25))
            c.frame(cx - 27, dy - 9, 54, 10, OUT)
            for sx in (cx - 27, cx + 23):
                c.rect(sx, dy, 4, 30, PART); c.vline(sx + 1, dy, 30, lighten(PART, 0.25)); c.frame(sx, dy - 1, 4, 32, OUT)
            # pinned notes on the panel
            c.rect(cx - 20, dy - 7, 4, 4, (255, 240, 170)); c.rect(cx + 14, dy - 7, 5, 4, (180, 226, 170))

            def deco(c_, x, y, w, tx=tx, ty=ty):
                if (tx + ty) % 2:
                    c_.rect(x + 3, y + 7, 7, 5, (236, 236, 240)); c_.frame(x + 3, y + 7, 7, 5, OUT2)
                else:
                    P.mug(c_, x + 4, y + 8)
            desk_up(L, next(names), tx, ty, w=44, deco=deco, kind='monitor', top=DESK, front=DESK_F)
            L.block(tx - 2, ty - 1, tx + 1, ty - 1)


def lobby(L):
    """By the lifts: the mat, plants, the water cooler, the copier, a bin."""
    c = L.bg
    c.rect(248, 320, 48, 16, NAVY); c.frame(248, 320, 48, 16, GOLD)
    c.text(264, 325, 'GNB', (246, 214, 130))
    L.tall(340, lambda t: P.potted_plant(t, 24, 340, 0))
    L.block(1, 20)
    L.tall(340, lambda t: P.potted_plant(t, 520, 340, 2))
    L.block(32, 20)

    # water cooler (tile 32, row 12)
    def cooler(t):
        t.rect(2, 0, 8, 10, (150, 200, 240)); t.rect(3, 1, 2, 7, (210, 236, 252)); t.frame(1, -1 + 1, 10, 11, OUT)
        t.rect(0, 10, 12, 16, (226, 228, 236)); t.rect(1, 11, 10, 2, (250, 250, 252)); t.frame(0, 10, 12, 16, OUT)
        t.rect(3, 15, 2, 2, (80, 140, 220)); t.rect(7, 15, 2, 2, (220, 80, 70))
    L.tall(12 * T + 16, cooler, x=32 * T + 1, y=11 * T - 10)
    L.block(32, 12)
    # copier
    x, y = 184, 298
    c.box(x, y, 28, 16, 14, (226, 228, 236), (176, 180, 196))
    c.rect(x + 3, y + 3, 14, 9, (60, 62, 80)); c.rect(x + 20, y + 4, 5, 3, (120, 220, 160))
    c.rect(x + 4, y + 20, 20, 3, (250, 250, 252)); c.frame(x + 4, y + 20, 20, 3, OUT2)
    L.block(11, 18, 13, 19)
    P.trash_bin(c, 323, 324)
    L.block(20, 20)
