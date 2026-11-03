"""Profile colours: rectangles over a section print their share of the swept frame."""
import base64
import io
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

import trimesh

from profile_colours import colour_label, colour_of, colour_region, parse_colours

ROOT = Path(__file__).resolve().parent.parent
SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="{w}mm" height="{h}mm" viewBox="0 0 {w} {h}">{body}</svg>'
# A 4 mm wide, 3 mm high section, anchored on its centre line and base.
PROFILE = SVG.format(w=4, h=3, body='<path d="M0 0H4V3H0Z"/>')
STRAIGHT = SVG.format(w=80, h=20, body='<path d="M10 10 H70" fill="none" stroke="black"/>')
L_PATH = SVG.format(w=80, h=80, body='<path d="M10 70 V10 H70" fill="none" stroke="black"/>')


def run(tmp, frame, out, colours=None, *extra):
    tmp = Path(tmp)
    (tmp / "frame.svg").write_text(frame)
    (tmp / "profile.svg").write_text(PROFILE)
    args = [sys.executable, "tools/dxf2stl.py", str(tmp / "frame.svg"), *([str(out)] if out else []),
            "--profile", str(tmp / "profile.svg"), "--frame-only", *extra]
    if colours is not None:
        (tmp / "colours.json").write_text(json.dumps(colours))
        args += ["--profile-colors", str(tmp / "colours.json")]
    return subprocess.run(args, cwd=ROOT, capture_output=True, text=True)


def split(tmp, frame, colours, *extra):
    out = Path(tmp) / "parts"
    result = run(tmp, frame, out, colours, "--split", *extra)
    if result.returncode:
        raise AssertionError(result.stderr)
    return {path.stem: trimesh.load(path) for path in sorted(out.glob("*.stl"))}


def whole(tmp, frame, *extra):
    out = Path(tmp) / "whole.stl"
    result = run(tmp, frame, out, None, *extra)
    if result.returncode:
        raise AssertionError(result.stderr)
    return trimesh.load(out)


class Parsing(unittest.TestCase):
    def test_entries_are_validated_and_normalised(self):
        [entry] = parse_colours([{"color": "#E11D48", "rect": [2, 3, -1, 0], "mirrorX": 1}])
        self.assertEqual(entry, {"section": "main", "color": "#e11d48", "rect": (-1, 0, 2, 3),
                                 "mirrorX": True, "mirrorY": False})
        for bad in ({"color": "red", "rect": [0, 0, 1, 1]},
                    {"color": "#e11d48", "rect": [0, 0, 1]},
                    {"color": "#e11d48", "rect": [0, 0, 0, 1]},
                    {"color": "#e11d48", "rect": [0, 0, "x", 1]},
                    {"color": "#e11d48", "rect": [0, 0, 1, 1], "section": "groove"}):
            with self.assertRaises(ValueError, msg=bad):
                parse_colours([bad])
        with self.assertRaises(ValueError):
            parse_colours({"color": "#e11d48"})
        with self.assertRaises(ValueError):
            parse_colours([{"color": "#e11d48", "rect": [0, 0, 1, 1]}] * 33)

    def test_labels_round_trip_and_never_look_like_palette_rows(self):
        self.assertEqual(colour_label("#E11D48"), "frame-e11d48")
        self.assertEqual(colour_of("frame-e11d48"), "#e11d48")
        self.assertIsNone(colour_of("walls"))
        self.assertIsNone(colour_of("2-lime"))

    def test_mirrors_follow_the_section_transform(self):
        [entry] = parse_colours([{"color": "#e11d48", "rect": [1, 0, 1.5, 1], "mirrorX": True, "mirrorY": True}])
        # Twice as wide, half as tall, lifted 1 mm: the section is [-4, 1, 4, 2.5].
        region = colour_region(entry, (2, .5, 1), (-4, 1, 4, 2.5))
        self.assertAlmostEqual(region.area, 4 * (1 * .5))
        self.assertEqual(len(getattr(region, "geoms", [region])), 4)
        # Mirror Y reflects across the section's mid-height (1.75 mm).
        self.assertAlmostEqual(region.bounds[1], 1)
        self.assertAlmostEqual(region.bounds[3], 2.5)
        self.assertAlmostEqual(region.bounds[0], -3)

    def test_regions_are_clipped_to_the_section_with_a_margin(self):
        [entry] = parse_colours([{"color": "#e11d48", "rect": [-100, 2, 100, 100]}])
        left, bottom, right, top = colour_region(entry, (1, 1, 0), (-2, 0, 2, 3)).bounds
        self.assertAlmostEqual(bottom, 2)
        self.assertTrue(2 < right < 2.2 and -2.2 < left < -2 and 3 < top < 3.2)


class Split(unittest.TestCase):
    """The colour parts and the rest partition the frame exactly."""

    def test_straight_sweep_splits_into_exact_volumes(self):
        colours = [{"color": "#e11d48", "rect": [1, -1, 2.5, 5], "mirrorX": True},
                   {"color": "#f59e0b", "rect": [-9, 2.5, 9, 9]}]
        with tempfile.TemporaryDirectory() as tmp:
            parts = split(tmp, STRAIGHT, colours)
        self.assertEqual(set(parts), {"frame-e11d48", "frame-f59e0b", "walls"})
        for mesh in parts.values():
            self.assertTrue(mesh.is_volume)
        # 60 mm of a 4 × 3 section: both 1 mm side strips, then the 0.5 mm
        # band between them (the earlier colour keeps the strips' tops).
        self.assertAlmostEqual(parts["frame-e11d48"].volume, 2 * 1 * 3 * 60, delta=.05)
        self.assertAlmostEqual(parts["frame-f59e0b"].volume, 2 * .5 * 60, delta=.05)
        self.assertAlmostEqual(parts["walls"].volume, 4 * 3 * 60 - 360 - 60, delta=.05)

    def test_hooks_endings_and_grooves_are_coloured_like_the_frame(self):
        hooks = [{"x": 70, "y": 70, "type": "straight", "length": 20, "angle": 30, "overhang": 6}]
        colours = [{"color": "#10b981", "rect": [-3, 2, 3, 4]}]
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "hooks.json").write_text(json.dumps(hooks))
            (Path(tmp) / "groove.svg").write_text(SVG.format(w=4, h=3, body='<path d="M1.6 0H2.4V1H1.6Z"/>'))
            extra = ("--hooks", str(Path(tmp) / "hooks.json"), "--round-ends",
                     "--groove-profile", str(Path(tmp) / "groove.svg"))
            parts = split(tmp, L_PATH, colours, *extra)
            frame = whole(tmp, L_PATH, *extra)
        self.assertEqual(set(parts), {"frame-10b981", "walls"})
        self.assertTrue(all(mesh.is_volume for mesh in parts.values()))
        total = sum(mesh.volume for mesh in parts.values())
        self.assertAlmostEqual(total, frame.volume, delta=frame.volume * 1e-3)
        # The top band follows the straight hook up out of the frame.
        top = parts["frame-10b981"]
        self.assertGreater(top.bounds[1, 2], 10)
        self.assertGreater(top.volume, 0.2 * frame.volume)

    def test_cusp_colours_need_cusp_paths(self):
        colours = [{"section": "cusp", "color": "#10b981", "rect": [-3, 0, 3, 4]}]
        with tempfile.TemporaryDirectory() as tmp:
            parts = split(tmp, STRAIGHT, colours)
        self.assertEqual(set(parts), {"walls"})

    def test_preview_sends_each_colour_as_its_own_mesh(self):
        colours = [{"color": "#e11d48", "rect": [1, -1, 2.5, 5], "mirrorX": True}]
        with tempfile.TemporaryDirectory() as tmp:
            result = run(tmp, STRAIGHT, None, colours, "--regions")
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        [part] = data["wallParts"]
        self.assertEqual((part["group"], part["color"]), ("frame-e11d48", "#e11d48"))
        coloured = trimesh.load(io.BytesIO(base64.b64decode(part["mesh"])), file_type="stl")
        rest = trimesh.load(io.BytesIO(base64.b64decode(data["wallMesh"])), file_type="stl")
        self.assertAlmostEqual(coloured.volume, 360, delta=.05)
        self.assertAlmostEqual(rest.volume, 360, delta=.05)

    def test_project_3mf_gives_each_colour_its_own_part(self):
        colours = [{"color": "#e11d48", "rect": [1, -1, 2.5, 5]}]
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "model.3mf"
            result = run(tmp, STRAIGHT, out, colours)
            self.assertEqual(result.returncode, 0, result.stderr)
            with zipfile.ZipFile(out) as archive:
                settings = archive.read("Metadata/model_settings.config").decode()
        self.assertIn('value="frame-e11d48"', settings)
        self.assertIn('value="walls"', settings)

    def test_colours_need_a_profile(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "frame.svg").write_text(STRAIGHT)
            (Path(tmp) / "colours.json").write_text(json.dumps([{"color": "#e11d48", "rect": [0, 0, 1, 1]}]))
            result = subprocess.run([sys.executable, "tools/dxf2stl.py", str(Path(tmp) / "frame.svg"),
                                     str(Path(tmp) / "out.stl"), "--profile-colors", str(Path(tmp) / "colours.json")],
                                    cwd=ROOT, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Profile colours need a main sweep profile", result.stderr)


if __name__ == "__main__":
    unittest.main()
