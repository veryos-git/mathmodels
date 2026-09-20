"""Solid operations for independently profiled tracery and revolved endings."""
import math
import numpy as np
import trimesh
import manifold3d


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
