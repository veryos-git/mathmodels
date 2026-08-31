#!/usr/bin/env python3
"""preprocess.py — grayscale, threshold, denoise, optional skeletonize.

Usage: preprocess.py --params <params.json> <input-image> <output.png>

Reads the source image, normalizes it to a binary "lines on black" PNG.
Foreground (the linework to trace) is white (255) on a black (0) background.
"""
import argparse
import json
import sys

import cv2
import numpy as np


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--params", required=True, help="path to JSON params file")
    ap.add_argument("input")
    ap.add_argument("output")
    args = ap.parse_args()

    with open(args.params, "r", encoding="utf-8") as f:
        p = json.load(f)

    threshold = int(p.get("threshold", 128))
    invert = bool(p.get("invert", False))
    min_area = int(p.get("minArea", 0))
    skeletonize = bool(p.get("skeletonize", False))
    trace_mode = p.get("traceMode", "centerline")

    img = cv2.imread(args.input, cv2.IMREAD_GRAYSCALE)
    if img is None:
        print(f"error: cannot read image {args.input}", file=sys.stderr)
        sys.exit(1)

    # Light denoise before binarizing.
    img = cv2.medianBlur(img, 3)

    # Default assumption: dark lines on light paper -> lines become white (255).
    flag = cv2.THRESH_BINARY_INV if not invert else cv2.THRESH_BINARY
    _, binary = cv2.threshold(img, threshold, 255, flag)

    # Remove small specks (connected components below min_area).
    if min_area > 0:
        n, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
        keep = np.zeros_like(binary)
        for i in range(1, n):
            if stats[i, cv2.CC_STAT_AREA] >= min_area:
                keep[labels == i] = 255
        binary = keep

    # Centerline tracing always needs a 1px-wide skeleton.
    if skeletonize or trace_mode == "centerline":
        from skimage.morphology import skeletonize as sk_skeletonize

        binary = (sk_skeletonize(binary > 0).astype(np.uint8)) * 255

    cv2.imwrite(args.output, binary)


if __name__ == "__main__":
    main()
