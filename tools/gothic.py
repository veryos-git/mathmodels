"""Solid operations for independently profiled tracery and revolved endings."""
import math
import numpy as np
import trimesh
import manifold3d
from shapely import make_valid, set_precision
from shapely.geometry import LineString, Polygon
from shapely.ops import unary_union


def path_frames(chain, miter_limit=4.0):
    """Planar, Z-up sweep frames with mitred corners and square open ends."""
    closed = chain[0] == chain[-1]
    points = np.asarray(chain[:-1] if closed else chain, dtype=float)
    if closed and not Polygon(points).exterior.is_ccw:
        points = points[::-1]
    delta = np.roll(points, -1, axis=0) - points if closed else np.diff(points, axis=0)
    unit = delta / np.maximum(np.linalg.norm(delta, axis=1)[:, None], 1e-12)
    segment_normals = np.column_stack((-unit[:, 1], unit[:, 0]))
    normals = np.zeros_like(points)
    for i in range(len(points)):
        if not closed and i in (0, len(points)-1):
            normals[i] = segment_normals[0 if i == 0 else -1]
            continue
        vector = segment_normals[i-1] + segment_normals[i % len(segment_normals)]
        length = np.linalg.norm(vector)
        normals[i] = (segment_normals[i-1] if length < 1e-6 else
                      vector / length * min(2 / length, miter_limit))
    return points, normals, closed


def stepped_profile_sweep(profile, chains, miter_limit=4.0):
    """Exact height bands for rectilinear mouldings, or None for other profiles.

    A stepped sweep is a stack of planar ribbons. Union each band's ribbons
    before extrusion so tight turns and overlapping paths cannot create
    self-intersecting 3D shells. The profile, not a fixed slicing increment,
    determines every band height and lateral interval.
    """
    coords = np.asarray(profile.exterior.coords)
    edges = np.diff(coords, axis=0)
    if profile.interiors or np.any(np.all(np.abs(edges) > 1e-9, axis=1)):
        return None
    frames = [path_frames(c, miter_limit) for c in chains if len(c) >= 2]
    levels = sorted(set(coords[:, 1]))
    solids = []
    for bottom, top in zip(levels, levels[1:]):
        cross = profile.intersection(LineString([
            (profile.bounds[0]-1, (bottom+top)/2),
            (profile.bounds[2]+1, (bottom+top)/2)]))
        intervals = [cross] if cross.geom_type == 'LineString' else list(cross.geoms)
        ribbons = []
        for interval in intervals:
            left, _, right, _ = interval.bounds
            for points, normals, closed in frames:
                a, b = points + left*normals, points + right*normals
                for i in range(len(points) if closed else len(points)-1):
                    j = (i+1) % len(points)
                    ribbon = make_valid(Polygon([a[i], a[j], b[j], b[i]]))
                    if ribbon.geom_type == 'Polygon':
                        ribbons.append(ribbon)
                    elif hasattr(ribbon, 'geoms'):
                        ribbons.extend(p for p in ribbon.geoms if p.geom_type == 'Polygon')
        # Tangent paths can leave microscopic slivers. Resolve them before
        # triangulation at a precision which survives float32 STL vertices.
        magnitude = max(1.0, max(abs(v) for ribbon in ribbons for v in ribbon.bounds))
        precision = max(1e-6, magnitude * 2**-22)
        footprint = set_precision(unary_union(ribbons), precision).simplify(precision / 4)
        polygons = [footprint] if footprint.geom_type == 'Polygon' else list(footprint.geoms)
        for polygon in polygons:
            if polygon.area <= 1e-10:
                continue
            mesh = trimesh.creation.extrude_polygon(polygon, top-bottom)
            mesh.apply_translation([0, 0, bottom])
            solids.append(mesh)
    return solid_union(solids)


def solid_union(meshes):
    solids = []
    for mesh in meshes:
        mesh = mesh.copy()
        mesh.merge_vertices()
        mesh.fix_normals(multibody=True)
        for part in mesh.split(only_watertight=False):
            part.fix_normals()
            if not part.is_watertight:
                raise ValueError("A swept section is not closed; check for duplicate points or a self-crossing profile")
            if part.volume < 0:
                part.invert()
            if part.volume > 1e-10:
                solids.append(part)
    if not solids:
        raise ValueError("No solid geometry was produced")
    result = trimesh.boolean.union(solids, engine="manifold")
    simplified = manifold3d.Manifold(manifold3d.Mesh(
        vert_properties=np.asarray(result.vertices, dtype=np.float32),
        tri_verts=np.asarray(result.faces, dtype=np.uint32),
    )).simplify(0.0001).to_mesh()
    result = trimesh.Trimesh(vertices=simplified.vert_properties[:, :3],
                             faces=simplified.tri_verts, process=False)
    # STL uses float32 coordinates. Collapse coincident vertices at that
    # precision and discard zero-volume slivers from tangent intersections.
    result.vertices = result.vertices.astype(np.float32).astype(float)
    result.merge_vertices()
    parts = [p for p in result.split(only_watertight=False) if abs(p.volume) > 1e-6]
    if not parts or any(not p.is_watertight for p in parts):
        raise ValueError("The fused geometry is not watertight at STL precision; adjust the cusp width or ending side")
    return trimesh.util.concatenate(parts)


def revolved_ending(profile, point, normal, outward, angle=90, side=1, segments=24):
    """Revolve an end cross-section about its side's vertical axis.

    At zero degrees the section coincides exactly with the sweep end. The
    axis touches the profile's lateral edge; turning 90 degrees rolls the
    moulding around the tip, without approximating it by a spherical cap.
    The opposite side is useful for mirrored or differently oriented paths.
    """
    if not 0 < angle <= 180 or side not in (-1, 1):
        raise ValueError("End angle must be 0–180 degrees and side must be -1 or 1")
    ring = np.asarray(profile.exterior.coords[:-1])
    point, normal, outward = map(lambda p: np.asarray(p, dtype=float), (point, normal, outward))
    radius = -profile.bounds[0] if side == 1 else profile.bounds[2]
    pivot = point - side * radius * normal
    theta = np.linspace(0, math.radians(angle), max(2, segments) + 1)
    verts = []
    for t in theta:
        direction = side * normal * math.cos(t) + outward * math.sin(t)
        for x, z in ring:
            xy = pivot + (radius + side * x) * direction
            verts.append([*xy, z])
    faces = []
    k = len(ring)
    for i in range(len(theta) - 1):
        for j in range(k):
            a, b = i*k+j, i*k+(j+1)%k
            faces.extend([(a, b, b+k), (a, b+k, a+k)])
    cap_v, cap_f = trimesh.creation.triangulate_polygon(profile)
    for t in (theta[0], theta[-1]):
        offset = len(verts)
        direction = side * normal * math.cos(t) + outward * math.sin(t)
        for x, z in cap_v:
            xy = pivot + (radius + side*x) * direction
            verts.append([*xy, z])
        faces.extend((cap_f + offset).tolist())
    mesh = trimesh.Trimesh(vertices=verts, faces=faces, process=True)
    mesh.update_faces(mesh.nondegenerate_faces())
    mesh.remove_unreferenced_vertices()
    mesh.merge_vertices()
    mesh.fix_normals()
    return mesh
