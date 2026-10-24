#!/usr/bin/env python3
"""Convert a DXF or SVG sketch into a relief STL.

- Every curve is "slotted": buffered to a ribbon of `wall_width` and
  extruded to `wall_height`.
- The enclosed faces/regions between the walls are extruded to a random
  height between `region_min` and `region_max` (rounded to `region_step`).
- Each face is grown `wall_overlap` into the wall around it, so the two fuse
  when printed instead of meeting along a bare seam.

Machine-readable stats go to stdout as JSON; human notes go to stderr.

Usage:
    dxf2stl.py input.dxf output.stl [--wall-width 1.0] [--wall-height 2.0]
                [--region-min 0.2] [--region-max 2.0] [--region-step 0.1]
                [--seed N] [--sagitta 0.02] [--layers A,B,C]
                [--profile profile.dxf] [--also layer2.json]
                [--boundary crop.dxf] [--no-boundary-wall]
                [--effect maya-pyramid] [--effect-steps 4] [--effect-inset 0.3]
    dxf2stl.py input.dxf --inspect

--profile takes a drawing holding one closed cross-section and sweeps it along
every curve to form the frame, replacing the flat --wall-width ribbons.

--boundary takes a drawing holding a closed polygon and cuts the subject down
to it: whatever lies outside is thrown away, and the boundary itself is walled
so the cropped subject comes out with a rim (--no-boundary-wall cuts flush
instead). The polygon is read in the drawing's own coordinates and scaled with
it, so it is drawn over the subject; --boundary-scale, --boundary-x and
--boundary-y place it by eye. --boundary-fit instead centres the boundary on
the subject and scales it uniformly to just fit inside it, for files that do
not share a coordinate system.

--effect reshapes every face without touching the painting: maya-pyramid
splits a face's painted height into terraces, each stepped one --effect-inset
further in from its own outline than the one below it.

--also stacks another drawing on top: its JSON spec holds the drawing's "file"
plus its own "scale", "layers", "stacks"/"heights" and "holes". Each extra
drawing is centred on the base drawing and sits on the frame top of the one
below; colour groups are shared, so split and 3MF exports merge the layers.
"""

from gothic import (solid_union, revolved_ending, dome_ending, stepped_profile_sweep,
                    segmented_profile_sweep, path_frames, hook_solid)
import argparse
import base64
import itertools
import json
import math
import os
import random
import re
import sys
import uuid
import zipfile
from collections import defaultdict

import ezdxf
import numpy as np
import svgelements
import trimesh
from ezdxf.path import make_path
from shapely import STRtree, difference, set_precision, union, union_all
from shapely.affinity import scale as aff_scale
from shapely.affinity import translate
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import nearest_points, polygonize, unary_union
from shapely.prepared import prep

# Entity types make_path() can turn into a polyline. Anything else (TEXT,
# HATCH, SOLID, ...) carries no usable outline and is reported as skipped.
CURVE_TYPES = frozenset(
    ("LINE", "ARC", "CIRCLE", "ELLIPSE", "LWPOLYLINE", "POLYLINE", "SPLINE")
)

MAX_INSERT_DEPTH = 5


class ConvertError(Exception):
    """A problem worth showing to the user verbatim, without a traceback."""


def iter_entities(entities, depth=0):
    """Walk a layout, expanding block references into their real entities."""
    for e in entities:
        if e.dxftype() == "INSERT":
            if depth >= MAX_INSERT_DEPTH:
                continue
            try:
                exploded = list(e.virtual_entities())
            except Exception:  # a block we cannot explode is not fatal
                continue
            for child in iter_entities(exploded, depth + 1):
                # Block geometry drawn on layer "0" takes the layer of the
                # block reference, so the layer picker shows what CAD shows.
                if child.dxf.get("layer", "0") == "0":
                    child.dxf.layer = e.dxf.get("layer", "0")
                yield child
        else:
            yield e


def dxf_curves(path, sagitta, layers=None):
    """Read the drawing as flattened polylines, plus a summary of what we saw."""
    try:
        doc = ezdxf.readfile(path)
    except IOError:
        raise ConvertError("this file is not a readable DXF drawing") from None
    except ezdxf.DXFStructureError as exc:
        # ezdxf quotes the on-disk path, which is a server temp dir the user
        # has no business seeing.
        raise ConvertError(f"corrupt DXF file: {str(exc).replace(path, 'the file')}") from None
    except Exception:
        # A truncated file surfaces as StopIteration and friends, not as one of
        # ezdxf's declared errors.
        raise ConvertError("could not read this DXF — it looks truncated or corrupt") from None

    curves = []
    used = {}     # layer -> count of entities that became curves
    skipped = {}  # dxftype -> count of entities we could not use

    for e in iter_entities(doc.modelspace()):
        t = e.dxftype()
        layer = e.dxf.get("layer", "0")
        if t not in CURVE_TYPES:
            skipped[t] = skipped.get(t, 0) + 1
            continue
        if layers is not None and layer not in layers:
            continue
        try:
            geom = make_path(e)
        except Exception:
            skipped[t] = skipped.get(t, 0) + 1
            continue
        n_before = len(curves)
        for sub in geom.sub_paths():
            pts = [(p.x, p.y) for p in sub.flattening(sagitta)]
            # Drop consecutive duplicates; shapely rejects zero-length segments.
            dedup = [pts[0]] if pts else []
            for p in pts[1:]:
                if p != dedup[-1]:
                    dedup.append(p)
            if len(dedup) >= 2:
                curves.append(dedup)
        if len(curves) > n_before:
            used[layer] = used.get(layer, 0) + 1

    if not curves:
        if layers is not None:
            raise ConvertError("no drawable entities on the selected layers")
        raise ConvertError(
            "no drawable geometry found — this DXF has no lines, arcs, circles, "
            "polylines or splines in model space"
        )
    return curves, used, skipped


# svgelements resolves every SVG length to pixels at 96 ppi, which is the
# spec's own px-to-millimetre ratio.
MM_PER_PX = 25.4 / 96.0
MAX_FLATTEN_DEPTH = 16


def _chord_gap(p, a, b):
    """How far p sits from the segment a-b."""
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    span = dx * dx + dy * dy
    if span == 0.0:
        return math.hypot(p[0] - ax, p[1] - ay)
    t = min(1.0, max(0.0, ((p[0] - ax) * dx + (p[1] - ay) * dy) / span))
    return math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy))


def flatten_segment(seg, tol, out):
    """Append points along one SVG segment, subdividing until it is flat."""
    def point(t):
        p = seg.point(t)
        return (float(p.x), float(p.y))

    def walk(t0, t1, p0, p1, depth):
        # Sample inside the span rather than only at the middle: an S-curve can
        # cross its own chord at the midpoint while bulging either side of it.
        flat = all(
            _chord_gap(point(t0 + (t1 - t0) * f), p0, p1) <= tol
            for f in (0.25, 0.5, 0.75)
        )
        if flat or depth >= MAX_FLATTEN_DEPTH:
            out.append(p1)
            return
        tm = 0.5 * (t0 + t1)
        pm = point(tm)
        walk(t0, tm, p0, pm, depth + 1)
        walk(tm, t1, pm, p1, depth + 1)

    start, end = point(0.0), point(1.0)
    if not out:
        out.append(start)
    walk(0.0, 1.0, start, end, 0)


def svg_shapes(node, layer, skipped):
    """Walk the SVG tree, yielding (shape, layer name) pairs.

    Groups name the layers, so an Inkscape drawing keeps its layer structure
    and the existing layer picker works on SVGs too.
    """
    for child in node:
        values = getattr(child, "values", {})
        if str(values.get("display", "")).strip() == "none":
            continue                      # a hidden Inkscape layer, for instance
        if str(values.get("visibility", "")).strip() in ("hidden", "collapse"):
            continue

        if isinstance(child, svgelements.Shape):
            yield child, layer
        elif isinstance(child, (svgelements.Group, svgelements.Use)):
            label = next(
                (values[k] for k in values
                 if k == "inkscape:label" or k.endswith("}label")),
                None,
            )
            yield from svg_shapes(child, label or values.get("id") or layer, skipped)
        else:
            # Text, images and the like carry no outline we can slot.
            tag = values.get("tag", type(child).__name__)
            skipped[tag] = skipped.get(tag, 0) + 1


def svg_curves(path, sagitta, layers=None, scale=1.0):
    """Read an SVG's outlines as flattened polylines, in millimetres."""
    try:
        svg = svgelements.SVG.parse(path)
    except Exception:
        raise ConvertError("could not read this SVG — it looks malformed") from None

    unit = MM_PER_PX * scale
    # SVG's y axis points down; flip about the page so the relief is not mirrored.
    try:
        flip = float(svg.height)
    except (TypeError, ValueError):
        flip = 0.0
    tol = sagitta / unit if unit > 0 else sagitta

    curves, used, skipped = [], {}, {}
    for shape, layer in svg_shapes(svg, "(root)", skipped):
        tag = shape.values.get("tag", type(shape).__name__)
        if layers is not None and layer not in layers:
            continue
        try:
            segments = shape.segments()
        except Exception:
            skipped[tag] = skipped.get(tag, 0) + 1
            continue

        n_before = len(curves)
        run = []
        for seg in segments:
            if isinstance(seg, svgelements.Move):
                if len(run) >= 2:
                    curves.append(run)
                run = []
                continue
            try:
                flatten_segment(seg, tol, run)
            except Exception:
                continue
        if len(run) >= 2:
            curves.append(run)

        if len(curves) > n_before:
            used[layer] = used.get(layer, 0) + 1
        else:
            skipped[tag] = skipped.get(tag, 0) + 1

    # Drop repeated points, then convert to millimetres with y flipped.
    scaled = []
    for run in curves:
        dedup = [run[0]]
        for p in run[1:]:
            if p != dedup[-1]:
                dedup.append(p)
        if len(dedup) >= 2:
            scaled.append([(x * unit, (flip - y) * unit) for x, y in dedup])

    if not scaled:
        if layers is not None:
            raise ConvertError("no drawable entities on the selected layers")
        raise ConvertError("no drawable geometry found — this SVG has no paths or shapes")
    return scaled, used, skipped


def read_curves(path, sagitta, layers=None, scale=1.0):
    """Outlines from either supported drawing format."""
    if path.lower().endswith(".svg"):
        return svg_curves(path, sagitta, layers, scale)
    curves, used, skipped = dxf_curves(path, sagitta, layers)
    if scale != 1.0:
        curves = [[(x * scale, y * scale) for x, y in c] for c in curves]
    return curves, used, skipped


def inspect(path, sagitta, scale=1.0):
    """Report the layers that carry usable geometry, for the layer picker."""
    curves, used, skipped = read_curves(path, sagitta, scale=scale)
    xs = [p[0] for c in curves for p in c]
    ys = [p[1] for c in curves for p in c]
    return {
        "layers": [
            {"name": name, "entities": n} for name, n in sorted(used.items())
        ],
        "skipped": [{"type": t, "count": n} for t, n in sorted(skipped.items())],
        "curves": len(curves),
        "size": [round(max(xs) - min(xs), 3), round(max(ys) - min(ys), 3)],
    }


MIN_REGION_AREA = 1e-6

# A clipped curve shorter than this is a rounding artefact, not geometry.
MIN_CURVE_LENGTH = 1e-6


def polygons_of(geom):
    """Yield every Polygon contained in a shapely geometry."""
    if geom.is_empty:
        return
    if geom.geom_type == "Polygon":
        yield geom
    elif geom.geom_type in ("MultiPolygon", "GeometryCollection"):
        for g in geom.geoms:
            yield from polygons_of(g)


def grow_into_walls(region, overlap, silhouette):
    """A face widened so it bites `overlap` mm into the wall around it.

    Printed, a face that only meets the frame along a vertical seam has nothing
    holding it there — a thin one can drop straight out. Letting the two solids
    overlap gives the slicer material to fuse across the join. The growth is
    clipped to the silhouette so a face on the edge of the drawing cannot spill
    past the frame's outer face.
    """
    # Round joins, but coarse ones: at this radius a corner arc is a fraction
    # of a millimetre, and every segment of it is triangles in the STL.
    grown = region.buffer(overlap, join_style="round", quad_segs=2)
    parts = [p for p in polygons_of(grown.intersection(silhouette))
             if p.area >= MIN_REGION_AREA]
    # A pinch in the silhouette could in principle split the grown face; the
    # body of it is the piece that matters, and an empty result means the face
    # is better left as it was.
    return max(parts, key=lambda p: p.area) if parts else region


def confine_curves(curves, wall_width):
    """The curves redrawn so the walls end on the outermost line.

    A curve is normally traced down the middle of its wall, so the frame
    stands half a wall width outside the drawing: a 100 mm square walled
    10 mm wide comes out 110 mm across. Confined, the outermost line is where
    the model *ends* — that curve is moved half a wall width inwards and
    everything else is trimmed to stay behind it, so the same square comes out
    at exactly 100 mm with its walls still 10 mm thick.

    Only the outside of the drawing moves. A shape sitting inside another one
    is an island in its face and has nothing to do with how wide the model
    prints, so it stays as drawn — as does anything with no room to pull a
    wall into, such as an open stroke or a shape thinner than the wall.
    """
    lines = [LineString(c) for c in curves]
    walls = unary_union(lines).buffer(wall_width / 2.0, cap_style="round",
                                      join_style="round")
    # One piece per connected group of walls, and the shape each one draws:
    # the piece with its faces filled in.
    pieces = list(polygons_of(walls))
    shapes = [Polygon(p.exterior) for p in pieces]
    tree = STRtree(shapes)

    rooms = []   # per piece: where its centrelines may run, or None to leave it
    outer = []   # the new outermost centrelines
    for i, shape in enumerate(shapes):
        # `within` is reflexive, so a shape always finds itself.
        if any(j != i for j in tree.query(shape, predicate="within")):
            rooms.append(None)
            continue
        # Taking the buffer back off the shape lands on the outermost curve,
        # and a second half width in is where that curve has to run for its
        # wall to end there instead of straddling it.
        room = [p for p in polygons_of(shape.buffer(-wall_width))
                if p.area >= MIN_REGION_AREA]
        rooms.append(unary_union(room) if room else None)
        outer += [list(p.exterior.coords) for p in room]

    if all(room is None for room in rooms):
        return curves

    # Every curve lies inside exactly one piece — its own buffer is part of it.
    pieces_tree = STRtree(pieces)
    out = []
    for line, coords in zip(lines, curves):
        found = pieces_tree.query(line, predicate="intersects")
        room = rooms[found[0]] if len(found) else None
        if room is None:
            out.append(coords)
            continue
        clipped = line.intersection(room)
        for part in getattr(clipped, "geoms", [clipped]):
            if part.geom_type == "LineString" and part.length > MIN_CURVE_LENGTH:
                out.append(list(part.coords))
    return out + outer


def plan_regions(curves, wall_width, wall_overlap=0.0, clip=None):
    """The wall ribbons and the faces they enclose, in a stable order.

    `clip` is the boundary the model may not reach past: everything is cut to
    it before the faces are worked out, so a face's id is its place among the
    faces that survive rather than among the ones the subject had before it
    was cropped.
    """
    lines = [LineString(c) for c in curves]

    # Walls: every curve slotted to a ribbon.
    walls = unary_union(lines).buffer(wall_width / 2.0, cap_style="round", join_style="round")

    # Silhouette: each wall piece's exterior ring filled in. This covers the
    # walls plus every face they enclose, and is robust against the small
    # gaps/overlaps that flattened arcs leave at intersections.
    silhouette = unary_union([Polygon(p.exterior) for p in polygons_of(walls)])

    # The boundary is where the model stops. Both are cut *after* the
    # silhouette is filled in, so a face the boundary crosses is trimmed to it
    # rather than lost — whatever closed that face may itself be outside.
    if clip is not None:
        walls = unary_union(list(polygons_of(walls.intersection(clip))))
        silhouette = unary_union(list(polygons_of(silhouette.intersection(clip))))

    # Regions: connected components of the silhouette minus the walls.
    regions = [p for p in polygons_of(silhouette.difference(walls)) if p.area >= MIN_REGION_AREA]

    # A region's id is its position here, and the browser hands those ids back
    # when it asks for the STL, so the order must not depend on shapely's
    # internals. Sorting by area then centroid pins it down.
    regions.sort(key=lambda p: (-round(p.area, 6), round(p.centroid.x, 6), round(p.centroid.y, 6)))

    # Ids are settled above, on the faces as drawn, so turning the overlap up
    # or down never renumbers what the browser has already painted.
    if wall_overlap > 0:
        regions = [grow_into_walls(p, wall_overlap, silhouette) for p in regions]

    wall_polys = list(polygons_of(walls))
    if not wall_polys:
        raise ConvertError("the walls enclosed nothing — try a smaller wall width")
    return wall_polys, regions


# ---------------------------------------------------------------- profile sweep
#
# Advanced mode: instead of buffering every curve into a flat-topped ribbon,
# a closed cross-section (its own DXF/SVG drawing) is swept along the curves.
# The profile drawing's x axis runs across the path, its y axis is the height.

MITER_LIMIT = 4.0

def closed_faces(path, sagitta, what):
    """Every area a drawing's lines enclose, rebuilt from loose entities.

    An outline usually arrives as separate lines and arcs rather than one
    polyline, so the rings are recovered by polygonizing. A snap-round comes
    first: CAD exports carry ~1e-14 endpoint jitter that keeps polygonize from
    closing rings. The result is the *smallest* faces the lines enclose, so a
    ring drawn inside another one comes back as two — see `even_odd`.
    """
    curves, _, _ = read_curves(path, sagitta)
    snapped = [[(round(x, 6), round(y, 6)) for x, y in c] for c in curves]
    faces = list(polygonize(unary_union([LineString(c) for c in snapped])))
    if not faces:
        raise ConvertError(f"the {what} drawing has no closed outline — "
                           f"the {what} must be a closed shape")
    return faces


def load_profile(path, sagitta, origin=None):
    """The closed cross-section to sweep, anchored centre-x / bottom edge.

    Interior construction lines dissolve in the union, and the largest shape
    left is the section — a profile is one closed outline, not several.
    An explicit origin registers a cutter against the main profile instead.
    """
    merged = unary_union(closed_faces(path, sagitta, "profile"))
    polys = list(polygons_of(merged))
    if not polys:
        raise ConvertError("the profile drawing has no closed outline — "
                           "the sweep profile must be one closed shape")
    profile = max(polys, key=lambda p: p.area)
    minx, miny, maxx, _ = profile.bounds
    if origin is None:
        origin = ((minx + maxx) / 2.0, miny)
    return translate(profile, xoff=-origin[0], yoff=-origin[1])


def load_profile_sections(path, groove_path, sagitta, cusp_path=None):
    """Unscaled sections in the same coordinates used by the sweep and editor."""
    profile = load_profile(path, sagitta, origin=(0, 0))
    minx, miny, maxx, _ = profile.bounds
    origin = ((minx + maxx) / 2, miny)
    profile = translate(profile, xoff=-origin[0], yoff=-origin[1])
    return {
        "main": profile,
        "groove": load_profile(groove_path, sagitta, origin=origin) if groove_path else None,
        "cusp": load_profile(cusp_path, sagitta) if cusp_path else profile,
    }


def load_sweep_profiles(path, groove_path, sagitta, width_scale=1.0,
                        height_scale=1.0, groove_width=None, groove_height=None,
                        profile_z=0.0, groove_z=0.0):
    """Place both sections relative to the main section's centre and base.

    A cutter must keep its drawn elevation and lateral offset. Anchoring it
    independently would drop its tip onto the base and cut through the frame.
    """
    # Omitted cutter scales retain the original shared-scaling API behavior.
    groove_width = width_scale if groove_width is None else groove_width
    groove_height = height_scale if groove_height is None else groove_height
    for label, value in (("Profile width", width_scale), ("Profile height", height_scale),
                         ("Groove width", groove_width), ("Groove height", groove_height)):
        if not math.isfinite(value) or value <= 0:
            raise ConvertError(f"{label} scale must be greater than 0")
    if not all(math.isfinite(v) for v in (profile_z, groove_z)):
        raise ConvertError("Profile and groove vertical offsets must be finite")
    sections = load_profile_sections(path, groove_path, sagitta)
    profile, groove = sections["main"], sections["groove"]
    return (translate(aff_scale(profile, xfact=width_scale, yfact=height_scale, origin=(0, 0)), yoff=profile_z),
            translate(aff_scale(groove, xfact=groove_width, yfact=groove_height, origin=(0, 0)), yoff=groove_z)
            if groove is not None else None)


def chain_curves(curves, min_dot=-0.95):
    """Curves joined end-to-end into the longest possible polylines.

    Entities rarely arrive as one polyline per visual stroke, and a swept
    joint only comes out right where the sweep runs straight through it.
    Where several segments meet, the straightest continuation is the real
    path — pairing them up arbitrarily turns the chain back on itself and
    the sweep folds into garbage there. Near-reversing tangents are separate
    capped sweeps, as at the bottom cusp of a pair of pointed arches.

    Each junction pairs its ends on its own, straightest pair first. Growing
    one chain at a time instead lets the first chain to arrive take a turn
    meant for two other strokes: a bar ending at a frame's corner would
    turn into one side of the frame and leave the frame open there.
    """
    segs = []
    seen = set()
    for c in curves:
        pts = [(round(x, 6), round(y, 6)) for x, y in c]
        if len(pts) < 2:
            continue
        # Patterns and mirrors often draw the same stroke twice; sweeping a
        # duplicate only sends the chain straight back where it came from.
        key = tuple(pts)
        rkey = tuple(pts[::-1])
        if key in seen or rkey in seen:
            continue
        seen.add(key)
        segs.append(pts)

    def unit(a, b):
        d = (b[0] - a[0], b[1] - a[1])
        n = math.hypot(*d)
        return (d[0] / n, d[1] / n) if n else (0.0, 0.0)

    # The ends at each junction, keyed (segment, at its last point), with
    # the direction leading away from the junction into the segment.
    ends = defaultdict(list)
    for j, seg in enumerate(segs):
        if seg[0] != seg[-1]:
            ends[seg[0]].append(((j, False), unit(seg[0], seg[1])))
            ends[seg[-1]].append(((j, True), unit(seg[-1], seg[-2])))
    partner = {}
    for meeting in ends.values():
        # Running in along one end and out along the other: how straight.
        pairs = [(-(a[0] * b[0] + a[1] * b[1]), x, y)
                 for x, (_, a) in enumerate(meeting)
                 for y, (_, b) in enumerate(meeting) if x < y]
        for score, x, y in sorted(pairs, key=lambda p: (-p[0], p[1], p[2])):
            if score < min_dot:
                break
            a, b = meeting[x][0], meeting[y][0]
            if a not in partner and b not in partner:
                partner[a], partner[b] = b, a

    used = [False] * len(segs)

    def run(j, backwards):
        """Points along segment j and on through paired junctions."""
        points = []
        while j is not None and not used[j]:
            used[j] = True
            seg = segs[j][::-1] if backwards else segs[j]
            points += seg if not points else seg[1:]
            j, backwards = partner.get((j, not backwards), (None, None))
        return points

    chains = []
    for i, seg in enumerate(segs):
        if used[i]:
            continue
        # Keep the earliest segment's drawn direction; a loop closes itself.
        chain = run(i, False)
        before = partner.get((i, False))
        if before is not None and not used[before[0]]:
            chain = run(before[0], before[1])[::-1][:-1] + chain
        chains.append(chain)
    return chains


def repeat_paths(paths, offsets, merge=True):
    """Copies of the paths at each offset; the paths themselves without offsets.

    Neighbouring copies redraw the same edges, often as parts of different
    polylines. Merging nodes the copies together on a micron grid so each
    shared stretch is swept once, and chain_curves rejoins the pieces.
    """
    if offsets is None:
        return paths
    copies = [[(x + dx, y + dy) for x, y in path] for dx, dy in offsets for path in paths]
    if not merge or not copies:
        return copies
    merged = union_all([LineString(path) for path in copies], grid_size=1e-6)
    return [list(line.coords) for line in getattr(merged, "geoms", [merged])
            if line.geom_type == "LineString" and not line.is_empty]


def merged_chains(chains, tolerance=1e-3):
    """The chains with every stretch swept once and no sub-`tolerance` jogs.

    Sketches often redraw part of a stroke inside another, a hair off the
    original. Two sweeps along a shared stretch touch everywhere without
    fusing. Each chain gives up only what an earlier one already covers,
    on a grid that makes such near-copies coincide, and otherwise keeps
    its own course and direction through junctions, so mitres and
    asymmetric sections stay as drawn. Jogs left where strokes part are
    segments whose directions are noise, so they are simplified away;
    `tolerance` (in mm) is far below print resolution.
    """
    grid = tolerance / 10
    covered, paths = None, []
    for chain in chains:
        if len(chain) < 2:
            continue
        line = set_precision(LineString(chain), grid)
        nearby = prep(covered) if covered is not None else None
        runs, run = [], []
        # Walk the chain's own segments in order: overlay would rejoin a path
        # that passes back through itself into a different course.
        for a, b in zip(line.coords, line.coords[1:]):
            segment = LineString([a, b])
            rest = (segment if nearby is None or not nearby.intersects(segment)
                    else difference(segment, covered, grid_size=grid))
            parts = [p for p in getattr(rest, "geoms", [rest])
                     if p.geom_type == "LineString" and not p.is_empty]
            for part in sorted(parts, key=lambda p: segment.project(Point(p.coords[0]))):
                coords = list(part.coords)
                if run and run[-1] == coords[0]:
                    run += coords[1:]
                else:
                    runs.append(run)
                    run = coords
        runs.append(run)
        covered = line if covered is None else union(covered, line, grid_size=grid)
        for run in runs:
            if len(run) < 2:
                continue
            part = LineString(run).simplify(tolerance, preserve_topology=False)
            if part.length > tolerance:
                paths.append(list(part.coords))
    # A chain cut short by a shared stretch resumes along the earlier stroke.
    # Chain first: chaining rounds coordinates, which would undo exactness.
    return exact_junctions(chain_curves(paths), tolerance)


def exact_junctions(paths, tolerance, straight=math.radians(1)):
    """The paths with every near-junction made exact.

    A stroke that ends, or turns, a few nanometres beside another (CAD
    rounding does this, as does the grid above) leaves its sweep a sub-STL
    distance from the other's ridge, and float32 rounding folds the slivers
    between them into open edges. Vertices closer than `tolerance` become
    one, and a vertex within `tolerance` of another stroke moves onto it,
    which is threaded through the vertex there. Strokes running straight
    (within `straight`) through a vertex never bend there, as a hair's kink
    would leave two nearly coplanar prism faces, slivers of their own: the
    vertex only slides along such a stroke, and stays where two cross.
    """
    points = [tuple(p) for path in paths for p in path]
    if not points:
        return []
    owner, index = zip(*[(n, i) for n, path in enumerate(paths) for i in range(len(path))])

    def turn(k):
        """How sharply the path turns at point k; None at a free end."""
        path, i = paths[owner[k]], index[k]
        closed = path[0] == path[-1] and len(path) > 2
        if not closed and i in (0, len(path) - 1):
            return None
        before = path[i - 1] if i > 0 else path[-2]
        after = path[i + 1] if i < len(path) - 1 else path[1]
        a, b = np.subtract(path[i], before), np.subtract(after, path[i])
        return abs(math.atan2(a[0] * b[1] - a[1] * b[0], a @ b))

    bends = [turn(k) for k in range(len(points))]
    # Weld clusters onto the member whose stroke runs straightest through it.
    rank = [(math.inf if t is None else t, k) for k, t in enumerate(bends)]
    parent = list(range(len(points)))

    def root(k):
        while parent[k] != k:
            parent[k] = parent[parent[k]]
            k = parent[k]
        return k

    shapes = [Point(p) for p in points]
    for i, j in zip(*STRtree(shapes).query(shapes, predicate="dwithin", distance=tolerance)):
        a, b = root(int(i)), root(int(j))
        if a != b:
            keep, drop = sorted((a, b), key=lambda k: rank[k])
            parent[drop] = keep
    welded = [points[root(k)] for k in range(len(points))]
    starts = np.cumsum([0] + [len(path) for path in paths])
    guides = defaultdict(list)
    for k, t in enumerate(bends):
        if t is not None and t < straight:
            n, i = owner[k], index[k]
            before = k - 1 if i > 0 else starts[n] + len(paths[n]) - 2
            guides[welded[k]].append(LineString([welded[before], welded[k]]))
    # Each vertex near another stroke moves onto it: onto the nearest
    # segment, or where two strokes cross beside it, onto their crossing.
    segments = [(n, i, LineString([welded[k], welded[k + 1]]))
                for k, (n, i) in enumerate(zip(owner, index))
                if i < len(paths[n]) - 1]
    tree = STRtree([s for _, _, s in segments])
    moves = {}
    for vertex in set(welded):
        here = Point(vertex)
        near = [segments[s] for s in tree.query(here, predicate="dwithin", distance=tolerance)]
        near = sorted(((segment.distance(here), n, i, segment) for n, i, segment in near
                       if min(here.distance(Point(c)) for c in segment.coords) >= tolerance),
                      key=lambda m: m[0])
        lines = guides[vertex]
        if not near or any(_crossing(lines[0], line) is not None for line in lines[1:]):
            continue
        hits = near[:1]
        if lines:
            target = _crossing(lines[0], near[0][3])
        else:
            target = _foot(near[0][3], vertex)
            for other in near[1:]:
                crossing = _crossing(near[0][3], other[3])
                if crossing is not None and here.distance(Point(crossing)) < tolerance:
                    target, hits = crossing, [near[0], other]
                    break
        if target is not None and here.distance(Point(target)) < tolerance:
            moves[vertex] = (target, [(n, i, segment) for _, n, i, segment in hits])
    # A segment whose own end moves would no longer pass through its thread.
    planned = set(moves)
    threads = defaultdict(list)
    for vertex, (target, hits) in list(moves.items()):
        if any({welded[starts[n] + i], welded[starts[n] + i + 1]} & planned for n, i, _ in hits):
            del moves[vertex]
            continue
        for n, i, segment in hits:
            threads[n, i].append((segment.project(Point(target)), target))
    result, k = [], 0
    for n, path in enumerate(paths):
        own = [moves[p][0] if p in moves else p for p in welded[k:k + len(path)]]
        k += len(path)
        out = own[:1]
        for i, end in enumerate(own[1:]):
            out += [p for _, p in sorted(threads[n, i])] + [end]
        # Welding can fold two vertices of one path together.
        out = out[:1] + [p for prev, p in zip(out, out[1:]) if p != prev]
        if len(out) >= 2:
            result.append(out)
    return result


def _foot(segment, point):
    """The point on `segment` nearest `point`, computed along the segment."""
    (ax, ay), (bx, by) = segment.coords
    t = segment.project(Point(point), normalized=True)
    return (ax + t * (bx - ax), ay + t * (by - ay))


def _crossing(first, second):
    """Where the lines through two segments cross, or None if parallel."""
    (ax, ay), (bx, by) = first.coords
    (cx, cy), (dx, dy) = second.coords
    det = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx)
    if abs(det) < 1e-12 * first.length * second.length:
        return None
    t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / det
    return (ax + t * (bx - ax), ay + t * (by - ay))


def sweep_profile(profile, chains):
    """The frame as one mesh: the profile swept along every path.

    The path lies in the drawing plane, so the moving frame is simple — the
    profile's x runs along the path's in-plane normal, its y is z. Planar
    paths mean no twist. Corners are mitred: the ring sits on the angle
    bisector, pushed out by 1/cos(half the turn), exactly like a mitered
    stroke join — so the apex of a pointed arch comes to a real point.
    Past MITER_LIMIT the mitre is clipped to a bevel, or a cusp would spike.
    """
    # CAD sketches often contain collinear intermediate vertices. Earcut
    # removes them from caps; leaving them in the sides creates T-junctions
    # and prevents these otherwise closed sweeps from being solid-unioned.
    profile = profile.simplify(0, preserve_topology=True)
    try:
        mesh = stepped_profile_sweep(profile, chains, MITER_LIMIT)
        if mesh is None:
            mesh = _ring_profile_sweep(profile, chains)
        # solid_union checks its parts one at a time, but an STL reader
        # welds parts that touch at an edge; the whole must stay closed.
        welded = mesh.copy()
        welded.merge_vertices()
        if welded.is_volume:
            return mesh
    except (ValueError, RuntimeError):
        pass
    # Wide sections can fold through themselves on tight bends, or leave
    # tangent slivers that collapse when STL rounds vertices to float32.
    # Rebuild from closed prisms so the boolean resolves their overlaps.
    # This recovery belongs to all sweeps, including tracery and cutters.
    # Which sweeps fail is set by chance coincidences in the geometry,
    # not by the width, so the prisms also get a cleaned path network.
    from cylinder import printable_mesh
    try:
        return printable_mesh(segmented_profile_sweep(profile, merged_chains(chains), MITER_LIMIT))
    except (ValueError, RuntimeError) as error:
        raise ConvertError("Could not build the profile sweep: the swept paths did not form "
                           f"closed solids at STL precision ({error})") from error


def _ring_profile_sweep(profile, chains):
    """Join consecutive profile rings, preserving clipped mitres exactly."""
    ring = list(profile.exterior.coords)[:-1]
    cap_v, cap_f = trimesh.creation.triangulate_polygon(profile)
    meshes = []
    for chain in chains:
        closed = chain[0] == chain[-1]
        pts = chain[:-1] if closed else chain
        n = len(pts)
        if n < 2:
            continue
        P, N, closed = path_frames(chain, MITER_LIMIT)

        k = len(ring)
        verts = np.array([
            [(P[i, 0] + px * N[i, 0], P[i, 1] + px * N[i, 1], py) for px, py in ring]
            for i in range(n)
        ]).reshape(n * k, 3)
        faces = []
        for i in range(n if closed else n - 1):
            a, b = i, (i + 1) % n
            for j in range(k):
                j2 = (j + 1) % k
                faces.append((a * k + j, b * k + j, b * k + j2))
                faces.append((a * k + j, b * k + j2, a * k + j2))
        pieces = [trimesh.Trimesh(vertices=verts, faces=np.array(faces),
                                 process=False)]

        if not closed:
            for ring_i, flip in ((0, True), (n - 1, False)):
                v = np.zeros((len(cap_v), 3))
                v[:, 0] = P[ring_i, 0] + cap_v[:, 0] * N[ring_i, 0]
                v[:, 1] = P[ring_i, 1] + cap_v[:, 0] * N[ring_i, 1]
                v[:, 2] = cap_v[:, 1]
                cap = trimesh.Trimesh(vertices=v, faces=np.array(cap_f),
                                      process=False)
                if flip:
                    cap.invert()
                pieces.append(cap)
        # Close and orient each independent sweep before fusing the network.
        # Repairing only after concatenation can weld crossing paths together
        # into non-manifold edges and mixes up cap and side orientations.
        mesh = trimesh.util.concatenate(pieces)
        mesh.merge_vertices()
        mesh.update_faces(mesh.nondegenerate_faces())
        mesh.remove_unreferenced_vertices()
        mesh.fix_normals(multibody=True)
        meshes.append(mesh)
    return solid_union(meshes)


def subtract_groove(mesh, profile, chains, z_offset=0, trim=None):
    """Subtract the whole cutter network after the positive sweeps are fused.

    Cutting the 2D section first leaves material from neighbouring sweeps
    inside the groove at junctions. A final solid difference clears it there.
    `trim` keeps only x between its two values, cut before the result is
    checked at STL precision so only the part that is kept must pass.
    """
    from cylinder import manifold, mesh_of, printable_mesh

    cutter = sweep_profile(profile, chains)
    if z_offset:
        cutter.apply_translation((0, 0, z_offset))
    try:
        solid = manifold(mesh) - manifold(cutter)
        if trim is not None:
            solid = solid.trim_by_plane((1, 0, 0), trim[0]).trim_by_plane((-1, 0, 0), -trim[1])
        solid = solid.simplify(.0001)
        result = mesh_of(solid)
        # Tangencies can leave zero-volume fragments; keep only closed solids
        # that remain valid after float32 STL vertices have been welded.
        parts = []
        for part in result.split(only_watertight=False, repair=False):
            local = part.copy()
            local.apply_translation(-local.vertices.mean(axis=0))
            if not part.is_watertight and np.linalg.matrix_rank(local.vertices, tol=1e-7) < 3:
                continue  # A collapsed sliver can leave an isolated planar face.
            if abs(local.volume) > 1e-6:
                parts.append(part)
        if not parts:
            raise ValueError("the groove profile removes the entire frame")
        # Split parts can each be closed yet touch at an edge, which an STL
        # reader welds into one shared by four faces; check them together.
        mesh = trimesh.util.concatenate(parts)
        mesh.merge_vertices()
        if not mesh.is_volume:
            # Grazing junctions can leave two surfaces meeting at one welded
            # edge; printable_mesh joins or merges those tiny contacts.
            try:
                return printable_mesh(solid)
            except ValueError:
                raise ValueError("the grooved frame is not closed at STL precision; "
                                 "adjust the profile or curve tolerance") from None
        return mesh
    except (ValueError, RuntimeError) as error:
        raise ConvertError(f"Could not subtract the groove: {error}") from error


# ------------------------------------------------------------- boundary crop
#
# A second drawing — a closed polygon — bounds the subject: whatever lies
# outside it is cut away. The polygon is read in the subject's own coordinates
# and scaled with it, so a crop drawn over the subject lands where it was
# drawn, with its own size multiplier and nudge on top for placing it by eye.


def even_odd(faces):
    """The faces a CAD fill would ink, given nested rings.

    polygonize hands back the smallest faces the lines enclose, so a ring
    inside another ring arrives as two: the inner disc, and the band between
    them. Counting how many of those faces' outlines a face sits inside says
    which are filled — odd is ink, even is a hole — which is what makes a
    boundary drawn as two circles a ring rather than a disc.
    """
    shells = [Polygon(f.exterior) for f in faces]
    inked = []
    for face in faces:
        point = face.representative_point()
        if sum(1 for shell in shells if shell.contains(point)) % 2:
            inked.append(face)
    return inked


def load_boundary(path, sagitta):
    """The bounding polygon, in the drawing's own coordinates."""
    boundary = unary_union(even_odd(closed_faces(path, sagitta, "boundary")))
    polys = [p for p in polygons_of(boundary) if p.area >= MIN_REGION_AREA]
    if not polys:
        raise ConvertError("the boundary drawing encloses no area — "
                           "the boundary must be a closed polygon")
    return unary_union(polys)


def place_boundary(boundary, scale, boundary_scale, dx, dy, fit_to=None):
    """The boundary moved into the scaled drawing's coordinates.

    As drawn, it is scaled with the subject and stays registered on it. Fit
    instead re-anchors it: the boundary is centred on the subject's box and
    scaled — uniformly, so its shape holds — until it just fits inside it.
    That is the behaviour you want when the two files came out of different
    coordinate systems. Its own size multiplier works about its centre, and
    the nudge is in finished millimetres — the units the model is measured
    in — so both mean the same thing whatever the drawing was drawn in.
    """
    # The drawing's scale comes first — the fit is worked out in the scaled
    # coordinates, where the subject's box is measured.
    placed = aff_scale(boundary, xfact=scale, yfact=scale, origin=(0.0, 0.0))
    if fit_to is not None:
        (pminx, pminy, pmaxx, pmaxy) = fit_to
        bminx, bminy, bmaxx, bmaxy = placed.bounds
        bw, bh = bmaxx - bminx, bmaxy - bminy
        pw, ph = pmaxx - pminx, pmaxy - pminy
        # Uniform, so the boundary is not stretched; it just fits, so a
        # boundary drawn square stays square.
        k = min(pw / bw, ph / bh) if bw and bh else 1.0
        placed = aff_scale(placed, xfact=k, yfact=k, origin="center")
        placed = translate(placed,
                           xoff=(pminx + pmaxx) / 2.0 - (bminx + bmaxx) / 2.0,
                           yoff=(pminy + pmaxy) / 2.0 - (bminy + bmaxy) / 2.0)
    if boundary_scale != 1.0:
        placed = aff_scale(placed, xfact=boundary_scale, yfact=boundary_scale,
                           origin="center")
    if dx or dy:
        placed = translate(placed, xoff=dx, yoff=dy)
    return placed


def transform_curves(curves, scale, dx, dy, centre=None):
    """Resize and slide the subject inside the boundary.

    The boundary stays put; this moves what is shown through it. Scaling is
    about the subject's own centre, and the shift is in model millimetres, so
    both mean the same thing whatever the subject was drawn in.
    """
    if scale == 1.0 and not dx and not dy:
        return curves
    xs = [p[0] for c in curves for p in c]
    ys = [p[1] for c in curves for p in c]
    cx = (min(xs) + max(xs)) / 2.0
    cy = (min(ys) + max(ys)) / 2.0
    if centre is not None:
        cx, cy = centre
    out = []
    for c in curves:
        out.append([(round((x - cx) * scale + cx + dx, 6),
                     round((y - cy) * scale + cy + dy, 6))
                    for x, y in c])
    return out


def clip_curves(curves, region):
    """Every curve trimmed to the part of it that lies inside `region`.

    Most curves are wholly in or wholly out, and answering that from a
    prepared geometry is far cheaper than intersecting each one: a subject
    cropped to a small window is thousands of curves thrown away untouched.
    """
    guard = prep(region)
    out = []
    for coords in curves:
        line = LineString(coords)
        if guard.contains(line):
            out.append(coords)
            continue
        if not guard.intersects(line):
            continue
        clipped = line.intersection(region)
        for part in getattr(clipped, "geoms", [clipped]):
            if part.geom_type == "LineString" and part.length > MIN_CURVE_LENGTH:
                out.append(list(part.coords))
    return out


def boundary_curves(region):
    """The boundary's own outlines, to be walled like any other curve."""
    return [list(ring.coords)
            for poly in polygons_of(region)
            for ring in (poly.exterior, *poly.interiors)]


def polys_centre(polys):
    """The centre of the bounding box holding every polygon."""
    minx = min(p.bounds[0] for p in polys)
    miny = min(p.bounds[1] for p in polys)
    maxx = max(p.bounds[2] for p in polys)
    maxy = max(p.bounds[3] for p in polys)
    return ((minx + maxx) / 2.0, (miny + maxy) / 2.0)


def preview(args):
    """The subject and boundary outlines, in millimetres, for the 2D window.

    This is only the geometry the browser needs to draw the position preview:
    the subject's flattened curves and the boundary's own rings, both at their
    drawn size. The browser scales and slides them exactly as `place_boundary`
    and `transform_curves` will, so the preview matches the crop.
    """
    curves, _, _ = read_curves(args.input, args.sagitta, args.layers, scale=1.0)
    out = {
        "subject": {
            "curves": [[[round(x, 3), round(y, 3)] for x, y in c] for c in curves],
        },
        "boundary": None,
    }
    if args.boundary:
        boundary = load_boundary(args.boundary, args.sagitta)
        rings = []
        for poly in polygons_of(boundary):
            rings.append([[round(x, 3), round(y, 3)] for x, y in poly.exterior.coords])
            for interior in poly.interiors:
                rings.append([[round(x, 3), round(y, 3)] for x, y in interior.coords])
        out["boundary"] = {"rings": rings}
    return out


def frame_connections(wall_polys, crop, wall_width):
    """Short ribs bridging floating frame pieces, so a frame-only print holds together.

    A frame-only model is the boundary plus the subject's own lines. When the
    subject does not reach the boundary — a small motif inside a lantern-sized
    crop — the silhouette prints as a loose second part. This returns one
    straight rib from each piece that would float to the piece it should hold
    on to: the boundary rim when the boundary is walled, otherwise the largest
    piece in the frame.
    """
    if crop is None:
        return []
    pieces = list(polygons_of(unary_union(wall_polys)))
    if len(pieces) < 2:
        return []
    rim = unary_union([
        LineString(ring.coords).buffer(wall_width / 2.0, cap_style="round",
                                       join_style="round")
        for poly in polygons_of(crop)
        for ring in (poly.exterior, *poly.interiors)
    ])
    anchored = [piece for piece in pieces if piece.intersects(rim)]
    anchor = max(anchored or pieces, key=lambda piece: piece.area)
    ribs = []
    for piece in pieces:
        if piece.equals(anchor) or piece.intersects(anchor):
            continue
        start, end = nearest_points(piece, anchor)
        if start.distance(end) > 1e-6:
            ribs.append(LineString([start, end]))
    return ribs


def plan_drawing(path, scale, layers_csv, args, boundary=None, defer_frame=False):
    """One drawing read and planned into walls and faces.

    This is the whole per-drawing pipeline: curves in, the boundary crop and
    the profile sweep if there are any, then the wall ribbons and the regions
    they enclose. Stacking several drawings means calling this once per
    drawing and offsetting the results. `defer_frame` leaves the sweep to the
    returned `build_frame`, for sketch repeats.
    """
    layers = None
    if layers_csv:
        layers = {name for name in layers_csv.split(",") if name}
    curves, used, skipped = read_curves(path, args.sagitta, layers, scale)

    wall_width, wall_height = args.wall_width, args.wall_height
    profile = groove_profile = None
    groove_path = getattr(args, "groove_profile", None)
    if groove_path and not args.profile:
        raise ConvertError("A groove profile requires a main sweep profile")
    if args.profile:
        profile, groove_profile = load_sweep_profiles(
            args.profile, groove_path, args.sagitta, args.profile_scale,
            args.profile_height_scale, args.groove_width, args.groove_height,
            args.profile_z, args.groove_z)
        minx, _, maxx, maxy = profile.bounds
        # The profile sets the frame's dimensions: its x span is the wall
        # width the faces are planned against, its top is the wall height.
        wall_width, wall_height = maxx - minx, maxy

    cusp_curves = []
    cusp_section = None
    if args.cusps:
        if profile is None:
            raise ConvertError("Cusp paths require a main sweep profile")
        if not (all(math.isfinite(v) and v > 0 for v in (args.cusp_width, args.cusp_height))
                and math.isfinite(args.cusp_z)):
            raise ConvertError("Cusp width/height must be positive and elevation must be finite")
        cusp_curves, _, _ = read_curves(args.cusps, args.sagitta, None, scale)
        # Reuse the drawn section, before the main frame's width/height scales.
        cusp_section = load_profile(args.cusp_profile or args.profile, args.sagitta)
        cusp_section = aff_scale(cusp_section, xfact=args.cusp_width, yfact=args.cusp_height, origin=(0, 0))
        cusp_section = translate(cusp_section, yoff=args.cusp_z)
        wall_height = max(wall_height, cusp_section.bounds[3])
    if args.round_ends and profile is None:
        raise ConvertError("Rounded endings require a sweep profile")
    if args.hooks and profile is None:
        raise ConvertError("Hooks are swept from the main profile; choose one first")

    # The boundary crops the subject. Walled — the default — the cut curves
    # plus the boundary's own rings are the drawing from here on, so the rim
    # closes the faces along the cut like any other wall. Cut flush instead and
    # the subject is planned as drawn and trimmed afterwards, so a face the cut
    # runs through survives as the part of it that is inside.
    crop = n_cropped = None
    n_curves = len(curves)
    if boundary is not None:
        fit_to = None
        if args.boundary_fit:
            # The subject's own box, in its drawing units, before scaling: the
            # boundary is fitted to this, so the crop lands on the subject
            # whatever coordinate systems the two files were drawn in.
            xs = [p[0] for c in curves for p in c]
            ys = [p[1] for c in curves for p in c]
            fit_to = (min(xs), min(ys), max(xs), max(ys))
        crop = place_boundary(boundary, scale, args.boundary_scale,
                              args.boundary_x, args.boundary_y, fit_to)

    # The subject inside the boundary — the subject itself — is resized and slid under the
    # boundary after the boundary is placed, so the frame stays put while the
    # crop finds its composition. Without a boundary this would only shift the
    # model and break the finished-size maths, so it is applied to the crop.
    content = None
    if boundary is not None:
        points = [p for c in curves for p in c]
        centre = ((min(p[0] for p in points)+max(p[0] for p in points))/2,
                  (min(p[1] for p in points)+max(p[1] for p in points))/2)
        # Kept so the paint can be matched back in the subject's own frame, where
        # sliding or resizing the content leaves every face where it was.
        content = {"scale": args.subject_scale,
                   "shift": [args.subject_x, args.subject_y],
                   "centre": [centre[0], centre[1]]}
        if cusp_curves:
            cusp_curves = transform_curves(cusp_curves, args.subject_scale, args.subject_x, args.subject_y, centre)
        curves = transform_curves(curves, args.subject_scale,
                                  args.subject_x, args.subject_y)

    if boundary is not None:
        inside = clip_curves(curves, crop)
        if not inside:
            raise ConvertError("the boundary does not overlap the drawing — "
                               "nothing of the subject would be left")
        n_cropped = len(curves) - len(inside)
        n_curves = len(inside)
        if args.boundary_wall:
            rings = boundary_curves(crop)
            curves = inside + rings
            n_curves = len(curves)

    # Confining moves the outermost curves, so it has to happen before
    # anything is built on them — the sweep included.
    if args.confine_walls:
        curves = confine_curves(curves, wall_width)

    # A swept frame is a mesh, and a mesh cannot be cut here, so the sweep
    # follows only what lies inside the boundary. With the boundary walled the
    # curves are already trimmed to it.
    swept = curves if crop is None or args.boundary_wall \
        else clip_curves(curves, crop)
    if crop is not None and cusp_curves:
        cusp_curves = clip_curves(cusp_curves, crop)

    # Where the model is allowed to reach. A walled boundary is a curve like
    # any other, so its wall straddles the line with half of it outside, just
    # as the drawing's own outermost curve does; confined, the model ends on
    # the line. With no wall the cut is flush and the boundary itself is the
    # edge of the model.
    clip = None
    if crop is not None:
        clip = crop if args.confine_walls or not args.boundary_wall else \
            crop.buffer(wall_width / 2.0, join_style="round", quad_segs=8)

    wall_polys, region_polys = plan_regions(curves, wall_width,
                                            args.wall_overlap, clip)
    if cusp_curves:
        cusp_walls = unary_union([LineString(c).buffer((cusp_section.bounds[2] - cusp_section.bounds[0])/2) for c in cusp_curves])
        region_polys = [q for p in region_polys for q in polygons_of(p.difference(cusp_walls))]
    if args.frame_only:
        region_polys = []

    # A frame-only print is the boundary plus the subject's own lines, so a
    # subject that floats inside the boundary would come off the bed as a loose
    # second part. Ribs bridge every floating piece to the boundary; the full
    # model keeps the clean frame and lets the painted faces do the joining.
    connection_curves, connection_polys = [], []
    if crop is not None:
        connection_curves = frame_connections(wall_polys, crop, wall_width)
        if connection_curves and profile is None:
            connection_polys = [
                rib.buffer(wall_width / 2.0, cap_style="round",
                           join_style="round")
                for rib in connection_curves
            ]
    if args.frame_only and connection_polys:
        wall_polys = wall_polys + connection_polys

    # Every path vertex is a candidate for an ending or a hook (only meaningful
    # when a sweep profile is loaded). Both free ends and interior/closed-loop
    # corners qualify; the build picks each hook's outward direction from the
    # local geometry. Deduplicated by rounded position.
    open_endpoints = []
    if profile is not None:
        seen = set()
        for chain in chain_curves(list(swept)):
            vertices = chain[:-1] if len(chain) > 1 and chain[0] == chain[-1] else chain
            for pt in vertices:
                key = (round(float(pt[0]), 4), round(float(pt[1]), 4))
                if key in seen:
                    continue
                seen.add(key)
                open_endpoints.append([key[0], key[1]])

    # Dome endings: load the target coordinates once (closure for build_frame).
    dome_ends_coords = []
    if args.dome_ends:
        try:
            with open(args.dome_ends) as _fp:
                dome_ends_coords = [np.asarray(pt, dtype=float) for pt in json.load(_fp)]
        except (OSError, ValueError, TypeError) as _e:
            raise ConvertError(f"Could not read dome-ends file: {_e}") from _e

    # Hooks: each spec continues the main profile along a hook path at the open
    # endpoint nearest its (x, y). Loaded once as a closure for build_frame.
    hook_specs = []
    if args.hooks:
        try:
            with open(args.hooks) as _fp:
                hook_specs = list(json.load(_fp))
        except (OSError, ValueError, TypeError) as _e:
            raise ConvertError(f"Could not read hooks file: {_e}") from _e
        for _spec in hook_specs:
            if not (isinstance(_spec, dict) and all(math.isfinite(float(_spec.get(k, float("nan"))))
                                                    for k in ("x", "y"))):
                raise ConvertError("Each hook needs finite x and y endpoint coordinates")
            if not math.isfinite(float(_spec.get("offset", 0.0))):
                raise ConvertError("A hook's vertical offset must be a finite number")

    def build_frame(offsets=None, trim=None):
        """The swept frame and its connection ribs; None for flat walls.

        `offsets` sweeps copies of the drawing instead, and `trim` keeps
        only x between its two values, for the sketch repeats on a cylinder
        (see repeat_sketch). A cylinder never uses separate ribs, so trimmed
        frames return none.
        """
        if profile is None:
            return None, None
        paths = repeat_paths(swept, offsets)
        frame_mesh = sweep_profile(profile, chain_curves(paths))
        # Hooks stand on the paths the groove is swept along, so a groove cut
        # after them would slice through every hook. They join the frame
        # after the groove unless --groove-last asks for the old order.
        late = []

        if args.cusps or args.round_ends or dome_ends_coords or hook_specs:
            solids = [frame_mesh]
            cusps = repeat_paths(cusp_curves, offsets, merge=False)
            end_section = cusp_section if args.cusps else profile
            end_chains = chain_curves(cusps if args.cusps else paths, min_dot=-0.5)
            if cusps:
                solids.append(sweep_profile(cusp_section, end_chains))
            if args.round_ends:
                for chain in end_chains:
                    if chain[0] == chain[-1] or len(chain) < 2:
                        continue
                    for index, neighbour in ((0, 1), (-1, -2)):
                        point = np.asarray(chain[index], dtype=float)
                        forward = point - np.asarray(chain[neighbour], dtype=float)
                        forward /= max(np.linalg.norm(forward), 1e-12)
                        # Avoid rolling an ending at a connection to the main frame.
                        if args.cusps and any(LineString(c).distance(Point(point)) <= max(1e-4, args.sagitta*2) for c in paths):
                            continue
                        tangent = -forward if index == 0 else forward
                        normal = np.array([-tangent[1], tangent[0]])
                        solids.append(revolved_ending(end_section, point, normal, forward,
                                                      args.end_angle, args.end_side))
            if dome_ends_coords:
                dome_chains = chain_curves(paths, min_dot=-0.5)
                tol = max(1e-2, args.sagitta * 2)
                for chain in dome_chains:
                    if chain[0] == chain[-1] or len(chain) < 2:
                        continue
                    for index, neighbour in ((0, 1), (-1, -2)):
                        point = np.asarray(chain[index], dtype=float)
                        if not any(np.linalg.norm(point - t) <= tol for t in dome_ends_coords):
                            continue
                        forward = point - np.asarray(chain[neighbour], dtype=float)
                        forward /= max(np.linalg.norm(forward), 1e-12)
                        tangent = -forward if index == 0 else forward
                        normal = np.array([-tangent[1], tangent[0]])
                        solids.append(dome_ending(profile, point, normal, forward))
            if hook_specs:
                tol = max(1e-2, args.sagitta * 2)
                overlap = max(args.sagitta * 2, 0.05)
                # Hooks stand up out of the drawing plane. They all face the
                # same way, along the drawing's -Y by default, whatever the
                # path does at their vertex; `rotation` turns one about Z, and
                # `offset` slides it up the drawing's vertical axis (+Y) from
                # the vertex. One hook per vertex, even where several paths
                # meet there.
                placed = set()
                for chain in chain_curves(paths, min_dot=-0.5):
                    for point in path_frames(chain)[0]:
                        key = (round(float(point[0]) / tol), round(float(point[1]) / tol))
                        spec = next((s for s in hook_specs
                                     if abs(float(s["x"]) - point[0]) <= tol
                                     and abs(float(s["y"]) - point[1]) <= tol), None)
                        if spec is None or key in placed:
                            continue
                        placed.add(key)
                        turn = math.radians(float(spec.get("rotation", 0.0)))
                        forward = np.array([math.sin(turn), -math.cos(turn)])
                        anchor = point + (0.0, float(spec.get("offset", 0.0)))
                        try:
                            # The profile is centred on both the path and the
                            # hook, so an unshifted hook's root always overlaps
                            # the frame.
                            hook = hook_solid(profile, anchor, forward, spec, overlap)
                        except ValueError as error:
                            raise ConvertError(str(error)) from error
                        (late if groove_profile is not None and not args.groove_last
                         else solids).append(hook)
            try:
                frame_mesh = solid_union(solids)
            except (ValueError, RuntimeError) as error:
                raise ConvertError(f"Could not fuse tracery: {error}") from error

        ribs = repeat_paths([list(rib.coords) for rib in connection_curves], offsets)
        connection_mesh = sweep_profile(profile, chain_curves(ribs)) if ribs else None
        if args.frame_only and connection_mesh is not None:
            try:
                frame_mesh = solid_union([frame_mesh, connection_mesh])
            except (ValueError, RuntimeError) as error:
                raise ConvertError(f"Could not fuse the frame connections: {error}") from error

        if trim is not None:
            connection_mesh = None
        if groove_profile is not None:
            groove_chains = chain_curves(paths + ribs)
            frame_mesh = subtract_groove(frame_mesh, groove_profile, groove_chains, trim=trim)
            if connection_mesh is not None:
                connection_mesh = subtract_groove(connection_mesh, groove_profile, groove_chains)
        elif trim is not None:
            from cylinder import manifold, printable_mesh
            try:
                frame_mesh = printable_mesh(manifold(frame_mesh).trim_by_plane((1, 0, 0), trim[0])
                                            .trim_by_plane((-1, 0, 0), -trim[1]))
            except ValueError as error:
                raise ConvertError(f"Could not cut the repeated frame: {error}") from error
        if late:
            # The grooved frame can hold parts that only touch at an edge, so
            # fuse with the same manifold tools the groove cut used.
            from cylinder import manifold, printable_mesh
            try:
                solid = manifold(frame_mesh)
                for hook in late:
                    solid = solid + manifold(hook)
                if trim is not None:
                    solid = solid.trim_by_plane((1, 0, 0), trim[0]).trim_by_plane((-1, 0, 0), -trim[1])
                frame_mesh = printable_mesh(solid.simplify(.0001))
            except (ValueError, RuntimeError) as error:
                raise ConvertError(f"Could not fuse the hooks onto the grooved frame: {error}") from error
        return frame_mesh, connection_mesh

    # Sketch repeats sweep the frame later, once every drawing is placed.
    frame_mesh, connection_mesh = (None, None) if defer_frame else build_frame()
    xs = [x for c in swept for x, _ in c]
    ys = [y for c in swept for _, y in c]

    summary = {
        "curves": n_curves,
        "layers": [{"name": n, "entities": c} for n, c in sorted(used.items())],
        "skipped": [{"type": t, "count": c} for t, c in sorted(skipped.items())],
    }
    if n_cropped is not None:
        summary["cropped"] = n_cropped
    return {
        "paint_scale": scale,
        "content": content,
        "crop": crop,
        "wall_polys": wall_polys,
        "region_polys": region_polys,
        "connection_curves": connection_curves,
        "connection_polys": connection_polys,
        "connection_mesh": connection_mesh,
        "wall_height": wall_height,
        "frame_mesh": frame_mesh,
        "build_frame": build_frame,
        "open_endpoints": open_endpoints,
        "sketch_bounds": (min(xs), min(ys), max(xs), max(ys)) if xs else None,
        "summary": summary,
    }


def repeat_sketch(layers, nx, ny):
    """Rebuild every frame from nx × ny copies of the sketch, for a cylinder.

    The copies follow each other at the base drawing's sketch size, so the
    paths at its ends coincide and are swept, and grooved, once as a single
    network instead of once per copy. The frame is made periodic: one column
    one sketch wide and ny copies tall is cut from the network and checked
    at STL precision once, then joined to its own copies around the shell.
    A large network checked whole fails far more often at grazing junctions.

    The cut sits partway across the sketch rather than on its outer paths,
    where a planar cut through a sweep's centreline leaves slivers. Sizes
    are rounded to a 2^-30 mm grid so the copies' cut faces coincide exactly.
    Faces stay a single copy; they repeat at the same spacing when wrapped,
    so every copy shares its paint.

    Returns the layout the wrap needs: the repeat period and the flat bounds
    that cover the shell exactly once, starting at the column.
    """
    def on_grid(value):
        return round(value * 2**30) / 2**30

    if layers[0]["sketch_bounds"] is None:
        raise ConvertError("Sketch repeats need a drawing with paths to sweep")
    x0, y0, x1, y1 = layers[0]["sketch_bounds"]
    width, height = on_grid(x1 - x0), on_grid(y1 - y0)
    if min(width, height) <= 1e-6:
        raise ConvertError("Sketch repeats need a drawing with positive width and height")
    start = on_grid(x0 + 0.3819660112501051 * width)
    end = start + width
    # The column spans two copies; one more either side reaches across it.
    offsets = [(ix * width, iy * height) for iy in range(ny) for ix in range(-1, 3)]
    # Float32 rounding moves the cut faces by a few ULPs; put them back.
    snap = max(1e-5, abs(start) * 2**-22, abs(end) * 2**-22)

    lo, hi = math.inf, -math.inf
    for drawing in layers:
        dx, dy = drawing["offset"]
        frame, drawing["connection_mesh"] = drawing["build_frame"](offsets, (start - dx, end - dx))
        if frame is not None:
            frame.apply_translation((dx, dy, 0.0))
            vertices = frame.vertices.copy()
            x = vertices[:, 0]
            vertices[:, 0] = np.where(np.abs(x - start) < snap, start,
                                      np.where(np.abs(x - end) < snap, end, x))
            frame.vertices = vertices
            drawing["frame_mesh"] = frame
            frame_lo, frame_hi = frame.bounds[:, 1]
        else:
            # Flat walls are the buffered paths, so their copies simply merge.
            walls = unary_union([translate(p, ox, oy) for p in drawing["wall_polys"]
                                 for ox, oy in offsets])
            frame_lo, frame_hi = walls.bounds[1], walls.bounds[3]
            column = box(start, frame_lo - 1, end, frame_hi + 1)
            drawing["wall_polys"] = list(polygons_of(walls.intersection(column)))
        lo, hi = min(lo, frame_lo), max(hi, frame_hi)
        for poly in drawing["region_polys"]:
            lo = min(lo, poly.bounds[1])
            hi = max(hi, poly.bounds[3] + (ny - 1) * height)
    return {"period": [width, height], "bounds": [start, lo, start + nx * width, hi],
            "repeatX": nx, "repeatY": ny}


def shift_holes(holes, dx, dy):
    """Mounting holes moved by a drawing layer's centring offset.

    Anything malformed is passed through untouched so hole_cutter can report
    it with its own message.
    """
    shifted = []
    for hole in holes:
        try:
            shifted.append({**hole, "x": float(hole["x"]) + dx,
                            "y": float(hole["y"]) + dy})
        except (TypeError, ValueError, KeyError):
            shifted.append(hole)
    return shifted


def hole_cutter(holes):
    """The union of the mounting holes, or None when there are none."""
    discs = []
    for hole in holes:
        try:
            x, y = float(hole["x"]), float(hole["y"])
            d = float(hole.get("d", hole.get("diameter", 3.0)))
        except (TypeError, ValueError, KeyError):
            raise ConvertError("a hole needs numeric x, y and d") from None
        if d <= 0:
            raise ConvertError("hole diameter must be greater than 0")
        discs.append(Point(x, y).buffer(d / 2.0, quad_segs=16))
    return unary_union(discs) if discs else None


def cut(poly, cutter):
    """A polygon minus the holes, as the pieces that survive.

    Cutting happens after region ids are fixed, so punching a hole never
    renumbers the faces the browser has already painted.
    """
    if cutter is None:
        return [poly]
    return [p for p in polygons_of(poly.difference(cutter)) if p.area >= MIN_REGION_AREA]


def region_stacks(count, region_min, region_max, region_step, rng,
                  heights, groups, explicit):
    """The layer stack of every face.

    A face is a pile of coloured slabs, bottom first, each with its own
    thickness. A plain --heights value is simply a stack one layer deep.
    """
    steps = max(round((region_max - region_min) / region_step), 0)
    stacks = []
    for i in range(count):
        key = str(i)
        if key in explicit:
            layers = explicit[key]
            if not isinstance(layers, list):
                raise ConvertError(f"the stack for face {key} is not a list")
            stack = []
            for layer in layers:
                if not isinstance(layer, dict):
                    raise ConvertError(f"a layer of face {key} is not an object")
                try:
                    thickness = float(layer.get("t", layer.get("h")))
                except (TypeError, ValueError):
                    raise ConvertError(f"a layer of face {key} has no numeric thickness") from None
                group = layer.get("g")
                stack.append({"t": round(thickness, 6),
                              "g": None if group is None else str(group)})
            stacks.append(stack)
            continue

        h = heights.get(key)
        if h is None:
            h = region_min + region_step * rng.randint(0, steps)
        stacks.append([{"t": round(float(h), 6), "g": groups.get(key)}])
    return stacks


# ----------------------------------------------------------------- effects
#
# An effect changes the shape a face is extruded into without touching the
# painting: the stack still says how tall the face stands and which colours it
# is made of. Each effect turns one face's outline and stack into the slabs it
# is really built from, bottom first, so adding another one later means adding
# another generator here and a name to EFFECTS.

EFFECTS = ("none", "maya-pyramid")

# Terraces past this are refused: every one of them is another ring of outline
# in the preview, and a pyramid that fine is better printed than previewed.
MAX_EFFECT_STEPS = 24

# A terrace thinner than this will not print as a layer of its own, so a short
# face shares its height between fewer terraces instead.
MIN_TERRACE_THICKNESS = 0.2


def inset_polys(poly, distance):
    """The outline pulled `distance` mm in from its own border, as the pieces
    that survive.

    Mitred joins keep a straight edge straight and parallel to the one below
    it, which is what makes the terraces read as steps rather than as a heap
    of rounded-off blobs. A waisted face can be pinched into several pieces on
    the way in, and any face vanishes once there is nothing left to give.
    """
    if distance <= 0:
        return [poly]
    return [p for p in polygons_of(poly.buffer(-distance, join_style=2, mitre_limit=2.0))
            if p.area >= MIN_REGION_AREA]


def colour_at(stack, z):
    """The colour group a stack is painted with at height `z`."""
    top = 0.0
    for layer in stack:
        top += layer["t"]
        if z < top:
            return layer.get("g")
    return stack[-1].get("g") if stack else None


def flat_slabs(poly, stack):
    """No effect: one slab per painted layer, every one on the face's outline."""
    z = 0.0
    for layer in stack:
        if layer["t"] > 0:      # a layer set to zero is left out on purpose
            yield poly, z, layer["t"], layer.get("g")
        z += layer["t"]


def pyramid_steps(poly, steps, inset):
    """Each terrace of a stepped pyramid as its own pieces, widest first.

    The list stops early where the face runs out: a narrow sliver comes to a
    point after a step or two while a broad one keeps going.
    """
    terraces = []
    for k in range(steps):
        faces = inset_polys(poly, inset * k)
        if not faces:
            break
        terraces.append(faces)
    return terraces


def pyramid_slabs(poly, stack, steps, inset):
    """A face as a stepped pyramid, in the manner of a Maya temple.

    The face's painted height is split into equal terraces, each pulled one
    `inset` further in from the outline than the terrace below it. The
    painting is left alone: a terrace takes the colour the stack has at its
    middle, so a face painted in bands still comes out in those bands.

    The height is shared between the terraces that fit, so a face that comes
    to a point early still stands as tall as it was painted — and a face too
    short for that many steps is built from fewer of them, never thinner than
    MIN_TERRACE_THICKNESS each.
    """
    total = sum(layer["t"] for layer in stack)
    terraces = pyramid_steps(poly, steps, inset) if total > 0 else []
    if not terraces:
        return
    # The epsilon keeps a height that is an exact multiple of the minimum
    # (0.6 / 0.2 lands just under 3 in floating point) from losing a terrace.
    fit = max(1, int(total / MIN_TERRACE_THICKNESS + 1e-9))
    terraces = terraces[:fit]
    thickness = total / len(terraces)
    for k, faces in enumerate(terraces):
        z = thickness * k
        group = colour_at(stack, z + thickness / 2)
        for face in faces:       # a terrace can be several pieces once pinched
            yield face, z, thickness, group


def face_slabs(poly, stack, effect):
    """The slabs one face is built from, bottom first, under `effect`."""
    if effect and effect["name"] == "maya-pyramid":
        return pyramid_slabs(poly, stack, effect["steps"], effect["inset"])
    return flat_slabs(poly, stack)


def region_solids(region_polys, stacks, cutter, z_base=0.0, effect=None, extrude=None):
    """Every layer of every face as a solid, paired with its colour group."""
    for poly, stack in zip(region_polys, stacks):
        for face, z, thickness, group in face_slabs(poly, stack, effect):
            for piece in cut(face, cutter):
                solid = (extrude or trimesh.creation.extrude_polygon)(piece, thickness)
                solid.apply_translation((0.0, 0.0, z_base + z))
                yield solid, group


def wall_solids(wall_polys, wall_height, cutter, wall_stack=None, frame_mesh=None,
                z_base=0.0, extrude=None):
    """The frame, either as one solid or as a stack of coloured layers.

    Printing the frame from thin layers of the palette's own filaments saves
    dedicating a whole colour to it; the mix reads as a dark edge.

    A swept frame (profile mode) is a single ready-made mesh instead — it is
    neither prismatic nor sliceable into palette bands.
    """
    if frame_mesh is not None:
        mesh = frame_mesh.copy()
        mesh.apply_translation((0.0, 0.0, z_base))
        yield mesh, None
        return
    layers = wall_stack or [{"t": wall_height, "g": None}]
    for wall in wall_polys:
        z = z_base
        for layer in layers:
            thickness = layer["t"]
            if thickness <= 0:
                continue
            for piece in cut(wall, cutter):
                solid = (extrude or trimesh.creation.extrude_polygon)(piece, thickness)
                solid.apply_translation((0.0, 0.0, z))
                yield solid, layer.get("g")
            z += thickness


def build_meshes(layers, wall_stack=None):
    """Every solid of every drawing layer, stacked by each layer's z_base."""
    meshes = []
    n_walls, n_regions, n_layers = 0, 0, 0
    for drawing in layers:
        for solid, _ in wall_solids(drawing["wall_polys"], drawing["wall_height"],
                                    drawing["cutter"], wall_stack,
                                    drawing["frame_mesh"], drawing["z_base"]):
            meshes.append(solid)
            n_walls += 1
        for solid, _ in region_solids(drawing["region_polys"], drawing["stacks"],
                                      drawing["cutter"], drawing["z_base"],
                                      drawing["effect"]):
            meshes.append(solid)
            n_layers += 1
        n_regions += sum(1 for s in drawing["stacks"]
                         if any(layer["t"] > 0 for layer in s))
    return meshes, n_walls, n_regions, n_layers


def safe_name(name):
    """A group label reduced to something safe to use as a file name."""
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", str(name)).strip("-.")
    return cleaned or "group"


def colour_buckets(layers, wall_stack, extrude=None, face_offsets=None):
    """Every solid, gathered under the colour group that prints it.

    A layered frame has its slabs filed under their own colours; a plain frame
    keeps a group of its own. Group labels are shared across drawing layers,
    so stacked drawings merge into the same buckets. `face_offsets` repeats
    every face at those offsets, for sketch repeats on a cylinder.
    """
    buckets = defaultdict(list)
    n_walls, n_regions = 0, 0
    for drawing in layers:
        for solid, group in wall_solids(drawing["wall_polys"],
                                        drawing["wall_height"], drawing["cutter"],
                                        wall_stack, drawing["frame_mesh"],
                                        drawing["z_base"], extrude=extrude):
            buckets[group or "walls"].append(solid)
            n_walls += 1
        for solid, group in region_solids(drawing["region_polys"],
                                          drawing["stacks"], drawing["cutter"],
                                          drawing["z_base"], drawing["effect"], extrude=extrude):
            if face_offsets is None:
                buckets[group or "ungrouped"].append(solid)
            for dx, dy in face_offsets or []:
                buckets[group or "ungrouped"].append(solid.copy().apply_translation((dx, dy, 0.0)))
            n_regions += 1

    merged = [(label, trimesh.util.concatenate(buckets[label]), len(buckets[label]))
              for label in sorted(buckets)]
    return merged, n_walls, n_regions


def write_group_files(outdir, layers, wall_stack=None):
    """One STL per colour group, written side by side."""
    merged, n_walls, n_regions = colour_buckets(layers, wall_stack)
    os.makedirs(outdir, exist_ok=True)
    written = []
    for label, mesh, count in merged:
        name = f"{safe_name(label)}.stl"
        mesh.export(os.path.join(outdir, name))
        written.append({"file": name, "solids": count,
                        "triangles": int(len(mesh.faces))})
    return written, n_walls, n_regions


# The flat version of the model: one layer thick, shaped like the outermost
# outline, so it prints as a single-colour backing plate.
OUTLINE_THICKNESS = 0.2


def outline_solid(layers, thickness=OUTLINE_THICKNESS):
    """One flat plate shaped like the model's outermost outline.

    With a boundary the outline is the boundary itself — the finished size the
    crop was fitted to. Without one it is the *silhouette* of the frame: the
    frame is a lattice of ribbons, and the plate is its projection, so the
    openings between the walls are filled rather than cut out. Stacked drawings
    share one plate covering all of them. Returns None when there is nothing to
    cover.
    """
    shapes = []
    for drawing in layers:
        shape = drawing.get("crop")
        if shape is None:
            walls = drawing.get("wall_polys") or []
            if not walls:
                continue
            shape = unary_union([Polygon(poly.exterior)
                                 for poly in polygons_of(unary_union(walls))])
        if not shape.is_empty:
            shapes.append(shape)
    if not shapes:
        return None
    solids = [
        trimesh.creation.extrude_polygon(poly, thickness)
        for poly in polygons_of(unary_union(shapes))
        if not poly.is_empty and poly.area > 0
    ]
    return trimesh.util.concatenate(solids) if solids else None


def write_project_3mf(path, layers, wall_stack=None):
    """Every colour as its own part of one 3MF, with an extruder each."""
    merged, n_walls, n_regions = colour_buckets(layers, wall_stack)
    # Group labels start with the palette row ("2-lime"), so that number is the
    # extruder; anything unnumbered lands on the next free slot.
    used = {int(m[0].split("-", 1)[0]) for m in merged if m[0].split("-", 1)[0].isdigit()}
    spare = (max(used) if used else 0) + 1
    members = []
    for label, mesh, _ in merged:
        head = label.split("-", 1)[0]
        if head.isdigit():
            members.append((label, mesh, int(head)))
        else:
            members.append((label, mesh, spare))
            spare += 1
    return write_3mf(path, members, outline_solid(layers)), n_walls, n_regions


# The surface patterns a Bambu Studio / Snapmaker slicer knows. These are the
# values of the `top_surface_pattern` / `bottom_surface_pattern` metadata the
# 3MF carries per object; each controls how the nozzle fills a solid layer.
SURFACE_PATTERNS = (
    "monotonicline", "monotonic", "rectilinear", "alignedrectilinear",
    "concentric", "hilbertcurve", "archimedeanchords", "octagramspiral",
)


def write_project_3mf_variations(outdir, layers, wall_stack=None, patterns=None):
    """Default Snapmaker export: selected colour variants on about three plates."""
    from slicer_3mf import export
    if patterns and len(patterns) > 1:
        raise ConvertError("Choose one surface pattern per export; colour variations no longer multiply across patterns.")
    try:
        result = export(outdir, layers, wall_stack, {
            "target": "snapmaker", "pattern": (patterns or ["monotonicline"])[0],
        })
    except ValueError as error:
        raise ConvertError(str(error)) from error
    return result["files"], result["walls"], result["regions"]


"""3MF, in the flavour Snapmaker's slicer (a Bambu Studio fork) writes.

A 3MF is a zip. The geometry is plain 3MF core — one `.model` per part under
3D/Objects, each holding vertices and triangles — while the *colour* lives
entirely in Metadata/model_settings.config, as an `extruder` number per object.
Nothing about the mesh carries colour.

The build is grouped into *build plates*: Metadata/model_settings.config holds
one `<plate>` per plate, each listing the `model_instance`s it carries, and an
`<assemble>` block that places every object on its plate. A reference project
(example_3dobject_versions.3mf) shows three kinds of plate in one file —
single_color_version, frame_only_version and multi_color_versions — so this
writer always adds the two plain printable versions on their own plates and
spreads the many colour/pattern combinations over plates instead of overflowing
one bed.

Every part that belongs together is placed with the same transform, so the
pieces stay registered on top of each other instead of being scattered as
separate imports.
"""

PLATE_CENTRE = (135.5, 136.0)      # middle of the 270 x 270 bed
BED = 270.0                        # one build plate is 270 x 270 mm
PLATE_EDGE = 8.0                   # margin kept clear around a plate's grid
GAP = 5.0                          # gap between two neighbours on a plate
IDENTITY = "1 0 0 0 1 0 0 0 1"
MODEL_NS = (
    'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" '
    'xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" '
    'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" '
    'requiredextensions="p"'
)


def _num(value):
    """Compact fixed-point, because these strings dominate the file size."""
    text = f"{value:.5f}".rstrip("0").rstrip(".")
    return "0" if text in ("", "-0", "-") else text


def _mesh_xml(mesh):
    verts = "".join(
        f'<vertex x="{_num(x)}" y="{_num(y)}" z="{_num(z)}"/>'
        for x, y, z in mesh.vertices
    )
    tris = "".join(
        f'<triangle v1="{a}" v2="{b}" v3="{c}"/>' for a, b, c in mesh.faces
    )
    return f'<vertices>{verts}</vertices><triangles>{tris}</triangles>'


def _mesh_model(object_id, mesh):
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<model unit="millimeter" xml:lang="en-US" {MODEL_NS}>\n'
        ' <metadata name="BambuStudio:3mfVersion">1</metadata>\n'
        ' <resources>\n'
        f'  <object id="{object_id}" p:UUID="{uuid.uuid4()}" type="model">\n'
        f'   <mesh>{_mesh_xml(mesh)}</mesh>\n'
        '  </object>\n'
        ' </resources>\n'
        ' <build/>\n'
        '</model>\n'
    )


def is_palette_label(label):
    """A group label's head is its palette row ("2-lime") when it is numbered."""
    return label.split("-", 1)[0].isdigit()


def _plate_capacity(step_x, step_y):
    """How many whole grid cells (columns, rows) one plate can hold."""

    def fit(step):
        return max(1, int((BED - 2 * PLATE_EDGE) / step)) if step > 0 else 1

    return fit(step_x), fit(step_y)


def _grid_positions(count, cols, step_x, step_y, cx, cy):
    """(x, y) for `count` objects laid out in `cols` columns centred on (cx, cy)."""
    cols = max(1, min(count, cols))
    rows = (count + cols - 1) // cols
    grid_w = (cols - 1) * step_x
    grid_h = (rows - 1) * step_y
    base_x = cx - grid_w / 2
    base_y = cy + grid_h / 2
    return [(base_x + (i % cols) * step_x, base_y - (i // cols) * step_y)
            for i in range(count)]


def _version_members(members):
    """The always-on version objects: the model in one colour, and the frame alone.

    `members` is one combination's [(label, mesh, extruder)] — every volume a
    printed model can need. Returns [(name, [(label, mesh, extruder)])] for the
    versions that add something the model itself does not already hold: a
    one-colour version whenever more than one volume must print together, and
    the frame alone only when the model has unnumbered (frame) volumes that a
    drawing of faces can do without.
    """
    palette = [m for m in members if is_palette_label(m[0])]
    fixed = [m for m in members if not is_palette_label(m[0])]
    versions = []
    if len(members) > 1:
        # The whole relief — faces and frame — as one colour on one extruder,
        # for a single-spool test print of the same model.
        versions.append(("single color",
                         [(label, mesh, 1) for label, mesh, _ in members]))
    if palette and fixed:
        # Just the frame: the unnumbered groups, in their own colours.
        versions.append(("frame only", fixed))
    return versions


def _settings_part_xml(label, mesh_id, extruder):
    return (
        f'    <part id="{mesh_id}" subtype="normal_part">\n'
        f'      <metadata key="name" value="{label}"/>\n'
        '      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n'
        f'      <metadata key="extruder" value="{extruder}"/>\n'
        '    </part>\n'
    )


def _settings_object_xml(object_id, name, parts, pattern):
    """One <object> of Metadata/model_settings.config: its name, an optional
    top/bottom surface pattern, and one <part> per colour group."""
    inner = "".join(_settings_part_xml(label, mesh_id, extruder)
                    for label, mesh_id, extruder in parts)
    pattern_meta = ""
    if pattern:
        pattern_meta = (
            f'    <metadata key="top_surface_pattern" value="{pattern}"/>\n'
            f'    <metadata key="bottom_surface_pattern" value="{pattern}"/>\n'
        )
    top = parts[0][2] if parts else 1
    return (
        f'  <object id="{object_id}">\n'
        f'    <metadata key="name" value="{name}"/>\n'
        + pattern_meta
        + f'    <metadata key="extruder" value="{top}"/>\n'
        + inner
        + '  </object>\n'
    )


def _plates_xml(plates, placed):
    """The <plate> blocks and the <assemble> block of model_settings.config.

    plates: [(plater_name, [object ids])] in plate order; placed maps each
    object id to its "1 0 0 0 1 0 0 0 1 x y z" position. Every object belongs
    to exactly one plate.
    """
    blocks = []
    order = []
    for i, (name, ids) in enumerate(plates):
        members = "".join(
            '    <model_instance>\n'
            f'      <metadata key="object_id" value="{oid}"/>\n'
            '      <metadata key="instance_id" value="0"/>\n'
            '    </model_instance>\n'
            for oid in ids
        )
        blocks.append(
            '  <plate>\n'
            f'    <metadata key="plater_id" value="{i + 1}"/>\n'
            f'    <metadata key="plater_name" value="{name}"/>\n'
            '    <metadata key="locked" value="false"/>\n'
            + members
            + '  </plate>\n'
        )
        order.extend((oid, placed[oid]) for oid in ids)
    assembled = "".join(
        f'   <assemble_item object_id="{oid}" instance_id="0" transform="{tf}"'
        ' offset="0 0 0"/>\n'
        for oid, tf in order
    )
    return "".join(blocks) + '  <assemble>\n' + assembled + '  </assemble>\n'


def write_3mf(path, members, outline=None):
    """members: [(name, mesh, extruder)] — one entry per colour group.

    The colour groups stay registered on top of each other on the first plate,
    as one multi-extruder model. When the model has faces to print, the same
    relief also appears once more in one colour on its own plate
    ("single_color_version") and the frame by itself on another
    ("frame_only_version"). `outline` adds one more: the flat, one-colour
    0.2 mm plate shaped like the outermost outline ("outline_version").
    """
    solids = [m for m in members if len(m[1].faces)]
    if not solids:
        raise ConvertError("there is nothing to export")

    lo = [min(m.bounds[0][i] for _, m, _ in solids) for i in range(3)]
    hi = [max(m.bounds[1][i] for _, m, _ in solids) for i in range(3)]
    # One shared offset keeps the parts registered; z sits the model on the bed.
    move = (f"{IDENTITY} {_num(PLATE_CENTRE[0] - (lo[0] + hi[0]) / 2)} "
            f"{_num(PLATE_CENTRE[1] - (lo[1] + hi[1]) / 2)} {_num(-lo[2])}")

    # Assembly objects: each colour group keeps its own object (registered on
    # the first plate), and each plain version gets one of its own. Every
    # object owns the meshes it prints — its own file and part ids — so the
    # slicer never has to guess which volume a settings part means.
    objects = []              # {"object_id", "name", "members", "pattern"}
    for label, mesh, extruder in solids:
        objects.append({"object_id": 2 * len(objects) + 2, "name": label,
                        "members": [(label, mesh, extruder)], "pattern": None})
    versions = _version_members(solids)
    if outline is not None and len(outline.faces):
        # The flat outline plate is a single-colour version of its own: one
        # volume on the first extruder, the way the slicer export prints it.
        versions = versions + [("outline 0.2", [("outline 0.2", outline, 1)])]
    for vi, (name, version_members) in enumerate(versions):
        objects.append({"object_id": 1000 + vi, "name": name,
                        "members": version_members, "pattern": None})

    def own_place(meshes):
        mlo = [min(m.bounds[0][i] for m in meshes) for i in range(3)]
        mhi = [max(m.bounds[1][i] for m in meshes) for i in range(3)]
        return (f"{IDENTITY} {_num(PLATE_CENTRE[0] - (mlo[0] + mhi[0]) / 2)} "
                f"{_num(PLATE_CENTRE[1] - (mlo[1] + mhi[1]) / 2)} "
                f"{_num(-mlo[2])}")

    colour_count = len(solids)
    placed = {objects[i]["object_id"]: move for i in range(colour_count)}
    for obj in objects[colour_count:]:
        placed[obj["object_id"]] = own_place([m for _, m, _ in obj["members"]])

    version_plate = {"single color": "single_color_version",
                     "frame only": "frame_only_version",
                     "outline 0.2": "outline_version"}
    plates = [("", [objects[i]["object_id"] for i in range(colour_count)])]
    for obj in objects[colour_count:]:
        plates.append((version_plate[obj["name"]], [obj["object_id"]]))

    # One globally-unique part id per volume, across every object and plate.
    part_ids = {}             # (object_id, label) -> part id
    next_id = 1
    for obj in objects:
        for label, mesh, extruder in obj["members"]:
            part_ids[(obj["object_id"], label)] = next_id
            next_id += 1

    # The main model: one assembly object per object, each referencing the mesh
    # objects of its own file under 3D/Objects.
    resources = ""
    for obj in objects:
        comps = "".join(
            f'   <component p:path="/3D/Objects/object_{obj["object_id"]}.model" '
            f'objectid="{part_ids[(obj["object_id"], label)]}" '
            f'p:UUID="{uuid.uuid4()}" transform="{IDENTITY} 0 0 0"/>\n'
            for label, mesh, extruder in obj["members"]
        )
        resources += (
            f'  <object id="{obj["object_id"]}" p:UUID="{uuid.uuid4()}" type="model">\n'
            f'   <components>\n{comps}   </components>\n'
            '  </object>\n'
        )

    build_items = "".join(
        f'  <item objectid="{oid}" p:UUID="{uuid.uuid4()}" '
        f'transform="{placed[oid]}" printable="1"/>\n'
        for oid in placed
    )
    model = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<model unit="millimeter" xml:lang="en-US" {MODEL_NS}>\n'
        ' <metadata name="Application">vector2stl</metadata>\n'
        ' <metadata name="BambuStudio:3mfVersion">1</metadata>\n'
        ' <resources>\n' + resources + ' </resources>\n'
        f' <build p:UUID="{uuid.uuid4()}">\n' + build_items + ' </build>\n'
        '</model>\n'
    )

    rels = "".join(
        f'<Relationship Target="/3D/Objects/object_{obj["object_id"]}.model" '
        f'Id="rel-{i + 1}"'
        ' Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>'
        for i, obj in enumerate(objects)
    )

    # The settings config: one object per assembly, one part per colour group.
    settings_objects = "".join(
        _settings_object_xml(
            obj["object_id"], obj["name"],
            [(label, part_ids[(obj["object_id"], label)], extruder)
             for label, mesh, extruder in obj["members"]],
            obj["pattern"])
        for obj in objects
    )
    settings = (
        '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n'
        + settings_objects
        + _plates_xml(plates, placed)
        + '</config>\n'
    )

    content_types = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'
        ' <Default Extension="rels"'
        ' ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n'
        ' <Default Extension="model"'
        ' ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n'
        ' <Default Extension="png" ContentType="image/png"/>\n'
        '</Types>\n'
    )
    root_rels = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
        ' <Relationship Target="/3D/3dmodel.model" Id="rel-1"'
        ' Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n'
        '</Relationships>\n'
    )

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr("_rels/.rels", root_rels)
        archive.writestr("3D/3dmodel.model", model)
        archive.writestr(
            "3D/_rels/3dmodel.model.rels",
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + rels + '</Relationships>\n',
        )
        for obj in objects:
            objects_xml = "".join(
                f'  <object id="{part_ids[(obj["object_id"], label)]}" '
                f'p:UUID="{uuid.uuid4()}" type="model">\n'
                f'   <mesh>{_mesh_xml(mesh)}</mesh>\n'
                '  </object>\n'
                for label, mesh, extruder in obj["members"]
            )
            archive.writestr(
                f"3D/Objects/object_{obj['object_id']}.model",
                '<?xml version="1.0" encoding="UTF-8"?>\n'
                f'<model unit="millimeter" xml:lang="en-US" {MODEL_NS}>\n'
                ' <metadata name="BambuStudio:3mfVersion">1</metadata>\n'
                ' <resources>\n' + objects_xml + ' </resources>\n'
                ' <build/>\n'
                '</model>\n',
            )
        archive.writestr("Metadata/model_settings.config", settings)
        archive.writestr(
            "Metadata/slice_info.config",
            '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <header>\n'
            '    <header_item key="X-BBL-Client-Type" value="slicer"/>\n'
            '    <header_item key="X-BBL-Client-Version" value=""/>\n'
            '  </header>\n</config>\n',
        )

    return [
        {"file": g["name"], "extruder": g["extruder"],
         "triangles": int(len(g["mesh"].faces))}
        for g in ({"name": label, "mesh": mesh, "extruder": extruder}
                  for label, mesh, extruder in solids)
    ]


def write_3mf_assemblies(path, combinations):
    """One 3MF whose build holds one *assembly* per colour combination, spread
    over build plates.

    `combinations` is a list of `(name, members, pattern)`; each member is
    `(label, mesh, extruder)` — that combination's colour parts. `pattern` is
    the slicer's top/bottom surface pattern for the object, or None for the
    slicer's default. Every combination's parts are written into one shared
    object file and referenced by a single assembly object, so each combination
    behaves as one merged multi-colour object on the plate.

    Two plates always come first, carrying the plain printable versions of the
    model — the whole relief in one colour ("single_color_version") and the
    frame alone ("frame_only_version") — then the combinations fill
    "multi_color_versions", spilling onto further plates as each one fills, so
    a big comparison never overflows the bed.
    """
    combos = []
    for name, members, pattern in combinations:
        solids = [(label, mesh, extruder) for (label, mesh, extruder) in members
                  if len(mesh.faces)]
        if solids:
            combos.append((name, solids, pattern))
    if not combos:
        raise ConvertError("there is nothing to export")

    # Every combination shares the same geometry, so one box centres them all
    # and sizes the grid every plate packs into.
    meshes = [m for _, members, _ in combos for _, m, _ in members]
    lo = [min(m.bounds[0][i] for m in meshes) for i in range(3)]
    hi = [max(m.bounds[1][i] for m in meshes) for i in range(3)]
    centre = [(lo[i] + hi[i]) / 2 for i in range(3)]
    size = [hi[i] - lo[i] for i in range(3)]
    base_z = -lo[2]

    # One object per combination (1000+) and one per plain version (2000+);
    # every object's parts live in its own mesh file under 3D/Objects.
    objects = []          # (object_id, name, members, pattern)
    for ci, (name, members, pattern) in enumerate(combos):
        objects.append((1000 + ci, name, members, pattern))
    versions = _version_members(combos[0][1])
    for vi, (name, members) in enumerate(versions):
        objects.append((2000 + vi, name, members, None))

    # One mesh object per volume, numbered across every object.
    parts = []
    mesh_id = 1
    for object_id, _, members, _ in objects:
        for label, mesh, extruder in members:
            parts.append({"object_id": object_id, "label": label, "mesh": mesh,
                          "extruder": extruder, "mesh_id": mesh_id})
            mesh_id += 1
    by_object = defaultdict(list)
    for p in parts:
        by_object[p["object_id"]].append(p)

    # Grid the combinations onto plates, a full plate at a time.
    step_x = size[0] + GAP
    step_y = size[1] + GAP
    fit_cols, fit_rows = _plate_capacity(step_x, step_y)
    per_plate = fit_cols * fit_rows
    cx = PLATE_CENTRE[0] - centre[0]
    cy = PLATE_CENTRE[1] - centre[1]

    plates = []           # (plater_name, [object ids])
    placed = {}           # object_id -> "1 0 0 0 1 0 0 0 1 x y z"

    def push_plate(name, ids):
        pos = _grid_positions(len(ids), fit_cols, step_x, step_y, cx, cy)
        plates.append((name, ids))
        for oid, (x, y) in zip(ids, pos):
            placed[oid] = f"{IDENTITY} {_num(x)} {_num(y)} {_num(base_z)}"

    version_names = {"single color": "single_color_version",
                     "frame only": "frame_only_version"}
    for oid, name, _, _ in objects:
        if oid >= 2000:
            push_plate(version_names[name], [oid])
    combo_ids = [1000 + ci for ci in range(len(combos))]
    first = True
    for start in range(0, len(combo_ids), per_plate):
        chunk = combo_ids[start:start + per_plate]
        push_plate("multi_color_versions" if first else "", chunk)
        first = False

    # The main model: one assembly object per object, each referencing the mesh
    # objects of its own file.
    resources = ""
    for object_id, _, members, _ in objects:
        comps = "".join(
            f'   <component p:path="/3D/Objects/object_{object_id}.model" '
            f'objectid="{p["mesh_id"]}" p:UUID="{uuid.uuid4()}" '
            f'transform="{IDENTITY} 0 0 0"/>\n'
            for p in by_object[object_id]
        )
        resources += (
            f'  <object id="{object_id}" p:UUID="{uuid.uuid4()}" type="model">\n'
            f'   <components>\n{comps}   </components>\n'
            '  </object>\n'
        )

    build_items = "".join(
        f'  <item objectid="{oid}" p:UUID="{uuid.uuid4()}" '
        f'transform="{placed[oid]}" printable="1"/>\n'
        for oid in placed
    )
    model = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<model unit="millimeter" xml:lang="en-US" {MODEL_NS}>\n'
        ' <metadata name="Application">vector2stl</metadata>\n'
        ' <metadata name="BambuStudio:3mfVersion">1</metadata>\n'
        ' <resources>\n' + resources + ' </resources>\n'
        f' <build p:UUID="{uuid.uuid4()}">\n' + build_items + ' </build>\n'
        '</model>\n'
    )

    # One relationship per object file.
    rels = "".join(
        f'<Relationship Target="/3D/Objects/object_{oid}.model" '
        f'Id="rel-{i + 1}"'
        ' Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>'
        for i, (oid, _, _, _) in enumerate(objects)
    )

    # Colour assignments: one object per combination/version, one part per
    # colour. The surface pattern is an object-level override of the slicer's
    # global top/bottom surface pattern, so each combination gets the subject
    # it was built for (the meshes are identical; only the slicing differs).
    settings_objects = "".join(
        _settings_object_xml(
            object_id, name,
            [(p["label"], p["mesh_id"], p["extruder"])
             for p in by_object[object_id]],
            pattern)
        for object_id, name, _, pattern in objects
    )
    settings = (
        '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n'
        + settings_objects
        + _plates_xml(plates, placed)
        + '</config>\n'
    )

    content_types = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'
        ' <Default Extension="rels"'
        ' ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n'
        ' <Default Extension="model"'
        ' ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n'
        ' <Default Extension="png" ContentType="image/png"/>\n'
        '</Types>\n'
    )
    root_rels = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
        ' <Relationship Target="/3D/3dmodel.model" Id="rel-1"'
        ' Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n'
        '</Relationships>\n'
    )

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr("_rels/.rels", root_rels)
        archive.writestr("3D/3dmodel.model", model)
        archive.writestr(
            "3D/_rels/3dmodel.model.rels",
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + rels + '</Relationships>\n',
        )
        for object_id, _, _, _ in objects:
            object_parts = by_object[object_id]
            objects_xml = "".join(
                f'  <object id="{p["mesh_id"]}" p:UUID="{uuid.uuid4()}" type="model">\n'
                f'   <mesh>{_mesh_xml(p["mesh"])}</mesh>\n'
                '  </object>\n'
                for p in object_parts
            )
            archive.writestr(
                f"3D/Objects/object_{object_id}.model",
                '<?xml version="1.0" encoding="UTF-8"?>\n'
                f'<model unit="millimeter" xml:lang="en-US" {MODEL_NS}>\n'
                ' <metadata name="BambuStudio:3mfVersion">1</metadata>\n'
                ' <resources>\n' + objects_xml + ' </resources>\n'
                ' <build/>\n'
                '</model>\n',
            )
        archive.writestr("Metadata/model_settings.config", settings)
        archive.writestr(
            "Metadata/slice_info.config",
            '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <header>\n'
            '    <header_item key="X-BBL-Client-Type" value="slicer"/>\n'
            '    <header_item key="X-BBL-Client-Version" value=""/>\n'
            '  </header>\n</config>\n',
        )

    return (len(combos), len(parts),
            sum(len(p["mesh"].faces) for p in parts),
            len(plates), len(versions))


def ring_json(coords):
    return [[round(x, 4), round(y, 4)] for x, y in coords]


def polygon_json(poly):
    return {
        "exterior": ring_json(poly.exterior.coords),
        "holes": [ring_json(r.coords) for r in poly.interiors],
    }


def as_map(raw, what):
    """A JSON object (or array) of per-region values, keyed by region id."""
    if isinstance(raw, list):
        raw = dict(enumerate(raw))
    if not isinstance(raw, dict):
        raise ConvertError(f"{what} assignments must be a JSON object or array")
    out = {}
    for key, value in raw.items():
        try:
            out[str(int(key))] = value
        except (TypeError, ValueError):
            raise ConvertError(f"{key!r} is not a region id") from None
    return out


def load_map(path, what):
    """Per-region assignments from a JSON file, keyed by region id."""
    if not path:
        return {}
    try:
        with open(path) as fp:
            raw = json.load(fp)
    except (OSError, ValueError) as exc:
        raise ConvertError(f"could not read the {what} assignments: {exc}") from None
    return as_map(raw, what)


def load_layer_spec(path):
    """An --also spec: one extra drawing plus its per-layer assignments."""
    try:
        with open(path) as fp:
            spec = json.load(fp)
    except (OSError, ValueError) as exc:
        raise ConvertError(f"could not read the layer spec: {exc}") from None
    if not isinstance(spec, dict) or not spec.get("file"):
        raise ConvertError('a layer spec needs at least a "file"')
    drawing = str(spec["file"])
    if not os.path.isabs(drawing):
        # Relative paths resolve against the spec, not the caller's cwd.
        drawing = os.path.join(os.path.dirname(os.path.abspath(path)), drawing)
    spec["file"] = drawing
    scale = spec.get("scale", 1.0)
    if not isinstance(scale, (int, float)) or isinstance(scale, bool) or scale <= 0:
        raise ConvertError("a layer spec's scale must be a number greater than 0")
    if not isinstance(spec.get("holes", []), list):
        raise ConvertError("a layer spec's holes must be a JSON array")
    return spec


def as_float(key, value):
    try:
        return float(value)
    except (TypeError, ValueError):
        raise ConvertError(f"height for region {key} is not a number") from None


def positive(name, value):
    if value <= 0:
        raise ConvertError(f"{name} must be greater than 0")
    return value


def main():
    # Cylinder settings and generated shells are supplied by the HTTP backend.
    ap = argparse.ArgumentParser()
    ap.add_argument("--slice-height", type=float, metavar="MM",
                    help="export an SVG cross-section this far above the model base")
    ap.add_argument("input")
    ap.add_argument("output", nargs="?")
    ap.add_argument("--inspect", action="store_true",
                    help="report layers and geometry counts as JSON, then exit")
    ap.add_argument("--regions", action="store_true",
                    help="report the wall and region outlines as JSON, then exit")
    ap.add_argument("--preview", action="store_true",
                    help="report the subject and boundary outlines as JSON for "
                         "the 2D window-position preview, then exit")
    ap.add_argument("--profile-sections", action="store_true",
                    help="report normalized main, groove and cusp sections for the shared profile editor")
    ap.add_argument("--sketch", action="store_true",
                    help="report a DXF subject's exact lines, circles and arcs as JSON for "
                         "the tip editor, then exit")
    ap.add_argument("--sketch-edit", default=None, metavar="FILE",
                    help="JSON file: [{handle, center, radius, start, end}] counter-clockwise "
                         "arcs to write into the DXF subject, saved to the output path")
    ap.add_argument("--heights", default=None, metavar="FILE",
                    help='JSON file mapping region id to height, e.g. {"0": 1.1}')
    ap.add_argument("--cylinder", default=None, metavar="FILE",
                    help="Cylinder settings and OpenSCAD shell paths as JSON")
    ap.add_argument("--ring", default=None, metavar="FILE",
                    help="Ring settings JSON: profilePath and offset (mm) for a revolved profile")
    ap.add_argument("--lighter", default=None, metavar="FILE",
                    help="Lighter settings JSON: bodyPath (OpenSCAD shell) plus the case "
                         "dimensions for the BIC J26 elliptical body")
    ap.add_argument("--sketch-repeat", type=int, nargs=2, default=None, metavar=("X", "Y"),
                    help="sweep the frame along X × Y copies of the sketch, for a cylinder "
                         "(--cylinder settings imply this unless sweepThenRepeat is set)")
    ap.add_argument("--lid-sketch", default=None, metavar="FILE",
                    help="Separate lid-top sketch swept with --profile and fitted to the cylinder lid")
    ap.add_argument("--addition-outline", metavar="FILE", help="Closed shelf outline, perpendicular to the base frame")
    ap.add_argument("--addition-preview", action="store_true", help="Top/front placement outlines without fusing a shelf")
    ap.add_argument("--addition-profile", metavar="FILE", help="Shelf edge section; defaults to the main sweep profile")
    ap.add_argument("--addition-thickness", type=float, default=5)
    ap.add_argument("--addition-width", type=float, default=0)
    ap.add_argument("--addition-depth", type=float, default=0)
    ap.add_argument("--addition-x", type=float, default=0)
    ap.add_argument("--addition-y", type=float, default=0)
    ap.add_argument("--addition-z", type=float, default=0)
    ap.add_argument("--addition-rotation", type=int, default=90)
    ap.add_argument("--addition-edge-sweep", action="store_true")
    ap.add_argument("--addition-flip", action="store_true")
    ap.add_argument("--addition-profile-scale", type=float, default=1,
                    help="Shelf section source-width scale, independent of the main profile")
    ap.add_argument("--addition-profile-height-scale", type=float, default=1,
                    help="Shelf section source-height scale, independent of the main profile")
    ap.add_argument("--addition-mirror-profile", action="store_true",
                    help="Reflect the shelf section across its source bottom baseline before rotation")
    ap.add_argument("--addition-flip-profile", action="store_true",
                    help="Flip the shelf section left/right about its source centreline before rotation")
    ap.add_argument("--addition-keep-original-profile", action="store_true",
                    help="Sweep both the original section and its selected mirrored orientation")
    ap.add_argument("--addition-trim-back", action="store_true",
                    help="Cut the placed shelf and its rim flush to the main frame's rear bed plane")
    ap.add_argument("--stacks", default=None, metavar="FILE",
                    help='JSON file mapping face id to its layer stack, e.g. '
                         '{"0": [{"t": 0.65, "g": "1-orange"}, {"t": 1.1, "g": "3-violet"}]}')
    ap.add_argument("--wall-stack", default=None, metavar="FILE",
                    help='JSON list of frame bands, e.g. [{"t": 0.2, "g": "1-orange"}]; '
                         "without it the frame is one solid of --wall-height")
    ap.add_argument("--split", action="store_true",
                    help="write one STL per colour group into the output directory")
    ap.add_argument("--variations", action="store_true",
                    help="write a Snapmaker 3MF with colour permutations, "
                         "targeting three plates and keeping the required "
                         "versions together on plate 1")
    ap.add_argument("--slicer-options", metavar="FILE",
                    help="JSON selection, target printer and preview options for plate-aware 3MF export")
    ap.add_argument("--patterns", default=None, metavar="LIST",
                    help="one top/bottom surface pattern for the "
                         "--variations export (choose from " + ", ".join(SURFACE_PATTERNS) + ")")
    ap.add_argument("--groups", default=None, metavar="FILE",
                    help="JSON file mapping region id to a colour group; makes "
                         "the output a directory holding one STL per group")
    ap.add_argument("--holes", default=None, metavar="FILE",
                    help='JSON list of mounting holes, e.g. [{"x":0,"y":0,"d":4}]')
    ap.add_argument("--layers", default=None,
                    help="comma-separated layer names to use (default: all)")
    ap.add_argument("--wall-width", type=float, default=1.0)
    ap.add_argument("--wall-height", type=float, default=2.0)
    ap.add_argument("--confine-walls", action="store_true",
                    help="keep the model inside its outermost line: the outer "
                         "curves are traced along the inside of the wall "
                         "instead of down its middle")
    ap.add_argument("--wall-overlap", type=float, default=0.1,
                    help="how far each face reaches into the wall around it, so "
                         "the two fuse when printed (0 for an exact fit)")
    ap.add_argument("--region-min", type=float, default=0.2)
    ap.add_argument("--region-max", type=float, default=2.0)
    ap.add_argument("--region-step", type=float, default=0.1)
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--sagitta", type=float, default=0.02)
    ap.add_argument("--scale", type=float, default=1.0,
                    help="multiply every coordinate, for drawings in the wrong units")
    ap.add_argument("--profile", default=None, metavar="FILE",
                    help="DXF/SVG holding one closed cross-section; it is swept "
                         "along every curve to form the frame, instead of "
                         "extruding flat ribbons (its width/height replace "
                         "--wall-width/--wall-height)")
    ap.add_argument("--profile-scale", type=float, default=1.0,
                    help="stretch the profile's width (its x axis); the height "
                         "stays as drawn")
    ap.add_argument("--profile-height-scale", type=float, default=1.0,
                    help="stretch the profile's height (its y axis), independently of its width")
    ap.add_argument("--groove-width", type=float, default=None,
                    help="independent groove x scale (defaults to --profile-scale)")
    ap.add_argument("--groove-height", type=float, default=None,
                    help="independent groove y scale (defaults to --profile-height-scale)")
    ap.add_argument("--profile-z", type=float, default=0.0,
                    help="main profile vertical offset in mm, applied after scaling")
    ap.add_argument("--groove-z", type=float, default=0.0,
                    help="groove profile vertical offset in mm, applied after scaling")
    ap.add_argument("--groove-profile", default=None, metavar="FILE",
                    help="DXF/SVG cutter section in the main profile's coordinates; "
                         "sweep along the same paths and subtract from the frame")
    ap.add_argument("--cusps", help="Separate SVG/DXF cusp paths in the frame coordinate system")
    ap.add_argument("--cusp-profile", help="Optional independent closed section for cusp paths")
    ap.add_argument("--cusp-width", type=float, default=0.55)
    ap.add_argument("--cusp-height", type=float, default=0.55)
    ap.add_argument("--cusp-z", type=float, default=0.0)
    ap.add_argument("--round-ends", action="store_true")
    ap.add_argument("--end-angle", type=float, default=90.0)
    ap.add_argument("--end-side", type=int, choices=[-1, 1], default=1)
    ap.add_argument("--dome-ends", default=None, metavar="FILE",
                    help="JSON file listing [[x,y],...] endpoint positions to cap with a dome ending")
    ap.add_argument("--hooks", default=None, metavar="FILE",
                    help="JSON file: list of {x,y,type,...} hooks swept from the main "
                         "profile, standing up out of the drawing plane at path "
                         "vertices, facing the drawing's -Y unless rotation (degrees, "
                         "counter-clockwise) turns them; offset (mm) slides one up the "
                         "drawing's Y axis from its vertex. type is 'round' (small_radius, "
                         "big_radius, angle) or 'straight' (length, angle, overhang; post "
                         "and bar carry the profile on both faces); tip is 'quarter' "
                         "(default), 'half' (180° roll) or 'square' — a straight hook's "
                         "rounded tip is always the 180° half-round")
    ap.add_argument("--frame-only", action="store_true", help="Generate tracery without glass faces")
    ap.add_argument("--groove-last", action="store_true",
                    help="cut the groove profile after the hooks are fused on, so it runs "
                         "through them too (by default hooks are added after the groove)")
    ap.add_argument("--boundary", default=None, metavar="FILE",
                    help="DXF/SVG holding a closed polygon that bounds the "
                         "drawing: everything outside it is cut away. It is "
                         "read in the drawing's own coordinates and scaled "
                         "with it, so draw it over the subject")
    ap.add_argument("--boundary-fit", dest="boundary_fit",
                    action=argparse.BooleanOptionalAction, default=True,
                    help="centre the boundary on the subject and scale it "
                         "uniformly to just fit inside it — for files that do "
                         "not share a coordinate system (--no-boundary-fit "
                         "keeps the boundary as drawn)")
    ap.add_argument("--no-boundary-wall", dest="boundary_wall",
                    action="store_false", default=True,
                    help="cut flush at the boundary instead of walling it, "
                         "leaving the faces along the cut open")
    ap.add_argument("--boundary-scale", type=float, default=1.0,
                    help="resize the boundary about its own centre")
    ap.add_argument("--boundary-x", type=float, default=0.0, metavar="MM",
                    help="nudge the boundary sideways, in finished millimetres")
    ap.add_argument("--boundary-y", type=float, default=0.0, metavar="MM",
                    help="nudge the boundary up or down, in finished millimetres")
    ap.add_argument("--subject-scale", type=float, default=1.0,
                    help="resize the subject inside the boundary about its own "
                         "centre, while the boundary stays put")
    ap.add_argument("--subject-x", type=float, default=0.0, metavar="MM",
                    help="slide the subject sideways under the boundary, in "
                         "finished millimetres")
    ap.add_argument("--subject-y", type=float, default=0.0, metavar="MM",
                    help="slide the subject up or down under the boundary, in "
                         "finished millimetres")
    ap.add_argument("--effect", choices=EFFECTS, default="none",
                    help="reshape every face: maya-pyramid steps each one in "
                         "from its own outline, bottom to top")
    ap.add_argument("--effect-steps", type=int, default=4, metavar="N",
                    help="maya-pyramid: how many terraces a face is built from")
    ap.add_argument("--effect-inset", type=float, default=0.3, metavar="MM",
                    help="maya-pyramid: how much further in each terrace sits")
    ap.add_argument("--also", action="append", default=[], metavar="FILE",
                    help="JSON spec for another drawing stacked on top of the "
                         "previous ones, centred on the base drawing: "
                         '{"file": "...", "scale": 1.0, "layers": "A,B", '
                         '"stacks": {...}, "heights": {...}, "holes": [...]}; '
                         "repeatable, in stacking order")
    args = ap.parse_args()

    positive("sagitta", args.sagitta)
    positive("scale", args.scale)
    if args.lid_sketch and (not args.cylinder or not args.profile):
        raise ConvertError("A lid-top sketch requires cylinder settings and a sweep profile")

    if sum(bool(m) for m in (args.cylinder, args.ring, args.lighter)) > 1:
        raise ConvertError("Cylinder, ring and lighter modes cannot be combined")


    if (args.cylinder or args.sketch_repeat or args.ring or args.lighter) and (args.addition_outline or args.addition_preview):
        raise ConvertError("Perpendicular additions require a flat model surface")
    # By default a cylinder (and a ring or lighter) repeats the sketch before
    # sweeping it; "first sweep then repeat" copies the finished relief instead.
    cylinder, ring, lighter, sketch_repeat = None, None, None, None
    try:
        if args.cylinder:
            with open(args.cylinder) as fp:
                cylinder = json.load(fp)
            if not cylinder.get("sweepThenRepeat"):
                from cylinder import repeat_counts
                sketch_repeat = repeat_counts(cylinder)
        elif args.ring:
            with open(args.ring) as fp:
                ring = json.load(fp)
            # A single copy wraps cleanly on its own; repeats join by sweeping
            # the sketch once more, exactly as the cylinder does.
            if not ring.get("sweepThenRepeat") and int(ring.get("repeatX", 1)) > 1:
                from cylinder import repeat_counts
                sketch_repeat = repeat_counts({"repeatX": int(ring["repeatX"]), "repeatY": 1})
        elif args.lighter:
            with open(args.lighter) as fp:
                lighter = json.load(fp)
            # Same rule as the ring: one copy wraps alone, repeats sweep again.
            if not lighter.get("sweepThenRepeat") and int(lighter.get("repeatX", 1)) > 1:
                from cylinder import repeat_counts
                sketch_repeat = repeat_counts({"repeatX": int(lighter["repeatX"]), "repeatY": 1})
        elif args.sketch_repeat:
            from cylinder import repeat_counts
            sketch_repeat = repeat_counts(dict(zip(("repeatX", "repeatY"), args.sketch_repeat)))
    except (OSError, ValueError) as error:
        raise ConvertError(str(error)) from error

    if args.inspect:
        json.dump(inspect(args.input, args.sagitta, args.scale), sys.stdout)
        return

    if args.preview:
        json.dump(preview(args), sys.stdout)
        return

    if args.sketch or args.sketch_edit:
        import sketch_arcs
        try:
            if args.sketch:
                json.dump(sketch_arcs.read_sketch(args.input, args.sagitta), sys.stdout)
                return
            if not args.output:
                raise ConvertError("an output path is required for --sketch-edit")
            with open(args.sketch_edit) as fp:
                edits = json.load(fp)
            if not isinstance(edits, list):
                raise ConvertError("--sketch-edit expects a JSON list of arcs")
            sketch_arcs.write_arcs(args.input, edits, args.output)
        except (OSError, ValueError) as error:
            raise ConvertError(str(error)) from error
        json.dump({"arcs": len(edits)}, sys.stdout)
        return

    if args.profile_sections:
        sections = load_profile_sections(args.input, args.groove_profile, args.sagitta, args.cusp_profile)
        # Preserve section precision; small features must not disappear in the editor.
        json.dump({key: {"exterior": list(poly.exterior.coords),
                         "holes": [list(r.coords) for r in poly.interiors],
                         "bounds": list(poly.bounds)} if poly is not None else None
                   for key, poly in sections.items()}, sys.stdout)
        return

    if not args.output and not args.regions and not args.addition_preview:
        raise ConvertError("an output path is required unless --inspect is given")

    positive("wall width", args.wall_width)
    positive("wall height", args.wall_height)
    positive("region step", args.region_step)
    if args.wall_overlap < 0:
        raise ConvertError("wall overlap must be 0 or greater")
    if args.wall_overlap >= args.wall_width / 2.0:
        raise ConvertError("wall overlap must be less than half the wall width, "
                           "or the faces either side of a wall meet inside it")
    if args.region_min < 0:
        raise ConvertError("region min must be 0 or greater")
    if args.region_max < args.region_min:
        raise ConvertError("region max must be greater than or equal to region min")

    effect = None
    if args.effect != "none":
        if not 1 <= args.effect_steps <= MAX_EFFECT_STEPS:
            raise ConvertError(f"effect steps must be 1 to {MAX_EFFECT_STEPS}")
        positive("effect inset", args.effect_inset)
        effect = {"name": args.effect, "steps": args.effect_steps,
                  "inset": args.effect_inset}

    holes = []
    if args.holes:
        try:
            with open(args.holes) as fp:
                holes = json.load(fp)
        except (OSError, ValueError) as exc:
            raise ConvertError(f"could not read the holes: {exc}") from None
        if not isinstance(holes, list):
            raise ConvertError("holes must be a JSON array")

    specs = [load_layer_spec(p) for p in args.also]
    if args.profile:
        if holes or any(s.get("holes") for s in specs):
            raise ConvertError("mounting holes cannot be cut through a swept "
                               "frame — clear the holes or the profile")
        if args.wall_stack:
            raise ConvertError("a layered frame needs flat walls — "
                               "clear the frame bands or the profile")

    # One boundary bounds every drawing in the stack. It is read once, in the
    # drawings' own coordinates, and placed per drawing at that drawing's
    # scale, so drawings sharing a coordinate system are cropped alike.
    boundary = None
    if args.boundary:
        positive("boundary size", args.boundary_scale)
        positive("subject size", args.subject_scale)
        boundary = load_boundary(args.boundary, args.sagitta)

    # Every drawing is planned on its own first; stacking shifts them after.
    defer = sketch_repeat is not None
    layers = [dict(plan_drawing(args.input, args.scale, args.layers, args,
                                boundary, defer),
                   holes=holes, spec=None)]
    for spec in specs:
        layers.append(dict(
            plan_drawing(spec["file"], spec.get("scale", 1.0),
                         spec.get("layers"), args, boundary, defer),
            holes=spec.get("holes", []), spec=spec))

    # Added drawings are centred on the base drawing's centre; the base keeps
    # its own coordinates, so single-drawing output is exactly as before.
    cx0, cy0 = polys_centre(layers[0]["wall_polys"])
    for drawing in layers[1:]:
        cx, cy = polys_centre(drawing["wall_polys"])
        dx, dy = cx0 - cx, cy0 - cy
        drawing["wall_polys"] = [translate(p, dx, dy) for p in drawing["wall_polys"]]
        drawing["region_polys"] = [translate(p, dx, dy)
                                   for p in drawing["region_polys"]]
        if drawing["crop"] is not None:
            # The crop is the outermost outline the 3MF outline version uses,
            # so it has to ride with the drawing like everything else does.
            drawing["crop"] = translate(drawing["crop"], dx, dy)
        if drawing["frame_mesh"] is not None:
            drawing["frame_mesh"].apply_translation((dx, dy, 0.0))
        if drawing["connection_curves"]:
            drawing["connection_curves"] = [translate(rib, dx, dy)
                                            for rib in drawing["connection_curves"]]
        if drawing["connection_polys"]:
            drawing["connection_polys"] = [translate(rib, dx, dy)
                                           for rib in drawing["connection_polys"]]
        if drawing["connection_mesh"] is not None:
            drawing["connection_mesh"].apply_translation((dx, dy, 0.0))
        drawing["holes"] = shift_holes(drawing["holes"], dx, dy)
        drawing["offset"] = (dx, dy)
    layers[0]["offset"] = (0.0, 0.0)

    # Each drawing sits on the frame top of the one below it.
    z = 0.0
    for drawing in layers:
        drawing["z_base"] = z
        drawing["cutter"] = hole_cutter(drawing["holes"])
        drawing["effect"] = effect        # one effect for the whole model
        z += drawing["wall_height"]

    tiling = repeat_sketch(layers, *sketch_repeat) if sketch_repeat is not None else None

    if args.addition_outline or args.addition_preview:
        from additions import attach_shelf, placement_preview
        from dxf2stl import ConvertError as ShelfInputError
        try:
            if args.addition_preview:
                json.dump(placement_preview(layers[0]["frame_mesh"], args), sys.stdout)
                return
            layers[0]["frame_mesh"] = attach_shelf(layers[0]["frame_mesh"], args)
        except ShelfInputError as error:
            raise ConvertError(str(error)) from error

    def region_payload(i, poly, cutter, drawing):
        # area and centroid describe the whole face, not the cut pieces, so
        # they stay put as holes are added and removed.
        payload = {
            "id": i, "area": round(poly.area, 4),
            "centroid": [round(poly.centroid.x, 4), round(poly.centroid.y, 4)],
            "parts": [polygon_json(q) for q in cut(poly, cutter)],
        }
        # Match paint in drawing coordinates, independent of wall width,
        # model scale, layer centring, mounting holes and face ordering.
        dx, dy = drawing["offset"]
        source = aff_scale(translate(poly, -dx, -dy),
                           xfact=1 / drawing["paint_scale"],
                           yfact=1 / drawing["paint_scale"], origin=(0, 0))
        # The window-content transform is undone as well, so sliding or
        # resizing the subject under its boundary never moves a face's paint:
        # the subject stays put in this frame and only the crop travels.
        content = drawing.get("content")
        if content is not None:
            step = content["scale"]
            shift_x, shift_y = content["shift"]
            cx, cy = content["centre"]
            cx /= drawing["paint_scale"]
            cy /= drawing["paint_scale"]
            shift_x /= drawing["paint_scale"]
            shift_y /= drawing["paint_scale"]
            source = translate(source, -(cx + shift_x), -(cy + shift_y))
            source = aff_scale(source, xfact=1 / step, yfact=1 / step,
                               origin=(0, 0))
            source = translate(source, cx, cy)
        point = source.representative_point()
        # `area` lets the browser break a tie when several painted faces fold
        # into one: the biggest predecessor is the one that survived.
        payload["paintRegion"] = {"polygon": polygon_json(source),
                                  "area": round(source.area, 6),
                                  "point": [point.x, point.y]}
        if effect and effect["name"] == "maya-pyramid":
            # The terraces above the first, so the browser can show the same
            # steps the STL is built from instead of guessing at an offset.
            payload["steps"] = [
                [polygon_json(q) for face in faces for q in cut(face, cutter)]
                for faces in pyramid_steps(poly, effect["steps"], effect["inset"])[1:]
            ]
        return payload

    def layer_payload(drawing):
        payload = {
            "wallHeight": drawing["wall_height"],
            "zBase": round(drawing["z_base"], 6),
            "offset": [round(v, 6) for v in drawing["offset"]],
            "walls": [polygon_json(p)
                      for w in drawing["wall_polys"]
                      for p in cut(w, drawing["cutter"])],
            "regions": [region_payload(i, p, drawing["cutter"], drawing)
                        for i, p in enumerate(drawing["region_polys"])],
        }
        if drawing["frame_mesh"] is not None:
            # The swept frame is no longer a prism the browser can extrude,
            # so it travels as a ready-made binary STL.
            payload["wallMesh"] = base64.b64encode(
                drawing["frame_mesh"].export(file_type="stl")).decode("ascii")
        if drawing["open_endpoints"]:
            payload["openEndpoints"] = drawing["open_endpoints"]
        return payload

    if args.regions:
        json.dump({**layers[0]["summary"], **layer_payload(layers[0]),
                   "drawings": [layer_payload(d) for d in layers],
                   **({"cylinderRepeat": tiling} if tiling else {})}, sys.stdout)
        return

    assigned = {k: as_float(k, v) for k, v in load_map(args.heights, "height").items()}
    groups = {k: str(v) for k, v in load_map(args.groups, "group").items()}
    explicit = load_map(args.stacks, "stack")

    wall_stack = None
    if args.wall_stack:
        try:
            with open(args.wall_stack) as fp:
                raw = json.load(fp)
        except (OSError, ValueError) as exc:
            raise ConvertError(f"could not read the frame bands: {exc}") from None
        if not isinstance(raw, list):
            raise ConvertError("the frame bands must be a JSON array")
        wall_stack = []
        for layer in raw:
            if not isinstance(layer, dict):
                raise ConvertError("a frame band is not an object")
            try:
                thickness = float(layer.get("t", layer.get("h")))
            except (TypeError, ValueError):
                raise ConvertError("a frame band has no numeric thickness") from None
            group = layer.get("g")
            wall_stack.append({"t": round(thickness, 6),
                               "g": None if group is None else str(group)})

    # One rng consumed drawing by drawing, so a single drawing's random heights
    # are exactly what they were before stacking existed.
    rng = random.Random(args.seed)
    n_assigned = len(assigned) + len(explicit)
    for drawing in layers:
        spec = drawing["spec"]
        if spec is None:
            d_assigned, d_groups, d_explicit = assigned, groups, explicit
        else:
            d_assigned = {k: as_float(k, v) for k, v in
                          as_map(spec.get("heights", {}), "height").items()}
            d_groups = {}
            d_explicit = as_map(spec.get("stacks", {}), "stack")
            n_assigned += len(d_assigned) + len(d_explicit)
        drawing["stacks"] = region_stacks(
            len(drawing["region_polys"]), args.region_min, args.region_max,
            args.region_step, rng, d_assigned, d_groups, d_explicit,
        )

    n_holes = sum(len(drawing["holes"]) for drawing in layers)

    if args.cylinder:
        from cylinder import cylinder_extrude, export_cylinder
        if args.slice_height is not None or args.variations or args.slicer_options or args.output.lower().endswith(".3mf"):
            raise ConvertError("Cylinder mode exports STL; switch to flat mode for SVG slices or 3MF variations")
        face_offsets = None
        if tiling:
            # The frame column already holds every row; faces repeat up here.
            face_offsets = [(0.0, iy * tiling["period"][1]) for iy in range(tiling["repeatY"])]
        buckets, n_walls, n_regions = colour_buckets(layers, wall_stack, extrude=cylinder_extrude,
                                                     face_offsets=face_offsets)
        try:
            lid_art = None
            if args.lid_sketch:
                from lid_art import lid_art_mesh
                lid_art, _ = lid_art_mesh(args.lid_sketch, args.profile, cylinder,
                                         args.profile_scale, args.sagitta, args.groove_profile,
                                         args.profile_height_scale, args.groove_width, args.groove_height,
                                         args.profile_z, args.groove_z)
            result = export_cylinder(args.output, buckets, cylinder, bool(args.split or args.groups),
                                     lid_art, tiling)
        except ValueError as error:
            raise ConvertError(str(error)) from error
        json.dump({**layers[0]["summary"], **result, "walls": n_walls,
                   "regions": n_regions, "holes": n_holes}, sys.stdout)
        return

    if args.ring:
        from ring import ring_extrude, export_ring, export_ring_sizes
        if args.slice_height is not None or args.variations or args.slicer_options or (args.output and args.output.lower().endswith(".3mf")):
            raise ConvertError("Ring mode exports STL; switch to flat mode for SVG slices or 3MF variations")
        try:
            ring_settings = ring if ring is not None else json.load(open(args.ring))
            buckets, n_walls, n_regions = colour_buckets(layers, wall_stack, extrude=ring_extrude)
            # A list of sizes sweeps the relief once, then revolves and wraps a
            # separate printable ring for each inner diameter.
            if ring_settings.get("sizes"):
                result = export_ring_sizes(args.output, buckets, ring_settings,
                                           args.sagitta, ring_settings["sizes"], tiling=tiling)
            else:
                result = export_ring(args.output, buckets, ring_settings, args.sagitta,
                                     split=bool(args.split or args.groups), tiling=tiling)
        except (OSError, ValueError) as error:
            raise ConvertError(str(error)) from error
        json.dump({**layers[0]["summary"], **result, "walls": n_walls,
                   "regions": n_regions, "holes": n_holes}, sys.stdout)
        return

    if args.lighter:
        from lighter import ellipse_extrude, export_lighter
        if args.slice_height is not None or args.variations or args.slicer_options or (args.output and args.output.lower().endswith(".3mf")):
            raise ConvertError("Lighter mode exports STL; switch to flat mode for SVG slices or 3MF variations")
        try:
            lighter_settings = lighter if lighter is not None else json.load(open(args.lighter))
            buckets, n_walls, n_regions = colour_buckets(layers, wall_stack, extrude=ellipse_extrude)
            result = export_lighter(args.output, buckets, lighter_settings,
                                    split=bool(args.split or args.groups), tiling=tiling)
        except (OSError, ValueError) as error:
            raise ConvertError(str(error)) from error
        json.dump({**layers[0]["summary"], **result, "walls": n_walls,
                   "regions": n_regions, "holes": n_holes}, sys.stdout)
        return

    if args.slicer_options:
        from slicer_3mf import export
        try:
            options = json.loads(open(args.slicer_options).read())
            json.dump(export(args.output, layers, wall_stack, options), sys.stdout)
        except (ValueError, TypeError) as error:
            raise ConvertError(str(error)) from error
        return

    if args.variations:
        patterns = None
        if args.patterns:
            patterns = [p.strip().lower() for p in args.patterns.split(",")
                        if p.strip()]
            unknown = [p for p in patterns if p not in SURFACE_PATTERNS]
            if unknown:
                raise ConvertError("unknown surface pattern(s): "
                                   + ", ".join(unknown) + " — choose from "
                                   + ", ".join(SURFACE_PATTERNS))
        files, n_walls, n_regions = write_project_3mf_variations(
            args.output, layers, wall_stack, patterns)
        json.dump({**layers[0]["summary"], "files": files,
                   "variations": len(files), "holes": n_holes,
                   "walls": n_walls, "regions": n_regions,
                   "drawings": len(layers), "effect": args.effect}, sys.stdout)
        return

    if args.output and args.output.lower().endswith(".3mf"):
        files, n_walls, n_regions = write_project_3mf(args.output, layers,
                                                      wall_stack)
        json.dump({**layers[0]["summary"], "files": files, "holes": n_holes,
                   "walls": n_walls, "regions": n_regions,
                   "drawings": len(layers), "effect": args.effect}, sys.stdout)
        return

    if args.split or args.groups:
        files, n_walls, n_regions = write_group_files(args.output, layers,
                                                      wall_stack)
        json.dump({**layers[0]["summary"], "files": files, "holes": n_holes,
                   "walls": n_walls, "regions": n_regions,
                   "drawings": len(layers), "effect": args.effect}, sys.stdout)
        return

    meshes, n_walls, n_regions, n_layers = build_meshes(layers, wall_stack)

    if args.slice_height is not None:
        from slice_svg import slice_svg
        try:
            svg, stats = slice_svg(meshes, args.slice_height)
        except ValueError as exc:
            raise ConvertError(str(exc)) from exc
        with open(args.output, "w", encoding="utf-8") as fp:
            fp.write(svg)
        json.dump(stats, sys.stdout)
        return

    solid = trimesh.util.concatenate(meshes)
    solid.export(args.output)

    lo, hi = solid.bounds
    json.dump({
        **layers[0]["summary"],
        "walls": n_walls,
        "regions": n_regions,
        "slabs": n_layers,        # "layers" already names the drawing's layers
        "assigned": n_assigned,
        "holes": n_holes,
        "drawings": len(layers),
        "effect": args.effect,
        "triangles": int(len(solid.faces)),
        "size": [round(float(hi[i] - lo[i]), 3) for i in range(3)],
    }, sys.stdout)


if __name__ == "__main__":
    try:
        main()
    except ConvertError as exc:
        print(exc, file=sys.stderr)
        raise SystemExit(1)
