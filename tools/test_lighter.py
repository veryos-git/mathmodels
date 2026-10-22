import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import trimesh

from lighter import (_ellipse_points, _tile_solid, ellipse_arc_table,
                     export_lighter, lighter_info, mesh_of, start_fraction)

ROOT = Path(__file__).resolve().parent.parent
SCAD = str(ROOT / "hgc_requirements_documentation/simple_lighter_case/bicj26.scad")
SKETCH = str(ROOT / "reverse_engeneering/gothic_tracery_simple/sketch.dxf")
SWEEP = str(ROOT / "reverse_engeneering/gothic_tracery_simple/default_profile.dxf")

SETTINGS = {"wall": 1.0, "height": 70.9, "width": 25.0, "depth": 14.5,
            "fit": 0.25, "edgeChamfer": 0.4}


def render_shell(path):
    """Render the BIC J26 case shell with OpenSCAD, matching the backend."""
    subprocess.run(
        ["openscad", "-o", path, "-D", "wall=1.0", "-D", "height=70.9", SCAD],
        check=True, capture_output=True, env={**os.environ, "QT_QPA_PLATFORM": "offscreen"},
    )


class EllipseMathTests(unittest.TestCase):
    def test_arc_table_is_monotonic_with_positive_perimeter(self):
        theta, arclen = ellipse_arc_table(13.75, 8.5)
        self.assertEqual(theta[0], 0.0)
        self.assertAlmostEqual(theta[-1], 2 * math.pi)
        self.assertTrue(np.all(np.diff(arclen) > 0))
        # Ramanujan's approximation of the ellipse perimeter, as a sanity bound.
        a, b = 13.75, 8.5
        approx = math.pi * (3 * (a + b) - math.sqrt((3 * a + b) * (a + 3 * b)))
        self.assertAlmostEqual(arclen[-1], approx, delta=0.05)

    def test_info_body_runs_between_the_chamfers(self):
        info = lighter_info(SETTINGS)
        self.assertAlmostEqual(info["a"], 25 / 2 + 0.25 + 1.0)
        self.assertAlmostEqual(info["b"], 14.5 / 2 + 0.25 + 1.0)
        self.assertAlmostEqual(info["z0"], 0.4)
        self.assertAlmostEqual(info["z1"], 70.5)
        self.assertGreater(info["perimeter"], 0)

    def test_each_start_vertex_seats_the_seam_on_that_vertex(self):
        """V1..V4 split the perimeter into equal quarters, so the seam lands on
        the matching axis vertex of the ellipse; the 90° offset steps along."""
        info = lighter_info(SETTINGS)
        a, b = info["a"], info["b"]
        corners = {1: (a, 0), 3: (0, b), 2: (-a, 0), 4: (0, -b)}
        for vertex, (cx, cy) in corners.items():
            frac = start_fraction({"startVertex": vertex})
            px, py, _, _ = (v[0] for v in _ellipse_points(info, np.array([frac])))
            self.assertAlmostEqual(px, cx, places=2)
            self.assertAlmostEqual(py, cy, places=2)
        # A 90° offset from V1 reaches V3 (the next vertex round).
        self.assertAlmostEqual(start_fraction({"startVertex": 1, "startOffset": 90}),
                               start_fraction({"startVertex": 3}))


@unittest.skipUnless(shutil.which("openscad"), "OpenSCAD is required to build the shell")
class LighterWrapTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.shell = os.path.join(cls.tmp, "shell.stl")
        render_shell(cls.shell)
        cls.info = lighter_info(SETTINGS)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_sketch_repeat_wraps_into_one_closed_solid(self):
        """A periodic column repeated around the ellipse fuses with the shell
        into a single watertight solid."""
        import manifold3d as mf
        W, H, nx = self.info["perimeter"] / 3, self.info["body_height"], 3
        column = mesh_of(mf.Manifold.cube((W, H, 2.0)))
        buckets = [("relief", column, 1)]
        tiling = {"period": [W, H], "bounds": [0.0, 0.0, nx * W, H],
                  "repeatX": nx, "repeatY": 1}
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "l.stl")
            result = export_lighter(out, buckets, {**SETTINGS, "repeatX": nx,
                                    "bodyPath": self.shell}, tiling=tiling)
            self.assertTrue(result["lighter"])
            loaded = trimesh.load(out)
        self.assertTrue(loaded.is_watertight)
        self.assertTrue(loaded.is_winding_consistent)
        self.assertEqual(len(loaded.split(only_watertight=False)), 1)

    def test_converter_end_to_end_is_closed(self):
        """Exactly as the server runs it: the gothic sketch swept and repeated
        three times around the case is one watertight solid."""
        with tempfile.TemporaryDirectory() as d:
            config = os.path.join(d, "lighter.json")
            Path(config).write_text(json.dumps(
                {**SETTINGS, "repeatX": 3, "sweepThenRepeat": False,
                 "bodyPath": self.shell}))
            out = os.path.join(d, "l.stl")
            cmd = [sys.executable, "tools/dxf2stl.py", SKETCH, out,
                   "--lighter", config, "--profile", SWEEP, "--sagitta", "0.3"]
            run = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            loaded = trimesh.load(out)
        self.assertTrue(loaded.is_watertight, "lighter export is not watertight")
        self.assertEqual(len(loaded.split(only_watertight=False)), 1)
        # The wrapped artwork rises past the elliptical shell: its bounding box
        # exceeds the bare case's outer ellipse (2a × 2b).
        self.assertGreater(loaded.extents[0], 2 * self.info["a"])
        self.assertGreater(loaded.extents[1], 2 * self.info["b"])


class TileTests(unittest.TestCase):
    def test_sweep_then_repeat_offsets_each_copy(self):
        import manifold3d as mf
        W = 15.0
        solid = mf.Manifold.cube((W, 10.0, 2.0))
        tiled, bounds = _tile_solid(solid, [0.0, 0.0, W, 10.0], 3)
        self.assertEqual(bounds, [0.0, 0.0, 3 * W, 10.0])
        self.assertAlmostEqual(tiled.bounding_box()[3], 3 * W, places=5)


if __name__ == "__main__":
    unittest.main()
