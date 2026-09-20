# Terminology

Canonical vocabulary for Mathmodels. One concept, one word. This file is the
source of truth: where code, UI or prose disagrees with it, they are wrong.

The pipeline in one line:

**subject** → **regions** → painted **faces** on a **relief**, framed by
**walls** and cropped to a **boundary**.

## 2D input

| Term | Meaning |
| --- | --- |
| **subject** | The 2D artwork a model is built from: an SVG or DXF drawing, or the SVG produced by tracing a photo. The thing you load, trace, crop and build from. Also the storage role of a library resource used this way. |
| **sublayer** | One named layer inside a multi-layer DXF/SVG subject. |
| **region** | A closed area enclosed by the subject's lines — the 2D thing that becomes paint. |
| **boundary** | A closed shape that crops the subject and defines the finished outline and size (for example to fit a lantern). |
| **profile** | A closed cross-section swept along the subject's lines to form the frame. |
| **tracery** | The network of ornament lines of a gothic subject. |

## 3D result

| Term | Meaning |
| --- | --- |
| **wall** | The ribbon one subject line is buffered into and extruded (wall width, wall height, wall overlap). |
| **frame** | The assembled 3D structure made of walls: black frame, frame bands, frame only. |
| **frame band** | One colour band of a layered (non-black) frame. |
| **connection rib** | A generated wall bridging a floating frame piece to the boundary (or, with no walled boundary, to the largest piece), so a frame-only print is one piece. Ribs carry the frame's own width, height and colour. |
| **face** | One region extruded into 3D — the surface you click and paint. |
| **slab** | One painted thickness piece of a face, with one colour and one height. |
| **paint stack** | The ordered slabs of one face, bottom first. |
| **relief** | The finished 3D object: frame plus painted faces. |
| **layered subject** | A subject placed on top of another to build a stacked model. |
| **print layer** | One layer the printer lays down; its thickness is the *print layer height*. |

## Pipeline and storage

| Term | Meaning |
| --- | --- |
| **resource** | A reusable 2D input saved in the library. Roles: **subject**, **boundary**, **profile**. |
| **model** | The 3D work in the 3D step: its inputs, settings and painting. |
| **project** | A saved model — inputs, settings and painting together. |
| **library** | Where resources live. |

## Export

| Term | Meaning |
| --- | --- |
| **build plate** / **plate** | One printer bed in a multi-plate 3MF project. |
| **version** | One printable arrangement in the export: Single hue, Frame only, Black frame + one hue, Outline 0.2 mm, colour arrangements. |
| **filament slot** | The printer's material position a part prints from (the 3MF `extruder` field). |
| **surface pattern** | The slicer's infill path style for top and bottom surfaces (monotonic, hilbert curve …). This is the *only* thing called a pattern in the project. |
| **silhouette plate** | The flat 0.2 mm version shaped like the subject's silhouette. |

## The silhouette

**silhouette** is the subject's outermost edge, and the flat 0.2 mm version
extruded from it. With a boundary set, the silhouette *is* the boundary.

**Exception — the trace step.** The two trace modes stay named **centerline**
and **outline**. There, "outline" is a processing mode (follow the edges of
filled areas), never a geometry term. Outside the trace panel, "outline" is not
a project word.

**Files are still drawings.** A `.dxf` or `.svg` on disk is a drawing file;
"drawing" is fine for the file and its format, not for the concept.

## Do not use

| Banned | Use instead |
| --- | --- |
| pattern, motif, artwork, design (for the 2D input) | subject |
| pattern (for a library resource or its role) | subject |
| drawing, sketch (for the concept) | subject |
| face, area, cell, pane (for the 2D enclosed area) | region |
| region, tile (for the extruded 3D surface) | face |
| frame, crop, window, mask (for the cropping shape) | boundary |
| outline, contour, outer contour (for the outermost edge) | silhouette |
| layer (for a DXF/SVG layer of the subject) | sublayer |
| layer (for a printed layer) | print layer |
| layer (for one painted thickness of a face) | slab |
| layer (for one colour band of the frame) | frame band |
| stack (for a face's slabs) | paint stack |
| stack, stacked drawing (for several subjects) | layered subject |

## Scope and lagging names

This glossary governs **user-facing language**: UI copy, docs, CLI help and the
stored resource kinds. It also names the concepts the code is built on.

Internal identifiers may lag behind it (for example `drawing`, `content`,
`renderDrawings`, `frameStack`). Rename them when you touch that code, and never
rename a persisted format without a migration. Known lags:

- The project file format keeps `drawings` for layered subjects, and
  `/api/regions` plus the stats payload keep a `drawings` array. Both need a
  format/payload migration before they can follow the glossary.
- The converter's `--layers` still selects DXF/SVG **sublayers**.
- The callback API keeps its short names: `faces`, `stack`, `levels`, `hues`
  and `face.stack`. There, `stack` is a face's paint stack.
- Machine formats keep their own words: a 3MF part has an `extruder`, the UI
  says **filament slot**; 3MF plate metadata is the **build plate**.

## Renaming map (old → new)

| Old | New |
| --- | --- |
| resource kind `pattern` | resource kind `subject` (older saves are read as `subject`) |
| library category *Patterns* | *Subjects* |
| *Save pattern* | *Save subject* |
| *add drawing…*, `--also` "drawing" | *add subject…*, additional subject |
| "stacked drawings" | *layered subjects* |
| `patternScale` / `patternX` / `patternY` (subject inside a boundary) | `subjectScale` / `subjectX` / `subjectY`; CLI `--subject-scale/x/y` |
| preview payload `pattern` (2D window) | `subject` |
| "window content" | the subject inside the boundary |
| "paintable faces" (2D) | *paintable regions* |
| "maya pyramid regions" | *maya pyramid faces* |
| "keep walls inside the outline" | *keep walls inside the silhouette* |
| 3MF *surface patterns* | unchanged — the one legitimate use of "pattern" |
