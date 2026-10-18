"""Wrap closed relief solids onto an OpenSCAD shell, with a printable lid split.

Cut into angular strips before bending: simply moving a triangle's corners
would turn a large flat face into a chord through the cylinder. Manifold caps
the lid and half-turn cuts. Small overlaps bond neighbouring artwork repeats.
"""
import math
import os

import manifold3d as mf
import numpy as np
import trimesh

SEGMENTS = 128
EMBED = 0.05
SEAM_OVERLAP = 0.05


def cylinder_extrude(poly, height):
    # Near-collinear vertices from buffered path intersections can create
    # zero-area caps in Earcut. Bending makes those caps overlap. Simplify
    # below drawing precision and use Manifold's polygon extrusion instead.
    poly = poly.simplify(1e-7, preserve_topology=True)
    contours = [list(poly.exterior.coords)[:-1]] + [list(r.coords)[:-1] for r in poly.interiors]
    solid = mf.CrossSection(contours, mf.FillRule.EvenOdd).extrude(height)
    data = solid.to_mesh64()
    return trimesh.Trimesh(data.vert_properties[:, :3], data.tri_verts, process=False)


def manifold(mesh):
    mesh = mesh.copy()
    mesh.merge_vertices()
    result = mf.Manifold(mf.Mesh64(np.asarray(mesh.vertices, dtype=np.float64),
                                 np.asarray(mesh.faces, dtype=np.uint32)))
    if result.status() != mf.Error.NoError:
        raise ValueError("Cylinder wrapping requires closed relief meshes")
    return result


def mesh_of(solid):
    data = solid.to_mesh64()
    # STL stores float32. Weld at that precision now, then remove triangles
    # whose vertices coincide; doing this only on reload leaves zero-area
    # boolean slivers that look like non-manifold edges to a slicer.
    mesh = trimesh.Trimesh(np.asarray(data.vert_properties[:, :3], dtype=np.float32),
                          data.tri_verts, process=True)
    mesh.update_faces(np.all(np.diff(np.sort(mesh.faces, axis=1), axis=1) != 0, axis=1))
    mesh.update_faces(mesh.unique_faces())
    mesh.remove_unreferenced_vertices()
    return mesh


def union(solids):
    return mf.Manifold.batch_boolean(solids, mf.OpType.Add)


def dimensions(c):
    if c['lid'] and c.get('threaded') and c.get('threadedDesign'):
        d = c['threadedDesign']
        shoulder = c['height']-c['neck']+d['stop']
        return shoulder, shoulder+d['lidHeight']
    shoulder = c["height"] - c["neck"] if c["lid"] else c["height"]
    height = c["height"] + 0.2 + c["lidTop"] if c["lid"] else c["height"]
    return shoulder, height


def bevels(c, part):
    d = c.get('threadedDesign') if c['lid'] and c.get('threaded') else None
    if not d:
        return []
    shoulder, height = dimensions(c)
    base = c['height']-c['neck']
    return ([d['baseBottomChamfer'], base-d['baseTopChamfer'], base] if part == 'body'
            else [shoulder+d['lidBottomChamfer'], height-d['lidTopChamfer']])


def surface_inset(z, c, part):
    d = c.get('threadedDesign') if c['lid'] and c.get('threaded') else None
    if not d:
        return 0
    shoulder, height = dimensions(c)
    base = c['height']-c['neck']
    if part == 'body':
        return np.maximum(0, np.maximum(d['baseBottomChamfer']-z,
                          np.minimum(d['baseTopChamfer'], z-(base-d['baseTopChamfer']))))
    return np.maximum(0, np.maximum(d['lidBottomChamfer']-(z-shoulder),
                                    d['lidTopChamfer']-(height-z)))


def clip_x(poly, value, greater, axis=0):
    """Clip a triangle/polygon without simplifying shared boundary edges."""
    output = []
    for a, b in zip(poly, poly[1:]+poly[:1]):
        da = (a[axis]-value)*(1 if greater else -1)
        db = (b[axis]-value)*(1 if greater else -1)
        if da >= 0:
            output.append(a)
        if da < 0 < db or db < 0 < da:
            point = a + da/(da-db)*(b-a)
            point[axis] = value
            output.append(point)
    return output


def bevel_bands(poly, levels):
    if len(poly) < 3:
        return []
    bands = [poly]
    for y in levels:
        split = []
        for p in bands:
            if min(v[1] for v in p) < y < max(v[1] for v in p):
                split.extend([clip_x(p, y, False, 1), clip_x(p, y, True, 1)])
            else:
                split.append(p)
        bands = split
    return bands


def wrap_solid(solid, bounds, c, part):
    nx, ny = c.get('repeatX', 1), c.get('repeatY', 1)
    if any(type(n) is not int or not 1 <= n <= 12 for n in (nx, ny)) or nx*ny > 64:
        raise ValueError("Use 1–12 repeats per direction, with at most 64 copies")
    x0, y0, x1, y1 = bounds
    width, height = x1-x0, y1-y0
    if min(width, height) <= 1e-8:
        raise ValueError("The relief must have positive width and height")
    # A tiny overlap bonds tips at every tile boundary. Include it in the
    # uniform-scale sizing calculation in static/cylinder.js as well.
    sx = (math.pi*c['diameter']+nx*SEAM_OVERLAP)/(nx*width)
    sy = (dimensions(c)[1]+(ny-1)*SEAM_OVERLAP)/(ny*height)
    step_x, step_y = width-SEAM_OVERLAP/sx, height-SEAM_OVERLAP/sy
    tiled_bounds = [x0, y0, x0+width+(nx-1)*step_x, y0+height+(ny-1)*step_y]
    return union([_wrap_tile(solid.translate((ix*step_x, iy*step_y, 0)), tiled_bounds, c, part)
                  for ix in range(nx) for iy in range(ny)])


def _wrap_tile(solid, bounds, c, part):
    x0, y0, x1, y1 = bounds
    width, height = x1-x0, y1-y0
    if min(width, height) <= 1e-8:
        raise ValueError("The relief must have positive width and height")
    shoulder, assembled_height = dimensions(c)
    levels = [y0+z/assembled_height*height for z in bevels(c, part)]
    if c["lid"]:
        split = shoulder + (c["seamGap"]/2 if part == "lid" else -c["seamGap"]/2)
        cut = y0 + split / assembled_height * height
        upper, lower = solid.split_by_plane((0, 1, 0), cut)
        solid = upper if part == "lid" else lower
    if solid.is_empty():
        return solid

    # Preserve connectivity through subdivision. Boolean-unioning 128 bent
    # strips creates coincident cap faces on swept profiles. Only split the
    # two half-turns into closed solids; subdivide their existing triangles.
    halves = []
    for half in solid.split_by_plane((1, 0, 0), (x0+x1)/2):
        if half.is_empty():
            continue
        data = half.to_mesh64()
        triangles = data.vert_properties[:, :3][data.tri_verts]
        dx = width/SEGMENTS
        output = []
        for triangle in triangles:
            first = max(0, min(SEGMENTS-1, math.floor((triangle[:, 0].min()-x0)/dx)))
            last = max(0, min(SEGMENTS-1, math.floor((triangle[:, 0].max()-x0)/dx)))
            for i in range(first, last+1):
                poly = clip_x(clip_x(list(triangle), x0+i*dx, True), x0+(i+1)*dx, False)
                for band in bevel_bands(poly, levels):
                    for k in range(1, len(band)-1):
                        output.extend((band[0], band[k], band[k+1]))
        mesh = trimesh.Trimesh(np.array(output), np.arange(len(output)).reshape(-1, 3), process=True)
        mesh.update_faces(np.all(np.diff(np.sort(mesh.faces, axis=1), axis=1) != 0, axis=1))
        mesh.remove_unreferenced_vertices()
        vertices = mesh.vertices
        # A small overlap avoids a non-manifold edge where a drawing's two
        # outer tips would otherwise merely touch after one complete turn.
        angle = ((vertices[:, 0]-x0)/width-.5)*(2*math.pi+SEAM_OVERLAP/(c["diameter"]/2))+math.pi
        z = (vertices[:, 1]-y0)/height*assembled_height
        radius = c["diameter"]/2-surface_inset(z, c, part)-EMBED+vertices[:, 2]
        cx, cy = np.cos(angle), np.sin(angle)
        # The shared half-turn caps must lie in exactly the same plane.
        cx[np.abs(cx) < 1e-12] = 0
        cy[np.abs(cy) < 1e-12] = 0
        mesh.vertices = np.column_stack((radius*cx, radius*cy,
                                         z))
        halves.append(manifold(mesh))
    return union(halves)


def print_position(solid, c, part, gap, decorated=False):
    if part == "body":
        return solid
    if decorated:
        # Keep raised top details facing upwards and the lid's opening on the
        # bed. Apply this same placement to the shell and every colour part.
        return solid.translate((gap, 0, -dimensions(c)[0]))
    _, height = dimensions(c)
    # The lid prints roof-down, open side up. Both the shell and all colours
    # receive exactly this transform, preserving their registration.
    return solid.rotate((180, 0, 0)).translate((gap, 0, height))


def export_cylinder(output, buckets, c, split=False, lid_art=None):
    flat = [mesh for _, mesh, _ in buckets if len(mesh.faces)]
    if not flat:
        raise ValueError("Generate a non-empty relief before wrapping it")
    lo = np.min([m.bounds[0] for m in flat], axis=0)
    hi = np.max([m.bounds[1] for m in flat], axis=0)
    bounds = [lo[0], lo[1], hi[0], hi[1]]
    if lo[2] < -EMBED:
        raise ValueError("Cylinder relief must lie above its base plane")
    gap = c["diameter"] + 2*max(0, hi[2]) + 10
    # Frame bands can share a colour with faces and intentionally overlap.
    # Bend their original closed components independently, as the preview does,
    # and resolve overlaps afterwards. Pre-union creates cap slivers that can
    # invert when bent; bending an overlapping concatenation is invalid too.
    sources = [(label, manifold(mesh).decompose()) for label, mesh, _ in buckets if len(mesh.faces)]
    parts = [("body", manifold(trimesh.load_mesh(c["bodyPath"])))]
    if lid_art is not None and not c['lid']:
        raise ValueError("A lid-top sketch requires Add lid")
    if c["lid"]:
        parts.append(("lid", manifold(trimesh.load_mesh(c["lidPath"]))))
    all_meshes, written = [], []
    if split:
        os.makedirs(output, exist_ok=True)
    for part, shell in parts:
        art = [(label, union([wrap_solid(solid, bounds, c, part) for solid in solids]))
               for label, solids in sources]
        if part == 'lid' and lid_art is not None:
            art.append(('top-art', manifold(lid_art)))
        if split:
            from dxf2stl import safe_name
            # Remove the small bonding overlap from colour volumes; the shell
            # fills that volume. Each file is a closed, registered solid.
            solids = [("shell", shell)] + [(label, solid-shell) for label, solid in art]
            for label, solid in solids:
                if solid.is_empty():
                    continue
                mesh = mesh_of(print_position(solid, c, part, gap, lid_art is not None))
                name = f"{part}-{safe_name(label)}.stl"
                mesh.export(os.path.join(output, name))
                written.append({"file": name, "solids": len(solid.decompose()), "triangles": len(mesh.faces)})
                all_meshes.append(mesh)
        else:
            solid = union([shell] + [s for _, s in art])
            if solid.status() != mf.Error.NoError:
                raise ValueError("Could not join the wrapped relief to the shell")
            all_meshes.append(mesh_of(print_position(solid, c, part, gap, lid_art is not None)))
    combined = trimesh.util.concatenate(all_meshes)
    if not combined.is_watertight or not combined.is_winding_consistent:
        raise ValueError("The wrapped export did not form closed printable parts")
    if not split:
        combined.export(output)
    return {"files": written, "triangles": len(combined.faces),
            "size": np.round(combined.extents, 3).tolist(),
            "cylinder": True, "parts": len(parts)}
