#!/usr/bin/env python3
"""trace.py — turn a raster image into a clean line SVG.

Usage: trace.py --params <params.json> <input-image>

Reads the source image, binarizes it (optional invert / gap closing / speck
removal / skeletonization), traces it to polylines — either the *centerline* skeleton of
the strokes or the *outline* of the filled regions — then reduces the points
and optionally smooths them to cubic Béziers. The final SVG is written to
stdout; a one-line stats JSON (paths / nodes) goes to stderr.

This is the raster half of the pipeline: the SVG it produces is exactly the
input tools/dxf2stl.py already consumes, so a traced photo flows straight into
the relief builder with no conversion step.
"""
import argparse
import json
import math
import re
import sys

import cv2
import numpy as np

# Eight-connected neighbourhood, so diagonal strokes stay one path.
DIRS8 = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]

CMD_RE = re.compile(r"([ML])\s*([-\d.]+)\s+([-\d.]+)")


# ------------------------------------------------------------- preprocessing

def preprocess(img: np.ndarray, p: dict) -> np.ndarray:
    """Grayscale -> denoise -> threshold -> close gaps -> despeckle -> skeleton."""
    if img.ndim == 3:
        if img.shape[2] == 4:
            alpha = img[:, :, 3:4].astype(float) / 255
            img = (img[:, :, :3] * alpha + 255 * (1-alpha)).astype(np.uint8)
        img = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    img = cv2.medianBlur(img, 3)

    # Default assumption: dark lines on light paper -> lines become white (255).
    flag = cv2.THRESH_BINARY_INV if not p.get("invert", False) else cv2.THRESH_BINARY
    _, binary = cv2.threshold(img, int(p.get("threshold", 128)), 255, flag)

    # Repair faint breaks before removing specks or thinning. Keep this opt-in:
    # closing can also join intentional narrow gaps between neighbouring lines.
    radius = max(0, min(4, int(p.get("closeGaps", 0))))
    if radius:
        kernel = np.ones((2 * radius + 1, 2 * radius + 1), dtype=np.uint8)
        binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)

    # Remove small specks (connected components below min_area).
    min_area = int(p.get("minArea", 0))
    if min_area > 0:
        n, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
        keep = np.zeros_like(binary)
        for i in range(1, n):
            if stats[i, cv2.CC_STAT_AREA] >= min_area:
                keep[labels == i] = 255
        binary = keep

    # Centerline tracing always needs a 1px-wide skeleton.
    if p.get("skeletonize", False) or p.get("traceMode", "centerline") == "centerline":
        from skimage.morphology import skeletonize as sk_skeletonize

        binary = (sk_skeletonize(binary > 0).astype(np.uint8)) * 255

    return binary


# ------------------------------------------------------------------ tracing

def skeleton_paths(skel: np.ndarray) -> list:
    """Trace a 1px skeleton into polylines.

    Collapse each junction to one shared endpoint, without emitting its internal
    pixel edges. Only use a diagonal when there is no orthogonal connection;
    otherwise a three-pixel corner would become a triangular loop. Degree-2
    chains and genuine closed loops each become one path. Returns (x, y).
    """
    pts = set(map(tuple, np.argwhere(skel)))  # (y, x)
    if not pts:
        return []

    def nbrs(p):
        y, x = p
        return [
            (y + dy, x + dx) for dy, dx in DIRS8
            if (y + dy, x + dx) in pts
            and not (dy and dx and ((y + dy, x) in pts or (y, x + dx) in pts))
        ]

    # Stable iteration also makes repeated traces produce identical SVGs.
    adjacent = {p: nbrs(p) for p in sorted(pts)}
    nodes = {}
    groups = []
    for p in adjacent:
        if len(adjacent[p]) <= 2 or p in nodes:
            continue
        cid = len(groups)
        group = [p]
        nodes[p] = cid
        for cur in group:
            for n in adjacent[cur]:
                if len(adjacent[n]) > 2 and n not in nodes:
                    nodes[n] = cid
                    group.append(n)
        groups.append(group)
    # Endpoints are separate nodes, even when directly adjacent to a junction.
    for p in adjacent:
        if len(adjacent[p]) < 2:
            nodes[p] = len(groups)
            groups.append([p])
    centres = [tuple(np.mean(group, axis=0)) for group in groups]

    visited = set()  # frozenset({a, b}) per edge

    def walk(start, first):
        path = [start]
        visited.add(frozenset((start, first)))
        prev, cur = start, first
        while True:
            path.append(cur)
            if cur in nodes or cur == start:
                break
            nxts = [n for n in adjacent[cur] if n != prev]
            if not nxts or frozenset((cur, nxts[0])) in visited:
                break
            nxt = nxts[0]
            visited.add(frozenset((cur, nxt)))
            prev, cur = cur, nxt
        if path[0] in nodes:
            path[0] = centres[nodes[path[0]]]
        if path[-1] in nodes:
            path[-1] = centres[nodes[path[-1]]]
        return path

    paths = []
    for p, cid in nodes.items():
        for n in adjacent[p]:
            if nodes.get(n) != cid and frozenset((p, n)) not in visited:
                paths.append(walk(p, n))
    # Pure closed loops (every pixel has degree 2).
    for p in adjacent:
        if p in nodes:
            continue
        for n in adjacent[p]:
            if frozenset((p, n)) not in visited:
                paths.append(walk(p, n))

    return [[(x, y) for (y, x) in path] for path in paths]


def black_regions(binary: np.ndarray, diameter: int) -> np.ndarray:
    """Keep broad filled features, without cutting small thick corners out of lines."""
    diameter = max(3, min(201, diameter))
    # Odd kernels have a centred anchor; an even opening shifts the result and
    # can put preserved pixels outside the original stroke.
    size = diameter if diameter % 2 else diameter + 1
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size))
    opened = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(opened, connectivity=8)
    _, source_labels, source_stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    keep = np.zeros(n, dtype=np.uint8)
    # Map each opened component back to its original connected stroke/spot.
    sources = np.zeros(n, dtype=np.int32)
    sources[labels.ravel()] = source_labels.ravel()
    for i in range(1, n):
        area = stats[i, cv2.CC_STAT_AREA]
        source_area = source_stats[sources[i], cv2.CC_STAT_AREA]
        # A disk also fits at sharp turns and intersections. Small remnants of
        # a much larger line are not filled spots. Still keep small standalone
        # eyes/dots when the opening covers most of the original component.
        if area >= 2 * diameter * diameter or area >= 0.5 * source_area:
            keep[i] = 255
    return keep[labels]


def outline_paths(binary: np.ndarray) -> list:
    """Trace region outlines via contour detection (potrace-style)."""
    contours, _ = cv2.findContours(binary, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    paths = []
    for c in contours:
        if len(c) < 3:
            continue
        pts = [(int(pt[0][0]), int(pt[0][1])) for pt in c]
        pts.append(pts[0])  # close
        paths.append(pts)
    return paths


# --------------------------------------------------------------- simplifying

def rdp(points: list, epsilon: float, closed: bool) -> list:
    if epsilon <= 0 or len(points) < 3:
        return points
    arr = np.array(points, dtype=np.float32).reshape(-1, 1, 2)
    if closed:
        # Closed approxPolyDP may move/drop the starting point. That point can
        # be a shared junction, so simplify two open arcs with fixed endpoints.
        split = int(np.argmax(np.sum((arr[:, 0] - arr[0, 0]) ** 2, axis=1)))
        if split == 0:
            return points
        first = cv2.approxPolyDP(arr[:split + 1], epsilon, False).reshape(-1, 2)
        second = cv2.approxPolyDP(arr[split:], epsilon, False).reshape(-1, 2)
        approx = np.concatenate((first[:-1], second[:-1]))
    else:
        approx = cv2.approxPolyDP(arr, epsilon, False).reshape(-1, 2)
    if len(approx) < (3 if closed else 2):
        return points
    pts = [(float(x), float(y)) for x, y in approx]
    if closed:
        pts.append(pts[0])
    return pts


def catmull_rom_beziers(pts: list, scale: float, closed: bool) -> list:
    """Cubic smoothing with bounded tangents at unevenly spaced points.

    RDP can leave a tiny corner segment between two long edges. Unbounded
    Catmull–Rom handles then overshoot and form a new loop. Limit each shared
    tangent to a third of its shorter adjacent edge, and keep sharp reversals
    as corners. Both sides of a vertex still use the same tangent.
    """
    n = len(pts)
    p = pts[:-1] if closed else pts  # unique points
    m = len(p)
    if m < 3:
        return [("L", pts[1])] if n == 2 else []

    def get(i):
        return p[i % m] if closed else p[min(max(i, 0), m - 1)]

    def tangent(i):
        prev, cur, nxt = get(i - 1), get(i), get(i + 1)
        incoming = (cur[0] - prev[0], cur[1] - prev[1])
        outgoing = (nxt[0] - cur[0], nxt[1] - cur[1])
        dx, dy = (nxt[0] - prev[0]) * scale / 6, (nxt[1] - prev[1]) * scale / 6
        if any(dx * v[0] + dy * v[1] < 0 for v in (incoming, outgoing)):
            return (0.0, 0.0)
        lengths = [length for v in (incoming, outgoing) if (length := math.hypot(*v)) > 0]
        limit = scale * min(lengths) / 3 if lengths else 0
        length = math.hypot(dx, dy)
        if length > limit:
            dx, dy = dx * limit / length, dy * limit / length
        return dx, dy

    tangents = [tangent(i) for i in range(m)]
    segs = []
    seg_count = m if closed else m - 1
    for i in range(seg_count):
        p1, p2 = get(i), get(i + 1)
        t1, t2 = tangents[i], tangents[(i + 1) % m]
        c1 = (p1[0] + t1[0], p1[1] + t1[1])
        c2 = (p2[0] - t2[0], p2[1] - t2[1])
        segs.append(("C", (c1, c2, p2)))
    return segs


def parse_paths(svg: str) -> list:
    """Extract point lists from our controlled polyline path format."""
    paths = []
    for d in re.findall(r'<path\s+d="([^"]+)"', svg):
        pts = [(float(x), float(y)) for _, x, y in CMD_RE.findall(d)]
        if len(pts) >= 2:
            paths.append(pts)
    return paths


def fmt(v: float) -> str:
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return s if s not in ("", "-0") else "0"


def simplify_svg(svg: str, p: dict) -> tuple:
    """Point reduction + optional smoothing; returns (svg, path_count, node_count)."""
    epsilon = float(p.get("simplify", 0))
    smoothing = max(0.0, min(1.0, float(p.get("smoothing", 0))))
    stroke_width = float(p.get("strokeWidth", 2))

    m = re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', svg)
    width, height = (m.group(1), m.group(2)) if m else ("0", "0")

    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}">'
    ]
    node_count = 0
    path_count = 0
    for raw in parse_paths(svg):
        closed = raw[0] == raw[-1]
        pts = rdp(raw, epsilon, closed)
        if smoothing > 0:
            segs = catmull_rom_beziers(pts, smoothing, closed)
            if not segs:
                continue
            d = [f"M {fmt(pts[0][0])} {fmt(pts[0][1])}"]
            for cmd, vals in segs:
                if cmd == "C":
                    c1, c2, p2 = vals
                    d.append(
                        f"C {fmt(c1[0])} {fmt(c1[1])} {fmt(c2[0])} {fmt(c2[1])} "
                        f"{fmt(p2[0])} {fmt(p2[1])}"
                    )
                else:
                    d.append(f"L {fmt(vals[0])} {fmt(vals[1])}")
            node_count += len(segs) + 1
        else:
            d = [f"M {fmt(pts[0][0])} {fmt(pts[0][1])}"]
            d += [f"L {fmt(x)} {fmt(y)}" for x, y in pts[1:]]
            node_count += len(pts)
        if closed:
            d.append("Z")
        out.append(
            f'<path d="{" ".join(d)}" fill="none" stroke="#000" '
            f'stroke-width="{fmt(stroke_width)}"/>'
        )
        path_count += 1
    out.append("</svg>")
    return "\n".join(out), path_count, node_count


# --------------------------------------------------------------------- main

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--params", required=True, help="path to JSON params file")
    ap.add_argument("input", help="source image (png/jpg/gif/webp/…)")
    args = ap.parse_args()

    with open(args.params, "r", encoding="utf-8") as f:
        p = json.load(f)

    img = cv2.imread(args.input, cv2.IMREAD_UNCHANGED)
    if img is None:
        print(f"error: cannot read image {args.input}", file=sys.stderr)
        sys.exit(1)

    # Preserve broad dark features before skeletonizing line art. A disk opening
    # separates thick interiors (eyes, spots) from ordinary pen strokes.
    raw = preprocess(img, {**p, "traceMode": "outline", "skeletonize": False})
    height, width = raw.shape
    blobs = np.zeros_like(raw)
    if p.get("blackAreas", "none") == "outline" and p.get("traceMode", "centerline") == "centerline":
        blobs = black_regions(raw, int(p.get("blackMinWidth", 8)))
    if p.get("traceMode", "centerline") == "centerline":
        from skimage.morphology import skeletonize as sk_skeletonize
        lines = cv2.bitwise_and(raw, cv2.bitwise_not(blobs))
        paths = skeleton_paths(sk_skeletonize(lines > 0))
        # Closed outlines remain closed throughout simplification; they become
        # paintable faces downstream instead of disappearing into a tiny skeleton.
        paths += outline_paths(blobs)
    else:
        binary = preprocess(img, p)
        paths = outline_paths(binary)

    # Raw polyline SVG, then reduced/smoothed into the final form.
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}">'
    ]
    for path in paths:
        if len(path) < 2:
            continue
        d = [f"M {path[0][0]:.1f} {path[0][1]:.1f}"]
        d += [f"L {x:.1f} {y:.1f}" for x, y in path[1:]]
        parts.append(f'<path d="{" ".join(d)}" fill="none" stroke="#000" stroke-width="1"/>')
    parts.append("</svg>")

    svg, path_count, node_count = simplify_svg("\n".join(parts), p)
    sys.stdout.write(svg)
    print(json.dumps({"paths": path_count, "nodes": node_count}), file=sys.stderr)


if __name__ == "__main__":
    main()
