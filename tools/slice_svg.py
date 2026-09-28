"""Horizontal CNC cross-sections of generated solids, in millimetres."""
import math

import numpy as np
import trimesh
from shapely import make_valid, set_precision
from shapely.geometry import MultiLineString, Polygon
from shapely.ops import polygonize_full, unary_union


def polygon_parts(geometry):
    if geometry.geom_type == "Polygon":
        yield geometry
    elif hasattr(geometry, "geoms"):
        for part in geometry.geoms:
            yield from polygon_parts(part)


def planar_section(meshes, z):
    """Slice unfused sweeps whose 3D topology may prevent a boolean union.

    Node the triangle intersections in 2D, then keep cells with nonzero
    winding. Unlike even/odd filling across all sweeps, winding retains
    overlapping material while preserving holes. Require closed linework:
    never invent a closing edge across an actual gap in the selected slice.
    """
    directed = []
    for mesh in meshes:
        segments, faces = trimesh.intersections.mesh_plane(
            mesh, [0, 0, 1], [0, 0, z], return_faces=True)
        if not len(segments):
            continue
        segments = segments[:, :, :2].copy()
        normals = mesh.face_normals[faces, :2]
        tangent = np.column_stack((-normals[:, 1], normals[:, 0]))
        if mesh.volume < 0:
            tangent *= -1
        reverse = np.einsum('ij,ij->i', segments[:, 1] - segments[:, 0], tangent) < 0
        segments[reverse] = segments[reverse, ::-1]
        directed.extend(segments)
    if not directed:
        raise ValueError("This height does not intersect any solid; choose another height")
    # Sub-micron endpoint snapping joins numerical duplicates, not real gaps.
    segments = np.round(np.asarray(directed), 7)
    linework = unary_union(set_precision(MultiLineString(segments.tolist()), 1e-7))
    cells, cuts, dangles, invalid = polygonize_full(linework)
    if not (cuts.is_empty and dangles.is_empty and invalid.is_empty):
        raise ValueError("The slice has an open contour; check the model geometry or choose another height")
    start, end = segments[:, 0], segments[:, 1]
    filled = []
    for cell in cells.geoms:
        point = cell.representative_point()
        x, y = point.x, point.y
        side = ((end[:, 0] - start[:, 0]) * (y - start[:, 1])
                - (x - start[:, 0]) * (end[:, 1] - start[:, 1]))
        upward = (start[:, 1] <= y) & (end[:, 1] > y) & (side > 0)
        downward = (end[:, 1] <= y) & (start[:, 1] > y) & (side < 0)
        if np.count_nonzero(upward) != np.count_nonzero(downward):
            filled.append(cell)
    return unary_union(filled)


def slice_svg(meshes, height):
    """Return SVG and stats. Height is measured from the whole model's base.

    Union solids, or their planar sections, so overlaps leave no internal cuts.
    SVG Y is reversed to preserve the model's top view; every slice uses the
    full model bounds, including when only a small island remains at this Z.
    """
    if not math.isfinite(height) or height < 0:
        raise ValueError("Slice height must be a finite, non-negative number")
    bounds = np.array([mesh.bounds for mesh in meshes])
    lo, hi = bounds[:, 0].min(axis=0), bounds[:, 1].max(axis=0)
    depth = float(hi[2] - lo[2])
    if height >= depth:
        raise ValueError(f"Slice height must be below the model height ({depth:g} mm)")
    try:
        solid = trimesh.boolean.union(meshes, engine="manifold")
    except (ValueError, RuntimeError):
        shape = planar_section(meshes, lo[2] + height)
    else:
        section = solid.section(plane_origin=[0, 0, lo[2] + height],
                                plane_normal=[0, 0, 1])
        if section is None:
            raise ValueError("This height does not intersect any solid; choose another height")
        # Even/odd nesting is safe after the solids have been fused.
        shape = Polygon()
        for points in section.discrete:
            if not np.allclose(points[0], points[-1], rtol=0, atol=1e-7):
                raise ValueError("The slice has an open contour; check the model geometry")
            # A plane through a vertex can yield a touching ring or spur.
            ring = unary_union(list(polygon_parts(make_valid(Polygon(points[:, :2])))))
            shape = shape.symmetric_difference(ring)
    if shape.is_empty:
        raise ValueError("This height has no closed cutting outlines")
    polygons = list(polygon_parts(shape))
    paths = []
    contours = 0
    for polygon in polygons:
        commands = []
        for ring in [polygon.exterior, *polygon.interiors]:
            coords = list(ring.coords)[:-1]
            commands.append("M" + " L".join(
                f"{x - lo[0]:.9f},{hi[1] - y:.9f}" for x, y in coords) + " Z")
            contours += 1
        paths.append(f'<path d="{" ".join(commands)}"/>')
    width, length = hi[:2] - lo[:2]
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{width:.9f}mm" '
           f'height="{length:.9f}mm" viewBox="0 0 {width:.9f} {length:.9f}">\n'
           f'<title>Cross-section {height:g} mm above model base</title>\n'
           '<g fill="none" stroke="black" stroke-width="0.1" fill-rule="evenodd">\n'
           + "\n".join(paths) + '\n</g>\n</svg>\n')
    return svg, {"sliceHeight": height, "modelHeight": depth,
                 "contours": contours, "area": float(shape.area)}
