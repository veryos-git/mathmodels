"""Validate exported geometry after resolving 3MF components and transforms."""
import json
import math
import tempfile
import unittest
import zipfile
from pathlib import Path
from xml.etree import ElementTree as E
import numpy as np
import trimesh
from slicer_3mf import layout, write, prepare
from shapely.geometry import box

class SlicerExport(unittest.TestCase):
    def fixture(self,target,count=13):
        meshes=[]
        for label,extents,pos in [('Frame',(70,80,1),(10,-25,.5)),('Colour',(60,70,.6),(10,-25,.3))]:
            mesh=trimesh.creation.box(extents=extents);mesh.apply_translation(pos);meshes.append((label,mesh))
        plan=layout([70,80,1],target,4,.2)
        variants=[dict(id=str(i),name='Object & '+str(i),parts=[[0,1],[1,2]]) for i in range(count)]
        variants[1]['parts']=[[0,1]]
        return dict(target=target,layout=plan,plates=math.ceil(count/plan['capacity']),pattern='concentric',layerHeight=.2,colours=['#000000','#E4BD68','#96D8AF','#0086D6']),meshes,variants

    def test_both_targets_resolve_to_unique_objects_on_correct_plates(self):
        for target in ['bambu','snapmaker']:
            with self.subTest(target=target),tempfile.TemporaryDirectory() as tmp:
                result,meshes,variants=self.fixture(target,25)
                path=Path(tmp)/'test.3mf';write(path,result,meshes,variants)
                with zipfile.ZipFile(path) as z:
                    model=E.fromstring(z.read('3D/3dmodel.model'))
                    geo=E.fromstring(z.read('3D/Objects/geometry.model'))
                    settings=E.fromstring(z.read('Metadata/model_settings.config'))
                    cfg=json.loads(z.read('Metadata/project_settings.config'))
                items=model.findall('./{*}build/{*}item');self.assertEqual(len(items),25)
                objects={o.get('id'):o for o in model.findall('./{*}resources/{*}object')}
                vertices={o.get('id'):np.array([[float(v.get(k)) for k in 'xyz'] for v in o.findall('.//{*}vertex')]) for o in geo.findall('./{*}resources/{*}object')}
                assignments={}
                for pi,plate in enumerate(settings.findall('plate')):
                    for inst in plate.findall('model_instance'):
                        oid=inst.find("metadata[@key='object_id']").get('value')
                        self.assertNotIn(oid,assignments);assignments[oid]=pi
                self.assertEqual(len(assignments),25)
                plan=result['layout'];cols=math.ceil(math.sqrt(result['plates']));boxes={}
                for item in items:
                    oid=item.get('objectid');pi=assignments[oid]
                    points=np.concatenate([vertices[c.get('objectid')] for c in objects[oid].findall('./{*}components/{*}component')])
                    points+=np.array(list(map(float,item.get('transform').split()[9:])))
                    points[:,0]-=(pi%cols)*plan['bed']*1.2;points[:,1]+=(pi//cols)*plan['bed']*1.2
                    lo,hi=points.min(axis=0),points.max(axis=0)
                    self.assertAlmostEqual(lo[2],0,places=5)
                    self.assertTrue(np.all(lo[:2]>=np.array(plan['origin'])-1e-5))
                    self.assertTrue(np.all(hi[:2]<=np.array(plan['origin'])+plan['bed']+1e-5))
                    x,y,w,h=plan['tower'];self.assertTrue(hi[0]<=x or hi[1]<=y or lo[0]>=x+w or lo[1]>=y+h)
                    for a,b in boxes.setdefault(pi,[]):
                        self.assertTrue(hi[0]<=a[0] or hi[1]<=a[1] or lo[0]>=b[0] or lo[1]>=b[1])
                    boxes[pi].append((lo,hi))
                self.assertEqual([assignments[str(i)] for i in [1,2,3]],[0,0,0])
                self.assertEqual(len(cfg['wipe_tower_x']),result['plates'])
                self.assertEqual(cfg['filament_colour'][0],'#000000')

    def test_selection_and_mixed_frame_keep_required_versions_and_real_frame_geometry(self):
        frame = box(0,0,70,80).difference(box(2,2,68,78))
        drawing = dict(wall_polys=[frame],wall_height=1,cutter=None,frame_mesh=None,
                       z_base=0,effect=None,region_polys=[box(2,2,35,78),box(35,2,68,78)],
                       stacks=[[dict(t=.4,g='1-gold'),dict(t=.2,g='2-green')],
                               [dict(t=.8,g='2-green')]])
        wall_stack = [dict(t=.5,g='1-gold'),dict(t=.5,g='2-green')]
        options=dict(target='bambu',preview=True,selected=[],colours={'1-gold':'#E4BD68','2-green':'#96D8AF'})
        result,geometry,chosen=prepare([drawing],wall_stack,options)
        self.assertEqual([v['id'] for v in chosen],['single','frame','two','outline'])
        self.assertEqual(result['plates'],1)
        self.assertEqual(len({slot for g,slot in chosen[0]['parts']}),1)
        self.assertEqual(len({slot for g,slot in chosen[2]['parts']}),2)
        frame_index=chosen[1]['parts'][0][0]
        self.assertAlmostEqual(geometry[frame_index][1].volume,frame.area)
        self.assertTrue(result['geometry'][frame_index]['paths'])
        # The flat outline version is the filled silhouette, one 0.2 mm layer,
        # printed with the same single hue as the single-hue version.
        outline=geometry[chosen[3]['parts'][0][0]][1]
        lo,hi=outline.bounds
        self.assertAlmostEqual(lo[2],0,places=5);self.assertAlmostEqual(hi[2],.2,places=5)
        self.assertAlmostEqual(outline.volume,70*80*.2,places=3)
        self.assertEqual(chosen[3]['parts'][0][1],chosen[0]['parts'][0][1])
        # Both height patches survive; the browser sorts them before painting.
        heights=[p['z'] for g in result['geometry'] for p in g['paths']]
        self.assertIn(.4,heights);self.assertIn(.6,heights)
        with self.assertRaisesRegex(ValueError,'stale'):
            prepare([drawing],wall_stack,{**options,'selected':['missing']})

    def test_outline_version_takes_the_boundary_size(self):
        crop = box(5,5,45,65)
        drawing = dict(wall_polys=[box(0,0,70,80)],wall_height=1,cutter=None,frame_mesh=None,
                       z_base=0,effect=None,region_polys=[box(6,6,44,64)],crop=crop,
                       stacks=[[dict(t=.4,g='1-gold')]])
        options=dict(target='snapmaker',preview=True,selected=[],colours={'1-gold':'#E4BD68'})
        result,geometry,chosen=prepare([drawing],None,options)
        outline=geometry[chosen[3]['parts'][0][0]][1]
        lo,hi=outline.bounds
        for got,want in zip([lo[0],lo[1],hi[0],hi[1],lo[2],hi[2]],[5,5,45,65,0,.2]):
            self.assertAlmostEqual(got,want,places=5)

    def test_frame_only_version_is_bridged_to_the_boundary(self):
        boundary = box(0,0,70,80)
        rim = boundary.difference(box(1,1,69,79))
        island = box(30,35,40,45).difference(box(31,36,39,44))
        drawing = dict(wall_polys=[rim,island],wall_height=1,cutter=None,frame_mesh=None,
                       z_base=0,effect=None,region_polys=[box(2,2,68,78)],crop=boundary,
                       connection_polys=[box(.5,35,40,36)],connection_mesh=None,
                       stacks=[[dict(t=.4,g='1-gold')]])
        options=dict(target='snapmaker',preview=False,selected=[],colours={'1-gold':'#E4BD68'})
        result,geometry,chosen=prepare([drawing],None,options)
        self.assertEqual([v['id'] for v in chosen],['single','frame','two','outline'])
        bridged=geometry[chosen[1]['parts'][0][0]][1]
        plain=geometry[chosen[2]['parts'][0][0]][1]
        # The Frame-only version carries the rib; the colour versions stay clean.
        self.assertAlmostEqual(plain.volume,rim.area+island.area,places=3)
        self.assertGreater(bridged.volume,plain.volume)

    def test_rejects_required_versions_that_cannot_fit(self):
        for target in ['bambu','snapmaker']:
            with self.assertRaisesRegex(ValueError,'three required'):
                layout([240,240,1],target,4,.2)
            with self.assertRaisesRegex(ValueError,'four required'):
                layout([240,240,1],target,4,.2,required=4)

    def test_reservation_covers_measured_fine_layer_sliced_tower_paths(self):
        # Measured extrusion centreline bounds relative to saved tower position
        # from the real slicers at 0.08 mm, four filaments; include half line width.
        measured = {'bambu':[-2.897,-4.897,37.897,80.147],
                    'snapmaker':[-4.828,-4.828,34.828,84.528]}
        for target,offsets in measured.items():
            plan=layout([79.3,79.3,2],target,4,.08)
            x,y,w,h=plan['tower'];tx,ty=plan['tower_position']
            self.assertGreaterEqual(tx+offsets[0]-.3,x)
            self.assertGreaterEqual(ty+offsets[1]-.3,y)
            self.assertLessEqual(tx+offsets[2]+.3,x+w)
            self.assertLessEqual(ty+offsets[3]+.3,y+h)

    def test_tower_reservation_covers_estimate_brim_and_clearance(self):
        for target in ['bambu','snapmaker']:
            for h in [.08,.2,.28]:
                plan=layout([40,40,5],target,4,h)
                for reserve,estimate in zip(plan['tower'][2:],plan['tower_estimate']):
                    self.assertGreaterEqual(reserve,estimate+2*(plan['brim']+5))

if __name__=='__main__': unittest.main()
