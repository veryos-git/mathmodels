"""Exact lines and arcs of a DXF subject, for editing its pointy tips and paths.

The tip and path editors work on the subject's own primitives, not on
flattened polylines. Model-space LINE, ARC and CIRCLE entities carry their
handle: the tip editor reshapes the arcs and keeps lines and circles as fixed
references, the path editor can move all three. Lines and arcs inside blocks
or polylines are reported without a handle and stay fixed. `read_sketch`
reports them; `write_edits` puts edited entities back into the same DXF by
handle and leaves every other entity untouched.

Every arc is reported counter-clockwise from ``start`` to ``end`` in world
coordinates; an arc drawn with a downward extrusion is turned round so that
holds.
"""
import math

import ezdxf
from ezdxf.math import Vec3
from ezdxf.path import make_path

MAX_INSERT_DEPTH = 5


def _read(path):
    """The DXF document; problems are ValueErrors worth showing verbatim."""
    if not path.lower().endswith(".dxf"):
        raise ValueError("Tip editing works on DXF subjects; this one is an SVG")
    try:
        return ezdxf.readfile(path)
    except IOError:
        raise ValueError("this file is not a readable DXF drawing") from None
    except Exception:
        raise ValueError("could not read this DXF — it looks truncated or corrupt") from None


def _planar(e):
    """+1 or -1 for an entity drawn in (or facing away from) the XY plane, else 0."""
    z = Vec3(e.dxf.get("extrusion", (0, 0, 1))).normalize()
    return 1 if z.isclose((0, 0, 1)) else -1 if z.isclose((0, 0, -1)) else 0


def _xy(v):
    return [float(v.x), float(v.y)]


def _arc(e, layer, editable):
    """An ARC entity as a counter-clockwise world-space arc, or None."""
    side = _planar(e)
    if not side:
        return None
    centre = e.ocs().to_wcs(e.dxf.center)
    start, end = e.start_point, e.end_point
    if side < 0:                           # mirrored OCS: clockwise in world space
        start, end = end, start
    return {"handle": e.dxf.handle if editable else None, "layer": layer,
            "center": _xy(centre), "radius": float(e.dxf.radius),
            "start": _xy(start), "end": _xy(end)}


def _collect(entities, layer_of, sketch, sagitta, editable, depth=0):
    for e in entities:
        kind = e.dxftype()
        layer = layer_of(e)
        if kind == "INSERT":
            if depth >= MAX_INSERT_DEPTH:
                continue
            try:
                exploded = list(e.virtual_entities())
            except Exception:
                continue
            outer = e.dxf.get("layer", "0")
            _collect(exploded, lambda c: outer if c.dxf.get("layer", "0") == "0" else c.dxf.get("layer", "0"),
                     sketch, sagitta, False, depth + 1)
        elif kind == "LINE":
            a, b = e.dxf.start, e.dxf.end
            if not Vec3(a).isclose(b):
                sketch["lines"].append({"handle": e.dxf.handle if editable else None,
                                        "layer": layer, "a": _xy(a), "b": _xy(b)})
        elif kind == "ARC":
            arc = _arc(e, layer, editable)
            if arc:
                sketch["arcs"].append(arc)
                continue
            sketch["polylines"].append({"layer": layer, "points": _flat(e, sagitta)})
        elif kind == "CIRCLE" and _planar(e):
            sketch["circles"].append({"handle": e.dxf.handle if editable else None,
                                      "layer": layer, "radius": float(e.dxf.radius),
                                      "center": _xy(e.ocs().to_wcs(e.dxf.center))})
        elif kind in ("LWPOLYLINE", "POLYLINE"):
            # Bulged segments become fixed arcs: tangency targets, not editable.
            try:
                parts = list(e.virtual_entities())
            except Exception:
                continue
            _collect(parts, lambda _: layer, sketch, sagitta, False, depth + 1)
        elif kind in ("SPLINE", "ELLIPSE", "CIRCLE"):
            points = _flat(e, sagitta)
            if len(points) >= 2:
                sketch["polylines"].append({"layer": layer, "points": points})


def _flat(e, sagitta):
    try:
        return [[float(p.x), float(p.y)] for p in make_path(e).flattening(sagitta)]
    except Exception:
        return []


def read_sketch(path, sagitta=0.02):
    """The subject's lines, circles and arcs; model-space ones carry a handle."""
    doc = _read(path)
    sketch = {"lines": [], "circles": [], "arcs": [], "polylines": []}
    _collect(doc.modelspace(), lambda e: e.dxf.get("layer", "0"), sketch, sagitta, True)
    if not (sketch["lines"] or sketch["arcs"] or sketch["circles"] or sketch["polylines"]):
        raise ValueError("no drawable geometry found in this DXF")
    return sketch


def _numbers(edit, *keys):
    """The edit's coordinates as finite floats, flattened in `keys` order."""
    try:
        values = [float(v) for key in keys
                  for v in (edit[key] if isinstance(edit[key], (list, tuple)) else [edit[key]])]
    except (KeyError, TypeError, ValueError):
        values = None
    if values is None or len(values) != sum(1 if key == "radius" else 2 for key in keys):
        raise ValueError(f"Each {edit.get('kind', 'arc')} edit needs a handle and its "
                         + ", ".join(keys)) from None
    if not all(math.isfinite(v) for v in values):
        raise ValueError("Edited paths need finite coordinates")
    return values


def _editable(doc, edit, kind):
    """The model-space entity an edit names, checked against its kind."""
    handle = str(edit.get("handle"))
    e = doc.entitydb.get(handle)
    if e is None or e.dxftype() != kind.upper() or e.dxf.owner != doc.modelspace().block_record_handle:
        raise ValueError(f"No editable {kind} {handle} in this DXF")
    if kind != "line" and not _planar(e):
        raise ValueError(f"{kind.capitalize()} {handle} is not drawn in the XY plane")
    return e


def write_edits(path, edits, out):
    """Apply edits to model-space entities by handle and save to `out`.

    * ``{handle, center, radius, start, end}`` — an arc, counter-clockwise in
      world space as `read_sketch` reports them (``kind: "arc"`` is optional);
    * ``{kind: "line", handle, a, b}`` — a line's two ends;
    * ``{kind: "circle", handle, center, radius}`` — a circle.

    The edited entity keeps its handle, layer and style. Arcs and circles are
    written with an upward extrusion at their original elevation; line ends
    keep their own elevation. Returns how many entities of each kind changed.
    """
    doc = _read(path)
    counts = {}
    for edit in edits:
        if not isinstance(edit, dict):
            raise ValueError("Each edit must be an object")
        kind = edit.get("kind", "arc")
        if kind == "line":
            e = _editable(doc, edit, "line")
            ax, ay, bx, by = _numbers(edit, "a", "b")
            if math.hypot(bx - ax, by - ay) <= 0:
                raise ValueError(f"Line {edit['handle']} would shrink to nothing")
            e.dxf.start = (ax, ay, e.dxf.start.z)
            e.dxf.end = (bx, by, e.dxf.end.z)
        elif kind in ("arc", "circle"):
            e = _editable(doc, edit, kind)
            keys = ("center", "radius") + (("start", "end") if kind == "arc" else ())
            cx, cy, radius, *ends = _numbers(edit, *keys)
            if radius <= 0:
                raise ValueError(f"Edited {kind}s need a positive radius")
            elevation = e.ocs().to_wcs(e.dxf.center).z
            e.dxf.extrusion = (0, 0, 1)
            e.dxf.center = (cx, cy, elevation)
            e.dxf.radius = radius
            if kind == "arc":
                sx, sy, ex, ey = ends
                e.dxf.start_angle = math.degrees(math.atan2(sy - cy, sx - cx)) % 360
                e.dxf.end_angle = math.degrees(math.atan2(ey - cy, ex - cx)) % 360
        else:
            raise ValueError(f"Unknown edit kind {kind!r}: expected arc, line or circle")
        counts[f"{kind}s"] = counts.get(f"{kind}s", 0) + 1
    doc.saveas(out)
    return counts


def write_arcs(path, edits, out):
    """Write the tip editor's ``[{handle, center, radius, start, end}]`` arcs."""
    return write_edits(path, [{**edit, "kind": "arc"} for edit in edits], out)
