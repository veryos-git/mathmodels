# Working from images, stained glass, and gothic tracery

The model sidebar has four focused panels: **Inputs**, **Shape**, **Paint**,
and **Export**. The preview and project Save button remain visible. Frame-only
projects omit Paint. Switching panels does not discard work.

For the measured Onshape tracery example, open **Inputs → Sweep profiles &
cusp paths → Load Onshape Spitzbogen example**. See the
[construction and STEP comparison](spitzbogen.md) for dimensions and validation.

## Image → reusable subject → stained glass

1. Start with **Trace a photo**. Clean up the original with the pen and eraser.
2. In centerline mode, **Large black areas → Keep their outlines** preserves
   eyes and spots as closed outlines. Set the minimum dark-feature width above
   the width of ordinary pen strokes. Outline mode already retains their
   edges. Transparent image backgrounds are composited onto white paper.
3. **Save subject** preserves the original, edited image, settings and SVG.
   **Create 3D model** commits a matching image/SVG pair to the model.
4. In **Inputs**, select a fitting boundary from the library if this is a
   lantern insert. A frame-only print bridges a floating subject to the
   boundary with generated connection ribs, so it prints as one piece. The boundary stays at its actual size; position and scale
   the subject inside it. The existing 2D positioning preview is available here.
5. In **Shape**, choose the wall and printable face thicknesses. Generate 3D.
6. In **Paint**, choose calibrated filaments for the palette rows and paint
   the faces. Preserved dark features are ordinary closed faces: paint them
   black if that is the intended printed result.
7. Save the project, then use **Export** for STL, material-group STLs or 3MF.

Starting a new image or vector project from Start clears the previous Gothic
sweep/cusp inputs. Replacing a subject through a model's library picker retains
its boundary, supporting quick variations for the same lantern frame.

## CNC slices for stacked sheets

After generating the model, open **Export** and click **Add slice**. Enter its
height above the model base in millimetres. Every added slice receives a
random color and a matching horizontal plane in the 3D preview; editing the
height moves that plane immediately. Use **Show plane** to hide individual
planes when inspecting several slices. Heights must be below the model top.

Click a slice's **Download SVG**, or **Download all slice SVGs** for the list.
SVG cutting outlines use the same color as their preview planes. Your browser
may ask to allow multiple downloads. Slice heights, colors and plane visibility
are saved with the project. Removing a slice removes its preview plane too.

The height selects a
horizontal cross-section through the complete model, including painted
thicknesses, frames and holes. Overlapping solids are fused before slicing
so their internal boundaries do not become cutting lines. For swept frames
that cannot be fused as 3D solids, the exporter combines their closed planar
cross-sections instead. An actual gap in the slice outline still produces an error.

The SVG uses millimetres, closed paths and the full model's XY bounds for
every slice. Import at 100% scale in your CNC software, retain the shared
canvas when aligning layers, and apply cutter compensation there. No
alignment holes or cutter offsets are added automatically.

For 3 mm sheets, export at 1.5, 4.5, 7.5 mm and so on, below the model top.
Each file represents one plane; stacked sheets approximate slopes with steps.
At an exact horizontal step, the cross-section uses the material above the
plane. Heights outside the model or in an empty gap produce an error.

The CLI also supports `--slice-height MM` with an SVG output filename.

Gothic tracery starts with **keep walls inside the silhouette** unchecked.
Enabling it shows a warning because confinement moves and trims sweep paths
and can distort arches and cusp joins. Saved projects retain their chosen
setting and show the same warning if it is enabled.

## Filament calibration

Open **Filaments & calibration** from Start or from the Paint panel.

1. Create a filament with a name, brand, material, base color and print layer
   height. A filament without measurements is explicitly an estimate.
2. Set the number of tabs and the number of print layers per thickness step.
   The patch grid lists each exact thickness. Download the numbered coupon STL.
3. Print it flat, at the specified layer height, with solid infill. Keep the
   extrusion settings consistent with the intended window. The sample areas
   have the requested thickness all the way down to the bed; the raised numbers
   sit on the handling spine outside those areas.
4. Put the tabs against the intended backlight. Match each numbered patch's
   color in the dialog. Check **I matched these colors to my printed, backlit
   tabs** and save. You can reopen, update, duplicate or delete a filament.
5. Assign it to a palette row. Palette shades and model colors use the saved
   thickness/color measurements. Changing the row's ordinary hue picker clears
   its filament assignment. Exported material groups use assigned filament names.

Between measurements, the preview interpolates RGB optical density; beyond
them it extrapolates from the last interval. Stacks of assigned filaments
multiply channel transmission. This is a visual approximation for the calibrated
backlight, not a spectral simulation. Changing filament, print settings or
lighting can require a new calibration. Projects embed their calibration
snapshots, so editing or deleting a library filament does not change old projects.

Filaments are readable JSON files under `library/filaments/<id>.json`.
`GET/POST /api/filaments` and `GET/PUT/DELETE /api/filaments/:id` implement CRUD.
`POST /api/calibration` accepts JSON `{layerHeight, thicknesses}` and returns
an STL, with 2–16 patches, each a whole number of layers and at most 10 mm thick.

## Gothic tracery

Choose **Gothic tracery** on Start. In **Inputs**, choose:

- The main frame paths, as SVG or DXF.
- The main closed sweep profile.
- Optional cusp paths in the same coordinate system as the main frame.
- An optional independent cusp profile; otherwise a reduced main profile is used.

The finer paths share the main frame's scale and base plane. They are not an
extra layered subject above it. In **Shape**, control the cusp width and height
multipliers and elevation. Uploading a custom section starts its multipliers at
1, preserving its physical dimensions. The reduced main-section default is 0.55.

**Revolve open cusp endings** turns their terminal sections around a vertical
axis along the chosen lateral edge, normally through 90°. Use the other axis
side when a path's orientation puts the roll on the wrong side. Without cusp
paths the option applies to open main-frame paths. Closed loops have no endings;
cusp endpoints attached to the main path are not rounded. Main sweeps, cusp
sweeps and endings are fused with Manifold before the mesh is sent to the preview
or exported. Invalid solids produce a conversion error instead of a silent
broken export.

Choose **Frame only** for an ornamental tracery object without faces.
Keep it off for a swept frame with paintable infill. The input files, settings,
workflow selection and material calibrations all travel inside project files.
Imported project resources include cusp paths and cusp profiles.

### Reference example and derivation

**Load reference gothic example** loads the provided complex tracery, including
its two different sections and quarter-revolved endings. The prepared inputs
are under `examples/gothic/`:

- `frame.dxf` preserves the supplied main-frame drawing.
- `cusps.dxf` contains its three ornamental arcs. The supplied cusp drawing also
  contains closed frame/construction outlines; those are deliberately omitted
  from this prepared cusp-only input.
- `frame-profile.svg` was sectioned from the supplied frame STL: approximately
  5.00 mm wide and 2.3866 mm high.
- `cusp-profile.svg` was sectioned from the supplied cusp STL: approximately
  2.4996 mm wide and 1.3268 mm high.

The sections were simplified with a 0.003 mm tolerance. Source CAD exports and
screenshots remain unchanged under `reverse_engeneering/`. The generated sample
is checked for one connected watertight solid, a shared zero-height base, the
reference frame height, and the frame's overall dimensions. It follows the
reference construction; it is not claimed to reproduce every CAD tessellation
vertex exactly.

### Command line

```bash
.venv/bin/python tools/dxf2stl.py examples/gothic/frame.dxf tracery.stl \
  --profile examples/gothic/frame-profile.svg \
  --cusps examples/gothic/cusps.dxf \
  --cusp-profile examples/gothic/cusp-profile.svg \
  --cusp-width 1 --cusp-height 1 --cusp-z 0 \
  --round-ends --end-angle 90 --end-side 1 --frame-only
```

The same options travel through the existing build/export HTTP routes as
`cusps` and `cuspProfile` file fields and `cuspWidth`, `cuspHeight`, `cuspZ`,
`roundEnds`, `endAngle`, `endSide`, `frameOnly` fields. New dependencies are
installed by the existing `deno task setup` / start workflow.

## Checks

```bash
deno task check
deno task test
deno task test:geometry
```

Storage tests cover resource revisions, thumbnails, imports and filament CRUD.
Geometry tests exercise closed black-area tracing, quarter revolutions,
watertight reference tracery and exact coupon thicknesses after STL export.
