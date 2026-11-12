"""Pixel-painting toolkit for the HIMYM world (tools/himym).

Everything in the HIMYM theme's backdrop is painted by code onto one RGBA
canvas, pixel by pixel: a (58,58,80) outline, a top surface + front face
for every piece of furniture, three-tone shading, no anti-aliasing.

Every pixel here is original work; nothing is lifted from a third-party pack.
"""
from PIL import Image
import os

T = 16
OUT = (58, 58, 80)          # LimeZu outline
OUT2 = (70, 70, 94)
HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.abspath(os.path.join(HERE, '..', '..', 'src', 'renderer', 'src', 'assets'))


def rgb(h):
    h = h.lstrip('#')
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def mix(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def lighten(c, t=0.2):
    return mix(c, (255, 255, 255), t)


def darken(c, t=0.2):
    return mix(c, (30, 22, 40), t)


class Canvas:
    def __init__(self, w, h, ox=0, oy=0, img=None):
        self.w, self.h = w, h
        self.img = img if img is not None else Image.new('RGBA', (w, h), (0, 0, 0, 0))
        self.ox, self.oy = ox, oy
        self.p = self.img.load()

    def sub(self, ox, oy):
        """A view of the same pixels with a shifted origin (for one location)."""
        return Canvas(self.w, self.h, self.ox + ox, self.oy + oy, self.img)

    # ── primitives ──────────────────────────────────────────────────────────
    def px(self, x, y, c, a=255):
        x += self.ox; y += self.oy
        if 0 <= x < self.w and 0 <= y < self.h:
            if a >= 255:
                self.p[x, y] = (c[0], c[1], c[2], 255)
            else:
                o = self.p[x, y]
                if o[3] == 0:
                    self.p[x, y] = (c[0], c[1], c[2], a)
                else:
                    t = a / 255.0
                    self.p[x, y] = (int(o[0] + (c[0] - o[0]) * t), int(o[1] + (c[1] - o[1]) * t),
                                    int(o[2] + (c[2] - o[2]) * t), o[3])

    def get(self, x, y):
        x += self.ox; y += self.oy
        if 0 <= x < self.w and 0 <= y < self.h:
            return self.p[x, y]
        return (0, 0, 0, 0)

    def rect(self, x, y, w, h, c, a=255):
        for yy in range(y, y + h):
            for xx in range(x, x + w):
                self.px(xx, yy, c, a)

    def hline(self, x, y, w, c, a=255):
        self.rect(x, y, w, 1, c, a)

    def vline(self, x, y, h, c, a=255):
        self.rect(x, y, 1, h, c, a)

    def frame(self, x, y, w, h, c=OUT, a=255):
        self.hline(x, y, w, c, a); self.hline(x, y + h - 1, w, c, a)
        self.vline(x, y, h, c, a); self.vline(x + w - 1, y, h, c, a)

    def rrect(self, x, y, w, h, c, r=1):
        """Filled rect with r-px chamfered corners."""
        for yy in range(h):
            inset = 0
            if yy < r: inset = r - yy
            elif yy >= h - r: inset = r - (h - 1 - yy)
            self.hline(x + inset, y + yy, w - 2 * inset, c)

    def rframe(self, x, y, w, h, c=OUT, r=1):
        """Outline matching rrect."""
        self.hline(x + r, y, w - 2 * r, c); self.hline(x + r, y + h - 1, w - 2 * r, c)
        self.vline(x, y + r, h - 2 * r, c); self.vline(x + w - 1, y + r, h - 2 * r, c)
        for i in range(1, r):
            self.px(x + r - i, y + i, c); self.px(x + w - 1 - r + i, y + i, c)
            self.px(x + r - i, y + h - 1 - i, c); self.px(x + w - 1 - r + i, y + h - 1 - i, c)

    def line(self, x0, y0, x1, y1, c, a=255):
        dx = abs(x1 - x0); dy = -abs(y1 - y0)
        sx = 1 if x0 < x1 else -1; sy = 1 if y0 < y1 else -1
        err = dx + dy
        while True:
            self.px(x0, y0, c, a)
            if x0 == x1 and y0 == y1: break
            e2 = 2 * err
            if e2 >= dy: err += dy; x0 += sx
            if e2 <= dx: err += dx; y0 += sy

    def ellipse(self, cx, cy, rx, ry, c, a=255):
        for yy in range(-ry, ry + 1):
            for xx in range(-rx, rx + 1):
                if (xx * xx) / float(rx * rx + 0.01) + (yy * yy) / float(ry * ry + 0.01) <= 1.0:
                    self.px(cx + xx, cy + yy, c, a)

    def ring(self, cx, cy, rx, ry, c, th=1):
        for yy in range(-ry, ry + 1):
            for xx in range(-rx, rx + 1):
                d = (xx * xx) / float(rx * rx + 0.01) + (yy * yy) / float(ry * ry + 0.01)
                irx, iry = max(rx - th, 0.5), max(ry - th, 0.5)
                di = (xx * xx) / float(irx * irx) + (yy * yy) / float(iry * iry)
                if d <= 1.0 and di > 1.0:
                    self.px(cx + xx, cy + yy, c)

    def shadow(self, x, y, w, h, a=46):
        self.rect(x, y, w, h, (24, 16, 36), a)

    def dither(self, x, y, w, h, c, phase=0, a=255):
        for yy in range(y, y + h):
            for xx in range(x, x + w):
                if (xx + yy + phase) % 2 == 0:
                    self.px(xx, yy, c, a)

    # ── compound shapes ─────────────────────────────────────────────────────
    def box(self, x, y, w, ht, hf, top, front=None, hi=None, edge=True, shadow=True, r=1):
        """A 3/4-view block: top surface `ht` tall over a front face `hf` tall.
        Outlined, with a highlight along the top's far edge and a darker lip
        where the top meets the front."""
        front = front or darken(top, 0.22)
        hi = hi or lighten(top, 0.22)
        h = ht + hf
        if shadow:
            self.shadow(x + 1, y + h, w - 1, 2)
        self.rrect(x, y, w, h, front, r)
        self.rect(x + 1, y + 1, w - 2, ht - 1, top)
        self.hline(x + 2, y + 1, w - 4, hi)
        if hf > 0:
            self.hline(x + 1, y + ht, w - 2, darken(top, 0.1))
            self.vline(x + w - 2, y + ht + 1, max(hf - 2, 0), darken(front, 0.14))
        if edge:
            self.rframe(x, y, w, h, OUT, r)

    def blit(self, im, x, y):
        """Paste an RGBA PIL image, alpha-aware (binary alpha)."""
        q = im.load()
        for yy in range(im.height):
            for xx in range(im.width):
                c = q[xx, yy]
                if c[3] > 0:
                    self.px(x + xx, y + yy, c[:3], c[3])

    def text(self, x, y, s, c, shadow=None):
        """3x5 pixel caps."""
        cx = x
        for ch in s.upper():
            g = FONT.get(ch)
            if g is None:
                cx += 2
                continue
            for r, row in enumerate(g):
                for i, b in enumerate(row):
                    if b == '#':
                        if shadow: self.px(cx + i, y + r + 1, shadow)
                        self.px(cx + i, y + r, c)
            cx += len(g[0]) + 1
        return cx


def text_w(s):
    w = 0
    for ch in s.upper():
        g = FONT.get(ch)
        w += (len(g[0]) + 1) if g else 2
    return w - 1


_F = {
    'A': ['.#.', '#.#', '###', '#.#', '#.#'], 'B': ['##.', '#.#', '##.', '#.#', '##.'],
    'C': ['.##', '#..', '#..', '#..', '.##'], 'D': ['##.', '#.#', '#.#', '#.#', '##.'],
    'E': ['###', '#..', '##.', '#..', '###'], 'F': ['###', '#..', '##.', '#..', '#..'],
    'G': ['.##', '#..', '#.#', '#.#', '.##'], 'H': ['#.#', '#.#', '###', '#.#', '#.#'],
    'I': ['#', '#', '#', '#', '#'], 'J': ['..#', '..#', '..#', '#.#', '.#.'],
    'K': ['#.#', '#.#', '##.', '#.#', '#.#'], 'L': ['#..', '#..', '#..', '#..', '###'],
    'M': ['#...#', '##.##', '#.#.#', '#...#', '#...#'], 'N': ['#..#', '##.#', '#.##', '#..#', '#..#'],
    'O': ['.#.', '#.#', '#.#', '#.#', '.#.'], 'P': ['##.', '#.#', '##.', '#..', '#..'],
    'Q': ['.#.', '#.#', '#.#', '.#.', '..#'], 'R': ['##.', '#.#', '##.', '#.#', '#.#'],
    'S': ['.##', '#..', '.#.', '..#', '##.'], 'T': ['###', '.#.', '.#.', '.#.', '.#.'],
    'U': ['#.#', '#.#', '#.#', '#.#', '###'], 'V': ['#.#', '#.#', '#.#', '#.#', '.#.'],
    'W': ['#...#', '#...#', '#.#.#', '##.##', '#...#'], 'X': ['#.#', '#.#', '.#.', '#.#', '#.#'],
    'Y': ['#.#', '#.#', '.#.', '.#.', '.#.'], 'Z': ['###', '..#', '.#.', '#..', '###'],
    '0': ['###', '#.#', '#.#', '#.#', '###'], '1': ['.#', '##', '.#', '.#', '.#'],
    '2': ['##.', '..#', '.#.', '#..', '###'], '3': ['##.', '..#', '.#.', '..#', '##.'],
    '4': ['#.#', '#.#', '###', '..#', '..#'], '5': ['###', '#..', '##.', '..#', '##.'],
    '6': ['.##', '#..', '###', '#.#', '###'], '7': ['###', '..#', '.#.', '.#.', '.#.'],
    '8': ['###', '#.#', '###', '#.#', '###'], '9': ['###', '#.#', '###', '..#', '##.'],
    "'": ['#', '#', '.', '.', '.'], '.': ['.', '.', '.', '.', '#'], '!': ['#', '#', '#', '.', '#'],
    '-': ['...', '...', '###', '...', '...'], '?': ['##.', '..#', '.#.', '...', '.#.'],
    '&': ['.#.', '#.#', '.#.', '#.#', '.##'], ':': ['.', '#', '.', '#', '.'],
}
FONT = _F
