import json
import math
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from shapely.geometry import LineString, Point, Polygon, box

from dxf2stl import ConvertError
from keyfob import build_keyfob, frame, keyfob_svg, load_subject, mirror

TOOLS = Path(__file__).resolve().parent


def svg(body, size=100):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}mm" height="{size}mm" '
            f'viewBox="0 0 {size} {size}">{body}</svg>')


# A 40 × 60 box with two eyes; the box's top is y = 20 in SVG coordinates.
GHOST = svg('<path d="M30 20 H70 V80 H30 Z" fill="none" stroke="#000"/>'
            '<circle cx="42" cy="35" r="4" fill="none" stroke="#000"/>'
            '<circle cx="58" cy="35" r="4" fill="none" stroke="#000"/>')


class KeyfobTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def subject(self, text, name='subject.svg'):
        path = self.root / name
        path.write_text(text)
        return str(path)

    def build(self, text=GHOST, size=60, gap=0.6, **options):
        curves, sil, dropped = load_subject(self.subject(text), size, gap, 0.02)
        return curves, sil, dropped, build_keyfob(curves, sil, gap=gap, **options)

    def test_silhouette_is_scaled_and_centred_and_keeps_the_eyes_as_details(self):
        _, sil, dropped, parts = self.build(fillet=0)
        minx, miny, maxx, maxy = sil.bounds
        self.assertAlmostEqual(maxy - miny, 60, places=2)
        self.assertAlmostEqual(maxx - minx, 40, places=1)
        self.assertAlmostEqual((minx + maxx) / 2, 0, places=6)
        self.assertAlmostEqual(sil.area, 40 * 60, delta=2)
        self.assertEqual(dropped, 0)
        self.assertEqual(len(parts['details']), 2)
        for eye in parts['details']:
            self.assertTrue(eye.is_ring)
            self.assertAlmostEqual(eye.length, 2 * math.pi * 4 * 60 / 60, delta=0.2)

    def test_cut_line_is_its_own_mirror_image_across_the_fold(self):
        for angle in (0, 35, 90, 200):
            _, _, _, parts = self.build(neck_angle=angle, neck_offset=4)
            d, _ = frame(angle)
            cut = parts['cut']
            flipped = mirror(cut, d, parts['foldAt'])
            self.assertLess(cut.symmetric_difference(flipped).area, 0.05 * cut.length, angle)

    def test_neck_has_the_requested_width_and_length(self):
        _, _, _, parts = self.build(neck_width=10, neck_length=24, fillet=0)
        cut = parts['cut']
        # The box's top is at y = 30 after scaling; the fold sits 12 mm above it.
        self.assertAlmostEqual(parts['foldAt'], 42, places=3)
        self.assertAlmostEqual(parts['neckLength'], 24, places=3)
        across = cut.intersection(LineString([(-30, 36), (30, 36)]))
        self.assertAlmostEqual(across.length, 10, places=2)
        self.assertAlmostEqual(cut.area, 2 * 40 * 60 + 10 * 24, delta=3)
        minx, miny, maxx, maxy = cut.bounds
        self.assertAlmostEqual(maxy - miny, 60 * 2 + 24, places=2)

    def test_back_carries_the_details_only_in_full_mode(self):
        _, _, _, plain = self.build()
        _, _, _, full = self.build(mirror_mode='full')
        self.assertEqual(plain['back'], [])
        self.assertEqual(len(full['back']), len(full['details']))
        d, _ = frame(0)
        for front, back in zip(full['details'], full['back']):
            self.assertLess(mirror(front, d, full['foldAt']).hausdorff_distance(back), 1e-6)
            self.assertGreater(back.centroid.y, full['foldAt'])
        with self.assertRaises(ConvertError):
            self.build(mirror_mode='both')

    def test_fillet_rounds_only_the_neck_junction(self):
        # A notch in the bottom edge must keep its sharp corners.
        notched = svg('<path d="M30 20 H70 V80 H55 L50 70 L45 80 H30 Z" fill="none" stroke="#000"/>')
        _, sil, _, sharp = self.build(notched, fillet=0)
        _, _, _, round_ = self.build(notched, fillet=3)
        notch_tip = Point(0, sil.bounds[1] + 10)   # (50, 70) after centring and scaling
        self.assertLess(round_['cut'].exterior.distance(notch_tip), 0.5)
        added = round_['cut'].symmetric_difference(sharp['cut'])
        # Two corner fillets per half, r²(1 − π/4) each, all of them at the neck's root.
        self.assertAlmostEqual(added.area, 4 * 9 * (1 - math.pi / 4), delta=0.3)
        fold = round_['foldAt']
        near_root = box(-10, 30, 10, 33.1).union(box(-10, 2 * fold - 33.1, 10, 2 * fold - 30))
        self.assertLess(added.difference(near_root).area, 0.05)   # simplification noise only

    def test_neck_grows_when_the_subject_bulges_past_its_root(self):
        # A slanted top: the neck leaves at the low corner, the shape rises beside it.
        slanted = svg('<path d="M30 20 L70 50 V80 H30 Z" fill="none" stroke="#000"/>')
        _, sil, _, parts = self.build(slanted, neck_offset=-15, neck_length=4, neck_width=6)
        self.assertGreater(parts['neckLength'], 4)
        d, _ = frame(0)
        top = max(y for _, y in sil.exterior.coords)
        self.assertGreaterEqual(parts['foldAt'], top + 1 - 1e-6)
        front = parts['cut'].intersection(box(-100, -100, 100, parts['foldAt']))
        self.assertTrue(front.is_valid)

    def test_small_outline_gaps_close_but_large_ones_do_not(self):
        broken = svg('<path d="M30 20 H70 V80 H30 V20.4" fill="none" stroke="#000"/>')
        _, sil, _, _ = self.build(broken, gap=1.0)
        self.assertAlmostEqual(sil.area, 40 * 60, delta=4)
        with self.assertRaises(ConvertError):
            self.build(broken, gap=0.05)

    def test_stray_pieces_outside_the_outline_are_reported_and_ignored(self):
        stray = svg('<path d="M30 20 H70 V80 H30 Z" fill="none" stroke="#000"/>'
                    '<path d="M80 20 H95 V35 H80 Z" fill="none" stroke="#000"/>', size=100)
        _, sil, dropped, parts = self.build(stray, size=60)
        self.assertEqual(dropped, 1)
        self.assertAlmostEqual(sil.bounds[3] - sil.bounds[1], 60, places=2)
        self.assertEqual(parts['details'], [])

    def test_stitching_runs_inside_both_halves_and_stops_at_the_neck(self):
        _, _, _, parts = self.build(stitch=3, neck_length=30)
        self.assertEqual(len(parts['stitch']), 2)
        cut = parts['cut']
        fold = parts['foldAt']
        for line in parts['stitch']:
            self.assertFalse(line.is_ring)
            self.assertAlmostEqual(cut.exterior.distance(line), 3, delta=0.05)
            # Half the neck (15 mm) less the 3 mm the stitching follows it up from the root.
            self.assertTrue(all(abs(y - fold) > 12 - 0.01 for _, y in line.coords))

    def test_neck_that_misses_the_shape_is_an_error(self):
        with self.assertRaises(ConvertError):
            self.build(neck_offset=80)

    def test_svg_is_in_millimetres_with_one_layer_per_kind_of_line(self):
        _, _, _, parts = self.build(mirror_mode='full', stitch=2)
        text, view = keyfob_svg(parts, fold_mark=True)
        for layer in ('cut', 'details', 'details-back', 'stitch', 'fold'):
            self.assertIn(f'<g id="{layer}"', text)
        self.assertIn(f'width="{view[2]:.3f}'.rstrip('0').rstrip('.'), text)
        self.assertTrue(text.count('<path') >= 1 + 2 + 2 + 2 + 1)
        minx, miny, maxx, maxy = parts['cut'].bounds
        self.assertAlmostEqual(view[1], -maxy - 3, places=6)   # y points down in SVG

    def test_command_line_prints_svg_and_preview_geometry(self):
        out = subprocess.run(
            [sys.executable, str(TOOLS / 'keyfob.py'), self.subject(GHOST), '--size', '40',
             '--neck-angle', '-90', '--neck-offset', '-2', '--mirror', 'full', '--fold-mark'],
            capture_output=True, text=True, cwd=TOOLS, check=True)
        data = json.loads(out.stdout)
        self.assertTrue(data['svg'].startswith('<?xml'))
        self.assertEqual(data['direction'], [-1, 0])
        self.assertLess(data['fold'][0], -20)
        self.assertEqual(data['info']['back'], 2)
        bad = subprocess.run([sys.executable, str(TOOLS / 'keyfob.py'), self.subject(GHOST), '--size', '0'],
                             capture_output=True, text=True, cwd=TOOLS)
        self.assertEqual(bad.returncode, 1)
        self.assertEqual(bad.stderr.strip(), 'size must be greater than zero')


if __name__ == '__main__':
    unittest.main()
