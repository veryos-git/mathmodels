#!/usr/bin/env python3
"""Turn a subject into a fold-over keyfob, as an SVG in millimetres.

The subject's *silhouette* — the region its outermost line encloses — gets a
neck, and the whole piece is mirrored across a fold line in the middle of that
neck. Cut it out, fold the neck through a key ring, and the back half lies
exactly behind the front. The subject's inner lines (a ghost's eyes, a wing's
veins) stay on the front as detail lines; --mirror full copies them onto the
back as well, so cut-outs go through both thicknesses.

Usage:
    keyfob.py subject.svg [--size 50] [--mirror silhouette|full]
              [--neck-width 12] [--neck-length 30] [--neck-angle 0]
              [--neck-offset 0] [--fillet 3] [--close-gaps 0.6]
              [--stitch 3] [--fold-mark] [--sagitta 0.02]

--size is the silhouette's longest side. --neck-angle points the neck: 0° is
straight up, clockwise from there. --neck-offset slides it sideways from the
middle of the silhouette (positive is to the right, looking along the neck).
--neck-length is the clear length between the two halves; the fold sits in its
middle. --stitch adds a stitching line that far inside the cut edge.

Prints JSON: the SVG, its layers' geometry for the preview, and a summary.
"""

import argparse
import json
import math
import sys

from shapely import affinity
from shapely.geometry import LineString, MultiLineString, Polygon
from shapely.ops import linemerge, unary_union

from dxf2stl import ConvertError, polygons_of, read_curves

MIRROR_MODES = ("silhouette", "full")
# Away from the neck the two halves are kept at least this far apart, so a
# subject that bulges past the neck's root can never overlap its mirror image.
MIN_GAP = 2.0
# The silhouette is rebuilt from buffers; this drops their arc vertices
# without moving the edge by anything a knife could follow.
SIMPLIFY = 0.01
# A piece of the silhouette smaller than this share of the main one is a
# stray mark, not part of the subject.
MIN_PIECE = 0.002
OVERLAP = 1e-3  # the two halves overlap this much at the fold, so they fuse
# Pieces cut from one another fuse back with floating-point cracks along their
# shared edges; growing them this much (mm) before the union seals those.
SEAL = 1e-3

COLOURS = {"cut": "#e11d48", "details": "#2563eb", "details-back": "#7c3aed",
           "stitch": "#16a34a", "fold": "#64748b"}


def frame(angle):
    """Unit vectors along the neck (0° = up, clockwise) and to its right."""
    a = math.radians(angle)
    d = (math.sin(a), math.cos(a))
    return d, (d[1], -d[0])


def along(geom, d):
    """The range a geometry covers when projected onto the direction d."""
    coords = [c for g in _parts(geom) for c in g.coords]
    values = [x * d[0] + y * d[1] for x, y in coords]
    return min(values), max(values)


def _parts(geom):
    """Every ring or line of a geometry, for walking its coordinates."""
    if geom.is_empty:
        return
    if geom.geom_type == "Polygon":
        yield geom.exterior
        yield from geom.interiors
    elif geom.geom_type in ("LineString", "LinearRing"):
        yield geom
    elif hasattr(geom, "geoms"):
        for g in geom.geoms:
            yield from _parts(g)


def strip(d, n, offset, width, t0, t1):
    """The neck's band from t0 to t1 along d, `width` wide, `offset` to the side."""
    def at(t, u):
        return (d[0] * t + n[0] * u, d[1] * t + n[1] * u)
    lo, hi = offset - width / 2, offset + width / 2
    return Polygon([at(t0, lo), at(t1, lo), at(t1, hi), at(t0, hi)])


def mirror(geom, d, fold):
    """Reflect across the fold line {p : p·d = fold}."""
    a, b = 1 - 2 * d[0] * d[0], -2 * d[0] * d[1]
    e = 1 - 2 * d[1] * d[1]
    return affinity.affine_transform(geom, [a, b, b, e, 2 * fold * d[0], 2 * fold * d[1]])


def lines_of(geom):
    """Every LineString in a geometry, merged into the longest runs possible."""
    lines = [g for g in _flatten(geom) if g.geom_type == "LineString" and not g.is_empty]
    if not lines:
        return []
    merged = linemerge(lines)
    return [g for g in _flatten(merged) if g.geom_type == "LineString" and not g.is_empty]


def _flatten(geom):
    if hasattr(geom, "geoms"):
        for g in geom.geoms:
            yield from _flatten(g)
    else:
        yield geom


def load_subject(path, size, gap, sagitta):
    """The subject's curves, centred and scaled so the silhouette's longest side is `size`.

    Returns (curves, silhouette, dropped pieces). Curves are read twice when
    the subject is scaled a lot, so the flattening tolerance is `sagitta` in
    the finished keyfob's millimetres rather than the subject's own units.
    """
    curves, _, _ = read_curves(path, sagitta)
    xs = [x for c in curves for x, _ in c]
    ys = [y for c in curves for _, y in c]
    extent = max(max(xs) - min(xs), max(ys) - min(ys))
    if extent <= 0:
        raise ConvertError("the subject has no size")
    factor = size / extent
    if not 0.5 < factor < 2:
        curves, _, _ = read_curves(path, sagitta / factor)
    cx, cy = (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2
    curves = [[((x - cx) * factor, (y - cy) * factor) for x, y in c] for c in curves]
    sil, dropped = silhouette_of(curves, gap)
    # Stray marks outside the silhouette counted towards the first estimate.
    minx, miny, maxx, maxy = sil.bounds
    rescale = size / max(maxx - minx, maxy - miny)
    mx, my = (maxx + minx) / 2, (maxy + miny) / 2
    curves = [[((x - mx) * rescale, (y - my) * rescale) for x, y in c] for c in curves]
    sil = affinity.scale(affinity.translate(sil, -mx, -my), rescale, rescale, origin=(0, 0))
    return curves, sil, dropped


def silhouette_of(curves, gap):
    """The region enclosed by the subject's outermost lines, as one polygon.

    The lines are thickened by half the gap so breaks narrower than `gap`
    close, every enclosed hole is filled, and the result is thinned back to
    the lines' centres. Loose strokes outside the silhouette thin away to
    nothing. Returns (polygon, number of separate pieces left out).
    """
    eps = max(gap / 2, 1e-3)
    grown = MultiLineString([c for c in curves if len(c) >= 2]).buffer(eps, quad_segs=8)
    filled = unary_union([Polygon(p.exterior) for p in polygons_of(grown)])
    pieces = sorted(polygons_of(filled.buffer(-eps, quad_segs=8)), key=lambda p: p.area, reverse=True)
    if not pieces or pieces[0].area < (2 * eps) ** 2 * 4:
        raise ConvertError(
            "the subject's silhouette is not closed — close its outer line, "
            "or raise Close gaps")
    main = Polygon(pieces[0].exterior).simplify(SIMPLIFY, preserve_topology=True)
    dropped = sum(1 for p in pieces[1:] if p.area > MIN_PIECE * main.area)
    return main, dropped


def details_of(curves, sil, gap):
    """The subject's detail lines: everything inside the silhouette but its edge."""
    tol = max(gap, 0.2)
    inner = sil.buffer(-tol)
    if inner.is_empty:
        return []
    lines = MultiLineString([c for c in curves if len(c) >= 2]).intersection(inner)
    boundary = sil.exterior
    kept = []
    for line in lines_of(lines):
        # Where the outer line turns a sharp inward corner the thinned
        # silhouette rounds it off, and a scrap of that line ends up inside.
        if line.length < 4 * tol and line.hausdorff_distance(boundary) < 4 * tol:
            continue
        kept.append(line.simplify(SIMPLIFY))
    return kept


def build_keyfob(curves, sil, *, neck_width=12.0, neck_length=30.0, neck_angle=0.0,
                 neck_offset=0.0, fillet=3.0, mirror_mode="silhouette", stitch=0.0,
                 gap=0.6):
    """The keyfob's cut line, detail lines, stitching and fold for a centred silhouette."""
    if mirror_mode not in MIRROR_MODES:
        raise ConvertError(f"mirror must be one of: {', '.join(MIRROR_MODES)}")
    d, n = frame(neck_angle)
    lo, t_all = along(sil, d)
    full_band = strip(d, n, neck_offset, neck_width, lo - 1, t_all + 1)
    in_band = sil.intersection(full_band)
    if in_band.is_empty or in_band.area < 1e-9:
        raise ConvertError("the neck misses the subject — reduce the neck offset")
    t_root = along(in_band, d)[1]
    fold = max(t_root + neck_length / 2, t_all + MIN_GAP / 2)

    # The neck is the part of its band outside the silhouette that reaches the
    # fold; pockets the band crosses elsewhere (between a ghost's tails, say)
    # stay open.
    band = strip(d, n, neck_offset, neck_width, lo - 1, fold + OVERLAP)
    fold_line = LineString([_at(d, n, fold, neck_offset - neck_width),
                            _at(d, n, fold, neck_offset + neck_width)])
    neck = unary_union([p for p in polygons_of(band.difference(sil)) if p.intersects(fold_line)])
    front = unary_union([sil, neck.buffer(SEAL, join_style="mitre")]).intersection(
        unary_union([sil, band]))
    if fillet > 0 and not neck.is_empty:
        # Round the inside corners where the neck meets the silhouette, and
        # only those: the subject's own notches keep their crisp corners.
        closed = front.buffer(fillet, quad_segs=16).buffer(-fillet, quad_segs=16)
        rounds = [p.buffer(SEAL, join_style="mitre")
                  for p in polygons_of(closed.difference(front)) if p.distance(neck) < 1e-6]
        front = unary_union([front, *rounds])
    front = Polygon(_largest(front).exterior)
    cut = _largest(unary_union([front, mirror(front, d, fold)]))
    cut = Polygon(cut.exterior).simplify(SIMPLIFY, preserve_topology=True)
    # Close any crack the unions left, without rounding anything visible.
    cut = _largest(cut.buffer(10 * SEAL, join_style="mitre").buffer(-10 * SEAL, join_style="mitre"))
    cut = Polygon(cut.exterior)

    details = details_of(curves, sil, gap)
    back = [mirror(line, d, fold) for line in details] if mirror_mode == "full" else []

    stitches = []
    if stitch > 0:
        inset = cut.buffer(-stitch, quad_segs=16)
        rings = [p.exterior for p in polygons_of(inset)]
        # Leave the neck's free length unstitched: that is where the ring sits.
        gap_band = strip(d, n, neck_offset, neck_width + 2 * stitch,
                         t_root + stitch, 2 * fold - t_root - stitch)
        for ring in rings:
            open_ring = ring.difference(gap_band) if gap_band.is_valid and gap_band.area > 0 else ring
            stitches.extend(line.simplify(SIMPLIFY) for line in lines_of(open_ring))

    fold_mark = LineString([_at(d, n, fold, neck_offset - neck_width / 2),
                            _at(d, n, fold, neck_offset + neck_width / 2)])
    return {
        "cut": cut, "details": details, "back": back, "stitch": stitches,
        "fold": fold_mark, "foldAt": fold, "root": t_root,
        "neckLength": 2 * (fold - t_root), "direction": d, "normal": n,
    }


def _at(d, n, t, u):
    return (d[0] * t + n[0] * u, d[1] * t + n[1] * u)


def _largest(geom):
    polys = sorted(polygons_of(geom), key=lambda p: p.area, reverse=True)
    if not polys:
        raise ConvertError("the keyfob came out empty")
    return polys[0]


def _fmt(v):
    s = f"{v:.3f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def path_data(coords, closed=False):
    """SVG path data for millimetre coordinates, y flipped to point down."""
    pts = list(coords)
    if closed and len(pts) > 1 and pts[0] == pts[-1]:
        pts = pts[:-1]
    d = " ".join(f"{'M' if i == 0 else 'L'}{_fmt(x)} {_fmt(-y)}" for i, (x, y) in enumerate(pts))
    return d + (" Z" if closed else "")


def keyfob_svg(parts, fold_mark=False, margin=3.0):
    """The keyfob as an SVG in millimetres, one Inkscape layer per kind of line."""
    groups = [("cut", "Cut line", [path_data(parts["cut"].exterior.coords, True)], "")]
    if parts["details"]:
        groups.append(("details", "Details (front)",
                       [path_data(line.coords, line.is_ring) for line in parts["details"]], ""))
    if parts["back"]:
        groups.append(("details-back", "Details (back, mirrored)",
                       [path_data(line.coords, line.is_ring) for line in parts["back"]], ""))
    if parts["stitch"]:
        groups.append(("stitch", "Stitching line",
                       [path_data(line.coords, line.is_ring) for line in parts["stitch"]],
                       ' stroke-dasharray="1.5 1"'))
    if fold_mark:
        groups.append(("fold", "Fold line", [path_data(parts["fold"].coords)],
                       ' stroke-dasharray="2 1.5"'))

    minx, miny, maxx, maxy = parts["cut"].bounds
    x, y = minx - margin, -maxy - margin
    w, h = maxx - minx + 2 * margin, maxy - miny + 2 * margin
    out = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" '
        f'width="{_fmt(w)}mm" height="{_fmt(h)}mm" viewBox="{_fmt(x)} {_fmt(y)} {_fmt(w)} {_fmt(h)}">',
    ]
    for key, label, paths, extra in groups:
        out.append(f'<g id="{key}" inkscape:groupmode="layer" inkscape:label="{label}" fill="none" '
                   f'stroke="{COLOURS[key]}" stroke-width="0.2" stroke-linecap="round" '
                   f'stroke-linejoin="round"{extra}>')
        out.extend(f'<path d="{p}"/>' for p in paths)
        out.append("</g>")
    out.append("</svg>")
    return "\n".join(out) + "\n", [x, y, w, h]


def keyfob(args):
    for name in ("size", "neck_width", "neck_length", "sagitta"):
        if not math.isfinite(getattr(args, name)) or getattr(args, name) <= 0:
            raise ConvertError(f"{name.replace('_', ' ')} must be greater than zero")
    for name in ("fillet", "close_gaps", "stitch"):
        if not math.isfinite(getattr(args, name)) or getattr(args, name) < 0:
            raise ConvertError(f"{name.replace('_', ' ')} cannot be negative")
    if not math.isfinite(args.neck_angle) or not math.isfinite(args.neck_offset):
        raise ConvertError("the neck angle and offset must be numbers")

    curves, sil, dropped = load_subject(args.input, args.size, args.close_gaps, args.sagitta)
    parts = build_keyfob(curves, sil, neck_width=args.neck_width, neck_length=args.neck_length,
                         neck_angle=args.neck_angle, neck_offset=args.neck_offset,
                         fillet=args.fillet, mirror_mode=args.mirror, stitch=args.stitch,
                         gap=args.close_gaps)
    svg, view = keyfob_svg(parts, args.fold_mark)
    d, n = parts["direction"], parts["normal"]
    fold = _at(d, n, parts["foldAt"], args.neck_offset)
    minx, miny, maxx, maxy = parts["cut"].bounds
    sminx, sminy, smaxx, smaxy = sil.bounds
    notes = []
    if dropped:
        notes.append(f"{dropped} separate piece{'s' if dropped > 1 else ''} outside the "
                     "silhouette left out")
    if parts["neckLength"] > args.neck_length + 0.05:
        notes.append(f"neck lengthened to {parts['neckLength']:.1f} mm so the halves do not overlap")
    if args.stitch and not parts["stitch"]:
        notes.append("the stitching line does not fit inside the keyfob")
    return {
        "svg": svg,
        # Geometry for the interactive preview, in the SVG's own y-down coordinates.
        "view": [round(v, 3) for v in view],
        "centre": [0, 0],
        "fold": [round(fold[0], 3), round(-fold[1], 3)],
        "direction": [round(d[0], 6), round(-d[1], 6)],
        # The subject's whole silhouette as drawn, including what the neck
        # swallows; a reference for the preview, never part of the SVG.
        "silhouette": path_data(sil.exterior.coords, True),
        "info": {
            "width": round(maxx - minx, 2), "height": round(maxy - miny, 2),
            "subject": [round(smaxx - sminx, 2), round(smaxy - sminy, 2)],
            "neckLength": round(parts["neckLength"], 2),
            "details": len(parts["details"]), "back": len(parts["back"]),
            "stitch": len(parts["stitch"]), "notes": notes,
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("input")
    parser.add_argument("--size", type=float, default=50.0)
    parser.add_argument("--mirror", choices=MIRROR_MODES, default="silhouette")
    parser.add_argument("--neck-width", type=float, default=12.0)
    parser.add_argument("--neck-length", type=float, default=30.0)
    parser.add_argument("--neck-angle", type=float, default=0.0)
    parser.add_argument("--neck-offset", type=float, default=0.0)
    parser.add_argument("--fillet", type=float, default=3.0)
    parser.add_argument("--close-gaps", type=float, default=0.6)
    parser.add_argument("--stitch", type=float, default=0.0)
    parser.add_argument("--fold-mark", action="store_true")
    parser.add_argument("--sagitta", type=float, default=0.02)
    parser.add_argument("--output", help="also write the SVG here")
    args = parser.parse_args()
    result = keyfob(args)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as stream:
            stream.write(result["svg"])
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    try:
        main()
    except ConvertError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
