#!/usr/bin/env python3
"""trace.py — centerline or outline tracing -> SVG paths.

Usage: trace.py --params <params.json> <preprocessed.png>
Writes the raw SVG to stdout. All paths are plain polylines
(M x y L x y ...); simplification/smoothing happens in simplify.py.

Input must be a binary image with white (255) linework on black (0),
as produced by preprocess.py.
"""
import argparse
import json
import sys

import cv2
import numpy as np

DIRS8 = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


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


def fmt(v: float) -> str:
    s = f"{v:.1f}"
    return s[:-2] if s.endswith(".0") else s


def to_svg(paths: list, width: int, height: int) -> str:
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}">'
    ]
    for path in paths:
        if len(path) < 2:
            continue
        d = [f"M {fmt(path[0][0])} {fmt(path[0][1])}"]
        d += [f"L {fmt(x)} {fmt(y)}" for x, y in path[1:]]
        parts.append(
            f'<path d="{" ".join(d)}" fill="none" stroke="#000" stroke-width="1"/>'
        )
    parts.append("</svg>")
    return "\n".join(parts)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--params", required=True, help="path to JSON params file")
    ap.add_argument("input", help="preprocessed binary PNG")
    args = ap.parse_args()

    with open(args.params, "r", encoding="utf-8") as f:
        p = json.load(f)

    binary = cv2.imread(args.input, cv2.IMREAD_GRAYSCALE)
    if binary is None:
        print(f"error: cannot read image {args.input}", file=sys.stderr)
        sys.exit(1)
    height, width = binary.shape

    if p.get("traceMode", "centerline") == "centerline":
        paths = skeleton_paths(binary > 0)
    else:
        paths = outline_paths(binary)

    sys.stdout.write(to_svg(paths, width, height))


if __name__ == "__main__":
    main()
