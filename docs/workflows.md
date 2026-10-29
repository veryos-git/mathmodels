# Working from images, stained glass, and gothic tracery

The model sidebar has four focused panels: **Inputs**, **Shape**, **Paint**,
and **Export**. The preview and project Save button remain visible. Frame-only
projects omit Paint. Switching panels does not discard work.

For the measured Onshape tracery example, open **Inputs → Sweep profiles &
cusp paths → Load Onshape Spitzbogen example**. See the
[construction and STEP comparison](spitzbogen.md) for dimensions and validation.

## Image → reusable subject → stained glass

1. Start with **Trace a photo**. Clean up the original with the pen and eraser,
   pick colours with the pipette, and **lasso crop** away everything outside
   the part you want to keep.
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

**Path endings & hooks** act on the vertices of the swept main path — free
ends and corners alike, on open or closed paths — shown as markers in the 3D
view. Pick what to apply, then click a marker to toggle it there: a **dome
cap** rounds a free endpoint over. Hooks are swept from the same main profile
and stand up out of the drawing plane. All hooks face the same way, down the
drawing's vertical axis (−Y), whatever the path does at their vertex; the
**Rotation** turns them counter-clockwise from there. A vertex shared by several
paths still gets a single hook. Each applied hook gets its own **vertical
offset** field: it slides that hook up (positive) or down (negative) the
drawing's vertical axis from the clicked marker, which then shows a smaller dot
where the hook stands. A **round hook** is a reverse curve: a *small radius* arc
rises from the endpoint into a *big radius* arc that curls over, ending at the
*curl angle* measured round the big circle from the ground; the profile sits on
the concave side of each arc, as in the reference model. A **straight hook** is
built like the reference (`object_additions/hook/24-10-2026`): a bottom bar of
the given *length* runs from the marker with the profile on top, a post stands
at the marker, and a bar rising at *angle* from the bottom bar's far end crosses
the post's top and *overhangs* it back over the frame. The post and the rising
bar carry the profile on both faces (the section and its mirror image), the post
ending square at the bar's centre line; anything below the base plane is cut off.
The **Tip** sets how the free end finishes: *quarter round* rolls the end
section 90° forward (its profile edges can stay sharp); *half round* rolls it
180° into a half-disc knob; *square* leaves the cut. A straight hook's bar has
the profile on both faces, so its rounded tip is always the 180° half-round.
With a **groove profile**, hooks are fused on after the groove is cut, so the
groove stops where a hook stands instead of slicing through it. Tick **Cut the
groove last, through the hooks too** (shown once a groove and a hook are both
set; CLI `--groove-last`) for the old order.
The endings and hooks are fused into the frame with
Manifold, so they export as one printable body, and travel inside project files.

Choose **Frame only** for an ornamental tracery object without faces.
Keep it off for a swept frame with paintable infill. The input files, settings,
workflow selection and material calibrations all travel inside project files.
Imported project resources include cusp paths and cusp profiles.

### Editing pointy tips

A DXF subject's **pointy tips** — where two arcs (in CAD, two overlapping
circles) meet at an angle — can be reshaped without going back to CAD. Choose
**Edit pointy tips…** under the subject preview. The editor shows the subject's
exact lines and arcs. Each tip is an orange dot, and each tangency the subject
already has (an arc touching a line, a circle or another arc) is a green
diamond:

- **Drag a tip**, or type its **Tip X / Tip Y**. Its two arcs change radius and
  centre so that each still touches the same lines and circles; the arcs stay
  joined at every tip. A drag that would break a tangency, or slide an arc off
  the end of its line, stops at the last shape that still works.
- **Circle overlap** — with a tip selected, how far its two circles overlap
  along the line between their centres (r₁ + r₂ − distance). The selected tip's
  full circles are drawn dashed.
- **Arc radius** — click an arc to select it and type its radius.
- **Keep symmetry** — on when the subject is symmetric (mirrored left/right,
  up/down, or rotated). Every symmetric copy follows the edit, so all tips of a
  quatrefoil move together. Off, only the selected tip's two arcs change; the
  neighbouring tips slide along arcs that stay put.

**Apply to subject** writes the new arcs into the DXF itself (same entity
handles, layers and everything else untouched) and rebuilds the model, keeping
holes, paint and scale. Lines, circles, polylines and arcs inside blocks stay
fixed; only model-space arcs are editable. SVG subjects cannot be edited this
way yet. Sizes are the DXF's own units, before the model's scale.

### Additions: perpendicular shelves

Use **Inputs → Shape → Additions → Export** for a frame-only model.
Models with painted faces also retain a **Paint** step before Export.

In **Additions**, upload or choose a closed SVG/DXF **Shelf outline**. This is
the shelf seen from above. **Use gothic shelf outline** loads the supplied
scalloped example. Loading an outline enables the shelf; disable **Enable shelf**
to keep its settings without including it in the model.

The outline is extruded **0.2–20 mm** thick (default **5 mm**) and placed at
**90°** to the base swept frame. Width and depth are independent; **0** preserves
that dimension from the source drawing. The longest horizontal edge at the
drawing's top or bottom faces the frame. **Flip front / back** reverses this.
Holes in the outline remain holes.

**Shelf placement** shows the shelf outline in yellow against the swept frame
in blue, using shelf coordinates: **X = left/right, Y = depth, Z = height**.
Choose **Top · X/Y** to drag the shelf across the plane. The square handles
resize width, depth or both, keeping the rear centre fixed. **Keep proportions**
preserves the width/depth ratio. Choose **Front · X/Z** to drag the shelf
up/down against the bat's face; this changes only its Z height.

Use **Expand** for a larger workspace. Scroll to zoom at the pointer, drag
empty space to pan, and **Fit all** to see both outlines. Arrow keys move by
0.1 mm (Shift: 1 mm); front view accepts only up/down movement. Escape cancels
the current drag. Exact dimensions and X/Y/Z positions are editable below
the canvas. Changes appear immediately in 2D and rebuild the 3D model on release.
The decorative edge is excluded from the shelf's placement outline.

Offsets are finished millimetres relative to the base frame centre and its
front surface. The shelf's top starts at the centre's height, its thickness
extends downward, and the back overlaps the frame by up to 0.2 mm.
Move it downward to place it near the bottom of a bat. A detached shelf reports
an error when rebuilding; its outline stays editable so it can be moved back.
The frame projections stay fixed as the shelf moves.

**Sweep along shelf edges** decorates the complete outer perimeter. By default
it uses the main sweep profile's source drawing. Upload a separate
**Edge cross-section** to use another drawing. **Profile width ×** and
**Profile height ×** size the shelf section independently; 1× uses the source's
drawn dimensions. These scales apply before rotation. **Copy main profile size**
copies the two main-profile scales once when sharing its drawing. Subsequent
main-profile edits do not resize the shelf edge. Older projects capture their
previously shared main scales when opened, preserving the shelf section's size.
**90°, 180°, 270° and 360°** rotate that cross-section around the edge;
360° is the original orientation. The source profile's bottom baseline has its
midpoint anchored on the slab edge at half its thickness. Main-profile elevation and
groove cutters are specific to the frame and do not alter the shelf edge.

**Mirror across horizontal baseline** reflects the source section through its
bottom edge (Y=0). **Flip left / right in source profile** reflects it through
its vertical centreline (X=0). Both act before rotation, around the same fixed
anchor. The baseline follows the selected rotation; it is horizontal in the
source drawing, not necessarily in the finished model. Check the resulting
toolpaths in the slicer; arbitrary profiles are not guaranteed to become support-free.

Enable **Keep original sweep too · both profiles** to add the mirrored sweep
alongside the original instead of replacing it. With the baseline mirror enabled,
the two sections meet along their flat bases on opposite sides of the baseline,
as in the supplied CAD example. They are never centred separately. The optional
left/right flip also applies to the reflected copy. Both sections share the shelf
profile's size, rotation and anchor. Their swept solids are fused into the shelf, so overlapping
areas do not leave duplicate shells; the bed-plane trim then cuts the combined
result. The setting is saved with the project. Older projects retain a single
sweep until this option is enabled.

This corrects the earlier mirror about the rotated bounding-box centre. Existing
mirror settings now use the source axes above; the baseline anchor replaces
bounding-box centring for all shelf edge sweeps. The main frame is unchanged.

**Trim flush to frame back · bed plane** cuts the placed shelf and its decorative
edge at the main frame's rear plane, with a closed planar cap. This assumes the
frame's back lies on the bed. It removes projections behind that plane without
moving or cutting the frame. It is enabled by default in the UI, including when
opening older shelf projects, and can be disabled to retain the full sweep.

Changes rebuild an existing model automatically. **Update 3D model** also
generates it from scratch. Shelves require a main sweep profile and a flat
model surface. The shelf is fused with the base frame and travels with it in
STL, colour-separated exports, 3MF and slice SVGs. Other stacked drawings keep
their original elevations. Projects embed both drawings and all shelf settings;
older projects reopen with additions disabled.
Placement and the proportions lock are saved with the project.

The [transcribed sketch notes](../hgc/object_additions/gothic_Shelf/notes.md)
record the original design and link to the supplied CAD examples.

CLI example:

```bash
.venv/bin/python tools/dxf2stl.py frame.dxf shelf.stl --profile profile.dxf \
  --frame-only \
  --addition-outline "hgc/object_additions/gothic_Shelf/examples/shelf - shelf_profile_path.dxf" \
  --addition-thickness 5 --addition-y -25 \
  --addition-edge-sweep --addition-rotation 90 \\
  --addition-profile-scale 1 --addition-profile-height-scale 1 \\
  --addition-mirror-profile --addition-trim-back
```

The build routes accept `additionOutline` and optional `additionProfile` uploads,
numeric `additionThickness`, `additionWidth`, `additionDepth`, `additionX`,
`additionY`, `additionZ`, `additionRotation`, `additionProfileScale`,
`additionProfileHeightScale`, and boolean `additionEdgeSweep=1`,
`additionFlip=1`, `additionMirrorProfile=1`, `additionFlipProfile=1`,
`additionKeepOriginalProfile=1`, `additionTrimBack=1`. Use
`--addition-keep-original-profile` with either mirror flag on the CLI to sweep
both orientations. Without a mirror flag, it keeps just the original.
CLI/API profile scales default to 1 independently of the
main profile; trim and mirrors are opt-in flags. Omit `additionOutline` to build
without a shelf.
`POST /api/additions/preview` returns the normalized shelf outline and top/front
projections of the base frame using the same geometry pipeline. It deliberately
ignores shelf position, size and flip, allowing the browser to edit those locally.
For compatibility, stored/API `additionY` is still the model's upright direction
(editor **Z**), and `additionZ` is still its outward direction (editor **Y**).
Existing projects retain their exact placement.

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

The tip editor reads and writes DXF arcs through the converter too:

```bash
# Exact lines, circles and arcs (model-space arcs carry their handle)
.venv/bin/python tools/dxf2stl.py subject.dxf --sketch
# Write [{handle, center, radius, start, end}] counter-clockwise arcs back
.venv/bin/python tools/dxf2stl.py subject.dxf edited.dxf --sketch-edit arcs.json
```

Over HTTP these are `POST /api/sketch` (`file`) and `POST /api/sketch/apply`
(`file` plus an `edits` JSON field), which answers with the edited DXF.

## Checks

```bash
deno task check
deno task test
deno task test:geometry
deno task test:tip-editor
```

Storage tests cover resource revisions, thumbnails, imports and filament CRUD.
Geometry tests exercise closed black-area tracing, quarter revolutions,
watertight reference tracery and exact coupon thicknesses after STL export.
