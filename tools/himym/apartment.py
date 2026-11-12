"""Ted's apartment (4C) — the main agent workspace.

Laid out after the show's set as seen from the "fourth wall" (which is this
room's bottom edge):

  back wall, left   brick chimney wall with the fireplace
  back wall, centre the raised window alcove, one step up: two tall windows
                    with wooden blinds — the LEFT one opens onto the fire
                    escape (iron railing + ladder to the roof) — and built-in
                    shelves between them. Ted's desk lives up here.
  back wall, right  black bookcase with yellow drawers, then the front door,
                    and the kitchen immediately beside the door (fridge first)
  centre            the red couch facing the fourth wall, coffee table, the
                    red armchair, the patchwork rug
  left wall         the upright piano
  right             round dining table outside the kitchen, breakfast counter

All coordinates are local pixels inside the 544x352 room (34x22 tiles).
"""
from px import T, OUT, OUT2, lighten, darken, mix
from world import hash2
import props as P

W, H = 34 * T, 22 * T

WALL = (230, 208, 152)        # the warm yellow-cream plaster
WALL_LO = (216, 192, 136)
TRIM = (98, 58, 48)           # dark wood trim / doors
TRIM_L = (136, 86, 64)
DOOR = (112, 64, 50)
RED = (206, 62, 44)           # the couch
RED_L = (232, 96, 66)
RED_D = (156, 40, 40)
CAB = (236, 226, 200)         # kitchen cabinets
CAB_D = (196, 184, 156)
GRANITE = (78, 76, 92)
KT_A = (236, 230, 214)
KT_B = (92, 92, 108)

ALC_X0, ALC_X1 = 150, 352     # the window alcove
ALC_Y1 = 98


def paint(L):
    c = L.bg
    # ── floors ───────────────────────────────────────────────────────────────
    P.wood_floor(c, 6, 48, W - 12, H - 60, base=(190, 138, 88), seed=11)
    # the alcove is one step up: lighter boards, then the step's riser
    P.wood_floor(c, ALC_X0, 48, ALC_X1 - ALC_X0, ALC_Y1 - 48, base=(204, 152, 100), seed=4)
    c.rect(ALC_X0, ALC_Y1, ALC_X1 - ALC_X0, 4, (150, 100, 66))
    c.hline(ALC_X0, ALC_Y1, ALC_X1 - ALC_X0, (226, 180, 124))
    c.hline(ALC_X0, ALC_Y1 + 3, ALC_X1 - ALC_X0, OUT)
    c.rect(ALC_X0, ALC_Y1 + 4, ALC_X1 - ALC_X0, 3, (20, 12, 30), 56)
    # kitchen lino
    P.checker_floor(c, 440, 48, 98, 98, KT_A, KT_B, 8)
    c.vline(439, 48, 98, (120, 84, 60)); c.vline(440, 48, 98, (150, 110, 76))

    # ── back wall ────────────────────────────────────────────────────────────
    plaster(c, 6, W - 12)
    P.brick_wall(c, 6, 0, 112, 48, seed=5)
    P.wall_trim(c, 6, 0, 112, wood=(84, 52, 46))
    c.vline(118, 0, 48, OUT)
    # kitchen wall: cream tile
    c.rect(440, 0, 98, 48, (240, 232, 212))
    P.tile_grid(c, 440, 0, 98, 48, 8, (218, 208, 184))
    P.wall_trim(c, 440, 0, 98, wood=(196, 186, 160))
    c.vline(439, 0, 48, OUT)

    P.room_shell(c, W, H, wall_top=(226, 214, 196), door=None)

    fireplace(L)
    hall_door(L)
    alcove(L)
    door_wall(L)
    kitchen(L)
    living_room(L)
    dining(L)
    left_side(L)
    fourth_wall(L)

    # ── map data ─────────────────────────────────────────────────────────────
    L.block(0, 0, 33, 2)
    L.spawn('entrance', 26, 4)
    L.door(26, 3)                              # the front door, beside the kitchen
    L.free(25, 3, 26, 3)
    L.extra['fireEscape'] = L.tile(11, 3)      # the window that leads to the roof
    L.free(11, 3)
    L.errand('water', (2, 20), 'left', (1, 20), 4.5)
    L.errand('water', (31, 20), 'right', (32, 20), 4.5)
    L.errand('water', (21, 4), 'up', (21, 3), 4.5, god_only=True)
    L.errand('dispenser', (30, 4), 'up', (30, 3), 3.5)
    L.errand('fridge', (28, 4), 'up', (28, 3), 3.2)
    L.errand('shelf', (23, 4), 'up', (23, 2), 4)
    L.errand('bin', (21, 20), 'left', (20, 20), 2.6)


def plaster(c, x, w):
    c.rect(x, 0, w, 48, WALL)
    c.rect(x, 30, w, 14, WALL_LO)
    for xx in range(x, x + w):
        for yy in range(5, 44):
            if hash2(xx // 2, yy // 2, 9) % 29 == 0:
                c.px(xx, yy, darken(WALL, 0.04))
    c.rect(x, 27, w, 3, TRIM); c.hline(x, 27, w, TRIM_L)          # chair rail
    c.hline(x, 30, w, (0, 0, 0), 40)
    P.wall_trim(c, x, 0, w, wood=TRIM)
    c.hline(x, 6, w, TRIM, 150)                                   # picture rail


def door(c, x, y, w, h, knob_right=True, col=DOOR):
    c.rect(x - 2, y - 2, w + 4, h + 2, TRIM); c.frame(x - 2, y - 2, w + 4, h + 3, OUT)
    c.hline(x - 1, y - 1, w + 2, TRIM_L)
    c.rect(x, y, w, h, col)
    c.vline(x, y, h, lighten(col, 0.16))
    pw = (w - 7) // 2
    for (px_, py_, ph) in ((x + 2, y + 3, h // 2 - 5), (x + 2, y + h // 2 + 1, h // 2 - 4)):
        for k in range(2):
            c.frame(px_ + k * (pw + 3), py_, pw, ph, darken(col, 0.3))
            c.hline(px_ + k * (pw + 3) + 1, py_ + 1, pw - 2, lighten(col, 0.14))
    kx = x + w - 4 if knob_right else x + 2
    c.rect(kx, y + h // 2 - 1, 2, 3, (226, 190, 110)); c.px(kx, y + h // 2 - 1, (255, 232, 160))
    c.frame(x, y, w, h, OUT)


# ─────────────────────────────────────────────────────────────────────────────
def fireplace(L):
    """Back wall, left: the brick chimney wall, wooden mantel, the swords."""
    c = L.bg
    sx, sw = 30, 68
    # wooden surround + mantel
    c.rect(sx, 16, sw, 32, (112, 68, 52)); c.frame(sx, 16, sw, 33, OUT)
    c.vline(sx + 1, 17, 30, (150, 100, 72))
    c.rect(sx + 4, 20, sw - 8, 3, (88, 52, 44))
    c.rect(sx - 5, 12, sw + 10, 5, (126, 78, 58)); c.hline(sx - 4, 13, sw + 8, (170, 116, 82))
    c.frame(sx - 5, 12, sw + 10, 5, OUT)
    c.hline(sx - 3, 17, sw + 6, (0, 0, 0), 70)
    # firebox
    fx, fy, fw, fh = sx + 13, 25, 42, 23
    c.rect(fx - 2, fy - 2, fw + 4, fh + 2, (128, 66, 56))
    for i in range(fx - 2, fx + fw + 2, 6):
        c.vline(i, fy - 2, 2, (88, 46, 46))
    c.rrect(fx, fy, fw, fh, (34, 24, 36), 2); c.rect(fx, fy + fh - 1, fw, 1, (34, 24, 36))
    c.frame(fx - 2, fy - 2, fw + 4, fh + 3, OUT)
    c.ellipse(fx + fw // 2, fy + fh - 4, 16, 8, (150, 60, 40), 110)
    c.ellipse(fx + fw // 2, fy + fh - 3, 10, 5, (220, 110, 50), 120)
    for (lx, ly, lw) in ((fx + 7, fy + fh - 5, 28), (fx + 11, fy + fh - 8, 20)):
        c.rect(lx, ly, lw, 3, (98, 62, 48)); c.hline(lx, ly, lw, (136, 90, 62))
        c.frame(lx - 1, ly - 1, lw + 2, 5, (50, 34, 40))
    for (qx, qh) in ((fx + 13, 7), (fx + 18, 10), (fx + 23, 8), (fx + 28, 6)):
        c.rect(qx, fy + fh - 8 - qh, 3, qh, (240, 130, 50))
        c.rect(qx + 1, fy + fh - 6 - qh, 1, qh - 2, (255, 210, 90))
    # on the mantel: a clock and candles
    c.rect(sx + 30, 6, 8, 6, (226, 190, 110)); c.frame(sx + 29, 5, 10, 8, OUT)
    c.rect(sx + 32, 7, 4, 3, (250, 246, 238)); c.px(sx + 34, 8, OUT)
    for qx in (sx + 2, sx + sw - 5):
        c.rect(qx, 8, 2, 4, (250, 240, 220)); c.px(qx, 7, (255, 200, 80))
    # hearth
    c.rect(sx + 4, 48, sw - 8, 8, (150, 140, 140)); c.hline(sx + 5, 49, sw - 10, (184, 176, 174))
    for i in range(sx + 12, sx + sw - 8, 12):
        c.vline(i, 49, 6, (122, 114, 118))
    c.frame(sx + 4, 47, sw - 8, 10, OUT)
    L.extra['fire'] = L.gpx(fx + fw // 2, fy + fh - 6)
    L.block(2, 3, 5, 3)

    # the crossed swords, on the brick beside the chimney
    def swords(t):
        steel, hi = (206, 214, 226), (246, 248, 252)
        t.line(1, 20, 17, 2, steel); t.line(0, 19, 16, 1, hi)
        t.line(18, 20, 2, 2, steel); t.line(19, 19, 3, 1, hi)
        for (hx, hy, s) in ((1, 20, 1), (18, 20, -1)):
            t.rect(hx - 1, hy - 1, 3, 3, (226, 184, 80))
            t.line(hx + 2 * s, hy - 4, hx + 5 * s, hy + 1, (226, 184, 80))
    P.stamp(c, swords, 8, 8, 20, 23)
    # a framed print on the right of the chimney
    c.rect(101, 9, 13, 16, (70, 46, 46)); c.rect(103, 11, 9, 12, (226, 150, 70)); c.frame(101, 9, 13, 16, OUT)
    c.rect(105, 14, 5, 6, (60, 70, 110))


def hall_door(L):
    """The door to the bedrooms, between the chimney wall and the alcove."""
    door(L.bg, 122, 9, 22, 39, knob_right=False)


def blinds_window(c, x, y, w, h, drop, seed, escape=False):
    """A tall sash window in a dark wood frame, wooden blinds lowered `drop` px.
    With `escape`, the iron fire escape shows outside: rails, bars and the
    ladder that climbs to the roof."""
    frame = (118, 60, 46)
    c.rect(x, y, w, h, frame); c.frame(x, y, w, h, OUT)
    c.hline(x + 1, y + 1, w - 2, lighten(frame, 0.25))
    ix, iy, iw, ih = x + 3, y + 3, w - 6, h - 6
    sky = [(52, 60, 118), (96, 78, 146), (176, 104, 140), (238, 150, 112)]
    for yy in range(ih):
        t = yy / float(ih - 1)
        seg = min(int(t * 3), 2)
        c.hline(ix, iy + yy, iw, mix(sky[seg], sky[seg + 1], t * 3 - seg))
    bx = ix
    k = 0
    while bx < ix + iw:                                          # skyline
        bw = min(4 + hash2(k, 1, seed) % 6, ix + iw - bx)
        bh = int(ih * (0.25 + (hash2(k, 5, seed) % 100) / 100.0 * 0.35))
        c.rect(bx, iy + ih - bh, bw, bh, (34, 30, 66))
        for wy in range(iy + ih - bh + 2, iy + ih - 1, 3):
            for wx in range(bx + 1, bx + bw - 1, 2):
                if hash2(wx, wy, seed) % 3 == 0:
                    c.px(wx, wy, (255, 220, 130))
        bx += bw + hash2(k, 9, seed) % 2
        k += 1
    if escape:
        iron, iron_l = (26, 24, 36), (70, 70, 94)
        ry = iy + ih - 13
        c.hline(ix, ry, iw, iron); c.hline(ix, ry - 1, iw, iron_l)          # top rail
        c.hline(ix, ry + 6, iw, iron)                                        # mid rail
        for bx_ in range(ix + 1, ix + iw, 4):
            c.vline(bx_, ry, 13, iron)
        c.rect(ix, iy + ih - 2, iw, 2, iron)                                 # the landing's grating
        # the ladder up to the roof
        lx = ix + iw - 11
        c.vline(lx, iy, ih - 2, iron); c.vline(lx + 6, iy, ih - 2, iron)
        c.vline(lx + 1, iy, ih - 2, iron_l)
        for ly in range(iy + 2, iy + ih - 3, 4):
            c.hline(lx, ly, 7, iron)
    # blinds
    slat, slat_d = (206, 170, 116), (160, 124, 82)
    for yy in range(drop):
        c.hline(ix, iy + yy, iw, slat_d if yy % 3 == 2 else slat)
    c.hline(ix, iy + drop, iw, darken(slat_d, 0.3))
    c.vline(ix + 3, iy, drop, slat_d); c.vline(ix + iw - 4, iy, drop, slat_d)
    c.frame(ix - 1, iy - 1, iw + 2, ih + 2, OUT)
    my = iy + ih // 2 + 3
    if not escape:
        c.hline(ix, my, iw, frame); c.hline(ix, my + 1, iw, darken(frame, 0.25))
    for i in range(5):
        c.px(ix + 2 + i, iy + drop + 8 - i, (255, 255, 255), 80)
    c.rect(x - 2, y + h, w + 4, 3, lighten(frame, 0.15)); c.frame(x - 2, y + h, w + 4, 3, OUT)


def alcove(L):
    """The raised window alcove: fire-escape window, built-ins, second window,
    and Ted's two desks."""
    c = L.bg
    # stub walls that make the recess
    for sx in (ALC_X0 - 4, ALC_X1):
        c.rect(sx, 44, 4, ALC_Y1 - 40, (226, 214, 196)); c.frame(sx, 43, 4, ALC_Y1 - 38, OUT)
        c.rect(sx, ALC_Y1 + 1, 4, 4, TRIM)
    # the alcove's wall is a touch lighter, as if set back and lit by the windows
    c.rect(ALC_X0, 5, ALC_X1 - ALC_X0, 22, lighten(WALL, 0.14))
    blinds_window(c, 160, 3, 48, 40, drop=6, seed=3, escape=True)
    blinds_window(c, 294, 3, 48, 40, drop=17, seed=8)

    # built-in shelves between the windows, the blue French horn at their heart
    bx, bw = 216, 70
    c.rect(bx, 4, bw, 40, (112, 68, 52)); c.frame(bx, 4, bw, 41, OUT)
    c.hline(bx + 1, 5, bw - 2, (150, 100, 72))
    for (sx, sw_) in ((bx + 2, 18), (bx + bw - 20, 18)):
        c.rect(sx, 7, sw_, 35, (60, 40, 44))
        for i, sy in enumerate((7, 19, 31)):
            P.books_row(c, sx + 1, sy + 1, sw_ - 2, 9, seed=41 + i * 5 + sx)
            c.hline(sx, sy + 10, sw_, (150, 100, 72)); c.hline(sx, sy + 11, sw_, (80, 50, 46))
    c.rect(bx + 21, 7, 28, 35, (132, 84, 64)); c.frame(bx + 21, 7, 28, 35, (80, 50, 46))

    def horn(t):
        b, bh, bd, bdd = (58, 112, 226), (150, 190, 255), (34, 70, 168), (20, 40, 110)
        t.ring(8, 11, 7, 7, b, 2)
        t.ring(8, 11, 4, 4, bd, 1)
        for (qx, qy) in ((2, 8), (3, 6), (5, 5), (7, 4), (9, 4)):
            t.px(qx, qy, bh)
        t.line(1, 9, 0, 5, b); t.line(0, 5, 0, 2, bh)
        t.ellipse(16, 12, 7, 9, b)
        t.ring(16, 12, 7, 9, bh, 1)
        t.ellipse(17, 12, 4, 6, bd)
        t.ellipse(18, 12, 2, 3, bdd)
        t.px(12, 6, (220, 236, 255)); t.px(13, 5, (220, 236, 255))
    P.stamp(c, horn, bx + 23, 11, 24, 22)
    c.rect(bx + 29, 36, 12, 3, (226, 190, 110)); c.frame(bx + 28, 35, 14, 5, OUT)

    # Ted's desk under the built-ins (seat 15,4): monitor, lamp, a tower model
    def ted(c_, x, y, w):
        c_.line(x + 4, y + 9, x + 7, y + 1, (70, 70, 94)); c_.line(x + 7, y + 1, x + 12, y + 4, (70, 70, 94))
        c_.rect(x + 10, y + 3, 6, 3, (220, 90, 70)); c_.frame(x + 9, y + 2, 8, 5, OUT)
        mx = x + w - 13
        c_.rect(mx, y - 4, 8, 14, (240, 238, 230)); c_.frame(mx - 1, y - 5, 10, 16, OUT)
        c_.rect(mx + 2, y - 9, 4, 5, (240, 238, 230)); c_.frame(mx + 1, y - 10, 6, 6, OUT)
        c_.vline(mx + 4, y - 13, 3, OUT)
        for yy in range(y - 7, y + 9, 2):
            c_.hline(mx + 1, yy, 6, (170, 190, 214))
    desk_up(L, 'desk-ceo', 15, 4, w=62, deco=ted, kind='laptop', chair=False, top=(226, 190, 124), front=(168, 118, 76))
    P.stool(c, 15 * T + 2, 4 * T + 3)

    # the drafting table under the right window (seat 19,4)
    def draft(c_, x, y, w):
        c_.rect(x + w - 19, y + 2, 16, 11, (74, 122, 196)); c_.frame(x + w - 19, y + 2, 16, 11, (44, 78, 150))
        for i in range(0, 14, 4):
            c_.vline(x + w - 18 + i, y + 3, 9, (104, 150, 216))
        c_.frame(x + w - 14, y + 4, 6, 8, (236, 244, 255))
        c_.hline(x + 3, y + 12, 12, (240, 226, 190))
    desk_up(L, 'pc-4', 19, 4, w=46, deco=draft, chair=False, top=(226, 190, 124), front=(168, 118, 76))
    P.stool(c, 19 * T + 2, 4 * T + 3)

    # Ted's plant in the corner of the alcove
    L.tall(64, lambda t: P.potted_plant(t, 343, 64, 1))
    L.block(21, 3)
    # a small radiator under the fire-escape window, clear of the sill you climb through
    c.rect(152, 36, 8, 12, (196, 190, 180)); c.frame(152, 36, 8, 13, OUT)
    for i in range(154, 160, 2):
        c.vline(i, 38, 9, (150, 144, 138))
    L.block(9, 3)


def door_wall(L):
    """Right of the alcove: black bookcase with yellow drawers, the umbrella
    stand, then the front door — which sits right beside the kitchen."""
    c = L.bg
    # bookcase
    bx = 360
    c.shadow(bx + 2, 62, 30, 2)
    c.rect(bx, 6, 32, 56, (44, 40, 52))
    c.rect(bx + 2, 9, 28, 30, (26, 24, 34))
    for i, sy in enumerate((9, 19, 29)):
        P.books_row(c, bx + 3, sy + 1, 26, 8, seed=70 + i * 9)
        c.hline(bx + 2, sy + 9, 28, (80, 76, 92))
    for i, dy in enumerate((41, 51)):
        c.rect(bx + 2, dy, 28, 9, (240, 204, 70)); c.frame(bx + 2, dy, 28, 9, OUT2)
        c.hline(bx + 3, dy + 1, 26, (255, 232, 130)); c.rect(bx + 14, dy + 4, 4, 1, (120, 96, 30))
    c.hline(bx + 1, 7, 30, (90, 86, 104))
    c.frame(bx, 6, 32, 56, OUT)
    # a speaker on top
    c.rect(bx + 3, 0, 8, 6, (60, 58, 74)); c.frame(bx + 2, -1, 10, 8, OUT); c.px(bx + 6, 2, (150, 150, 170))
    L.block(22, 3, 24, 3)

    # the front door: dark wood, brass 4C, peephole
    dx = 404
    door(c, dx, 6, 26, 42)
    c.rect(dx + 9, 10, 8, 5, (226, 190, 110)); c.frame(dx + 8, 9, 10, 7, OUT)
    c.text(dx + 10, 10, '4C', (90, 60, 40))
    c.px(dx + 13, 19, (30, 26, 36)); c.px(dx + 12, 19, (226, 190, 110))
    # door mat on the floor in front of it
    c.rect(dx - 2, 50, 30, 10, (120, 96, 70)); c.frame(dx - 2, 50, 30, 10, (84, 64, 52))
    for i in range(dx + 1, dx + 26, 4):
        c.px(i, 55, (184, 154, 110))

    # umbrella stand with THE yellow umbrella, between bookcase and door
    def umbrella(t):
        t.rect(1, 14, 8, 10, (96, 100, 122)); t.rect(2, 15, 6, 2, (60, 62, 84))
        t.vline(3, 17, 6, (136, 140, 160))
        t.rect(3, 2, 3, 14, (246, 204, 52)); t.vline(3, 3, 13, (255, 232, 120)); t.vline(5, 3, 13, (206, 160, 30))
        t.rect(4, 0, 1, 2, (120, 80, 58)); t.px(5, 0, (120, 80, 58)); t.px(6, 1, (120, 80, 58))
    P.stamp(c, umbrella, 393, 37, 10, 25)
    # coat hooks right of the door
    c.rect(433, 18, 5, 2, TRIM); c.frame(432, 17, 7, 4, OUT)
    c.rect(433, 20, 4, 14, (60, 84, 130)); c.vline(433, 21, 12, (90, 116, 160)); c.frame(432, 20, 6, 15, OUT)


def kitchen(L):
    """Immediately right of the front door: fridge first, then the counters;
    a breakfast counter closes the kitchen off from the living room."""
    c = L.bg
    # fridge, covered in photos
    fx = 444
    c.shadow(fx + 2, 62, 26, 2)
    c.rect(fx, 8, 28, 54, (232, 234, 238)); c.rect(fx + 1, 9, 26, 2, (252, 252, 254))
    c.hline(fx, 27, 28, OUT)
    c.rect(fx + 2, 15, 2, 9, (150, 156, 170)); c.rect(fx + 2, 31, 2, 16, (150, 156, 170))
    c.rect(fx + 23, 10, 4, 51, (200, 204, 214))
    for (qx, qy, col) in ((8, 32, (255, 240, 170)), (15, 31, (160, 200, 240)), (9, 41, (240, 170, 160)), (16, 40, (180, 226, 170)), (8, 13, (240, 170, 160)), (15, 14, (255, 240, 170))):
        c.rect(fx + qx, qy, 5, 6, col); c.frame(fx + qx, qy, 5, 6, OUT2)
    c.frame(fx, 8, 28, 54, OUT)
    L.extra['fridge'] = L.gpx(fx + 2, 30)

    # upper cabinets
    c.rect(476, 5, 60, 20, CAB); c.hline(477, 6, 58, (252, 246, 232))
    for dx in range(476, 536, 20):
        c.frame(dx, 5, 20, 20, OUT); c.frame(dx + 3, 8, 14, 14, CAB_D); c.rect(dx + 15, 15, 2, 3, TRIM)
    c.hline(476, 25, 60, (0, 0, 0), 70)
    # base counter with a dark top
    c.box(474, 36, 64, 14, 12, GRANITE, CAB, r=0)
    for i in range(476, 536, 5):
        c.px(i, 40 + (i % 3) * 2, (120, 118, 136))
    for dx in range(476, 536, 20):
        c.frame(dx, 51, 20, 10, CAB_D); c.rect(dx + 8, 53, 4, 1, TRIM)
    c.rrect(478, 38, 24, 10, (176, 184, 196), 1); c.rect(480, 40, 20, 6, (120, 130, 148)); c.rframe(478, 38, 24, 10, OUT, 1)
    c.rect(489, 33, 2, 7, (200, 206, 216)); c.rect(489, 33, 5, 2, (200, 206, 216)); c.frame(488, 32, 7, 4, OUT)
    c.rect(510, 38, 24, 11, (236, 236, 240)); c.frame(510, 38, 24, 11, OUT)
    for (sx, sy) in ((513, 40), (523, 40), (513, 45), (523, 45)):
        c.rect(sx, sy, 5, 3, (60, 60, 80)); c.px(sx + 2, sy + 1, (190, 80, 60))
    c.rect(511, 51, 22, 10, (236, 236, 240)); c.frame(510, 50, 24, 12, OUT)
    c.rect(514, 54, 16, 5, (60, 60, 80)); c.hline(513, 52, 18, (160, 164, 176))
    L.block(27, 3, 33, 3)

    # breakfast counter: row 8, tiles 28..33
    ix, iy = 452, 122
    c.box(ix, iy, 86, 16, 9, GRANITE, CAB, r=1)
    for i in range(ix + 4, ix + 82, 6):
        c.px(i, iy + 4 + (i % 3) * 3, (120, 118, 136))
    for dx in range(ix + 4, ix + 78, 26):
        c.frame(dx, iy + 17, 24, 7, CAB_D)
    L.block(28, 8, 33, 8)

    # the pineapple, and a bowl of green apples
    def pineapple(t):
        t.rect(1, 6, 6, 8, (232, 178, 60))
        for (qx, qy) in ((2, 7), (4, 9), (2, 11), (5, 12), (5, 7)):
            t.px(qx, qy, (176, 120, 40))
        t.vline(3, 2, 4, (88, 150, 84)); t.vline(4, 1, 5, (110, 176, 96))
        t.px(2, 3, (88, 150, 84)); t.px(5, 3, (110, 176, 96)); t.px(1, 4, (88, 150, 84)); t.px(6, 4, (88, 150, 84))
    P.stamp(c, pineapple, 527, iy - 5, 8, 14)
    c.rrect(ix + 3, iy + 5, 12, 6, (214, 120, 60), 2); c.rframe(ix + 3, iy + 5, 12, 6, OUT, 2)
    c.rect(ix + 5, iy + 3, 3, 3, (130, 196, 90)); c.rect(ix + 9, iy + 3, 3, 3, (150, 210, 100)); c.rect(ix + 7, iy + 2, 3, 3, (130, 196, 90))
    for (name, tx) in (('pc-2', 30), ('pc-9', 32)):
        cx = tx * T + 8
        scr = P.laptop_front(c, cx - 7, iy - 4)
        P.stool(c, cx - 6, 9 * T + 3)
        L.seat(name, tx, 9, 'up', screen=scr, cup=(cx - 15, iy + 12))


def sofa(c, x, y, w, base, lt, dk, pillows=()):
    """Three-seat sofa facing the viewer. 46px deep."""
    c.shadow(x + 2, y + 46, w - 2, 3)
    c.rrect(x, y, w, 46, base, 2)
    c.rrect(x + 8, y + 1, w - 16, 16, lt, 1)                     # back rest
    c.hline(x + 9, y + 2, w - 18, lighten(lt, 0.22))
    c.rect(x + 8, y + 13, w - 16, 4, base)
    third = (w - 16) // 3
    for sx in (x + 8 + third, x + 8 + 2 * third):
        c.vline(sx, y + 2, 15, dk)
    c.rect(x + 8, y + 17, w - 16, 20, lt)                        # seat
    c.hline(x + 8, y + 17, w - 16, dk); c.hline(x + 9, y + 18, w - 18, lighten(lt, 0.16))
    for sx in (x + 8 + third, x + 8 + 2 * third):
        c.vline(sx, y + 18, 19, dk)
    c.rect(x + 8, y + 37, w - 16, 7, base); c.hline(x + 8, y + 37, w - 16, dk); c.hline(x + 8, y + 43, w - 16, dk)
    for ax in (x, x + w - 8):
        c.rrect(ax, y + 4, 8, 40, base, 2)
        c.rect(ax + 1, y + 6, 6, 26, lt); c.hline(ax + 2, y + 6, 4, lighten(lt, 0.22))
        c.rframe(ax, y + 4, 8, 40, OUT, 2)
    c.rframe(x, y, w, 46, OUT, 2)
    c.rect(x + 3, y + 44, 3, 3, (70, 46, 46)); c.rect(x + w - 6, y + 44, 3, 3, (70, 46, 46))
    for (px_, col, dot) in pillows:
        c.rrect(px_, y + 19, 11, 9, col, 1); c.rframe(px_, y + 19, 11, 9, OUT, 1)
        c.hline(px_ + 2, y + 22, 7, dot); c.hline(px_ + 2, y + 25, 7, dot)


def armchair(c, x, y, base, lt, dk, faces='right'):
    """Club chair seen from above. 28x34."""
    c.shadow(x + 2, y + 34, 26, 3)
    c.rrect(x, y, 28, 34, base, 2)
    bx = x + 1 if faces == 'right' else x + 18
    sx = x + 10 if faces == 'right' else x + 2
    c.rrect(bx, y + 1, 9, 30, lt, 1); c.vline(bx + 1, y + 3, 26, lighten(lt, 0.22))
    c.rect(sx, y + 7, 16, 19, lt); c.frame(sx, y + 7, 16, 19, dk)
    ax = x + 8 if faces == 'right' else x
    c.rrect(ax, y + 1, 20, 6, base, 1); c.rframe(ax, y + 1, 20, 6, OUT, 1)
    c.rrect(ax, y + 26, 20, 6, base, 1); c.rframe(ax, y + 26, 20, 6, OUT, 1)
    c.hline(ax + 2, y + 2, 16, lt); c.hline(ax + 2, y + 27, 16, lt)
    c.rframe(x, y, 28, 34, OUT, 2)


def living_room(L):
    """The patchwork rug, the red couch facing the fourth wall, the coffee
    table, the red armchair and the leather club chair."""
    c = L.bg
    # ── rug: warm patchwork squares ──
    rx, ry, rw, rh = 172, 132, 168, 112
    cols = [(206, 120, 60), (170, 84, 52), (214, 168, 84), (132, 124, 70), (190, 70, 52), (226, 190, 130), (104, 78, 60)]
    c.rect(rx, ry, rw, rh, (150, 96, 60))
    for j in range(rh // 14):
        for i in range(rw // 14):
            col = cols[hash2(i, j, 5) % len(cols)]
            c.rect(rx + i * 14, ry + j * 14, 14, 14, col)
            c.frame(rx + i * 14, ry + j * 14, 14, 14, darken(col, 0.16))
            if hash2(i, j, 8) % 3 == 0:
                c.frame(rx + i * 14 + 3, ry + j * 14 + 3, 8, 8, lighten(col, 0.18))
    c.frame(rx, ry, rw, rh, (96, 62, 48))
    for i in range(rx + 1, rx + rw - 1, 3):
        c.px(i, ry - 1, (232, 220, 190)); c.px(i, ry + rh, (232, 220, 190))

    # ── the red couch: back row 9, seats row 10 (tiles 12..18) ──
    x, y = 192, 140
    sofa(c, x, y, 112, RED, RED_L, RED_D,
         pillows=((x + 10, (240, 196, 80), (200, 150, 50)), (x + 91, (226, 216, 196), (190, 110, 80))))
    L.block(12, 9, 18, 10)

    # ── coffee table: rows 12-13 ──
    tx, ty = 204, 198
    c.box(tx, ty, 88, 13, 6, (132, 86, 62), (96, 60, 50))
    c.rect(tx + 3, ty + 19, 3, 3, (70, 46, 46)); c.rect(tx + 82, ty + 19, 3, 3, (70, 46, 46))
    c.rect(tx + 21, ty + 6, 9, 5, (226, 216, 196)); c.frame(tx + 21, ty + 6, 9, 5, OUT2); c.hline(tx + 22, ty + 7, 7, (200, 90, 80))
    c.rect(tx + 54, ty + 8, 7, 3, (60, 60, 80))
    P.bottle(c, tx + 62, ty + 1)
    L.block(12, 12, 18, 13)
    for (name, t_) in (('pc-1', 15), ('pc-5', 13), ('pc-8', 17)):
        cx = t_ * T + 8
        lid = [None]

        def lap(t, cx=cx, lid=lid):
            lid[0] = P.laptop_back(t, cx - 7, ty - 6)
        L.tall(ty + 14, lap)
        L.seat(name, t_, 10, 'down', screen=lid[0], cup=(cx + 9, ty + 8), kind='lid',
               sit={'dx': 0, 'dy': 7, 'crop': 0})

    # ── the red armchair (right) and the leather club chair (left) ──
    armchair(c, 322, 186, RED, RED_L, RED_D, faces='left')
    c.rrect(327, 196, 9, 9, (226, 216, 196), 1); c.rframe(327, 196, 9, 9, OUT, 1); c.hline(329, 199, 5, (190, 110, 80))
    L.block(20, 12, 21, 13)
    armchair(c, 148, 186, (139, 84, 58), (166, 104, 70), (104, 60, 46), faces='right')
    L.block(9, 12, 10, 13)

    # ── end tables with lamps, either side of the couch ──
    for (ex, col) in ((172, (104, 170, 176)), (308, (132, 86, 62))):
        c.box(ex, 148, 18, 12, 6, col, darken(col, 0.3))
        L.tall(164, lambda t, ex=ex: P.table_lamp(t, ex + 9, 157, 0))
    L.block(11, 9); L.block(19, 9)


def dining(L):
    """The round wooden table just outside the kitchen."""
    c = L.bg
    cx, cy = 25 * T + 8, 9 * T + 8
    c.shadow(cx - 18, cy + 17, 37, 3)
    c.rect(cx - 2, cy + 8, 5, 12, (110, 72, 54)); c.frame(cx - 3, cy + 7, 7, 14, OUT)
    c.ellipse(cx, cy + 3, 22, 16, OUT)
    c.ellipse(cx, cy + 3, 21, 15, (160, 108, 70))
    c.ellipse(cx, cy, 21, 14, (214, 160, 100))
    c.hline(cx - 12, cy - 11, 22, (236, 190, 130))
    for r_ in (9, 15):
        c.ring(cx, cy, r_, int(r_ * 0.66), (196, 142, 88), 1)
    L.block(24, 9, 26, 9); L.block(25, 10)
    # north chair faces down; south chair faces up
    P.chair_back_rear(c, cx - 6, 8 * T - 6)
    lid = [None]

    def lap(t):
        lid[0] = P.laptop_back(t, cx - 7, cy - 15)
    L.tall(cy + 2, lap)
    L.seat('pc-6', 25, 8, 'down', screen=lid[0], kind='lid')
    scr = P.laptop_front(c, cx - 7, cy + 1)
    P.chair_seat(c, cx - 6, 11 * T + 2)
    L.tall(11 * T + 22, lambda t: P.chair_back_front(t, cx - 6, 11 * T + 9))
    L.seat('pc-11', 25, 11, 'up', screen=scr, cup=(cx + 10, cy + 2))


def desk_up(L, name, tx, ty, w=44, top=(214, 160, 100), front=(160, 108, 70), deco=None, chair=True, kind='laptop'):
    """A work desk for a seat that faces UP. Desk fills the row above the seat."""
    c = L.bg
    cx = tx * T + 8
    x, y = cx - w // 2, (ty - 1) * T - 6
    c.box(x, y, w, 16, 7, top, front)
    c.rect(x + 2, y + 23, 3, 3, darken(front, 0.2)); c.rect(x + w - 5, y + 23, 3, 3, darken(front, 0.2))
    if kind == 'monitor':
        scr = P.monitor(c, cx - 10, y - 12)
    else:
        scr = P.laptop_front(c, cx - 7, y - 3)
    if deco:
        deco(c, x, y, w)
    if chair:
        P.chair_seat(c, cx - 6, ty * T + 2)
        L.tall(ty * T + 22, lambda t: P.chair_back_front(t, cx - 6, ty * T + 9))
    L.block(x // T, ty - 1, (x + w - 1) // T, ty - 1)
    L.seat(name, tx, ty, 'up', screen=scr, cup=(cx + 10, y + 11), kind=kind)
    return x, y


def left_side(L):
    """The upright piano on the left wall, Marshall's desk, Lily's easel."""
    c = L.bg
    px_, py_ = 7, 100
    c.shadow(px_ + 2, py_ + 56, 22, 3)
    c.rect(px_, py_, 16, 56, (40, 36, 48)); c.rect(px_ + 1, py_ + 1, 6, 54, (66, 60, 78))
    c.vline(px_ + 1, py_ + 1, 54, (104, 98, 120))
    c.rect(px_ + 16, py_ + 4, 7, 48, (250, 246, 238))
    for i in range(py_ + 6, py_ + 51, 3):
        c.hline(px_ + 16, i, 7, (200, 196, 190))
    for i in range(py_ + 6, py_ + 50, 6):
        c.rect(px_ + 16, i, 4, 2, (40, 36, 50))
    c.frame(px_ + 16, py_ + 4, 8, 48, OUT); c.frame(px_, py_, 17, 56, OUT)
    c.rect(px_ + 9, py_ + 20, 6, 14, (250, 246, 238)); c.frame(px_ + 9, py_ + 20, 6, 14, OUT2)
    for i in range(py_ + 23, py_ + 33, 3):
        c.vline(px_ + 11, i, 2, (90, 90, 110)); c.vline(px_ + 13, i, 2, (90, 90, 110))
    c.rect(px_ + 4, py_ + 44, 3, 5, (200, 52, 48)); c.rect(px_ + 4, py_ + 8, 3, 5, (200, 52, 48))    # red candles on top
    c.box(px_ + 28, py_ + 20, 10, 16, 4, (50, 46, 60), (36, 32, 44))
    L.block(0, 6, 1, 9); L.block(2, 7, 2, 8)

    def marshall(c_, x, y, w):
        for i, col in enumerate(((120, 52, 50), (60, 84, 60), (120, 52, 50))):
            c_.rect(x + 3, y + 9 - i * 3, 10, 3, col); c_.frame(x + 3, y + 9 - i * 3, 10, 3, OUT)
            c_.px(x + 5, y + 10 - i * 3, (226, 190, 110))
        c_.rect(x + w - 11, y + 1, 8, 3, (70, 150, 100)); c_.frame(x + w - 12, y, 10, 5, OUT)
        c_.vline(x + w - 7, y + 5, 5, (226, 190, 110)); c_.rect(x + w - 10, y + 10, 7, 2, (226, 190, 110))
    desk_up(L, 'pc-3', 3, 16, deco=marshall, top=(132, 86, 62), front=(96, 60, 50))

    def lily(c_, x, y, w):
        for i, col in enumerate(((226, 90, 70), (240, 190, 70), (80, 140, 220), (110, 176, 96))):
            c_.rect(x + 3 + i * 4, y + 9, 3, 4, col); c_.frame(x + 2 + i * 4, y + 8, 5, 6, OUT)
        c_.line(x + w - 8, y + 11, x + w - 4, y + 3, (226, 216, 196))
    desk_up(L, 'pc-7', 8, 16, deco=lily, top=(236, 228, 208), front=(190, 176, 150))

    def easel(t):
        t.line(4, 30, 9, 2, (150, 104, 72)); t.line(18, 30, 13, 2, (150, 104, 72)); t.line(11, 30, 11, 4, (120, 80, 58))
        t.rect(2, 6, 18, 16, (250, 246, 238)); t.frame(2, 6, 18, 16, OUT)
        t.rect(4, 14, 14, 6, (110, 176, 96)); t.rect(4, 8, 14, 6, (140, 190, 232))
        t.ellipse(14, 10, 2, 2, (255, 220, 120)); t.rect(7, 12, 3, 5, (150, 96, 60)); t.ellipse(8, 11, 3, 2, (70, 140, 84))
        t.hline(1, 22, 20, (150, 104, 72)); t.hline(1, 23, 20, OUT)
    L.tall(272, easel, x=164, y=240)
    L.block(10, 15, 11, 16)

    L.tall(340, lambda t: P.potted_plant(t, 24, 340, 0))
    L.block(1, 20)


def fourth_wall(L):
    """Along the bottom edge — the side the audience sits on: the TV on its
    console (seen from behind), Robin's desk, a plant, the bin."""
    c = L.bg
    tx, ty = 208, 306
    c.box(tx, ty, 96, 12, 10, (132, 86, 62), (96, 60, 50))
    for dx in range(tx + 4, tx + 90, 30):
        c.frame(dx, ty + 13, 28, 7, (70, 46, 46))

    def tv(t):
        t.rrect(0, 0, 50, 22, (40, 38, 52), 1)
        t.rect(2, 2, 46, 3, (70, 68, 88))
        t.rect(20, 9, 10, 6, (58, 56, 74)); t.rect(8, 16, 34, 1, (58, 56, 74))
        t.rframe(0, 0, 50, 22, OUT, 1)
        t.rect(19, 22, 12, 3, (70, 68, 88)); t.frame(18, 22, 14, 4, OUT)
    L.tall(ty + 22, tv, x=tx + 23, y=ty - 16)
    L.block(13, 19, 18, 20)

    def robin(c_, x, y, w):
        c_.vline(x + 5, y + 1, 9, (120, 120, 140)); c_.rect(x + 6, y + 1, 7, 5, (250, 246, 238))
        c_.rect(x + 6, y + 1, 2, 5, (214, 60, 60)); c_.rect(x + 11, y + 1, 2, 5, (214, 60, 60)); c_.px(x + 9, y + 3, (214, 60, 60))
        c_.frame(x + 5, y, 9, 7, OUT)
        c_.rect(x + w - 9, y + 6, 3, 6, (70, 70, 94)); c_.ellipse(x + w - 8, y + 4, 2, 2, (150, 156, 172))
    desk_up(L, 'pc-10', 28, 16, deco=robin, kind='monitor', top=(214, 160, 100))

    # red cowboy boots by the console
    def boots(t):
        for bx in (0, 7):
            t.rect(bx + 1, 0, 4, 7, (196, 52, 48)); t.rect(bx, 6, 6, 3, (196, 52, 48)); t.px(bx + 2, 2, (240, 120, 100))
            t.hline(bx, 9, 6, (90, 40, 44))
    P.stamp(c, boots, 190, 326, 13, 10)

    L.tall(340, lambda t: P.potted_plant(t, 520, 340, 2))
    L.block(32, 20)
    P.trash_bin(c, 323, 324)
    L.block(20, 20)
