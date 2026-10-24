"""Solid operations for independently profiled tracery and revolved endings."""
import math
import numpy as np
import trimesh
import manifold3d
from shapely import make_valid, set_precision
from shapely.affinity import scale
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
    result.update_faces(np.all(np.diff(np.sort(result.faces, axis=1), axis=1) != 0, axis=1))
    result.update_faces(result.unique_faces())
    result.remove_unreferenced_vertices()
    parts = []
    for part in result.split(only_watertight=False, repair=False):
        local = part.copy()
        local.apply_translation(-local.vertices.mean(axis=0))
        # Collapsed slivers have no mass: asking trimesh for their centre of
        # mass divides by zero. Reject planar scraps before measuring volume,
        # in local coordinates so distant open faces cannot fake a volume.
        if np.linalg.matrix_rank(local.vertices, tol=1e-7) < 3:
            continue
        if abs(local.volume) > 1e-6:
            parts.append(part)
    if not parts or any(not p.is_volume for p in parts):
        raise ValueError("The fused geometry is not watertight at STL precision")
    return trimesh.util.concatenate(parts)


def segmented_profile_sweep(profile, chains, miter_limit=4.0, overlap=.001):
    """Union closed, mitre-cut prisms for tightly turning profile paths.

    Joining rings into one long shell can fold its inner surface through
    itself when the profile is wider than a bend. Individual prisms remain
    solids there, so the boolean removes the overlapping inner surfaces.
    A micron of overlap at internal joints avoids zero-thickness contacts.
    Past the mitre limit, the inside of a corner would cut back further
    than short neighbouring segments reach, so paths split there and the
    clipped mitre is built on its own (see `_clipped_mitre`). Whether a
    mitre is clipped depends only on the turn, not on the profile width.
    Return a Manifold so placement can precede the STL precision check.
    """
    contours = [list(profile.exterior.coords)[:-1]] + [list(r.coords)[:-1] for r in profile.interiors]
    section = manifold3d.CrossSection(contours, manifold3d.FillRule.EvenOdd)
    margin = max(abs(profile.bounds[0]), abs(profile.bounds[2]))*miter_limit + overlap
    solids = []
    pieces = []
    for chain in chains:
        if len(chain) < 2:
            continue
        split, corners = _split_sharp_corners(chain, miter_limit)
        pieces += split
        for corner in corners:
            solids += _clipped_mitre(profile, section, *corner, miter_limit, overlap)
    for piece, joined in pieces:
        points, normals, closed = path_frames(piece, miter_limit)
        for i in range(len(points) if closed else len(points)-1):
            j = (i+1) % len(points)
            direction = points[j]-points[i]
            length = np.linalg.norm(direction)
            if length < 1e-10:
                continue
            direction /= length
            normal = np.array([-direction[1], direction[0]])
            origin = points[i]-direction*margin
            solid = section.extrude(length+2*margin).transform([
                [normal[0], 0, direction[0], origin[0]],
                [normal[1], 0, direction[1], origin[1]],
                [0, 1, 0, 0]])
            for v, start in ((i, True), (j, False)):
                cut = np.array([normals[v, 1], -normals[v, 0]])
                if cut @ direction < 0:
                    cut = -cut
                cut /= np.linalg.norm(cut)
                if not start:
                    cut = -cut
                # Ends at a split corner reach into its mitre like internal joins.
                internal = closed or v not in (0, len(points)-1) or joined[v != 0]
                solid = solid.trim_by_plane([*cut, 0], cut @ points[v]-(overlap if internal else 0))
            solids.append(solid)
    if not solids:
        raise ValueError("The sketch has no drawable paths")
    return manifold3d.Manifold.batch_boolean(solids, manifold3d.OpType.Add).simplify(.0001)


def _split_sharp_corners(chain, miter_limit):
    """Pieces of `chain` between corners whose mitre `path_frames` would clip.

    Returns ``(pieces, corners)``: each piece is ``(points, joined)``, where
    ``joined`` says whether its start and its end lie on a split corner;
    each corner is ``(point, arriving, leaving)`` with unit directions.
    A closed chain is oriented as `path_frames` would orient it, so an
    asymmetric section stays on the same side once the loop is opened.
    """
    closed = chain[0] == chain[-1]
    points = [tuple(p) for p in (chain[:-1] if closed else chain)]
    if closed and not Polygon(points).exterior.is_ccw:
        points = points[::-1]
    n = len(points)
    sharp, corners = [], []
    for i in (range(n) if closed else range(1, n-1)):
        arriving = np.subtract(points[i], points[i-1], dtype=float)
        leaving = np.subtract(points[(i+1) % n], points[i], dtype=float)
        if min(np.linalg.norm(arriving), np.linalg.norm(leaving)) < 1e-12:
            continue
        arriving /= np.linalg.norm(arriving)
        leaving /= np.linalg.norm(leaving)
        # The same test as path_frames, a hair stricter so no clipped mitre
        # is left for a prism to cut.
        length = np.linalg.norm([-arriving[1]-leaving[1], arriving[0]+leaving[0]])
        if length < 1e-6 or 2 / length > miter_limit * (1 - 1e-9):
            sharp.append(i)
            corners.append((np.asarray(points[i], dtype=float), arriving, leaving))
    if not sharp:
        return [(chain, (False, False))], []
    if closed:
        loop = points[sharp[0]:] + points[:sharp[0]+1]
        cuts = [i - sharp[0] for i in sharp] + [n]
        if len(sharp) == 1:
            # One piece would start and end on the corner and read as closed
            # again; part it mid-segment, where square ends meet as a mitre.
            k = max(range(n), key=lambda i: math.dist(loop[i], loop[i+1]))
            loop.insert(k+1, tuple((np.add(loop[k], loop[k+1]) / 2).tolist()))
            cuts = [0, k+1, n+1]
        return [(loop[a:b+1], (True, True)) for a, b in zip(cuts, cuts[1:])], corners
    cuts = [0] + sharp + [n-1]
    return [(points[a:b+1], (a in sharp, b in sharp)) for a, b in zip(cuts, cuts[1:])], corners


def _clipped_mitre(profile, section, point, arriving, leaving, miter_limit, overlap):
    """The outside of a split corner: its mitre, clipped at the mitre limit.

    Each piece's prism runs on past the vertex to the bisector plane, as at
    any mitred corner, so asymmetric and multi-part sections keep their
    shape round the corner; the inside needs nothing, as the square-ended
    pieces already overlap there. At every height the tip is cut across the
    bisector at `miter_limit` times the section's outer half-width there,
    like a mitre-limited stroke join. Returns the two halves.
    """
    gap = arriving - leaving
    reach = np.linalg.norm(gap)                  # 2 sin(half the turn)
    outward = gap / reach                        # bisects the outside
    across = np.array([-outward[1], outward[0]])
    # The section's +x is left of travel, the outside of a right turn.
    side = 1.0 if arriving[0]*leaving[1] - arriving[1]*leaving[0] < 0 else -1.0
    if across @ (side*np.array([-arriving[1], arriving[0]])) < 0:
        across = -across                         # towards the arriving half
    width = max(abs(profile.bounds[0]), abs(profile.bounds[2]))
    length = 2*(miter_limit+1)*width/reach + 2*overlap   # past any clipped tip
    # Within the limit at every height: the section stretched outward by it
    # and continued inward, padded above and below so no faces coincide.
    ring = [(side*x*miter_limit, y) for x, y in profile.exterior.coords]
    _, bottom, _, top = profile.bounds
    pads = []
    for level, pad in ((bottom, bottom-1), (top, top+1)):
        edge = Polygon(ring).intersection(LineString([(-length, level), (length, level)]))
        pads.append(Polygon([(-length, level), (edge.bounds[2], level),
                             (edge.bounds[2], pad), (-length, pad)]))
    reachable = unary_union([Polygon(ring), *pads] + [
        Polygon([a, b, (b[0]-length, b[1]), (a[0]-length, a[1])])
        for a, b in zip(ring, ring[1:]) if a[1] != b[1]])
    clip = manifold3d.CrossSection(
        [list(p.exterior.coords)[:-1] for p in getattr(reachable, "geoms", [reachable])],
        manifold3d.FillRule.NonZero).extrude(2*length).transform([
            [outward[0], 0, across[0], point[0]-length*across[0]],
            [outward[1], 0, across[1], point[1]-length*across[1]],
            [0, 1, 0, 0]])
    halves = []
    for direction, start, sign in ((arriving, -overlap, 1), (leaving, -length, -1)):
        normal = np.array([-direction[1], direction[0]])
        origin = point + start*direction
        prism = section.extrude(length+overlap).transform([
            [normal[0], 0, direction[0], origin[0]],
            [normal[1], 0, direction[1], origin[1]],
            [0, 1, 0, 0]])
        # Each half keeps its own side of the bisector, plus the usual overlap.
        halves.append(prism.trim_by_plane([*(sign*across), 0], sign*across @ point - overlap) ^ clip)
    return halves


def _arc(centre, radius, start, stop, segments):
    """Points on a circle from angle `start` to `stop` (radians), both included."""
    count = max(2, int(segments * abs(stop - start) / (math.pi / 2)) + 1)
    return [(centre[0] + radius * math.cos(a), centre[1] + radius * math.sin(a))
            for a in np.linspace(start, stop, count + 1)]


def hook_sections(spec, profile_height, segments=24):
    """Hook paths in the vertical plane that stands on an endpoint.

    Coordinates are (s, v): s runs along the frame's travel direction out of
    the endpoint, v straight up out of the drawing plane. Every chain is
    ordered so its left normal is where the profile's height goes, which at
    s = 0 is +v — the hook therefore starts exactly like the frame it
    continues; ``chains[0]`` is the one leaving the endpoint. Returns
    ``(chains, tip, joints)``: ``tip`` is ``(point, direction, up)`` of the
    free end for the optional rounded cap, ``joints`` the same for inner
    ends that are always rounded.

    * ``"round"`` — a reverse curve standing up from the endpoint: a small
      arc (``small_radius``) bends the path upward until it meets, tangent, a
      big arc (``big_radius``) that curls over the top. Both circles touch
      the ground; ``angle`` is how far round the big circle the tip ends,
      measured from its ground point, so 180° is straight over the top.
    * ``"straight"`` — a triangular bracket: a bottom bar continues the path
      by ``length``, a post stands up at the endpoint, and a bar rising at
      ``angle`` from the bottom bar's far end crosses the post's top and
      overhangs it back over the frame by ``overhang`` (measured along the
      bar). ``chains[1:]`` (post, bar) carry the moulding on both faces, see
      `hook_solid`.
    """
    kind = spec.get("type", "round")
    if kind == "round":
        small = float(spec.get("small_radius", 6.0))
        big = float(spec.get("big_radius", 14.0))
        angle = float(spec.get("angle", 200.0))
        for label, value in (("small radius", small), ("big radius", big)):
            if not math.isfinite(value) or value <= 0:
                raise ValueError(f"Hook {label} must be a positive number")
        # Circles of radii r and R both resting on the ground and touching
        # each other stand 2·sqrt(rR) apart.
        gap = 2 * math.sqrt(small * big)
        meet = math.atan2(big - small, gap)          # small→big centre line
        if not math.isfinite(angle) or not math.degrees(math.pi / 2 - meet) < angle <= 350:
            raise ValueError("Hook angle must run past the point where the arcs meet "
                             f"({math.degrees(math.pi / 2 - meet):.0f}°) and stay within 350°")
        # Counter-clockwise up the small circle from its ground point...
        rise = _arc((0, small), small, -math.pi / 2, meet, segments)
        # ...then clockwise over the big one, leaving its far side `angle`
        # degrees from the ground point (towards the endpoint first).
        stop = -math.pi / 2 - math.radians(angle)
        curl = _arc((gap, big), big, meet - math.pi, stop, segments)
        # Like the reference sweep, the profile sits on the concave side of
        # each arc, so the big arc is listed backwards (its left normal then
        # faces its centre); the section changes sides where the arcs meet.
        # Concave on both sides, the two sweeps only touch along a line where
        # they meet; rounding off the rising arc's end there fuses them.
        joint = (np.array(rise[-1]), np.array([-math.sin(meet), math.cos(meet)]),
                 -np.array([math.cos(meet), math.sin(meet)]))
        direction = np.array([math.sin(stop), -math.cos(stop)])   # clockwise tangent
        up = -np.array([math.cos(stop), math.sin(stop)])          # towards the centre
        return [rise, curl[::-1]], (np.array(curl[-1]), direction, up), [joint]
    if kind == "straight":
        length = float(spec.get("length", 33.2))
        angle = float(spec.get("angle", 26.2))
        overhang = float(spec.get("overhang", 12.4))
        if not math.isfinite(length) or length <= 0:
            raise ValueError("Hook length must be a positive number")
        if not math.isfinite(angle) or not 5 <= angle <= 80:
            raise ValueError("Hook angle must be between 5 and 80 degrees")
        if not math.isfinite(overhang) or overhang < 0:
            raise ValueError("Hook overhang must be zero or more")
        a = math.radians(angle)
        height = length * math.tan(a)                 # where the bar crosses the post
        along = np.array([-math.cos(a), math.sin(a)])  # up the bar, back over the frame
        foot = np.array([length, 0.0])
        # The bar starts below ground deep enough that the ground cut leaves
        # it a full, flat-bottomed foot.
        sink = profile_height / math.tan(a) + 1
        top = foot + (length / math.cos(a) + overhang) * along
        bar = [tuple(top), tuple(foot - sink * along)]  # downhill: profile sits on top
        # The post ends square where the bar's centre line crosses it, as in
        # the reference; the two-sided bar buries that end on both faces.
        post = [(0, -1), (0, height)]
        bottom = [(0, 0), (length + 0.05, 0)]
        return [bottom, post, bar], (top, along, np.array([math.sin(a), math.cos(a)])), []
    raise ValueError(f"Unknown hook type {kind!r}; use 'round' or 'straight'")


def _plane_sweep(profile, chain, place):
    """Sweep `profile` along a 2D (s, v) chain mapped to 3D by `place(s, v)`.

    The profile's x stays across the plane (handled by `place`), its height
    follows the chain's mitred left normal.
    """
    points, normals, _ = path_frames(chain)
    ring = np.asarray(profile.exterior.coords[:-1])
    k = len(ring)
    verts = [place(p[0] + h * n[0], p[1] + h * n[1], x)
             for p, n in zip(points, normals) for x, h in ring]
    faces = []
    for i in range(len(points) - 1):
        for j in range(k):
            a, b = i * k + j, i * k + (j + 1) % k
            faces.extend([(a, b, b + k), (a, b + k, a + k)])
    cap_v, cap_f = trimesh.creation.triangulate_polygon(profile)
    for p, n in ((points[0], normals[0]), (points[-1], normals[-1])):
        offset = len(verts)
        verts.extend(place(p[0] + h * n[0], p[1] + h * n[1], x) for x, h in cap_v)
        faces.extend((cap_f + offset).tolist())
    return _closed(verts, faces)


def _two_sided(profile):
    """The section and its mirror image across the path, as sections to sweep.

    One section where they share the base line (the usual case), so the two
    faces are a single sweep with no internal face for the union to resolve.
    """
    both = unary_union([profile, scale(profile, 1, -1, origin=(0, 0))]).simplify(0)
    return list(getattr(both, "geoms", [both]))


def _plane_knob(profile, point, direction, up, place, angle=90, segments=24):
    """Round a hook end: turn the end section about its base line.

    The section rolls from `up` towards the travel `direction`: 90° gives a
    quarter-round nose (the tip), 180° a half-disc knob that reaches the
    opposite side (used to fuse the round hook's reverse curve).
    """
    ring = np.asarray(profile.exterior.coords[:-1])
    k = len(ring)
    theta = np.linspace(0, math.radians(angle), segments + 1)
    def at(t, x, h):
        lean = h * (math.cos(t) * up + math.sin(t) * direction)
        return place(point[0] + lean[0], point[1] + lean[1], x)
    verts = [at(t, x, h) for t in theta for x, h in ring]
    faces = []
    for i in range(segments):
        for j in range(k):
            a, b = i * k + j, i * k + (j + 1) % k
            faces.extend([(a, b, b + k), (a, b + k, a + k)])
    cap_v, cap_f = trimesh.creation.triangulate_polygon(profile)
    for t in (theta[0], theta[-1]):
        offset = len(verts)
        verts.extend(at(t, x, h) for x, h in cap_v)
        faces.extend((cap_f + offset).tolist())
    return _closed(verts, faces)


def _closed(verts, faces):
    mesh = trimesh.Trimesh(vertices=verts, faces=faces, process=True)
    mesh.update_faces(mesh.nondegenerate_faces())
    mesh.remove_unreferenced_vertices()
    mesh.merge_vertices()
    mesh.fix_normals()
    return mesh


def hook_tip(spec):
    """How a hook's free tip ends: ``spec['tip']``, or the older ``cap`` flag.

    * ``"quarter"`` (default) — the end section rolls 90° forward over its
      base line: a quarter-round nose, whose profile edges can stay sharp.
    * ``"half"`` — it rolls 180° to hang under the bar, as a half-disc knob.
    * ``"square"`` — left as cut (also ``cap: false``).

    A straight hook's bar carries the moulding on both faces, so both its
    rounded tips are the reference's 180° half-round, where the two faces'
    quarter rolls meet.
    """
    style = spec.get("tip", "quarter" if spec.get("cap", True) else "square")
    if style not in ("quarter", "half", "square"):
        raise ValueError(f"Unknown hook tip {style!r}; use 'quarter', 'half' or 'square'")
    return style


def hook_solid(profile, point, forward, spec, inset=0.05, across=None, segments=24):
    """A hook swept from the frame's own profile, standing up at `point`.

    `forward` is the in-plane direction the hook leaves along (the path's
    outward tangent at a free end). The hook stands in the vertical plane
    through `forward`; the profile keeps its across-the-path orientation, so
    at the root it matches the frame section exactly. `inset` pushes the
    root back into the frame so the two fuse; `across` is the frame's own
    profile-x direction there (default: left of `forward`), so asymmetric
    profiles are not mirrored. Nothing goes below the frame's
    base plane (z = 0). The free tip follows `hook_tip`.

    A straight hook is built like the reference (``object_additions/hook/
    24-10-2026``): the bottom bar carries the profile on top only; the post
    and the rising bar carry it on both faces (the section plus its mirror
    image across the path, as the reference's 180° revolve leaves it), the
    post ending square at the bar's centre line.
    """
    point = np.asarray(point, dtype=float)
    forward = np.asarray(forward, dtype=float)
    forward = forward / max(np.linalg.norm(forward), 1e-12)
    across = np.array([-forward[1], forward[0]]) if across is None else np.asarray(across, float)
    across = across / max(np.linalg.norm(across), 1e-12)
    height = profile.bounds[3]
    chains, tip, joints = hook_sections(spec, height, segments)
    if inset > 0:
        chains[0] = [(-inset, 0.0)] + chains[0]       # root, inside the frame

    def place(s, v, x):
        xy = point + s * forward + x * across
        return (xy[0], xy[1], v)

    style = hook_tip(spec)
    if spec.get("type") == "straight":
        two_sided = _two_sided(profile)
        meshes = [_plane_sweep(profile, chains[0], place)] + [
            _plane_sweep(part, chain, place) for chain in chains[1:] for part in two_sided]
    else:
        meshes = [_plane_sweep(profile, chain, place) for chain in chains]
    # Each knob is recessed a sliver so it fuses with the sweep it ends.
    knobs = [(joint, 180) for joint in joints]
    if style != "square":
        half = style == "half" or spec.get("type") == "straight"
        knobs.append((tip, 180 if half else 90))
    for (point2, direction, up), angle in knobs:
        meshes.append(_plane_knob(profile, point2 - direction * 0.05, direction, up,
                                  place, angle, segments))
    solid = _to_manifold(solid_union(meshes)).trim_by_plane((0.0, 0.0, 1.0), 0.0)
    return _manifold_mesh(solid)


def _to_manifold(mesh):
    return manifold3d.Manifold(manifold3d.Mesh(
        vert_properties=np.asarray(mesh.vertices, dtype=np.float32),
        tri_verts=np.asarray(mesh.faces, dtype=np.uint32)))


def _manifold_mesh(solid):
    data = solid.to_mesh()
    return trimesh.Trimesh(vertices=data.vert_properties[:, :3], faces=data.tri_verts,
                           process=False)


def dome_ending(profile, point, normal, outward, segments=24):
    """Cap a sweep endpoint by rolling the profile 90° around its base line.

    The profile cross-section is swept from its upright position (coinciding
    with the sweep end face) through 90° around the horizontal axis at the
    base of the profile (z = 0, running in the *normal* direction across the
    path).  The result is a dome-shaped cap: the profile's silhouette turns
    outward and lays flat, producing a smooth hemisphere-like ending rather
    than an abrupt flat cut.

    For each profile point (x, z_prof) the 3D position at angle t is:
        xy = point + x * normal + z_prof * sin(t) * outward
        height = z_prof * cos(t)
    At t=0 this is the profile in its swept position; at t=90° it lies flat.
    """
    ring = np.asarray(profile.exterior.coords[:-1])
    point = np.asarray(point, dtype=float)
    normal = np.asarray(normal, dtype=float)
    outward = np.asarray(outward, dtype=float)

    theta = np.linspace(0, math.pi / 2, max(2, segments) + 1)
    k = len(ring)
    verts = []
    for t in theta:
        cos_t, sin_t = math.cos(t), math.sin(t)
        for x, z in ring:
            xy = point + x * normal + z * sin_t * outward
            verts.append([xy[0], xy[1], float(z * cos_t)])

    faces = []
    for i in range(len(theta) - 1):
        for j in range(k):
            a, b = i * k + j, i * k + (j + 1) % k
            faces.extend([(a, b, b + k), (a, b + k, a + k)])

    cap_v, cap_f = trimesh.creation.triangulate_polygon(profile)
    # Cap at t=0: the profile in its upright position at the sweep endpoint.
    offset0 = len(verts)
    for x, z in cap_v:
        verts.append([*(point + x * normal), float(z)])
    faces.extend((cap_f[:, ::-1] + offset0).tolist())

    # Cap at t=90°: the profile footprint lying flat at z = 0.
    offset90 = len(verts)
    for x, z in cap_v:
        xy = point + x * normal + z * outward
        verts.append([xy[0], xy[1], 0.0])
    faces.extend((cap_f + offset90).tolist())

    mesh = trimesh.Trimesh(vertices=verts, faces=faces, process=True)
    mesh.update_faces(mesh.nondegenerate_faces())
    mesh.remove_unreferenced_vertices()
    mesh.merge_vertices()
    mesh.fix_normals()
    return mesh


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
