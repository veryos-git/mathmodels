"""Workflow integration tests: real vector/image readers and printable solids."""
import io
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
import cv2
import numpy as np
import trimesh
from shapely.geometry import Polygon
from shapely.ops import unary_union
from calibration import coupon
from gothic import revolved_ending, solid_union
from dxf2stl import polygons_of, sweep_profile, transform_curves
from trace import preprocess

ROOT = Path(__file__).resolve().parent.parent

class Workflows(unittest.TestCase):
    def test_quarter_revolve_matches_section_and_survives_stl(self):
        profile = Polygon([(-1,0),(1,0),(1,1),(0,2),(-1,1)])
        ending = revolved_ending(profile,[10,0],[0,1],[1,0])
        self.assertTrue(ending.is_watertight)
        sweep = sweep_profile(profile, [[(0,0),(10,0)]])
        mesh = solid_union([sweep, ending])
        loaded = trimesh.load(io.BytesIO(mesh.export(file_type='stl')),file_type='stl')
        self.assertTrue(loaded.is_watertight)
        self.assertEqual(len(loaded.split()),1)
        self.assertAlmostEqual(loaded.bounds[1,0],12,places=5)
        self.assertAlmostEqual(loaded.bounds[0,2],0)

    def test_reference_gothic_is_one_closed_printable_solid(self):
        with tempfile.TemporaryDirectory() as tmp:
            target=Path(tmp)/'gothic.stl'
            command=[sys.executable,'tools/dxf2stl.py','examples/gothic/frame.dxf',str(target),'--profile','examples/gothic/frame-profile.svg','--cusps','examples/gothic/cusps.dxf','--cusp-profile','examples/gothic/cusp-profile.svg','--cusp-width','1','--cusp-height','1','--frame-only','--round-ends']
            result=subprocess.run(command,cwd=ROOT,capture_output=True,text=True,check=True)
            self.assertEqual(json.loads(result.stdout)['regions'],0)
            mesh=trimesh.load(target)
            self.assertTrue(mesh.is_watertight)
            self.assertEqual(len(mesh.split()),1)
            self.assertAlmostEqual(mesh.bounds[0,2],0,places=4)
            self.assertAlmostEqual(mesh.bounds[1,2],2.3866,places=3)
            # The reference frame is ~47.59 x 42.27 mm; curved flattening and
            # mitres can differ by a fraction of a millimetre.
            np.testing.assert_allclose(mesh.extents[:2],[47.59,42.27],atol=.15)
            project=Path(tmp)/'gothic.3mf'
            command[3]=str(project)
            subprocess.run(command,cwd=ROOT,capture_output=True,text=True,check=True)
            with zipfile.ZipFile(project) as archive:
                self.assertTrue(any(name.endswith('.model') for name in archive.namelist()))
                self.assertGreater(sum(archive.read(name).count(b'<triangle ') for name in archive.namelist() if name.endswith('.model')),100)

    def test_frame_only_subject_is_bridged_to_its_boundary(self):
        with tempfile.TemporaryDirectory() as tmp:
            subject=Path(tmp)/'subject.svg'; boundary=Path(tmp)/'boundary.svg'
            subject.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100"><path d="M45 45H55V55H45Z" fill="none" stroke="black"/></svg>')
            boundary.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100"><path d="M5 5H95V95H5Z" fill="none" stroke="black"/></svg>')
            def walls(*extra):
                command=[sys.executable,'tools/dxf2stl.py',str(subject),'--regions','--boundary',str(boundary),'--no-boundary-fit','--wall-width','1',*extra]
                payload=json.loads(subprocess.run(command,cwd=ROOT,capture_output=True,text=True,check=True).stdout)
                return [Polygon(p['exterior'],p['holes']) for p in payload['walls']]
            # The motif floats inside the boundary: two loose pieces ...
            self.assertEqual(len(list(polygons_of(unary_union(walls())))),2)
            # ... until the frame-only model bridges it to the boundary.
            self.assertEqual(len(list(polygons_of(unary_union(walls('--frame-only'))))),1)

    def test_calibration_has_exact_tab_thicknesses_and_labels(self):
        values=[.2,.4,.6,.8]
        mesh=coupon(values)
        loaded=trimesh.load(io.BytesIO(mesh.export(file_type='stl')),file_type='stl')
        self.assertTrue(loaded.is_watertight)
        self.assertEqual(len(loaded.split()),1)
        for i,t in enumerate(values):
            v=loaded.vertices
            patch=v[(v[:,0]>i*12-5.1)&(v[:,0]<i*12+5.1)&(v[:,1]>2)]
            self.assertGreater(len(patch),0)
            self.assertAlmostEqual(patch[:,2].max(),t,places=5)
            self.assertAlmostEqual(patch[:,2].min(),0,places=5)
        self.assertGreater(loaded.bounds[1,2],1.2) # embossed labels on the spine

    def test_shared_transform_keeps_cusp_attachment_registered(self):
        main=[[(0,0),(20,0),(20,20)]]
        cusp=[[(20,10),(15,10),(15,15)]]
        transformed=transform_curves(cusp,2,3,4,centre=(10,10))
        self.assertEqual(transformed[0][0],(33,14))
        self.assertEqual(transform_curves(main,2,3,4)[0][1],(33,-6))

    def test_transparent_background_is_white_paper(self):
        image=np.zeros((40,40,4),dtype=np.uint8)
        image[10:30,10:30,3]=255
        binary=preprocess(image,{'traceMode':'outline','threshold':128})
        self.assertEqual(binary[0,0],0)
        self.assertEqual(binary[20,20],255)

    def test_black_eyes_keep_closed_outlines_in_centerline_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            image=np.full((120,160),255,dtype=np.uint8)
            cv2.circle(image,(45,60),15,0,-1)
            cv2.circle(image,(115,60),15,0,-1)
            cv2.line(image,(20,100),(140,100),0,2)
            path=Path(tmp)/'eyes.png';cv2.imwrite(str(path),image)
            params=Path(tmp)/'params.json'
            def trace(mode):
                params.write_text(json.dumps({'traceMode':'centerline','blackAreas':mode,'blackMinWidth':8,'threshold':128,'simplify':1,'smoothing':0}))
                return subprocess.run([sys.executable,'tools/trace.py','--params',str(params),str(path)],cwd=ROOT,capture_output=True,text=True,check=True).stdout
            preserved=trace('outline');old=trace('none')
            self.assertGreaterEqual(preserved.count('Z'),2)
            self.assertLess(old.count('Z'),preserved.count('Z'))
            self.assertIn('fill="none"',preserved)

if __name__ == '__main__': unittest.main()
