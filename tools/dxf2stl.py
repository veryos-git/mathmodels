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

--boundary takes a drawing holding a closed polygon and cuts the pattern down
to it: whatever lies outside is thrown away, and the boundary itself is walled
so the cropped pattern comes out with a rim (--no-boundary-wall cuts flush
instead). The polygon is read in the drawing's own coordinates and scaled with
it, so it is drawn over the pattern; --boundary-scale, --boundary-x and
--boundary-y place it by eye. --boundary-fit instead centres the boundary on
the pattern and scales it uniformly to just fit inside it, for files that do
not share a coordinate system.

--effect reshapes every face without touching the painting: maya-pyramid
splits a face's painted height into terraces, each stepped one --effect-inset
further in from its own outline than the one below it.

--also stacks another drawing on top: its JSON spec holds the drawing's "file"
plus its own "scale", "layers", "stacks"/"heights" and "holes". Each extra
drawing is centred on the base drawing and sits on the frame top of the one
below; colour groups are shared, so split and 3MF exports merge the layers.
"""

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
from shapely import STRtree
from shapely.affinity import scale as aff_scale
from shapely.affinity import translate
from shapely.geometry import LinearRing, LineString, Point, Polygon
from shapely.ops import polygonize, unary_union
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
    faces that survive rather than among the ones the pattern had before it
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

MITER_LIMIT = 2.0

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


def load_profile(path, sagitta):
    """The closed cross-section to sweep, anchored centre-x / bottom edge.

    Interior construction lines dissolve in the union, and the largest shape
    left is the section — a profile is one closed outline, not several.
    """
    merged = unary_union(closed_faces(path, sagitta, "profile"))
    polys = list(polygons_of(merged))
    if not polys:
        raise ConvertError("the profile drawing has no closed outline — "
                           "the sweep profile must be one closed shape")
    profile = max(polys, key=lambda p: p.area)
    minx, miny, maxx, _ = profile.bounds
    return translate(profile, xoff=-(minx + maxx) / 2.0, yoff=-miny)


def chain_curves(curves):
    """Curves joined end-to-end into the longest possible polylines.

    Entities rarely arrive as one polyline per visual stroke, and a swept
    joint only comes out right where the sweep runs straight through it.
    Where several segments meet, the straightest continuation is the real
    path — pairing them up arbitrarily turns the chain back on itself and
    the sweep folds into garbage there.
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

    def straightest(anchor, outward):
        """The unused segment at `anchor` most in line with `outward`."""
        best = None
        for j, other in enumerate(segs):
            if used[j]:
                continue
            if other[0] == anchor:
                cand, forward = unit(anchor, other[1]), True
            elif other[-1] == anchor:
                cand, forward = unit(anchor, other[-2]), False
            else:
                continue
            score = outward[0] * cand[0] + outward[1] * cand[1]
            if best is None or score > best[0]:
                best = (score, j, forward)
        return best[1:] if best else None

    chains = []
    used = [False] * len(segs)
    for i, seg in enumerate(segs):
        if used[i]:
            continue
        used[i] = True
        chain = list(seg)
        while chain[0] != chain[-1]:
            grown = False
            # tail, then head; each takes the straightest continuation on offer
            nxt = straightest(chain[-1], unit(chain[-2], chain[-1]))
            if nxt is not None:
                j, forward = nxt
                chain.extend(segs[j][1:] if forward else segs[j][-2::-1])
                used[j] = True
                grown = True
            if chain[0] != chain[-1]:
                nxt = straightest(chain[0], unit(chain[1], chain[0]))
                if nxt is not None:
                    j, forward = nxt
                    chain = (segs[j][:-1] if not forward else segs[j][:0:-1]) + chain
                    used[j] = True
                    grown = True
            if not grown:
                break
        chains.append(chain)
    return chains


def sweep_profile(profile, chains):
    """The frame as one mesh: the profile swept along every path.

    The path lies in the drawing plane, so the moving frame is simple — the
    profile's x runs along the path's in-plane normal, its y is z. Planar
    paths mean no twist. Corners are mitred: the ring sits on the angle
    bisector, pushed out by 1/cos(half the turn), exactly like a mitered
    stroke join — so the apex of a pointed arch comes to a real point.
    Past MITER_LIMIT the mitre is clipped to a bevel, or a cusp would spike.
    """
    ring = list(profile.exterior.coords)[:-1]
    cap_v, cap_f = trimesh.creation.triangulate_polygon(profile)
    meshes = []
    for chain in chains:
        closed = chain[0] == chain[-1]
        pts = chain[:-1] if closed else chain
        n = len(pts)
        if n < 2:
            continue
        # A closed loop swept backwards mirrors an asymmetric profile.
        if closed and not LinearRing(pts + [pts[0]]).is_ccw:
            pts = pts[::-1]
        P = np.array(pts)

        # Per-segment left normals first; the vertex frames derive from them.
        nseg = n if closed else n - 1
        D = np.array([P[(i + 1) % n] - P[i] for i in range(nseg)])
        U = D / np.maximum(np.hypot(D[:, 0], D[:, 1])[:, None], 1e-12)
        SN = np.stack([-U[:, 1], U[:, 0]], axis=1)

        N = np.zeros((n, 2))
        for i in range(n):
            if not closed and i == 0:
                N[i] = SN[0]
                continue
            if not closed and i == n - 1:
                N[i] = SN[-1]
                continue
            s = SN[i - 1] + SN[i % nseg]
            L = np.hypot(*s)
            if L < 1e-6:
                # A hairpin doubles back on itself; hold the incoming normal
                # instead of averaging two opposites into nothing.
                N[i] = SN[i - 1]
                continue
            N[i] = s / L * min(2.0 / L, MITER_LIMIT)

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
        meshes.append(trimesh.Trimesh(vertices=verts, faces=np.array(faces),
                                      process=False))

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
                meshes.append(cap)
    return trimesh.util.concatenate(meshes)


# ------------------------------------------------------------- boundary crop
#
# A second drawing — a closed polygon — bounds the pattern: whatever lies
# outside it is cut away. The polygon is read in the pattern's own coordinates
# and scaled with it, so a crop drawn over the pattern lands where it was
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

    As drawn, it is scaled with the pattern and stays registered on it. Fit
    instead re-anchors it: the boundary is centred on the pattern's box and
    scaled — uniformly, so its shape holds — until it just fits inside it.
    That is the behaviour you want when the two files came out of different
    coordinate systems. Its own size multiplier works about its centre, and
    the nudge is in finished millimetres — the units the model is measured
    in — so both mean the same thing whatever the drawing was drawn in.
    """
    # The drawing's scale comes first — the fit is worked out in the scaled
    # coordinates, where the pattern's box is measured.
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


def transform_curves(curves, scale, dx, dy):
    """Resize and slide the pattern — the window's content — under the boundary.

    The boundary is the frame and stays put; this moves what is shown through
    it. Scaling is about the pattern's own centre, and the shift is in model
    millimetres, so both mean the same thing whatever the drawing was drawn in.
    """
    if scale == 1.0 and not dx and not dy:
        return curves
    xs = [p[0] for c in curves for p in c]
    ys = [p[1] for c in curves for p in c]
    cx = (min(xs) + max(xs)) / 2.0
    cy = (min(ys) + max(ys)) / 2.0
    out = []
    for c in curves:
        out.append([(round((x - cx) * scale + cx + dx, 6),
                     round((y - cy) * scale + cy + dy, 6))
                    for x, y in c])
    return out


def clip_curves(curves, region):
    """Every curve trimmed to the part of it that lies inside `region`.

    Most curves are wholly in or wholly out, and answering that from a
    prepared geometry is far cheaper than intersecting each one: a pattern
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
    """The pattern and boundary outlines, in millimetres, for the 2D window.

    This is only the geometry the browser needs to draw the position preview:
    the pattern's flattened curves and the boundary's own rings, both at their
    drawn size. The browser scales and slides them exactly as `place_boundary`
    and `transform_curves` will, so the preview matches the crop.
    """
    curves, _, _ = read_curves(args.input, args.sagitta, args.layers, scale=1.0)
    out = {
        "pattern": {
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


def plan_drawing(path, scale, layers_csv, args, boundary=None):
    """One drawing read and planned into walls and faces.

    This is the whole per-drawing pipeline: curves in, the boundary crop and
    the profile sweep if there are any, then the wall ribbons and the regions
    they enclose. Stacking several drawings means calling this once per
    drawing and offsetting the results.
    """
    layers = None
    if layers_csv:
        layers = {name for name in layers_csv.split(",") if name}
    curves, used, skipped = read_curves(path, args.sagitta, layers, scale)

    wall_width, wall_height = args.wall_width, args.wall_height
    profile = None
    if args.profile:
        profile = load_profile(args.profile, args.sagitta)
        if args.profile_scale != 1.0:
            if args.profile_scale <= 0:
                raise ConvertError("profile scale must be greater than 0")
            profile = aff_scale(profile, xfact=args.profile_scale, yfact=1.0,
                                origin=(0.0, 0.0))
        minx, _, maxx, maxy = profile.bounds
        # The profile sets the frame's dimensions: its x span is the wall
        # width the faces are planned against, its top is the wall height.
        wall_width, wall_height = maxx - minx, maxy

    # The boundary crops the pattern. Walled — the default — the cut curves
    # plus the boundary's own rings are the drawing from here on, so the rim
    # closes the faces along the cut like any other wall. Cut flush instead and
    # the pattern is planned as drawn and trimmed afterwards, so a face the cut
    # runs through survives as the part of it that is inside.
    crop = n_cropped = None
    n_curves = len(curves)
    if boundary is not None:
        fit_to = None
        if args.boundary_fit:
            # The pattern's own box, in its drawing units, before scaling: the
            # boundary is fitted to this, so the crop lands on the pattern
            # whatever coordinate systems the two files were drawn in.
            xs = [p[0] for c in curves for p in c]
            ys = [p[1] for c in curves for p in c]
            fit_to = (min(xs), min(ys), max(xs), max(ys))
        crop = place_boundary(boundary, scale, args.boundary_scale,
                              args.boundary_x, args.boundary_y, fit_to)

    # The window content — the pattern itself — is resized and slid under the
    # boundary after the boundary is placed, so the frame stays put while the
    # crop finds its composition. Without a boundary this would only shift the
    # model and break the finished-size maths, so it is applied to the crop.
    if boundary is not None:
        curves = transform_curves(curves, args.pattern_scale,
                                  args.pattern_x, args.pattern_y)

    if boundary is not None:
        inside = clip_curves(curves, crop)
        if not inside:
            raise ConvertError("the boundary does not overlap the drawing — "
                               "nothing of the pattern would be left")
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
    if profile:
        swept = curves if crop is None or args.boundary_wall \
            else clip_curves(curves, crop)
        frame_mesh = sweep_profile(profile, chain_curves(swept))
    else:
        frame_mesh = None

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
    summary = {
        "curves": n_curves,
        "layers": [{"name": n, "entities": c} for n, c in sorted(used.items())],
        "skipped": [{"type": t, "count": c} for t, c in sorted(skipped.items())],
    }
    if n_cropped is not None:
        summary["cropped"] = n_cropped
    return {
        "wall_polys": wall_polys,
        "region_polys": region_polys,
        "wall_height": wall_height,
        "frame_mesh": frame_mesh,
        "summary": summary,
    }


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


def region_solids(region_polys, stacks, cutter, z_base=0.0, effect=None):
    """Every layer of every face as a solid, paired with its colour group."""
    for poly, stack in zip(region_polys, stacks):
        for face, z, thickness, group in face_slabs(poly, stack, effect):
            for piece in cut(face, cutter):
                solid = trimesh.creation.extrude_polygon(piece, thickness)
                solid.apply_translation((0.0, 0.0, z_base + z))
                yield solid, group


def wall_solids(wall_polys, wall_height, cutter, wall_stack=None, frame_mesh=None,
                z_base=0.0):
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
                solid = trimesh.creation.extrude_polygon(piece, thickness)
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


def colour_buckets(layers, wall_stack):
    """Every solid, gathered under the colour group that prints it.

    A layered frame has its slabs filed under their own colours; a plain frame
    keeps a group of its own. Group labels are shared across drawing layers,
    so stacked drawings merge into the same buckets.
    """
    buckets = defaultdict(list)
    n_walls, n_regions = 0, 0
    for drawing in layers:
        for solid, group in wall_solids(drawing["wall_polys"],
                                        drawing["wall_height"], drawing["cutter"],
                                        wall_stack, drawing["frame_mesh"],
                                        drawing["z_base"]):
            buckets[group or "walls"].append(solid)
            n_walls += 1
        for solid, group in region_solids(drawing["region_polys"],
                                          drawing["stacks"], drawing["cutter"],
                                          drawing["z_base"], drawing["effect"]):
            buckets[group or "ungrouped"].append(solid)
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
    return write_3mf(path, members), n_walls, n_regions


def write_project_3mf_variations(outdir, layers, wall_stack=None):
    """One 3MF holding every permutation of the palette's colour groups.

    The frame — an unnumbered group such as "walls" — keeps its colour in every
    combination; the numbered palette groups trade places, so a two-colour model
    has two combinations and a three-colour model six. Each combination is
    written as one merged assembly object, laid out side by side on the plate.
    """
    merged, n_walls, n_regions = colour_buckets(layers, wall_stack)
    palette = sorted((m for m in merged if m[0].split("-", 1)[0].isdigit()),
                     key=lambda m: int(m[0].split("-", 1)[0]))
    fixed = sorted((m for m in merged if not m[0].split("-", 1)[0].isdigit()),
                   key=lambda m: m[0])
    n = len(palette)
    os.makedirs(outdir, exist_ok=True)

    combinations = []
    # permutations(range(0)) is one empty tuple, so a frame-only model still
    # exports exactly one combination.
    for perm in itertools.permutations(range(n)):
        members = [(label, mesh, perm[i] + 1)
                   for i, (label, mesh, _) in enumerate(palette)]
        members += [(label, mesh, n + 1 + i)
                    for i, (label, mesh, _) in enumerate(fixed)]
        by_extruder = [None] * n
        for i, slot in enumerate(perm):
            by_extruder[slot] = palette[i][0]
        order = "-".join(label.split("-", 1)[1] for label in by_extruder)
        combinations.append((order or "frame", members))

    path = os.path.join(outdir, "variations.3mf")
    n_combos, n_parts, n_tris = write_3mf_assemblies(path, combinations)

    return [{
        "file": "variations.3mf",
        "variations": n_combos,
        "parts": n_parts,
        "triangles": n_tris,
    }], n_walls, n_regions


"""3MF, in the flavour Snapmaker's slicer (a Bambu Studio fork) writes.

A 3MF is a zip. The geometry is plain 3MF core — one `.model` per part under
3D/Objects, each holding vertices and triangles — while the *colour* lives
entirely in Metadata/model_settings.config, as an `extruder` number per object.
Nothing about the mesh carries colour.

Every part is placed with the same transform, so the pieces stay registered on
top of each other instead of being scattered as separate imports.
"""

PLATE_CENTRE = (135.5, 136.0)      # middle of the 270 x 270 bed
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


def write_3mf(path, members):
    """members: [(name, mesh, extruder)] — one entry per colour."""
    solids = [m for m in members if len(m[1].faces)]
    if not solids:
        raise ConvertError("there is nothing to export")

    lo = [min(m.bounds[0][i] for _, m, _ in solids) for i in range(3)]
    hi = [max(m.bounds[1][i] for _, m, _ in solids) for i in range(3)]
    # One shared offset keeps the parts registered; z sits the model on the bed.
    place = (
        PLATE_CENTRE[0] - (lo[0] + hi[0]) / 2,
        PLATE_CENTRE[1] - (lo[1] + hi[1]) / 2,
        -lo[2],
    )
    move = f"{IDENTITY} {_num(place[0])} {_num(place[1])} {_num(place[2])}"

    parts = []
    for i, (name, mesh, extruder) in enumerate(solids):
        parts.append({
            "mesh_id": 2 * i + 1,
            "object_id": 2 * i + 2,
            "path": f"/3D/Objects/{safe_name(name)}_{2 * i + 1}.model",
            "name": name,
            "mesh": mesh,
            "extruder": extruder,
        })

    components = "".join(
        f'  <object id="{p["object_id"]}" p:UUID="{uuid.uuid4()}" type="model">\n'
        f'   <components><component p:path="{p["path"]}" objectid="{p["mesh_id"]}"'
        f' p:UUID="{uuid.uuid4()}" transform="{IDENTITY} 0 0 0"/></components>\n'
        '  </object>\n'
        for p in parts
    )
    items = "".join(
        f'  <item objectid="{p["object_id"]}" p:UUID="{uuid.uuid4()}"'
        f' transform="{move}" printable="1"/>\n'
        for p in parts
    )
    model = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<model unit="millimeter" xml:lang="en-US" {MODEL_NS}>\n'
        ' <metadata name="Application">vector2stl</metadata>\n'
        ' <metadata name="BambuStudio:3mfVersion">1</metadata>\n'
        ' <resources>\n' + components + ' </resources>\n'
        f' <build p:UUID="{uuid.uuid4()}">\n' + items + ' </build>\n'
        '</model>\n'
    )

    rels = "".join(
        f'<Relationship Target="{p["path"]}" Id="rel-{i + 1}"'
        ' Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>'
        for i, p in enumerate(parts)
    )

    # The colours: one extruder per object.
    objects = "".join(
        f'  <object id="{p["object_id"]}">\n'
        f'    <metadata key="name" value="{p["name"]}"/>\n'
        f'    <metadata key="extruder" value="{p["extruder"]}"/>\n'
        f'    <part id="{p["mesh_id"]}" subtype="normal_part">\n'
        f'      <metadata key="name" value="{p["name"]}"/>\n'
        '      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n'
        f'      <metadata key="extruder" value="{p["extruder"]}"/>\n'
        '    </part>\n'
        '  </object>\n'
        for p in parts
    )
    instances = "".join(
        f'    <model_instance>\n'
        f'      <metadata key="object_id" value="{p["object_id"]}"/>\n'
        '      <metadata key="instance_id" value="0"/>\n'
        '    </model_instance>\n'
        for p in parts
    )
    assembled = "".join(
        f'   <assemble_item object_id="{p["object_id"]}" instance_id="0"'
        f' transform="{move}" offset="0 0 0"/>\n'
        for p in parts
    )
    settings = (
        '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n' + objects
        + '  <plate>\n    <metadata key="plater_id" value="1"/>\n'
        '    <metadata key="plater_name" value=""/>\n'
        '    <metadata key="locked" value="false"/>\n' + instances
        + '  </plate>\n  <assemble>\n' + assembled + '  </assemble>\n</config>\n'
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
        for p in parts:
            archive.writestr(p["path"].lstrip("/"), _mesh_model(p["mesh_id"], p["mesh"]))
        archive.writestr("Metadata/model_settings.config", settings)
        archive.writestr(
            "Metadata/slice_info.config",
            '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <header>\n'
            '    <header_item key="X-BBL-Client-Type" value="slicer"/>\n'
            '    <header_item key="X-BBL-Client-Version" value=""/>\n'
            '  </header>\n</config>\n',
        )

    return [
        {"file": p["name"], "extruder": p["extruder"],
         "triangles": int(len(p["mesh"].faces))}
        for p in parts
    ]


def write_3mf_assemblies(path, combinations):
    """One 3MF whose build holds one *assembly* per colour combination.

    `combinations` is a list of `(name, members)`; each member is
    `(label, mesh, extruder)` — that combination's colour parts. Every
    combination's parts are written into one shared object file and referenced
    by a single assembly object, so each combination behaves as one merged
    multi-colour object on the plate. The combinations are laid out in a grid
    so they never overlap.
    """
    # Drop empty parts and empty combinations.
    combos = []
    for name, members in combinations:
        solids = [(label, mesh, extruder) for (label, mesh, extruder) in members
                  if len(mesh.faces)]
        if solids:
            combos.append((name, solids))
    if not combos:
        raise ConvertError("there is nothing to export")

    # Every combination shares the same geometry, so one box centres them all.
    meshes = [m for _, members in combos for _, m, _ in members]
    lo = [min(m.bounds[0][i] for m in meshes) for i in range(3)]
    hi = [max(m.bounds[1][i] for m in meshes) for i in range(3)]
    centre = [(lo[i] + hi[i]) / 2 for i in range(3)]
    size = [hi[i] - lo[i] for i in range(3)]

    cols = min(len(combos), 3)
    rows = (len(combos) + cols - 1) // cols
    gap = 5.0
    step_x = size[0] + gap
    step_y = size[1] + gap
    grid_w = (cols - 1) * step_x
    grid_h = (rows - 1) * step_y
    base_x = PLATE_CENTRE[0] - centre[0] - grid_w / 2
    base_y = PLATE_CENTRE[1] - centre[1] + grid_h / 2
    base_z = -lo[2]

    # ids: parts take 1..N, assemblies take 1000+ so the two never collide.
    parts = []          # per part: ci, label, mesh, extruder, mesh_id
    mesh_id = 1
    for ci, (_, members) in enumerate(combos):
        for label, mesh, extruder in members:
            parts.append({"ci": ci, "label": label, "mesh": mesh,
                          "extruder": extruder, "mesh_id": mesh_id})
            mesh_id += 1

    def assembly_id(ci):
        return 1000 + ci

    def offsets(ci):
        col, row = ci % cols, ci // cols
        return base_x + col * step_x, base_y - row * step_y

    # The main model: one assembly object per combination.
    resources = ""
    for ci, (_, members) in enumerate(combos):
        obj_id = assembly_id(ci)
        comps = "".join(
            f'   <component p:path="/3D/Objects/object_{obj_id}.model" '
            f'objectid="{p["mesh_id"]}" p:UUID="{uuid.uuid4()}" '
            f'transform="{IDENTITY} 0 0 0"/>\n'
            for p in parts if p["ci"] == ci
        )
        resources += (
            f'  <object id="{obj_id}" p:UUID="{uuid.uuid4()}" type="model">\n'
            f'   <components>\n{comps}   </components>\n'
            f'  </object>\n'
        )

    build_items = "".join(
        f'  <item objectid="{assembly_id(ci)}" p:UUID="{uuid.uuid4()}" '
        f'transform="{IDENTITY} {_num(offsets(ci)[0])} {_num(offsets(ci)[1])} '
        f'{_num(base_z)}" printable="1"/>\n'
        for ci in range(len(combos))
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

    # One relationship per combination's object file.
    rels = "".join(
        f'<Relationship Target="/3D/Objects/object_{assembly_id(ci)}.model" '
        f'Id="rel-{ci + 1}"'
        ' Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>'
        for ci in range(len(combos))
    )

    # Colour assignments: one object per combination, one part per colour.
    objects = ""
    for ci, (name, _) in enumerate(combos):
        obj_id = assembly_id(ci)
        ps = "".join(
            f'    <part id="{p["mesh_id"]}" subtype="normal_part">\n'
            f'      <metadata key="name" value="{p["label"]}"/>\n'
            '      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n'
            f'      <metadata key="extruder" value="{p["extruder"]}"/>\n'
            '    </part>\n'
            for p in parts if p["ci"] == ci
        )
        top = next(p["extruder"] for p in parts if p["ci"] == ci)
        objects += (
            f'  <object id="{obj_id}">\n'
            f'    <metadata key="name" value="{name}"/>\n'
            f'    <metadata key="extruder" value="{top}"/>\n' + ps
            + '  </object>\n'
        )

    instances = "".join(
        f'    <model_instance>\n'
        f'      <metadata key="object_id" value="{assembly_id(ci)}"/>\n'
        '      <metadata key="instance_id" value="0"/>\n'
        '    </model_instance>\n'
        for ci in range(len(combos))
    )

    assembled = "".join(
        f'   <assemble_item object_id="{assembly_id(ci)}" instance_id="0"'
        f' transform="{IDENTITY} {_num(offsets(ci)[0])} {_num(offsets(ci)[1])} '
        f'{_num(base_z)}" offset="0 0 0"/>\n'
        for ci in range(len(combos))
    )

    settings = (
        '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n' + objects
        + '  <plate>\n    <metadata key="plater_id" value="1"/>\n'
        '    <metadata key="plater_name" value=""/>\n'
        '    <metadata key="locked" value="false"/>\n' + instances
        + '  </plate>\n  <assemble>\n' + assembled + '  </assemble>\n</config>\n'
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
        for ci, (_, _) in enumerate(combos):
            combo_parts = [p for p in parts if p["ci"] == ci]
            objects_xml = "".join(
                f'  <object id="{p["mesh_id"]}" p:UUID="{uuid.uuid4()}" type="model">\n'
                f'   <mesh>{_mesh_xml(p["mesh"])}</mesh>\n'
                '  </object>\n'
                for p in combo_parts
            )
            archive.writestr(
                f"3D/Objects/object_{assembly_id(ci)}.model",
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

    return len(combos), sum(len(m) for _, m in combos), \
        sum(len(m.faces) for _, members in combos for _, m, _ in members)


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
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("output", nargs="?")
    ap.add_argument("--inspect", action="store_true",
                    help="report layers and geometry counts as JSON, then exit")
    ap.add_argument("--regions", action="store_true",
                    help="report the wall and region outlines as JSON, then exit")
    ap.add_argument("--preview", action="store_true",
                    help="report the pattern and boundary outlines as JSON for "
                         "the 2D window-position preview, then exit")
    ap.add_argument("--heights", default=None, metavar="FILE",
                    help='JSON file mapping region id to height, e.g. {"0": 1.1}')
    ap.add_argument("--stacks", default=None, metavar="FILE",
                    help='JSON file mapping face id to its layer stack, e.g. '
                         '{"0": [{"t": 0.65, "g": "1-orange"}, {"t": 1.1, "g": "3-violet"}]}')
    ap.add_argument("--wall-stack", default=None, metavar="FILE",
                    help='JSON list of frame layers, e.g. [{"t": 0.2, "g": "1-orange"}]; '
                         "without it the frame is one solid of --wall-height")
    ap.add_argument("--split", action="store_true",
                    help="write one STL per colour group into the output directory")
    ap.add_argument("--variations", action="store_true",
                    help="write one 3MF per permutation of the palette colour "
                         "groups into the output directory")
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
    ap.add_argument("--boundary", default=None, metavar="FILE",
                    help="DXF/SVG holding a closed polygon that bounds the "
                         "drawing: everything outside it is cut away. It is "
                         "read in the drawing's own coordinates and scaled "
                         "with it, so draw it over the pattern")
    ap.add_argument("--boundary-fit", dest="boundary_fit",
                    action=argparse.BooleanOptionalAction, default=True,
                    help="centre the boundary on the pattern and scale it "
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
    ap.add_argument("--pattern-scale", type=float, default=1.0,
                    help="resize the pattern (the window content) about its own "
                         "centre, while the boundary stays put")
    ap.add_argument("--pattern-x", type=float, default=0.0, metavar="MM",
                    help="slide the pattern sideways under the boundary, in "
                         "finished millimetres")
    ap.add_argument("--pattern-y", type=float, default=0.0, metavar="MM",
                    help="slide the pattern up or down under the boundary, in "
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

    if args.inspect:
        json.dump(inspect(args.input, args.sagitta, args.scale), sys.stdout)
        return

    if args.preview:
        json.dump(preview(args), sys.stdout)
        return

    if not args.output and not args.regions:
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
                               "clear the frame layers or the profile")

    # One boundary bounds every drawing in the stack. It is read once, in the
    # drawings' own coordinates, and placed per drawing at that drawing's
    # scale, so drawings sharing a coordinate system are cropped alike.
    boundary = None
    if args.boundary:
        positive("boundary size", args.boundary_scale)
        positive("pattern size", args.pattern_scale)
        boundary = load_boundary(args.boundary, args.sagitta)

    # Every drawing is planned on its own first; stacking shifts them after.
    layers = [dict(plan_drawing(args.input, args.scale, args.layers, args,
                                boundary),
                   holes=holes, spec=None)]
    for spec in specs:
        layers.append(dict(
            plan_drawing(spec["file"], spec.get("scale", 1.0),
                         spec.get("layers"), args, boundary),
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
        if drawing["frame_mesh"] is not None:
            drawing["frame_mesh"].apply_translation((dx, dy, 0.0))
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

    def region_payload(i, poly, cutter):
        # area and centroid describe the whole face, not the cut pieces, so
        # they stay put as holes are added and removed.
        payload = {
            "id": i, "area": round(poly.area, 4),
            "centroid": [round(poly.centroid.x, 4), round(poly.centroid.y, 4)],
            "parts": [polygon_json(q) for q in cut(poly, cutter)],
        }
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
            "regions": [region_payload(i, p, drawing["cutter"])
                        for i, p in enumerate(drawing["region_polys"])],
        }
        if drawing["frame_mesh"] is not None:
            # The swept frame is no longer a prism the browser can extrude,
            # so it travels as a ready-made binary STL.
            payload["wallMesh"] = base64.b64encode(
                drawing["frame_mesh"].export(file_type="stl")).decode("ascii")
        return payload

    if args.regions:
        json.dump({**layers[0]["summary"], **layer_payload(layers[0]),
                   "drawings": [layer_payload(d) for d in layers]}, sys.stdout)
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
            raise ConvertError(f"could not read the frame layers: {exc}") from None
        if not isinstance(raw, list):
            raise ConvertError("the frame layers must be a JSON array")
        wall_stack = []
        for layer in raw:
            if not isinstance(layer, dict):
                raise ConvertError("a frame layer is not an object")
            try:
                thickness = float(layer.get("t", layer.get("h")))
            except (TypeError, ValueError):
                raise ConvertError("a frame layer has no numeric thickness") from None
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

    if args.variations:
        files, n_walls, n_regions = write_project_3mf_variations(
            args.output, layers, wall_stack)
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
