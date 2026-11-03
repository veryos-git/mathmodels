"""Multicolour sweep profiles: rectangles over a section that print in their own filament.

A colour is a rectangle drawn over the main or cusp cross-section in that
section's own (unscaled) coordinates, the ones the profile editor shows
before its width, height and vertical offset are applied. Whatever part of
the swept frame the rectangle covers prints in the colour. The rectangle is
swept, hooked and rolled exactly like the section it colours, and the
finished frame is then split by those "cutters", so the coloured parts and
the rest share their faces exactly and never overlap.
"""
import json
import math
import re

from shapely.geometry import box
from shapely.ops import unary_union

SECTIONS = ("main", "cusp")
MAX_COLOURS = 32
_HEX = re.compile(r"#[0-9a-fA-F]{6}")


def parse_colours(raw):
    """Validated entries: {"section", "color", "rect", "mirrorX", "mirrorY"}.

    ``rect`` is (x0, y0, x1, y1) with x0 < x1 and y0 < y1. Order matters:
    where two colours claim the same material, the earlier entry keeps it.
    """
    if not isinstance(raw, list):
        raise ValueError("Profile colours must be a JSON array")
    if len(raw) > MAX_COLOURS:
        raise ValueError(f"At most {MAX_COLOURS} profile colours are supported")
    entries = []
    for number, entry in enumerate(raw, 1):
        if not isinstance(entry, dict):
            raise ValueError(f"Profile colour {number} is not an object")
        section = entry.get("section", "main")
        if section not in SECTIONS:
            raise ValueError(f"Profile colour {number}: section must be 'main' or 'cusp'")
        colour = entry.get("color")
        if not isinstance(colour, str) or not _HEX.fullmatch(colour):
            raise ValueError(f"Profile colour {number} needs a #rrggbb colour")
        try:
            x0, y0, x1, y1 = (float(v) for v in entry.get("rect"))
        except (TypeError, ValueError):
            raise ValueError(f"Profile colour {number} needs a rectangle [x0, y0, x1, y1]") from None
        if not all(math.isfinite(v) for v in (x0, y0, x1, y1)):
            raise ValueError(f"Profile colour {number} has a non-finite rectangle")
        x0, x1 = sorted((x0, x1))
        y0, y1 = sorted((y0, y1))
        if x1 - x0 <= 1e-9 or y1 - y0 <= 1e-9:
            raise ValueError(f"Profile colour {number} has no area")
        entries.append({"section": section, "color": colour.lower(), "rect": (x0, y0, x1, y1),
                        "mirrorX": bool(entry.get("mirrorX")), "mirrorY": bool(entry.get("mirrorY"))})
    return entries


def load_colours(path):
    with open(path, encoding="utf-8") as fp:
        return parse_colours(json.load(fp))


def colour_label(colour):
    """The export group of a colour: never a palette row, so it keeps its own extruder."""
    return "frame-" + colour.lower().lstrip("#")


def colour_of(label):
    """The #rrggbb colour behind a `colour_label`, or None for any other group."""
    if label and label.startswith("frame-") and _HEX.fullmatch("#" + label[6:]):
        return "#" + label[6:]
    return None


def colour_region(entry, transform, bounds):
    """The entry's rectangle and its mirror images, in finished section millimetres.

    `transform` is the section's (width scale, height scale, vertical offset);
    `bounds` the finished section's bounds. Mirror X reflects across the
    section's centre line (x = 0, where the sweep path runs), mirror Y across
    the section's mid-height. The result is clipped to the section's box plus
    a small margin, so a rectangle drawn past the outline covers it fully
    without sweeping material the frame never had.
    """
    sx, sy, z = transform
    x0, y0, x1, y1 = entry["rect"]
    rects = [(x0 * sx, y0 * sy + z, x1 * sx, y1 * sy + z)]
    if entry["mirrorX"]:
        rects += [(-c, b, -a, d) for a, b, c, d in rects]
    if entry["mirrorY"]:
        mid2 = bounds[1] + bounds[3]
        rects += [(a, mid2 - d, c, mid2 - b) for a, b, c, d in rects]
    left, bottom, right, top = bounds
    margin = max(0.05, 0.02 * max(right - left, top - bottom))
    limit = box(left - margin, bottom - margin, right + margin, top + margin)
    return unary_union([box(*r) for r in rects]).intersection(limit)


def split_frame(frame, cutters):
    """Partition the finished frame mesh by colour.

    `cutters` is [(label, [closed meshes])] in priority order. Returns
    [(label, mesh)]: one entry per colour that covers some of the frame, in
    first-use order, then (None, rest) for what no colour covers. Each part
    is a closed solid at STL precision.
    """
    from cylinder import manifold, printable_mesh

    remaining = manifold(frame)
    shares, order = {}, []
    for label, pieces in cutters:
        if not pieces:
            continue
        cutter = None
        for piece in pieces:
            solid = manifold(piece)
            cutter = solid if cutter is None else cutter + solid
        share = remaining ^ cutter
        remaining = remaining - cutter
        if share.is_empty() or share.volume() <= 1e-6:
            continue
        if label not in shares:
            order.append(label)
            shares[label] = share
        else:
            shares[label] = shares[label] + share
    parts = [(label, printable_mesh(shares[label])) for label in order]
    if not remaining.is_empty() and remaining.volume() > 1e-6:
        parts.append((None, printable_mesh(remaining)))
    return parts
