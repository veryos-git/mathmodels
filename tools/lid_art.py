"""Fit a separate sketch to a circular lid and sweep the current profile."""
import argparse
import json
import math
import sys

import numpy as np
import manifold3d as mf
import trimesh
from shapely.affinity import scale as scale_polygon

from dxf2stl import ConvertError, MITER_LIMIT, chain_curves, load_profile, read_curves, sweep_profile
from gothic import path_frames, segmented_profile_sweep
from cylinder import EMBED, dimensions, manifold, mesh_of


def fit_lid_paths(curves, profile, diameter):
    """Scale paths uniformly before sweeping, keeping the section unchanged.

    Each sweep vertex is s*P + profile_x*N. Solve its circular boundary
    intersection to find the largest path scale whose finished sweep fits.
    This includes mitred corners, rather than estimating half a wall width.
    """
    chains = chain_curves(curves)
    if not chains:
        raise ValueError("The lid-top sketch has no drawable paths")
    points = np.array([p for chain in chains for p in chain], dtype=float)
    center = (points.min(axis=0)+points.max(axis=0))/2
    chains = [(np.asarray(chain)-center).tolist() for chain in chains]
    if np.max(np.linalg.norm(points-center, axis=1)) < 1e-8:
        raise ValueError("The lid-top sketch must have a positive size")
    radius = diameter/2
    scales = []
    for chain in chains:
        positions, normals, _ = path_frames(chain, MITER_LIMIT)
        a = np.sum(positions**2, axis=1)
        for px in (profile.bounds[0], profile.bounds[2]):
            offset = px*normals
            b = np.sum(positions*offset, axis=1)
            c = np.sum(offset**2, axis=1)-radius**2
            if np.any(c >= 0):
                raise ValueError("The sweep profile is too wide for this lid; reduce the profile width or increase the diameter")
            use = a > 1e-16
            roots = (-b[use]+np.sqrt(b[use]**2-a[use]*c[use]))/a[use]
            scales.extend(roots.tolist())
    factor = min(scales)
    return [(np.asarray(chain)*factor).tolist() for chain in chains], factor


def lid_art_mesh(sketch, profile_path, c, profile_scale=1.0, sagitta=0.02):
    if not c.get('lid'):
        raise ValueError("A lid-top sketch requires Add lid")
    if not profile_path:
        raise ValueError("Load a sweep profile to use a lid-top sketch")
    if not math.isfinite(profile_scale) or profile_scale <= 0:
        raise ValueError("Profile width must be greater than zero")
    if not math.isfinite(sagitta) or sagitta <= 0:
        raise ValueError("Curve tolerance must be greater than zero")
    profile = load_profile(profile_path, sagitta)
    profile = scale_polygon(profile, xfact=profile_scale, yfact=1, origin=(0, 0))
    design = c.get('threadedDesign', {}) if c.get('threaded') else {}
    diameter = c['diameter']-2*design.get('lidTopChamfer', 0)
    curves, _, _ = read_curves(sketch, sagitta)
    chains, factor = fit_lid_paths(curves, profile, diameter)
    # Refine very small source drawings in their original units before fitting.
    if factor > 1:
        curves, _, _ = read_curves(sketch, sagitta/factor)
        chains, factor = fit_lid_paths(curves, profile, diameter)
    embed = min(EMBED, profile.bounds[3]/4)
    z = dimensions(c)[1]-embed
    try:
        mesh = sweep_profile(profile, chains)
        mesh.apply_translation((0, 0, z))
        mesh = mesh_of(manifold(mesh))
        if not mesh.is_volume:
            raise ValueError("The lid-top sweep did not form closed solids")
    except (ConvertError, ValueError, RuntimeError):
        # Tight bends can fold a ring sweep back through itself. Resolve
        # those overlaps as closed sections, then validate at the actual
        # lid height: translation changes float32 STL rounding as well.
        solid = segmented_profile_sweep(profile, chains, MITER_LIMIT)
        solid = mf.Manifold.compose([p for p in solid.decompose() if abs(p.volume()) > 1e-6])
        mesh = mesh_of(solid.translate((0, 0, z)))
        parts = []
        for part in mesh.split(only_watertight=False, repair=False):
            # Collapsed boolean slivers can leave isolated planar faces.
            # Measure in local coordinates, avoiding a spurious volume
            # from an open triangle situated far above the origin.
            local = part.copy()
            local.apply_translation(-local.bounds.mean(axis=0))
            if abs(local.volume) > 1e-6:
                parts.append(part)
        if not parts or any(not p.is_volume for p in parts):
            raise ValueError("The lid-top sweep did not form closed solids; reduce the profile width or simplify tight sketch corners")
        mesh = trimesh.util.concatenate(parts)
    return mesh, {'scale': factor, 'diameter': diameter,
                  'profileWidth': profile.bounds[2]-profile.bounds[0],
                  'profileHeight': profile.bounds[3], 'triangles': len(mesh.faces)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('sketch')
    parser.add_argument('profile')
    parser.add_argument('config')
    parser.add_argument('output')
    parser.add_argument('--profile-scale', type=float, default=1)
    parser.add_argument('--sagitta', type=float, default=.02)
    args = parser.parse_args()
    with open(args.config) as stream:
        settings = json.load(stream)
    mesh, info = lid_art_mesh(args.sketch, args.profile, settings, args.profile_scale, args.sagitta)
    mesh.export(args.output)
    json.dump(info, sys.stdout)


if __name__ == '__main__':
    try:
        main()
    except (ConvertError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
