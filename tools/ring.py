"""Wrap flat artwork onto the outer surface of a revolved ring profile."""
import math
import numpy as np
import trimesh
import manifold3d as mf

from cylinder import clip_x, cylinder_extrude, manifold, mesh_of, printable_mesh, union

RING_SEGMENTS = 128
EMBED = 0.05
SEAM_OVERLAP = 0.05  # mm — same small overlap used by cylinder mode

ring_extrude = cylinder_extrude


# ---------------------------------------------------------------------------
# Profile geometry helpers

def compute_outer_radius_profile(profile_poly, offset, n_samples=64):
    """Sample the outer radius of the revolved ring at each axial height.

    Returns (z_values, r_outer_values) as numpy arrays.  z_values run from
    y_min to y_max of the profile; r_outer_values are the maximum radial
    distance from the ring axis at each height.
    """
    from shapely.geometry import LineString

    minx, miny, maxx, maxy = profile_poly.bounds
    z_vals = np.linspace(miny, maxy, n_samples)
    r_vals = []
    for z in z_vals:
        line = LineString([(minx - 1, z), (maxx + 1, z)])
        isect = profile_poly.intersection(line)
        xs = []
        if not isect.is_empty:
            if isect.geom_type in ("LineString", "LinearRing"):
                xs = [c[0] for c in isect.coords]
            elif isect.geom_type == "MultiLineString":
                xs = [c[0] for g in isect.geoms for c in g.coords]
            elif isect.geom_type == "Point":
                xs = [isect.x]
            elif isect.geom_type == "MultiPoint":
                xs = [p.x for p in isect.geoms]
        r_vals.append(offset + max(xs) if xs else offset)
    return z_vals, np.array(r_vals)


def load_ring_info(ring_settings, sagitta):
    """Return geometry info for the ring from settings.

    ring_settings keys:
      profilePath  – DXF/SVG of the ring cross-section
      offset       – radial distance from the ring axis to the profile's inner
                     edge (mm); default 9
      repeatX      – number of artwork copies around the ring; default 1
    """
    from dxf2stl import load_profile

    profile_path = ring_settings["profilePath"]
    offset = float(ring_settings.get("offset", 9.0))

    # load_profile positions the profile with x_min = 0, y_min = 0.
    profile_poly = load_profile(profile_path, sagitta)
    minx, miny, maxx, maxy = profile_poly.bounds

    z_profile, r_profile = compute_outer_radius_profile(profile_poly, offset)

    return {
        "profile_poly": profile_poly,
        "offset": offset,
        "r_outer": float(offset + (maxx - minx)),
        "r_inner": float(offset),
        "y_min": float(miny),
        "y_max": float(maxy),
        "ring_height": float(maxy - miny),
        "z_profile": z_profile.tolist(),
        "r_profile": r_profile.tolist(),
    }


def build_ring_shell(ring_info):
    """Revolve the ring profile around the Y-axis to create a closed shell."""
    from shapely.affinity import translate as aff_translate

    profile_poly = ring_info["profile_poly"]
    offset = ring_info["offset"]

    # Shift the profile outward so its inner edge sits at the requested offset.
    poly = aff_translate(profile_poly, xoff=offset)

    exterior = list(poly.exterior.coords)[:-1]
    holes = [list(r.coords)[:-1] for r in poly.interiors]
    cs = mf.CrossSection([exterior] + holes, mf.FillRule.EvenOdd)

    # revolve() rotates around the Y-axis; Y becomes Z in the result.
    return mf.Manifold.revolve(cs, RING_SEGMENTS)


def ring_shell_info(ring_settings, sagitta):
    """Build the ring shell and return (trimesh.Trimesh, info_dict)."""
    ring_info = load_ring_info(ring_settings, sagitta)
    shell_manifold = build_ring_shell(ring_info)
    shell_mesh = mesh_of(shell_manifold)
    info = {k: v for k, v in ring_info.items() if k != "profile_poly"}
    return shell_mesh, info


# ---------------------------------------------------------------------------
# Artwork wrapping

def _wrap_half(half_solid, ring_info, x0, x1, y0_art, y1_art):
    """Bend one half-turn of the flat relief onto the ring surface.

    The full artwork (x0..x1) maps to slightly more than one full revolution
    (2π + seam/r_outer), centred at angle=π (front of ring) so the seam sits
    at angle=0 (back).  Each vertex radius follows the ring's actual outer
    surface r(z) rather than a flat cylinder, ensuring contact everywhere.
    """
    width = x1 - x0
    height_art = y1_art - y0_art
    y_min = ring_info["y_min"]
    ring_height = ring_info["ring_height"]
    r_outer = ring_info["r_outer"]
    z_profile = np.array(ring_info["z_profile"])
    r_profile = np.array(ring_info["r_profile"])

    full_angle = 2 * math.pi + SEAM_OVERLAP / r_outer

    data = half_solid.to_mesh64()
    triangles = data.vert_properties[:, :3][data.tri_verts]
    dx = width / RING_SEGMENTS
    output = []
    for tri in triangles:
        first = max(0, min(RING_SEGMENTS - 1, math.floor((tri[:, 0].min() - x0) / dx)))
        last = max(0, min(RING_SEGMENTS - 1, math.floor((tri[:, 0].max() - x0) / dx)))
        for i in range(first, last + 1):
            poly = clip_x(
                clip_x(list(tri), x0 + i * dx if i else -math.inf, True),
                x0 + (i + 1) * dx if i < RING_SEGMENTS - 1 else math.inf, False,
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
    angle = ((v[:, 0] - x0) / width - 0.5) * full_angle + math.pi
    z_ring = y_min + (v[:, 1] - y0_art) / height_art * ring_height

    # Profile-following radius: embed EMBED mm inside the ring's outer surface
    # at each axial height, so the artwork always fuses with the shell.
    r_at_z = np.interp(z_ring, z_profile, r_profile)
    radius = r_at_z - EMBED + v[:, 2]

    cx, cy = np.cos(angle), np.sin(angle)
    cx[np.abs(cx) < 1e-12] = 0
    cy[np.abs(cy) < 1e-12] = 0
    mesh.vertices = np.column_stack((radius * cx, radius * cy, z_ring))
    return manifold(mesh)


def wrap_solid(solid, ring_info, bounds):
    """Map one flat relief solid onto the outer surface of the ring.

    `bounds` is [x0, y0, x1, y1] — the TOTAL flat bounds covering all artwork
    repeats, so repeated tiles map to equal angular slices of the ring.
    """
    x0, y0, x1, y1 = bounds

    if min(x1 - x0, y1 - y0) <= 1e-8:
        raise ValueError("The relief must have positive width and height")

    halves = []
    for half in solid.split_by_plane((1, 0, 0), (x0 + x1) / 2):
        if half.is_empty():
            continue
        m = _wrap_half(half, ring_info, x0, x1, y0, y1)
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
    tiled = union([
        solid.translate((i * w, 0, 0)) for i in range(repeatX)
    ])
    return tiled, [x0, y0, x0 + repeatX * w, y1]


# ---------------------------------------------------------------------------
# Export

def export_ring(output, buckets, ring_settings, sagitta, split=False):
    """Wrap the colour buckets onto the ring shell and write the STL file(s).

    Returns a stats dict (files list only populated when split=True).
    """
    import os

    flat = [mesh for _, mesh, _ in buckets if len(mesh.faces)]
    if not flat:
        raise ValueError("Generate a non-empty relief before wrapping it")

    repeatX = int(ring_settings.get("repeatX", 1))
    if not (1 <= repeatX <= 12):
        raise ValueError("Use 1–12 artwork repeats around the ring")

    ring_info = load_ring_info(ring_settings, sagitta)
    shell = build_ring_shell(ring_info)

    # Shared flat bounds for all components (one artwork tile width).
    lo = np.min([m.bounds[0] for m in flat], axis=0)
    hi = np.max([m.bounds[1] for m in flat], axis=0)
    tile_bounds = [lo[0], lo[1], hi[0], hi[1]]

    sources = [
        (label, manifold(mesh).decompose())
        for label, mesh, _ in buckets
        if len(mesh.faces)
    ]
    art = []
    for label, solids in sources:
        wrapped = []
        for s in solids:
            tiled, total_bounds = _tile_solid(s, tile_bounds, repeatX)
            w = wrap_solid(tiled, ring_info, total_bounds)
            if not w.is_empty():
                wrapped.append(w)
        art.append((label, union(wrapped) if wrapped else mf.Manifold()))

    if split:
        os.makedirs(output, exist_ok=True)
        from dxf2stl import safe_name

        solids_list = [("shell", shell)] + [
            (label, s - shell) for label, s in art if not s.is_empty()
        ]
        written = []
        all_meshes = []
        for label, s in solids_list:
            if s.is_empty():
                continue
            mesh = printable_mesh(s)
            name = f"ring-{safe_name(label)}.stl"
            mesh.export(os.path.join(output, name))
            written.append(
                {
                    "file": name,
                    "solids": len(s.decompose()),
                    "triangles": int(len(mesh.faces)),
                }
            )
            all_meshes.append(mesh)
        combined = (
            trimesh.util.concatenate(all_meshes) if all_meshes else trimesh.Trimesh()
        )
        return {
            "files": written,
            "triangles": int(len(combined.faces)),
            "size": np.round(combined.extents, 3).tolist(),
            "ring": True,
        }

    solid = union([shell] + [s for _, s in art if not s.is_empty()])
    if solid.status() != mf.Error.NoError:
        raise ValueError("Could not join the wrapped relief to the ring shell")
    mesh = printable_mesh(solid)
    mesh.export(output)
    return {
        "files": [],
        "triangles": int(len(mesh.faces)),
        "size": np.round(mesh.extents, 3).tolist(),
        "ring": True,
    }


if __name__ == "__main__":
    import argparse, json, sys

    ap = argparse.ArgumentParser(description="Build a ring shell STL from a profile DXF.")
    ap.add_argument("settings", help="Ring settings JSON file (profilePath + offset)")
    ap.add_argument("output", help="Output STL path for the ring shell")
    ap.add_argument("--sagitta", type=float, default=0.02)
    args = ap.parse_args()

    with open(args.settings) as fp:
        ring_settings = json.load(fp)

    shell_mesh, info = ring_shell_info(ring_settings, args.sagitta)
    shell_mesh.export(args.output)
    json.dump(info, sys.stdout)
