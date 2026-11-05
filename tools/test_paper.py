import json
import math
import re
import shutil
import tempfile
import unittest
from pathlib import Path

from shapely.geometry import Point, Polygon, box

from paper import (PaperError, View, Wall, build, checked_geometry, cutouts_of, echoed,
                   even_odd, fold_faces, scad_error, scad_problems, scad_svg_rings, template_layout)

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
TEMPLATE = str(ROOT / "paper_templates" / "house.scad")
ROW_HOUSE = str(ROOT / "paper_templates" / "papercut_fold_house2.scad")
WINDOW = str(TOOLS / "fixtures" / "paper-window.svg")

# The fixture window as polylines: a 20 × 30 frame with a cross through it.
FRAME = [[(0, 0), (20, 0), (20, 30), (0, 30), (0, 0)], [(10, 0), (10, 30)], [(0, 15), (20, 15)]]


class CutoutTests(unittest.TestCase):
    def test_frame_cuts_only_what_the_thickened_lines_enclose(self):
        cut, loose = cutouts_of(FRAME, 2)
        panes = sorted(cut.geoms, key=lambda p: p.bounds)
        self.assertEqual(len(panes), 4)
        self.assertEqual(loose, 0)
        for pane in panes:
            # 1 mm (half the bar) in from every line: 8 × 13 mm.
            self.assertAlmostEqual(pane.area, 8 * 13, delta=0.5)
        # The drawing's outermost line is not cut: everything stays inside it.
        self.assertTrue(box(0.99, 0.99, 19.01, 29.01).contains(cut))

    def test_thicker_lines_leave_smaller_panes(self):
        thin, _ = cutouts_of(FRAME, 1)
        thick, _ = cutouts_of(FRAME, 4)
        self.assertAlmostEqual(thick.area, 4 * 6 * 11, delta=1)
        self.assertGreater(thin.area, thick.area)

    def test_a_drawn_cutout_cuts_each_closed_outline_whole(self):
        cut, _ = cutouts_of(FRAME, 2, "drawn")
        self.assertAlmostEqual(cut.area, 600, delta=0.5)
        # A ghost with two eyes: the eyes fall out with the body, so one hole.
        ghost = [[(0, 0), (20, 0), (20, 30), (0, 30), (0, 0)],
                 [(5, 20), (8, 20), (8, 24), (5, 24), (5, 20)], [(12, 20), (15, 20), (15, 24), (12, 24), (12, 20)]]
        cut, _ = cutouts_of(ghost, 2, "drawn")
        self.assertEqual(cut.geom_type, "Polygon")
        self.assertEqual(len(cut.interiors), 0)
        self.assertAlmostEqual(cut.area, 600, delta=0.5)
        # Separate outlines are separate holes.
        cut, _ = cutouts_of([[(0, 0), (5, 0), (5, 5), (0, 5), (0, 0)], [(10, 0), (15, 0), (15, 5), (10, 5), (10, 0)]],
                            2, "drawn")
        self.assertEqual(len(cut.geoms), 2)

    def test_a_drawn_outline_with_a_small_break_still_closes(self):
        traced = [[(0.4, 0), (20, 0), (20, 30), (0, 30), (0, 0.1)]]     # 0.41 mm open at the corner
        cut, _ = cutouts_of(traced, 2, "drawn")
        self.assertAlmostEqual(cut.area, 600, delta=1)
        wide_open = [[(3, 0), (20, 0), (20, 30), (0, 30), (0, 3)]]
        cut, _ = cutouts_of(wide_open, 2, "drawn")
        self.assertTrue(cut.is_empty, "a real opening is not a cutout")

    def test_a_bar_touching_nothing_but_cut_outs_falls_out(self):
        ring = [(5 + math.cos(a / 8 * math.pi), 7 + math.sin(a / 8 * math.pi)) for a in range(17)]
        _, loose = cutouts_of([*FRAME[:2], ring], 0.4)
        self.assertEqual(loose, 1)

    def test_lines_too_thick_for_their_panes_cut_nothing(self):
        cut, _ = cutouts_of(FRAME, 25)
        self.assertTrue(cut.is_empty)

    def test_unknown_mode(self):
        with self.assertRaises(PaperError):
            cutouts_of(FRAME, 2, "lace")


class GeometryTests(unittest.TestCase):
    def test_client_geometry_is_checked(self):
        good = {"key": "k", "points": [[0, 0], [1, 0], [0, 1]], "paths": [[0, 1, 2]], "aspect": 1}
        self.assertEqual(checked_geometry(good)["paths"], [[0, 1, 2]])
        for bad in [{**good, "paths": [[0, 1, 3]]}, {**good, "points": [["x", 0]]},
                    {**good, "aspect": 0}, {"points": []}]:
            with self.assertRaises(PaperError):
                checked_geometry(bad)

    def test_openscad_svg_rings_are_even_odd_and_y_up(self):
        text = ('<svg><path d="\nM 0,-0 L 10,-0 L 10,-10 L 0,-10 z\n'
                'M 2,-2 L 4,-2 L 4,-4 L 2,-4 z\n" stroke="black"/></svg>')
        shape = even_odd(scad_svg_rings(text))
        self.assertAlmostEqual(shape.area, 96)
        self.assertEqual(shape.bounds, (0, 0, 10, 10))

    def test_echoed_values_and_assertion_messages(self):
        log = ('ECHO: "Floor"\nECHO: app_walls = [[[25, 25], [-1, 0], [0, 1], [50, 73]]]\n'
               'ERROR: Assertion \'(house_size > 16)\' failed: "House walls need room." in file x, line 3\n')
        self.assertEqual(echoed(log, "app_walls")[0][3], [50, 73])
        self.assertEqual(scad_error(log), "House walls need room.")
        with self.assertRaises(PaperError):
            echoed(log, "app_folds")

    def test_wall_coordinates_round_trip(self):
        # Wall 1 of the house: outside x runs left to right, y up the sheet.
        wall = Wall([[25, 25], [-1, 0], [0, 1], [50, 73]], View(inside_up=True))
        self.assertEqual(wall.origin, [-25, -25])
        self.assertEqual(wall.local((-15, -35)), (10, 10))
        self.assertTrue(wall.contains((0, -60)))
        self.assertFalse(wall.contains((0, 0)))
        self.assertEqual(wall.to_local(Point(-15, -35)).coords[0], (10, 10))
        # A net whose top face is the outside is only flipped upside down.
        upright = Wall([[7, 0], [1, 0], [0, 1], [55, 140]], View(inside_up=False))
        self.assertEqual((upright.origin, upright.ax, upright.ay), ([7, 0], [1, 0], [0, -1]))

    def test_template_layout_defaults_and_checks(self):
        log = "ECHO: app_folds = [[[0, 0], [1, 0]]]\n"
        layout = template_layout(log)
        self.assertEqual((layout["inside_up"], layout["fold_layer"], layout["up"], layout["base"]),
                         (True, True, [0, 0, 1], None))
        self.assertEqual(layout["folds"][0][2], 90, "folds turn 90° inward unless told")
        layout = template_layout(log + 'ECHO: app_net_top = "outside"\nECHO: app_fold_layer = false\n'
                                       "ECHO: app_up = [0, 1, 0]\nECHO: app_base = [64, 1]\n")
        self.assertEqual((layout["inside_up"], layout["fold_layer"], layout["up"], layout["base"]),
                         (False, False, [0, 1, 0], [64, 1]))
        for bad in ['ECHO: app_net_top = "sideways"', "ECHO: app_up = [0, 0, 0]", "ECHO: app_fold_layer = 1"]:
            with self.assertRaises(PaperError):
                template_layout(log + bad + "\n")

    def test_openscad_errors_that_do_not_fail_become_notes(self):
        log = ("ERROR: Can't open file '/a/b/veryos_logo.svg', import() at line 157\n"
               "ERROR: Can't open file '/a/b/veryos_logo.svg', import() at line 157\nECHO: x = 1\n")
        self.assertEqual(scad_problems(log), ["the template could not open veryos_logo.svg; put it beside the template"])

    def test_faces_fold_up_from_the_base(self):
        # A floor with one flap on top and a tab on the flap's right.
        net = Polygon([(0, 0), (10, 0), (10, 10), (12, 11), (12, 19), (10, 20), (0, 20), (0, 10)])
        folds = [((0, 10), (10, 10), 90), ((10, 10), (10, 20), 45)]
        _, faces = fold_faces(net, folds, base=(5, 5))
        self.assertEqual(len(faces), 3)
        root = next(i for i, f in enumerate(faces) if f["parent"] == -1)
        flap = next(i for i, f in enumerate(faces) if f["parent"] == root)
        tab = next(i for i, f in enumerate(faces) if f["parent"] == flap)
        self.assertEqual(faces[tab]["angle"], 45)
        for i in (flap, tab):
            # Turning right-handed about a → b lifts the face: it lies to the hinge's left.
            (ax, ay), (bx, by) = faces[i]["hinge"]
            cx, cy = Polygon(faces[i]["rings"][0]).centroid.coords[0]
            self.assertGreater((bx - ax) * (cy - ay) - (by - ay) * (cx - ax), 0)

    def test_perforated_folds_still_join_their_faces(self):
        # Two squares joined by a fold cut as slits: 2.6 mm slits, 2 mm bridges.
        sheet = box(0, 0, 20, 10)
        for i in range(4):
            y = 1.4 + i * 4.6
            sheet = sheet.difference(box(9.775, y, 10.225, y + 2.6))
        polygons, faces = fold_faces(sheet, [((10, 0), (10, 10), 90)], base=(2, 2))
        self.assertEqual(len(faces), 2)
        root = next(i for i, f in enumerate(faces) if f["parent"] == -1)
        self.assertEqual([f["parent"] for i, f in enumerate(faces) if i != root], [root])


@unittest.skipUnless(shutil.which("openscad"), "OpenSCAD is not installed")
class BuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def build(self, decorations=(), **params):
        return build({"template": TEMPLATE, "params": params, "decorations": list(decorations)},
                     workdir=self.temp.name)

    def test_the_plain_house(self):
        result = self.build()
        self.assertEqual(len(result["walls"]), 4)
        self.assertEqual(len(result["faces"]), 9, "floor, four walls, four glue tabs")
        self.assertEqual(result["info"]["cutouts"], 0, "the default house has no windows")
        self.assertEqual((result["info"]["width"], result["info"]["height"]), (196, 196))
        self.assertIn('<g id="cut"', result["svg"])
        self.assertIn('<g id="fold"', result["svg"])
        self.assertIn('width="206mm"', result["svg"])

    def test_a_window_is_centred_in_its_wall_and_seen_from_outside(self):
        result = self.build([{"file": WINDOW, "name": "window", "wall": 0, "thickness": 2}])
        d = result["decorations"][0]
        area = result["walls"][0]["area"]
        self.assertAlmostEqual(d["x"], (area[0] + area[2]) / 2, places=1)
        self.assertAlmostEqual(d["y"], (area[1] + area[3]) / 2, places=1)
        self.assertEqual(d["width"], 20)
        self.assertEqual(result["info"]["cutouts"], 4)
        # Left of the wall's middle as seen from outside, its panes sit left of
        # the middle of the net's top arm: the net is shown from outside too.
        left = self.build([{"file": WINDOW, "name": "window", "wall": 0, "x": 15, "y": 30,
                            "width": 10, "thickness": 1}])
        rings = [[float(v) for v in re.findall(r"-?[\d.]+", ring)] for ring in left["net"].split("M")[1:]]
        holes = [ring for ring in rings if max(ring[1::2]) < -25]   # the top arm: y above the floor
        self.assertEqual(len(holes), 4)
        self.assertTrue(all(max(ring[0::2]) < 0 for ring in holes))

    def test_the_drawing_comes_along_for_the_thumbnail(self):
        result = self.build([{"file": WINDOW, "name": "window", "wall": 0, "width": 20, "thickness": 2}])
        lines = result["decorations"][0]["geometry"]["lines"]
        self.assertEqual(len(lines), 3, "frame and the two bars of the cross")
        xs = [x for line in lines for x, _ in line]
        self.assertAlmostEqual(min(xs), -0.5)
        self.assertAlmostEqual(max(xs), 0.5)
        # Sent back to move it, the geometry leaves its lines behind.
        moved = self.build([{**result["decorations"][0], "name": "window", "x": 20}])
        self.assertNotIn("lines", moved["decorations"][0]["geometry"])

    def test_older_silhouette_decorations_are_cut_as_drawn(self):
        result = self.build([{"file": WINDOW, "name": "window", "wall": 0, "mode": "silhouette"}])
        self.assertEqual(result["decorations"][0]["mode"], "drawn")
        self.assertEqual(result["info"]["cutouts"], 1)

    def test_geometry_from_an_earlier_answer_is_reused(self):
        first = self.build([{"file": WINDOW, "name": "window", "wall": 1, "thickness": 2}])
        d = first["decorations"][0]
        moved = self.build([{**d, "name": "window", "y": d["y"] + 5}])
        self.assertEqual(moved["info"]["cutouts"], 4)
        with self.assertRaisesRegex(PaperError, "drawing is needed"):
            self.build([{**d, "name": "window", "width": d["width"] + 5}])

    def test_trimmed_and_misplaced_decorations_are_reported(self):
        result = self.build([{"file": WINDOW, "name": "edge", "wall": 2, "x": 2, "y": 30, "width": 20,
                              "thickness": 2},
                             {"file": WINDOW, "name": "gone", "wall": 3, "x": 25, "y": -40, "width": 10,
                              "thickness": 2}])
        notes = " ".join(result["info"]["notes"])
        self.assertIn("edge runs past wall 3's decoration area", notes)
        self.assertIn("gone lies outside wall 4's decoration area", notes)

    def test_template_parameters_and_assertions(self):
        gable = self.build(roof_style="gable", house_size=60)
        self.assertEqual(gable["walls"][0]["size"], [60, 73])
        with self.assertRaisesRegex(PaperError, "House walls need room"):
            self.build(house_size=10)

    def test_the_row_house_template(self):
        plain = build({"template": ROW_HOUSE}, workdir=self.temp.name)
        # No windows of its own; the door opens at the bottom edge, and the fold slits are not counted.
        self.assertEqual(plain["info"]["cutouts"], 0)
        result = build({"template": ROW_HOUSE, "decorations": [
            {"file": WINDOW, "name": "window", "wall": 1, "x": 40, "y": 50, "width": 10, "thickness": 1}]},
            workdir=self.temp.name)
        self.assertEqual(result["netTop"], "outside")
        self.assertEqual(result["up"], [0, 1, 0])
        self.assertFalse(result["foldLayer"])
        self.assertNotIn('<g id="fold"', result["svg"], "the cut already perforates the folds")
        self.assertEqual([w["size"] for w in result["walls"]], [[55, 140], [80, 100], [55, 140], [80, 100]])
        # Not mirrored: wall 1 is the first wall left to right, flipped upside down for SVG.
        self.assertEqual(result["walls"][0]["origin"], [7, 0])
        self.assertEqual(result["walls"][0]["y"], [0, -1])
        self.assertEqual(result["info"]["cutouts"], 4)
        self.assertTrue(any("veryos_logo.svg" in note for note in result["info"]["notes"]))
        # Four walls, two roof halves and six tabs (corner, gable, ridge and three roof
        # side tabs), all hinged to wall 2, which stays put.
        faces = result["faces"]
        self.assertEqual(len(faces), 12)
        roots = [i for i, f in enumerate(faces) if f["parent"] == -1]
        self.assertEqual(roots, [result["walls"][1]["face"]])
        self.assertEqual(len({w["face"] for w in result["walls"]}), 4)
        # The net's top is the outside, so inward folds turn the faces down (negative).
        self.assertTrue(all(f["angle"] < 0 for f in faces if f["parent"] >= 0))
        # The window is cut into wall 2, clear of its edges.
        area = result["walls"][1]["area"]
        self.assertEqual(area, [3, 3, 77, 97])

    def test_job_files_from_the_command_line(self):
        job = Path(self.temp.name) / "job.json"
        job.write_text(json.dumps({"template": TEMPLATE, "decorations": [
            {"file": WINDOW, "wall": 0, "thickness": 2}]}))
        import subprocess
        import sys
        out = Path(self.temp.name) / "net.svg"
        run = subprocess.run([sys.executable, str(TOOLS / "paper.py"), str(job), "--output", str(out)],
                             capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(run.stdout)["info"]["cutouts"], 4)
        self.assertTrue(out.read_text().startswith("<?xml"))


if __name__ == "__main__":
    unittest.main()
