"""The tip editor's DXF side: exact arcs out, edited arcs back in by handle."""
import json
import math
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import ezdxf

from sketch_arcs import read_sketch, write_arcs

ROOT = Path(__file__).resolve().parent.parent
EXAMPLES = ROOT / "hgc_requirements_documentation/change_path/examples"
POINTY = EXAMPLES / "Part Studio 1 - Sketch 1 (1).dxf"
LESS_POINTY = EXAMPLES / "lesspointz/Part Studio 1 - Sketch 1 (2).dxf"


def sweep(arc):
    a0 = math.atan2(arc["start"][1] - arc["center"][1], arc["start"][0] - arc["center"][0])
    a1 = math.atan2(arc["end"][1] - arc["center"][1], arc["end"][0] - arc["center"][0])
    return (a1 - a0) % math.tau


class ReadSketch(unittest.TestCase):
    def test_reference_quatrefoil(self):
        sketch = read_sketch(str(POINTY))
        self.assertEqual(len(sketch["lines"]), 4)
        self.assertEqual(len(sketch["arcs"]), 4)
        for arc in sketch["arcs"]:
            self.assertTrue(arc["handle"])                     # model-space: editable
            for end in ("start", "end"):
                self.assertAlmostEqual(math.dist(arc[end], arc["center"]), arc["radius"], places=9)
            # Counter-clockwise from start to end: each lobe bulges outward,
            # turning more than half a circle.
            self.assertGreater(sweep(arc), math.pi)

    def test_downward_extrusion_is_reported_counter_clockwise(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "flipped.dxf"
            doc = ezdxf.new()
            # In a -Z OCS, x is mirrored: OCS centre (−5, 0) is world (5, 0), and
            # the OCS-counter-clockwise 0°→90° runs clockwise in the world,
            # from (0, 0) to (5, 5)... i.e. counter-clockwise from (5, 5) to (0, 0).
            doc.modelspace().add_arc((-5, 0), 5, 0, 90, dxfattribs={"extrusion": (0, 0, -1)})
            doc.saveas(path)
            arc = read_sketch(str(path))["arcs"][0]
            self.assertEqual([round(v, 9) for v in arc["center"]], [5, 0])
            self.assertEqual([round(v, 9) for v in arc["start"]], [5, 5])
            self.assertEqual([round(v, 9) for v in arc["end"]], [0, 0])
            # Written back unchanged, it is the same world arc with +Z extrusion.
            write_arcs(str(path), [arc], str(path))
            again = read_sketch(str(path))["arcs"][0]
            for key in ("center", "start", "end"):
                self.assertAlmostEqual(math.dist(again[key], arc[key]), 0, places=9)
            self.assertEqual(tuple(ezdxf.readfile(path).modelspace()[0].dxf.extrusion), (0, 0, 1))

    def test_svg_and_block_arcs_are_not_editable(self):
        with tempfile.TemporaryDirectory() as tmp:
            svg = Path(tmp) / "s.svg"
            svg.write_text('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0H5"/></svg>')
            with self.assertRaisesRegex(ValueError, "DXF"):
                read_sketch(str(svg))
            path = Path(tmp) / "block.dxf"
            doc = ezdxf.new()
            block = doc.blocks.new("LOBE")
            block.add_arc((0, 0), 3, 0, 180)
            doc.modelspace().add_blockref("LOBE", (10, 0))
            doc.modelspace().add_lwpolyline([(0, 0), (4, 0)], dxfattribs={})
            doc.saveas(path)
            sketch = read_sketch(str(path))
            self.assertEqual([a["handle"] for a in sketch["arcs"]], [None])
            self.assertEqual([round(v, 9) for v in sketch["arcs"][0]["center"]], [10, 0])
            self.assertEqual(len(sketch["lines"]), 1)


class WriteArcs(unittest.TestCase):
    def test_edits_reproduce_the_cad_reference(self):
        goal = read_sketch(str(LESS_POINTY))
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "edited.dxf"
            write_arcs(str(POINTY), goal["arcs"], str(out))
            edited = read_sketch(str(out))
        self.assertEqual(edited["lines"], read_sketch(str(POINTY))["lines"])
        for want in goal["arcs"]:
            got = next(a for a in edited["arcs"] if a["handle"] == want["handle"])
            self.assertEqual(got["layer"], want["layer"])
            self.assertAlmostEqual(got["radius"], want["radius"], places=9)
            for key in ("center", "start", "end"):
                self.assertAlmostEqual(math.dist(got[key], want[key]), 0, places=9)

    def test_bad_edits_are_rejected(self):
        arc = read_sketch(str(POINTY))["arcs"][0]
        with tempfile.TemporaryDirectory() as tmp:
            out = str(Path(tmp) / "o.dxf")
            for edit in ({**arc, "handle": "FFFF"}, {**arc, "radius": -1},
                         {**arc, "center": [float("nan"), 0]}, {"handle": arc["handle"]}):
                with self.subTest(edit=edit), self.assertRaises(ValueError):
                    write_arcs(str(POINTY), [edit], out)

    def test_cli_round_trip(self):
        goal = read_sketch(str(LESS_POINTY))
        with tempfile.TemporaryDirectory() as tmp:
            edits, out = Path(tmp) / "edits.json", Path(tmp) / "edited.dxf"
            edits.write_text(json.dumps(goal["arcs"]))
            run = subprocess.run([sys.executable, "tools/dxf2stl.py", str(POINTY), str(out),
                                  "--sketch-edit", str(edits)], cwd=ROOT, capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertEqual(json.loads(run.stdout), {"arcs": 4})
            run = subprocess.run([sys.executable, "tools/dxf2stl.py", str(out), "--sketch"],
                                 cwd=ROOT, capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertEqual(len(json.loads(run.stdout)["arcs"]), 4)
            edits.write_text(json.dumps([{"handle": "nope"}]))
            run = subprocess.run([sys.executable, "tools/dxf2stl.py", str(POINTY), str(out),
                                  "--sketch-edit", str(edits)], cwd=ROOT, capture_output=True, text=True)
            self.assertNotEqual(run.returncode, 0)
            self.assertEqual(len(run.stderr.strip().splitlines()), 1, run.stderr)   # a message, not a traceback


if __name__ == "__main__":
    unittest.main()
