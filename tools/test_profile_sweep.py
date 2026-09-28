"""Sweep topology and measured cross-sections from the Onshape STEP parts."""
import io
import json
from pathlib import Path
import unittest

import numpy as np
import trimesh
from shapely.geometry import Polygon, Point, shape

from dxf2stl import chain_curves, load_profile, read_curves, sweep_profile
from slice_svg import planar_section

ROOT = Path(__file__).resolve().parent.parent


class ProfileSweepTests(unittest.TestCase):
    def test_reversing_arch_tangents_are_independent_sweeps(self):
        chains = chain_curves([
            [(0, 2), (0, 1), (0, 0)],
            [(0, 0), (.01, 1), (1, 2)],
        ])
        self.assertEqual(len(chains), 2)
        # A right angle remains a joined, mitred path.
        self.assertEqual(len(chain_curves([[(0, 0), (1, 0)], [(1, 0), (1, 1)]])), 1)

    def test_collinear_profile_vertices_do_not_leave_open_caps(self):
        profile = Polygon([(-1, 0), (0, 0), (1, 0), (0, 2)])
        mesh = sweep_profile(profile, [[(0, 0), (10, 0)]])
        loaded = trimesh.load(io.BytesIO(mesh.export(file_type='stl')), file_type='stl')
        self.assertTrue(loaded.is_volume)
        self.assertAlmostEqual(loaded.volume, 20, places=4)

    def test_overlapping_stepped_paths_are_one_solid(self):
        profile = Polygon([(-1, 0), (1, 0), (1, 1), (.5, 1),
                           (.5, 2), (-.5, 2), (-.5, 1), (-1, 1)])
        mesh = sweep_profile(profile, [[(-5, 0), (5, 0)], [(0, -5), (0, 5)]])
        self.assertTrue(mesh.is_volume)
        self.assertEqual(len(mesh.split()), 1)
        self.assertAlmostEqual(planar_section([mesh], .5).area, 36, places=3)
        self.assertAlmostEqual(planar_section([mesh], 1.5).area, 19, places=3)
        self.assertAlmostEqual(mesh.volume, 55, places=3)

    def test_spitzbogen_matches_measured_step_sections(self):
        profile = load_profile(str(ROOT / 'examples/spitzbogen/profile.svg'), .002)
        curves, _, _ = read_curves(str(ROOT / 'examples/spitzbogen/frame.dxf'), .002)
        mesh = sweep_profile(profile, chain_curves(curves))
        loaded = trimesh.load(io.BytesIO(mesh.export(file_type='stl')), file_type='stl')
        self.assertTrue(loaded.is_volume)
        self.assertEqual(len(loaded.split()), 1)
        np.testing.assert_allclose(loaded.extents, [58.28822, 94.85632, 1.3735655], atol=.02)
        fixture = json.loads((ROOT / 'tools/fixtures/spitzbogen-sections.json').read_text())
        for section in fixture['sections']:
            with self.subTest(z=section['z']):
                expected = shape(section['geometry'])
                actual = planar_section([loaded], section['z'])
                # Compare filled geometry, not merely total area: misplaced
                # edges, filled holes and extra spikes all count as errors.
                error = expected.symmetric_difference(actual).area / expected.area
                self.assertLess(error, .003)
                self.assertFalse(actual.covers(Point(0, 43.7)))
                self.assertAlmostEqual(actual.intersection(expected).area / expected.area, 1, delta=.003)


if __name__ == '__main__':
    unittest.main()
