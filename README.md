# vector2stl

Turn a 2D **DXF or SVG** sketch into a 3D relief STL. Every curve becomes a
raised *wall*, and every face enclosed by those walls is extruded to its own
height — either rolled at random or painted by hand from a colour palette.

![a gothic window with its faces painted](docs/preview.png)

## Running it

```bash
deno task start          # http://localhost:8788
```

That's the whole setup. The first run creates `.venv` and installs the Python
packages from `requirements.txt` (a few seconds); later runs skip straight to
the server. Editing `requirements.txt` re-installs on the next start.

You need Deno and Python 3 with the `venv` module — on Debian/Ubuntu that's
`sudo apt install python3-venv`.

`deno task dev` restarts on file changes, `deno task check` type-checks, and
`deno task setup` prepares `.venv` without starting the server.

Open the page, drop in a `.dxf`, `.svg` or saved `.v2sproj` project (or hit
**Use the example sketch**), tune the sizes, and **Generate 3D**. The browser gets the face outlines and extrudes them
itself, so painting is instant — nothing goes back to the server until you save.

## Painting the faces

The palette has **four** hue rows and five brightness levels per row. The levels
run **brightest = lowest** to **darkest = tallest**, spread evenly across the
*lowest face* … *tallest face* range — with the defaults that is 0.20, 0.65,
1.10, 1.55 and 2.00 mm. A face's shade therefore always tells you how far it
stands proud.

Pick a swatch, then use the mouse on a face in the view:

| Button | What it does |
| --- | --- |
| **left** | that face becomes just this colour and height |
| **right** | stacks another layer of this colour on top |
| **middle** | peels the top layer back off |

So picking hue 1 at 0.65 mm and left-clicking a face, then picking hue 3 at
1.10 mm and right-clicking the same face, leaves a face 1.75 mm tall made of a
0.65 mm layer with a 1.10 mm layer on it. Each palette height is the *thickness*
of the layer it adds. A face always keeps its bottom layer — middle-clicking the
last one does nothing; left click to recolour it instead. Selecting a swatch
only arms the colour, so it never disturbs a stack you have already built.

Each row starts with a colour picker: change it and that row — and every face
already painted with it — takes the new hue. Only the hue is taken from your
choice; the five brightness steps are re-derived, because brightness has to go
on meaning height. A grey has no hue, so it is refused rather than silently
turning the row red. Exported file names follow whatever hue a row is on.

| Control | What it does |
| --- | --- |
| selected face height | exact thickness for the top layer of the selected face |
| **Fill all** | gives every face the selected swatch |
| **Random all** | random hue and height for every face |
| **Random heights** | new heights for every face, leaving the colour scheme alone |
| **Mirror ⇄** | copies the left half's colours onto the right, reflected through the middle |
| **Top view** | locks the camera straight down and stops orbiting, so clicks can't spin the model |
| **↻** (seed) | rerolls the starting heights |

Mirroring pairs faces by reflected centroid and only accepts a pair when the
areas agree too; it reports any face that had no partner rather than guessing.

## Settings

| Setting | What it does |
| --- | --- |
| wall width | thickness of the ribbon each curve is buffered into |
| wall height | how tall the walls stand |
| lowest / tallest face | the ends of the palette's height range |
| curve accuracy | max chord error when flattening arcs, circles and splines |
| scale | multiplies every coordinate — see *Input formats* below |
| seed | fixes the starting heights so a result is reproducible |
| layers | which layers to read; shown when a drawing has more than one |

## Scripting the faces

**Callback…** opens a code editor (Monaco, from a CDN — a plain text box if it
cannot be reached). The script runs *once* with the whole set of faces, so the
loop is yours to write: sort, group or bucket them however you like before
deciding what each one becomes.

```js
faces    // [{ id, area, centroid: [x, y], height, stack }]
stack    // [{ hue, t }] bottom layer first — hue is 0..3, t is mm thick
levels   // the five palette heights
hues     // the four hue angles, in degrees
```

**Load a template…** in the header drops in a working starting point:

| Template | |
| --- | --- |
| Do nothing (default) | the bare loop, changes nothing |
| Random single hue | one layer per face, random colour and height |
| Random stacks | one to three random layers per face |
| Hue by rotation | cycle the palette rows in face order |
| Colour by area | rank by size, a hue and height per band |
| Height by area | bigger faces stand taller, colours untouched |
| Radial rings | rings stepping out from the middle |
| Vertical gradient | low at the foot of the drawing, tall at the top |
| Checkerboard | two colours alternating over a 10 mm grid |
| Cap the tall ones | crown whatever already stands high — builds on the current state |
| Flatten | everything back to one thin layer |

Picking one replaces the editor's contents, asking first if you had written
something of your own. Assign to `face.stack` to repaint — colouring by size,
for instance:

```js
const sorted = [...faces].sort((a, b) => b.area - a.area);
sorted.slice(0, 10).forEach(f => f.stack = [{ hue: 0, t: levels[0] },
                                            { hue: 2, t: levels[4] }]);
sorted.slice(10).forEach(f => f.stack = [{ hue: 1, t: levels[1] }]);
```

The script works on copies. If it throws, or hands back a layer with a hue out
of range or a thickness that is not a number, the error is shown and **nothing**
is applied — the model is never left half-changed. Ctrl+Enter runs, Esc closes,
and the code is remembered and saved with the project.

The script is your own code running in your own browser with no sandbox, which
is the point — but it does mean a callback pasted from elsewhere can do anything
the page can.

## The frame

By default the frame is **not** printed in a colour of its own. It is built from
thin layers cycling through the palette's four hues until it reaches the wall
height — ten 0.2 mm layers for a 2 mm frame — so it prints from filaments you
have already loaded — which is what freed the fourth palette row.

| Control | |
| --- | --- |
| frame layer (mm) | thickness of each band; 0.2 mm is a typical print layer |
| use black frame | back to one solid, exported as its own `walls.stl` |

The mixed frame reads as a dark edge from the side, where all four colours are
in view. Straight down from above you see only the **topmost** layer, so that
band's colour is what the frame's top surface will be — change *frame layer* to
land the last band on the hue you want.

It is not free: each band is a full extrusion of the wall outline, so a 2 mm
frame in 0.2 mm layers is roughly ten times the frame triangles. On the gothic
example that took the STL from 2.9 MB to 16 MB. Slicers cope; it is only worth
knowing before you wonder where the size came from.

## Mounting holes

Holes are cut straight through the part, for hanging it once it is printed.
Set a diameter, press **Place hole**, then click where each one should go —
the mode stays on so you can place several. Each hole appears in a list with
its position, and a red ring marks it in the view.

The preview is re-cut on the server, so what you see is what the STL contains.
Face ids are fixed *before* holes are cut, which is why adding or removing a
hole never disturbs the heights and colours you have already painted — even
when a hole splits a face in two or swallows a small one whole.

## Saving and reopening a project

A project holds everything needed to pick the work back up: the drawing itself,
every setting, the layer selection, the palette's four hues, the frame choice,
every face's stack of coloured layers, the holes, and the callback script. There are two places to put one.

**On the server** — type a name under *saved projects* and press **Save**. It
lands in `projects/` next to the app and appears in the list; click a name to
reopen it, or ✕ to delete it (both saving over an existing name and deleting
ask first). This is the one to use day to day — no files to manage.

**As a file** — **Save project** downloads a `.v2sproj`. Drop it back on the
page to reopen. Use this to move work between machines or to keep a copy
outside the app.

Either way the drawing is embedded rather than referenced, so a project stands
alone. Face ids are derived from the drawing and the wall settings; if a project
no longer produces the same number of faces, it says so and starts fresh instead
of pinning colours to the wrong faces.

Set `PROJECT_DIR` to keep the server's projects somewhere else. Project names
allow letters, digits, spaces, `.`, `_` and `-`, and must start with a letter or
digit — enough to keep a name from ever pointing outside that directory.

### Rescuing a session saved before this existed

`tools/recover-project.js` pulls a `.v2sproj` out of a tab that predates project
saving. Paste it into that tab's console — **without reloading** — then click a
save button; the state it sends is intercepted and written out as a project.

## Saving the model

- **Download STL** — one file containing the walls and every face, exactly as
  previewed.
- **Export 3MF (Snapmaker)** — the whole model as one 3MF project with the
  colours already assigned. See *3MF* below.
- **Export STLs by colour** — one STL per hue, named for the hue in use
  (`…-1-orange.stl`, `…-2-teal.stl`, …), for multi-material printing. Each
  *layer* goes to its own colour's file, so a stacked face is split across them
  at the right heights. A solid frame adds `…-walls.stl`; a mixed frame has its
  bands filed under their own colours instead.
  Browsers ask for permission the first time a page saves several files at once.

## 3MF

A 3MF is a zip. The geometry is plain 3MF core — one `.model` per part under
`3D/Objects/`, each holding `<vertices>` and `<triangles>` — and the **colour
is not in the mesh at all**. It lives in `Metadata/model_settings.config`:

```xml
<object id="4">
  <metadata key="name" value="2-lime"/>
  <metadata key="extruder" value="2"/>     <!-- this is the colour -->
  <part id="3" subtype="normal_part"> … </part>
</object>
```

The export writes that flavour: the one Snapmaker's slicer (a Bambu Studio
fork) reads, with the production extension and a `[Content_Types].xml`,
`_rels/.rels` and `3D/_rels/3dmodel.model.rels` to match. Palette row *n*
becomes extruder *n*, so orange is extruder 1 and violet is extruder 4.

Every part is placed with the **same** transform, centred on the 270 × 270 bed,
so the colours stay registered on top of each other. This matters: importing
loose STLs makes the slicer centre each one independently, which pulls them out
of alignment — in the reference file this project was built from, the four
colours sat up to 22 mm away from the frame.

No printer profile is written, so opening the file uses whatever printer and
filaments you already have selected rather than overriding them. A solid frame
needs a fifth extruder, which a four-colour printer does not have — the mixed
frame keeps the whole model within four.

## Input formats

Both readers produce the same thing — flattened polylines in millimetres — so
an SVG and the equivalent DXF give the same relief. There is no SVG-to-DXF
conversion step.

**DXF** — `LINE`, `ARC`, `CIRCLE`, `ELLIPSE`, `LWPOLYLINE`, `POLYLINE` and
`SPLINE`, with `INSERT` block references exploded. Layers come from the drawing.

**SVG** — `path` (all commands, including arcs and relative forms), `rect`
(incl. rounded), `circle`, `ellipse`, `line`, `polyline`, `polygon`, plus
`<use>` references. Transforms are applied, nested groups included. Groups name
the layers, using the Inkscape label when there is one, so the layer picker
works the same way. Hidden elements (`display:none`, `visibility:hidden`) are
left out. Only outlines matter — fills and strokes are ignored.

**Sizing.** SVG's y axis points down and the model's points up, so the drawing
is flipped for you. Lengths follow the SVG spec: a page declared in physical
units (`width="100mm"`) comes out at that size, and a unitless page is read as
CSS pixels at 96 dpi, so `100` becomes 26.46 mm. When that is not what you
wanted, set **scale** — for a unitless page meant to be millimetres, use
`3.7795`.

## Command line

The converter runs standalone:

```bash
.venv/bin/python tools/dxf2stl.py sketch.dxf out.stl --wall-width 1.0 --seed 7
.venv/bin/python tools/dxf2stl.py drawing.svg out.stl --scale 3.7795
.venv/bin/python tools/dxf2stl.py sketch.dxf --inspect     # layers + geometry counts
.venv/bin/python tools/dxf2stl.py sketch.dxf --regions     # face outlines as JSON

# heights.json: {"0": 1.1, "3": 0.2}   holes.json: [{"x": 12, "y": 80, "d": 4}]
# --wall-stack takes the same layer list for the frame
# stacks.json:  {"0": [{"t": 0.65, "g": "1-orange"}, {"t": 1.1, "g": "3-violet"}]}
.venv/bin/python tools/dxf2stl.py sketch.dxf out.stl --heights heights.json --holes holes.json
.venv/bin/python tools/dxf2stl.py sketch.dxf out.stl --stacks stacks.json
.venv/bin/python tools/dxf2stl.py sketch.dxf out_dir --stacks stacks.json --split
.venv/bin/python tools/dxf2stl.py sketch.dxf out.3mf  --stacks stacks.json
```

A face is a stack of layers, bottom first, each with a thickness `t` and a
colour group `g`; `--heights` is the shorthand for a stack one layer deep.
`--split` writes one STL per group into the output directory instead of a
single file; an output named `.3mf` writes a 3MF project instead.

A face's id is its index in `--regions` output. That order is pinned by area
then centroid, so the same drawing and wall width always yield the same ids —
which is what lets the browser hand heights back by id. Faces left out of
`--heights` fall back to a seeded random height; a height of `0` leaves the
face open.

The reader is chosen from the file extension. Anything without an outline (text,
hatches, images) is skipped and reported. Stats go to stdout as JSON; problems
go to stderr.

## HTTP API

| Route | |
| --- | --- |
| `POST /api/inspect` | multipart `file` (.dxf or .svg) → `{layers, skipped, curves, size}` |
| `POST /api/regions` | `file` + settings → wall and face outlines the browser extrudes |
| `POST /api/convert` | `file` + settings + `stacks` → STL body, stats in the `x-stats` header |
| `POST /api/export` | as above plus `groups` → JSON listing one base64 STL per group |
| `POST /api/export3mf` | as above → a 3MF project, colours assigned to extruders |
| `GET /api/example.dxf` | the bundled `sketch.dxf` |
| `GET /api/projects` | the saved projects, newest first |
| `GET/PUT/DELETE /api/projects/:name` | read, write or remove one |

`stacks`, `heights` and `groups` are JSON objects keyed by face id; `holes` is a
JSON array. All are sent as form fields, and `holes` applies to every route.
Uploads are capped at 16 MB. Failures return `{error, log}` with a 4xx status.

## Layout

- `server.ts` — Deno HTTP server; validates uploads, shells out to the converter
- `tools/dxf2stl.py` — DXF/SVG → shapely → trimesh → STL
- `tools/setup.ts` — builds `.venv` from `requirements.txt`; runs before `start`
- `static/index.html` — the whole frontend, three.js loaded from a CDN
- `tools/recover-project.js` — console rescue for pre-project sessions
- `sketch.dxf`, `expected_result.stl` — the example drawing and a reference output
- `projects/` — projects saved on the server (created on first save)
# mathmodels
