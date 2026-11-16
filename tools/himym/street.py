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


IRON = (22, 20, 32)
STONE = (150, 146, 150)
STONE_D = (104, 100, 108)
STONE_L = (186, 182, 186)
WARM = (255, 214, 130)

# The geometry the rest of the project walks on. One source of truth: export.py
# writes it beside the PNG and the website reads it from there, so a character
# never climbs a staircase that has moved.
#
# Proportions are deliberate. Ted's apartment is the building — a tall, bright
# residential floor across the whole frontage. MacLaren's is a small corner bar
# tucked underneath it: a narrow shopfront, two windows and one door, taking up
# well under half the facade. You should be able to tell which is which with
# the sign painted out.
PAVE_Y = 240          # top of the pavement — unchanged, the cast stands on 264
FLOOR_LINE = 150      # the cornice between the pub and the apartment above it
APT_TOP, APT_BOT = 34, 118          # the apartment windows' band
PUB_X0, PUB_X1 = 64, 268            # the whole of the pub's frontage
PUB_DOOR_X = 166      # centre of the pub door, at the bottom of its own steps
PUB_DOOR_TOP, PUB_DOOR_W = 206, 24   # the door leaf: its head, above the pavement, and its width
NEON_SHAMROCK = (96, 198)            # the green ring in the left window
NEON_GLASS = (237, 192)              # the pink-and-cyan beer glass in the right one (its top-left)
# MacLaren's is a basement bar: you go DOWN to it. The steps run along the
# front of the building, dropping from the pavement on the left to a small
# landing in front of the door, inside a well cut into the back of the paving.
PUB_STEP_X0, PUB_STEP_X1 = 124, 148  # the flight: four treads, left to right
PUB_WELL_X1 = 193                    # the far end of the landing
PUB_DROP = 18                        # how far below the pavement the landing is
PUB_LIP = PAVE_Y + PUB_DROP + 1      # the kerb along the street side of the well
PUB_RAIL_H = 18                      # the green guard railing standing on that kerb
RAIL_G, RAIL_GL, RAIL_GD = (29, 101, 75), (52, 120, 91), (16, 59, 46)
DOOR_G = (21, 84, 63)
STAIR_X0, STAIR_X1 = 396, 492       # where the stoop starts and reaches the landing
STAIR_TOP = 186       # the landing surface
LANDING_X1 = 540
APT_DOOR_X = 514      # centre of Ted's door, at the top of the stoop

# A tread's line is its BACK edge; a climber stands STEP_DEPTH in front of it,
# which is the depth the stoop is drawn with. The guardrail is the same
# ironwork on both sides: the far one against the building is painted into the
# elevation, the near one into the overlay, so a climber passes between them.
STEP_DEPTH = 12
RAIL_H = 22           # handrail height — chest-high on a climber, not overhead
MAILBOX_X = 346       # free-standing collection box, clear of every walked line

ANCHORS = {
    'paveY': PAVE_Y,
    'floorLine': FLOOR_LINE,
    # the door is below the pavement, at the foot of the pub's own steps
    'pubDoor': {'x': PUB_DOOR_X, 'y': PAVE_Y + PUB_DROP, 'top': PUB_DOOR_TOP, 'w': PUB_DOOR_W},
    # the way down to it: the flight, the landing, the kerb that hides a
    # descender's legs, and the part of the overlay that is this railing
    'pubSteps': {'x0': PUB_STEP_X0, 'y0': PAVE_Y, 'x1': PUB_STEP_X1, 'y1': PAVE_Y + PUB_DROP,
                 'landingX1': PUB_WELL_X1, 'lip': PUB_LIP,
                 'ov': {'x': 112, 'y': PUB_LIP - PUB_RAIL_H - 10, 'w': 90, 'h': PUB_RAIL_H + 14}},
    'pubFront': {'x0': PUB_X0, 'x1': PUB_X1},
    'stair': {'x0': STAIR_X0, 'y0': PAVE_Y, 'x1': STAIR_X1, 'y1': STAIR_TOP},
    'landing': {'x0': STAIR_X1, 'x1': LANDING_X1, 'y': STAIR_TOP},
    'apartmentDoor': {'x': APT_DOOR_X, 'y': STAIR_TOP},
    'apartmentWindows': [{'x': 26, 'y': APT_TOP, 'w': 104, 'h': APT_BOT - APT_TOP},
                         {'x': 150, 'y': APT_TOP, 'w': 104, 'h': APT_BOT - APT_TOP},
                         {'x': 274, 'y': APT_TOP, 'w': 104, 'h': APT_BOT - APT_TOP}],
    'pubWindows': [{'x': 74, 'y': 186, 'w': 70, 'h': 50}, {'x': 188, 'y': 186, 'w': 70, 'h': 50}],
    # the two neon signs in the pub windows, which the desktop app makes buzz
    'neons': {'shamrock': {'x': NEON_SHAMROCK[0], 'y': NEON_SHAMROCK[1]},
              'glass': {'x': NEON_GLASS[0] + 6, 'y': NEON_GLASS[1] + 8}},
    'mailbox': {'x': MAILBOX_X, 'y': PAVE_Y + 2, 'w': 22, 'h': 34},
    # where a Carl sprite is drawn behind the left window, so he appears to be
    # working the bar rather than being painted into the brickwork
    'carl': {'x': 96, 'y': 200},
}


def stair_slope_at(x):
    """The straight line of the flight. A handrail runs up this, not up the
    stepped surface underfoot — follow the steps instead and the rail breaks
    into disconnected pieces at every riser."""
    if x <= STAIR_X0:
        return PAVE_Y
    if x >= STAIR_X1:
        return STAIR_TOP
    t = (x - STAIR_X0) / float(STAIR_X1 - STAIR_X0)
    return int(round(PAVE_Y + (STAIR_TOP - PAVE_Y) * t))


def stair_top_at(x):
    """The surface of the stoop at a given x: the steps, then the landing."""
    if x < STAIR_X0:
        return PAVE_Y
    if x >= STAIR_X1:
        return STAIR_TOP
    step = (x - STAIR_X0) * 9 // (STAIR_X1 - STAIR_X0)
    return PAVE_Y - step * 6


def apartment_window(c, x, y, w, h, contents):
    """A tall upper-floor window with Ted's apartment lit behind it."""
    c.rect(x - 4, y - 4, w + 8, h + 8, (124, 120, 126)); c.frame(x - 4, y - 4, w + 8, h + 8, OUT)
    c.rect(x, y, w, h, (250, 210, 138))                       # lamplight on the far wall
    c.rect(x, y, w, h // 5, (253, 228, 168))
    contents(c, x, y, w, h)
    c.vline(x + w // 2, y, h, (124, 120, 126))                # glazing bars, over the room
    c.hline(x, y + h // 3, w, (124, 120, 126))
    c.frame(x, y, w, h, (84, 80, 88))
    c.rect(x - 7, y + h + 4, w + 14, 5, (176, 170, 166)); c.frame(x - 7, y + h + 4, w + 14, 5, OUT)
    c.rect(x - 6, y - 12, w + 12, 8, (176, 170, 166)); c.frame(x - 6, y - 12, w + 12, 8, OUT)


def _red_couch(c, x, y, w, h):
    """Ted's red couch, the thing you should see first."""
    by = y + h - 26
    c.rect(x + 10, by, w - 20, 18, (188, 52, 44)); c.frame(x + 10, by, w - 20, 18, OUT)
    c.rect(x + 10, by - 14, w - 20, 15, (206, 70, 58)); c.frame(x + 10, by - 14, w - 20, 15, OUT)
    c.rect(x + 6, by - 9, 8, 23, (166, 42, 38)); c.frame(x + 6, by - 9, 8, 23, OUT)
    c.rect(x + w - 14, by - 9, 8, 23, (166, 42, 38)); c.frame(x + w - 14, by - 9, 8, 23, OUT)
    for cx_ in (x + 20, x + w - 34):                           # cushions catching the light
        c.rect(cx_, by - 10, 13, 9, (226, 110, 92))
    c.rect(x + 4, y + h - 4, w - 8, 4, (120, 86, 58))          # the rug line under it


def _horn_and_shelf(c, x, y, w, h):
    """The blue French horn on the wall, bookshelves under it."""
    P.bookshelf(c, x + 6, y + h - 46, w - 34, 42, shelves=3, seed=4, top_items=False)
    bx, by = x + w - 18, y + 20
    blue = (0, 102, 204)
    c.ring(bx, by, 9, 9, blue, 2)                              # the coil
    c.ring(bx, by, 4, 4, blue, 1)
    c.rect(bx + 7, by - 6, 5, 13, blue); c.rect(bx + 10, by - 8, 4, 17, blue)   # the bell
    c.line(bx - 8, by - 8, bx - 13, by - 3, blue)              # the lead pipe
    c.px(bx - 14, by - 2, blue)


def _lamp_and_table(c, x, y, w, h):
    c.rect(x + 12, y + h - 26, 20, 24, (120, 84, 60)); c.frame(x + 12, y + h - 26, 20, 24, OUT)
    c.rect(x + 9, y + h - 34, 26, 9, (146, 104, 74)); c.frame(x + 9, y + h - 34, 26, 9, OUT)
    P.mug(c, x + 18, y + h - 40)
    c.rect(x + w - 22, y + h - 34, 4, 32, (70, 60, 54))        # the standard lamp
    c.rect(x + w - 30, y + h - 44, 19, 11, (255, 236, 180)); c.frame(x + w - 30, y + h - 44, 19, 11, OUT)
    c.ellipse(x + w - 21, y + h - 36, 20, 15, (255, 226, 150), 60)


def pub_window(c, x, y, w, h):
    """A small pub window: the bar, its bottles, a couple of stools."""
    c.rect(x - 3, y - 3, w + 6, h + 6, (44, 42, 54)); c.frame(x - 3, y - 3, w + 6, h + 6, OUT)
    c.rect(x, y, w, h, (255, 196, 110))
    c.rect(x, y, w, 13, (236, 160, 90))                        # glow near the low ceiling
    c.rect(x + 3, y + 13, w - 6, 3, (92, 56, 40))              # back-bar shelf
    for i in range(w // 10):
        bx = x + 6 + i * 10
        col = [(120, 78, 40), (60, 96, 68), (150, 120, 60), (90, 70, 110)][i % 4]
        c.rect(bx, y + 7, 4, 6, col); c.px(bx + 1, y + 5, col)
    c.rect(x + 2, y + h - 24, w - 4, 5, (104, 66, 44)); c.frame(x + 2, y + h - 24, w - 4, 5, OUT)
    c.rect(x + 2, y + h - 19, w - 4, 3, (74, 46, 34))
    for i in range(2):                                         # stools
        sx = x + 14 + i * ((w - 26) // 2)
        c.rect(sx, y + h - 13, 8, 3, (150, 100, 62)); c.vline(sx + 3, y + h - 10, 10, (86, 60, 56))
    for i in range(2):                                         # drinkers, warm silhouettes
        px_ = x + 17 + i * ((w - 30) // 2)
        c.rect(px_, y + h - 32, 9, 13, (118, 66, 60)); c.ellipse(px_ + 4, y + h - 35, 4, 4, (118, 66, 60))
    c.frame(x, y, w, h, (38, 36, 48))
    c.vline(x + w // 2, y, h, (44, 42, 54))


def _green_post(c, x, base, h):
    """A wrought-iron post in the pub's green, with a ball finial."""
    c.rect(x, base - h, 4, h, RAIL_G)
    c.vline(x, base - h, h, RAIL_GL)
    c.vline(x + 3, base - h, h, RAIL_GD)
    c.rect(x - 1, base - h - 2, 6, 2, RAIL_GL); c.hline(x - 1, base - h - 1, 6, RAIL_GD)
    c.rect(x + 1, base - h - 5, 2, 3, RAIL_G); c.px(x + 1, base - h - 5, RAIL_GL)
    c.rect(x - 1, base - 2, 6, 2, RAIL_GD)                     # the shoe it is leaded into


def pub_entrance(c):
    """MacLaren's way in: down from the pavement to a door below it.

    Painted after the paving, because it is cut out of it. The well takes only
    the back of the pavement, so the strip the cast walks along is untouched.
    What is in here is the far side of it — the wall, the steps, the door and
    the handrail fixed to the building. The railing along the street side is in
    pub_railing(), on the overlay, so that somebody going down passes behind
    it and the door is seen through its bars."""
    x0, xs, x1 = PUB_STEP_X0, PUB_STEP_X1, PUB_WELL_X1
    top, floor = PAVE_Y + 1, PAVE_Y + PUB_DROP
    dx = PUB_DOOR_X

    # the doorway's stone surround, from the sign down into the well
    c.rect(dx - 17, 184, 34, PAVE_Y - 184, (40, 38, 50))
    c.frame(dx - 17, 184, 34, PAVE_Y - 183, OUT)
    for i, yy in enumerate(range(186, PAVE_Y - 2, 9)):         # dressed blocks down each jamb
        for jx in (dx - 16, dx + 12):
            c.rect(jx, yy, 4, 9, (66, 62, 76)); c.hline(jx, yy, 4, (88, 84, 98))
            c.hline(jx, yy + 8, 4, (30, 28, 38))
    # a transom light over the door, so the bar glows above the pavement too
    c.rect(dx - 11, 188, 22, 12, WARM); c.rect(dx - 11, 188, 22, 4, (250, 190, 110))
    c.frame(dx - 11, 188, 22, 12, RAIL_GD)
    c.vline(dx - 4, 189, 10, RAIL_GD); c.vline(dx + 3, 189, 10, RAIL_GD)
    c.rect(dx - 13, 202, 26, 4, STONE_D); c.hline(dx - 13, 202, 26, STONE)   # the door head
    c.frame(dx - 13, 202, 26, 4, OUT)

    # the well: dark stone, darker the further down
    for yy in range(top, PUB_LIP):
        d = (yy - top) / float(PUB_DROP)
        c.hline(x0, yy, x1 - x0 + 1, mix((52, 50, 62), (24, 24, 34), d))
    for yy in (top + 5, top + 11):                             # its coursing
        c.hline(x0, yy, x1 - x0 + 1, (20, 20, 30), 150)
    for i, jx in enumerate(range(x0 + 4, x1, 12)):
        c.vline(jx, top + (5 if i % 2 else 0), 6, (20, 20, 30), 150)
    c.vline(x1 - 1, top, PUB_DROP, (14, 14, 22)); c.vline(x1, top, PUB_DROP, (30, 30, 40))
    c.hline(x0 - 2, PAVE_Y, x1 - x0 + 5, OUT)                  # the wall's foot, above it

    # the flight, in side view: a stone wedge stepping down to the right, each
    # tread lit along its nosing and dimmer than the one above
    n = 4
    run = (xs - x0) // n
    for i in range(n):
        sx, ty = x0 + i * run, top + (i + 1) * PUB_DROP // n - 1
        shade = i / float(n)
        body = mix((172, 168, 174), (104, 100, 112), shade)
        c.rect(sx, ty, run, PUB_LIP - ty, body)
        c.hline(sx, ty, run, lighten(body, 0.34))              # the nosing
        c.hline(sx, ty + 1, run, lighten(body, 0.1))
        c.vline(sx, ty, PUB_LIP - ty, darken(body, 0.3))       # the riser above it
        c.vline(sx + run - 1, ty + 2, PUB_LIP - ty - 2, darken(body, 0.16))
    c.vline(x0 - 1, top, 3, STONE_D)                           # the pavement's cut edge
    c.hline(xs, floor, x1 - xs, (86, 74, 70))                  # the landing, catching the door's light

    # the door, standing on the landing: its head above the pavement, its foot
    # well below it. Glazed above, two timber panels below.
    dy0, dy1 = PUB_DOOR_TOP, floor
    c.rect(dx - 12, dy0, 24, dy1 - dy0, DOOR_G)
    c.rect(dx - 9, dy0 + 4, 18, 15, WARM); c.rect(dx - 9, dy0 + 4, 18, 5, (255, 232, 170))
    c.frame(dx - 9, dy0 + 4, 18, 15, RAIL_GD)
    c.vline(dx, dy0 + 5, 13, DOOR_G); c.hline(dx - 8, dy0 + 11, 16, DOOR_G)
    c.hline(dx - 11, dy0 + 21, 22, RAIL_GL)                    # the lock rail
    for px_ in (dx - 9, dx + 1):                               # the panels
        c.rect(px_, dy0 + 25, 8, dy1 - dy0 - 28, darken(DOOR_G, 0.22))
        c.hline(px_, dy0 + 25, 8, RAIL_GD); c.vline(px_, dy0 + 25, dy1 - dy0 - 28, RAIL_GD)
        c.hline(px_ + 1, dy1 - 4, 7, RAIL_GL); c.vline(px_ + 7, dy0 + 26, dy1 - dy0 - 29, RAIL_GL)
    c.vline(dx - 12, dy0, dy1 - dy0, RAIL_GD); c.vline(dx + 11, dy0, dy1 - dy0, RAIL_GD)
    c.frame(dx - 13, dy0 - 1, 26, dy1 - dy0 + 1, OUT)
    c.rect(dx + 8, dy0 + 20, 2, 4, (226, 190, 110)); c.px(dx + 8, dy0 + 20, (255, 236, 170))   # brass handle
    for r_, a in ((22, 10), (15, 14), (9, 20)):                # the light it throws
        c.ellipse(dx, dy0 + 12, r_, int(r_ * 0.8), (255, 200, 120), a)
    c.ellipse(dx - 4, floor - 1, 26, 5, (255, 196, 112), 34)   # and its pool on the landing

    # the handrail on the building side: fixed to the wall, following the flight
    # down and then running level to the door jamb
    rail = lambda x: top - 9 + min(PUB_DROP, (x - x0) * PUB_DROP // (xs - x0))
    for x in range(x0 - 2, dx - 13):
        ry = rail(max(x, x0))
        c.px(x, ry, RAIL_GL); c.px(x, ry + 1, RAIL_G); c.px(x, ry + 2, RAIL_GD)
    for i in range(n):                                         # a baluster to each tread
        bx = x0 + i * run + run // 2
        ty = top + (i + 1) * PUB_DROP // n - 1
        c.vline(bx, rail(bx) + 3, ty - rail(bx) - 3, RAIL_G)
    _green_post(c, x0 - 6, PAVE_Y + 1, PUB_RAIL_H)             # the post at the head, wall side
    _green_post(c, x1 - 3, PAVE_Y + 1, PUB_RAIL_H)             # and at the far end

    # the kerb the street-side railing stands on
    c.rect(x0 - 8, PUB_LIP, x1 - x0 + 14, 3, (140, 138, 148))
    c.hline(x0 - 8, PUB_LIP, x1 - x0 + 14, (174, 172, 182))
    c.hline(x0 - 8, PUB_LIP + 2, x1 - x0 + 14, STONE_D)
    for jx in range(x0 - 2, x1 + 6, 13):
        c.vline(jx, PUB_LIP + 1, 2, STONE_D)


def pub_railing(c):
    """The green railing along the street side of the pub's steps.

    On the overlay, so that whoever is going down is behind it and the door
    shows between its bars. Posts with finials at the head, beside the door and
    at the far end; a moulded handrail; a bottom rail; balusters."""
    x0, x1 = PUB_STEP_X0 - 5, PUB_WELL_X1 + 1
    base, topy = PUB_LIP + 1, PUB_LIP + 1 - PUB_RAIL_H
    for x in range(x0, x1 + 4):                                # the handrail
        c.px(x, topy, RAIL_GL); c.px(x, topy + 1, RAIL_G); c.px(x, topy + 2, RAIL_GD)
    c.hline(x0, base - 3, x1 - x0 + 4, RAIL_G)                 # the bottom rail
    c.hline(x0, base - 2, x1 - x0 + 4, RAIL_GD)
    for i, x in enumerate(range(x0 + 7, x1, 5)):               # balusters, with a collar
        c.vline(x, topy + 3, PUB_RAIL_H - 6, RAIL_G)
        c.px(x, topy + 3, RAIL_GL)
        if i % 2 == 0:
            c.px(x, topy + 8, RAIL_GL)
    for px_ in (x0, PUB_DOOR_X + 15, x1):                      # the posts
        _green_post(c, px_, base, PUB_RAIL_H + 2)
    # the return at the far end, back to the post against the wall
    c.line(x1 + 1, topy - 1, PUB_WELL_X1 - 2, PAVE_Y - PUB_RAIL_H + 2, RAIL_G)


def mailbox(c, x, base):
    """A street collection box, built the way the real ones are: a square body
    on a single pedestal, the hooded lid curving over the front, the posting
    slot in the shadow under that hood, and the collection door filling the
    lower face. Read by its silhouette — the hood overhanging the body is the
    whole of it — so nothing has to be written on the side."""
    w, h = 22, 34
    y = base - h
    blue, blue_l, blue_d = (22, 74, 148), (62, 126, 202), (10, 40, 94)
    c.shadow(x - 1, base, w + 2, 3, a=100)

    c.rect(x + 8, base - 8, 6, 8, (44, 46, 58))                # the single pedestal
    c.frame(x + 8, base - 8, 6, 8, OUT)
    c.vline(x + 9, base - 7, 6, (74, 76, 90))
    c.rect(x + 5, base - 2, 12, 2, (58, 60, 72))               # its foot plate
    c.frame(x + 5, base - 2, 12, 2, OUT)

    c.rect(x + 2, y + 11, w - 4, 15, blue)                     # the body
    c.vline(x + 3, y + 12, 13, blue_l)                         # lit down the street side
    c.vline(x + w - 4, y + 12, 13, blue_d)
    c.frame(x + 2, y + 11, w - 4, 15, OUT)

    c.rrect(x, y, w, 11, blue, 3)                              # the hood, curving over
    c.hline(x + 3, y + 1, w - 6, blue_l)
    c.hline(x + 2, y + 2, w - 4, lighten(blue_l, 0.18))
    c.rect(x + w // 2 - 4, y + 4, 9, 2, blue_d)                # the pull handle on it
    c.rect(x + 1, y + 9, w - 2, 2, blue_d)                     # its overhanging lip
    c.rframe(x, y, w, 11, OUT, 3)

    c.rect(x + 3, y + 13, w - 6, 3, (12, 14, 22))              # the posting slot, in its shade
    c.hline(x + 3, y + 13, w - 6, (6, 8, 14))
    c.hline(x + 4, y + 15, w - 8, (40, 48, 68))

    c.rect(x + 4, y + 18, w - 8, 7, darken(blue, 0.16))        # the collection door
    c.frame(x + 4, y + 18, w - 8, 7, (8, 10, 18))
    c.hline(x + 5, y + 19, w - 10, blue_l, 110)
    c.rect(x + w // 2 - 2, y + 21, 5, 2, (172, 178, 194))      # its handle
    c.frame(x + w // 2 - 2, y + 21, 5, 2, OUT)
    # the markings: a pale band on the body above the door, which is the shape
    # of them at this size — letters here would only be noise
    c.rect(x + 6, y + 16, w - 12, 1, (150, 164, 192))
    c.px(x + 6, y + 16, (96, 110, 140)); c.px(x + w - 7, y + 16, (96, 110, 140))


def grate(c, x, y, w, h):
    """An iron basement grate in a stone surround — bars with a frame, not just
    scratches on the wall."""
    c.rect(x, y, w, h, (28, 28, 38)); c.frame(x, y, w, h, OUT)
    for gx in range(x + 2, x + w - 1, 5):
        c.vline(gx, y + 1, h - 2, (62, 60, 74)); c.vline(gx + 1, y + 1, h - 2, (38, 36, 48))
    for gy in range(y + 5, y + h - 2, 9):
        c.hline(x + 1, gy, w - 2, (74, 72, 86))
    c.frame(x - 1, y - 1, w + 2, h + 2, STONE_D)


def drain(c, x, y, w):
    """A kerbside gully grating, set into the paving."""
    c.rect(x, y, w, 5, (54, 54, 64)); c.frame(x, y, w, 5, OUT)
    for gx in range(x + 2, x + w - 1, 4):
        c.vline(gx, y + 1, 3, (30, 30, 40))
    c.hline(x, y, w, (92, 90, 102))


def wall_lantern(c, x, y, glow=True):
    """A bracket lantern on the masonry, with the pool it throws."""
    c.rect(x + 3, y, 3, 4, IRON)                               # the bracket
    c.rect(x, y + 4, 10, 3, IRON); c.frame(x, y + 4, 10, 3, OUT)
    c.rect(x + 1, y + 7, 8, 9, (255, 226, 158)); c.frame(x + 1, y + 7, 8, 9, OUT)
    c.vline(x + 5, y + 7, 9, (255, 246, 206))
    c.rect(x + 1, y + 16, 8, 2, IRON)
    if glow:
        # kept tight and faint: a wide wash on a dark wall reads as a grey dome
        # painted on the masonry rather than as light
        for r_, a in ((16, 6), (13, 8), (10, 10), (7, 13), (4, 18)):
            c.ellipse(x + 5, y + 12, r_, int(r_ * 1.1), (255, 214, 130), a)


def _guardrail(c, dy, x_from):
    """One side of the stoop's guardrail, `dy` in front of the tread line: a
    continuous top rail that follows the flight and then runs level along the
    landing, balusters down to the stone, and newel posts at the bottom, at the
    landing and at the top. Both sides are built by this, so they cannot drift
    apart or stop following the slope."""
    rail = lambda x: stair_slope_at(x) + dy - RAIL_H           # the sloping handrail
    tread = lambda x: stair_top_at(max(x, STAIR_X0)) + dy      # the stone it stands on
    # handrail: a moulded section, lit along the top and undercut beneath, so it
    # reads as a rail rather than as a drawn line
    for x in range(x_from, LANDING_X1 + 1):
        ry = rail(x)
        c.vline(x, ry, 3, IRON)
        c.px(x, ry, (104, 102, 120))
        c.px(x, ry + 2, (30, 28, 40))
    # the bottom rail runs parallel to the handrail, as a built one does —
    # follow the stepped stone instead and it breaks into dashes
    foot = lambda x: stair_slope_at(x) + dy - 4
    for x in range(x_from, LANDING_X1 + 1):
        c.vline(x, foot(x), 2, IRON)
        c.px(x, foot(x), (78, 76, 92))
    # balusters: evenly spaced, two pixels wide, every one spanning rail to rail
    for x in range(x_from + 5, LANDING_X1 - 3, 9):
        ry, by = rail(x) + 3, foot(x)
        c.vline(x, ry, by - ry, IRON)
        c.vline(x + 1, ry, by - ry, (58, 56, 72))
        c.px(x, ry, (88, 86, 104))
    # newel posts: heavier than the balusters, with a base and a capped head,
    # at the foot of the flight, at the landing and at the top
    for nx in (x_from, STAIR_X1, LANDING_X1 - 5):
        ny = tread(nx)
        c.rect(nx, ny - RAIL_H - 8, 7, RAIL_H + 8, IRON)
        c.frame(nx, ny - RAIL_H - 8, 7, RAIL_H + 8, OUT)
        c.vline(nx + 1, ny - RAIL_H - 7, RAIL_H + 6, (70, 68, 86))
        c.vline(nx + 5, ny - RAIL_H - 7, RAIL_H + 6, (28, 26, 38))
        c.rect(nx - 2, ny - RAIL_H - 13, 11, 5, (54, 52, 66))  # the cap
        c.frame(nx - 2, ny - RAIL_H - 13, 11, 5, OUT)
        c.hline(nx - 1, ny - RAIL_H - 13, 9, (100, 98, 114))
        c.rect(nx - 1, ny - 6, 9, 4, (54, 52, 66))             # and the base block
        c.frame(nx - 1, ny - 6, 9, 4, OUT)
        c.hline(nx, ny - 6, 7, (92, 90, 106))


def paint():
    c = Canvas(W, H)

    # ── sky, then the whole brownstone face ──────────────────────────────────
    for yy in range(0, 14):
        c.hline(0, yy, W, mix((16, 18, 46), (40, 36, 84), yy / 14.0))
    for i in range(30):
        c.px(hash2(i, 1, 9) % W, hash2(i, 2, 9) % 10, (255, 255, 240), 160)

    P.brick_wall(c, 0, 8, W, PAVE_Y - 8, base=(98, 100, 112), mortar=(66, 68, 80), seed=3)
    c.rect(0, 4, W, 6, (176, 170, 166)); c.frame(-1, 4, W + 2, 6, OUT)                   # roof cornice
    for yy in range(8, PAVE_Y):                                                           # night down the wall
        c.hline(0, yy, W, (14, 16, 30), 54 - min(40, (yy - 8) // 5))

    # ── the apartment: the tall, lit floor that is most of the building ──────
    h = APT_BOT - APT_TOP
    apartment_window(c, 26, APT_TOP, 104, h, _red_couch)
    apartment_window(c, 150, APT_TOP, 104, h, _horn_and_shelf)
    apartment_window(c, 274, APT_TOP, 104, h, _lamp_and_table)

    # the fire escape, hung under the apartment windows where it belongs
    c.rect(18, 128, 368, 3, IRON)
    for fx in range(18, 387, 7):
        c.vline(fx, 114, 14, IRON)
    c.hline(18, 114, 368, IRON)
    c.vline(366, 46, 82, IRON); c.vline(373, 46, 82, IRON)          # the ladder up to the roof
    for ly in range(50, 128, 7):
        c.hline(366, ly, 8, IRON)

    # ── the cornice over the shopfront, which stops at the entrance bay ──────
    c.rect(0, FLOOR_LINE, STAIR_X0 - 4, 9, (176, 170, 166)); c.frame(-1, FLOOR_LINE, STAIR_X0 - 3, 9, OUT)
    c.hline(0, FLOOR_LINE + 8, STAIR_X0 - 4, (112, 106, 108))
    c.rect(0, FLOOR_LINE + 9, STAIR_X0 - 4, 3, (86, 84, 96))

    # ── ground floor: a small neighbourhood bar under all that ───────────────
    c.rect(PUB_X0, 160, PUB_X1 - PUB_X0, 80, (56, 48, 60))
    c.frame(PUB_X0, 160, PUB_X1 - PUB_X0, 80, OUT)
    # a modest hanging sign over the door
    for bx in (PUB_DOOR_X - 56, PUB_DOOR_X + 53):
        c.rect(bx, 160, 3, 6, IRON); c.ellipse(bx + 1, 166, 3, 3, (190, 186, 190))
    c.rect(PUB_DOOR_X - 60, 164, 120, 17, (18, 76, 57)); c.frame(PUB_DOOR_X - 60, 164, 120, 17, OUT)
    c.frame(PUB_DOOR_X - 58, 166, 116, 13, (196, 166, 106))
    s = "MACLAREN'S"
    from px import FONT
    cx = PUB_DOOR_X - 60 + (120 - text_w(s)) // 2
    for ch in s:
        g = FONT.get(ch)
        if g is None:
            cx += 2; continue
        for r, row in enumerate(g):
            for i, bit in enumerate(row):
                if bit == '#':
                    c.px(cx + i, 170 + r, (232, 214, 166))
        cx += len(g[0]) + 1

    # a gooseneck lamp on the facade, bent over the sign and lighting it
    c.rect(PUB_DOOR_X - 1, 146, 3, 7, IRON)
    c.line(PUB_DOOR_X, 146, PUB_DOOR_X + 7, 142, IRON)
    c.rect(PUB_DOOR_X + 4, 140, 11, 4, IRON); c.frame(PUB_DOOR_X + 4, 140, 11, 4, OUT)
    c.rect(PUB_DOOR_X + 6, 144, 7, 2, (255, 236, 174))
    for r_, a in ((26, 18), (16, 26)):
        c.ellipse(PUB_DOOR_X + 9, 148, r_, int(r_ * 0.7), (255, 214, 130), a)

    # stone lintels and keystones over the shopfront openings
    for (lx, lw) in ((70, 78), (184, 78)):
        c.rect(lx, 178, lw, 5, STONE); c.frame(lx, 178, lw, 5, OUT)
        c.hline(lx, 178, lw, STONE_L)
        kx = lx + lw // 2 - 4
        c.rect(kx, 175, 8, 8, STONE_L); c.frame(kx, 175, 8, 8, OUT)

    pub_window(c, 74, 186, 70, 50)
    pub_window(c, 188, 186, 70, 50)

    # the door is not here any more: it is down the steps. See pub_entrance().
    # neon in the left window, a beer sign in the right
    g_ = (90, 240, 130)
    for (dx, dy) in ((0, -3), (-3, 0), (3, 0)):
        c.ring(NEON_SHAMROCK[0] + dx, NEON_SHAMROCK[1] + dy, 3, 3, g_, 1)
    c.vline(NEON_SHAMROCK[0], NEON_SHAMROCK[1] + 2, 5, g_); c.ellipse(NEON_SHAMROCK[0], NEON_SHAMROCK[1], 11, 10, g_, 26)
    # and a neon in the right one: a glass with a head on it, bent in tube
    # rather than spelled out
    pk, cy_ = (255, 110, 150), (130, 240, 250)
    gx, gy = NEON_GLASS                                        # hung clear of the drinkers
    for dy_ in range(10):                                      # the glass, tapering in
        c.px(gx + dy_ // 5, gy + 4 + dy_, cy_)
        c.px(gx + 11 - dy_ // 5, gy + 4 + dy_, cy_)
    c.hline(gx + 2, gy + 14, 8, cy_)                           # its base
    c.hline(gx, gy + 4, 12, pk)                                # the head on it
    c.px(gx + 3, gy + 2, pk); c.px(gx + 8, gy + 2, pk)
    c.px(gx + 13, gy + 7, cy_); c.px(gx + 14, gy + 8, cy_)     # the handle
    c.px(gx + 14, gy + 9, cy_); c.px(gx + 13, gy + 10, cy_)
    for r_, a in ((13, 14), (9, 20), (6, 26)):                 # the glow it throws
        c.ellipse(gx + 6, gy + 8, r_, int(r_ * 0.85), pk, a)
    for hx in (gx + 1, gx + 10):                               # hung from the window head
        c.vline(hx, gy - 4, 5, (120, 116, 130))

    # stonework either side of the little pub, so it reads as one shop in a much
    # bigger building: a plain stone bay on the left, basement grates on the right
    for bx in (12, 286):
        bw = PUB_X0 - 20 if bx == 12 else STAIR_X0 - 300
        c.rect(bx, 196, bw, 44, (72, 70, 84)); c.frame(bx, 196, bw, 44, OUT)
        for yy in range(200, 240, 10):                                                    # coursed blocks
            c.hline(bx + 1, yy, bw - 2, (58, 56, 70))
        for i in range(bw // 11):                                                         # the vertical joints
            jx = bx + 5 + i * 11
            for yy in range(200, 240, 10):
                c.vline(jx + (5 if (yy // 10) % 2 else 0), yy, 10, (58, 56, 70))
    grate(c, 296, 202, 38, 32)                                                            # right bay: a basement grate

    # a standpipe between the pub and the next bay along
    c.rect(272, 212, 9, 28, (128, 124, 134)); c.frame(272, 212, 9, 28, OUT)
    c.vline(274, 214, 24, (176, 172, 180))
    c.rect(270, 218, 13, 4, (150, 146, 154)); c.frame(270, 218, 13, 4, OUT)
    c.ellipse(276, 216, 4, 4, (186, 182, 190))

    # ── right bay: the stoop up to Ted's door ────────────────────────────────
    c.rect(STAIR_X0 - 8, 8, W - STAIR_X0 + 8, 232, (84, 80, 94)); c.frame(STAIR_X0 - 8, 8, W - STAIR_X0 + 9, 232, OUT)
    P.brick_wall(c, STAIR_X0 - 6, 10, W - STAIR_X0 + 6, 228, base=(92, 88, 102), mortar=(62, 60, 74), seed=6)
    window(c, 420, 40, 48, 62, True, 3)                                                   # the stair hall, lit

    # the stoop itself: nine steps up to a landing against the building
    for x in range(STAIR_X0, LANDING_X1 + 1):
        t = stair_top_at(x)
        c.vline(x, t, PAVE_Y - t, STONE_D)
    for i in range(9):                                                                     # tread + riser per step
        sx = STAIR_X0 + i * (STAIR_X1 - STAIR_X0) // 9
        ty = PAVE_Y - i * 6
        c.rect(sx, ty - 6, LANDING_X1 - sx, 3, STONE)
        c.hline(sx, ty - 6, LANDING_X1 - sx, STONE_L)
        c.vline(sx, ty - 6, 6, (84, 80, 90))
    c.rect(STAIR_X1, STAIR_TOP, LANDING_X1 - STAIR_X1, 4, STONE)                           # the landing
    c.hline(STAIR_X1, STAIR_TOP, LANDING_X1 - STAIR_X1, STONE_L)
    c.hline(STAIR_X0, PAVE_Y, LANDING_X1 - STAIR_X0, OUT)

    # the far guardrail, against the building. The near one is painted into the
    # overlay instead, so the cast climbs between the two.
    _guardrail(c, 0, STAIR_X0 - 6)

    # quoins down the joint where the entrance bay meets the shopfront: a
    # continuous column of blocks, long and short about turn
    for i, yy in enumerate(range(12, PAVE_Y - 8, 9)):
        qw = 12 if i % 2 else 7
        c.rect(STAIR_X0 - 16, yy, qw, 9, (108, 104, 118))
        c.frame(STAIR_X0 - 16, yy, qw, 9, (72, 70, 84))
        c.hline(STAIR_X0 - 15, yy + 1, qw - 2, (142, 138, 150))

    # Ted's door, at the top of the stoop
    c.rect(APT_DOOR_X - 20, STAIR_TOP - 56, 40, 56, (72, 50, 46)); c.frame(APT_DOOR_X - 20, STAIR_TOP - 56, 40, 56, OUT)
    c.rect(APT_DOOR_X - 17, STAIR_TOP - 52, 34, 52, (96, 64, 52)); c.frame(APT_DOOR_X - 17, STAIR_TOP - 52, 34, 52, OUT)
    for (px_, py_) in ((-13, -46), (3, -46), (-13, -26), (3, -26)):
        c.rect(APT_DOOR_X + px_, STAIR_TOP + py_, 11, 17, (74, 48, 40))
    c.ellipse(APT_DOOR_X + 12, STAIR_TOP - 27, 3, 3, (226, 190, 110))                      # knob
    c.rect(APT_DOOR_X - 21, STAIR_TOP - 70, 42, 13, WARM); c.frame(APT_DOOR_X - 21, STAIR_TOP - 70, 42, 13, OUT)
    for fx in range(APT_DOOR_X - 16, APT_DOOR_X + 18, 8):                                  # fanlight bars
        c.vline(fx, STAIR_TOP - 69, 11, (120, 90, 60))
    c.ellipse(APT_DOOR_X, STAIR_TOP - 64, 48, 28, (255, 214, 130), 44)
    c.rect(APT_DOOR_X - 13, STAIR_TOP - 82, 26, 9, (226, 190, 110)); c.frame(APT_DOOR_X - 13, STAIR_TOP - 82, 26, 9, OUT)
    c.text(APT_DOOR_X - 8, STAIR_TOP - 80, '150', (60, 44, 40))

    # a lantern on the brick beside the door, and the buzzer panel under it
    wall_lantern(c, APT_DOOR_X - 36, STAIR_TOP - 62)
    bx_, by_ = APT_DOOR_X - 33, STAIR_TOP - 34
    c.rect(bx_, by_, 8, 13, (150, 146, 154)); c.frame(bx_, by_, 8, 13, OUT)
    for i in range(4):
        c.rect(bx_ + 2, by_ + 2 + i * 3, 4, 2, (86, 84, 94))

    # the yellow umbrella, left leaning by the door
    ux, uy = APT_DOOR_X + 25, STAIR_TOP - 22
    c.rect(ux, uy, 3, 20, (226, 190, 110)); c.frame(ux - 1, uy, 5, 20, OUT)
    c.ellipse(ux + 1, uy - 1, 7, 5, (255, 201, 74)); c.frame(ux - 6, uy - 4, 15, 5, OUT)

    # ── pavement, lamp, hydrant, tree ────────────────────────────────────────
    c.rect(0, PAVE_Y, W, 26, (128, 126, 138))
    for i in range(W * 2):                                                 # flagstones, lightly varied
        fx, fy = hash2(i, 5, 7) % W, PAVE_Y + hash2(i, 6, 7) % 26
        c.px(fx, fy, (138, 136, 148) if i % 2 else (118, 116, 130))
    for sx in range(0, W, 34):                                             # the paving joints
        c.vline(sx, PAVE_Y, 26, (104, 102, 116))
        c.vline(sx + 1, PAVE_Y, 26, (146, 144, 156), 90)
    c.hline(0, PAVE_Y + 13, W, (110, 108, 122))                            # the joint along the flags
    c.hline(0, PAVE_Y + 14, W, (146, 144, 156), 70)
    c.hline(0, PAVE_Y, W, OUT); c.hline(0, PAVE_Y + 1, W, (160, 158, 170))
    c.rect(0, 266, W, 4, (90, 88, 102)); c.hline(0, 266, W, OUT)           # the kerb
    c.hline(0, 265, W, (168, 166, 178))
    c.rect(0, 270, W, 2, (30, 32, 40), 150)                                # the gutter's shadow

    c.rect(336, 158, 4, 84, IRON); c.rect(330, 152, 16, 8, IRON); c.rect(332, 154, 12, 5, (255, 236, 170))
    for r_, a in ((60, 14), (44, 18), (28, 24)):
        c.ellipse(338, 158, r_, int(r_ * 0.8), (255, 214, 130), a)
    c.rect(318, 224, 8, 16, (200, 52, 48)); c.rect(316, 228, 12, 4, (200, 52, 48))         # the hydrant
    c.frame(318, 223, 8, 18, OUT); c.rect(319, 220, 6, 4, (220, 80, 70))

    pub_entrance(c)
    mailbox(c, MAILBOX_X, PAVE_Y + 2)
    drain(c, 232, 261, 26)                                                 # kerbside gullies
    drain(c, 452, 261, 22)
    c.ellipse(118, 272, 9, 4, (62, 62, 72)); c.ring(118, 272, 9, 4, (34, 34, 44), 1)       # the manhole
    c.rect(7, 200, 5, 42, (70, 50, 46)); c.frame(6, 200, 7, 42, OUT)
    for i in range(30):
        bx_ = hash2(i, 1, 2) % 24; by_ = 164 + hash2(i, 2, 2) % 44
        c.px(bx_, by_, (255, 236, 170)); c.px(bx_, by_ + 1, (255, 200, 110), 150)

    # ── the road ─────────────────────────────────────────────────────────────
    c.rect(0, 270, W, 82, (50, 52, 60))
    for i in range(300):
        c.px(hash2(i, 3, 8) % W, 272 + hash2(i, 4, 8) % 78, (68, 70, 80))
    for sx in range(20, W, 70):
        c.rect(sx, 310, 34, 4, (220, 200, 110))
    return c.img


def paint_overlay():
    """The near side of the stoop's guardrail, on its own transparent layer.

    The elevation is a backdrop and the cast is drawn on top of it, so anything
    that should pass IN FRONT of a climber has to be painted after them. This
    is the street's only overlay: the website draws it over the actors, which is
    what puts a climbing character between two railings instead of behind both.
    Its bottom newel starts clear of the foot of the stoop so it never hides
    whoever is standing there."""
    c = Canvas(W, H)
    _guardrail(c, STEP_DEPTH, STAIR_X0 + 2)
    pub_railing(c)
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
