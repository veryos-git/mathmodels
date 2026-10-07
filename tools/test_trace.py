"""Raster-to-SVG regressions: connectivity, real loops, gap repair and filled spots."""
import json
import subprocess
import sys
import tempfile
import unittest
from collections import Counter
from pathlib import Path

import cv2
import numpy as np
from shapely.geometry import LineString
from shapely.ops import polygonize, unary_union
from skimage.morphology import skeletonize

from dxf2stl import MM_PER_PX, svg_curves
from trace import black_regions, preprocess, rdp, skeleton_paths

ROOT = Path(__file__).resolve().parent.parent


def skeleton(points, size=40):
    mask = np.zeros((size, size), dtype=bool)
    for x, y in points:
        mask[y, x] = True
    return mask


class SkeletonTracing(unittest.TestCase):
    def test_corner_has_no_diagonal_shortcut_or_triangle(self):
        paths = skeleton_paths(skeleton([(3, 3), (4, 3), (4, 4)]))
        self.assertEqual(len(paths), 1)
        self.assertEqual(paths[0], [(3, 3), (4, 3), (4, 4)])

    def test_diagonal_stroke_stays_connected(self):
        paths = skeleton_paths(skeleton([(i, i) for i in range(3, 20)]))
        self.assertEqual(len(paths), 1)
        self.assertEqual(len(paths[0]), 17)

    def test_t_and_x_have_shared_junctions(self):
        cases = [
            ([(x, 20) for x in range(10, 31)] + [(20, y) for y in range(10, 20)], 3),
            ([(i, i) for i in range(10, 31)] + [(i, 40-i) for i in range(10, 31)], 4),
        ]
        for pixels, branches in cases:
            with self.subTest(branches=branches):
                paths = skeleton_paths(skeleton(pixels))
                self.assertEqual(len(paths), branches)
                endpoints = Counter(p for path in paths for p in (path[0], path[-1]))
                self.assertEqual(endpoints[(20, 20)], branches)
                self.assertTrue(all(path[0] != path[-1] for path in paths))

    def test_adjacent_junction_pixels_collapse_without_internal_edges(self):
        pixels = ([(x, 20) for x in range(10, 31)]
                  + [(20, y) for y in range(10, 20)]
                  + [(21, y) for y in range(21, 31)])
        paths = skeleton_paths(skeleton(pixels))
        self.assertEqual(len(paths), 4)
        endpoints = Counter(p for path in paths for p in (path[0], path[-1]))
        self.assertEqual(endpoints[(20.5, 20)], 4)
        self.assertTrue(all(len(path) > 2 for path in paths))

    def test_short_real_branch_is_not_merged_with_junction(self):
        paths = skeleton_paths(skeleton([(x, 20) for x in range(10, 31)] + [(20, 19)]))
        self.assertEqual(len(paths), 3)
        self.assertIn([(20, 20), (20, 19)], paths)

    def test_real_loop_is_one_closed_path(self):
        mask = np.zeros((40, 40), np.uint8)
        cv2.rectangle(mask, (10, 10), (30, 30), 255, 1)
        paths = skeleton_paths(mask)
        self.assertEqual(len(paths), 1)
        self.assertEqual(paths[0][0], paths[0][-1])
        self.assertEqual(len(paths[0]), 81)
        self.assertEqual(len(set(paths[0])), 80)

    def test_simplifying_attached_loop_keeps_junction_anchor(self):
        mask = np.zeros((40, 40), np.uint8)
        cv2.rectangle(mask, (10, 10), (30, 30), 255, 1)
        cv2.line(mask, (20, 3), (20, 10), 255, 1)
        paths = skeleton_paths(mask)
        self.assertEqual(len(paths), 2)
        ring = next(path for path in paths if path[0] == path[-1])
        self.assertEqual(ring[0], (20, 10))
        for tolerance in (0.5, 1.5, 8):
            reduced = rdp(ring, tolerance, True)
            self.assertEqual(reduced[0], (20, 10))
            self.assertEqual(reduced[-1], (20, 10))

    def test_empty_and_isolated_pixel_do_not_create_paths(self):
        self.assertEqual(skeleton_paths(skeleton([])), [])
        self.assertEqual(skeleton_paths(skeleton([(10, 10)])), [])


class RasterCleanup(unittest.TestCase):
    def test_closing_repairs_small_break_before_speck_removal(self):
        image = np.full((40, 80), 255, np.uint8)
        image[18:23, 10:30] = 0
        image[18:23, 32:52] = 0
        params = dict(traceMode='outline', minArea=120)
        self.assertFalse(preprocess(image, params).any())
        repaired = preprocess(image, {**params, 'closeGaps': 1})
        self.assertEqual(cv2.connectedComponents(repaired)[0] - 1, 1)
        paths = skeleton_paths(skeletonize(repaired > 0))
        self.assertEqual(len(paths), 1)
        self.assertNotEqual(paths[0][0], paths[0][-1])

    def test_small_closing_preserves_separate_lines_and_large_holes(self):
        image = np.full((90, 120), 255, np.uint8)
        cv2.rectangle(image, (10, 10), (50, 70), 0, 3)
        cv2.line(image, (70, 10), (70, 70), 0, 3)
        cv2.line(image, (80, 10), (80, 70), 0, 3)
        mask = preprocess(image, dict(traceMode='outline', closeGaps=1))
        self.assertEqual(cv2.connectedComponents(mask)[0] - 1, 3)
        self.assertEqual(mask[40, 30], 0)

    def test_thick_leaf_corners_are_not_filled_spots(self):
        mask = np.zeros((120, 120), np.uint8)
        cv2.polylines(mask, [np.array([[15, 15], [95, 60], [15, 95]])], True, 255, 4)
        self.assertFalse(black_regions(mask, 8).any())

    def test_filled_eyes_remain_and_opening_never_shifts_outside_source(self):
        mask = np.zeros((100, 160), np.uint8)
        cv2.circle(mask, (30, 30), 15, 255, -1)
        cv2.circle(mask, (85, 30), 5, 255, -1)
        cv2.line(mask, (10, 70), (140, 70), 255, 3)
        blobs = black_regions(mask, 8)
        self.assertEqual(cv2.connectedComponents(blobs)[0] - 1, 2)
        self.assertEqual(blobs[30, 30], 255)
        self.assertEqual(blobs[30, 85], 255)
        self.assertEqual(blobs[70, 50], 0)
        self.assertFalse(np.any((blobs > 0) & (mask == 0)))


class TraceCommand(unittest.TestCase):
    def trace(self, image, **params):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / 'drawing.png'
            settings = Path(temp) / 'params.json'
            output = Path(temp) / 'drawing.svg'
            cv2.imwrite(str(source), image)
            settings.write_text(json.dumps(dict(
                threshold=128, simplify=1.5, smoothing=0.5,
                blackAreas='outline', blackMinWidth=8) | params))
            result = subprocess.run(
                [sys.executable, str(ROOT / 'tools/trace.py'), '--params', str(settings), str(source)],
                capture_output=True, text=True, check=True)
            output.write_text(result.stdout)
            # Read the actual SVG through the relief builder, including Béziers.
            curves, _, _ = svg_curves(str(output), 0.1, scale=1 / MM_PER_PX)
            return curves, json.loads(result.stderr)

    def test_five_drawn_leaf_outlines_make_five_connected_paintable_faces(self):
        image = np.full((160, 600), 255, np.uint8)
        for x in range(0, 600, 120):
            cv2.polylines(image, [np.array([[15+x, 15], [95+x, 60], [15+x, 125]])], True, 0, 4)
        # Uneven segment lengths at the sharp corners used to make smoothing
        # itself create extra loops, even after the skeleton had been fixed.
        for smoothing in (0, 0.5, 1):
            with self.subTest(smoothing=smoothing):
                curves, stats = self.trace(image, traceMode='centerline', smoothing=smoothing)
                geometry = unary_union([LineString(curve) for curve in curves])
                faces = list(polygonize(geometry))
                self.assertEqual(len(faces), 5)
                self.assertEqual(len(geometry.buffer(0.01).geoms), 5)
                self.assertTrue(all(face.area > 3500 for face in faces))
                self.assertLessEqual(stats['paths'], 15)

    def test_outline_mode_still_traces_both_edges_of_a_stroke(self):
        image = np.full((100, 100), 255, np.uint8)
        cv2.circle(image, (50, 50), 30, 0, 4)
        _, centre = self.trace(image, traceMode='centerline')
        _, outline = self.trace(image, traceMode='outline')
        self.assertEqual(centre['paths'], 1)
        self.assertEqual(outline['paths'], 2)


if __name__ == '__main__':
    unittest.main()
