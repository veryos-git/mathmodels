#!/usr/bin/env python3
"""thumbnail.py — generate a small preview thumbnail for the gallery.

Usage: thumbnail.py <input-image> <output.png> [max-size]
"""
import sys

import cv2


def main() -> None:
    src, dst = sys.argv[1], sys.argv[2]
    max_size = int(sys.argv[3]) if len(sys.argv) > 3 else 160

    img = cv2.imread(src, cv2.IMREAD_COLOR)
    if img is None:
        print(f"error: cannot read image {src}", file=sys.stderr)
        sys.exit(1)
    h, w = img.shape[:2]
    scale = max_size / max(h, w)
    if scale < 1.0:
        img = cv2.resize(img, (max(1, round(w * scale)), max(1, round(h * scale))),
                         interpolation=cv2.INTER_AREA)
    cv2.imwrite(dst, img)


if __name__ == "__main__":
    main()
