"""Exact lines and arcs of a DXF subject, for editing its pointy tips.

The tip editor works on the subject's own primitives, not on flattened
polylines: lines and circles are fixed references, model-space ARC entities
are editable. `read_sketch` reports them; `write_arcs` puts edited arcs back
into the same DXF by entity handle and leaves every other entity untouched.

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
                sketch["lines"].append({"layer": layer, "a": _xy(a), "b": _xy(b)})
        elif kind == "ARC":
            arc = _arc(e, layer, editable)
            if arc:
                sketch["arcs"].append(arc)
                continue
            sketch["polylines"].append({"layer": layer, "points": _flat(e, sagitta)})
        elif kind == "CIRCLE" and _planar(e):
            sketch["circles"].append({"layer": layer, "radius": float(e.dxf.radius),
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
    """The subject's lines, circles and arcs; model-space arcs carry a handle."""
    doc = _read(path)
    sketch = {"lines": [], "circles": [], "arcs": [], "polylines": []}
    _collect(doc.modelspace(), lambda e: e.dxf.get("layer", "0"), sketch, sagitta, True)
    if not (sketch["lines"] or sketch["arcs"] or sketch["circles"] or sketch["polylines"]):
        raise ValueError("no drawable geometry found in this DXF")
    return sketch


def write_arcs(path, edits, out):
    """Apply ``[{handle, center, radius, start, end}]`` edits and save to `out`.

    Each edit is a counter-clockwise world-space arc, as `read_sketch` reports
    them. The edited entity keeps its handle, layer and style; it is written
    with an upward extrusion at its original elevation.
    """
    doc = _read(path)
    for edit in edits:
        try:
            handle = str(edit["handle"])
            (cx, cy), radius = map(float, edit["center"]), float(edit["radius"])
            (sx, sy), (ex, ey) = map(float, edit["start"]), map(float, edit["end"])
        except (KeyError, TypeError, ValueError):
            raise ValueError("Each arc edit needs a handle, centre, radius, start and end") from None
        if not all(math.isfinite(v) for v in (cx, cy, radius, sx, sy, ex, ey)) or radius <= 0:
            raise ValueError("Edited arcs need finite coordinates and a positive radius")
        e = doc.entitydb.get(handle)
        if e is None or e.dxftype() != "ARC" or e.dxf.owner != doc.modelspace().block_record_handle:
            raise ValueError(f"No editable arc {handle} in this DXF")
        if not _planar(e):
            raise ValueError(f"Arc {handle} is not drawn in the XY plane")
        elevation = e.ocs().to_wcs(e.dxf.center).z
        e.dxf.extrusion = (0, 0, 1)
        e.dxf.center = (cx, cy, elevation)
        e.dxf.radius = radius
        e.dxf.start_angle = math.degrees(math.atan2(sy - cy, sx - cx)) % 360
        e.dxf.end_angle = math.degrees(math.atan2(ey - cy, ex - cx)) % 360
    doc.saveas(out)
