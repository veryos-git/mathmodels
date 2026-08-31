#!/usr/bin/env python3
"""simplify.py — RDP point reduction + optional Bézier smoothing.

Usage: simplify.py --params <params.json>   (raw SVG on stdin, final SVG on stdout)

Expects the polyline SVG produced by trace.py. Applies Douglas-Peucker
point reduction (tolerance = params.simplify, in px) and, when
params.smoothing > 0, converts polylines to smooth cubic Béziers
(Catmull-Rom, tangent scale = smoothing). Sets the final stroke width.
Stats JSON (path/node counts) is written to stderr.
"""
import argparse
import json
import re
import sys

import cv2
import numpy as np

CMD_RE = re.compile(r"([ML])\s*([-\d.]+)\s+([-\d.]+)")


def parse_paths(svg: str) -> list:
    """Extract point lists from our controlled polyline path format."""
    paths = []
    for d in re.findall(r'<path\s+d="([^"]+)"', svg):
        pts = [(float(x), float(y)) for _, x, y in CMD_RE.findall(d)]
        if len(pts) >= 2:
            paths.append(pts)
    return paths


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


def fmt(v: float) -> str:
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return s if s not in ("", "-0") else "0"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--params", required=True, help="path to JSON params file")
    args = ap.parse_args()

    with open(args.params, "r", encoding="utf-8") as f:
        p = json.load(f)

    svg = sys.stdin.read()
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

    sys.stdout.write("\n".join(out))
    print(json.dumps({"paths": path_count, "nodes": node_count}), file=sys.stderr)


if __name__ == "__main__":
    main()
