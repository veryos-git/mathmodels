import unittest
import xml.etree.ElementTree as ET
import json
import base64
from pathlib import Path
import subprocess
import sys
import tempfile

import trimesh
from shapely.geometry import Polygon

from slice_svg import slice_svg, planar_section


class SliceSVGTests(unittest.TestCase):
    def box(self, size, offset=(0, 0, 0)):
        mesh = trimesh.creation.box(extents=size)
        mesh.apply_translation(offset)
        return mesh

    def test_overlapping_solids_have_no_internal_cut(self):
        svg, stats = slice_svg([self.box([10, 10, 4]),
                                self.box([10, 10, 4], [5, 0, 0])], 2)
        self.assertEqual(stats['contours'], 1)
        self.assertAlmostEqual(stats['area'], 150)
        root = ET.fromstring(svg)
        self.assertEqual(root.attrib['width'], '15.000000000mm')
        self.assertEqual(root.attrib['height'], '10.000000000mm')
        self.assertTrue(root.find('.//{*}path').attrib['d'].endswith('Z'))

    def test_hole_and_island_survive(self):
        ring = Polygon([(0, 0), (10, 0), (10, 10), (0, 10)],
                       [[(2, 2), (8, 2), (8, 8), (2, 8)]])
        mesh = trimesh.creation.extrude_polygon(ring, 4)
        svg, stats = slice_svg([mesh, self.box([2, 2, 4], [5, 5, 2])], 2)
        self.assertEqual(stats['contours'], 3)
        self.assertAlmostEqual(stats['area'], 68)
        self.assertEqual(svg.count(' Z'), 3)

    def test_canvas_stays_aligned_and_y_is_top_view(self):
        meshes = [self.box([10, 20, 2], [0, 0, 1]),
                  self.box([2, 2, 2], [3, 7, 3])]
        low, _ = slice_svg(meshes, 1)
        high, stats = slice_svg(meshes, 3)
        self.assertEqual(ET.fromstring(low).attrib, ET.fromstring(high).attrib)
        self.assertAlmostEqual(stats['area'], 4)
        self.assertIn('7.000000000,2.000000000', high)

    def test_base_and_exact_stack_interface(self):
        meshes = [self.box([10, 10, 2], [0, 0, 1]),
                  self.box([2, 2, 2], [0, 0, 3])]
        self.assertAlmostEqual(slice_svg(meshes, 0)[1]['area'], 100)
        self.assertAlmostEqual(slice_svg(meshes, 2)[1]['area'], 4)

    def test_invalid_and_empty_heights(self):
        mesh = self.box([10, 10, 4])
        for height in [-1, float('nan'), float('inf'), 4, 5]:
            with self.subTest(height=height), self.assertRaises(ValueError):
                slice_svg([mesh], height)
        with self.assertRaisesRegex(ValueError, 'does not intersect'):
            slice_svg([mesh, self.box([2, 2, 2], [0, 0, 8])], 6)

    def test_unclosed_caps_do_not_prevent_closed_slice(self):
        meshes = [self.box([10, 10, 4]), self.box([10, 10, 4], [5, 0, 0])]
        for mesh in meshes:
            mesh.update_faces(abs(mesh.face_normals[:, 2]) < 0.5)
            self.assertFalse(mesh.is_watertight)
        _, stats = slice_svg(meshes, 0.1)
        self.assertAlmostEqual(stats['area'], 150)
        self.assertEqual(stats['contours'], 1)

    def test_planar_fallback_retains_holes_and_overlapping_islands(self):
        ring = Polygon([(0, 0), (10, 0), (10, 10), (0, 10)],
                       [[(2, 2), (8, 2), (8, 8), (2, 8)]])
        meshes = [trimesh.creation.extrude_polygon(ring, 4),
                  self.box([2, 2, 4], [5, 5, 2]),
                  self.box([2, 2, 4], [6, 5, 2])]
        section = planar_section(meshes, 0.1)
        self.assertAlmostEqual(section.area, 70)
        self.assertEqual(len(section.geoms), 2)
        self.assertEqual(sum(len(p.interiors) for p in section.geoms), 1)

    def test_planar_fallback_rejects_actual_open_section(self):
        mesh = self.box([10, 10, 4])
        mesh.update_faces(mesh.face_normals[:, 0] < 0.5)
        with self.assertRaisesRegex(ValueError, 'open contour'):
            slice_svg([mesh], 0.1)

    @unittest.skipUnless((Path(__file__).resolve().parent.parent /
                         'projects/gothic_cnc_wood.v2sproj').exists(),
                        'local user project is not present')
    def test_gothic_cnc_wood_at_point_one_mm(self):
        root = Path(__file__).resolve().parent.parent
        project = json.loads((root / 'projects/gothic_cnc_wood.v2sproj').read_text())
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            for key in ['drawing', 'profile']:
                (tmp / f'{key}.dxf').write_bytes(base64.b64decode(project[key]['data']))
            target = tmp / 'slice.svg'
            args = [sys.executable, 'tools/dxf2stl.py', str(tmp / 'drawing.dxf'),
                    str(target), '--profile', str(tmp / 'profile.dxf'),
                    '--frame-only', '--confine-walls', '--slice-height', '0.1']
            for key, flag in [('scale', 'scale'), ('profileScale', 'profile-scale'),
                              ('sagitta', 'sagitta')]:
                args.extend(['--' + flag, project['settings'][key]])
            result = subprocess.run(args, cwd=root, capture_output=True, text=True, check=True)
            stats = json.loads(result.stdout)
            self.assertEqual(stats['sliceHeight'], 0.1)
            self.assertGreater(stats['area'], 0)
            self.assertGreater(stats['contours'], 1)
            self.assertGreater(len(ET.parse(target).findall('.//{*}path')), 0)

    def test_gothic_converter_exports_slice_through_sweep_vertices(self):
        root = Path(__file__).resolve().parent.parent
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'slice.svg'
            result = subprocess.run([
                sys.executable, 'tools/dxf2stl.py', 'examples/gothic/frame.dxf',
                str(target), '--profile', 'examples/gothic/frame-profile.svg',
                '--cusps', 'examples/gothic/cusps.dxf', '--cusp-profile',
                'examples/gothic/cusp-profile.svg', '--cusp-width', '1',
                '--cusp-height', '1', '--frame-only', '--round-ends',
                '--slice-height', '1',
            ], cwd=root, capture_output=True, text=True, check=True)
            stats = json.loads(result.stdout)
            self.assertGreater(stats['area'], 0)
            self.assertGreater(stats['contours'], 1)
            svg = ET.parse(target).getroot()
            self.assertTrue(svg.attrib['width'].endswith('mm'))
            self.assertTrue(all(path.attrib['d'].endswith('Z')
                                for path in svg.findall('.//{*}path')))


if __name__ == '__main__':
    unittest.main()
