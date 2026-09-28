"""Measure reference STEP cross-sections; optional cadquery-ocp + vtk required.

This development tool is not used by the app. It imports actual CAD surfaces,
tessellates them in millimetres, and records unioned horizontal sections for
regression comparisons. It does not infer the CAD feature history.
"""
import argparse
import hashlib
import json
from pathlib import Path
import tempfile
import zipfile

import trimesh
from shapely.geometry import mapping
from shapely.ops import unary_union

from slice_svg import planar_section


def read_step(path, tolerance):
    from OCP.STEPControl import STEPControl_Reader
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.BRep import BRep_Tool
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopAbs import TopAbs_FACE, TopAbs_REVERSED
    from OCP.TopoDS import TopoDS
    from OCP.TopLoc import TopLoc_Location

    reader = STEPControl_Reader()
    if reader.ReadFile(str(path)) != IFSelect_RetDone:
        raise ValueError(f"Could not read {path.name}")
    reader.TransferRoots()
    solid = reader.OneShape()  # OpenCascade imports STEP lengths in mm.
    BRepMesh_IncrementalMesh(solid, tolerance, False, .06, True)
    explorer = TopExp_Explorer(solid, TopAbs_FACE)
    vertices, faces = [], []
    # OCP 8 renamed this cast; retain compatibility with OCP 7.
    cast_face = getattr(TopoDS, 'Face_s', None) or TopoDS.Face
    while explorer.More():
        face = cast_face(explorer.Current())
        location = TopLoc_Location()
        triangles = BRep_Tool.Triangulation_s(face, location)
        if triangles is not None:
            offset = len(vertices)
            for i in range(1, triangles.NbNodes()+1):
                p = triangles.Node(i).Transformed(location.Transformation())
                vertices.append([p.X(), p.Y(), p.Z()])
            for i in range(1, triangles.NbTriangles()+1):
                indices = [v+offset-1 for v in triangles.Triangle(i).Get()]
                if face.Orientation() == TopAbs_REVERSED:
                    indices.reverse()
                faces.append(indices)
        explorer.Next()
    return trimesh.Trimesh(vertices=vertices, faces=faces, process=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--heights', type=float, nargs='+', default=[.1, 1.0])
    parser.add_argument('--tolerance', type=float, default=.002)
    parser.add_argument('--simplify', type=float, default=.001)
    args = parser.parse_args()
    meshes = []
    with zipfile.ZipFile(args.archive) as archive, tempfile.TemporaryDirectory() as tmp:
        for index, name in enumerate(sorted(archive.namelist())):
            if Path(name).suffix.lower() not in ('.step', '.stp'):
                continue
            # No archive-supplied path is used for extraction.
            path = Path(tmp) / f'part-{index}.step'
            path.write_bytes(archive.read(name))
            meshes.append(read_step(path, args.tolerance))
    if not meshes:
        raise ValueError('The archive contains no STEP files')
    sections = []
    for z in args.heights:
        intersecting = [m for m in meshes if m.bounds[0, 2] <= z < m.bounds[1, 2]]
        geometry = unary_union([planar_section([m], z) for m in intersecting]).simplify(args.simplify)
        sections.append({'z': z, 'area': geometry.area, 'geometry': mapping(geometry)})
    result = {
        'source': str(args.archive),
        'sha256': hashlib.sha256(args.archive.read_bytes()).hexdigest(),
        'tessellationToleranceMM': args.tolerance,
        'simplificationToleranceMM': args.simplify,
        'sections': sections,
    }
    args.output.write_text(json.dumps(result, separators=(',', ':')) + '\n')
    print(f'Measured {len(meshes)} STEP parts at {len(sections)} heights → {args.output}')


if __name__ == '__main__':
    main()
