#!/usr/bin/env python3
"""trace.py — turn a raster image into a clean line SVG.

Usage: trace.py --params <params.json> <input-image>

Reads the source image, binarizes it (optional invert / speck removal /
skeletonization), traces it to polylines — either the *centerline* skeleton of
the strokes or the *outline* of the filled regions — then reduces the points
and optionally smooths them to cubic Béziers. The final SVG is written to
stdout; a one-line stats JSON (paths / nodes) goes to stderr.

This is the raster half of the pipeline: the SVG it produces is exactly the
input tools/dxf2stl.py already consumes, so a traced photo flows straight into
the relief builder with no conversion step.
"""
import argparse
import json
import re
import sys

import cv2
import numpy as np

# Eight-connected neighbourhood, so diagonal strokes stay one path.
DIRS8 = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]

CMD_RE = re.compile(r"([ML])\s*([-\d.]+)\s+([-\d.]+)")


# ------------------------------------------------------------- preprocessing

def preprocess(img: np.ndarray, p: dict) -> np.ndarray:
    """Grayscale -> denoise -> threshold -> despeckle -> (optionally) skeleton."""
    if img.ndim == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    img = cv2.medianBlur(img, 3)

    # Default assumption: dark lines on light paper -> lines become white (255).
    flag = cv2.THRESH_BINARY_INV if not p.get("invert", False) else cv2.THRESH_BINARY
    _, binary = cv2.threshold(img, int(p.get("threshold", 128)), 255, flag)

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

    Junction/endpoint pixels (degree != 2) are clustered into nodes; each
    maximal chain of degree-2 pixels between nodes becomes one path, so
    connected linework stays connected. Returns pixel coords as (x, y).
    """
    pts = set(map(tuple, np.argwhere(skel)))  # (y, x)
    if not pts:
        return []

    def nbrs(p):
        return [(p[0] + dy, p[1] + dx) for dy, dx in DIRS8 if (p[0] + dy, p[1] + dx) in pts]

    deg = {p: len(nbrs(p)) for p in pts}

    # Cluster special pixels (endpoints deg==1, junctions deg>=3, isolated deg==0).
    cluster = {}
    cid = 0
    for p in pts:
        if deg[p] == 2 or p in cluster:
            continue
        stack = [p]
        cluster[p] = cid
        while stack:
            cur = stack.pop()
            for n in nbrs(cur):
                if deg[n] != 2 and n not in cluster:
                    cluster[n] = cid
                    stack.append(n)
        cid += 1

    clusters = {}
    for p, c in cluster.items():
        clusters.setdefault(c, []).append(p)

    visited = set()  # frozenset({a, b}) per edge

    def walk(start, first):
        path = [start, first]
        visited.add(frozenset((start, first)))
        prev, cur = start, first
        while cur not in cluster:  # walking through degree-2 chain pixels
            nxts = [n for n in nbrs(cur) if n != prev and frozenset((cur, n)) not in visited]
            if not nxts:
                break
            nxt = nxts[0]
            visited.add(frozenset((cur, nxt)))
            path.append(nxt)
            prev, cur = cur, nxt
        return path

    paths = []
    # Chains hanging off node clusters (endpoints and junctions).
    for pixels in clusters.values():
        for p in pixels:
            for n in nbrs(p):
                if frozenset((p, n)) not in visited:
                    paths.append(walk(p, n))
    # Pure closed loops (every pixel has degree 2).
    for p in pts:
        if p in cluster:
            continue
        for n in nbrs(p):
            if frozenset((p, n)) not in visited:
                path = walk(p, n)
                path.append(p)  # close the loop
                paths.append(path)

    return [[(x, y) for (y, x) in path] for path in paths]


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
    approx = cv2.approxPolyDP(arr, epsilon, closed).reshape(-1, 2)
    if len(approx) < (3 if closed else 2):
        return points
    pts = [(float(x), float(y)) for x, y in approx]
    if closed:
        pts.append(pts[0])
    return pts


def catmull_rom_beziers(pts: list, scale: float, closed: bool) -> list:
    """Convert a polyline to cubic Bézier segments through every point."""
    n = len(pts)
    p = pts[:-1] if closed else pts  # unique points
    m = len(p)
    if m < 3:
        return [("L", pts[1])] if n == 2 else []

    def get(i):
        return p[i % m] if closed else p[min(max(i, 0), m - 1)]

    segs = []
    seg_count = m if closed else m - 1
    for i in range(seg_count):
        p0, p1, p2, p3 = get(i - 1), get(i), get(i + 1), get(i + 2)
        c1 = (p1[0] + (p2[0] - p0[0]) * scale / 6.0, p1[1] + (p2[1] - p0[1]) * scale / 6.0)
        c2 = (p2[0] - (p3[0] - p1[0]) * scale / 6.0, p2[1] - (p3[1] - p1[1]) * scale / 6.0)
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

    binary = preprocess(img, p)
    height, width = binary.shape

    if p.get("traceMode", "centerline") == "centerline":
        paths = skeleton_paths(binary > 0)
    else:
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
