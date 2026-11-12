"""Shared surfaces and furniture for the HIMYM locations."""
from px import Canvas, T, OUT, OUT2, lighten, darken, mix, text_w
from world import hash2

# ── palette ──────────────────────────────────────────────────────────────────
WOOD = (202, 136, 84)        # LimeZu warm wood
WOOD_L = (224, 184, 112)
WALNUT = (126, 82, 60)
DARKWOOD = (92, 58, 50)
CREAM = (250, 246, 238)
STEEL = (167, 176, 190)
LEATHER = (139, 84, 58)
BRICK = (158, 80, 62)
MORTAR = (104, 54, 52)
GLOW = (255, 214, 120)


# ── surfaces ─────────────────────────────────────────────────────────────────
def wood_floor(c, x, y, w, h, base=(196, 144, 92), plank=8, seed=1, length=64):
    light = lighten(base, 0.06); dark = darken(base, 0.06); gap = darken(base, 0.24)
    for yy in range(y, y + h):
        row = (yy - y) // plank
        off = hash2(row, 3, seed) % length
        for xx in range(x, x + w):
            seg = (xx - x + off) // length
            tone = hash2(seg, row, seed) % 5
            col = light if tone == 0 else dark if tone == 1 else base
            if (yy - y) % plank == plank - 1:
                col = gap
            elif (xx - x + off) % length == 0:
                col = gap
            elif (yy - y) % plank == 0:
                col = lighten(col, 0.07)
            c.px(xx, yy, col)
    for i in range((w * h) // 260):          # grain flecks
        fx = x + hash2(i, 7, seed) % w
        fy = y + hash2(i, 11, seed) % h
        if (fy - y) % plank in (2, 3, 4, 5):
            c.hline(fx, fy, 3 + hash2(i, 3, seed) % 4, darken(base, 0.10))


def checker_floor(c, x, y, w, h, a, b, size=8):
    for yy in range(y, y + h):
        for xx in range(x, x + w):
            t = ((xx - x) // size + (yy - y) // size) % 2
            col = a if t == 0 else b
            if (xx - x) % size == 0 or (yy - y) % size == 0:
                col = darken(col, 0.07)
            c.px(xx, yy, col)


def carpet(c, x, y, w, h, base, seed=3):
    for yy in range(y, y + h):
        for xx in range(x, x + w):
            n = hash2(xx, yy, seed) % 9
            col = lighten(base, 0.05) if n == 0 else darken(base, 0.05) if n == 1 else base
            c.px(xx, yy, col)


def tile_grid(c, x, y, w, h, size, line, a=255):
    for yy in range(y, y + h):
        for xx in range(x, x + w):
            if (xx - x) % size == size - 1 or (yy - y) % size == size - 1:
                c.px(xx, yy, line, a)


def brick_wall(c, x, y, w, h, base=BRICK, mortar=MORTAR, seed=5):
    for yy in range(y, y + h):
        row = (yy - y) // 4
        off = 4 if row % 2 else 0
        for xx in range(x, x + w):
            bx = (xx - x + off) // 8
            n = hash2(bx, row, seed) % 10
            col = lighten(base, 0.10) if n < 2 else darken(base, 0.12) if n < 4 else base
            if (yy - y) % 4 == 3 or (xx - x + off) % 8 == 7:
                col = mortar
            elif (yy - y) % 4 == 0:
                col = lighten(col, 0.07)
            c.px(xx, yy, col)


def plaster_wall(c, x, y, w, h, base):
    c.rect(x, y, w, h, base)
    for yy in range(y, y + h):
        for xx in range(x, x + w):
            if hash2(xx // 2, yy // 2, 9) % 23 == 0:
                c.px(xx, yy, darken(base, 0.04))


def wall_trim(c, x, y, w, top_h=4, base_h=4, wood=DARKWOOD, ceil=None):
    """Ceiling shadow band at the top of a wall face + a baseboard at its foot.
    `y` is the wall-face top; the face is 48px tall."""
    ceil = ceil or (46, 40, 58)
    c.rect(x, y, w, top_h, ceil)
    c.hline(x, y + top_h, w, (0, 0, 0), 60)
    c.hline(x, y + top_h + 1, w, (0, 0, 0), 28)
    c.rect(x, y + 48 - base_h, w, base_h, wood)
    c.hline(x, y + 48 - base_h, w, lighten(wood, 0.18))
    c.hline(x, y + 47, w, OUT)


def room_shell(c, W, H, wall_top=(232, 226, 212), door=None):
    """Side walls + bottom wall (top-down view of the wall thickness) and the
    floor shadow the back wall casts. `door` = (x0, x1) px gap in the bottom wall."""
    side = 6
    # shadow under the back wall
    c.rect(side, 48, W - 2 * side, 3, (20, 12, 30), 70)
    c.rect(side, 51, W - 2 * side, 2, (20, 12, 30), 30)
    for sx in (0, W - side):
        c.rect(sx, 0, side, H, wall_top)
        c.vline(sx, 0, H, OUT); c.vline(sx + side - 1, 0, H, OUT)
        c.vline(sx + 1, 0, H, lighten(wall_top, 0.4))
    # shadows along the side walls
    c.rect(side, 48, 2, H - 60, (20, 12, 30), 34)
    by = H - 12
    c.rect(0, by, W, 12, wall_top)
    c.hline(0, by, W, OUT); c.hline(0, H - 1, W, OUT)
    c.hline(1, by + 1, W - 2, lighten(wall_top, 0.4))
    c.rect(0, by + 8, W, 3, darken(wall_top, 0.12))
    c.vline(0, by, 12, OUT); c.vline(W - 1, by, 12, OUT)
    if door:
        x0, x1 = door
        c.rect(x0, by, x1 - x0, 12, (0, 0, 0), 0)
        for yy in range(by, H):
            for xx in range(x0, x1):
                c.px(xx, yy, (74, 56, 62))
        c.vline(x0 - 1, by, 12, OUT); c.vline(x1, by, 12, OUT)
        c.rect(x0, by, x1 - x0, 2, (40, 30, 44))
        # threshold strip
        c.rect(x0, by + 2, x1 - x0, 4, (150, 112, 78))
        c.hline(x0, by + 2, x1 - x0, (184, 146, 100))
        c.rect(x0, by + 6, x1 - x0, 6, (52, 40, 56))


# ── windows ──────────────────────────────────────────────────────────────────
def night_window(c, x, y, w, h, frame=(110, 70, 54), seed=1, panes=2, sill=True, sky=None):
    """A window onto the New York dusk: gradient sky, a skyline, lit windows."""
    sky = sky or [(44, 52, 110), (84, 70, 140), (158, 96, 140), (232, 140, 110)]
    c.rect(x, y, w, h, frame)
    c.frame(x, y, w, h, OUT)
    c.hline(x + 1, y + 1, w - 2, lighten(frame, 0.25))
    ix, iy, iw, ih = x + 3, y + 3, w - 6, h - 6
    for yy in range(ih):
        t = yy / float(max(ih - 1, 1))
        seg = min(int(t * (len(sky) - 1)), len(sky) - 2)
        col = mix(sky[seg], sky[seg + 1], t * (len(sky) - 1) - seg)
        c.hline(ix, iy + yy, iw, col)
    # skyline: two depth layers
    for layer, (tone, lo, hi) in enumerate([((52, 48, 96), 0.30, 0.62), ((30, 28, 60), 0.45, 0.85)]):
        bx = ix
        k = 0
        while bx < ix + iw:
            bw = 4 + hash2(k, layer, seed) % 6
            bh = int(ih * (lo + (hash2(k, layer + 5, seed) % 100) / 100.0 * (hi - lo)))
            bw = min(bw, ix + iw - bx)
            c.rect(bx, iy + ih - bh, bw, bh, tone)
            if layer == 1:
                for wy in range(iy + ih - bh + 2, iy + ih - 1, 3):
                    for wx in range(bx + 1, bx + bw - 1, 2):
                        if hash2(wx, wy, seed) % 3 == 0:
                            c.px(wx, wy, (255, 220, 130))
            elif hash2(k, 77, seed) % 3 == 0 and bh > 4:
                c.px(bx + bw // 2, iy + ih - bh - 1, tone)       # antenna
            bx += bw + (hash2(k, 9, seed) % 2)
            k += 1
    c.frame(ix - 1, iy - 1, iw + 2, ih + 2, OUT)
    # mullions
    for i in range(1, panes):
        mx = ix + (iw * i) // panes
        c.vline(mx - 1, iy, ih, frame); c.vline(mx, iy, ih, darken(frame, 0.2))
    my = iy + ih // 2
    c.hline(ix, my, iw, frame)
    # glass sheen
    for i in range(0, 5):
        c.px(ix + 2 + i, iy + 6 - i, (255, 255, 255), 90)
        c.px(ix + 3 + i, iy + 6 - i, (255, 255, 255), 50)
    if sill:
        c.rect(x - 2, y + h, w + 4, 3, lighten(frame, 0.15))
        c.frame(x - 2, y + h, w + 4, 3, OUT)
        c.hline(x - 1, y + h + 3, w + 2, (0, 0, 0), 60)


# ── small things ─────────────────────────────────────────────────────────────
def outlined(draw, w, h, col=OUT):
    """Run `draw(canvas)` on a scratch canvas and return it with a 1px outline
    hugging the painted silhouette."""
    tmp = Canvas(w + 2, h + 2)
    draw(tmp.sub(1, 1))
    p = tmp.p
    edge = []
    for y in range(h + 2):
        for x in range(w + 2):
            if p[x, y][3] != 0:
                continue
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < w + 2 and 0 <= ny < h + 2 and p[nx, ny][3] == 255:
                    edge.append((x, y)); break
    for (x, y) in edge:
        p[x, y] = (col[0], col[1], col[2], 255)
    return tmp.img


def stamp(c, draw, x, y, w, h, col=OUT):
    c.blit(outlined(draw, w, h, col), x - 1, y - 1)


def laptop_front(c, x, y, body=(190, 196, 208)):
    """Open laptop, screen toward the viewer (seat faces up). 14x12.
    Returns the screen rect."""
    c.rrect(x, y, 14, 9, (52, 54, 72), 1)                  # lid / bezel
    c.rect(x + 1, y + 1, 12, 7, (34, 38, 58))              # screen (off)
    c.px(x + 2, y + 2, (70, 80, 110)); c.px(x + 3, y + 2, (70, 80, 110))
    c.rframe(x, y, 14, 9, OUT, 1)
    c.rect(x - 1, y + 9, 16, 3, body)                      # keyboard deck
    c.hline(x - 1, y + 9, 16, lighten(body, 0.3))
    c.hline(x + 1, y + 10, 12, darken(body, 0.25))
    c.frame(x - 1, y + 9, 16, 3, OUT)
    return (x + 1, y + 1, 12, 7)


def laptop_back(c, x, y, body=(190, 196, 208), logo=(240, 244, 250)):
    """Open laptop seen from behind (seat faces down). 14x10. Returns the lid
    rect — its logo lights up while the owner works."""
    c.rrect(x, y, 14, 9, body, 1)
    c.hline(x + 1, y + 1, 12, lighten(body, 0.35))
    c.rect(x + 1, y + 6, 12, 2, darken(body, 0.12))
    c.rect(x + 6, y + 3, 2, 2, logo)
    c.rframe(x, y, 14, 9, OUT, 1)
    c.rect(x, y + 9, 14, 2, darken(body, 0.3))
    c.frame(x, y + 9, 14, 2, OUT)
    return (x + 5, y + 2, 4, 4)


def monitor(c, x, y):
    """Desktop monitor, 20x16 incl. stand. Returns the screen rect."""
    c.rrect(x, y, 20, 13, (60, 62, 80), 1)
    c.rect(x + 2, y + 2, 16, 9, (34, 38, 58))
    c.px(x + 3, y + 3, (70, 80, 110)); c.px(x + 4, y + 3, (70, 80, 110)); c.px(x + 3, y + 4, (70, 80, 110))
    c.rframe(x, y, 20, 13, OUT, 1)
    c.rect(x + 8, y + 13, 4, 2, (120, 124, 140)); c.frame(x + 7, y + 13, 6, 3, OUT)
    c.rect(x + 5, y + 15, 10, 2, (150, 154, 170)); c.frame(x + 4, y + 15, 12, 3, OUT)
    return (x + 2, y + 2, 16, 9)


def mug(c, x, y, col=(242, 237, 226), band=(232, 193, 77)):
    c.rect(x, y, 5, 4, col); c.hline(x, y + 2, 5, band); c.hline(x, y, 5, (255, 255, 255))
    c.rect(x + 5, y + 1, 1, 2, darken(col, 0.15))


def bottle(c, x, y, col=(120, 78, 40), label=(236, 226, 200)):
    c.rect(x, y + 3, 3, 6, col); c.px(x + 1, y, col); c.px(x + 1, y + 1, col); c.px(x + 1, y + 2, col)
    c.px(x + 1, y, (220, 200, 120)); c.hline(x, y + 5, 3, label); c.px(x, y + 4, lighten(col, 0.3))


def books_row(c, x, y, w, h, seed=1, lean=True):
    """A shelf row of book spines, bottoms aligned to y+h-1."""
    cols = [(178, 70, 62), (70, 110, 160), (216, 170, 80), (92, 140, 100), (150, 96, 150),
            (226, 216, 196), (60, 70, 100), (200, 110, 70), (120, 160, 170)]
    xx = x
    k = 0
    while xx < x + w:
        bw = 2 + (hash2(k, 1, seed) % 2)
        if hash2(k, 4, seed) % 9 == 0:
            xx += 1 + hash2(k, 5, seed) % 2      # a gap
            k += 1
            continue
        bw = min(bw, x + w - xx)
        bh = h - (hash2(k, 2, seed) % 3)
        col = cols[hash2(k, 3, seed) % len(cols)]
        c.rect(xx, y + h - bh, bw, bh, col)
        c.vline(xx, y + h - bh, bh, lighten(col, 0.22))
        if bh > 4:
            c.hline(xx, y + h - bh + 2, bw, lighten(col, 0.4) if hash2(k, 6, seed) % 2 else darken(col, 0.3))
        xx += bw
        k += 1


def bookshelf(c, x, y, w, h, wood=WALNUT, shelves=4, seed=1, top_items=True):
    """Tall bookcase against a wall (front view)."""
    c.shadow(x + 2, y + h, w - 2, 2)
    c.rect(x, y, w, h, wood)
    c.rect(x + 2, y + 3, w - 4, h - 5, darken(wood, 0.45))
    sh = (h - 5) // shelves
    for i in range(shelves):
        sy = y + 3 + i * sh
        books_row(c, x + 3, sy + 1, w - 6, sh - 3, seed=seed + i * 7)
        c.hline(x + 2, sy + sh - 2, w - 4, lighten(wood, 0.12))
        c.hline(x + 2, sy + sh - 1, w - 4, darken(wood, 0.25))
    c.hline(x + 1, y + 1, w - 2, lighten(wood, 0.3))
    c.hline(x + 1, y + 2, w - 2, lighten(wood, 0.12))
    c.frame(x, y, w, h, OUT)


def potted_plant(c, x, y, kind=0):
    """Original potted plants. (x, y) = bottom-centre. kind 0 bushy, 1 small, 2 palm."""
    pot, pot_d, soil = (176, 108, 78), (130, 76, 60), (70, 50, 46)
    g, gl, gd = (72, 142, 88), (118, 186, 110), (44, 100, 72)
    if kind % 3 == 1:
        c.rect(x - 4, y - 7, 9, 7, pot); c.rect(x - 5, y - 9, 11, 3, pot); c.hline(x - 4, y - 8, 9, lighten(pot, 0.25))
        c.vline(x + 3, y - 6, 6, pot_d); c.hline(x - 3, y - 9, 7, soil)
        for (dx, dy, r) in ((0, -15, 4), (-4, -12, 3), (4, -12, 3), (0, -19, 3)):
            c.ellipse(x + dx, y + dy, r, r, g)
        for (dx, dy) in ((-1, -17), (-5, -13), (3, -14), (0, -21)):
            c.px(x + dx, y + dy, gl); c.px(x + dx + 1, y + dy, gl)
        for (dx, dy) in ((2, -12), (-2, -10), (5, -10)):
            c.px(x + dx, y + dy, gd)
        _outline_region(c, x - 9, y - 24, 19, 25)
        return 18, 24
    if kind % 3 == 2:
        c.rect(x - 5, y - 8, 11, 8, pot); c.rect(x - 6, y - 10, 13, 3, pot); c.hline(x - 5, y - 9, 11, lighten(pot, 0.25))
        c.vline(x + 4, y - 7, 7, pot_d)
        c.rect(x - 1, y - 22, 2, 13, (120, 84, 56)); c.vline(x, y - 22, 13, (150, 110, 74))
        for (ex, ey) in ((-10, -24), (10, -24), (-8, -30), (8, -30), (-11, -19), (11, -19), (0, -33)):
            c.line(x, y - 23, x + ex, y + ey, g)
            c.line(x, y - 24, x + ex, y + ey - 1, gl)
            c.px(x + ex, y + ey + 1, gd)
        _outline_region(c, x - 13, y - 35, 27, 36)
        return 24, 34
    c.rect(x - 5, y - 8, 11, 8, pot); c.rect(x - 6, y - 10, 13, 3, pot); c.hline(x - 5, y - 9, 11, lighten(pot, 0.25))
    c.vline(x + 4, y - 7, 7, pot_d); c.hline(x - 4, y - 10, 9, soil)
    c.rect(x - 1, y - 16, 2, 6, (110, 78, 54))
    for (dx, dy, r) in ((0, -22, 6), (-6, -18, 5), (6, -18, 5), (-3, -27, 4), (4, -26, 4)):
        c.ellipse(x + dx, y + dy, r, r, g)
    for (dx, dy) in ((-2, -26), (-7, -20), (3, -28), (5, -21), (-1, -22), (-5, -29)):
        c.px(x + dx, y + dy, gl); c.px(x + dx + 1, y + dy, gl); c.px(x + dx, y + dy + 1, gl)
    for (dx, dy) in ((2, -17), (-4, -15), (7, -15), (0, -19), (-8, -16)):
        c.px(x + dx, y + dy, gd); c.px(x + dx + 1, y + dy, gd)
    _outline_region(c, x - 13, y - 33, 27, 34)
    return 22, 31


def _outline_region(c, x0, y0, w, h, col=OUT):
    """Outline whatever opaque pixels sit in a region of a scratch canvas."""
    pts = []
    for yy in range(y0, y0 + h):
        for xx in range(x0, x0 + w):
            if c.get(xx, yy)[3] != 0:
                continue
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                if c.get(xx + dx, yy + dy)[3] == 255 and c.get(xx + dx, yy + dy)[:3] != col:
                    pts.append((xx, yy)); break
    for (xx, yy) in pts:
        c.px(xx, yy, col)


def floor_lamp(c, x, y, kind=0):
    """Original floor lamp. (x, y) = bottom-centre."""
    shade = [(214, 70, 60), (74, 132, 214), (214, 70, 60), (240, 226, 196), (214, 184, 140), (74, 132, 214)][kind % 6]
    c.rect(x - 4, y - 2, 9, 2, (70, 70, 94)); c.rect(x, y - 24, 1, 22, (150, 156, 172)); c.vline(x + 1, y - 24, 22, (90, 90, 114))
    c.rrect(x - 6, y - 33, 13, 10, shade, 2); c.hline(x - 4, y - 32, 9, lighten(shade, 0.3)); c.hline(x - 5, y - 25, 11, darken(shade, 0.25))
    c.hline(x - 4, y - 23, 9, (255, 240, 180))
    _outline_region(c, x - 8, y - 35, 17, 36)
    return 14, 34


def table_lamp(c, x, y, kind=0):
    """Original table lamp. (x, y) = bottom-centre."""
    shade = [(240, 226, 196), (236, 236, 240)][kind % 2]
    c.rect(x - 3, y - 2, 7, 2, (150, 100, 70)); c.rect(x - 1, y - 8, 3, 6, (190, 120, 80)); c.px(x - 1, y - 7, (226, 160, 110))
    c.rrect(x - 5, y - 16, 11, 9, shade, 2); c.hline(x - 3, y - 15, 7, lighten(shade, 0.4)); c.hline(x - 4, y - 9, 9, darken(shade, 0.18))
    _outline_region(c, x - 7, y - 18, 15, 19)
    return 12, 17


def stool(c, x, y, top=(190, 132, 84), leg=(86, 60, 56)):
    """Round bar/kitchen stool seen from above-front. (x, y) = top-left of a
    12x12 footprint."""
    c.rect(x + 2, y + 6, 1, 5, leg); c.rect(x + 9, y + 6, 1, 5, leg)
    c.hline(x + 2, y + 9, 8, leg)
    c.rrect(x, y, 12, 7, top, 2)
    c.hline(x + 3, y + 1, 6, lighten(top, 0.25))
    c.hline(x + 2, y + 5, 8, darken(top, 0.2))
    c.rframe(x, y, 12, 7, OUT, 2)
    c.px(x + 1, y + 10, OUT, 80); c.px(x + 10, y + 10, OUT, 80)


def chair_seat(c, x, y, wood=WOOD, cushion=None):
    """Dining chair seat pad, 12x9 at (x, y) — the part under the sitter."""
    c.rrect(x, y, 12, 9, cushion or wood, 1)
    c.hline(x + 2, y + 1, 8, lighten(cushion or wood, 0.2))
    c.rframe(x, y, 12, 9, OUT, 1)


def chair_back_front(c, x, y, wood=WOOD):
    """Chair back for a seat that faces UP (we look at the sitter's back, the
    chair back is between us and them). 12 wide, 11 tall + legs."""
    c.rrect(x, y, 12, 10, wood, 1)
    c.rect(x + 2, y + 2, 8, 2, darken(wood, 0.3))
    c.rect(x + 2, y + 5, 8, 2, darken(wood, 0.3))
    c.hline(x + 1, y + 1, 10, lighten(wood, 0.25))
    c.rframe(x, y, 12, 10, OUT, 1)
    c.rect(x + 1, y + 10, 2, 4, darken(wood, 0.25)); c.rect(x + 9, y + 10, 2, 4, darken(wood, 0.25))
    c.frame(x, y + 9, 4, 6, OUT); c.frame(x + 8, y + 9, 4, 6, OUT)
    c.rect(x + 1, y + 10, 2, 4, darken(wood, 0.25)); c.rect(x + 9, y + 10, 2, 4, darken(wood, 0.25))


def chair_back_rear(c, x, y, wood=WOOD):
    """Chair back for a seat that faces DOWN (the back rises behind the sitter)."""
    c.rrect(x, y, 12, 9, wood, 1)
    c.rect(x + 2, y + 2, 8, 2, darken(wood, 0.3))
    c.rect(x + 2, y + 5, 8, 2, darken(wood, 0.3))
    c.hline(x + 1, y + 1, 10, lighten(wood, 0.25))
    c.rframe(x, y, 12, 9, OUT, 1)


def sign_plate(c, x, y, s, fg, bg, pad=3, border=None):
    w = text_w(s) + pad * 2
    c.rect(x, y, w, 5 + pad * 2 - 2, bg)
    c.frame(x, y, w, 5 + pad * 2 - 2, border or OUT)
    c.text(x + pad, y + pad - 1, s, fg)
    return w


def trash_bin(c, x, y):
    c.rrect(x, y, 10, 12, (120, 126, 146), 1)
    c.rect(x + 1, y + 1, 8, 3, (70, 72, 94))
    c.vline(x + 3, y + 5, 6, (150, 156, 174)); c.vline(x + 6, y + 5, 6, (96, 100, 122))
    c.rframe(x, y, 10, 12, OUT, 1)
    c.shadow(x + 1, y + 12, 9, 2)
