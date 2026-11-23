# DXF and SVG shader previews

Choose **Shader preview** in the model viewer's toolbar. The source list includes
every uploaded project drawing and cross-section, including stacked drawings,
boundary, cusp paths/profile, groove profile, lid sketch, shelf outline and shelf
edge profile. Shared shelf/main cross-sections can be selected by either role.
Use **Shader** in an individual vector preview to open that file directly,
including files in the library before they are added to a project.

Tick one source or several. Ticked sources are drawn into one field, each in its
own drawing coordinates, so sketches exported from the same CAD document (a frame
and its cusp paths, say) line up as drawn; the combination is then centered and
fitted to the canvas. Sources drawn in unrelated coordinates land wherever those
coordinates put them. An SVG is y-down, so beside a DXF it is mirrored about its
x axis. Curve detail is relative to the size of the whole combination, so a small
drawing gets fewer segments beside a large one than on its own. Opening a single
file with **Shader** shows that file alone without changing the combination
saved with the project.

The preview uses the source vector geometry, centered and fitted to shader
coordinates with +Y up. Selected DXF sublayers are honored for project drawings.
It is a visualization of the original paths and sections, not of the generated
STL, its placement transforms or its paint assignments.

**Automatic** displays drawing paths as outlines and profile/boundary/shelf
inputs with closed fills, each ticked source by its own role. **Filled closed shapes** honors SVG fill rules and
preserves DXF nested holes; open paths remain strokes. **Path outlines** strokes
all contours. Outline width is in normalized shader units. Curve detail changes
the polyline approximation used to generate a signed distance field.

All 60 styles from [Shadertrace](https://github.com/jonasfrey/shadertracev2) are
available, from silhouette and neon through contours, materials, diagnostics and
particles. Pause, restart or scrub the animation; adjust its loop length and
render resolution. Ticked sources, style and preview controls are saved in
`.v2sproj` under `shaderPreview`. Older projects keep their single source or use
defaults. Shader inspection
does not rebuild or alter the 3D model.

- **Save PNG** captures the current animation frame at the selected export size.
- **Save GIF** renders one full loop at the selected export size and GIF frame
  rate (10, 20, 25 or 50 fps; an 8 s loop at 20 fps is 160 frames). Frames are
  spaced evenly over the loop length, so the GIF repeats seamlessly forever. All
  frames share one 255-colour palette chosen from 24 frames across the loop, and
  each frame after the first stores only the pixels that changed. Progress is
  shown under the buttons; the button becomes **Cancel GIF** while it runs, and
  closing the dialog cancels it too.

Export size (256 to 4096 px, square) is independent of the live preview
resolution. Exports that differ from the preview resolution compile the shader
on a separate offscreen canvas and draw in 1024 px tiles, so the preview keeps
running and large frames don't trip the GPU watchdog. GIF encoding runs in the
page between frames: 512 px encodes in a few seconds, 4096 px roughly 0.3 s per
frame plus render time, and large smooth GIFs can reach hundreds of MB. GPUs
smaller than the chosen size report their limit.
- **Save shader bundle** downloads `.shader.json` (format version 2) containing
  generated SDF GLSL, style GLSL, complete GLSL ES 3.00 vertex/fragment stages,
  uniforms, normalized geometry bounds, metadata for every source in `sources`,
  warnings and draw-pass instructions. Particle styles include both particle
  stages and their additional blended point pass. A drawing too large for shader
  constants (see the limits below) also lists its geometry texture in `textures`:
  an RGBA32F image, base64 of little-endian floats, to upload with nearest
  filtering and bind to the named sampler. The comment at the top of `sdf`
  describes its layout. `textures` is empty for smaller drawings, whose GLSL is
  self-contained. The JSON is suitable for integration into a WebGL 2 renderer;
  it is not an STL.

Exports of several sources are named after the first one, with `+1`, `+2`, … for
the others.

Parsing and rendering run locally in the browser. Opening a library file fetches
its original from this app; nothing is uploaded to Shadertrace. One shader canvas
is shared across previews. Animation stops when the dialog or browser tab is
hidden, and GPU programs are disposed when the dialog closes. A lost WebGL context
is reported and the preview rebuilds when the browser restores it.

WebGL 2 is required. The converter supports SVG and ASCII DXF, with limits of
16 MB per file and 32,768 flattened segments and path commands for all ticked
sources together. A drawing of up to 1,024 segments whose SDF code fits in 100 KB
is written into the shader as constants. Anything larger, in segments or in
number of separate shapes, keeps its geometry in a float texture instead, because
GLSL compilers reject constant arrays and shaders of that size. There the shader
is the same few lines for every drawing: edges are stored in runs of 16 with a
bounding box each, and a pixel skips every run and every whole shape that cannot
be nearer than what it has already found, so the field stays exact while most
edges go unread. Invalid, nonplanar or overly complex inputs show errors, and
with several sources the message names the file; unsupported entities and
ambiguous DXF joins show warnings. CAD sketches often export a shared edge once
per region that uses it; a DXF entity that traces the same curve as an earlier
one is skipped, and a warning gives the count. Such copies used to multiply the
segment count, leave joins ambiguous and cancel each other in even-odd fills. Use **Fast** curve detail or simplify the
source to reduce segment count. Repeated-field styles (materials, ray tracing and
volume) can be slow on complex paths; use 256 × 256 for those. These preview
limits do not change the application's existing model import limits.

Vendored module provenance and local changes are recorded in
[`static/vendor/shadertrace/README.md`](../static/vendor/shadertrace/README.md).
Run `deno task test:shaders` for parser and integration regression tests.

For browser checks against a running server, run
`PLAYWRIGHT_MODULE=/path/to/playwright-core node tools/test_shader_browser.mjs`.
`CHROME_PATH` selects the browser, `APP_URL` selects the local server, and
`SHADER_PROJECT` can select a project fixture. The browser suite renders every
style, with constants and with an edge texture, and checks combined sources,
exports, project save/open, source previews, mobile layout, invalid input, stale
requests, GPU context recovery and unavailable WebGL.
