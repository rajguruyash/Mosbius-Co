"""The laser tag arena — Barney's other office.

Black floor with a glowing grid, neon-edged barriers for cover, a red base and
a blue base, the scoreboard, haze. Barney leads; the kids are his squad.
544x352 (34x22 tiles).
"""
from px import T, OUT, OUT2, lighten, darken, text_w
from world import hash2
import props as P

W, H = 34 * T, 22 * T
CYAN = (60, 230, 240)
PINK = (255, 80, 190)
LIME = (150, 255, 90)
DARK = (18, 16, 34)


def glow(c, x, y, w, h, col, a=26):
    c.rect(x - 3, y - 3, w + 6, h + 6, col, a // 2)
    c.rect(x - 1, y - 1, w + 2, h + 2, col, a)


def barrier(L, tx, ty, tw, th, col):
    """A block of cover with a neon edge; taller than it is deep."""
    c = L.bg
    x, y, w, h = tx * T, ty * T - 8, tw * T, th * T + 8
    glow(c, x, y, w, h, col)
    c.shadow(x + 2, y + h, w - 2, 3, a=80)
    c.rect(x, y, w, h, (40, 38, 66))
    c.rect(x, y, w, 9, (60, 58, 96))
    for i in range(x + 4, x + w - 3, 8):
        c.vline(i, y + 11, h - 13, (30, 28, 52))
    c.frame(x, y, w, h, col); c.hline(x, y + 9, w, col, 150)
    c.frame(x - 1, y - 1, w + 2, h + 2, OUT)
    L.block(tx, ty, tx + tw - 1, ty + th - 1)


def paint(L):
    c = L.bg
    c.rect(6, 48, W - 12, H - 60, DARK)
    for yy in range(48, H - 12, 16):                                     # the grid
        c.hline(6, yy, W - 12, (44, 40, 96))
    for xx in range(16, W - 6, 16):
        c.vline(xx, 48, H - 60, (44, 40, 96))
    for yy in range(48, H - 12, 16):
        for xx in range(16, W - 6, 16):
            c.px(xx, yy, (110, 100, 220))
    # haze
    for i in range(26):
        x = 20 + hash2(i, 1, 3) % (W - 80); y = 70 + hash2(i, 2, 3) % (H - 110)
        c.ellipse(x, y, 26 + hash2(i, 3, 3) % 20, 8, (120, 100, 220), 10)

    # back wall: black with UV strips and the scoreboard
    c.rect(6, 0, W - 12, 48, (26, 22, 46))
    for xx in range(10, W - 10, 40):
        c.rect(xx, 40, 28, 2, (150, 110, 255)); c.rect(xx - 2, 38, 32, 6, (150, 110, 255), 40)
    P.wall_trim(c, 6, 0, W - 12, wood=(40, 36, 70), ceil=(14, 12, 28))
    P.room_shell(c, W, H, wall_top=(56, 52, 96), door=(256, 288))
    L.block(0, 0, 33, 2)
    sx, sw = 190, 164
    glow(c, sx, 5, sw, 30, PINK, 40)
    c.rect(sx, 5, sw, 30, (12, 10, 24)); c.frame(sx, 5, sw, 30, PINK); c.frame(sx - 1, 4, sw + 2, 32, OUT)
    s = 'LASER TAG'
    c.text(sx + (sw - text_w(s)) // 2, 9, s, CYAN)
    c.text(sx + 10, 21, 'RED', (255, 90, 90)); c.text(sx + 30, 21, '1200', (255, 220, 220))
    c.text(sx + 96, 21, 'BLUE', (110, 170, 255)); c.text(sx + 120, 21, '3400', (220, 236, 255))
    c.text(sx + 60, 28, 'MVP: B. STINSON', LIME)
    # vest racks on the wall
    for (rx, col) in ((40, (255, 90, 90)), (454, (110, 170, 255))):
        c.rect(rx, 8, 50, 3, (120, 124, 140)); c.frame(rx, 7, 50, 5, OUT)
        for i in range(5):
            vx = rx + 3 + i * 9
            c.rect(vx, 12, 7, 12, (40, 40, 56)); c.rect(vx + 2, 15, 3, 4, col); c.frame(vx, 11, 7, 14, OUT)

    # ── the bases ────────────────────────────────────────────────────────────
    for (bx, by, col, name) in ((14, 136, (255, 90, 90), 'RED'), (474, 136, (110, 170, 255), 'BLUE')):
        glow(c, bx, by, 56, 72, col, 40)
        c.rect(bx, by, 56, 72, (30, 28, 52)); c.frame(bx, by, 56, 72, col); c.frame(bx + 4, by + 4, 48, 64, col)
        c.ring(bx + 28, by + 36, 16, 16, col, 2); c.ellipse(bx + 28, by + 36, 6, 6, col)
        c.text(bx + (56 - text_w(name)) // 2, by + 60, name, col)

    # ── cover ────────────────────────────────────────────────────────────────
    barrier(L, 8, 5, 3, 1, CYAN); barrier(L, 23, 5, 3, 1, PINK)
    barrier(L, 15, 7, 4, 1, LIME)
    barrier(L, 6, 10, 1, 3, PINK); barrier(L, 27, 10, 1, 3, CYAN)
    barrier(L, 11, 12, 3, 1, CYAN); barrier(L, 20, 12, 3, 1, PINK)
    barrier(L, 15, 15, 4, 1, LIME)
    barrier(L, 8, 17, 3, 1, PINK); barrier(L, 23, 17, 3, 1, CYAN)

    # posts: the captain's spot behind the centre barrier, then the squad's
    L.seat('lasertag-boss', 16, 16, 'up', kind='none', sit={'dx': 0, 'dy': 0, 'crop': 0})
    seats = []
    for (tx, ty, f) in ((9, 18, 'up'), (24, 18, 'up'), (12, 13, 'up'), (21, 13, 'up'), (17, 8, 'up'),
                        (5, 11, 'right'), (28, 11, 'left'), (9, 6, 'up'), (24, 6, 'up'), (2, 10, 'right'), (31, 10, 'left')):
        name = 'lasertag-%d' % (len(seats) + 1)
        L.seat(name, tx, ty, f, kind='none', sit={'dx': 0, 'dy': 0, 'crop': 0})
        seats.append(name)

    # entrance: a glowing arch
    glow(c, 250, 318, 44, 18, LIME, 30)
    c.frame(250, 318, 44, 18, LIME); c.text(258, 324, 'ENTER', LIME)
    L.spawn('entrance', 16, 20)
    L.free(16, 21, 17, 21)
    L.door(16, 21)
    L.extra['hq'] = {'boss': 'lasertag-boss', 'seats': seats, 'cast': ['barney', 'marshall'], 'crowd': 'kids'}
