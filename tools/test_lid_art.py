import math
import io
import json
import tempfile
import unittest
from pathlib import Path

import ezdxf
import manifold3d as mf
import numpy as np
import trimesh
from shapely.geometry import Polygon

from cylinder import dimensions, export_cylinder, manifold, mesh_of
from dxf2stl import sweep_profile
from lid_art import fit_lid_paths, lid_art_mesh


class LidArtTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.c = dict(diameter=60, height=60, thickness=2.4, bottom=2.4,
                      lid=True, threaded=True, lidTop=2.4, neck=6, pitch=1,
                      clearance=.15, seamGap=.2)
        self.sketch = self.root/'top.dxf'
        doc = ezdxf.new()
        doc.modelspace().add_circle((120, -30), 10)
        doc.modelspace().add_line((110, -30), (130, -30))
        doc.saveas(self.sketch)
        self.profile = self.root/'profile.svg'
        self.profile.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="2mm" height="3mm" viewBox="0 0 2 3"><path d="M0 0H2V3H0Z"/></svg>')

    def test_fits_paths_before_sweeping_and_keeps_profile_dimensions(self):
        profile = Polygon([(-1, 0), (1, 0), (1, 3), (-1, 3)])
        paths, factor = fit_lid_paths([[(10, 20), (110, 20), (110, 70), (10, 70), (10, 20)]], profile, 60)
        points = np.asarray(paths[0])
        self.assertAlmostEqual(np.ptp(points[:, 0])/np.ptp(points[:, 1]), 2)
        self.assertAlmostEqual(np.ptp(points[:, 0]), 100*factor)
        mesh = sweep_profile(profile, paths)
        self.assertAlmostEqual(np.linalg.norm(mesh.vertices[:, :2], axis=1).max(), 30, places=4)
        self.assertAlmostEqual(mesh.extents[2], 3)
        self.assertTrue(mesh.is_volume)

    def test_dxf_is_centered_fitted_and_bonded_to_the_top(self):
        for diameter, width_scale in [(60, 1), (80, 1.7)]:
            c = {**self.c, 'diameter': diameter}
            mesh, info = lid_art_mesh(str(self.sketch), str(self.profile), c, width_scale)
            self.assertTrue(mesh.is_volume)
            self.assertAlmostEqual(np.linalg.norm(mesh.vertices[:, :2], axis=1).max(), diameter/2, places=3)
            np.testing.assert_allclose(mesh.bounds.mean(axis=0)[:2], [0, 0], atol=.02)
            self.assertAlmostEqual(mesh.bounds[0, 2], dimensions(c)[1]-.05, places=4)
            self.assertAlmostEqual(mesh.extents[2], 3, places=4)
            self.assertAlmostEqual(info['profileWidth'], 2*width_scale, places=5)
            self.assertAlmostEqual(info['profileHeight'], 3, places=5)

    def test_requires_lid_profile_and_valid_width(self):
        for c, profile, scale in [({**self.c, 'lid': False}, self.profile, 1),
                                  (self.c, None, 1), (self.c, self.profile, 0),
                                  (self.c, self.profile, math.inf)]:
            with self.assertRaises(ValueError):
                lid_art_mesh(str(self.sketch), str(profile) if profile else None, c, scale)
        with self.assertRaises(ValueError):
            fit_lid_paths([[(0, 0), (1, 0)]], Polygon([(-10, 0), (10, 0), (0, 3)]), 10)

    def test_top_sketch_uses_flat_top_inside_default_chamfer_and_alignment_stop(self):
        c = {**self.c, 'neck': 10, 'threadedDesign': {
            'lidHeight': 20, 'stop': .2, 'lidTopChamfer': .5}}
        mesh, info = lid_art_mesh(str(self.sketch), str(self.profile), c)
        self.assertEqual(info['diameter'], 59)
        self.assertAlmostEqual(np.linalg.norm(mesh.vertices[:, :2], axis=1).max(), 29.5, places=3)
        self.assertAlmostEqual(mesh.bounds[0, 2], 70.2-.05, places=4)

    def test_curved_lid_survives_fitting_and_stl_round_trip(self):
        fixture = json.loads((Path(__file__).parent/'fixtures/lid-sweep-precision.json').read_text())
        doc = ezdxf.new()
        drawing = doc.modelspace()
        for entity in fixture['entities']:
            args = {k: v for k, v in entity.items() if k != 'type'}
            getattr(drawing, 'add_'+entity['type'].lower())(**args)
        doc.saveas(self.sketch)
        profile = self.root/'curved-profile.dxf'
        doc = ezdxf.new()
        doc.modelspace().add_lwpolyline(fixture['profile'], close=True)
        doc.saveas(profile)
        c = {**self.c, 'height': 76.53850412655753, 'neck': 10,
             'threadedDesign': {'lidHeight': 20, 'stop': .2, 'lidTopChamfer': .5}}
        # Include the failing saved-project size, another proportional fit,
        # and ordinary requested diameters. Width changes must remain usable.
        for diameter in (34.66513306362327, 38.349314883541304, 35, 40, 60):
            for width in (1, .7, 1.4):
                with self.subTest(diameter=diameter, width=width):
                    mesh, info = lid_art_mesh(str(self.sketch), str(profile), {**c, 'diameter': diameter}, width)
                    loaded = trimesh.load(io.BytesIO(mesh.export(file_type='stl')), file_type='stl')
                    self.assertTrue(loaded.is_volume)
                    self.assertEqual(len(loaded.split()), 1)
                    self.assertAlmostEqual(np.linalg.norm(loaded.vertices[:, :2], axis=1).max(), (diameter-1)/2, delta=.002)
                    self.assertAlmostEqual(loaded.bounds[0, 2], dimensions(c)[1]-.05, places=4)
                    self.assertAlmostEqual(loaded.extents[2], info['profileHeight'], places=4)
                    self.assertAlmostEqual(info['profileWidth'], 5*width, places=5)

    def test_joined_and_colour_exports_keep_the_decorated_lid_upright(self):
        body = mf.Manifold.cylinder(60, 30, 30, 128)-mf.Manifold.cylinder(60, 25, 25, 128).translate((0, 0, 2.4))
        lid = (mf.Manifold.cylinder(8.6, 30, 30, 128)-mf.Manifold.cylinder(6.2, 27, 27, 128)).translate((0, 0, 54))
        for part, solid in [('body', body), ('lid', lid)]:
            path = self.root/(part+'.stl')
            mesh_of(solid).export(path)
            self.c[part+'Path'] = str(path)
        art, _ = lid_art_mesh(str(self.sketch), str(self.profile), self.c)
        buckets = [('paint', mesh_of(mf.Manifold.cube((100, 50, 1))), 1)]
        joined = self.root/'joined.stl'
        export_cylinder(str(joined), buckets, self.c, lid_art=art)
        mesh = trimesh.load_mesh(joined)
        self.assertTrue(mesh.is_volume)
        self.assertEqual(len(mesh.split()), 2)
        colour_dir = self.root/'colours'
        result = export_cylinder(str(colour_dir), buckets, self.c, True, art)
        self.assertIn('lid-top-art.stl', [f['file'] for f in result['files']])
        for f in result['files']:
            part = trimesh.load_mesh(colour_dir/f['file'])
            self.assertTrue(part.is_volume, f['file'])
            self.assertGreaterEqual(part.bounds[0, 2], -1e-5)
        top = trimesh.load_mesh(colour_dir/'lid-top-art.stl')
        self.assertGreaterEqual(top.bounds[0, 2], 8.6-.05-1e-4)
        shell = trimesh.load_mesh(colour_dir/'lid-shell.stl')
        self.assertLess((manifold(top)^manifold(shell)).volume(), 1e-5)
        self.assertAlmostEqual(top.bounds[1, 2], 8.6+3-.05, places=4)


if __name__ == '__main__':
    unittest.main()
