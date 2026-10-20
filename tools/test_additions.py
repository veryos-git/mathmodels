"""Shelf geometry, source orientation, validation and preview/export parity."""
import base64
import io
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from xml.etree import ElementTree

import numpy as np
import trimesh
from shapely.geometry import LineString, Polygon

from additions import attach_shelf, edge_section, shelf_mesh, shelf_outline
from cylinder import manifold
from dxf2stl import ConvertError

ROOT = Path(__file__).resolve().parent.parent
EXAMPLE = ROOT / "hgc/object_additions/gothic_Shelf/examples/shelf - shelf_profile_path.dxf"


class Additions(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)
        self.frame = self.svg("frame", '<path d="M0 0H100V80H0Z M0 40H100"/>')
        self.outline = self.svg("shelf", '<path d="M0 0H60V20H0Z"/>')
        self.profile = self.svg("profile", '<path d="M0 0H2V2H0Z"/>')

    def svg(self, name, body):
        path = self.path / f"{name}.svg"
        path.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="100mm" '
                        f'height="100mm" viewBox="0 0 100 100">{body}</svg>')
        return path

    def run_cli(self, *extra, success=True):
        command = [sys.executable, "tools/dxf2stl.py", str(self.frame),
                   "--profile", str(self.profile), "--frame-only",
                   "--addition-outline", str(self.outline), *map(str, extra)]
        result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("Traceback", result.stderr)
        return result.stderr

    def test_reference_rear_edge_and_exact_thickness(self):
        mesh = shelf_mesh(EXAMPLE, .02, thickness=5)
        self.assertTrue(mesh.is_volume)
        np.testing.assert_allclose(mesh.extents, [94.19284, 29.605908, 5], atol=.001)
        rear = mesh.vertices[np.abs(mesh.vertices[:, 1]) < 1e-5]
        self.assertAlmostEqual(np.ptp(rear[:, 0]), mesh.extents[0], places=4)
        scaled = shelf_mesh(EXAMPLE, .02, thickness=.2, width=120, depth=40)
        np.testing.assert_allclose(scaled.extents, [120, 40, .2], atol=.001)

    def test_holes_are_preserved_and_open_outlines_rejected(self):
        hole = self.svg("hole", '<path d="M0 0H60V20H0Z M25 5H35V15H25Z"/>')
        self.assertAlmostEqual(shelf_mesh(hole, .02).volume, (60*20-10*10)*5, delta=.01)
        opened = self.svg("open", '<path d="M0 0H60V20"/>')
        with self.assertRaisesRegex(ConvertError, "closed"):
            shelf_mesh(opened, .02)

    def test_all_cross_section_rotations_make_printable_shelves(self):
        section = Polygon([(-2, 0), (2, 0), (1, 3), (-1, 1)])
        meshes = [shelf_mesh(EXAMPLE, .04, section=section, rotation=angle)
                  for angle in (90, 180, 270, 360)]
        for mesh in meshes:
            loaded = trimesh.load(io.BytesIO(mesh.export(file_type="stl")), file_type="stl")
            self.assertTrue(loaded.is_volume)
            self.assertEqual(sum(p.volume > 0 for p in loaded.split()), 1)
        self.assertNotAlmostEqual(meshes[0].volume, meshes[1].volume, places=2)

    def shelf_args(self, **changes):
        values = dict(cylinder=None, profile=str(self.profile), sagitta=.02,
                      profile_scale=1, profile_height_scale=1,
                      addition_outline=str(self.outline), addition_profile=None,
                      addition_edge_sweep=True, addition_thickness=5,
                      addition_width=0, addition_depth=0, addition_x=0,
                      addition_y=0, addition_z=0, addition_rotation=90,
                      addition_flip=False, addition_profile_scale=4,
                      addition_profile_height_scale=6, addition_mirror_profile=False,
                      addition_flip_profile=False, addition_keep_original_profile=False,
                      addition_trim_back=False)
        return SimpleNamespace(**(values | changes))

    def test_bed_trim_caps_the_placed_rim_at_the_actual_frame_back(self):
        frame = trimesh.creation.box(extents=[80, 60, 2])
        frame.apply_translation([0, 0, 1])
        before = attach_shelf(frame, self.shelf_args())
        after = attach_shelf(frame, self.shelf_args(addition_trim_back=True))
        self.assertLess(before.bounds[0, 2], -4)
        self.assertAlmostEqual(after.bounds[0, 2], 0, places=6)
        self.assertLess(after.volume, before.volume)
        self.assertTrue(after.is_volume)
        self.assertEqual(len(after.split()), 1)
        self.assertTrue(np.any((after.face_normals[:, 2] < -.999)
                               & (np.abs(after.triangles_center[:, 2]) < 1e-6)),
                        "the cut has a closed flat bed-facing cap")
        self.assertLess((manifold(frame) - manifold(after)).volume(), 1e-6,
                        "the cut must not remove any of the original frame")
        raised = frame.copy()
        raised.apply_translation([0, 0, 4])
        raised_trim = attach_shelf(raised, self.shelf_args(addition_trim_back=True))
        np.testing.assert_allclose(raised_trim.bounds, after.bounds + [0, 0, 4], atol=1e-5)
        self.assertAlmostEqual(raised_trim.volume, after.volume, places=3)
        reloaded = trimesh.load(io.BytesIO(after.export(file_type="stl")), file_type="stl")
        self.assertTrue(reloaded.is_volume)
        self.assertAlmostEqual(reloaded.bounds[0, 2], 0, places=6)
        with self.assertRaisesRegex(ConvertError, "trim removed"):
            attach_shelf(frame, self.shelf_args(addition_trim_back=True, addition_z=-100))

    def test_shelf_scales_do_not_follow_main_scales(self):
        frame = trimesh.creation.box(extents=[80, 60, 2])
        frame.apply_translation([0, 0, 1])
        original = attach_shelf(frame, self.shelf_args())
        changed_main = attach_shelf(frame, self.shelf_args(profile_scale=25, profile_height_scale=.01))
        np.testing.assert_allclose(original.bounds, changed_main.bounds)
        self.assertAlmostEqual(original.volume, changed_main.volume, places=5)
        resized = attach_shelf(frame, self.shelf_args(addition_profile_scale=2,
                                                     addition_profile_height_scale=3))
        self.assertNotAlmostEqual(original.volume, resized.volume, places=2)
        # Source width/height scale before rotation, including custom sections.
        section = Polygon([(-2, 0), (2, 0), (1, 3)])
        prepared = edge_section(section, 5, 90, width_scale=2, height_scale=3)
        np.testing.assert_allclose(np.subtract(prepared.bounds[2:], prepared.bounds[:2]), [9, 8])
        self.assertAlmostEqual(prepared.area, section.area * 6)

    def test_mirror_keeps_the_source_baseline_fixed_before_every_rotation(self):
        section = Polygon([(-2, 0), (2, 0), (1, 3)])
        # Explicit quarter-turn matrices make the expected result independent
        # of the production scale/rotate/translate helpers.
        rotations = {90: [[0, -1], [1, 0]], 180: [[-1, 0], [0, -1]],
                     270: [[0, 1], [-1, 0]], 360: [[1, 0], [0, 1]]}
        for angle, matrix in rotations.items():
            with self.subTest(rotation=angle):
                normal = edge_section(section, .4, angle, 2, 3)
                mirrored = edge_section(section, .4, angle, 2, 3, mirror=True)
                rotated_baseline = np.array([[-4, 0], [4, 0]]) @ np.array(matrix).T + [0, .2]
                baseline = LineString(rotated_baseline)
                self.assertLess(normal.intersection(mirrored).area, 1e-8,
                                "both profiles must occupy opposite sides of their baseline")
                self.assertLess(normal.boundary.intersection(mirrored.boundary)
                                .hausdorff_distance(baseline), 1e-8,
                                "the original and reflected flat bases must coincide")
                self.assertAlmostEqual(normal.union(mirrored).area, 2 * section.area * 6)
                for mirror, flip in ((False, False), (True, False), (False, True), (True, True)):
                    coordinates = np.array(section.exterior.coords) * [
                        -2 if flip else 2, -3 if mirror else 3]
                    expected = Polygon(coordinates @ np.array(matrix).T + [0, .2])
                    actual = edge_section(section, .4, angle, 2, 3, mirror, flip)
                    self.assertLess(actual.symmetric_difference(expected).area, 1e-8)

    def test_source_axis_mirrors_produce_closed_sweeps(self):
        section = Polygon([(-2, 0), (2, 0), (1, 3)])
        for angle in (90, 180, 270, 360):
            for mirror, flip in ((True, False), (False, True), (True, True)):
                with self.subTest(rotation=angle, mirror=mirror, flip=flip):
                    mesh = shelf_mesh(self.outline, .02, thickness=.4, section=section,
                                      rotation=angle, mirror_profile=mirror, flip_profile=flip)
                    loaded = trimesh.load(io.BytesIO(mesh.export(file_type="stl")), file_type="stl")
                    self.assertTrue(loaded.is_volume)
                    self.assertEqual(len(loaded.split()), 1)

    def test_trim_mirrors_and_scales_match_preview_and_exports(self):
        asymmetric = self.svg("asymmetric", '<path d="M0 0H4L3 3Z"/>')
        options = ["--addition-edge-sweep", "--addition-profile", asymmetric,
                   "--addition-profile-scale", "2", "--addition-profile-height-scale", "4",
                   "--addition-mirror-profile", "--addition-flip-profile", "--addition-trim-back"]
        data = self.run_cli("--regions", *options)
        preview = trimesh.load(io.BytesIO(base64.b64decode(data["wallMesh"])), file_type="stl")
        target = self.path / "trimmed.stl"
        self.run_cli(target, *options)
        exported = trimesh.load(target)
        self.assertTrue(exported.is_volume)
        self.assertEqual(len(exported.split()), 1)
        self.assertAlmostEqual(exported.bounds[0, 2], 0, places=6)
        np.testing.assert_allclose(preview.bounds, exported.bounds)
        self.assertAlmostEqual(preview.volume, exported.volume, places=4)
        split = self.path / "trimmed-parts"
        self.run_cli(split, "--split", *options)
        np.testing.assert_allclose(trimesh.load(split / "walls.stl").bounds, exported.bounds)
        target_3mf = self.path / "trimmed.3mf"
        self.run_cli(target_3mf, *options)
        with zipfile.ZipFile(target_3mf) as archive:
            heights = [float(vertex.get("z"))
                       for name in archive.namelist() if name.endswith(".model")
                       for vertex in ElementTree.fromstring(archive.read(name)).iter()
                       if vertex.tag.endswith("}vertex")]
        self.assertAlmostEqual(min(heights), 0, places=6)
        self.assertAlmostEqual(max(heights), exported.bounds[1, 2], places=4)

    def test_both_sweeps_fuse_the_union_without_replacing_either_profile(self):
        section = Polygon([(-2, 0), (2, 0), (1, 3)])
        for angle in (90, 180, 270, 360):
            original = shelf_mesh(self.outline, .02, thickness=.4, section=section, rotation=angle)
            for mirror, flip in ((True, False), (False, True), (True, True)):
                with self.subTest(rotation=angle, mirror=mirror, flip=flip):
                    options = dict(thickness=.4, section=section, rotation=angle,
                                   mirror_profile=mirror, flip_profile=flip)
                    reflected = shelf_mesh(self.outline, .02, **options)
                    both = shelf_mesh(self.outline, .02, keep_original_profile=True, **options)
                    a, b, actual = map(manifold, (original, reflected, both))
                    self.assertLess((a - actual).volume(), 1e-4)
                    self.assertLess((b - actual).volume(), 1e-4)
                    # Inclusion/exclusion avoids a second union of coincident
                    # surfaces already rounded independently to STL precision.
                    expected_volume = a.volume() + b.volume() - (a ^ b).volume()
                    self.assertAlmostEqual(actual.volume(), expected_volume, delta=1e-4)
                    self.assertGreater(both.volume, max(original.volume, reflected.volume) + .1)
                    self.assertLess(both.volume, original.volume + reflected.volume)
                    loaded = trimesh.load(io.BytesIO(both.export(file_type="stl")), file_type="stl")
                    self.assertTrue(loaded.is_volume)
                    self.assertEqual(len(loaded.split()), 1)
        # Coincident copies must not double the volume or create extra shells.
        symmetric = Polygon([(-2, 0), (2, 0), (2, 3), (-2, 3)])
        for shape, mirror, flip in ((symmetric, False, True), (section, False, False)):
            options = dict(section=shape, mirror_profile=mirror, flip_profile=flip)
            single = shelf_mesh(self.outline, .02, **options)
            both = shelf_mesh(self.outline, .02, keep_original_profile=True, **options)
            self.assertAlmostEqual(single.volume, both.volume, places=5)
            self.assertEqual(len(both.split()), 1)

    def test_both_sweeps_survive_bed_trim_preview_and_exports(self):
        asymmetric = self.svg("both-profile", '<path d="M0 0H4L3 3Z"/>')
        options = ["--addition-edge-sweep", "--addition-profile", asymmetric,
                   "--addition-profile-scale", "2", "--addition-profile-height-scale", "4",
                   "--addition-mirror-profile", "--addition-flip-profile", "--addition-trim-back"]
        normal_options = [value for value in options
                          if value not in ("--addition-mirror-profile", "--addition-flip-profile")]
        def preview(extra):
            data = self.run_cli("--regions", *extra)
            return trimesh.load(io.BytesIO(base64.b64decode(data["wallMesh"])), file_type="stl")
        normal = preview(normal_options)
        mirrored = preview(options)
        both_options = [*options, "--addition-keep-original-profile"]
        both = preview(both_options)
        expected = manifold(normal) + manifold(mirrored)
        # Each independent preview has already rounded its cut surfaces to
        # STL float32 precision; allow one part per million for that rounding.
        tolerance = max(1e-3, both.volume * 1e-6)
        self.assertLess((expected - manifold(both)).volume(), tolerance)
        self.assertLess((manifold(both) - expected).volume(), tolerance)
        self.assertGreater(both.volume, max(normal.volume, mirrored.volume) + .1)
        self.assertAlmostEqual(both.bounds[0, 2], 0, places=6)
        target = self.path / "both.stl"
        self.run_cli(target, *both_options)
        exported = trimesh.load(target)
        self.assertTrue(exported.is_volume)
        self.assertEqual(len(exported.split()), 1)
        np.testing.assert_allclose(exported.bounds, both.bounds)
        self.assertAlmostEqual(exported.volume, both.volume, places=4)
        split = self.path / "both-parts"
        self.run_cli(split, "--split", *both_options)
        self.assertAlmostEqual(trimesh.load(split / "walls.stl").volume, both.volume, places=4)

    def test_preview_and_stl_have_same_perpendicular_fused_shelf(self):
        data = self.run_cli("--regions")
        preview = trimesh.load(io.BytesIO(base64.b64decode(data["wallMesh"])), file_type="stl")
        output = self.path / "result.stl"
        self.run_cli(output)
        exported = trimesh.load(output)
        self.assertTrue(exported.is_volume)
        self.assertEqual(len(exported.split()), 1)
        np.testing.assert_allclose(preview.bounds, exported.bounds)
        self.assertAlmostEqual(preview.volume, exported.volume, places=4)
        self.assertAlmostEqual(exported.bounds[1, 2], 21.8, places=4)
        # A plane beyond the 2 mm frame cuts only the upright shelf:
        # its width is 60 mm and its thickness lies along Y, not Z.
        section = exported.section(plane_origin=[0, 0, 10], plane_normal=[0, 0, 1])
        np.testing.assert_allclose(section.extents[:2], [60, 5], atol=.0001)
        groups = self.path / "split"
        self.run_cli(groups, "--split")
        split = trimesh.load(groups / "walls.stl")
        np.testing.assert_allclose(split.bounds, exported.bounds)
        project = self.path / "result.3mf"
        self.run_cli(project)
        with zipfile.ZipFile(project) as archive:
            heights = [float(vertex.get("z"))
                       for name in archive.namelist() if name.endswith(".model")
                       for vertex in ElementTree.fromstring(archive.read(name)).iter()
                       if vertex.tag.endswith("}vertex")]
        self.assertAlmostEqual(max(heights), exported.bounds[1, 2], places=4)
        # A CNC slice beyond the frame must also include the shelf.
        sliced = self.path / "shelf.svg"
        self.run_cli(sliced, "--slice-height", "10")
        self.assertIn("<path", sliced.read_text())
        # The shelf belongs only to the base drawing, not every stacked subject.
        spec = self.path / "layer.json"
        spec.write_text(json.dumps({"file": str(self.frame)}))
        stacked = self.run_cli("--regions", "--also", spec)
        upper = trimesh.load(io.BytesIO(base64.b64decode(stacked["drawings"][1]["wallMesh"])), file_type="stl")
        self.assertAlmostEqual(upper.extents[2], 2, places=5)
        self.assertAlmostEqual(stacked["drawings"][1]["zBase"], 2, places=5)

    def test_invalid_dimensions_rotation_and_detached_placement(self):
        for extra, message in [
            (["--addition-thickness", ".1"], "0.2 and 20"),
            (["--addition-thickness", "21"], "0.2 and 20"),
            (["--addition-width", "-1"], "non-negative"),
            (["--addition-y", "nan"], "finite"),
            (["--addition-rotation", "45"], "90, 180, 270 or 360"),
            (["--addition-x", "1000"], "does not touch"),
            (["--cylinder", "unused.json"], "flat model"),
            (["--addition-edge-sweep", "--addition-profile-scale", "0"], "greater than zero"),
            (["--addition-edge-sweep", "--addition-profile-height-scale", "nan"], "finite"),
        ]:
            with self.subTest(extra=extra):
                self.assertIn(message, self.run_cli("--regions", *extra, success=False))

    def test_placement_preview_uses_the_same_outline_and_fixed_frame(self):
        preview = self.run_cli("--addition-preview")
        moved = self.run_cli("--addition-preview", "--addition-x", "1000",
                             "--addition-y", "10", "--addition-z", "100",
                             "--addition-width", "70", "--addition-flip")
        self.assertEqual(preview, moved, "preview geometry stays anchored while a shelf is edited")
        outline = shelf_outline(str(self.outline), .02)
        np.testing.assert_allclose(preview["shelf"]["exterior"], outline.exterior.coords, atol=.0001)
        self.assertTrue(preview["frame"]["top"])
        self.assertTrue(preview["frame"]["front"])
        top = np.concatenate([p["exterior"] for p in preview["frame"]["top"]])
        front = np.concatenate([p["exterior"] for p in preview["frame"]["front"]])
        self.assertAlmostEqual(np.ptp(top[:, 1]), 2, places=4)
        self.assertAlmostEqual(np.ptp(front[:, 1]), 82, places=3)
        self.assertAlmostEqual(top[:, 1].max(), .2, places=4)
        self.assertAlmostEqual((front[:, 1].max() + front[:, 1].min()) / 2, 0, places=4)


if __name__ == "__main__":
    unittest.main()
