"""Independent section dimensions must agree in previews, exports and lid sweeps."""
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

from dxf2stl import ConvertError, load_profile_sections, load_sweep_profiles
from lid_art import lid_art_mesh

ROOT = Path(__file__).resolve().parent.parent


class ProfileScalingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.main = self.section('main', [(8, 20), (12, 20), (12, 23), (8, 23)])
        self.groove = self.section('groove', [(10, 21), (11, 21), (11, 24), (10, 24)])
        self.paths = self.path('paths', 0)
        self.cusps = self.path('cusps', 10)

    def section(self, name, points):
        path = self.root / f'{name}.dxf'
        doc = ezdxf.new()
        doc.modelspace().add_lwpolyline(points, close=True)
        doc.saveas(path)
        return str(path)

    def path(self, name, y):
        path = self.root / f'{name}.dxf'
        doc = ezdxf.new()
        doc.modelspace().add_line((0, y), (10, y))
        doc.saveas(path)
        return str(path)

    def preview(self, *flags):
        command = [sys.executable, str(ROOT / 'tools/dxf2stl.py'), self.paths,
                   '--profile', self.main, '--frame-only', *map(str, flags)]
        result = subprocess.run([*command, '--regions'], capture_output=True, text=True, check=True)
        payload = json.loads(result.stdout)
        mesh = trimesh.load(io.BytesIO(base64.b64decode(payload['wallMesh'])), file_type='stl')
        self.assertTrue(mesh.is_volume)
        return mesh, command

    def test_each_section_scales_its_axes_and_keeps_the_shared_origin(self):
        main, groove = load_sweep_profiles(self.main, self.groove, .02, 2, .5, .5, 1.5)
        np.testing.assert_allclose(main.bounds, [-4, 0, 4, 1.5])
        np.testing.assert_allclose(groove.bounds, [0, 1.5, .5, 6])
        for scales in [(0, 1, 1, 1), (1, -1, 1, 1), (1, 1, float('nan'), 1),
                       (1, 1, 1, float('inf'))]:
            with self.subTest(scales=scales), self.assertRaises(ConvertError):
                load_sweep_profiles(self.main, self.groove, .02, *scales)

    def test_profile_scales_leave_path_length_and_cusps_independent(self):
        for width, height in [(2, .5), (3, 1)]:
            with self.subTest(width=width, height=height):
                mesh, _ = self.preview('--profile-scale', width, '--profile-height-scale', height,
                                       '--cusps', self.cusps, '--cusp-width', .25, '--cusp-height', 2,
                                       '--scale', 2)
                main, cusp = sorted(mesh.split(), key=lambda part: part.bounds[0, 1])
                np.testing.assert_allclose(main.bounds, [[0, -2*width, 0], [20, 2*width, 3*height]], atol=1e-5)
                np.testing.assert_allclose(cusp.bounds, [[0, 19.5, 0], [20, 20.5, 6]], atol=1e-5)
        custom = self.section('custom-cusp', [(-1, 0), (1, 0), (1, 1), (-1, 1)])
        mesh, _ = self.preview('--profile-scale', 3, '--profile-height-scale', 2,
                               '--cusps', self.cusps, '--cusp-profile', custom,
                               '--cusp-width', .5, '--cusp-height', 2, '--cusp-z', 1)
        _, cusp = sorted(mesh.split(), key=lambda part: part.bounds[0, 1])
        np.testing.assert_allclose(cusp.bounds, [[0, 9.5, 1], [10, 10.5, 3]], atol=1e-5)

    def test_independent_groove_preview_and_stl_match(self):
        mesh, command = self.preview('--profile-scale', 2, '--profile-height-scale', .5,
                                      '--groove-profile', self.groove, '--groove-width', .5,
                                      '--groove-height', .5)
        np.testing.assert_allclose(mesh.extents, [10, 8, 1.5], atol=1e-5)
        self.assertAlmostEqual(mesh.volume, 115, places=4)
        target = self.root / 'scaled.stl'
        subprocess.run([*command[:3], str(target), *command[3:]], capture_output=True, text=True, check=True)
        saved = trimesh.load(target)
        self.assertTrue(saved.is_volume)
        np.testing.assert_allclose(saved.bounds, mesh.bounds, atol=1e-5)
        self.assertAlmostEqual(saved.volume, mesh.volume, places=4)

    def test_lid_sweep_uses_both_section_scales(self):
        config = dict(diameter=60, height=60, lid=True, threaded=False, neck=6, lidTop=2.4)
        mesh, info = lid_art_mesh(self.paths, self.main, config, profile_scale=2,
                                  profile_height_scale=.5, groove_path=self.groove,
                                  groove_width=.5, groove_height=.5)
        self.assertTrue(mesh.is_volume)
        self.assertEqual(info['profileWidth'], 8)
        self.assertEqual(info['profileHeight'], 1.5)
        self.assertAlmostEqual(mesh.extents[2], 1.5, places=4)
        self.assertAlmostEqual(mesh.volume / mesh.extents[0], 11.5, places=4)

    def test_editor_sections_match_registered_sweep_coordinates(self):
        cusp = self.section('cusp', [(40, 20), (42, 20), (42, 21), (40, 21)])
        sections = load_profile_sections(self.main, self.groove, .02, cusp)
        np.testing.assert_allclose(sections['main'].bounds, [-2, 0, 2, 3])
        np.testing.assert_allclose(sections['groove'].bounds, [0, 1, 1, 4])
        np.testing.assert_allclose(sections['cusp'].bounds, [-1, 0, 1, 1])
        response = subprocess.run([sys.executable, str(ROOT/'tools/dxf2stl.py'), self.main,
                                   '--profile-sections', '--groove-profile', self.groove,
                                   '--cusp-profile', cusp], capture_output=True, text=True, check=True)
        payload = json.loads(response.stdout)
        for name, poly in sections.items():
            np.testing.assert_allclose(payload[name]['bounds'], poly.bounds)
            np.testing.assert_allclose(payload[name]['exterior'], poly.exterior.coords)
        fallback = load_profile_sections(self.main, None, .02)
        self.assertTrue(fallback['main'].equals(fallback['cusp']))
        self.assertIsNone(fallback['groove'])

    def test_offsets_apply_after_scaling_and_preserve_horizontal_registration(self):
        main, groove = load_sweep_profiles(self.main, self.groove, .02, 2, .5, .5, 1.5,
                                           profile_z=1.2, groove_z=-.3)
        np.testing.assert_allclose(main.bounds, [-4, 1.2, 4, 2.7])
        np.testing.assert_allclose(groove.bounds, [0, 1.2, .5, 5.7])
        for key in ['profile_z', 'groove_z']:
            for value in [float('nan'), float('inf')]:
                with self.subTest(key=key, value=value), self.assertRaises(ConvertError):
                    load_sweep_profiles(self.main, self.groove, .02, **{key:value})

    def test_signed_offsets_match_preview_and_stl_and_change_the_cut(self):
        mesh, command = self.preview('--profile-z', .4, '--groove-profile', self.groove,
                                      '--groove-z', -.2, '--cusps', self.cusps,
                                      '--cusp-width', .25, '--cusp-height', 1, '--cusp-z', -.3)
        main, cusp = sorted(mesh.split(), key=lambda part: part.bounds[0, 1])
        np.testing.assert_allclose(main.bounds, [[0, -2, .4], [10, 2, 3.4]], atol=1e-5)
        np.testing.assert_allclose(cusp.bounds, [[0, 9.5, -.3], [10, 10.5, 2.7]], atol=1e-5)
        np.testing.assert_allclose(main.volume, 94, rtol=1e-6)
        target = self.root/'positioned.stl'
        subprocess.run([*command[:3], str(target), *command[3:]], capture_output=True, text=True, check=True)
        saved = trimesh.load(target)
        np.testing.assert_allclose(saved.bounds, mesh.bounds, atol=1e-5)
        self.assertAlmostEqual(saved.volume, mesh.volume, places=4)

    def test_lid_offsets_use_the_same_vertical_registration(self):
        config = dict(diameter=60, height=60, lid=True, threaded=False, neck=6, lidTop=2.4)
        original, _ = lid_art_mesh(self.paths, self.main, config, groove_path=self.groove)
        shifted, info = lid_art_mesh(self.paths, self.main, config, groove_path=self.groove,
                                     profile_z=.5, groove_z=.5)
        np.testing.assert_allclose(shifted.bounds, original.bounds + [0, 0, .5], atol=1e-5)
        np.testing.assert_allclose(original.volume, shifted.volume, rtol=1e-6)
        self.assertEqual(info['profileHeight'], 3)


if __name__ == '__main__':
    unittest.main()
