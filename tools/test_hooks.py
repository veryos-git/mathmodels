"""Generated hook paths use the active frame profile and stay printable."""
import io
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import trimesh
from shapely.geometry import Polygon

from additions import attach_hook, hook_mesh
from dxf2stl import ConvertError, read_curves

ROOT = Path(__file__).resolve().parent.parent


class Hooks(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)
        self.hook_path = self.path / "generated-hook.svg"
        self.hook_path.write_text(
            '<svg xmlns="http://www.w3.org/2000/svg" width="24mm" height="36mm" '
            'viewBox="0 0 24 36"><path d="M 0 0 V 36 H 24 M 0 0 L 24 36" '
            'fill="none" stroke="black"/></svg>')
        self.frame = trimesh.creation.box(extents=[80, 80, 3])
        self.profile = Polygon([(-1, 0), (1, 0), (1, 3), (-1, 3)])

    def args(self, **changes):
        values = dict(cylinder=None, hook_path=str(self.hook_path), hook_x=0,
                      hook_y=0, hook_z=0, hook_mirror=False, sagitta=.02)
        return SimpleNamespace(**(values | changes))

    def test_generated_svg_has_three_profile_swept_rails(self):
        curves, _, _ = read_curves(str(self.hook_path), .02)
        expected = [[(0, 36), (0, 0), (24, 0)], [(0, 36), (24, 0)]]
        for actual, target in zip(curves, expected):
            for point, wanted in zip(actual, target):
                self.assertAlmostEqual(point[0], wanted[0], places=3)
                self.assertAlmostEqual(point[1], wanted[1], places=3)
        mesh = hook_mesh(self.hook_path, self.profile, .02)
        self.assertTrue(mesh.is_volume)
        self.assertGreater(mesh.extents[0], 23)
        self.assertGreater(mesh.extents[1], 35)

    def test_hook_fuses_to_frame_and_mirror_adds_a_second_support(self):
        single = attach_hook(self.frame, self.profile, self.args(hook_x=16))
        paired = attach_hook(self.frame, self.profile, self.args(hook_x=16, hook_mirror=True))
        self.assertTrue(single.is_volume)
        self.assertTrue(paired.is_volume)
        self.assertEqual(len(single.split()), 1)
        self.assertEqual(len(paired.split()), 1)
        self.assertGreater(single.bounds[1, 2], self.frame.bounds[1, 2] + 20)
        self.assertGreater(paired.volume, single.volume + .1)
        loaded = trimesh.load(io.BytesIO(paired.export(file_type="stl")), file_type="stl")
        self.assertTrue(loaded.is_volume)

    def test_disconnected_hook_is_rejected(self):
        with self.assertRaisesRegex(ConvertError, "does not touch"):
            attach_hook(self.frame, self.profile, self.args(hook_z=100))

    def test_cli_sweeps_the_generated_path(self):
        frame_path = self.path / "frame.svg"
        profile_path = self.path / "profile.svg"
        output = self.path / "hook.stl"
        frame_path.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="80mm" '
                              'height="80mm" viewBox="0 0 80 80"><path d="M0 0H80V80H0Z"/></svg>')
        profile_path.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="4mm" '
                                'height="3mm" viewBox="0 0 4 3"><path d="M0 0H4V3H0Z"/></svg>')
        result = subprocess.run([
            sys.executable, "tools/dxf2stl.py", str(frame_path), str(output), "--profile", str(profile_path),
            "--frame-only", "--hook-path", str(self.hook_path), "--hook-x", "10", "--hook-mirror",
        ], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        mesh = trimesh.load(output)
        self.assertTrue(mesh.is_volume)
        self.assertEqual(len(mesh.split()), 1)


if __name__ == "__main__":
    unittest.main()
