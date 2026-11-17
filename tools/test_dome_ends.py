"""Dome caps roll the section down over a free path end, on main and cusp paths."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import trimesh

ROOT = Path(__file__).resolve().parent.parent


class CuspDomeEnds(unittest.TestCase):
    """A cusp path's free end is a marker and takes a dome cap in the cusp section."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        # A horizontal frame bar at y = 40 and a cusp hanging from its middle
        # down to a free tip at (40, 20); the converter flips SVG Y.
        self.frame = self.tmp / "frame.svg"
        self.frame.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="80mm" '
                              'height="80mm" viewBox="0 0 80 80">'
                              '<path d="M10 40 H70" fill="none" stroke="black"/></svg>')
        self.cusps = self.tmp / "cusps.svg"
        self.cusps.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="80mm" '
                              'height="80mm" viewBox="0 0 80 80">'
                              '<path d="M40 40 V60" fill="none" stroke="black"/></svg>')
        # 4 mm wide, 3 mm tall; the cusp section is it at 0.5 × 0.5.
        self.profile = self.tmp / "profile.svg"
        self.profile.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="4mm" '
                                'height="3mm" viewBox="0 0 4 3"><path d="M0 0H4V3H0Z"/></svg>')

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_converter(self, *extra):
        return subprocess.run([
            sys.executable, "tools/dxf2stl.py", str(self.frame), *extra,
            "--profile", str(self.profile), "--cusps", str(self.cusps),
            "--cusp-width", "0.5", "--cusp-height", "0.5", "--frame-only",
        ], cwd=ROOT, capture_output=True, text=True)

    def test_regions_list_the_free_cusp_ends(self):
        result = self.run_converter("--regions")
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertIn([40.0, 20.0], data["cuspEndpoints"])
        # Main-path vertices stay in their own list.
        self.assertNotIn([40.0, 20.0], data["openEndpoints"])

    def test_dome_cap_rolls_the_cusp_section_over_its_tip(self):
        plain = self.tmp / "plain.stl"
        domed = self.tmp / "domed.stl"
        ends = self.tmp / "domes.json"
        ends.write_text(json.dumps([[40, 20]]))
        for out, extra in ((plain, []), (domed, ["--dome-ends", str(ends)])):
            result = self.run_converter(str(out), *extra)
            self.assertEqual(result.returncode, 0, result.stderr)
        plain, domed = trimesh.load(plain), trimesh.load(domed)
        self.assertAlmostEqual(plain.bounds[0, 1], 20, delta=0.01)
        # The 1.5 mm tall cusp section lies down past the tip, 2 mm wide
        # like the cusp, and the cap fuses into one body with the frame.
        self.assertAlmostEqual(domed.bounds[0, 1], 20 - 1.5, delta=0.05)
        tip = domed.vertices[domed.vertices[:, 1] < 19.5]
        self.assertLessEqual(tip[:, 0].max() - tip[:, 0].min(), 2 + 1e-6)
        self.assertTrue(domed.is_volume)
        self.assertEqual(len(domed.split()), 1)


if __name__ == "__main__":
    unittest.main()
