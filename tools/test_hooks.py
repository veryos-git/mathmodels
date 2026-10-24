"""Hooks stand up out of the frame, swept from the main profile at path vertices."""
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import trimesh
from shapely.geometry import Polygon

from gothic import hook_sections, hook_solid

ROOT = Path(__file__).resolve().parent.parent
# The reference moulding: 10 mm wide, a 5.34 mm gable ridge.
PROFILE = Polygon([(0, 0), (10, 0), (10, 1.13), (8.05, 3.08), (6.93, 3.08), (5, 5.34),
                   (3.07, 3.08), (1.95, 3.08), (0, 1.13)])


class HookSections(unittest.TestCase):
    """The (along, up) paths a hook sweeps, in the vertical plane at the endpoint."""

    def test_round_rises_tangent_then_curls_over_the_big_circle(self):
        chains, (tip, direction, up), joints = hook_sections(
            {"type": "round", "small_radius": 6, "big_radius": 14, "angle": 200}, 5.34)
        rise, curl = (np.asarray(c) for c in chains)
        # Leaves the endpoint along the ground, first bending upward.
        np.testing.assert_allclose(rise[0], (0, 0), atol=1e-9)
        self.assertAlmostEqual(rise[1][1] / rise[1][0], 0, delta=0.2)
        self.assertGreater(rise[1][1], 0)
        # Both circles rest on the ground and touch: 2*sqrt(6*14) apart.
        gap = 2 * np.sqrt(84)
        np.testing.assert_allclose(np.linalg.norm(curl - (gap, 14), axis=1), 14, atol=1e-9)
        # The tip is 200° round the big circle from its ground point.
        np.testing.assert_allclose(tip, (gap + 14 * np.sin(np.radians(20)),
                                         14 + 14 * np.cos(np.radians(20))), atol=1e-9)
        self.assertEqual(len(joints), 1)            # the reverse-curve joint
        np.testing.assert_allclose(np.linalg.norm(up), 1, atol=1e-9)

    def test_straight_is_a_bracket_with_a_post_at_the_endpoint(self):
        chains, (tip, direction, _), _ = hook_sections(
            {"type": "straight", "length": 33, "angle": 26, "overhang": 13}, 5.34)
        bottom, post, bar = (np.asarray(c) for c in chains)
        self.assertTrue(np.allclose(bottom[:, 1], 0))           # along the ground
        self.assertTrue(np.allclose(post[:, 0], 0))             # upright at the endpoint
        # The post ends where the bar's centre line crosses it.
        self.assertAlmostEqual(post[-1][1], 33 * np.tan(np.radians(26)))
        # The bar rises back over the frame (negative along) past the post.
        self.assertLess(tip[0], 0)
        self.assertAlmostEqual(np.degrees(np.arctan2(direction[1], -direction[0])), 26)

    def test_bad_parameters_are_rejected(self):
        for spec in ({"type": "straight", "length": 0},
                     {"type": "straight", "angle": 90},
                     {"type": "straight", "overhang": -1},
                     {"type": "round", "big_radius": -1},
                     {"type": "round", "angle": 400},
                     {"type": "round", "angle": 30},
                     {"type": "spiral"}):
            with self.subTest(spec):
                with self.assertRaises(ValueError):
                    hook_sections(spec, 5.34)


class HookSolid(unittest.TestCase):
    """Each hook is one printable body standing on the base plane."""

    def test_round_hook_matches_the_reference_size(self):
        # The big circle tops out at 28 mm (the reference STEP reaches 32.2
        # only through its 180° tip revolve).
        mesh = hook_solid(PROFILE, (0, 0), (1, 0), {"type": "round"})
        loaded = trimesh.load(io.BytesIO(mesh.export(file_type="stl")), file_type="stl")
        self.assertTrue(loaded.is_volume)
        self.assertEqual(len(loaded.split()), 1)
        self.assertAlmostEqual(loaded.bounds[0, 2], 0, places=4)   # nothing below
        self.assertAlmostEqual(loaded.bounds[1, 2], 28.0, delta=0.3)
        # It stands in the vertical plane through the travel direction:
        # across the path it is exactly the profile's width.
        self.assertAlmostEqual(loaded.extents[1], 10, places=3)

    def test_straight_hook_is_built_like_the_reference(self):
        # hook/24-10-2026: the sketch's three lines and the STEP's bodies.
        # Bottom bar 33.23 long, post 16.32 high, the bar's line ends at
        # (11.09, 21.77) past the post; reference profile 5.34 high.
        length, post, tip = 33.2279, 16.3222, np.array([11.0908, 21.7701])
        spec = {"type": "straight", "length": length,
                "angle": np.degrees(np.arctan2(post, length)),
                "overhang": float(np.hypot(tip[0], tip[1] - post))}
        h, a = 5.338, np.arctan2(post, length)
        mesh = hook_solid(PROFILE, (0, 0), (1, 0), spec, inset=0)
        loaded = trimesh.load(io.BytesIO(mesh.export(file_type="stl")), file_type="stl")
        self.assertTrue(loaded.is_volume)
        self.assertEqual(len(loaded.split()), 1)
        # Along the path (our +x is the reference's -Y): the 180° knob reaches
        # one profile height past the bar's end, forward and up; the bar's top
        # face meets the ground 45.33 out (the STEP's cut face).
        self.assertAlmostEqual(mesh.bounds[0, 0], -(tip[0] + h), delta=0.1)
        self.assertAlmostEqual(mesh.bounds[1, 0], 45.334, delta=0.01)
        self.assertAlmostEqual(mesh.bounds[0, 2], 0, places=4)
        self.assertAlmostEqual(mesh.bounds[1, 2], tip[1] + h, delta=0.1)
        self.assertAlmostEqual(mesh.extents[1], 10, places=3)

        def heights(s):
            return mesh.section(plane_origin=(s, 0, 0), plane_normal=(1, 0, 0)).vertices[:, 2]
        # Over the overhang the bar has the profile on both faces of its line.
        line = post + 6 * np.tan(a)
        cut = heights(-6)
        self.assertAlmostEqual(cut.min(), line - h / np.cos(a), delta=0.01)
        self.assertAlmostEqual(cut.max(), line + h / np.cos(a), delta=0.01)
        # So does the post (Parts 3 and 4), centred on the vertex (cut between
        # the bottom bar's top and the bar's underside)...
        level = mesh.section(plane_origin=(0, 0, 6), plane_normal=(0, 0, 1)).vertices[:, 0]
        level = level[level < 8]
        self.assertAlmostEqual(level.min(), -h, delta=0.01)
        self.assertAlmostEqual(level.max(), h, delta=0.01)
        # ...while the bottom bar (Part 2) carries it on top only.
        low = heights(8)
        low = low[low < 6]
        self.assertAlmostEqual(low.min(), 0, places=4)
        self.assertAlmostEqual(low.max(), h, delta=0.01)

    def test_straight_tip_is_a_half_round_unless_square(self):
        # The bar has the profile on both faces, so a rounded tip rolls the
        # end section 180° from one face to the other: quarter and half agree.
        spec = {"type": "straight", "length": 33, "angle": 26, "overhang": 13}
        half = hook_solid(PROFILE, (0, 0), (1, 0), {**spec, "tip": "half"})
        quarter = hook_solid(PROFILE, (0, 0), (1, 0), {**spec, "tip": "quarter"})
        square = hook_solid(PROFILE, (0, 0), (1, 0), {**spec, "tip": "square"})
        self.assertAlmostEqual(half.volume, quarter.volume, places=6)
        self.assertLess(square.volume, half.volume)
        _, (tip, direction, _), _ = hook_sections(spec, 5.34)
        self.assertAlmostEqual(half.bounds[0, 0], (tip - 0.05 * direction)[0] - 5.34, delta=0.05)
        with self.assertRaises(ValueError):
            hook_solid(PROFILE, (0, 0), (1, 0), {**spec, "tip": "pointy"})

    def test_round_tip_rolls_a_quarter_or_a_half_turn(self):
        quarter, half, square = (hook_solid(PROFILE, (0, 0), (1, 0), {"type": "round", "tip": t})
                                 for t in ("quarter", "half", "square"))
        self.assertLess(square.volume, quarter.volume)
        self.assertLess(quarter.volume, half.volume)

    def test_hook_follows_the_given_direction(self):
        mesh = hook_solid(PROFILE, (5, 5), (0, -1), {"type": "round"})
        self.assertLess(mesh.bounds[0, 1], -15)    # runs out towards -Y
        self.assertAlmostEqual(mesh.extents[0], 10, places=3)


class HookCli(unittest.TestCase):
    """The converter fuses hooks onto the swept frame as a single body."""

    def test_round_and_straight_hooks_fuse_onto_the_frame(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            frame = tmp / "frame.svg"
            profile = tmp / "profile.svg"
            hooks = tmp / "hooks.json"
            out = tmp / "hooked.stl"
            # An open L-path; the converter flips SVG Y, so its ends are at
            # (10, 10) and (70, 70) in model coordinates.
            frame.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="80mm" '
                             'height="80mm" viewBox="0 0 80 80">'
                             '<path d="M10 70 V10 H70" fill="none" stroke="black"/></svg>')
            profile.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="4mm" '
                               'height="3mm" viewBox="0 0 4 3"><path d="M0 0H4V3H0Z"/></svg>')
            hooks.write_text(json.dumps([
                {"x": 10, "y": 10, "type": "round"},
                {"x": 70, "y": 70, "type": "straight", "length": 25, "angle": 30,
                 "overhang": 8, "cap": True},
            ]))
            result = subprocess.run([
                sys.executable, "tools/dxf2stl.py", str(frame), str(out),
                "--profile", str(profile), "--frame-only", "--hooks", str(hooks),
            ], cwd=ROOT, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            mesh = trimesh.load(out)
            self.assertTrue(mesh.is_volume)
            self.assertEqual(len(mesh.split()), 1)
            # The round hook runs on past the (10, 10) end towards -Y, and
            # both hooks stand up well above the 3 mm frame.
            self.assertLess(mesh.bounds[0, 1], -10)
            self.assertGreater(mesh.bounds[1, 2], 25)

    def test_hook_fuses_onto_a_closed_loop_corner(self):
        # A closed frame has no free ends; every corner is still placeable and
        # the hook leaves perpendicular, away from the loop.
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            box = tmp / "box.svg"
            profile = tmp / "profile.svg"
            hooks = tmp / "hooks.json"
            out = tmp / "hooked.stl"
            box.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="80mm" '
                           'height="80mm" viewBox="0 0 80 80">'
                           '<path d="M10 10 H70 V70 H10 Z" fill="none" stroke="black"/></svg>')
            profile.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="4mm" '
                               'height="3mm" viewBox="0 0 4 3"><path d="M0 0H4V3H0Z"/></svg>')
            hooks.write_text(json.dumps([
                {"x": 10, "y": 10, "type": "round", "small_radius": 5,
                 "big_radius": 12, "angle": 200},
            ]))
            result = subprocess.run([
                sys.executable, "tools/dxf2stl.py", str(box), str(out),
                "--profile", str(profile), "--frame-only", "--hooks", str(hooks),
            ], cwd=ROOT, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            mesh = trimesh.load(out)
            self.assertTrue(mesh.is_volume)
            self.assertEqual(len(mesh.split()), 1)
            # The corner hook leaves perpendicular, away from the loop centre,
            # so it protrudes past the frame's lower-left corner (~8 mm).
            self.assertLess(min(mesh.bounds[0, :2]), 0)
            self.assertGreater(mesh.bounds[1, 2], 20)

    def test_hooks_all_face_down_the_drawing_and_rotate(self):
        # Three paths meet at (40, 40); a hook there and at a free end both
        # face -Y regardless of the paths, and a shared vertex gets one hook.
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            frame = tmp / "frame.svg"
            profile = tmp / "profile.svg"
            hooks = tmp / "hooks.json"
            frame.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="80mm" '
                             'height="80mm" viewBox="0 0 80 80">'
                             '<path d="M10 40 H40 M40 40 H70 M40 40 L60 10" fill="none" '
                             'stroke="black"/></svg>')
            profile.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="4mm" '
                               'height="3mm" viewBox="0 0 4 3"><path d="M0 0H4V3H0Z"/></svg>')

            def build(spec):
                hooks.write_text(json.dumps([{"x": 40, "y": 40, "type": "straight", **spec}]))
                out = tmp / "hooked.stl"
                result = subprocess.run([
                    sys.executable, "tools/dxf2stl.py", str(frame), str(out),
                    "--profile", str(profile), "--frame-only", "--hooks", str(hooks),
                ], cwd=ROOT, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                return trimesh.load(out)

            down = build({"length": 20, "angle": 30, "overhang": 5})
            self.assertTrue(down.is_volume)
            # Bottom bar runs 20 mm down from (40, 40) to y = 20; the bar's
            # foot reaches 3 mm / sin 30° further before the ground cut. One
            # hook, aligned with -Y, standing 4 mm wide across X.
            self.assertAlmostEqual(down.bounds[0, 1], 20 - 3 / 0.5, delta=0.05)
            high = down.vertices[down.vertices[:, 2] > 5]
            self.assertAlmostEqual(float(np.ptp(high[:, 0])), 4, delta=0.01)
            turned = build({"length": 20, "angle": 30, "overhang": 5, "rotation": 90})
            high = turned.vertices[turned.vertices[:, 2] > 5]
            self.assertAlmostEqual(float(np.ptp(high[:, 1])), 4, delta=0.01)
            self.assertGreater(turned.bounds[1, 0], 70 - 1)   # +X after 90° CCW from -Y

    def test_hooks_are_added_after_the_groove_unless_it_is_cut_last(self):
        # The hook at the (10, 70) corner runs its bottom bar down the grooved
        # vertical path: by default the hook stays whole over it and the
        # groove stops there; --groove-last cuts the groove through the hook.
        import manifold3d as mf

        def solid_at(mesh, point):
            body = mf.Manifold(mf.Mesh(vert_properties=np.asarray(mesh.vertices, np.float32),
                                       tri_verts=np.asarray(mesh.faces, np.uint32)))
            return (body ^ mf.Manifold.cube((0.1, 0.1, 0.1), True).translate(point)).volume() > 9e-4

        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            frame, profile, groove, hooks = (tmp / n for n in ("frame.svg", "p.svg", "g.svg", "h.json"))
            frame.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="80mm" '
                             'height="80mm" viewBox="0 0 80 80">'
                             '<path d="M10 70 V10 H70" fill="none" stroke="black"/></svg>')
            profile.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="4mm" '
                               'height="3mm" viewBox="0 0 4 3"><path d="M0 0H4V3H0Z"/></svg>')
            # A 1 mm wide slot, 1 mm deep from the top of the 3 mm profile.
            groove.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="4mm" '
                              'height="3mm" viewBox="0 0 4 3"><path d="M1.5 -1H2.5V1H1.5Z"/></svg>')
            hooks.write_text(json.dumps([{"x": 10, "y": 70, "type": "straight", "length": 20,
                                          "angle": 30, "overhang": 5}]))

            def build(*flags):
                out = tmp / "hooked.stl"
                result = subprocess.run([
                    sys.executable, "tools/dxf2stl.py", str(frame), str(out),
                    "--profile", str(profile), "--groove-profile", str(groove),
                    "--frame-only", "--hooks", str(hooks), *flags,
                ], cwd=ROOT, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                mesh = trimesh.load(out)
                self.assertTrue(mesh.is_volume)
                self.assertEqual(len(mesh.split()), 1)
                return mesh

            under_hook, bare_frame = (10, 60, 2.5), (10, 30, 2.5)   # inside the slot
            default, last = build(), build("--groove-last")
            self.assertTrue(solid_at(default, under_hook))
            self.assertFalse(solid_at(default, bare_frame))
            self.assertFalse(solid_at(last, under_hook))
            self.assertFalse(solid_at(last, bare_frame))
            self.assertGreater(default.volume, last.volume)

    def test_offset_slides_a_hook_up_the_drawing(self):
        # The hook at (40, 40) moves 7 mm up the drawing's vertical axis; its
        # bottom bar still crosses the horizontal path, so it stays fused.
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            frame = tmp / "frame.svg"
            profile = tmp / "profile.svg"
            hooks = tmp / "hooks.json"
            frame.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="80mm" '
                             'height="80mm" viewBox="0 0 80 80">'
                             '<path d="M10 40 H70 M40 40 L60 10" fill="none" '
                             'stroke="black"/></svg>')
            profile.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="4mm" '
                               'height="3mm" viewBox="0 0 4 3"><path d="M0 0H4V3H0Z"/></svg>')

            def build(offset):
                hooks.write_text(json.dumps([{"x": 40, "y": 40, "type": "straight", "length": 20,
                                              "angle": 30, "overhang": 5, "offset": offset}]))
                out = tmp / "hooked.stl"
                result = subprocess.run([
                    sys.executable, "tools/dxf2stl.py", str(frame), str(out),
                    "--profile", str(profile), "--frame-only", "--hooks", str(hooks),
                ], cwd=ROOT, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                return trimesh.load(out)

            still, moved = build(0), build(7)
            self.assertTrue(moved.is_volume)
            self.assertEqual(len(moved.split()), 1)
            # Above the 3 mm frame there is only hook: all of it shifted +Y.
            high, shifted = (m.vertices[m.vertices[:, 2] > 5] for m in (still, moved))
            self.assertAlmostEqual(shifted[:, 1].min() - high[:, 1].min(), 7, delta=0.01)
            self.assertAlmostEqual(shifted[:, 1].max() - high[:, 1].max(), 7, delta=0.01)
            self.assertAlmostEqual(float(np.ptp(shifted[:, 0])), 4, delta=0.01)
            self.assertAlmostEqual(moved.bounds[0, 1], 20 - 3 / 0.5 + 7, delta=0.05)

    def test_hook_without_profile_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            frame = tmp / "frame.svg"
            hooks = tmp / "hooks.json"
            frame.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="80mm" '
                             'height="80mm" viewBox="0 0 80 80">'
                             '<path d="M10 70 V10 H70" fill="none" stroke="black"/></svg>')
            hooks.write_text(json.dumps([{"x": 10, "y": 10, "type": "round"}]))
            result = subprocess.run([
                sys.executable, "tools/dxf2stl.py", str(frame), str(tmp / "o.stl"),
                "--frame-only", "--hooks", str(hooks),
            ], cwd=ROOT, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("profile", result.stderr.lower())


if __name__ == "__main__":
    unittest.main()
