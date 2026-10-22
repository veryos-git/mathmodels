"""Wrap flat artwork onto the outer elliptical body of the BIC J26 lighter case.

The lighter case (hgc_requirements_documentation/simple_lighter_case/bicj26.scad)
is a thin elliptical tube. Unlike the ring — a surface of revolution with one
outer radius r(z) per height — the lighter's cross-section is an ellipse, so the
flat artwork is mapped around the ellipse *perimeter by arc length* (uniform
spacing, no bunching on the flat faces) and pushed outward along the local
ellipse normal. Everything else mirrors ring mode: 128 angular strips before
bending, a small seam overlap bonding the ends, and a union with the shell that
OpenSCAD rendered from the SCAD source.
"""
import math

import manifold3d as mf
import numpy as np
import trimesh

from cylinder import (clip_x, cylinder_extrude, fold_strip, manifold, mesh_of,
                      printable_mesh, union)

LIGHTER_SEGMENTS = 128
EMBED = 0.05
SEAM_OVERLAP = 0.05  # mm — same small overlap used by cylinder and ring modes

# Fixed BIC Maxi J26 cavity, straight from bicj26.scad. The case must fit a real
# lighter, so these stay constant; only the wall and height are user controls.
LIGHTER_WIDTH = 25.0
LIGHTER_DEPTH = 14.5
FIT_CLEARANCE = 0.25
EDGE_CHAMFER = 0.4

# Where the pattern's seam (its start/end join) sits on the ellipse, as degrees
# around the perimeter: V1 = +a (right), V2 = -a (left), V3 = +b (top),
# V4 = -b (bottom). The four vertices split the perimeter into equal quarters,
# so a quarter turn (90 deg) steps exactly from one vertex to the next.
VERTEX_DEG = {1: 0.0, 2: 180.0, 3: 90.0, 4: 270.0}


def start_fraction(settings):
    """Seam position as a fraction of the perimeter, from the start controls."""
    base = VERTEX_DEG.get(int(settings.get("startVertex", 1)), 0.0)
    deg = base + float(settings.get("startOffset", 0.0))
    return (deg / 360.0) % 1.0

ellipse_extrude = cylinder_extrude


# ---------------------------------------------------------------------------
# Ellipse geometry

def ellipse_arc_table(a, b, n=512):
    """Cumulative arc length of the ellipse (a, b) over theta in [0, 2*pi].

    Returns (theta[n+1], arclen[n+1]) with arclen monotonic from 0 to the
    perimeter, suitable for inverting arc length back to an angle with
    np.interp. Sampled finely so the inversion is smooth on the flat faces.
    """
    theta = np.linspace(0.0, 2.0 * math.pi, n + 1)
    # ds/dtheta of (a cos t, b sin t) is sqrt((a sin t)^2 + (b cos t)^2).
    ds = np.hypot(a * np.sin(theta), b * np.cos(theta))
    arclen = np.concatenate(([0.0], np.cumsum((ds[1:] + ds[:-1]) * 0.5 * np.diff(theta))))
    return theta, arclen


def lighter_info(settings):
    """Geometry of the lighter's outer elliptical body from its settings.

    settings keys (see lighter.ts / the written lighter.json):
      width, depth   – lighter cavity, fixed to the J26 (mm)
      fit            – clearance per side (mm)
      wall           – shell wall thickness (mm)
      height         – overall case height (mm)
      edgeChamfer    – 45 deg chamfer on the outer top/bottom edges (mm)

    The relief maps onto the straight full-size section between the chamfers,
    where the ellipse is constant, so z0 = edgeChamfer and z1 = height - it.
    """
    width = float(settings.get("width", LIGHTER_WIDTH))
    depth = float(settings.get("depth", LIGHTER_DEPTH))
    fit = float(settings.get("fit", FIT_CLEARANCE))
    wall = float(settings["wall"])
    height = float(settings["height"])
    chamfer = float(settings.get("edgeChamfer", EDGE_CHAMFER))

    a = width / 2.0 + fit + wall
    b = depth / 2.0 + fit + wall
    z0 = chamfer
    z1 = height - chamfer
    if min(a, b) <= 1e-6 or z1 - z0 <= 1e-6:
        raise ValueError("The lighter wall, height and chamfer leave no body to wrap")

    theta, arclen = ellipse_arc_table(a, b)
    return {
        "a": a,
        "b": b,
        "perimeter": float(arclen[-1]),
        "z0": z0,
        "z1": z1,
        "body_height": float(z1 - z0),
        # Seam position around the perimeter (fraction); the wrap and the
        # browser preview both offset the artwork by this.
        "start": start_fraction(settings),
        "theta": theta.tolist(),
        "arclen": arclen.tolist(),
    }


def _ellipse_points(info, frac):
    """Map loop fractions [0, 1) to ellipse points and outward unit normals.

    `frac` is the position around the perimeter; it is taken modulo one full
    loop so the seam overlap (frac slightly past 1) lands back on the start.
    """
    a, b = info["a"], info["b"]
    theta_tab = np.asarray(info["theta"])
    arclen = np.asarray(info["arclen"])
    perimeter = info["perimeter"]

    s = (frac % 1.0) * perimeter
    theta = np.interp(s, arclen, theta_tab)
    px = a * np.cos(theta)
    py = b * np.sin(theta)
    nx = np.cos(theta) / a
    ny = np.sin(theta) / b
    norm = np.hypot(nx, ny)
    return px, py, nx / norm, ny / norm


# ---------------------------------------------------------------------------
# Artwork wrapping (mirrors ring._wrap_half / wrap_solid)

def _wrap_half(half_solid, info, x0, x1, y0_art, y1_art, seam=SEAM_OVERLAP):
    """Bend one half of the flat relief onto the lighter's elliptical body.

    The full artwork (x0..x1) maps to one full loop plus `seam` of overlap,
    centred so the seam sits at the +A side and the middle of the artwork faces
    the -A side (mirroring ring's `+ math.pi`). `seam` is 0 for sketch repeats,
    whose periodic columns already meet after exactly one loop.
    """
    width = x1 - x0
    height_art = y1_art - y0_art
    perimeter = info["perimeter"]
    z0 = info["z0"]
    body_height = info["body_height"]

    data = half_solid.to_mesh64()
    triangles = data.vert_properties[:, :3][data.tri_verts]
    dx = width / LIGHTER_SEGMENTS
    output = []
    for tri in triangles:
        first = max(0, min(LIGHTER_SEGMENTS - 1, math.floor((tri[:, 0].min() - x0) / dx)))
        last = max(0, min(LIGHTER_SEGMENTS - 1, math.floor((tri[:, 0].max() - x0) / dx)))
        for i in range(first, last + 1):
            poly = clip_x(
                clip_x(list(tri), x0 + i * dx if i else -math.inf, True),
                x0 + (i + 1) * dx if i < LIGHTER_SEGMENTS - 1 else math.inf, False,
            )
            for k in range(1, len(poly) - 1):
                output.extend((poly[0], poly[k], poly[k + 1]))

    if not output:
        return None

    mesh = trimesh.Trimesh(
        np.array(output), np.arange(len(output)).reshape(-1, 3), process=True
    )
    mesh.update_faces(
        np.all(np.diff(np.sort(mesh.faces, axis=1), axis=1) != 0, axis=1)
    )
    mesh.remove_unreferenced_vertices()
    if not len(mesh.vertices):
        return None

    v = mesh.vertices
    # Full loop plus a seam's worth of overlap. The seam (the artwork's two
    # ends meeting) sits at `info["start"]` around the perimeter — a chosen
    # vertex plus an offset — so the pattern starts at a known place.
    frac = ((v[:, 0] - x0) / width - 0.5) * (perimeter + seam) / perimeter + 0.5 + info["start"]
    px, py, nx, ny = _ellipse_points(info, frac)
    depth = v[:, 2] - EMBED
    z_ring = z0 + (v[:, 1] - y0_art) / height_art * body_height
    mesh.vertices = np.column_stack((px + depth * nx, py + depth * ny, z_ring))
    return manifold(mesh)


def wrap_solid(solid, info, bounds, middle=None, seam=SEAM_OVERLAP):
    """Map one flat relief solid onto the lighter's elliptical body.

    `bounds` is [x0, y0, x1, y1] — the TOTAL flat bounds covering all repeats.
    `middle` is where the solid is split into two halves (default halfway).
    """
    x0, y0, x1, y1 = bounds
    if min(x1 - x0, y1 - y0) <= 1e-8:
        raise ValueError("The relief must have positive width and height")

    halves = []
    for half in solid.split_by_plane((1, 0, 0), (x0 + x1) / 2 if middle is None else middle):
        if half.is_empty():
            continue
        m = _wrap_half(half, info, x0, x1, y0, y1, seam)
        if m is not None:
            halves.append(m)
    if not halves:
        return mf.Manifold()
    return union(halves)


def _tile_solid(solid, bounds, repeatX):
    """Return the manifold solid with artwork tiled repeatX times in X."""
    if repeatX == 1:
        return solid, bounds
    x0, y0, x1, y1 = bounds
    w = x1 - x0
    tiled = union([solid.translate((i * w, 0, 0)) for i in range(repeatX)])
    return tiled, [x0, y0, x0 + repeatX * w, y1]


def _bucket_sources(buckets):
    return [(label, manifold(mesh).decompose())
            for label, mesh, _ in buckets if len(mesh.faces)]


def _tile_bounds(buckets):
    flat = [mesh for _, mesh, _ in buckets if len(mesh.faces)]
    if not flat:
        raise ValueError("Generate a non-empty relief before wrapping it")
    lo = np.min([m.bounds[0] for m in flat], axis=0)
    hi = np.max([m.bounds[1] for m in flat], axis=0)
    return [lo[0], lo[1], hi[0], hi[1]]


def _wrap_sources(sources, info, tile_bounds, repeatX, tiling, seam=None):
    """Bend every colour bucket onto the lighter body; returns (label, solid).

    Sketch repeats (`tiling`) join their periodic columns flat (seam 0);
    otherwise finished copies are tiled side by side with a bonding overlap.
    """
    if tiling is not None:
        bounds = tiling["bounds"]
        nx, step = tiling["repeatX"], tiling["period"][0]
        middle = bounds[0] + (nx // 2 + 0.5) * step
        turn_seam = 0.0 if seam is None else seam

        def wrap_one(solid):
            strip = union([solid.translate((ix * step, 0, 0)) for ix in range(nx)])
            return union([wrap_solid(piece, info, bounds, middle=middle, seam=turn_seam)
                          for piece in fold_strip(strip, bounds[0], bounds[2])])
    else:
        turn_seam = SEAM_OVERLAP if seam is None else seam

        def wrap_one(solid):
            tiled, total_bounds = _tile_solid(solid, tile_bounds, repeatX)
            return wrap_solid(tiled, info, total_bounds, seam=turn_seam)

    art = []
    for label, solids in sources:
        wrapped = [w for w in (wrap_one(s) for s in solids) if not w.is_empty()]
        art.append((label, union(wrapped) if wrapped else mf.Manifold()))
    return art


# ---------------------------------------------------------------------------
# Export

def export_lighter(output, buckets, settings, split=False, tiling=None):
    """Wrap the colour buckets onto the lighter shell and write the STL file(s).

    The shell is the OpenSCAD render of bicj26.scad, written by the HTTP
    backend to `settings["bodyPath"]`. With sketch repeats (`tiling`) the
    periodic columns meet after exactly one loop; without it, finished copies
    sit side by side. Mirrors ring.export_ring.
    """
    import os

    repeatX = int(settings.get("repeatX", 1))
    if not (1 <= repeatX <= 12):
        raise ValueError("Use 1–12 artwork repeats around the lighter")

    info = lighter_info(settings)
    shell = manifold(trimesh.load_mesh(settings["bodyPath"]))
    tile_bounds = _tile_bounds(buckets)
    sources = _bucket_sources(buckets)

    # Wrapping the exact column join (seam 0) can trip the boolean when the seam
    # lands on an awkward spot of the ellipse — which the start offset can do.
    # A tiny bonded seam resolves it; try the clean join first, then the bond.
    seams = [None, SEAM_OVERLAP] if tiling is not None else [None]
    errors = []

    def attempt(seam):
        art = _wrap_sources(sources, info, tile_bounds, repeatX, tiling, seam=seam)
        if split:
            os.makedirs(output, exist_ok=True)
            from dxf2stl import safe_name

            solids_list = [("shell", shell)] + [
                (label, s - shell) for label, s in art if not s.is_empty()
            ]
            written, all_meshes = [], []
            for label, s in solids_list:
                if s.is_empty():
                    continue
                mesh = printable_mesh(s)
                name = f"lighter-{safe_name(label)}.stl"
                mesh.export(os.path.join(output, name))
                written.append({"file": name, "solids": len(s.decompose()),
                                "triangles": int(len(mesh.faces))})
                all_meshes.append(mesh)
            combined = trimesh.util.concatenate(all_meshes) if all_meshes else trimesh.Trimesh()
            return {"files": written, "triangles": int(len(combined.faces)),
                    "size": np.round(combined.extents, 3).tolist(), "lighter": True}

        solid = union([shell] + [s for _, s in art if not s.is_empty()])
        if solid.status() != mf.Error.NoError:
            raise ValueError("Could not join the wrapped relief to the lighter shell")
        mesh = printable_mesh(solid)
        mesh.export(output)
        return {"files": [], "triangles": int(len(mesh.faces)),
                "size": np.round(mesh.extents, 3).tolist(), "lighter": True}

    for seam in seams:
        try:
            return attempt(seam)
        except (ValueError, RuntimeError) as error:
            errors.append(error)
    raise errors[-1]


if __name__ == "__main__":
    import argparse, json, sys

    ap = argparse.ArgumentParser(description="Report lighter body geometry as JSON.")
    ap.add_argument("settings", help="Lighter settings JSON (wall, height, …)")
    ap.add_argument("output", nargs="?", help="Unused; kept for a ring-like call shape")
    args = ap.parse_args()

    with open(args.settings) as fp:
        settings = json.load(fp)
    json.dump(lighter_info(settings), sys.stdout)
