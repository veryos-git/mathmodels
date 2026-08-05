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
    dxf2stl.py input.dxf --inspect
"""

import argparse
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
import svgelements
import trimesh
from ezdxf.path import make_path
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union

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


def plan_regions(curves, wall_width, wall_overlap=0.0):
    """The wall ribbons and the faces they enclose, in a stable order."""
    lines = [LineString(c) for c in curves]

    # Walls: every curve slotted to a ribbon.
    walls = unary_union(lines).buffer(wall_width / 2.0, cap_style="round", join_style="round")

    # Silhouette: each wall piece's exterior ring filled in. This covers the
    # walls plus every face they enclose, and is robust against the small
    # gaps/overlaps that flattened arcs leave at intersections.
    silhouette = unary_union([Polygon(p.exterior) for p in polygons_of(walls)])

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


def region_solids(region_polys, stacks, cutter):
    """Every layer of every face as a solid, paired with its colour group."""
    for poly, stack in zip(region_polys, stacks):
        z = 0.0
        for layer in stack:
            thickness = layer["t"]
            if thickness <= 0:      # a layer set to zero is left out on purpose
                continue
            for piece in cut(poly, cutter):
                solid = trimesh.creation.extrude_polygon(piece, thickness)
                solid.apply_translation((0.0, 0.0, z))
                yield solid, layer.get("g")
            z += thickness


def wall_solids(wall_polys, wall_height, cutter, wall_stack=None):
    """The frame, either as one solid or as a stack of coloured layers.

    Printing the frame from thin layers of the palette's own filaments saves
    dedicating a whole colour to it; the mix reads as a dark edge.
    """
    layers = wall_stack or [{"t": wall_height, "g": None}]
    for wall in wall_polys:
        z = 0.0
        for layer in layers:
            thickness = layer["t"]
            if thickness <= 0:
                continue
            for piece in cut(wall, cutter):
                solid = trimesh.creation.extrude_polygon(piece, thickness)
                solid.apply_translation((0.0, 0.0, z))
                yield solid, layer.get("g")
            z += thickness


def build_meshes(wall_polys, region_polys, wall_height, stacks, cutter=None,
                 wall_stack=None):
    meshes = [solid for solid, _ in wall_solids(wall_polys, wall_height, cutter, wall_stack)]
    n_walls = len(meshes)
    n_layers = 0
    for solid, _ in region_solids(region_polys, stacks, cutter):
        meshes.append(solid)
        n_layers += 1
    n_regions = sum(1 for s in stacks if any(layer["t"] > 0 for layer in s))
    return meshes, n_walls, n_regions, n_layers


def safe_name(name):
    """A group label reduced to something safe to use as a file name."""
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", str(name)).strip("-.")
    return cleaned or "group"


def colour_buckets(wall_polys, region_polys, wall_height, stacks, cutter, wall_stack):
    """Every solid, gathered under the colour group that prints it.

    A layered frame has its slabs filed under their own colours; a plain frame
    keeps a group of its own.
    """
    buckets = defaultdict(list)
    n_walls = 0
    for solid, group in wall_solids(wall_polys, wall_height, cutter, wall_stack):
        buckets[group or "walls"].append(solid)
        n_walls += 1
    n_regions = 0
    for solid, group in region_solids(region_polys, stacks, cutter):
        buckets[group or "ungrouped"].append(solid)
        n_regions += 1

    merged = [(label, trimesh.util.concatenate(buckets[label]), len(buckets[label]))
              for label in sorted(buckets)]
    return merged, n_walls, n_regions


def write_group_files(outdir, wall_polys, region_polys, wall_height, stacks,
                      cutter=None, wall_stack=None):
    """One STL per colour group, written side by side."""
    merged, n_walls, n_regions = colour_buckets(
        wall_polys, region_polys, wall_height, stacks, cutter, wall_stack)
    os.makedirs(outdir, exist_ok=True)
    written = []
    for label, mesh, count in merged:
        name = f"{safe_name(label)}.stl"
        mesh.export(os.path.join(outdir, name))
        written.append({"file": name, "solids": count,
                        "triangles": int(len(mesh.faces))})
    return written, n_walls, n_regions


def write_project_3mf(path, wall_polys, region_polys, wall_height, stacks,
                      cutter=None, wall_stack=None):
    """Every colour as its own part of one 3MF, with an extruder each."""
    merged, n_walls, n_regions = colour_buckets(
        wall_polys, region_polys, wall_height, stacks, cutter, wall_stack)
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


def _mesh_model(object_id, mesh):
    verts = "".join(
        f'<vertex x="{_num(x)}" y="{_num(y)}" z="{_num(z)}"/>'
        for x, y, z in mesh.vertices
    )
    tris = "".join(
        f'<triangle v1="{a}" v2="{b}" v3="{c}"/>' for a, b, c in mesh.faces
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<model unit="millimeter" xml:lang="en-US" {MODEL_NS}>\n'
        ' <metadata name="BambuStudio:3mfVersion">1</metadata>\n'
        ' <resources>\n'
        f'  <object id="{object_id}" p:UUID="{uuid.uuid4()}" type="model">\n'
        f'   <mesh><vertices>{verts}</vertices><triangles>{tris}</triangles></mesh>\n'
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


def ring_json(coords):
    return [[round(x, 4), round(y, 4)] for x, y in coords]


def polygon_json(poly):
    return {
        "exterior": ring_json(poly.exterior.coords),
        "holes": [ring_json(r.coords) for r in poly.interiors],
    }


def load_map(path, what):
    """A JSON object (or array) of per-region values, keyed by region id."""
    if not path:
        return {}
    try:
        with open(path) as fp:
            raw = json.load(fp)
    except (OSError, ValueError) as exc:
        raise ConvertError(f"could not read the {what} assignments: {exc}") from None
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
    ap.add_argument("--groups", default=None, metavar="FILE",
                    help="JSON file mapping region id to a colour group; makes "
                         "the output a directory holding one STL per group")
    ap.add_argument("--holes", default=None, metavar="FILE",
                    help='JSON list of mounting holes, e.g. [{"x":0,"y":0,"d":4}]')
    ap.add_argument("--layers", default=None,
                    help="comma-separated layer names to use (default: all)")
    ap.add_argument("--wall-width", type=float, default=1.0)
    ap.add_argument("--wall-height", type=float, default=2.0)
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
    args = ap.parse_args()

    positive("sagitta", args.sagitta)
    positive("scale", args.scale)

    if args.inspect:
        json.dump(inspect(args.input, args.sagitta, args.scale), sys.stdout)
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

    layers = None
    if args.layers:
        layers = {name for name in args.layers.split(",") if name}

    holes = []
    if args.holes:
        try:
            with open(args.holes) as fp:
                holes = json.load(fp)
        except (OSError, ValueError) as exc:
            raise ConvertError(f"could not read the holes: {exc}") from None
        if not isinstance(holes, list):
            raise ConvertError("holes must be a JSON array")
    cutter = hole_cutter(holes)

    curves, used, skipped = read_curves(args.input, args.sagitta, layers, args.scale)
    wall_polys, region_polys = plan_regions(curves, args.wall_width, args.wall_overlap)
    summary = {
        "curves": len(curves),
        "layers": [{"name": n, "entities": c} for n, c in sorted(used.items())],
        "skipped": [{"type": t, "count": c} for t, c in sorted(skipped.items())],
    }

    if args.regions:
        # area and centroid describe the whole face, not the cut pieces, so
        # they stay put as holes are added and removed.
        json.dump({
            **summary,
            "wallHeight": args.wall_height,
            "walls": [polygon_json(p) for w in wall_polys for p in cut(w, cutter)],
            "regions": [
                {"id": i, "area": round(p.area, 4),
                 "centroid": [round(p.centroid.x, 4), round(p.centroid.y, 4)],
                 "parts": [polygon_json(q) for q in cut(p, cutter)]}
                for i, p in enumerate(region_polys)
            ],
        }, sys.stdout)
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

    rng = random.Random(args.seed)
    stacks = region_stacks(
        len(region_polys), args.region_min, args.region_max, args.region_step, rng,
        assigned, groups, explicit,
    )

    if args.output and args.output.lower().endswith(".3mf"):
        files, n_walls, n_regions = write_project_3mf(
            args.output, wall_polys, region_polys, args.wall_height, stacks, cutter,
            wall_stack,
        )
        json.dump({**summary, "files": files, "holes": len(holes),
                   "walls": n_walls, "regions": n_regions}, sys.stdout)
        return

    if args.split or args.groups:
        files, n_walls, n_regions = write_group_files(
            args.output, wall_polys, region_polys, args.wall_height, stacks, cutter,
            wall_stack,
        )
        json.dump({**summary, "files": files, "holes": len(holes),
                   "walls": n_walls, "regions": n_regions}, sys.stdout)
        return

    meshes, n_walls, n_regions, n_layers = build_meshes(
        wall_polys, region_polys, args.wall_height, stacks, cutter, wall_stack,
    )

    solid = trimesh.util.concatenate(meshes)
    solid.export(args.output)

    lo, hi = solid.bounds
    json.dump({
        **summary,
        "walls": n_walls,
        "regions": n_regions,
        "slabs": n_layers,        # "layers" already names the drawing's layers
        "assigned": len(assigned) + len(explicit),
        "holes": len(holes),
        "triangles": int(len(solid.faces)),
        "size": [round(float(hi[i] - lo[i]), 3) for i in range(3)],
    }, sys.stdout)


if __name__ == "__main__":
    try:
        main()
    except ConvertError as exc:
        print(exc, file=sys.stderr)
        raise SystemExit(1)
