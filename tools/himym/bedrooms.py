"""The two bedrooms off the apartment's hall door: Ted's (left) and Marshall &
Lily's (right), with the little hallway that joins them. 544x352 (34x22 tiles).
"""
from px import T, OUT, OUT2, lighten, darken
from world import hash2
import props as P
from apartment import plaster, door, desk_up, blinds_window, TRIM

W, H = 34 * T, 22 * T


def bed(c, x, y, w, h, blanket, pillow, n=2, fold=None):
    """A bed seen from above, headboard at the top."""
    c.shadow(x + 2, y + h, w - 2, 3)
    c.rrect(x, y, w, h, (236, 232, 222), 2)
    c.rect(x, y, w, 7, (112, 68, 52)); c.hline(x + 1, y + 1, w - 2, (156, 104, 76))      # headboard
    pw = (w - 8 - (n - 1) * 3) // n
    for i in range(n):
        px_ = x + 4 + i * (pw + 3)
        c.rrect(px_, y + 9, pw, 11, pillow, 2); c.hline(px_ + 2, y + 10, pw - 4, lighten(pillow, 0.3))
        c.rframe(px_, y + 9, pw, 11, OUT2, 2)
    c.rect(x + 1, y + 24, w - 2, h - 26, blanket)
    c.rect(x + 1, y + 24, w - 2, 6, fold or lighten(blanket, 0.3))
    c.hline(x + 1, y + 30, w - 2, darken(blanket, 0.25))
    for i in range(x + 8, x + w - 6, 12):
        c.vline(i, y + 34, h - 40, darken(blanket, 0.1))
    c.rect(x, y + h - 4, w, 4, (112, 68, 52))
    c.rframe(x, y, w, h, OUT, 2)


def poster(c, x, y, w, h, bg, fg, art):
    c.rect(x, y, w, h, bg); c.frame(x, y, w, h, OUT)
    art(c, x, y, fg)


def paint(L):
    c = L.bg
    P.wood_floor(c, 6, 48, W - 12, H - 60, base=(182, 132, 86), seed=44)
    plaster(c, 6, W - 12)
    P.room_shell(c, W, H, wall_top=(226, 214, 196), door=(256, 288))
    # the wall between the rooms, with the hall left open below it
    c.rect(266, 0, 12, 240, (226, 214, 196)); c.frame(266, -1, 12, 242, OUT)
    c.vline(267, 0, 240, (252, 246, 236)); c.rect(266, 236, 12, 4, TRIM)
    c.rect(278, 48, 3, 190, (20, 12, 30), 34)
    L.block(16, 0, 17, 14)
    L.block(0, 0, 33, 2)

    # ── Ted's room ───────────────────────────────────────────────────────────
    blinds_window(c, 26, 3, 44, 38, drop=12, seed=14)
    # the Star Wars corner: two posters
    def xwing(c_, x, y, fg):
        c_.line(x + 4, y + 16, x + 20, y + 6, fg); c_.line(x + 4, y + 6, x + 20, y + 16, fg)
        c_.rect(x + 10, y + 9, 5, 4, fg); c_.px(x + 6, y + 4, (255, 240, 170)); c_.px(x + 18, y + 20, (255, 240, 170))
    def helmet(c_, x, y, fg):
        c_.ellipse(x + 11, y + 12, 7, 8, fg); c_.rect(x + 5, y + 11, 13, 3, (30, 30, 40))
        c_.rect(x + 8, y + 16, 7, 3, (30, 30, 40)); c_.px(x + 11, y + 17, fg)
    poster(c, 84, 5, 25, 26, (20, 22, 44), (220, 226, 240), xwing)
    poster(c, 114, 5, 23, 26, (30, 30, 40), (240, 240, 244), helmet)
    bed(c, 150, 44, 60, 84, (44, 62, 120), (200, 56, 52), n=2, fold=(200, 56, 52))
    L.block(9, 3, 13, 7)
    c.box(214, 50, 18, 12, 6, (132, 86, 62), (96, 60, 50))                              # nightstand
    L.tall(66, lambda t: P.table_lamp(t, 223, 59, 0))
    L.block(13, 3, 14, 3)
    P.bookshelf(c, 232, 6, 30, 56, wood=(120, 76, 56), shelves=4, seed=91)             # architecture books
    L.block(14, 3, 15, 3)

    def ted(c_, x, y, w):
        c_.rect(x + 3, y + 3, 14, 9, (74, 122, 196)); c_.frame(x + 3, y + 3, 14, 9, (44, 78, 150))
        c_.frame(x + 7, y + 4, 5, 7, (236, 244, 255))
    desk_up(L, 'room-1', 3, 8, w=46, deco=ted, top=(226, 190, 124), front=(168, 118, 76))
    # rug + a guitar on a stand + laundry basket
    c.rect(60, 150, 96, 56, (58, 64, 110)); c.frame(60, 150, 96, 56, (34, 38, 70)); c.frame(63, 153, 90, 50, (214, 168, 84))
    def guitar(t):
        t.ellipse(6, 20, 5, 6, (190, 120, 60)); t.ellipse(6, 13, 4, 4, (190, 120, 60)); t.px(6, 19, (40, 30, 30))
        t.rect(5, 0, 2, 12, (90, 60, 46)); t.rect(4, 0, 4, 3, (60, 44, 40))
    L.tall(228, lambda t: P.stamp(t, guitar, 228, 200, 12, 27))
    L.block(14, 13)
    L.tall(338, lambda t: P.potted_plant(t, 24, 338, 0))
    L.block(1, 20)

    # ── Marshall & Lily's room ───────────────────────────────────────────────
    blinds_window(c, 470, 3, 44, 38, drop=8, seed=15)
    # Lily's paintings
    for (px_, col, col2) in ((300, (236, 150, 170), (120, 176, 96)), (328, (140, 190, 232), (240, 196, 80))):
        c.rect(px_, 7, 22, 20, (226, 190, 110)); c.rect(px_ + 2, 9, 18, 16, col); c.frame(px_, 7, 22, 20, OUT)
        c.ellipse(px_ + 11, px_ % 7 + 15, 4, 4, col2)
    bed(c, 366, 44, 84, 88, (214, 120, 60), (250, 246, 238), n=2, fold=(240, 196, 80))
    for i in range(372, 446, 14):                                                       # quilt squares
        for j in range(84, 124, 14):
            c.frame(i, j, 12, 12, (170, 84, 52))
    L.block(22, 3, 28, 8)
    for nx in (346, 454):
        c.box(nx, 50, 16, 12, 6, (132, 86, 62), (96, 60, 50))
    L.tall(66, lambda t: P.table_lamp(t, 354, 59, 1))
    L.tall(66, lambda t: P.table_lamp(t, 462, 59, 1))
    # wardrobe on the right wall, dresser at the foot
    c.shadow(508, 150, 28, 3)
    c.rect(506, 76, 30, 74, (132, 86, 62)); c.frame(506, 76, 30, 74, OUT); c.hline(507, 77, 28, (170, 116, 82))
    c.vline(521, 78, 70, (96, 60, 50)); c.rect(518, 110, 2, 5, (226, 190, 110)); c.rect(523, 110, 2, 5, (226, 190, 110))
    L.block(31, 4, 32, 9)
    c.rect(330, 160, 150, 60, (150, 58, 58)); c.frame(330, 160, 150, 60, (104, 40, 44)); c.frame(334, 164, 142, 52, (214, 168, 84))

    def lily(c_, x, y, w):
        c_.rect(x + 4, y - 6, 12, 12, (170, 206, 226)); c_.frame(x + 3, y - 7, 14, 14, (226, 190, 110))      # mirror
        for i, col in enumerate(((226, 90, 70), (240, 190, 70), (150, 96, 150))):
            c_.rect(x + w - 16 + i * 4, y + 8, 3, 4, col)
    desk_up(L, 'room-2', 30, 16, w=46, deco=lily, top=(236, 228, 208), front=(190, 176, 150))
    L.tall(338, lambda t: P.potted_plant(t, 520, 338, 2))
    L.block(32, 20)

    # ── the hall: the way back to the living room ────────────────────────────
    c.rect(250, 318, 44, 16, (120, 96, 70)); c.frame(250, 318, 44, 16, (84, 64, 52))
    L.spawn('entrance', 16, 20)
    L.free(16, 21, 17, 21)
    L.door(16, 21)
    L.errand('water', (2, 20), 'left', (1, 20), 4.5)
    L.errand('shelf', (15, 4), 'up', (15, 2), 4)
