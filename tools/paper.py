#!/usr/bin/env python3
"""Paper mode: the cutting net of a foldable paper model, as an SVG in millimetres.

An OpenSCAD *paper template* (paper_templates/*.scad) draws the flat net — a
house, say: floor, four walls and their glue tabs. Its walls start plain.
Windows and other decorations are SVG/DXF drawings placed on a wall:

* **frame** (the default, a *frame cutout*) — the drawing's lines are
  thickened to `thickness` mm of paper, and only what they enclose is cut out.
  A square with a cross in it becomes four panes held by paper bars; the
  drawing's outermost line is not cut, the wall around it carries on.
* **drawn** — the drawing already is the cutout: every closed outline is cut
  out whole, as drawn. Gaps up to 0.6 mm in an outline are closed first, and
  whatever lies inside an outline (a ghost's eyes) falls out with it.

The template clips every decoration to its wall's decoration area, so cuts
keep clear of the folds, the glue tabs and the wall's edge.

Usage:
    paper.py job.json [--openscad openscad] [--output net.svg]

job.json:
    {"template": "paper_templates/house.scad",
     "params": {"house_size": 60, "roof_style": "gable"},
     "decorations": [{"file": "window.svg", "wall": 0, "x": 25, "y": 30,
                      "width": 20, "rotation": 0, "thickness": 2, "mode": "frame"}]}

Paths are relative to the working directory. A decoration's x and y are its
centre seen from outside the wall, from the wall's bottom-left corner;
rotation is clockwise in degrees. Leave out x, y or width and the decoration
is centred in the wall's decoration area at a size that fits. A decoration may
carry the "geometry" an earlier run returned for it instead of a "file", so
moving it does not re-read the drawing.

Prints JSON: the SVG, the geometry the editor shows, the net split into faces
along its folds for the 3D preview, and a summary. The SVG shows the walls
from outside: fold them away from you, or turn the sheet over and fold them up.
"""

import argparse
import json
import math
import os
import re
import subprocess
import sys
import tempfile

from shapely import affinity
from shapely.geometry import LineString, MultiLineString, Point, Polygon, box
from shapely.ops import polygonize, unary_union

MODES = ("frame", "drawn")
LEGACY_MODES = {"silhouette": "drawn"}
CLOSE_GAPS = 0.6        # mm: breaks this narrow in a drawn outline still close it
SAGITTA = 0.02          # curve flattening tolerance, in the paper's millimetres
SIMPLIFY = 0.01         # vertices closer than this to the line are dropped
MIN_CUTOUT = 0.05       # mm²: anything smaller is a sliver, not a cut
MAX_DECORATIONS = 32
FOLD_BAND = 1.0         # mm either side of a fold in which its two faces are looked for
THUMB_TOLERANCE = 0.05  # mm: the thumbnail's lines need no more detail than this
FIT = 0.6               # a new decoration fills this share of its wall's area
OPENSCAD_TIMEOUT = 120
COLOURS = {"cut": "#e11d48", "fold": "#2563eb"}


class PaperError(Exception):
    """A problem worth showing to the user verbatim, without a traceback."""


def _polygons(geom):
    if geom.is_empty:
        return
    if geom.geom_type == "Polygon":
        yield geom
    elif hasattr(geom, "geoms"):
        for g in geom.geoms:
            yield from _polygons(g)


def _finite(value, name, low=None):
    try:
        value = float(value)
    except (TypeError, ValueError):
        raise PaperError(f"{name} must be a number") from None
    if not math.isfinite(value) or (low is not None and value <= low):
        raise PaperError(f"{name} must be {'greater than ' + str(low) if low is not None else 'a number'}")
    return value


# --------------------------------------------------------------- decorations

def cutouts_of(curves, thickness, mode="frame"):
    """What a decoration cuts out of the wall, and how many paper pieces fall loose.

    `curves` are polylines in millimetres. In frame mode they are thickened to
    `thickness` and the holes of the result are cut — never the outside of the
    drawing. Drawn, the regions inside the outermost closed lines are cut.
    """
    if mode not in MODES:
        raise PaperError(f"decoration mode must be one of: {', '.join(MODES)}")
    lines = [c for c in curves if len(c) >= 2]
    if not lines:
        raise PaperError("the decoration has no lines")
    if mode == "drawn":
        # Traced outlines rarely close exactly: bridge small breaks, then shrink back.
        eps = CLOSE_GAPS / 2
        grown = MultiLineString(lines).buffer(eps, quad_segs=8)
        filled = unary_union([Polygon(p.exterior) for p in _polygons(grown)])
        cut = filled.buffer(-eps, quad_segs=8, join_style="mitre")
        loose = 0
    else:
        frame = MultiLineString(lines).buffer(thickness / 2, quad_segs=8)
        filled = unary_union([Polygon(p.exterior) for p in _polygons(frame)])
        cut = filled.difference(frame)
        # Paper bars that touch nothing but cut-outs drop out with them.
        loose = sum(1 for p in _polygons(frame)) - len(list(_polygons(filled)))
    cut = cut.simplify(SIMPLIFY, preserve_topology=True)
    parts = [p for p in _polygons(cut) if p.area >= MIN_CUTOUT]
    return unary_union(parts) if parts else Polygon(), max(loose, 0)


def read_decoration(path, sagitta=SAGITTA):
    """The drawing's polylines in its own millimetres, and their bounds."""
    from dxf2stl import ConvertError, read_curves   # slow import: only when a file is read
    try:
        curves, _, _ = read_curves(path, sagitta)
    except ConvertError as error:
        raise PaperError(str(error)) from None
    xs = [x for c in curves for x, _ in c]
    ys = [y for c in curves for _, y in c]
    if not xs or max(xs) - min(xs) <= 0 or max(ys) - min(ys) <= 0:
        raise PaperError("the decoration has no width or height")
    return curves, (min(xs), min(ys), max(xs), max(ys))


def decoration_geometry(path, width, thickness, mode):
    """The decoration's cut-outs for OpenSCAD, normalized: its drawing is 1 wide,
    centred on (0, 0), y up. Width and thickness are the paper's millimetres."""
    curves, (x0, y0, x1, y1) = read_decoration(path)
    factor = width / (x1 - x0)
    if not 0.5 < factor < 2:
        # Flatten curves to a tolerance in the paper's millimetres, not the drawing's.
        curves, (x0, y0, x1, y1) = read_decoration(path, SAGITTA / factor)
        factor = width / (x1 - x0)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    scaled = [[((x - cx) * factor, (y - cy) * factor) for x, y in c] for c in curves]
    cut, loose = cutouts_of(scaled, thickness, mode)
    normal = affinity.scale(cut, 1 / width, 1 / width, origin=(0, 0))
    points, paths = scad_polygon(normal)
    # The drawing itself, normalized the same way, for the editor's thumbnail.
    lines = [[[round(x / width, 4), round(y / width, 4)] for x, y in line.simplify(THUMB_TOLERANCE).coords]
             for line in (LineString(c) for c in scaled if len(c) >= 2)]
    return {
        "key": geometry_key(width, thickness, mode),
        "points": points, "paths": paths, "lines": lines,
        "aspect": round((y1 - y0) / (x1 - x0), 6),
        "cutouts": sum(1 for _ in _polygons(cut)),
        "loose": loose,
    }


def geometry_key(width, thickness, mode):
    """What a decoration's geometry depends on: placing it elsewhere reuses it."""
    return f"{mode}|{round(width, 4)}|{round(thickness, 4)}"


def scad_polygon(geom):
    """OpenSCAD polygon(points, paths) data: every ring of every polygon."""
    points, paths = [], []
    for poly in _polygons(geom):
        for ring in [poly.exterior, *poly.interiors]:
            coords = list(ring.coords)[:-1]
            if len(coords) < 3:
                continue
            start = len(points)
            points.extend([round(x, 6), round(y, 6)] for x, y in coords)
            paths.append(list(range(start, len(points))))
    return points, paths


def checked_geometry(raw):
    """Geometry a client sent back: numbers and indices only, nothing else."""
    try:
        points = [[_finite(x, "a point"), _finite(y, "a point")] for x, y in raw["points"]]
        paths = [[int(i) for i in path] for path in raw["paths"]]
        aspect = _finite(raw["aspect"], "the aspect", 0)
    except (KeyError, TypeError, ValueError):
        raise PaperError("a decoration's geometry is malformed") from None
    if any(len(p) < 3 or min(p) < 0 or max(p) >= len(points) for p in paths):
        raise PaperError("a decoration's geometry is malformed")
    # The thumbnail's lines stay with the browser; only what the cut needs comes back.
    return {"key": str(raw.get("key", "")), "points": points, "paths": paths, "aspect": aspect,
            "cutouts": int(raw.get("cutouts") or 0), "loose": int(raw.get("loose") or 0)}


def normal_shape(geometry):
    """The normalized cut-outs as one shapely geometry (even-odd, like OpenSCAD)."""
    shape = Polygon()
    for path in geometry["paths"]:
        ring = Polygon([geometry["points"][i] for i in path])
        if not ring.is_valid:
            ring = ring.buffer(0)
        shape = shape.symmetric_difference(ring)
    return shape


def placed(shape, d):
    """A normalized shape placed on its wall, in the wall's outside coordinates."""
    shape = affinity.scale(shape, d["width"], d["width"], origin=(0, 0))
    shape = affinity.rotate(shape, -d["rotation"], origin=(0, 0))   # clockwise
    return affinity.translate(shape, d["x"], d["y"])


# ------------------------------------------------------------------ OpenSCAD

def scad_value(value):
    """A parameter value as OpenSCAD source."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return repr(_finite(value, "a parameter"))
    if isinstance(value, str):
        return json.dumps(value)
    raise PaperError("template parameters must be numbers, booleans or text")


def scad_decorations(decorations):
    rows = []
    for d in decorations:
        g = d["geometry"]
        if not g["paths"]:
            continue
        rows.append("[{}, {!r}, {!r}, {!r}, {}, {}, {!r}]".format(
            d["wall"], d["x"], d["y"], d["width"],
            json.dumps(g["points"], separators=(",", ":")),
            json.dumps(g["paths"], separators=(",", ":")), d["rotation"]))
    return "[\n" + ",\n".join(rows) + "\n]"


def start_openscad(openscad, source, output, path, params):
    definitions = []
    for key, value in params.items():
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            raise PaperError(f"unknown template parameter {key!r}")
        definitions += ["-D", f"{key}={scad_value(value)}"]
    args = [openscad, "-o", path,
            *definitions, "-D", f"output={json.dumps(output)}", source]
    return subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
                            env={**os.environ, "QT_QPA_PLATFORM": "offscreen"})


def finish_openscad(process, path, what):
    try:
        _, log = process.communicate(timeout=OPENSCAD_TIMEOUT)
    except subprocess.TimeoutExpired:
        process.kill()
        raise PaperError(f"OpenSCAD took too long to build the {what}") from None
    if process.returncode != 0 or not os.path.exists(path) or os.path.getsize(path) == 0:
        raise PaperError(f"OpenSCAD could not build the {what}: {scad_error(log)}")
    return log


def scad_error(log):
    """The line of an OpenSCAD log worth showing: an assertion's own message if there is one."""
    for line in log.splitlines():
        if "Assertion" in line and "failed" in line:
            message = re.search(r'failed: "(.*)"', line)
            return message.group(1) if message else line.strip()
    for line in log.splitlines():
        if line.startswith(("ERROR", "WARNING: No top level", "Current top level object is empty")):
            return line.strip()
    return (log.strip().splitlines() or ["no output"])[-1]


def echoed(log, name, default=None):
    """The value a template echoed as `echo(name = value)`; without one, `default` if given."""
    match = re.search(rf"^ECHO: {name} = (.*)$", log, re.M)
    if not match:
        if default is not None:
            return default
        raise PaperError(f"the template does not echo {name} — see the app protocol in paper_templates/house.scad")
    try:
        return json.loads(match.group(1))
    except json.JSONDecodeError:
        raise PaperError(f"the template's {name} is not a list of numbers") from None


def scad_svg_rings(text):
    """The closed rings of an OpenSCAD SVG export, in OpenSCAD's own (y up) coordinates."""
    rings = []
    for d in re.findall(r'<path[^>]*\bd="([^"]*)"', text):
        for sub in re.split(r"[Mm]", d):
            numbers = [float(v) for v in re.findall(r"-?\d+(?:\.\d*)?(?:[eE][-+]?\d+)?", sub)]
            ring = [(numbers[i], -numbers[i + 1]) for i in range(0, len(numbers) - 1, 2)]
            if len(ring) >= 3:
                rings.append(ring)
    return rings


def even_odd(rings):
    shape = Polygon()
    for ring in rings:
        poly = Polygon(ring)
        shape = shape.symmetric_difference(poly if poly.is_valid else poly.buffer(0))
    return shape


# --------------------------------------------------------- outside view (SVG)

class View:
    """The net as the app shows and exports it: from outside, SVG's y pointing down.

    OpenSCAD draws the sheet as it lies before folding. When its top face is the
    inside (house.scad), the outside is seen from below: x is mirrored, and with
    the y flip a point (x, y) shows at (-x, -y). When its top face is the
    outside, only y flips. Either way, applying the view twice gives the
    template's coordinates back.
    """

    def __init__(self, inside_up=True):
        self.sx = -1 if inside_up else 1

    def geom(self, geom):
        return affinity.scale(geom, self.sx, -1, origin=(0, 0))

    def point(self, p):
        return [self.sx * p[0], -p[1]]


class Wall:
    """Where a wall lies in the view: its outside (x, y) maps to origin + x·ax + y·ay."""

    def __init__(self, raw, view):
        try:
            origin, ax, ay, size = raw
            self.origin, self.ax, self.ay = view.point(origin), view.point(ax), view.point(ay)
            self.size = [_finite(size[0], "a wall width", 0), _finite(size[1], "a wall height", 0)]
        except (TypeError, ValueError):
            raise PaperError("the template's app_walls are malformed") from None
        det = self.ax[0] * self.ay[1] - self.ax[1] * self.ay[0]
        if abs(det) < 1e-9:
            raise PaperError("the template's app_walls are malformed")
        self.det = det

    def matrix(self):
        """shapely affine matrix: wall outside coordinates to the view."""
        return [self.ax[0], self.ay[0], self.ax[1], self.ay[1], self.origin[0], self.origin[1]]

    def local(self, p):
        """A view point in the wall's outside coordinates."""
        dx, dy = p[0] - self.origin[0], p[1] - self.origin[1]
        return ((dx * self.ay[1] - dy * self.ay[0]) / self.det,
                (self.ax[0] * dy - self.ax[1] * dx) / self.det)

    def contains(self, p, margin=1e-6):
        x, y = self.local(p)
        return -margin <= x <= self.size[0] + margin and -margin <= y <= self.size[1] + margin

    def to_local(self, geom):
        a, b, c, d = self.ax[0], self.ay[0], self.ax[1], self.ay[1]
        det = a * d - b * c
        ia, ib, ic, id_ = d / det, -b / det, -c / det, a / det
        ox, oy = self.origin
        return affinity.affine_transform(geom, [ia, ib, ic, id_, -(ia * ox + ib * oy), -(ic * ox + id_ * oy)])

    def summary(self, area):
        bounds = area.bounds if not area.is_empty else (0, 0, *self.size)
        return {"origin": self.origin, "x": self.ax, "y": self.ay, "size": self.size,
                "area": [round(v, 3) for v in bounds]}


def _fmt(v):
    s = f"{v:.3f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def path_data(geom):
    """SVG path data for every ring of a (view coordinate) geometry."""
    out = []
    for poly in _polygons(geom):
        for ring in [poly.exterior, *poly.interiors]:
            pts = list(ring.coords)[:-1]
            out.append(" ".join(f"{'M' if i == 0 else 'L'}{_fmt(x)} {_fmt(y)}"
                                for i, (x, y) in enumerate(pts)) + " Z")
    return " ".join(out)


def line_data(lines):
    return " ".join(f"M{_fmt(a[0])} {_fmt(a[1])} L{_fmt(b[0])} {_fmt(b[1])}" for a, b in lines)


def net_svg(net, folds, margin=5.0):
    """The net as an SVG in millimetres: a cut layer and, unless `folds` is
    empty because the cut already perforates them, a fold (score) layer."""
    minx, miny, maxx, maxy = net.bounds
    x, y = minx - margin, miny - margin
    w, h = maxx - minx + 2 * margin, maxy - miny + 2 * margin
    groups = [("cut", "Cut", path_data(net), ""),
              ("fold", "Fold (score)", line_data(folds), ' stroke-dasharray="2 1.5"')]
    out = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" '
        f'width="{_fmt(w)}mm" height="{_fmt(h)}mm" viewBox="{_fmt(x)} {_fmt(y)} {_fmt(w)} {_fmt(h)}">',
    ]
    for key, label, d, extra in groups:
        if not d:
            continue
        out.append(f'<g id="{key}" inkscape:groupmode="layer" inkscape:label="{label}" fill="none" '
                   f'stroke="{COLOURS[key]}" stroke-width="0.2" stroke-linecap="round" '
                   f'stroke-linejoin="round"{extra}>')
        out.append(f'<path d="{d}"/>')
        out.append("</g>")
    out.append("</svg>")
    return "\n".join(out) + "\n", [x, y, w, h]


# --------------------------------------------------------------------- build

def checked_decoration(raw, index, walls):
    name = str(raw.get("name") or f"decoration {index + 1}")
    try:
        wall = int(raw.get("wall", 0))
    except (TypeError, ValueError):
        raise PaperError(f"{name}: the wall must be a number") from None
    # A template with fewer walls than the last one: the last wall takes the rest.
    wall = min(max(wall, 0), walls - 1)
    mode = raw.get("mode", "frame")
    d = {"name": name, "wall": wall, "mode": LEGACY_MODES.get(mode, mode),
         "thickness": _finite(raw.get("thickness", 2), f"{name}: the thickness", 0),
         "rotation": _finite(raw.get("rotation", 0), f"{name}: the rotation") % 360}
    if d["mode"] not in MODES:
        raise PaperError(f"{name}: the mode must be one of: {', '.join(MODES)}")
    for key in ("x", "y", "width"):
        value = raw.get(key)
        d[key] = None if value is None else _finite(value, f"{name}: {key}", 0 if key == "width" else None)
    if raw.get("geometry") is not None:
        d["geometry"] = checked_geometry(raw["geometry"])
    d["file"] = raw.get("file")
    return d


def resolve(d, wall, area):
    """Fill in a new decoration's position and size, and (re)build its geometry if needed."""
    x0, y0, x1, y1 = area.bounds if not area.is_empty else (0, 0, *wall.size)
    if d["x"] is None:
        d["x"] = round((x0 + x1) / 2, 2)
    if d["y"] is None:
        d["y"] = round((y0 + y1) / 2, 2)
    if d["width"] is None:
        if not d["file"]:
            raise PaperError(f"{d['name']}: a width is needed")
        _, (bx0, by0, bx1, by1) = read_decoration(d["file"])
        aspect = (by1 - by0) / (bx1 - bx0)
        d["width"] = max(1.0, math.floor(FIT * min(x1 - x0, (y1 - y0) / aspect) * 2) / 2)
    key = geometry_key(d["width"], d["thickness"], d["mode"])
    if d.get("geometry") is None or d["geometry"].get("key") != key:
        if not d["file"]:
            raise PaperError(f"{d['name']}: the drawing is needed to resize it")
        if d["mode"] == "frame" and 2 * d["thickness"] >= d["width"]:
            raise PaperError(f"{d['name']}: the line thickness must be less than half its width")
        d["geometry"] = decoration_geometry(d["file"], d["width"], d["thickness"], d["mode"])


def fold_faces(net, folds, base=None):
    """The net split along its fold lines into faces, each hinged to the face it
    folds from, starting with the face under `base`, which stays flat.

    Everything is in the template's own coordinates. Each hinge runs so that
    turning the face a positive `angle` about it, right-handed, lifts the face
    up, towards the net's top face; a negative angle lowers it. Returns the
    faces as polygons, and as data for the preview.
    """
    lines = []
    for a, b, angle in folds:
        line = LineString([a, b])
        if line.length < 1e-6:
            continue
        # A hair longer, so the fold surely crosses the edge it ends on.
        dx, dy = (b[0] - a[0]) / line.length * 1e-4, (b[1] - a[1]) / line.length * 1e-4
        lines.append((LineString([(a[0] - dx, a[1] - dy), (b[0] + dx, b[1] + dy)]), line, angle))
    rings = [ring for p in _polygons(net) for ring in [p.exterior, *p.interiors]]
    noded = unary_union([*rings, *(extended for extended, _, _ in lines)])
    faces = [p for p in polygonize(noded) if net.contains(p.representative_point())]
    if not faces:
        raise PaperError("the net could not be split into faces along its folds")

    edges = {i: [] for i in range(len(faces))}
    for _, line, angle in lines:
        # The two faces filling a band along the fold. A band, not the line
        # itself, so that folds perforated by slits still join their faces.
        band = line.buffer(FOLD_BAND, cap_style="flat")
        touching = sorted(((f.intersection(band).area, i) for i, f in enumerate(faces)), reverse=True)
        if len(touching) >= 2 and touching[1][0] > 0.2 * FOLD_BAND * line.length:
            i, j = touching[0][1], touching[1][1]
            edges[i].append((j, line, angle))
            edges[j].append((i, line, angle))
    root = None
    if base is not None:
        root = next((i for i, f in enumerate(faces) if f.covers(Point(base))), None)
    if root is None:
        root = max(range(len(faces)), key=lambda i: faces[i].area)

    parent = {root: (-1, None, 0)}
    queue = [root]
    while queue:
        i = queue.pop(0)
        for j, line, angle in edges[i]:
            if j in parent:
                continue
            (ax, ay), (bx, by) = line.coords
            c = faces[j].representative_point()
            # Right-handed about a→b, the face's side must rise: (b - a) × (c - a) > 0.
            if (bx - ax) * (c.y - ay) - (by - ay) * (c.x - ax) < 0:
                (ax, ay), (bx, by) = (bx, by), (ax, ay)
            parent[j] = (i, [[round(ax, 4), round(ay, 4)], [round(bx, 4), round(by, 4)]], angle)
            queue.append(j)
    # The lengthened folds left points a hair apart along the edges; drop them.
    faces = [face.simplify(1e-3, preserve_topology=True) for face in faces]
    return faces, [{
        "rings": [[[round(x, 4), round(y, 4)] for x, y in list(ring.coords)[:-1]]
                  for ring in [face.exterior, *face.interiors]],
        "parent": parent.get(i, (-1,))[0],
        "hinge": parent.get(i, (-1, None))[1],
        "angle": parent.get(i, (-1, None, 0))[2],
    } for i, face in enumerate(faces)]


def template_layout(log):
    """What the template's "area" output echoed about its net, beyond its walls."""
    net_top = echoed(log, "app_net_top", "inside")
    fold_layer = echoed(log, "app_fold_layer", True)
    if net_top not in ("inside", "outside") or not isinstance(fold_layer, bool):
        raise PaperError('the template\'s app_net_top must be "inside" or "outside", app_fold_layer true or false')
    try:
        folds = [(a, b, _finite(fold[2] if len(fold) > 2 else 90, "a fold angle"))
                 for fold in echoed(log, "app_folds") for a, b in [fold[:2]]]
        up = [_finite(v, "app_up") for v in echoed(log, "app_up", [0, 0, 1])]
        base = echoed(log, "app_base", [])
        base = [_finite(v, "app_base") for v in base] if base else None
    except (TypeError, ValueError):
        raise PaperError("the template's app_folds, app_up or app_base are malformed") from None
    if len(up) != 3 or not any(up):
        raise PaperError("the template's app_up must be a direction [x, y, z]")
    return {"inside_up": net_top == "inside", "fold_layer": fold_layer, "folds": folds,
            "up": up, "base": base}


def scad_problems(log):
    """Errors OpenSCAD reported without failing, such as a file the template imports."""
    notes = []
    for line in log.splitlines():
        if not line.startswith("ERROR:"):
            continue
        missing = re.search(r"Can't open (?:import )?file '([^']*)'", line)
        note = (f"the template could not open {os.path.basename(missing.group(1))}; put it beside the template"
                if missing else "OpenSCAD: " + line[len("ERROR:"):].strip())
        if note not in notes:
            notes.append(note)
    return notes


def build(job, openscad="openscad", workdir=None):
    template = os.path.abspath(job["template"])
    if not os.path.isfile(template):
        raise PaperError("that paper template does not exist")
    params = dict(job.get("params") or {})
    raw_decorations = job.get("decorations") or []
    if len(raw_decorations) > MAX_DECORATIONS:
        raise PaperError(f"at most {MAX_DECORATIONS} decorations")

    with tempfile.TemporaryDirectory(dir=workdir) as tmp:
        def run(output, what, decorations):
            source, path = os.path.join(tmp, f"{output}.scad"), os.path.join(tmp, f"{output}.svg")
            with open(source, "w", encoding="utf-8") as stream:
                # Defined before the template is included: OpenSCAD's -D cannot
                # introduce a variable that earlier assignments can see.
                stream.write(f"app_decorations = {scad_decorations(decorations)};\n")
                stream.write(f"include <{template.replace(os.sep, '/')}>\n")
            log = finish_openscad(start_openscad(openscad, source, output, path, params), path, what)
            with open(path, encoding="utf-8") as stream:
                return log, even_odd(scad_svg_rings(stream.read()))

        log, area = run("area", "decoration area", [])
        layout = template_layout(log)
        view = View(layout["inside_up"])
        walls = [Wall(raw, view) for raw in echoed(log, "app_walls")]
        folds = layout["folds"]
        area = view.geom(area)
        # Each piece of the decoration area belongs to the wall it lies on.
        wall_areas = [[] for _ in walls]
        for piece in _polygons(area):
            point = piece.representative_point()
            for i, wall in enumerate(walls):
                if wall.contains((point.x, point.y)):
                    wall_areas[i].append(wall.to_local(piece))
                    break
        wall_areas = [unary_union(parts) if parts else Polygon() for parts in wall_areas]

        decorations = [checked_decoration(raw, i, len(walls)) for i, raw in enumerate(raw_decorations)]
        notes = []
        for d in decorations:
            resolve(d, walls[d["wall"]], wall_areas[d["wall"]])
            shape = placed(normal_shape(d["geometry"]), d)
            inside = shape.intersection(wall_areas[d["wall"]]).area if not shape.is_empty else 0
            d["notes"] = []
            if shape.is_empty:
                d["notes"].append("cuts nothing — its lines enclose no area at this thickness")
            elif inside < 1e-6:
                d["notes"].append(f"lies outside wall {d['wall'] + 1}'s decoration area and cuts nothing")
            elif shape.area - inside > 0.01 * shape.area:
                d["notes"].append(f"runs past wall {d['wall'] + 1}'s decoration area and is trimmed")
            if d["geometry"].get("loose"):
                n = d["geometry"]["loose"]
                d["notes"].append(f"{n} loose paper piece{'s' if n > 1 else ''} would fall out")
            notes.extend(f"{d['name']} {note}" for note in d["notes"])

        cut_log, sheet = run("cut", "net", decorations)
        notes.extend(scad_problems(log + cut_log))

    if sheet.is_empty:
        raise PaperError("the template drew an empty net")
    net = view.geom(sheet)
    view_folds = [[view.point(a), view.point(b)] for a, b, _ in folds]
    svg, bounds = net_svg(net, view_folds if layout["fold_layer"] else [])
    minx, miny, maxx, maxy = net.bounds
    pieces = list(_polygons(net))
    if len(pieces) > 1:
        notes.append(f"the net is in {len(pieces)} separate pieces")
    # Positive folds turn inward; the preview lifts faces towards the net's top face.
    lift = 1 if layout["inside_up"] else -1
    polygons, faces = fold_faces(sheet, [(a, b, lift * angle) for a, b, angle in folds], layout["base"])
    for wall in walls:
        # The face the wall is: most of the wall's own rectangle, back in the template's coordinates.
        rect = view.geom(affinity.affine_transform(box(0, 0, *wall.size), wall.matrix()))
        wall.face = max(range(len(polygons)), key=lambda i: polygons[i].intersection(rect).area)
    fold_lines = [LineString(f) for f in view_folds]
    return {
        "svg": svg,
        "view": [round(v, 3) for v in bounds],
        "net": path_data(net),
        "folds": line_data(view_folds),
        "area": path_data(area),
        "walls": [{**wall.summary(wall_areas[i]), "face": wall.face} for i, wall in enumerate(walls)],
        "decorations": [{
            "wall": d["wall"], "x": d["x"], "y": d["y"], "width": d["width"],
            "rotation": d["rotation"], "thickness": d["thickness"], "mode": d["mode"],
            "geometry": d["geometry"], "notes": d["notes"],
        } for d in decorations],
        # The 3D preview folds the sheet itself, in the template's coordinates:
        # which face is the inside, which way is up, and each face's hinge.
        "faces": faces,
        "netTop": "inside" if layout["inside_up"] else "outside",
        "up": layout["up"],
        "foldLayer": layout["fold_layer"],
        "info": {
            "width": round(maxx - minx, 2), "height": round(maxy - miny, 2),
            # Slits perforating a fold are not cut-outs.
            "cutouts": sum(1 for p in pieces for hole in p.interiors
                           if not any(line.intersects(Polygon(hole)) for line in fold_lines)),
            "notes": notes,
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("job", help="the job as JSON (see above)")
    parser.add_argument("--openscad", default="openscad", help="the OpenSCAD command")
    parser.add_argument("--output", help="also write the SVG here")
    args = parser.parse_args()
    with open(args.job, encoding="utf-8") as stream:
        job = json.load(stream)
    # Scratch files go beside the job, which the server clears away afterwards.
    result = build(job, args.openscad, os.path.dirname(os.path.abspath(args.job)))
    if args.output:
        with open(args.output, "w", encoding="utf-8") as stream:
            stream.write(result["svg"])
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    try:
        main()
    except PaperError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
