import math
import os
import io
import tempfile
import unittest
import json
import subprocess
import sys
import shutil
from pathlib import Path

import manifold3d as mf
import numpy as np
import ezdxf
import trimesh

from cylinder import dimensions, export_cylinder, manifold, mesh_of, printable_mesh, surface_inset, wrap_solid


class CylinderTests(unittest.TestCase):
    def setUp(self):
        self.c = dict(diameter=60, height=60, thickness=2.4, bottom=2.4,
                      lid=True, threaded=True, lidTop=2.4, neck=6, pitch=1,
                      clearance=.15, seamGap=.2)
        self.bounds = [0, 0, 100, 50]
        self.flat = mf.Manifold.cube((100, 50, 1))

    def test_full_turn_and_lid_seam_are_closed(self):
        for part in ('body', 'lid'):
            solid = wrap_solid(self.flat, self.bounds, self.c, part)
            mesh = mesh_of(solid)
            self.assertTrue(mesh.is_watertight)
            self.assertTrue(mesh.is_winding_consistent)
            self.assertEqual(len(solid.decompose()), 1)
            self.assertGreater(solid.volume(), 0)
            if part == 'body':
                self.assertAlmostEqual(mesh.bounds[1, 2], 53.9, places=5)
            else:
                self.assertAlmostEqual(mesh.bounds[0, 2], 54.1, places=5)
                self.assertAlmostEqual(mesh.bounds[1, 2], 62.6, places=5)
            self.assertAlmostEqual(mesh.bounds[1, 0], 30.95, places=4)

    def test_plain_shell_height_and_volume(self):
        c = {**self.c, 'lid': False}
        solid = wrap_solid(self.flat, self.bounds, c, 'body')
        expected = math.pi*(30.95**2-29.95**2)*60
        self.assertAlmostEqual(solid.volume()/expected, 1, places=3)
        self.assertEqual(dimensions(c), (60, 60))

    def test_open_rim_chamfer_keeps_wrapped_artwork_closed(self):
        c = {**self.c, 'lid': False, 'topChamfer': .4}
        mesh = printable_mesh(wrap_solid(self.flat, self.bounds, c, 'body'))
        loaded = trimesh.load(io.BytesIO(mesh.export(file_type='stl')), file_type='stl')
        self.assertTrue(loaded.is_volume)
        for z, outer in [(0, 30.95), (59.6, 30.95), (60, 30.55)]:
            vertices = loaded.vertices[np.abs(loaded.vertices[:, 2]-z)<1e-4]
            self.assertGreater(len(vertices), 0)
            self.assertAlmostEqual(np.linalg.norm(vertices[:, :2], axis=1).max(), outer, places=4)
        self.assertAlmostEqual(float(surface_inset(59.8, c, 'body')), .2)

    @unittest.skipUnless(shutil.which('openscad'), 'OpenSCAD is required to check the actual shell')
    def test_scad_open_rim_chamfers_inner_and_outer_edges_only(self):
        source = Path(__file__).with_name('cylinder-container.scad')
        with tempfile.TemporaryDirectory() as directory:
            meshes = []
            for chamfer in (0, .4):
                path = Path(directory)/f'rim-{chamfer}.stl'
                result = subprocess.run(['openscad', '-o', str(path), '-D', 'view="container"',
                    '-D', 'has_lid=false', '-D', 'edge_chamfer=0', '-D', f'top_chamfer={chamfer}',
                    str(source)], env={**os.environ, 'QT_QPA_PLATFORM': 'offscreen'},
                    capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                mesh = trimesh.load_mesh(path)
                self.assertTrue(mesh.is_volume)
                top = mesh.vertices[np.abs(mesh.vertices[:, 2]-60)<1e-4]
                radii = np.linalg.norm(top[:, :2], axis=1)
                inner = radii[radii < 28.8]
                self.assertAlmostEqual(inner.max(), 27.6+chamfer, delta=.001)
                # Boolean intersections may add vertices inside a polygon
                # facet, between its apothem and the nominal corner radius.
                self.assertGreaterEqual(inner.min(), (27.6+chamfer)*math.cos(math.pi/128)-.001)
                self.assertAlmostEqual(radii.max(), 30-chamfer, delta=.001)
                bottom = mesh.vertices[np.abs(mesh.vertices[:, 2])<1e-4]
                self.assertAlmostEqual(np.linalg.norm(bottom[:, :2], axis=1).max(), 30, delta=.001)
                meshes.append(mesh)
            self.assertLess(meshes[1].volume, meshes[0].volume)

    def test_chamfered_artwork_is_closed_and_clears_the_raised_lid_seam(self):
        import numpy as np
        c = {**self.c, 'height': 70, 'neck': 10, 'threadedDesign': {
            'lidHeight': 20, 'stop': .2, 'baseTopChamfer': .5,
            'baseBottomChamfer': .5, 'lidTopChamfer': .5, 'lidBottomChamfer': .5}}
        self.assertEqual(dimensions(c), (60.2, 80.2))
        for part, top in [('body', 60.1), ('lid', 80.2)]:
            solid = wrap_solid(self.flat, self.bounds, c, part)
            mesh = mesh_of(solid)
            self.assertTrue(mesh.is_volume)
            self.assertEqual(len(solid.decompose()), 1)
            edge = mesh.vertices[np.abs(mesh.vertices[:, 2]-top) < 1e-4]
            self.assertGreater(len(edge), 0)
            # The 1 mm relief follows the 0.5 mm outer bevel, embedded 0.05 mm.
            self.assertAlmostEqual(np.linalg.norm(edge[:, :2], axis=1).max(), 30.45, places=4)
            self.assertAlmostEqual(mesh.bounds[1, 2], top, places=4)
            self.assertAlmostEqual(mesh.bounds[0, 2], 0 if part == 'body' else 60.3, places=4)

    def test_repeats_preserve_proportions_and_depth(self):
        # Three 100 mm tiles around and two 50 mm tiles up, at native size.
        c = {**self.c, 'lid': False, 'repeatX': 3, 'repeatY': 2,
             'diameter': (300-3*.05)/math.pi, 'height': 100-.05}
        motif = mf.Manifold.cube((10, 8, 1)).translate((10, 10, 0))
        wrapped = wrap_solid(motif, self.bounds, c, 'body')
        copies = wrapped.decompose()
        self.assertEqual(len(copies), 6)
        for copy in copies:
            mesh = mesh_of(copy)
            self.assertTrue(mesh.is_watertight)
            self.assertAlmostEqual(mesh.extents[2], 8, places=5)
            radii = (mesh.vertices[:, :2]**2).sum(axis=1)**.5
            self.assertAlmostEqual(radii.max()-radii.min(), 1, places=5)
            # Unwrap each small motif's angular span to its surface width.
            import numpy as np
            angles = np.arctan2(mesh.vertices[:, 1], mesh.vertices[:, 0])
            angles = np.angle(np.exp(1j*(angles-angles[0])))
            width = (angles.max()-angles.min())*c['diameter']/2
            self.assertAlmostEqual(width, 10, places=4)

    def test_repeat_limits_are_validated(self):
        for bad in ({'repeatX': 0}, {'repeatY': 1.5}, {'repeatX': 12, 'repeatY': 12}):
            with self.assertRaises(ValueError):
                wrap_solid(self.flat, self.bounds, {**self.c, **bad}, 'body')

    def test_stl_edge_contacts_are_closed_without_losing_small_solids(self):
        touching = (mf.Manifold.cube((1, 1, 1))
                    + mf.Manifold.cube((1, 1, 1)).translate((1, 1, 0)))
        tiny = mf.Manifold.cube((.01, .01, .01)).translate((4, 0, 0))
        solid = touching + tiny
        self.assertFalse(mesh_of(solid).is_watertight)
        mesh = printable_mesh(solid)
        loaded = trimesh.load(io.BytesIO(mesh.export(file_type='stl')), file_type='stl')
        self.assertTrue(loaded.is_volume)
        self.assertAlmostEqual(loaded.volume, solid.volume(), delta=1e-7)
        np.testing.assert_allclose(loaded.bounds, mesh_of(solid).bounds, atol=.00011)
        parts = loaded.split()
        self.assertEqual(len(parts), 2)
        self.assertAlmostEqual(min(p.volume for p in parts), .01**3, places=10)

    def test_printable_conversion_rejects_an_open_input(self):
        invalid = mf.Manifold(mf.Mesh64(np.array([[0., 0, 0], [1, 0, 0], [0, 1, 0]]),
                                       np.array([[0, 1, 2]], dtype=np.uint32)))
        with self.assertRaisesRegex(ValueError, 'closed printable parts'):
            printable_mesh(invalid)

    def test_grooved_elven_cylinder_survives_stl_welding(self):
        fixture = json.loads((Path(__file__).parent/'fixtures/groove-cylinder-precision.json').read_text())
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            doc = ezdxf.new()
            for entity in fixture['entities']:
                args = {k: v for k, v in entity.items() if k != 'type'}
                getattr(doc.modelspace(), 'add_'+entity['type'].lower())(**args)
            doc.saveas(root/'subject.dxf')
            for key in ('profile', 'grooveProfile'):
                doc = ezdxf.new()
                doc.modelspace().add_lwpolyline(fixture[key], close=True)
                doc.saveas(root/(key+'.dxf'))
            c = fixture['cylinder']
            radius, height = c['diameter']/2, c['height']
            shell = (mf.Manifold.cylinder(height, radius, radius, 128)
                     - mf.Manifold.cylinder(height, radius-c['thickness'], radius-c['thickness'], 128)
                     .translate((0, 0, c['bottom'])))
            c['bodyPath'] = str(root/'shell.stl')
            mesh_of(shell).export(c['bodyPath'])
            (root/'cylinder.json').write_text(json.dumps(c))
            (root/'stacks.json').write_text(json.dumps(fixture['stacks']))
            target = root/'wrapped.stl'
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('dxf2stl.py')),
                str(root/'subject.dxf'), str(target), '--profile', str(root/'profile.dxf'),
                '--groove-profile', str(root/'grooveProfile.dxf'), '--stacks', str(root/'stacks.json'),
                '--cylinder', str(root/'cylinder.json')], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            loaded = trimesh.load_mesh(target)
            self.assertTrue(loaded.is_volume)
            # The analytic shell avoids OpenSCAD's coordinate rounding; the
            # volume must still match the saved project to ten parts per million.
            self.assertAlmostEqual(loaded.volume/35318.7446, 1, delta=1e-5)
            self.assertAlmostEqual(loaded.bounds[0, 2], 0, delta=.00011)
            self.assertAlmostEqual(loaded.bounds[1, 2], height, delta=.00011)

    def test_exports_are_closed_and_lid_is_print_oriented(self):
        # Analytic shells isolate wrapping/export checks from OpenSCAD startup.
        c = {**self.c, 'repeatX': 3, 'repeatY': 2}
        body = mf.Manifold.cylinder(60,30,30,128)-mf.Manifold.cylinder(60,25,25,128).translate((0,0,2.4))
        lid = (mf.Manifold.cylinder(8.6,30,30,128)-mf.Manifold.cylinder(6.2,27,27,128)).translate((0,0,54))
        with tempfile.TemporaryDirectory() as root:
            c['bodyPath']=os.path.join(root,'body.stl')
            c['lidPath']=os.path.join(root,'lid.stl')
            mesh_of(body).export(c['bodyPath'])
            mesh_of(lid).export(c['lidPath'])
            buckets=[('1-red',mesh_of(self.flat),1)]
            output=os.path.join(root,'combined.stl')
            result=export_cylinder(output,buckets,c)
            mesh=trimesh.load_mesh(output)
            self.assertTrue(mesh.is_watertight)
            self.assertEqual(result['parts'],2)
            self.assertEqual(len(mesh.split()),2)
            files=export_cylinder(os.path.join(root,'colours'),buckets,c,True)['files']
            self.assertEqual(len(files),4)
            for item in files:
                m=trimesh.load_mesh(os.path.join(root,'colours',item['file']))
                self.assertTrue(m.is_watertight,item['file'])
                self.assertGreaterEqual(m.bounds[0,2],-1e-5)
                if item['file'].startswith('lid-'):
                    self.assertGreater(m.bounds[0,0],40)
                    self.assertLessEqual(m.bounds[1,2],8.6001)

    def test_converter_wraps_intersecting_frame_and_painted_faces(self):
        # Buffered frame junctions contain nearly collinear vertices. Their
        # caps must remain valid after bending and joining to another colour.
        c = {**self.c, 'lid': False, 'repeatX': 3, 'repeatY': 2}
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            drawing = root/'cross.svg'
            drawing.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="50mm" viewBox="0 0 100 50"><path d="M0 0H100V50H0Z M0 25H100 M50 0V50" fill="none" stroke="black"/></svg>')
            c['bodyPath'] = str(root/'shell.stl')
            shell = mf.Manifold.cylinder(60,30,30,128)-mf.Manifold.cylinder(60,27.6,27.6,128).translate((0,0,2.4))
            mesh_of(shell).export(c['bodyPath'])
            config = root/'cylinder.json'
            config.write_text(json.dumps(c))
            stacks = root/'stacks.json'
            stacks.write_text(json.dumps({str(i):[{'g':f'{i%2+1}-colour','t':.6}] for i in range(4)}))
            frame = root/'frame.json'
            frame.write_text(json.dumps([{'g':'1-colour','t':1}]))
            for split in (False, True):
                output = root/('colours' if split else 'combined.stl')
                result = subprocess.run([sys.executable, str(Path(__file__).with_name('dxf2stl.py')),
                    str(drawing), str(output), '--confine-walls', '--cylinder', str(config),
                    '--stacks', str(stacks), '--wall-stack', str(frame),
                    *(['--split'] if split else [])], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                files = [output/f['file'] for f in json.loads(result.stdout)['files']] if split else [output]
                for path in files:
                    mesh = trimesh.load_mesh(path)
                    self.assertTrue(mesh.is_watertight, path.name)
                    self.assertTrue(mesh.is_winding_consistent, path.name)

    def test_gothic_sweep_survives_wrap_and_lid_seams(self):
        project = Path(__file__).resolve().parents[1]
        reference = project/'hgc/examples/gothic'
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            c = {**self.c, 'repeatX': 2, 'repeatY': 2}
            body = mf.Manifold.cylinder(60,30,30,128)-mf.Manifold.cylinder(60,25,25,128).translate((0,0,2.4))
            lid = (mf.Manifold.cylinder(8.6,30,30,128)-mf.Manifold.cylinder(6.2,27,27,128)).translate((0,0,54))
            for name, solid in [('body',body),('lid',lid)]:
                c[name+'Path'] = str(root/(name+'.stl'))
                mesh_of(solid).export(c[name+'Path'])
            config = root/'cylinder.json'
            config.write_text(json.dumps(c))
            output = root/'swept.stl'
            result = subprocess.run([sys.executable, str(project/'tools/dxf2stl.py'),
                str(reference/'frame.dxf'), str(output), '--profile', str(reference/'frame-profile.svg'),
                '--cusps', str(reference/'cusps.dxf'), '--cusp-profile', str(reference/'cusp-profile.svg'),
                '--cusp-width', '1', '--cusp-height', '1', '--frame-only', '--round-ends',
                '--cylinder', str(config)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            mesh = trimesh.load_mesh(output)
            self.assertTrue(mesh.is_watertight)
            self.assertTrue(mesh.is_winding_consistent)
            self.assertEqual(len(mesh.split()), 2)


if __name__ == '__main__':
    unittest.main()
