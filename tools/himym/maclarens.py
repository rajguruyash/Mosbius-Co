"""MacLaren's Pub — where agents meet, take breaks and talk.

The long bar with its back-bar of bottles, the taps, the gang's booth, a
second booth, high-tops, the pool table, the jukebox and the dart board.
Local pixels inside the 544x352 room (34x22 tiles).
"""
from px import T, OUT, OUT2, lighten, darken, mix, text_w
from world import hash2
import props as P

W, H = 34 * T, 22 * T

FLOOR = (118, 78, 60)
PANEL = (82, 52, 46)
PANEL_L = (110, 72, 58)
PANEL_D = (58, 38, 40)
WALLPAPER = (40, 62, 54)
BOOTH = (132, 50, 48)
BOOTH_L = (166, 70, 62)
BOOTH_D = (96, 36, 42)
BRASS = (226, 184, 96)
BAR_TOP = (128, 80, 56)


def wainscot(c, x, y, w, h):
    c.rect(x, y, w, h, PANEL)
    c.hline(x, y, w, PANEL_L); c.hline(x, y + 1, w, lighten(PANEL_L, 0.12)); c.hline(x, y + 2, w, PANEL_D)
    for px_ in range(x + 2, x + w - 12, 18):
        c.frame(px_, y + 5, 15, h - 10, PANEL_D)
        c.hline(px_ + 1, y + 6, 13, PANEL_L, 150); c.vline(px_ + 1, y + 6, h - 12, PANEL_L, 150)


def back_bar(L):
    """The wall behind the bar: sign, mirror, three shelves of bottles."""
    c = L.bg
    x0, x1 = 16, 266
    # cabinet body
    c.rect(x0, 4, x1 - x0, 44, (70, 44, 44))
    c.frame(x0, 4, x1 - x0, 44, OUT)
    c.hline(x0 + 1, 5, x1 - x0 - 2, PANEL_L)
    # carved sign
    sx, sw = 92, 98
    c.rect(sx, 5, sw, 11, (36, 70, 56)); c.frame(sx, 5, sw, 11, BRASS)
    c.frame(sx - 1, 4, sw + 2, 13, OUT)
    s = "MACLAREN'S"
    c.text(sx + (sw - text_w(s)) // 2, 8, s, (246, 214, 130), shadow=(20, 40, 32))
    for qx in (sx + 6, sx + sw - 9):                         # shamrocks
        c.px(qx, 9, (110, 196, 120)); c.px(qx + 2, 9, (110, 196, 120)); c.px(qx + 1, 8, (110, 196, 120)); c.px(qx + 1, 10, (110, 196, 120)); c.px(qx + 1, 11, (60, 120, 80))
    # mirror
    mx, mw = 118, 46
    c.rect(mx, 18, mw, 20, (150, 176, 196)); c.frame(mx, 18, mw, 20, BRASS); c.frame(mx - 1, 17, mw + 2, 22, OUT)
    for i in range(0, 14):
        c.px(mx + 6 + i, 34 - i, (220, 236, 246), 170); c.px(mx + 7 + i, 34 - i, (220, 236, 246), 90)
        c.px(mx + 24 + i, 34 - i, (220, 236, 246), 120)
    # bottle shelves either side of the mirror (+ a short row under the sign ends)
    for (bx, bw) in ((x0 + 4, mx - x0 - 8), (mx + mw + 4, x1 - mx - mw - 8)):
        for row, sy in enumerate((16, 27)):
            c.rect(bx, sy, bw, 10, (40, 28, 40))
            c.rect(bx, sy, bw, 10, (255, 196, 110), 26)       # warm back-light
            bottles(c, bx + 1, sy, bw - 2, 10, seed=row * 13 + bx)
            c.hline(bx - 1, sy + 10, bw + 2, PANEL_L); c.hline(bx - 1, sy + 11, bw + 2, PANEL_D)
    # low back counter with a register and stacked glasses
    c.rect(x0 + 1, 40, x1 - x0 - 2, 7, (112, 70, 54)); c.hline(x0 + 1, 40, x1 - x0 - 2, (160, 110, 76))
    c.rect(52, 33, 13, 8, (60, 62, 80)); c.frame(51, 32, 15, 10, OUT); c.rect(54, 35, 6, 2, (150, 220, 160))   # register
    for gx in range(200, 240, 5):
        c.rect(gx, 36, 3, 4, (210, 226, 236)); c.px(gx, 36, (255, 255, 255))
    # floor mat behind the bar
    c.rect(14, 48, 258, 26, (58, 46, 58))
    for yy in range(50, 74, 4):
        c.hline(16, yy, 254, (74, 60, 72))
    L.block(1, 3, 17, 4)
    L.extra['bartender'] = [L.tile(4, 4), L.tile(9, 4), L.tile(14, 4)]


def bottles(c, x, y, w, h, seed=1):
    cols = [(70, 120, 80), (150, 90, 50), (200, 170, 90), (60, 80, 130), (170, 60, 60), (220, 224, 230), (110, 70, 110)]
    xx = x
    k = 0
    while xx < x + w - 2:
        col = cols[hash2(k, 1, seed) % len(cols)]
        bh = 6 + hash2(k, 2, seed) % 3
        bw = 3
        top = y + h - bh
        c.rect(xx, top + 2, bw, bh - 2, col)
        c.px(xx + 1, top, col); c.px(xx + 1, top + 1, col)
        c.px(xx + 1, top - 1 if bh < 8 else top, (226, 200, 140))
        c.vline(xx, top + 2, bh - 2, lighten(col, 0.35))
        if hash2(k, 3, seed) % 2:
            c.hline(xx, top + 4, bw, (236, 226, 200))
        xx += bw + 1 + (hash2(k, 4, seed) % 2)
        k += 1


def bar_counter(L):
    """The bar: top at rows 4.6..5.6, panelled front, brass rail, taps, stools."""
    c = L.bg
    x0, x1, y = 12, 290, 74
    w = x1 - x0
    c.shadow(x0 + 2, y + 31, w - 2, 3)
    # L-return up to the wall at the right end
    c.rect(x1 - 20, 48, 20, 30, BAR_TOP); c.hline(x1 - 19, 49, 18, lighten(BAR_TOP, 0.2))
    c.vline(x1 - 2, 50, 26, darken(BAR_TOP, 0.14))
    c.frame(x1 - 20, 47, 20, 32, OUT)
    # top
    c.rrect(x0, y, w, 31, darken(PANEL, 0.1), 1)
    c.rect(x0 + 1, y + 1, w - 2, 15, BAR_TOP)
    c.hline(x0 + 2, y + 1, w - 4, lighten(BAR_TOP, 0.3))
    c.hline(x0 + 2, y + 2, w - 4, lighten(BAR_TOP, 0.12))
    for i in range(x0 + 20, x1 - 10, 37):                    # the polish catching the lights
        c.hline(i, y + 6, 9, lighten(BAR_TOP, 0.2)); c.hline(i + 3, y + 9, 5, lighten(BAR_TOP, 0.12))
    c.hline(x0 + 1, y + 15, w - 2, darken(BAR_TOP, 0.25))    # lip
    c.hline(x0 + 1, y + 16, w - 2, PANEL_L)
    # panelled front
    c.rect(x0 + 1, y + 17, w - 2, 13, PANEL)
    for px_ in range(x0 + 4, x1 - 20, 22):
        c.frame(px_, y + 19, 19, 8, PANEL_D); c.hline(px_ + 1, y + 20, 17, PANEL_L, 140)
    c.hline(x0 + 3, y + 28, w - 6, BRASS); c.hline(x0 + 3, y + 29, w - 6, darken(BRASS, 0.35))   # foot rail
    for px_ in range(x0 + 12, x1 - 6, 44):
        c.vline(px_, y + 26, 4, darken(BRASS, 0.2))
    c.rframe(x0, y, w, 31, OUT, 1)
    # join the return to the top
    c.rect(x1 - 19, y - 1, 18, 3, BAR_TOP)
    L.block(1, 5, 18, 5)

    # taps (tile 8 → x 128..144)
    tx = 124
    c.rect(tx, y - 2, 24, 5, (70, 70, 94)); c.frame(tx - 1, y - 3, 26, 7, OUT)
    c.hline(tx, y - 2, 24, (120, 124, 146))
    for i, col in enumerate(((220, 70, 60), (240, 200, 80), (80, 150, 100))):
        hx = tx + 3 + i * 7
        c.rect(hx + 1, y - 9, 2, 7, STEELC := (190, 196, 210)); c.frame(hx, y - 10, 4, 9, OUT)
        c.rect(hx, y - 15, 4, 6, col); c.px(hx + 1, y - 14, lighten(col, 0.4)); c.frame(hx - 1, y - 16, 6, 8, OUT)
    c.rect(tx + 2, y + 5, 20, 4, (60, 60, 80)); c.frame(tx + 1, y + 4, 22, 6, OUT)     # drip tray
    for i in range(tx + 4, tx + 20, 3):
        c.px(i, y + 6, (120, 124, 146))
    L.extra['taps'] = L.gpx(tx + 12, y - 4)

    # the glass rack (clean mugs) lives at tile 4; bus tub / sink at tile 12
    c.rect(60, y + 3, 24, 10, (86, 60, 56)); c.frame(60, y + 3, 24, 10, OUT); c.hline(61, y + 4, 22, (120, 84, 70))
    c.rrect(188, y + 3, 24, 10, (150, 158, 172), 1); c.rect(190, y + 5, 20, 6, (96, 110, 132)); c.rframe(188, y + 3, 24, 10, OUT, 1)
    c.rect(199, y - 2, 2, 6, (200, 206, 216)); c.rect(199, y - 2, 5, 2, (200, 206, 216)); c.frame(198, y - 3, 7, 4, OUT)

    # on the counter: peanuts, coasters, a pint, napkins
    c.rrect(100, y + 5, 10, 6, (190, 132, 84), 2); c.rframe(100, y + 5, 10, 6, OUT, 2)
    for (qx, qy) in ((102, y + 6), (105, y + 7), (107, y + 6)):
        c.px(qx, qy, (236, 210, 160))
    pint(c, 162, y + 2); pint(c, 236, y + 3)
    c.rect(222, y + 8, 6, 4, (236, 226, 200)); c.frame(222, y + 8, 6, 4, OUT2)
    c.rect(32, y + 6, 6, 5, (250, 246, 238)); c.frame(31, y + 5, 8, 7, OUT)
    c.rect(256, y + 6, 5, 5, (214, 168, 84)); c.frame(256, y + 6, 5, 5, OUT2)

    # a green banker's lamp
    c.rect(44, y - 3, 12, 4, (60, 150, 100)); c.hline(45, y - 3, 10, (130, 210, 160)); c.frame(43, y - 4, 14, 6, OUT)
    c.vline(50, y + 2, 5, BRASS); c.rect(46, y + 7, 9, 2, BRASS); c.rect(46, y + 1, 9, 1, (255, 240, 170))
    # stools along the front (row 6); tiles 4,6,7,8,9,12,13 stay clear for the stands
    for t_ in (2, 3, 5, 10, 11, 14, 15, 16):
        L.tall(6 * T + 15, lambda t, t_=t_: P.stool(t, t_ * T + 2, 6 * T + 3, top=(150, 100, 70), leg=(60, 44, 46)))
        L.block(t_, 6)


def pint(c, x, y, full=True):
    c.rect(x, y, 5, 8, (236, 190, 70) if full else (210, 226, 236))
    c.rect(x, y, 5, 2, (252, 250, 244))
    c.vline(x, y + 2, 6, (255, 226, 130) if full else (240, 248, 252))
    c.frame(x - 1, y - 1, 7, 10, OUT)
    c.rect(x + 6, y + 2, 1, 4, OUT)


def bench_back(c, x, y, w, h, front=False):
    c.rrect(x, y, w, h, BOOTH, 2)
    c.rect(x + 2, y + 1, w - 4, 3, BOOTH_L); c.hline(x + 3, y + 1, w - 6, lighten(BOOTH_L, 0.2))
    c.rect(x + 1, y + h - 3, w - 2, 2, BOOTH_D)
    for sx in range(x + 9, x + w - 4, 9):                    # tufting
        c.px(sx, y + h // 2, BOOTH_D); c.px(sx, y + h // 2 + 1, lighten(BOOTH_L, 0.1))
    c.rframe(x, y, w, h, OUT, 2)


def paint(L):
    c = L.bg
    P.wood_floor(c, 6, 48, W - 12, H - 60, base=(78, 50, 44), seed=31, length=56)

    # ── back wall: deep muted green over dark wood panelling ─────────────────
    c.rect(6, 0, W - 12, 48, WALLPAPER)
    for yy in range(4, 26):
        for xx in range(6, W - 6):
            if (xx + yy * 3) % 12 == 0 and yy % 6 == 2:
                c.px(xx, yy, lighten(WALLPAPER, 0.12))
            elif (xx + yy * 3) % 12 == 6 and yy % 6 == 5:
                c.px(xx, yy, darken(WALLPAPER, 0.14))
    wainscot(c, 6, 26, W - 12, 22)
    P.wall_trim(c, 6, 0, W - 12, wood=PANEL_D)
    P.room_shell(c, W, H, wall_top=(84, 56, 52), door=(256, 288))

    back_bar(L)
    bar_counter(L)
    front_wall(L)
    pool_table(L)
    # the gang's booth: the centrepiece, just off the bar
    booth(L, 13, 9, 4, ['cafe-seat-%d' % i for i in range(1, 9)], hero=True)
    # a run of two smaller booths, back to back, along the left wall
    booth(L, 1, 9, 2, ['cafe-seat-%d' % i for i in range(9, 13)])
    booth(L, 1, 14, 2, ['cafe-seat-%d' % i for i in range(13, 17)], joined=True)
    for (tx, ty) in ((22, 10), (27, 12), (23, 16), (30, 17), (9, 16)):
        two_top(L, tx, ty)
    entry(L)
    lights(L)

    # ── map data ─────────────────────────────────────────────────────────────
    L.block(0, 0, 33, 2)
    L.spawn('entrance', 16, 20)
    L.free(16, 21, 17, 21)
    L.door(16, 21)
    L.zone('cafeteria', 1, 6, 32, 15)
    L.spawn('cafe-stand-coffee', 7, 6)
    L.spawn('cafe-stand-vending', 20, 4)
    L.extra['coffee'] = {
        'trayTile': L.tile(4, 5), 'trayStand': L.tile(4, 6),
        'machineStand': L.tile(8, 6),
        'sinkTile': L.tile(12, 5), 'sinkStand': L.tile(12, 6),
        'maxCups': 5,
    }
    L.errand('water', (6, 20), 'left', (5, 20), 4.5)
    L.errand('bin', (21, 20), 'left', (20, 20), 2.6)


def booth(L, tx, ty, n, names, hero=False, joined=False):
    """A red leather booth: bench (faces down) / dark wooden table / bench
    (faces up), `n` seats wide. `tx` = leftmost seat tile, `ty` = the row of
    the top bench's back. Seats sit in rows ty+1 and ty+3, paired across the
    table. `joined` shares its top back with the booth above it."""
    c = L.bg
    x = tx * T - 6
    w = n * T + 12
    y = ty * T
    table, table_d = (112, 70, 56), (72, 44, 44)
    # wooden end panels
    for dx in (x - 6,):                                           # closed at the wall end, open at the aisle
        c.rect(dx, y - 6, 6, 5 * T + 8, PANEL); c.vline(dx + 1, y - 5, 5 * T + 6, PANEL_L)
        c.frame(dx, y - 6, 6, 5 * T + 8, OUT)
        c.rect(dx, y + 5 * T - 2, 6, 4, PANEL_D)
        c.rect(dx - 1, y - 8, 8, 3, PANEL_L); c.frame(dx - 1, y - 8, 8, 3, OUT)          # post cap
    c.shadow(x, y + 5 * T + 2, w, 2)
    # top bench: back (seen from above) + seat
    if not joined:
        bench_back(c, x, y - 4, w, 14)
    else:
        c.rect(x, y - 2, w, 12, BOOTH); c.hline(x, y - 2, w, BOOTH_D); c.rect(x, y, w, 3, PANEL_L); c.hline(x, y + 3, w, OUT)
    c.rect(x, y + 10, w, 20, BOOTH_L); c.hline(x, y + 10, w, BOOTH_D)
    c.hline(x + 1, y + 11, w - 2, lighten(BOOTH_L, 0.14))
    for i in range(1, n):
        c.vline(x + 6 + i * T, y + 11, 19, BOOTH_D)
    c.frame(x, y + 10, w, 21, OUT)
    # the dark wooden table
    ty_ = y + 2 * T + 1
    c.box(x + 3, ty_, w - 6, 18, 5, table, table_d)
    for i in range(x + 10, x + w - 14, 23):
        c.hline(i, ty_ + 5, 9, lighten(table, 0.16)); c.hline(i + 5, ty_ + 11, 6, lighten(table, 0.1))
    # bottom bench seat
    by = y + 3 * T + 6
    c.rect(x, by, w, 14, BOOTH_L); c.hline(x + 1, by + 1, w - 2, lighten(BOOTH_L, 0.14))
    for i in range(1, n):
        c.vline(x + 6 + i * T, by + 1, 13, BOOTH_D)
    c.frame(x, by, w, 15, OUT)
    # bottom bench back — in front of the sitters, so it is y-sorted
    L.tall((ty + 4) * T + 14, lambda t: bench_back(t, x, (ty + 4) * T + 2, w, 13))
    # on the table
    pint(c, x + 10, ty_ + 3); pint(c, x + w - 18, ty_ + 7)
    if n > 2:
        pint(c, x + w // 2 + 8, ty_ + 2, full=False); pint(c, x + 30, ty_ + 8)
        bx = x + w // 2 - 12
        c.rrect(bx, ty_ + 6, 11, 7, (190, 70, 60), 2); c.rframe(bx, ty_ + 6, 11, 7, OUT, 2)      # basket of fries
        for (qx, qh) in ((bx + 2, 4), (bx + 4, 5), (bx + 6, 3), (bx + 8, 5)):
            c.vline(qx, ty_ + 9 - qh, qh, (246, 206, 96))
        c.rect(x + w - 30, ty_ + 3, 4, 6, (236, 226, 200)); c.frame(x + w - 31, ty_ + 2, 6, 8, OUT)   # napkins
    if hero:
        c.rect(x - 5, y + 22, 4, 8, BRASS); c.frame(x - 6, y + 21, 6, 10, OUT)
        # the chair pulled up to the open end, for whoever arrives fifth
        cx = x + w + 10
        P.chair_seat(c, cx, ty_ + 4, wood=(120, 76, 58))
        c.rrect(cx + 9, ty_ + 2, 5, 13, (120, 76, 58), 1); c.rframe(cx + 9, ty_ + 2, 5, 13, OUT, 1)
        L.block(tx + n + 1, ty + 2)
    L.block(tx - 1, ty, tx + n - 1, ty + 4)
    L.block(tx + n, ty); L.block(tx + n, ty + 4)
    for i in range(n):
        L.seat(names[i * 2], tx + i, ty + 1, 'down', kind='none')
        L.seat(names[i * 2 + 1], tx + i, ty + 3, 'up', kind='none')
    L.extra.setdefault('booths', []).append(L.gpx(x + w // 2, ty_ + 8))


def two_top(L, tx, ty):
    """A small square wooden table with a chair either side."""
    c = L.bg
    x, y = tx * T - 2, ty * T - 3
    c.box(x, y, 20, 14, 6, (128, 82, 60), (88, 56, 48))
    c.rect(x + 8, y + 20, 4, 3, (60, 44, 46))
    c.hline(x + 4, y + 4, 8, lighten((128, 82, 60), 0.2))
    if (tx + ty) % 2:
        pint(c, x + 4, y + 2); pint(c, x + 12, y + 5, full=False)
    else:
        pint(c, x + 11, y + 3)
        c.rect(x + 3, y + 6, 4, 4, (250, 246, 238)); c.frame(x + 2, y + 5, 6, 6, OUT2)   # a candle
        c.px(x + 4, y + 7, (255, 200, 80))
    P.chair_back_rear(c, tx * T + 2, (ty - 1) * T - 2, wood=(120, 76, 58))
    P.chair_seat(c, tx * T + 2, (ty + 1) * T + 4, wood=(120, 76, 58))
    L.tall((ty + 2) * T + 8, lambda t: P.chair_back_front(t, tx * T + 2, (ty + 1) * T + 10, wood=(120, 76, 58)))
    L.block(tx, ty - 1, tx, ty + 1)


def pool_table(L):
    c = L.bg
    x, y, w, h = 376, 68, 92, 50
    c.shadow(x + 2, y + h + 6, w - 2, 3)
    c.rrect(x, y, w, h + 6, (70, 44, 44), 2)
    c.rrect(x, y, w, h, (108, 66, 52), 2)
    c.hline(x + 3, y + 1, w - 6, (150, 98, 72))
    c.rect(x + 5, y + 5, w - 10, h - 10, (40, 112, 84))
    c.rect(x + 5, y + 5, w - 10, 2, (62, 140, 104))
    c.frame(x + 4, y + 4, w - 8, h - 8, (26, 74, 60))
    for (px_, py_) in ((x + 5, y + 5), (x + w // 2, y + 4), (x + w - 7, y + 5), (x + 5, y + h - 7), (x + w // 2, y + h - 6), (x + w - 7, y + h - 7)):
        c.rect(px_, py_, 2, 2, (20, 20, 30))
    balls = [((226, 200, 60), 22, 14), ((200, 60, 56), 30, 22), ((60, 90, 180), 40, 12), ((250, 246, 238), 62, 24),
             ((40, 36, 50), 34, 30), ((230, 120, 50), 48, 20), ((110, 60, 130), 26, 30)]
    for (col, bx, by) in balls:
        c.rect(x + bx, y + by, 3, 3, col); c.px(x + bx, y + by, lighten(col, 0.5)); c.px(x + bx + 2, y + by + 2, darken(col, 0.3))
    c.line(x + 58, y + 36, x + 84, y + 26, (226, 196, 140)); c.line(x + 58, y + 37, x + 84, y + 27, (150, 104, 72))
    c.rframe(x, y, w, h, OUT, 2); c.rframe(x, y, w, h + 6, OUT, 2)
    for lx in (x + 3, x + w - 7):
        c.rect(lx, y + h + 6, 4, 4, (60, 40, 42)); c.frame(lx - 1, y + h + 5, 6, 6, OUT)
    L.block(23, 4, 29, 7)
    L.extra['pool'] = L.gpx(x + w // 2, y + h // 2)


def pub_window(c, x, y, w, h):
    frame = (72, 44, 44)
    c.rect(x, y, w, h, frame); c.frame(x, y, w, h, OUT); c.hline(x + 1, y + 1, w - 2, PANEL_L)
    ix, iy, iw, ih = x + 3, y + 3, w - 6, h - 6
    for yy in range(ih):
        c.hline(ix, iy + yy, iw, mix((30, 38, 66), (58, 60, 96), yy / float(ih)))
    # the street outside, seen from below the pavement: lamplight and passing legs
    c.rect(ix, iy + ih - 7, iw, 7, (44, 40, 60))
    for k in range(4):
        lx = ix + 6 + (hash2(k, 3, x) % (iw - 12))
        c.rect(lx, iy + ih - 9, 2, 9, (24, 22, 36)); c.rect(lx + 3, iy + ih - 8, 2, 8, (24, 22, 36))
    c.ellipse(ix + iw // 4, iy + 4, 5, 3, (255, 214, 130), 70)
    for mx in range(ix + iw // 4, ix + iw, iw // 4):
        c.vline(mx, iy, ih, frame)
    c.hline(ix, iy + 9, iw, frame)
    c.frame(ix - 1, iy - 1, iw + 2, ih + 2, OUT)


def neon(c, x, y, kind):
    if kind == 'shamrock':
        g, gl = (90, 240, 130), (190, 255, 210)
        for (dx, dy) in ((0, -3), (-3, 0), (3, 0)):
            c.ring(x + dx, y + dy, 3, 3, g, 1)
        c.vline(x, y + 2, 5, g); c.px(x + 1, y + 6, g)
        c.px(x, y - 3, gl); c.px(x - 3, y, gl); c.px(x + 3, y, gl)
        c.ellipse(x, y, 10, 9, g, 22)
    elif kind == 'beer':
        p, b = (255, 110, 150), (120, 220, 255)
        c.frame(x - 13, y - 6, 27, 13, p)
        c.text(x - 8, y - 2, 'BEER', b)
        c.rect(x - 15, y - 8, 31, 17, p, 20)
    else:
        r = (255, 90, 80)
        c.text(x - 8, y - 2, 'OPEN', r)
        c.frame(x - 11, y - 5, 23, 11, (255, 190, 90))
        c.rect(x - 13, y - 7, 27, 15, r, 20)


def front_wall(L):
    """Right of the bar: the brick pier with the dart board, the jukebox, and
    the pub's front windows with their neon — the street is up there."""
    c = L.bg
    P.brick_wall(c, 292, 4, 12, 40, base=(128, 66, 56), mortar=(84, 44, 46), seed=17)
    c.vline(291, 4, 40, OUT); c.vline(304, 4, 40, OUT)

    # the jukebox (tiles 19-21, row 3)
    jx, jy = 308, 14
    c.shadow(jx + 2, jy + 48, 30, 3)
    c.rrect(jx, jy, 32, 48, (120, 52, 50), 6)
    c.rrect(jx + 3, jy + 3, 26, 22, (250, 210, 110), 5)
    c.rrect(jx + 6, jy + 6, 20, 16, (60, 44, 80), 4)
    for i, col in enumerate(((240, 90, 90), (250, 200, 90), (120, 210, 150), (110, 170, 250))):
        c.vline(jx + 8 + i * 5, jy + 8, 12, col); c.vline(jx + 9 + i * 5, jy + 8, 12, lighten(col, 0.3))
    c.rect(jx + 4, jy + 27, 24, 6, (236, 226, 200)); c.frame(jx + 4, jy + 27, 24, 6, OUT)
    for i in range(jx + 6, jx + 27, 3):
        c.vline(i, jy + 28, 4, (120, 110, 100))
    c.rect(jx + 5, jy + 35, 22, 10, (84, 36, 40))
    for i in range(jx + 7, jx + 26, 3):
        c.vline(i, jy + 36, 8, (190, 150, 90))
    c.rframe(jx, jy, 32, 48, OUT, 6)
    c.vline(jx + 1, jy + 8, 34, (250, 150, 110)); c.vline(jx + 30, jy + 8, 34, (70, 30, 40))
    L.block(19, 3, 21, 3)
    L.extra['jukebox'] = L.gpx(jx + 16, jy + 14)

    # front windows + neon
    pub_window(c, 350, 4, 84, 38); neon(c, 372, 22, 'shamrock'); neon(c, 408, 20, 'beer')
    pub_window(c, 446, 4, 84, 38); neon(c, 470, 20, 'open'); neon(c, 510, 22, 'shamrock')
    # framed photos + a vintage poster on the pier between the windows and by the jukebox
    for (fx, fy, fw, fh, col) in ((436, 8, 9, 12, (190, 170, 140)), (436, 24, 9, 10, (150, 170, 190)), (342, 8, 7, 10, (214, 168, 84))):
        c.rect(fx, fy, fw, fh, (70, 46, 46)); c.rect(fx + 1, fy + 1, fw - 2, fh - 2, col); c.frame(fx, fy, fw, fh, OUT)
        c.px(fx + 3, fy + fh - 4, darken(col, 0.4))
    # dart board on the far right, beside the window
    dx, dy = 534, 18
    c.ellipse(dx - 2, dy, 5, 9, (30, 28, 40))
    for r_, col in ((8, (226, 216, 196)), (6, (190, 60, 56)), (4, (70, 140, 96)), (2, (226, 216, 196))):
        c.ring(dx - 2, dy, max(r_ // 2, 1), r_, col, 1)


def entry(L):
    c = L.bg
    for i in range(3):                                           # steps up to the street
        c.rect(258 + i * 2, 342 + i * 3, 28 - i * 4, 3, (150 - i * 20, 140 - i * 20, 150 - i * 18))
    c.rect(254, 322, 36, 14, (60, 84, 70)); c.frame(254, 322, 36, 14, (36, 54, 48)); c.frame(256, 324, 32, 10, (100, 140, 110))
    L.tall(340, lambda t: P.potted_plant(t, 88, 340, 2))
    L.block(5, 20)
    P.trash_bin(c, 323, 324)
    L.block(20, 20)
    # coat stand by the door
    def stand(t):
        t.vline(6, 4, 30, (70, 46, 46)); t.vline(7, 4, 30, (110, 72, 54))
        t.hline(2, 34, 10, (70, 46, 46))
        t.line(6, 5, 2, 7, (70, 46, 46)); t.line(7, 5, 11, 7, (70, 46, 46))
        t.rect(8, 8, 5, 14, (40, 40, 56)); t.vline(8, 9, 12, (70, 70, 94))
        t.rect(1, 8, 5, 12, (120, 96, 60)); t.vline(1, 9, 10, (160, 130, 84))
    L.tall(338, lambda t: P.stamp(t, stand, 298, 300, 14, 37))
    L.block(18, 20)


def lights(L):
    """Warm amber pools under low-hanging pendants; the room itself stays dim."""
    c = L.bg
    c.rect(6, 48, W - 12, H - 60, (20, 10, 26), 22)              # dim the room a touch
    for r_, a in ((70, 14), (54, 16), (38, 18)):                  # the gang's booth gets the warmest light
        c.ellipse(240, 192, r_, int(r_ * 0.6), (255, 200, 120), a)
    spots = [(218, 194), (262, 194), (40, 190), (40, 270), (360, 164), (440, 196), (376, 260), (488, 276), (152, 260),
             (80, 118), (200, 118), (422, 96)]
    for (lx, ly) in spots:
        for r_, a in ((46, 16), (36, 18), (26, 20), (16, 24)):
            c.ellipse(lx, ly, r_, int(r_ * 0.62), (255, 176, 90), max(a - 5, 6))
    for (lx, ly) in spots[:9]:
        def lamp(t, lx=lx, ly=ly):
            t.vline(lx, ly - 84, 30, (30, 22, 34))
            t.rrect(lx - 7, ly - 56, 15, 8, (44, 100, 76), 3)
            t.hline(lx - 4, ly - 55, 8, (104, 170, 130))
            t.rect(lx - 5, ly - 49, 11, 2, (255, 232, 160))
            t.rframe(lx - 7, ly - 56, 15, 8, OUT, 3)
        L.tall(H + 100, lamp)
    # the long lamp over the pool table
    def pool_lamp(t):
        t.vline(400, 30, 20, (30, 22, 34)); t.vline(444, 30, 20, (30, 22, 34))
        t.rrect(390, 50, 64, 8, (44, 100, 76), 2); t.hline(394, 51, 56, (104, 170, 130))
        t.rect(393, 57, 58, 2, (255, 232, 160)); t.rframe(390, 50, 64, 8, OUT, 2)
    L.tall(H + 100, pool_lamp)
