"""Sweep topology and measured cross-sections from the Onshape STEP parts."""
import io
import json
from pathlib import Path
import tempfile
import unittest
import warnings

import ezdxf
import numpy as np
import trimesh
from shapely.affinity import scale
from shapely.geometry import LineString, Polygon, Point, shape
from shapely.ops import unary_union

from dxf2stl import chain_curves, load_profile, merged_chains, read_curves, sweep_profile
from slice_svg import planar_section
from gothic import segmented_profile_sweep
from cylinder import mesh_of

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

    def test_junctions_pair_their_straightest_ends(self):
        # A rhombus frame with a cross whose bars end in its corners, in the
        # order a mirrored CAD quarter exports it. Chaining one path at a time
        # turned the vertical bar into a side of the frame at the top corner.
        top, bottom, right, left = (0, 69.28), (0, -69.28), (40, 0), (-40, 0)
        chains = chain_curves([[(0, 0), top], [right, (0, 0)], [top, right], [left, (0, 0)],
                               [top, left], [(0, 0), bottom], [bottom, left], [bottom, right]])
        self.assertEqual(len(chains), 3)
        frame = [chain for chain in chains if chain[0] == chain[-1]]
        self.assertEqual(len(frame), 1)
        self.assertEqual(set(frame[0]), {top, bottom, right, left})
        bars = sorted(sorted(chain) for chain in chains if chain[0] != chain[-1])
        self.assertEqual(bars, [[left, (0, 0), right], [bottom, (0, 0), top]])

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

    def test_segmented_sweep_preserves_profile_and_square_open_ends(self):
        profile = Polygon([(-1, 0), (1, 0), (0, 2)])
        solid = segmented_profile_sweep(profile, [[(0, 0), (5, 0), (10, 0)]])
        mesh = mesh_of(solid)
        self.assertTrue(mesh.is_volume)
        np.testing.assert_allclose(mesh.bounds, [[0, -1, 0], [10, 1, 2]], atol=1e-6)
        self.assertAlmostEqual(mesh.volume, 20, places=5)
        self.assertAlmostEqual(planar_section([mesh], 1).area, 10, places=5)

    def assert_mitre_limited_sections(self, mesh, chain, half_width, heights):
        """Each slice is the path stroked with mitres clipped at four times its half-width."""
        for z in heights:
            expected = LineString(chain).buffer(half_width(z), cap_style='flat',
                                                join_style='mitre', mitre_limit=4)
            actual = planar_section([mesh], z)
            self.assertLess(actual.symmetric_difference(expected).area / expected.area, .001)

    def test_segmented_sweep_clips_sharp_corners_at_every_width(self):
        # Past the mitre limit the prism rebuild used to refuse the corner at
        # any width; now the path splits there and the mitre is clipped.
        # Turns of 155°, 174° and 178°; mitres clip past about 151°.
        for end in ((.94, 4.23), (0, 1), (0, .3)):
            chain = [(0, 0), (10, 0), end]
            for width in (.1, 1, 3):
                with self.subTest(end=end, width=width):
                    profile = Polygon([(-width, 0), (width, 0), (0, 2)])
                    mesh = mesh_of(segmented_profile_sweep(profile, [chain]))
                    self.assertTrue(mesh.is_volume)
                    self.assertEqual(len(mesh.split()), 1)
                    self.assert_mitre_limited_sections(mesh, chain, lambda z: width * (1 - z / 2),
                                                       (.1, .9, 1.7))

    def test_segmented_sweep_opens_a_loop_at_its_only_sharp_corner(self):
        profile = Polygon([(-.5, 0), (.5, 0), (0, 1)])
        loop = [(0, 0), (20, 1), (20, -1), (0, 0)]
        mesh = mesh_of(segmented_profile_sweep(profile, [loop]))
        self.assertTrue(mesh.is_volume)
        self.assertEqual(len(mesh.split()), 1)
        np.testing.assert_allclose(mesh.bounds[:, 2], [0, 1], atol=1e-6)
        self.assert_mitre_limited_sections(mesh, loop, lambda z: .5 * (1 - z), (.1, .5))

    def test_merged_chains_draw_each_stretch_once_without_jogs(self):
        # The second stroke is wholly redrawn inside the first, a hair off.
        chains = merged_chains([[(0, 0), (10, 0)], [(2, 1e-6), (4, 0)], [(5, 0), (15, 0)],
                                [(15, 0), (15.0004, .0003), (15, 5)]])
        self.assertEqual(len(chains), 1)
        # The drawn direction survives, so asymmetric sections keep their side.
        self.assertEqual(tuple(chains[0][0]), (0, 0))
        self.assertEqual(tuple(chains[0][-1]), (15, 5))
        self.assertAlmostEqual(LineString(chains[0]).length, 20, places=6)

    def test_library_sketches_sweep_at_widths_that_failed_by_chance(self):
        # These failed at 0.1, 0.25 and 0.5 but not 1: whether two sweeps
        # met in a way STL rounding breaks was chance, not the width.
        fixture = json.loads((ROOT / 'tools/fixtures/sweep-coincidences.json').read_text())
        section = Polygon(json.loads((ROOT / 'tools/fixtures/gothic-hook-sweep.json').read_text())['profile'])
        for name, drawn in fixture['sketches'].items():
            chains = chain_curves([[tuple(p) for p in chain] for chain in drawn])
            for width in (.1, .25, .5, 1):
                with self.subTest(sketch=name, width=width):
                    profile = scale(section, xfact=width, yfact=width, origin=(0, 0))
                    mesh = sweep_profile(profile, chains)
                    loaded = trimesh.load(io.BytesIO(mesh.export(file_type='stl')), file_type='stl')
                    self.assertTrue(loaded.is_volume)
                    self.assertEqual(len(loaded.split()), 1)
                    # Away from the profile's flats, each slice is the paths
                    # stroked at its half-width there, with limited mitres.
                    for z in (.5 * width, 2.5 * width, 4.5 * width):
                        half = profile.intersection(LineString([(-20, z), (20, z)])).bounds[2]
                        expected = unary_union([
                            LineString(chain).buffer(half, cap_style='flat',
                                                     join_style='mitre', mitre_limit=4)
                            for chain in chains])
                        actual = planar_section([loaded], z)
                        self.assertLess(actual.symmetric_difference(expected).area / expected.area, .01)

    def test_gothic_hook_widths_preserve_sections_and_survive_stl(self):
        fixture = json.loads((ROOT / 'tools/fixtures/gothic-hook-sweep.json').read_text())
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'sketch.dxf'
            doc = ezdxf.new()
            drawing = doc.modelspace()
            for entity in fixture['entities']:
                args = {k: v for k, v in entity.items() if k != 'type'}
                getattr(drawing, 'add_' + entity['type'].lower())(**args)
            doc.saveas(path)
            chains = chain_curves(read_curves(str(path), .02)[0])

        # Both narrower and wider sections used to fail on these arches.
        # Treat the accompanying zero-volume mass warning as a failure too.
        for width in (.7, 1, 2):
            with self.subTest(width=width), warnings.catch_warnings():
                warnings.simplefilter('error', RuntimeWarning)
                profile = scale(Polygon(fixture['profile']), xfact=width, yfact=1, origin=(0, 0))
                mesh = sweep_profile(profile, chains)
                loaded = trimesh.load(io.BytesIO(mesh.export(file_type='stl')), file_type='stl')
                self.assertTrue(loaded.is_volume)
                self.assertEqual(len(loaded.split()), 1)
                np.testing.assert_allclose(loaded.bounds[:, 2], [0, 6], atol=1e-6)
                for z in (.5, 2.5, 4.5):
                    # An independent planar stroke gives the expected filled
                    # area, including the holes between intersecting arches.
                    section = profile.intersection(LineString([(-20, z), (20, z)]))
                    expected = unary_union([
                        LineString(chain).buffer(section.bounds[2], cap_style='flat',
                                                 join_style='mitre', mitre_limit=4)
                        for chain in chains])
                    actual = planar_section([loaded], z)
                    self.assertLess(actual.symmetric_difference(expected).area / expected.area, .001)

    def test_spitzbogen_matches_measured_step_sections(self):
        profile = load_profile(str(ROOT / 'hgc/examples/spitzbogen/profile.svg'), .002)
        curves, _, _ = read_curves(str(ROOT / 'hgc/examples/spitzbogen/frame.dxf'), .002)
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
