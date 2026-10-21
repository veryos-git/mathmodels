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


def printable_mesh(solid):
    """Keep closed solid topology when STL welding collapses tiny contacts.

    A boolean can keep two surfaces as separate vertex fans at one edge.
    STL loses that distinction: a slicer welds the equal coordinates into a
    four-face edge. Only when conversion fails, simplify below a micron and
    join those contacts with a local, sub-micron overlap. Grazing junctions
    can keep producing new contacts; then merge details below 1 µm, and then
    10 µm, both far under print resolution. Do not fill holes in an invalid
    input or discard small, real disconnected solids.
    """
    if solid.status() != mf.Error.NoError or solid.is_empty():
        raise ValueError("The wrapped export did not form closed printable parts")
    for detail in (None, .001, .01):
        mesh = _closed_mesh(solid if detail is None else solid.simplify(detail))
        if mesh is not None:
            return mesh
    raise ValueError("The wrapped export did not form closed printable parts")


def _closed_mesh(solid):
    mesh = mesh_of(solid)
    if mesh.is_volume:
        return mesh
    # Several float32 ULPs, with a 0.1 micron floor in model millimetres.
    tolerance = max(.0001, np.max(np.abs(mesh.vertices))*2**-21)
    solid = solid.simplify(tolerance)
    for attempt in range(3):
        mesh = mesh_of(solid)
        pieces = []
        for piece in mesh.split(only_watertight=False, repair=False):
            local = piece.copy()
            local.apply_translation(-local.vertices.mean(axis=0))
            if not piece.is_watertight and np.linalg.matrix_rank(local.vertices, tol=1e-7) < 3:
                continue  # A collapsed boolean sliver left a planar scrap.
            if piece.is_watertight and abs(local.volume) <= tolerance*local.area:
                continue  # Thinner on average than the tolerance: a flat sliver.
            pieces.append(piece)
        if not pieces:
            break
        mesh = trimesh.util.concatenate(pieces)
        mesh.merge_vertices()
        if mesh.is_volume:
            return mesh
        edges, counts = np.unique(mesh.edges_sorted, axis=0, return_counts=True)
        contacts = edges[counts > 2]
        if attempt == 2 or not len(contacts) or np.any(counts % 2):
            break  # Open contours are not edge contacts; keep the validation.
        overlaps = []
        for a, b in mesh.vertices[contacts]:
            direction = b-a
            length = np.linalg.norm(direction)
            direction /= length
            side = np.cross(direction, [1, 0, 0] if abs(direction[0]) < .9 else [0, 1, 0])
            side /= np.linalg.norm(side)
            transform = np.column_stack((side, np.cross(direction, side), direction,
                                         a-direction*tolerance))
            overlaps.append(mf.Manifold.cylinder(length+2*tolerance, tolerance,
                                                 tolerance, 8).transform(transform))
        solid = union([solid, *overlaps]).simplify(tolerance)
    return None


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
    if not c['lid']:
        top = c.get('topChamfer', 0)
        return [c['height']-top] if top > 0 else []
    d = c.get('threadedDesign') if c['lid'] and c.get('threaded') else None
    if not d:
        return []
    shoulder, height = dimensions(c)
    base = c['height']-c['neck']
    return ([d['baseBottomChamfer'], base-d['baseTopChamfer'], base] if part == 'body'
            else [shoulder+d['lidBottomChamfer'], height-d['lidTopChamfer']])


def surface_inset(z, c, part):
    if not c['lid']:
        top = c.get('topChamfer', 0)
        return np.clip(z-c['height']+top, 0, top)
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


def repeat_counts(c):
    nx, ny = c.get('repeatX', 1), c.get('repeatY', 1)
    if any(type(n) is not int or not 1 <= n <= 12 for n in (nx, ny)) or nx*ny > 64:
        raise ValueError("Use 1–12 repeats per direction, with at most 64 copies")
    return nx, ny


def fold_strip(solid, x0, x1):
    """Move whatever lies past either end of a full turn onto the other end."""
    lo, hi = solid.bounding_box()[0], solid.bounding_box()[3]
    if lo >= x0-1e-6 and hi <= x1+1e-6:
        return [solid]  # Cutting exactly along an end face would leave slivers.
    width = x1-x0
    pieces = [solid.trim_by_plane((1, 0, 0), x0).trim_by_plane((-1, 0, 0), -x1),
              solid.trim_by_plane((-1, 0, 0), -x0).translate((width, 0, 0)),
              solid.trim_by_plane((1, 0, 0), x1).translate((-width, 0, 0))]
    return [piece for piece in pieces if not piece.is_empty()]


def wrap_solid(solid, bounds, c, part):
    """First sweep then repeat: copies of the finished relief, bonded at their tips."""
    nx, ny = repeat_counts(c)
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


def _wrap_tile(solid, bounds, c, part, seam=SEAM_OVERLAP, middle=None):
    """Bend one closed solid; `bounds` map to a full turn and the shell height.

    `seam` stretches the turn so its ends overlap; `middle` is where the
    solid is split into two half-turns, by default halfway along.
    """
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
    for half in solid.split_by_plane((1, 0, 0), (x0+x1)/2 if middle is None else middle):
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
                # The outer strips also keep rounding just past the bounds.
                poly = clip_x(clip_x(list(triangle), x0+i*dx if i else -math.inf, True),
                              x0+(i+1)*dx if i < SEGMENTS-1 else math.inf, False)
                for band in bevel_bands(poly, levels):
                    for k in range(1, len(band)-1):
                        output.extend((band[0], band[k], band[k+1]))
        mesh = trimesh.Trimesh(np.array(output), np.arange(len(output)).reshape(-1, 3), process=True)
        mesh.update_faces(np.all(np.diff(np.sort(mesh.faces, axis=1), axis=1) != 0, axis=1))
        mesh.remove_unreferenced_vertices()
        vertices = mesh.vertices
        # A small overlap avoids a non-manifold edge where a drawing's two
        # outer tips would otherwise merely touch after one complete turn.
        angle = ((vertices[:, 0]-x0)/width-.5)*(2*math.pi+seam/(c["diameter"]/2))+math.pi
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


def export_cylinder(output, buckets, c, split=False, lid_art=None, tiling=None):
    """Wrap the colour buckets onto the shell and write the STL file(s).

    With sketch repeats (`tiling`, from dxf2stl.repeat_sketch) the buckets
    hold one periodic column with every row. Its copies around the shell
    meet at exactly coincident faces, so they are joined flat and the strip
    wraps exactly once, its ends meeting in one plane. Whatever reaches past
    either end continues on the other.
    """
    flat = [mesh for _, mesh, _ in buckets if len(mesh.faces)]
    if not flat:
        raise ValueError("Generate a non-empty relief before wrapping it")
    lo = np.min([m.bounds[0] for m in flat], axis=0)
    hi = np.max([m.bounds[1] for m in flat], axis=0)
    bounds = [lo[0], lo[1], hi[0], hi[1]] if tiling is None else tiling["bounds"]

    def wrap(solid, part):
        if tiling is None:
            return wrap_solid(solid, bounds, c, part)
        nx, step = tiling["repeatX"], tiling["period"][0]
        strip = union([solid.translate((ix*step, 0, 0)) for ix in range(nx)])
        # Split the turn mid-column, away from the faces where columns meet.
        middle = bounds[0]+(nx//2+.5)*step
        return union([_wrap_tile(piece, bounds, c, part, 0, middle)
                      for piece in fold_strip(strip, bounds[0], bounds[2])])

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
        art = [(label, union([wrap(solid, part) for solid in solids]))
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
                mesh = printable_mesh(print_position(solid, c, part, gap, lid_art is not None))
                name = f"{part}-{safe_name(label)}.stl"
                mesh.export(os.path.join(output, name))
                written.append({"file": name, "solids": len(solid.decompose()), "triangles": len(mesh.faces)})
                all_meshes.append(mesh)
        else:
            solid = union([shell] + [s for _, s in art])
            if solid.status() != mf.Error.NoError:
                raise ValueError("Could not join the wrapped relief to the shell")
            all_meshes.append(printable_mesh(print_position(solid, c, part, gap, lid_art is not None)))
    combined = trimesh.util.concatenate(all_meshes)
    if not combined.is_watertight or not combined.is_winding_consistent:
        raise ValueError("The wrapped export did not form closed printable parts")
    if not split:
        combined.export(output)
    return {"files": written, "triangles": len(combined.faces),
            "size": np.round(combined.extents, 3).tolist(),
            "cylinder": True, "parts": len(parts)}
