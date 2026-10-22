import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import trimesh

from ring import _tile_solid, export_ring, load_ring_info, mesh_of

ROOT = Path(__file__).resolve().parent.parent
PROFILE = str(ROOT / "reverse_engeneering/ring/default_profile.dxf")
SKETCH = str(ROOT / "reverse_engeneering/gothic_tracery_simple/sketch.dxf")
SWEEP = str(ROOT / "reverse_engeneering/gothic_tracery_simple/default_profile.dxf")


class RingTests(unittest.TestCase):
    def setUp(self):
        self.cfg = {"profilePath": PROFILE, "offset": 9.0}
        self.info = load_ring_info(self.cfg, 0.3)

    def test_sketch_repeat_joins_columns_into_one_continuous_band(self):
        """With `tiling`, periodic columns meet exactly: one closed ring band,
        not three separate tiles."""
        import manifold3d as mf
        W, H, nx = 20.0, self.info["ring_height"], 3
        column = mesh_of(mf.Manifold.cube((W, H, 2.0)))
        buckets = [("relief", column, 1)]
        tiling = {"period": [W, H], "bounds": [0.0, 0.0, nx * W, H],
                  "repeatX": nx, "repeatY": 1}
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "ring.stl")
            result = export_ring(out, buckets, {**self.cfg, "repeatX": nx}, 0.3,
                                 tiling=tiling)
            self.assertTrue(result["ring"])
            loaded = trimesh.load(out)
        self.assertTrue(loaded.is_watertight)
        self.assertTrue(loaded.is_winding_consistent)
        # A ring (with or without a raised band fused to it) is genus 1.
        self.assertEqual(loaded.euler_number, 0)
        self.assertEqual(len(loaded.split(only_watertight=False)), 1)

    def test_converter_sketch_repeat_is_closed_and_repeats_around(self):
        """End to end, exactly as the server runs it: the gothic sketch swept
        and repeated three times around the ring is one watertight solid whose
        relief has three-fold rotational symmetry."""
        with tempfile.TemporaryDirectory() as d:
            config = os.path.join(d, "ring.json")
            Path(config).write_text(json.dumps(
                {"profilePath": PROFILE, "offset": 9.0, "repeatX": 3,
                 "sweepThenRepeat": False}))
            out = os.path.join(d, "ring.stl")
            cmd = [sys.executable, "tools/dxf2stl.py", SKETCH, out,
                   "--ring", config, "--profile", SWEEP, "--sagitta", "0.3"]
            run = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            loaded = trimesh.load(out)
        self.assertTrue(loaded.is_watertight, "ring export is not watertight")
        self.assertEqual(len(loaded.split(only_watertight=False)), 1)
        # Relief tips stand out past the shell; their angles should be invariant
        # under a 120° turn. Compare the folded histogram of each third.
        v = loaded.vertices
        r = np.linalg.norm(v[:, :2], axis=1)
        tips = v[r > self.info["r_outer"] + 0.3]
        ang = np.arctan2(tips[:, 1], tips[:, 0]) % (2 * np.pi)
        third = 2 * np.pi / 3
        hists = []
        for k in range(3):
            copy = ang[(ang >= k * third) & (ang < (k + 1) * third)] - k * third
            hists.append(np.histogram(copy, bins=10, range=(0, third))[0])
        base = hists[0].sum()
        self.assertGreater(base, 100)
        for h in hists[1:]:
            # Each copy holds a comparable share of the relief tips.
            self.assertGreater(h.sum(), 0.6 * base)

    def test_sweep_then_repeat_stays_a_side_by_side_copy(self):
        """Without `tiling` the finished relief is copied in place; the helper
        the export relies on offsets each copy by the tile width."""
        import manifold3d as mf
        W = 15.0
        solid = mf.Manifold.cube((W, 10.0, 2.0))
        tiled, bounds = _tile_solid(solid, [0.0, 0.0, W, 10.0], 3)
        self.assertEqual(bounds, [0.0, 0.0, 3 * W, 10.0])
        self.assertAlmostEqual(tiled.bounding_box()[3], 3 * W, places=5)


if __name__ == "__main__":
    unittest.main()
