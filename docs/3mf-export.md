# Selectable slicer project export

`tools/slicer_3mf.py` is the plate-aware exporter used by both download buttons.
`tools/dxf2stl.py --slicer-options options.json` shares that entry point with the
HTTP endpoint. The older direct `out.3mf` CLI path is not the new exporter.

## Profiles and geometry

The P1S template was extracted from
`reverse_engeneering/3mf_files/example_bambulab_p1s_12_objects_on_two_plates.3mf`.
The U1 template was extracted from `example_3dobject_versions.3mf` in the same
directory. Self-contained copies live in `tools/3mf_profiles`; reference archives
are not needed at runtime. They provide 0.4 mm machine and PLA process/material
settings. The selected colours replace the reference filament colours; calibrated
optical appearance is not encoded as a material recipe or temperature setting.

Every selected version is one top-level component assembly and one build item.
Shared mesh resources are never independent build items. Colour/extruder and
surface-pattern settings belong to each assembly's parts. Object IDs are globally
allocated, XML values escaped, and every build instance is assigned to exactly
one plate. The required frame-only geometry is extracted from the frame itself,
including when its original colours were merged into palette buckets.

Four versions are always exported: **Single hue**, **Frame only**,
**Black frame + one hue**, and **Outline 0.2 mm**. The first three are the
required colour-comparison versions and stay guaranteed together on plate 1
(`layout(..., required=3)` refuses a model too large for that). The outline
joins plate 1 when capacity allows and otherwise starts the next plate, so
adding it never fails an export that used to succeed. The **Frame only**
version carries the connection ribs (`frame_connections()` in `dxf2stl.py`),
so a subject that floats inside its boundary still prints as one piece; the
colour versions keep the clean frame. The outline version is the
single-hue extruded outline plate: `outline_solid()` in `dxf2stl.py` takes the
placed boundary (`crop`) when one crops the pattern, and otherwise the filled
silhouette of the frame ribbons, extruded exactly `OUTLINE_THICKNESS` (0.2 mm).
It shares the single-hue filament slot, so it prints in one colour without an
extra spool. Stacked drawings contribute to one shared plate covering all of
them.

Plate origins use `ceil(sqrt(plate_count))` columns, a 20% bed-size gap, and
negative Y for successive rows. Mesh coordinates remain unchanged within each
assembly, and its bottom is translated to Z=0. The common footprint grid is
conservative: it does not rotate objects or nest them in each other's cutouts.

## Tower reservation

Both exported profiles explicitly use rectangular towers, with ribs and cones
disabled. Bambu uses a 35 mm tower width and 3 mm brim; U1 uses 30 mm and 5 mm.
The reservation covers the larger of a 54 mm square and the estimated tower
bounds plus brim and 5 mm clearance on each side, with additional depth
headroom of 25% or 15 mm, whichever is larger. All export colours are counted
on every plate, even if an individual plate needs fewer colours. Priming volume
is 45 mm³; configured line spacing and minimum depth by model height are included.
Snapmaker's hardcoded 0.2 mm preview height and the actual chosen layer height
are both covered conservatively. The tower's saved coordinates place it inside
that reserved rectangle on each plate.

At 0.08 mm layers, actual Snapmaker tower extrusion paths exceeded the raw
preview estimate by about 12 mm. The extra depth headroom covers the measured
difference and leaves clearance.

This is a pre-slicing estimate, not a guarantee for arbitrary changes inside the
slicer. Changing materials, purge settings, supports, brims, tower shape or model
scale requires checking placement again. The exporter disables model skirts,
brims and supports. It never generates a fake tower mesh: the slicer generates
the actual prime tower.

Sources inspected:

- [Bambu 2.7.1.62 plate layout and tower estimator](https://github.com/bambulab/BambuStudio/blob/v02.07.01.62/src/slic3r/GUI/PartPlate.cpp)
- [Bambu tower generation](https://github.com/bambulab/BambuStudio/blob/v02.07.01.62/src/libslic3r/GCode/WipeTower.cpp)
- [Snapmaker plate estimator](https://github.com/Snapmaker/OrcaSlicer/blob/main/src/slic3r/GUI/PartPlate.cpp)
- [Snapmaker depth estimate](https://github.com/Snapmaker/OrcaSlicer/blob/main/src/libslic3r/Print.cpp)
- [Snapmaker tower shape options](https://github.com/Snapmaker/OrcaSlicer/blob/main/src/libslic3r/PrintConfig.cpp)

## Verification

`tools/test_slicer_3mf.py` resolves mesh components and final transforms in the
exported archives, independently checking object counts, unique plate assignment,
Z=0, plate bounds, tower clearance and inter-object overlap for both targets.
It also checks oversized-model rejection and tower reservations at several layer
heights. Run with `.venv/bin/python -m unittest discover -s tools -p test_slicer_3mf.py`.

The browser smoke tests exercised both buttons against the real server, generated
a model, opened the selection dialog, deselected an optional variant and downloaded
the required versions (including the flat outline). Layered-frame selection and
height-ordered preview patches are also covered by the Python tests, which
additionally check the flat outline version's 0.2 mm thickness, its
filled-silhouette volume and its use of the boundary when one is set. Bambu Studio 2.7.1.62 loaded and sliced an exported fixture with eight
objects on plate 1 and one on plate 2, with validation enabled and arrangement
disabled.

Snapmaker Orca 1.10.1.50's CLI crashes in GUI-only plate-name rendering and virtual
filament expansion even though no GUI exists. A debugger test bypassed those two
functions only (the test uses physical filament slots, no virtual mixtures); its
slicing engine then completed successfully with validation enabled. This is a
CLI-test workaround, not application code or a change to the generated project.
The metadata uses the Bambu-compatible application/version discriminator accepted
by that installed release. Normal unmodified Snapmaker CLI slicing remains a
known limitation of this validation environment.

Further fine-layer validation used a larger fixture at 0.08 mm: Bambu sliced
nine objects over three plates; Snapmaker sliced them over two. Both reported
success with no per-plate warning messages. Parsed prime-tower extrusion paths
stayed within the reserved rectangles on all five plates after adding the depth
headroom. The measured path bounds are retained in a regression test.
