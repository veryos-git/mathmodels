"""Extrude a shelf outline and attach it perpendicular to a swept frame."""
import math

import numpy as np
import trimesh
from shapely.affinity import rotate, scale, translate


def shelf_outline(outline_path, sagitta, width=0, depth=0, flip=False):
    """The exact top-view outline shared by the placement editor and extrusion.

    CAD outlines may put their rear edge at either Y extremum. The longest
    horizontal edge at an extremum determines the rear; flip overrides that
    choice. Dimensions of zero preserve the drawing's physical dimensions.
    """
    from dxf2stl import ConvertError, closed_faces, even_odd, polygons_of
    from shapely.ops import unary_union

    if any(not math.isfinite(v) or v < 0 for v in (width, depth)):
        raise ConvertError("Shelf width and depth must be finite and non-negative")
    outline_path = str(outline_path)
    outline = unary_union(even_odd(closed_faces(outline_path, sagitta, "shelf")))
    polygons = list(polygons_of(outline))
    if len(polygons) != 1:
        raise ConvertError("The shelf outline must contain one connected shape (holes are allowed)")
    outline = polygons[0]
    minx, miny, maxx, maxy = outline.bounds
    sx, sy = width/(maxx-minx) if width else 1, depth/(maxy-miny) if depth else 1
    # Refine curves before enlargement, so tolerance is in finished millimetres.
    if max(sx, sy) > 1:
        outline = unary_union(even_odd(closed_faces(outline_path, sagitta/max(sx, sy), "shelf")))
        if outline.geom_type != "Polygon":
            raise ConvertError("The shelf outline must contain one connected shape")
        minx, miny, maxx, maxy = outline.bounds
        sx, sy = width/(maxx-minx) if width else 1, depth/(maxy-miny) if depth else 1
    candidates = []
    for a, b in zip(outline.exterior.coords, list(outline.exterior.coords)[1:]):
        if abs(a[1]-b[1]) < 1e-5:
            for y in (miny, maxy):
                if abs(a[1]-y) < 1e-5:
                    candidates.append((abs(a[0]-b[0]), y))
    rear = max(candidates)[1] if candidates else miny
    reverse = (rear == maxy) != bool(flip)
    outline = translate(outline, xoff=-(minx+maxx)/2, yoff=-miny)
    outline = scale(outline, xfact=sx, yfact=sy, origin=(0, 0))
    if reverse:
        outline = scale(outline, xfact=1, yfact=-1, origin=(0, 0))
        outline = translate(outline, yoff=(maxy-miny)*sy)
    return outline


def edge_section(section, thickness, rotation, width_scale=1, height_scale=1,
                 mirror=False, flip=False):
    """Reflect about the source baseline, then rotate about the same anchor.

    load_profile registers the drawing at centre X / bottom Y, so Y=0 is
    its horizontal baseline and X=0 its vertical centreline. The baseline
    midpoint stays on the sweep path at half the slab thickness. Never centre
    the two copies independently: that would overlay their bounding boxes.
    """
    from dxf2stl import ConvertError

    for label, value in (("width", width_scale), ("height", height_scale)):
        if not math.isfinite(value) or value <= 0:
            raise ConvertError(f"Shelf profile {label} scale must be finite and greater than zero")
    if rotation not in (90, 180, 270, 360):
        raise ConvertError("Shelf edge profile rotation must be 90, 180, 270 or 360 degrees")
    section = scale(section, xfact=-width_scale if flip else width_scale,
                    yfact=-height_scale if mirror else height_scale, origin=(0, 0))
    section = rotate(section, rotation, origin=(0, 0))
    return translate(section, yoff=thickness/2)


def shelf_mesh(outline_path, sagitta, thickness=5, width=0, depth=0,
               section=None, rotation=90, flip=False, profile_scale=1,
               profile_height_scale=1, mirror_profile=False, flip_profile=False,
               keep_original_profile=False):
    """Extrude the normalized outline and optionally sweep its outer edge."""
    from dxf2stl import ConvertError, sweep_profile
    from cylinder import manifold, printable_mesh

    if not math.isfinite(thickness) or not .2 <= thickness <= 20:
        raise ConvertError("Shelf thickness must be between 0.2 and 20 mm")
    if rotation not in (90, 180, 270, 360):
        raise ConvertError("Shelf edge profile rotation must be 90, 180, 270 or 360 degrees")
    outline = shelf_outline(outline_path, sagitta, width, depth, flip)
    slab = trimesh.creation.extrude_polygon(outline, thickness)
    if section is None:
        return slab
    selected = edge_section(section, thickness, rotation, profile_scale,
                            profile_height_scale, mirror_profile, flip_profile)
    sections = [selected]
    if keep_original_profile and (mirror_profile or flip_profile):
        original = edge_section(section, thickness, rotation, profile_scale,
                                profile_height_scale)
        if not original.equals(selected):
            sections.append(original)
    solid = manifold(slab)
    for cross_section in sections:
        rim = sweep_profile(cross_section, [list(outline.exterior.coords)])
        solid += manifold(rim)
    # Fuse the sweeps: overlapping original/mirrored portions must not become
    # duplicate shells or internal faces in preview, trimming or exports.
    return printable_mesh(solid)


def shelf_origin(frame):
    """Shelf coordinates are X=left/right, Y=model Z (depth), Z=model Y (up)."""
    center = frame.bounds.mean(axis=0)
    return np.array([center[0], center[1], frame.bounds[1, 2]-min(.2, frame.extents[2]/4)])


def placement_preview(frame, args):
    """Project the unmodified swept frame, so moving a shelf cannot move its reference."""
    from dxf2stl import ConvertError, polygon_json, polygons_of
    from shapely.geometry import Polygon
    from shapely.ops import unary_union

    if frame is None:
        raise ConvertError("Choose a main sweep profile to position the shelf")
    if args.cylinder:
        raise ConvertError("Perpendicular additions require a flat model surface")
    vertices = frame.vertices - shelf_origin(frame)
    result = {}
    for name, axes in (("top", [0, 2]), ("front", [0, 1])):
        triangles = vertices[:, axes][frame.faces]
        polygons = [Polygon(triangle) for triangle in triangles
                    if abs(np.linalg.det(np.array([triangle[1]-triangle[0],
                                                   triangle[2]-triangle[0]]))) > 1e-10]
        silhouette = unary_union(polygons).simplify(.0001, preserve_topology=True)
        result[name] = [polygon_json(p) for p in polygons_of(silhouette)]
    outline = shelf_outline(args.addition_outline, args.sagitta) if args.addition_outline else None
    return {"frame": result, "shelf": {
        **polygon_json(outline), "bounds": list(outline.bounds),
    } if outline is not None else None}


def attach_shelf(frame, args):
    """Fuse one shelf onto the base drawing, leaving paint/stack coordinates intact."""
    from dxf2stl import ConvertError, load_profile
    from cylinder import manifold, printable_mesh

    if frame is None:
        raise ConvertError("Additions require a main sweep profile")
    if args.cylinder:
        raise ConvertError("Perpendicular additions require a flat model surface")
    offsets = (args.addition_x, args.addition_y, args.addition_z)
    if not all(math.isfinite(v) for v in offsets):
        raise ConvertError("Shelf position must contain finite millimetre values")
    section = None
    if args.addition_edge_sweep:
        scales = (args.addition_profile_scale, args.addition_profile_height_scale)
        if not all(math.isfinite(value) and value > 0 for value in scales):
            raise ConvertError("Shelf profile scales must be finite and greater than zero")
        section = load_profile(args.addition_profile or args.profile,
                               args.sagitta / max(1, *scales))
    try:
        shelf = shelf_mesh(args.addition_outline, args.sagitta, args.addition_thickness,
                           args.addition_width, args.addition_depth, section,
                           args.addition_rotation, args.addition_flip,
                           args.addition_profile_scale, args.addition_profile_height_scale,
                           args.addition_mirror_profile, args.addition_flip_profile,
                           args.addition_keep_original_profile)
        # Rotate +90° about X: shelf depth becomes model Z; slab thickness
        # extends downward along model Y. Rear edge overlaps the frame.
        shelf.apply_transform(np.array([[1, 0, 0, 0], [0, 0, -1, 0],
                                        [0, 1, 0, 0], [0, 0, 0, 1]], dtype=float))
        shelf.apply_translation(shelf_origin(frame) + np.array(offsets))
        frame_solid, shelf_solid = manifold(frame), manifold(shelf)
        if args.addition_trim_back:
            # The frame lies XY on the bed. Shelf depth becomes world Z after
            # rotation; trim the placed solid, including its rim, to the frame's
            # actual rear plane. Manifold caps this cut before fusion/export.
            shelf_solid = shelf_solid.trim_by_plane((0, 0, 1), float(frame.bounds[0, 2]))
            if shelf_solid.is_empty():
                raise ConvertError("The bed-plane trim removed the shelf. Move it outward from the frame.")
        if (frame_solid ^ shelf_solid).volume() < 1e-8:
            raise ConvertError("The shelf does not touch the frame. Adjust its width or position.")
        return printable_mesh(frame_solid + shelf_solid)
    except (ValueError, RuntimeError) as error:
        raise ConvertError(f"Could not build the shelf: {error}") from error
