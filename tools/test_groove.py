"""Subtractive sweeps: registered sections, path junctions and saved output."""
import base64
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import ezdxf
import numpy as np
import trimesh
from shapely import make_valid
from shapely.geometry import Polygon

from dxf2stl import (ConvertError, chain_curves, load_sweep_profiles,
                     read_curves, subtract_groove, sweep_profile)
from lid_art import lid_art_mesh
from slice_svg import planar_section, slice_svg

ROOT = Path(__file__).resolve().parent.parent
REFERENCE = ROOT / 'hgc/examples/example6_groove'


class GrooveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        # The two drawings share an intentionally nonzero origin. The cutter
        # is off centre and starts 1 mm above the main profile's base.
        self.main = self.dxf('main', [(8, 20), (12, 20), (12, 23), (8, 23)])
        self.groove = self.dxf('groove', [(10, 21), (11, 21), (11, 24), (10, 24)])
        self.paths = self.root/'paths.dxf'
        doc = ezdxf.new()
        doc.modelspace().add_line((0, 0), (10, 0))
        doc.saveas(self.paths)
        self.paths = str(self.paths)

    def dxf(self, name, points):
        path = self.root/f'{name}.dxf'
        doc = ezdxf.new()
        doc.modelspace().add_lwpolyline(points, close=True)
        doc.saveas(path)
        return str(path)

    def command(self, *flags):
        return [sys.executable, str(ROOT/'tools/dxf2stl.py'), str(self.paths), *map(str, flags),
                '--profile', str(self.main), '--groove-profile', str(self.groove),
                '--frame-only']

    def reload(self, mesh):
        loaded = trimesh.load(io.BytesIO(mesh.export(file_type='stl')), file_type='stl')
        self.assertTrue(loaded.is_volume)
        return loaded

    def test_shared_origin_preserves_elevation_offset_and_width_scale(self):
        for scale in (1, 1.7):
            profile, groove = load_sweep_profiles(self.main, self.groove, .02, scale)
            np.testing.assert_allclose(profile.bounds, [-2*scale, 0, 2*scale, 3])
            np.testing.assert_allclose(groove.bounds, [0, 1, scale, 4])
            paths = [[(0, 0), (10, 0)]]
            mesh = self.reload(subtract_groove(sweep_profile(profile, paths), groove, paths))
            self.assertAlmostEqual(mesh.volume, 100*scale, delta=.001)
            self.assertAlmostEqual(planar_section([mesh], .5).area, 40*scale, places=4)
            self.assertAlmostEqual(planar_section([mesh], 2).area, 30*scale, places=4)

    def test_final_subtraction_clears_crossing_sweeps(self):
        main = Polygon([(-2, 0), (2, 0), (2, 3), (-2, 3)])
        groove = Polygon([(-.5, 1), (.5, 1), (.5, 4), (-.5, 4)])
        paths = [[(-5, 0), (5, 0)], [(0, -5), (0, 5)]]
        mesh = self.reload(subtract_groove(sweep_profile(main, paths), groove, paths))
        self.assertEqual(len(mesh.split()), 1)
        self.assertAlmostEqual(planar_section([mesh], .5).area, 64, places=4)
        self.assertAlmostEqual(planar_section([mesh], 2).area, 45, places=4)
        self.assertAlmostEqual(mesh.volume, 154, delta=.001)

    def test_svg_profiles_keep_their_shared_coordinates(self):
        paths = []
        for name, section in [('main', 'M8 20H12V23H8Z'), ('groove', 'M10 19H11V22H10Z')]:
            path = self.root/f'{name}.svg'
            path.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="20mm" '
                            f'height="30mm" viewBox="0 0 20 30"><path d="{section}"/></svg>')
            paths.append(str(path))
        main, groove = load_sweep_profiles(*paths, .02)
        np.testing.assert_allclose(main.bounds, [-2, 0, 2, 3], atol=2e-6)
        np.testing.assert_allclose(groove.bounds, [0, 1, 1, 4], atol=2e-6)

    def test_preview_stl_and_layered_subjects_keep_the_cut(self):
        payload = json.loads(subprocess.run(self.command('--regions'), capture_output=True,
                                            text=True, check=True).stdout)
        preview = trimesh.load(io.BytesIO(base64.b64decode(payload['wallMesh'])), file_type='stl')
        self.assertAlmostEqual(preview.volume, 100, places=4)
        target = self.root/'groove.stl'
        subprocess.run(self.command(target), capture_output=True, text=True, check=True)
        mesh = trimesh.load(target)
        self.assertTrue(mesh.is_volume)
        self.assertAlmostEqual(mesh.volume, preview.volume, places=4)
        layer = self.root/'layer.json'
        layer.write_text(json.dumps({'file': str(self.paths)}))
        payload = json.loads(subprocess.run(self.command('--regions', '--also', layer),
                                            capture_output=True, text=True, check=True).stdout)
        self.assertEqual(len(payload['drawings']), 2)
        for drawing in payload['drawings']:
            mesh = trimesh.load(io.BytesIO(base64.b64decode(drawing['wallMesh'])), file_type='stl')
            self.assertTrue(mesh.is_volume)
            self.assertAlmostEqual(mesh.volume, 100, places=4)

    def test_requires_main_profile_and_rejects_removing_entire_frame(self):
        result = subprocess.run([sys.executable, str(ROOT/'tools/dxf2stl.py'),
                                 str(self.paths), '--regions', '--groove-profile', str(self.groove)],
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('requires a main sweep profile', result.stderr)
        profile, _ = load_sweep_profiles(self.main, None, .02)
        paths = [[(0, 0), (10, 0)]]
        with self.assertRaisesRegex(ConvertError, 'removes the entire frame'):
            subtract_groove(sweep_profile(profile, paths), profile, paths)

    def test_lid_top_uses_the_same_registered_groove(self):
        config = dict(diameter=60, height=60, lid=True, threaded=False, neck=6, lidTop=2.4)
        plain, _ = lid_art_mesh(self.paths, self.main, config)
        grooved, _ = lid_art_mesh(self.paths, self.main, config, groove_path=self.groove)
        mesh = self.reload(grooved)
        self.assertLess(mesh.volume, plain.volume)
        np.testing.assert_allclose(mesh.bounds, plain.bounds, atol=1e-5)
        self.assertAlmostEqual(mesh.volume/plain.volume, 5/6, places=4)

    @unittest.skipUnless(REFERENCE.exists(), 'Optional supplied groove CAD example is unavailable')
    def test_supplied_curved_example_matches_section_difference(self):
        main, groove = load_sweep_profiles(str(REFERENCE/'Part Studio 2 - profile.dxf'),
                                           str(REFERENCE/'Part Studio 2 - profile_remover_groove.dxf'), .02)
        self.assertAlmostEqual(groove.bounds[1], .609178)
        paths = chain_curves(read_curves(str(REFERENCE/'Part Studio 2 - paths.dxf'), .02)[0])
        positive, cutter = sweep_profile(main, paths), sweep_profile(groove, paths)
        mesh = self.reload(subtract_groove(positive, groove, paths))
        self.assertLess(mesh.volume, positive.volume)
        for z in (.3, .7, .9, 1.05):
            expected = planar_section([positive], z)
            if z > groove.bounds[1]:
                expected = expected.difference(planar_section([cutter], z))
            section = mesh.section(plane_origin=[0, 0, z], plane_normal=[0, 0, 1])
            actual = Polygon()
            for ring in section.discrete:
                actual = actual.symmetric_difference(make_valid(Polygon(ring[:, :2])))
            self.assertLess(actual.symmetric_difference(expected).area/expected.area, .003)
            svg, stats = slice_svg([mesh], z)
            self.assertIn('<path', svg)
            self.assertAlmostEqual(stats['area']/expected.area, 1, delta=.003)


if __name__ == '__main__':
    unittest.main()
