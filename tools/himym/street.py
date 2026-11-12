"""The establishing shot: West 85th Street at night, MacLaren's down the steps
below the pavement, the apartment building's stoop beside it. Shown for a beat
whenever the view cuts to the pub. A front elevation, 544x352."""
from px import Canvas, OUT, lighten, darken, mix, text_w
from world import hash2
import props as P

W, H = 544, 352


def window(c, x, y, w, h, lit, seed):
    c.rect(x - 2, y - 2, w + 4, h + 4, (126, 128, 140)); c.frame(x - 2, y - 2, w + 4, h + 4, OUT)
    col = (255, 214, 130) if lit else (34, 36, 62)
    c.rect(x, y, w, h, col)
    if lit:
        c.rect(x, y, w, h // 3, (250, 190, 110))
        if seed % 3 == 0:
            c.rect(x + w // 2 - 2, y + h - 9, 5, 9, (60, 44, 60)); c.rect(x + w // 2 - 1, y + h - 13, 3, 4, (60, 44, 60))
    else:
        c.line(x + 2, y + h - 3, x + w - 3, y + 2, (60, 64, 100))
    c.vline(x + w // 2, y, h, (126, 128, 140)); c.hline(x, y + h // 2, w, (126, 128, 140))
    c.rect(x - 4, y + h + 2, w + 8, 3, (170, 160, 156)); c.frame(x - 4, y + h + 2, w + 8, 3, OUT)


def paint():
    c = Canvas(W, H)
    # sky sliver + the brownstone
    for yy in range(0, 20):
        c.hline(0, yy, W, mix((16, 18, 46), (40, 36, 84), yy / 20.0))
    for i in range(30):
        c.px(hash2(i, 1, 9) % W, hash2(i, 2, 9) % 14, (255, 255, 240), 160)
    P.brick_wall(c, 0, 14, W, 226, base=(98, 100, 112), mortar=(66, 68, 80), seed=3)
    c.rect(0, 10, W, 6, (170, 160, 156)); c.frame(-1, 10, W + 2, 6, OUT)                     # cornice
    for yy in range(14, 240):                                                                # night falls down the wall
        c.hline(0, yy, W, (14, 16, 30), 60 - min(44, (yy - 14) // 4))
    for row, wy in enumerate((30, 86)):
        for i, wx in enumerate(range(24, W - 30, 62)):
            window(c, wx, wy, 30, 36, hash2(i, row, 5) % 5 < 3, hash2(i, row, 7))
    # the fire escape down the middle
    iron = (22, 20, 32)
    for fy in (74, 130):
        c.rect(200, fy, 150, 3, iron)
        for fx in range(200, 351, 6):
            c.vline(fx, fy - 14, 14, iron)
        c.hline(200, fy - 14, 150, iron)
    c.line(214, 74, 330, 130, iron); c.line(216, 74, 332, 130, iron)
    c.vline(338, 20, 54, iron); c.vline(346, 20, 54, iron)
    for ly in range(22, 74, 5):
        c.hline(338, ly, 9, iron)

    # ── ground floor ─────────────────────────────────────────────────────────
    c.rect(0, 142, W, 6, (170, 160, 156)); c.frame(-1, 142, W + 2, 6, OUT)
    # MacLaren's: the green awning, the sign, the windows with neon
    c.rect(26, 150, 250, 22, (30, 78, 60)); c.frame(26, 150, 250, 22, OUT)
    for sx in range(26, 276, 14):
        c.vline(sx, 151, 20, (22, 60, 48))
    for sx in range(26, 276, 10):
        c.rect(sx, 172, 9, 4, (30, 78, 60)); c.frame(sx, 171, 10, 6, OUT)
    s = "MACLAREN'S PUB"
    tx = 26 + (250 - text_w(s) * 2) // 2
    cx = tx
    from px import FONT
    for ch in s:
        g = FONT.get(ch)
        if g is None:
            cx += 4; continue
        for r, row in enumerate(g):
            for i, bit in enumerate(row):
                if bit == '#':
                    c.rect(cx + i * 2, 156 + r * 2, 2, 2, (246, 214, 130))
        cx += (len(g[0]) + 1) * 2
    c.rect(26, 178, 250, 62, (52, 52, 62)); c.frame(26, 178, 250, 62, OUT)                   # the frontage, below the pavement line
    for (wx, ww) in ((36, 96), (176, 90)):
        c.rect(wx, 184, ww, 44, (255, 196, 110)); c.rect(wx, 184, ww, 14, (236, 160, 90))
        for mx in range(wx + ww // 4, wx + ww, ww // 4):
            c.vline(mx, 184, 44, (52, 52, 62))
        c.frame(wx, 184, ww, 44, OUT)
        for k in range(3):                                                                    # silhouettes at the bar
            px_ = wx + 14 + k * (ww // 3)
            c.rect(px_, 208, 9, 20, (70, 44, 52)); c.ellipse(px_ + 4, 204, 4, 4, (70, 44, 52))
    g_, pk = (90, 240, 130), (255, 110, 150)
    for (dx, dy) in ((0, -3), (-3, 0), (3, 0)):
        c.ring(60 + dx, 198 + dy, 3, 3, g_, 1)
    c.vline(60, 200, 5, g_); c.ellipse(60, 198, 11, 10, g_, 26)
    c.frame(196, 190, 30, 13, pk); c.text(202, 194, 'BEER', (130, 240, 250)); c.rect(194, 188, 34, 17, pk, 22)
    # the door at the foot of the steps
    c.rect(138, 186, 30, 54, (40, 84, 64)); c.frame(138, 186, 30, 54, OUT)
    c.rect(142, 190, 22, 22, (255, 214, 130)); c.frame(142, 190, 22, 22, OUT); c.rect(162, 216, 3, 4, (226, 190, 110))
    c.ellipse(153, 244, 30, 8, (255, 200, 120), 40)

    # the apartment building's stoop, right
    c.rect(398, 150, 60, 90, (126, 128, 140)); c.frame(398, 150, 60, 90, OUT)
    c.rect(408, 162, 40, 78, (60, 44, 60)); c.frame(408, 162, 40, 78, OUT)
    c.rect(412, 166, 32, 30, (255, 214, 130), 200); c.frame(412, 166, 32, 30, OUT); c.vline(428, 166, 74, OUT)
    c.rect(418, 153, 20, 8, (226, 190, 110)); c.frame(418, 153, 20, 8, OUT); c.text(423, 155, '150', (60, 44, 40))
    for i in range(5):
        c.rect(390 - i * 3, 240 - (5 - i) * 0 + i * 0 + 0, 0, 0, OUT)
    for i in range(4):
        c.rect(392 - i * 4, 222 + i * 6, 72 + i * 8, 6, (150, 142, 144)); c.frame(392 - i * 4, 222 + i * 6, 72 + i * 8, 6, OUT)
    for rx in (388, 468):
        c.vline(rx, 206, 40, iron); c.vline(rx + 1, 206, 40, (70, 70, 94))
    window(c, 480, 176, 40, 44, True, 3)

    # ── the pavement and the steps down to the pub ───────────────────────────
    c.rect(0, 240, W, 26, (128, 126, 138))
    for sx in range(0, W, 34):
        c.vline(sx, 240, 26, (104, 102, 116))
    c.hline(0, 240, W, OUT); c.hline(0, 241, W, (160, 158, 170))
    c.rect(0, 266, W, 4, (90, 88, 102)); c.hline(0, 266, W, OUT)
    # the stairwell cut into the pavement, in front of the door
    c.rect(112, 240, 82, 22, (36, 30, 44)); c.frame(112, 240, 82, 22, OUT)
    for i in range(5):
        c.rect(114 + i * 8, 242 + i * 4, 78 - i * 8, 4, (110 - i * 14, 108 - i * 14, 122 - i * 14))
    for rx in range(110, 198, 8):
        c.vline(rx, 226, 16, iron)
    c.hline(110, 226, 88, iron); c.hline(110, 227, 88, (70, 70, 94))
    c.rect(108, 222, 4, 20, iron); c.rect(196, 222, 4, 20, iron)

    # lamp post, hydrant, the tree in fairy lights
    c.rect(312, 150, 4, 92, iron); c.rect(306, 144, 16, 8, iron); c.rect(308, 146, 12, 5, (255, 236, 170))
    for r_, a in ((60, 14), (44, 18), (28, 24)):
        c.ellipse(314, 150, r_, int(r_ * 0.8), (255, 214, 130), a)
    c.rect(352, 224, 8, 16, (200, 52, 48)); c.rect(350, 228, 12, 4, (200, 52, 48)); c.frame(352, 223, 8, 18, OUT); c.rect(353, 220, 6, 4, (220, 80, 70))
    c.rect(72, 196, 5, 46, (70, 50, 46)); c.frame(71, 196, 7, 46, OUT)
    for i in range(46):
        bx_ = 50 + hash2(i, 1, 2) % 50; by_ = 150 + hash2(i, 2, 2) % 52
        c.px(bx_, by_, (255, 236, 170)); c.px(bx_, by_ + 1, (255, 200, 110), 150)

    # ── the road ─────────────────────────────────────────────────────────────
    c.rect(0, 270, W, 82, (50, 52, 60))
    for i in range(300):
        c.px(hash2(i, 3, 8) % W, 272 + hash2(i, 4, 8) % 78, (68, 70, 80))
    for sx in range(20, W, 70):
        c.rect(sx, 310, 34, 4, (220, 200, 110))
    return c.img


def cab():
    c = Canvas(200, 80)
    x, y = 30, 12
    c.shadow(x + 6, y + 46, 130, 5, a=90)
    c.rrect(x, y + 16, 140, 28, (246, 204, 52), 4); c.rrect(x + 30, y, 76, 20, (246, 204, 52), 4)
    c.rect(x + 36, y + 4, 30, 14, (150, 206, 240)); c.rect(x + 70, y + 4, 30, 14, (150, 206, 240))
    c.frame(x + 36, y + 4, 30, 14, OUT); c.frame(x + 70, y + 4, 30, 14, OUT)
    c.rect(x + 54, y - 7, 30, 8, (26, 22, 36)); c.text(x + 59, y - 5, 'TAXI', (255, 236, 170))
    for i in range(9):
        c.rect(x + 8 + i * 14, y + 26, 7, 7, (26, 22, 36) if i % 2 else (250, 250, 252))
    c.rrect(x, y + 16, 140, 28, (246, 204, 52), 4) if False else None
    c.rframe(x, y + 16, 140, 28, OUT, 4); c.rframe(x + 30, y, 76, 20, OUT, 4)
    for wx in (x + 22, x + 100):
        c.ellipse(wx + 9, y + 44, 10, 10, (26, 22, 36)); c.ellipse(wx + 9, y + 44, 4, 4, (160, 160, 180))
    c.rect(x - 2, y + 24, 5, 6, (255, 250, 220)); c.ellipse(x - 20, y + 30, 26, 8, (255, 240, 180), 40)
    c.rect(x + 137, y + 24, 4, 6, (220, 60, 56))
    return c.img.crop(c.img.getbbox())
