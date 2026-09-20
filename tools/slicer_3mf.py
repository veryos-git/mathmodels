"""Selectable, plate-aware Bambu P1S / Snapmaker U1 project exports.

Profiles originate from the supplied reference projects. Geometry is shared by
assemblies; only assemblies appear in <build>. Plate coordinates follow each
slicer's ceil(sqrt(plate_count)) grid with 20% gaps.
"""
import itertools
import json
import math
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

import numpy as np
import trimesh
from shapely.geometry import Polygon
from shapely.ops import unary_union

CORE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02'
PROD = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06'
REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
MODEL_REL = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel'
IDENTITY = '1 0 0 0 1 0 0 0 1'
ET.register_namespace('', CORE)
ET.register_namespace('p', PROD)


def minimum_depth(height):
    return float(np.interp(height, [5, 100, 250, 350], [5, 20, 40, 60]))


def layout(size, target, colours, layer_height, required=3):
    """Conservative common slots: reserve for all export filaments on every plate.

    Use rectangular towers, no cone/ribs, and at least 5 mm clearance beyond
    the estimated brim. Reserve at least 54 mm each way to absorb line rounding.
    Slots are identical for preview and export; no object is scaled to fit.
    """
    if not all(math.isfinite(s) and s > 0 for s in size) or size[2] > (250 if target == 'bambu' else 270):
        raise ValueError('Model dimensions are outside the supported printable volume.')
    bed = 256. if target == 'bambu' else 270.
    origin = [0., 0.] if target == 'bambu' else [.5, 1.]
    width = 35. if target == 'bambu' else 30.
    brim = 3. if target == 'bambu' else 5.
    # Snapmaker's preview hardcodes 0.2; cover that and the actual layer height.
    h = min(.2, layer_height) if target == 'snapmaker' else layer_height
    spacing = 1.5 if target == 'bambu' else 1.2
    depth = max(minimum_depth(size[2]), 45 * max(1, colours - 1) / h / width * spacing)
    # Sliced tower paths include perimeters and priming blocks omitted by the
    # preview formula. Fine-layer CLI tests showed up to ~12 mm extra depth.
    # Reserve 25% or 15 mm (whichever is larger), beyond brim and clearance.
    depth_headroom = max(15., depth * .25)
    reserve = [max(54., math.ceil(width + 2 * (brim + 5))),
               max(54., math.ceil(depth + depth_headroom + 2 * (brim + 5)))]
    edge, gap = 8., 5.
    tower = [origin[0] + bed - edge - reserve[0],
             origin[1] + bed - edge - reserve[1], *reserve]
    slots = []
    # P1S excluded front-left 18 x 28 corner; keep an extra margin around it.
    for row in range(max(0, int((bed - 2 * edge + gap) // (size[1] + gap)))):
        for col in range(max(0, int((bed - 2 * edge + gap) // (size[0] + gap)))):
            x, y = origin[0] + edge + col * (size[0] + gap), origin[1] + edge + row * (size[1] + gap)
            if target == 'bambu' and x < 23 and y < 33:
                continue
            if x + size[0] > tower[0] and y + size[1] > tower[1]:
                continue
            slots.append([x, y])
    # Also try a shelf above the front exclusion by shifting the whole grid.
    if target == 'bambu':
        alternate = []
        for row in range(max(0, int((bed - edge - 33 + gap) // (size[1] + gap)))):
            for col in range(max(0, int((bed - 2 * edge + gap) // (size[0] + gap)))):
                x, y = edge + col * (size[0] + gap), 33 + row * (size[1] + gap)
                if x + size[0] <= tower[0] or y + size[1] <= tower[1]:
                    alternate.append([x, y])
        if len(alternate) > len(slots):
            slots = alternate
    if len(slots) < required:
        words = {1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five'}
        count = words.get(required, str(required))
        raise ValueError(f'The {count} required versions do not fit together on plate 1 with prime-tower clearance. Reduce the model dimensions and try again.')
    return dict(bed=bed, origin=origin, slots=slots, capacity=len(slots), tower=tower,
                tower_position=[tower[0] + brim + 5, tower[1] + brim + 5],
                tower_estimate=[width, depth], brim=brim, size=size)


def profile(target, colours, layer_height, pattern, plan, plates):
    d = json.loads((Path(__file__).parent / '3mf_profiles' / (target + '.json')).read_text())
    # Keep four material/tool slots, as in both supplied machine profiles.
    colours = colours + ['#FFFFFF'] * (4 - len(colours))
    d.update(filament_colour=colours, filament_diameter=['1.75'] * 4,
             filament_type=['PLA'] * 4, layer_height=str(layer_height),
             initial_layer_print_height=str(layer_height),
             top_surface_pattern=pattern, bottom_surface_pattern=pattern,
             enable_prime_tower='1', prime_tower_width=str(plan['tower_estimate'][0]),
             prime_tower_brim_width=str(plan['brim']), wipe_tower_rotation_angle='0',
             wipe_tower_x=[str(plan['tower_position'][0])] * plates,
             wipe_tower_y=[str(plan['tower_position'][1])] * plates,
             timelapse_type='0', brim_type='no_brim', skirt_loops='0',
             print_sequence='by layer', enable_support='0')
    if target == 'bambu':
        d.update(prime_tower_rib_wall='0', prime_tower_extra_rib_length='0',
                 prime_tower_infill_gap='150%', filament_prime_volume=['45'] * 4,
                 prime_volume_mode='Default')
    else:
        d.update(version='01.10.01.50', bed_exclude_area=[], wipe_tower_wall_type='rectangle', wipe_tower_cone_angle='0',
                 wipe_tower_extra_rib_length='0', wipe_tower_extra_spacing='120%',
                 prime_volume='45', purge_in_prime_tower='0')
    return d


def outlines(mesh):
    """Top-facing patches in height order, so higher colour layers cover lower ones."""
    faces = mesh.triangles[mesh.face_normals[:, 2] > 1e-6]
    heights = np.round(faces[:, :, 2].mean(axis=1), 3)
    patches = []
    for height in np.unique(heights):
        geom = unary_union([Polygon(t[:, :2]) for t in faces[heights == height]])
        geom = geom.simplify(.05, preserve_topology=True)
        polys = [geom] if geom.geom_type == 'Polygon' else getattr(geom, 'geoms', [])
        paths = []
        for poly in polys:
            if poly.geom_type != 'Polygon':
                continue
            for ring in [poly.exterior, *poly.interiors]:
                paths.append('M' + ' L'.join(f'{x:.3f},{-y:.3f}' for x, y in ring.coords) + 'Z')
        patches.append(dict(z=float(height), path=''.join(paths)))
    return patches


def prepare(layers, wall_stack, options):
    from dxf2stl import (colour_buckets, wall_solids, region_solids,
                         is_palette_label, outline_solid, OUTLINE_THICKNESS)
    if not isinstance(options, dict):
        raise ValueError('Slicer options must be a JSON object.')
    target = options.get('target', 'snapmaker')
    if target not in ('bambu', 'snapmaker'):
        raise ValueError('Unknown slicer target')
    h = float(options.get('layerHeight', .2))
    if not math.isfinite(h) or not .08 <= h <= .28:
        raise ValueError('Choose a slicing layer height between 0.08 and 0.28 mm.')
    pattern = options.get('pattern', 'monotonicline')
    from dxf2stl import SURFACE_PATTERNS
    if pattern not in SURFACE_PATTERNS:
        raise ValueError('Unknown surface pattern')
    merged, walls, regions = colour_buckets(layers, wall_stack)
    merged = [m for m in merged if len(m[1].faces)]
    palette = [m for m in merged if is_palette_label(m[0])]
    fixed = [m for m in merged if not is_palette_label(m[0])]
    if not palette:
        raise ValueError('Paint at least one filled region before exporting colour variations.')
    colour_map = options.get('colours', {})
    if not isinstance(colour_map, dict):
        raise ValueError('Filament colours must map group names to hex colours.')
    colours = []
    def slot(colour):
        if not isinstance(colour, str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', colour):
            raise ValueError('Filament colours must be six-digit hex colours.')
        colour = colour.upper()
        if colour not in colours:
            colours.append(colour)
        return colours.index(colour) + 1
    palette_slots = [slot(colour_map.get(m[0], ['#E4BD68', '#96D8AF', '#0086D6', '#000000'][i % 4])) for i,m in enumerate(palette)]
    black = slot('#000000')
    if len(colours) > 4:
        raise ValueError('These printer profiles support four filament colours, including the required black frame. Choose at most three other hues.')
    hue = next((s for s in palette_slots if s != black), None)
    if hue is None:
        raise ValueError('Choose at least one non-black hue for the required two-hue version.')
    frame_meshes, face_meshes = [], []
    for d in layers:
        frame_meshes.extend(m for m,g in wall_solids(d['wall_polys'], d['wall_height'], d['cutter'], wall_stack, d['frame_mesh'], d['z_base']))
        face_meshes.extend(m for m,g in region_solids(d['region_polys'], d['stacks'], d['cutter'], d['z_base'], d['effect']))
    if not frame_meshes or not face_meshes:
        raise ValueError('This export needs both a frame and filled regions for the required versions.')
    frame = trimesh.util.concatenate(frame_meshes)
    faces = trimesh.util.concatenate(face_meshes)
    # A frame-only print is the boundary plus the subject's own lines; where the
    # subject floats, the ribs planned with it bridge the gap. The Frame-only
    # version prints those ribs, while the colour versions keep the clean frame.
    frame_connected = None
    if any(d.get('connection_polys') or d.get('connection_mesh') is not None for d in layers):
        bridges = []
        for d in layers:
            if d.get('connection_mesh') is not None:
                mesh = d['connection_mesh'].copy()
                mesh.apply_translation((0.0, 0.0, d['z_base']))
                bridges.append(mesh)
            polys = list(d['wall_polys']) + list(d.get('connection_polys') or [])
            bridges.extend(m for m,g in wall_solids(polys, d['wall_height'], d['cutter'], wall_stack, d['frame_mesh'], d['z_base']))
        if bridges:
            frame_connected = trimesh.util.concatenate(bridges)
    # The flat version: the outermost outline — the boundary when one crops the
    # pattern, the frame's own silhouette otherwise — extruded one 0.2 mm layer.
    outline = outline_solid(layers, OUTLINE_THICKNESS)
    if outline is None or not len(outline.faces):
        raise ValueError('Could not determine the outer outline for the flat 0.2 mm version.')
    all_mesh = trimesh.util.concatenate([m for _,m,_ in merged])
    lo, hi = all_mesh.bounds
    size = (hi - lo).tolist()
    # The three colour-comparison versions stay guaranteed together on plate 1.
    # The flat outline is always exported too, but on a large model it shares
    # that guarantee's pressure: it joins plate 1 when there is room and
    # otherwise starts the next plate rather than failing the whole export.
    plan = layout(size, target, len(colours), h)
    geometries = ([(label,m) for label,m,_ in merged]
                  + [('Frame',frame), ('Filled regions',faces), ('Outline 0.2 mm',outline)])
    frame_i, face_i, outline_i = len(merged), len(merged)+1, len(merged)+2
    frame_only_i = frame_i
    if frame_connected is not None:
        geometries.append(('Frame with ribs', frame_connected))
        frame_only_i = len(geometries) - 1
    variants = [dict(id='single', name='Single hue', required=True, parts=[[i,hue] for i in range(len(merged))]),
                dict(id='frame', name='Frame only', required=True, parts=[[frame_only_i,black]]),
                dict(id='two', name='Black frame + one hue', required=True, parts=[[frame_i,black],[face_i,hue]]),
                dict(id='outline', name='Outline 0.2 mm', required=True, parts=[[outline_i,hue]])]
    # Deduplicate permutations when palette rows use the same spool colour.
    if len(palette) > 8:
        raise ValueError('Too many colour groups; combine groups before exporting.')
    seen = set()
    for perm in itertools.permutations(palette_slots):
        if perm in seen:
            continue
        seen.add(perm)
        parts = [[merged.index(m),s] for m,s in zip(palette,perm)]
        parts += [[merged.index(m),black] for m in fixed]
        variants.append(dict(id='colour-'+'-'.join(map(str,perm)), name='Colour arrangement '+str(len(seen)), required=False, parts=parts))
        if len(seen) >= 128:
            break
    selected = options.get('selected')
    if selected is None:
        selected = [v['id'] for v in variants[:3 * plan['capacity']]]
    if not isinstance(selected,list) or any(not isinstance(s,str) for s in selected):
        raise ValueError('Invalid variation selection')
    unknown = set(selected) - {v['id'] for v in variants}
    if unknown:
        raise ValueError('Variation selection is stale. Reopen the export dialog.')
    chosen = [v for v in variants if v['required'] or v['id'] in selected]
    count = math.ceil(len(chosen) / plan['capacity'])
    result = dict(target=target, colours=colours, variants=variants,
                  selected=[v['id'] for v in chosen], layout=plan, plates=count,
                  objects=len(chosen), pattern=pattern, layerHeight=h,
                  required=sum(1 for v in variants if v['required']),
                  walls=walls, regions=regions)
    if options.get('preview'):
        result['geometry'] = [dict(name=label, paths=outlines(mesh)) for label,mesh in geometries]
        result['viewBox'] = [float(lo[0]), float(-hi[1]), size[0], size[1]]
    return result, geometries, chosen


def write(path, result, geometries, chosen):
    from dxf2stl import _mesh_xml
    target, plan = result['target'], result['layout']
    count, capacity = result['plates'], plan['capacity']
    cols = math.ceil(math.sqrt(count))
    model = ET.Element('model', {'unit':'millimeter', 'xmlns':CORE, 'xmlns:p':PROD, 'requiredextensions':'p'})
    ET.SubElement(model,'metadata',name='Application').text = 'BambuStudio-02.07.01.62' if target == 'bambu' else 'BambuStudio-01.10.01.50'
    ET.SubElement(model,'metadata',name='BambuStudio:3mfVersion').text = '1'
    resources = ET.SubElement(model,'resources')
    build = ET.SubElement(model,'build')
    settings = ET.Element('config')
    plates = []
    for i in range(count):
        p=ET.SubElement(settings,'plate'); plates.append(p)
        for key,value in [('plater_id',i+1),('plater_name', ''),('locked','false')]:
            ET.SubElement(p,'metadata',key=key,value=str(value))
    assemble = ET.SubElement(settings,'assemble')
    used = sorted({g for v in chosen for g,s in v['parts']})
    # Global object-id allocation avoids the former 1000/2000 range collisions.
    mesh_ids = {g:len(chosen)+1+i for i,g in enumerate(used)}
    for index,v in enumerate(chosen):
        oid = str(index+1)
        obj=ET.SubElement(resources,'object',id=oid,type='model')
        components=ET.SubElement(obj,'components')
        config_obj=ET.SubElement(settings,'object',id=oid)
        for key,value in [('name',v['name']),('extruder',v['parts'][0][1]),('top_surface_pattern',result['pattern']),('bottom_surface_pattern',result['pattern'])]:
            ET.SubElement(config_obj,'metadata',key=key,value=str(value))
        for g,s in v['parts']:
            mid=str(mesh_ids[g])
            ET.SubElement(components,'component',{'p:path':'/3D/Objects/geometry.model','objectid':mid,'transform':IDENTITY+' 0 0 0'})
            part=ET.SubElement(config_obj,'part',id=mid,subtype='normal_part')
            ET.SubElement(part,'metadata',key='name',value=geometries[g][0])
            ET.SubElement(part,'metadata',key='extruder',value=str(s))
            ET.SubElement(part,'metadata',key='matrix',value='1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1')
        pi=index//capacity
        x,y=plan['slots'][index%capacity]
        ox=(pi%cols)*plan['bed']*1.2; oy=-(pi//cols)*plan['bed']*1.2
        bounds=np.array([geometries[g][1].bounds for g,s in v['parts']])
        lo=bounds[:,0,:].min(axis=0)
        tf=IDENTITY+f' {x+ox-lo[0]:.6f} {y+oy-lo[1]:.6f} {-lo[2]:.6f}'
        ET.SubElement(build,'item',objectid=oid,transform=tf,printable='1')
        instance=ET.SubElement(plates[pi],'model_instance')
        for key,value in [('object_id',oid),('instance_id','0'),('identify_id',oid)]:
            ET.SubElement(instance,'metadata',key=key,value=value)
        ET.SubElement(assemble,'assemble_item',object_id=oid,instance_id='0',transform=tf,offset='0 0 0')
    def xml(e):return ET.tostring(e,encoding='utf-8',xml_declaration=True)
    rels=ET.Element('Relationships',xmlns=REL)
    ET.SubElement(rels,'Relationship',Target='/3D/Objects/geometry.model',Id='geometry',Type=MODEL_REL)
    rootrels=ET.Element('Relationships',xmlns=REL)
    ET.SubElement(rootrels,'Relationship',Target='/3D/3dmodel.model',Id='model',Type=MODEL_REL)
    types=ET.Element('Types',xmlns='http://schemas.openxmlformats.org/package/2006/content-types')
    for ext,mime in [('rels','application/vnd.openxmlformats-package.relationships+xml'),('model','application/vnd.ms-package.3dmanufacturing-3dmodel+xml'),('config','application/xml')]:
        ET.SubElement(types,'Default',Extension=ext,ContentType=mime)
    with zipfile.ZipFile(path,'w',zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml',xml(types));z.writestr('_rels/.rels',xml(rootrels))
        z.writestr('3D/3dmodel.model',xml(model));z.writestr('3D/_rels/3dmodel.model.rels',xml(rels))
        meshes=''.join(f'<object id="{mesh_ids[g]}" type="model"><mesh>{_mesh_xml(geometries[g][1])}</mesh></object>' for g in used)
        z.writestr('3D/Objects/geometry.model',f'<?xml version="1.0" encoding="UTF-8"?><model xmlns="{CORE}" unit="millimeter"><resources>{meshes}</resources><build/></model>')
        z.writestr('Metadata/model_settings.config',xml(settings))
        z.writestr('Metadata/slice_info.config', '<config><header><header_item key="X-BBL-Client-Type" value="slicer"/><header_item key="X-BBL-Client-Version" value=""/></header></config>')
        z.writestr('Metadata/project_settings.config',json.dumps(profile(target,result['colours'],result['layerHeight'],result['pattern'],plan,count)))
    required = result.get('required')
    if required is None:
        required = sum(1 for v in result.get('variants', []) if v.get('required')) or 3
    return dict(file=Path(path).name,variations=len(chosen)-required,versions=required,objects=len(chosen),plates=count,
                parts=sum(len(v['parts']) for v in chosen),triangles=sum(len(geometries[g][1].faces) for g in used))


def export(outdir, layers, wall_stack, options):
    result, geometries, chosen = prepare(layers,wall_stack,options)
    if not options.get('preview'):
        Path(outdir).mkdir(parents=True,exist_ok=True)
        result['files']=[write(Path(outdir)/'variations.3mf',result,geometries,chosen)]
    return result
