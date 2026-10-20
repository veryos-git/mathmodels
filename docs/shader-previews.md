# DXF and SVG shader previews

Choose **Shader preview** in the model viewer's toolbar. The source menu includes
every uploaded project drawing and cross-section, including stacked drawings,
boundary, cusp paths/profile, groove profile, lid sketch, shelf outline and shelf
edge profile. Shared shelf/main cross-sections can be selected by either role.
Use **Shader** in an individual vector preview to open that file directly,
including files in the library before they are added to a project.

The preview uses the source vector geometry, centered and fitted to shader
coordinates with +Y up. Selected DXF sublayers are honored for project drawings.
It is a visualization of the original paths and sections, not of the generated
STL, its placement transforms or its paint assignments.

**Automatic** displays drawing paths as outlines and profile/boundary/shelf
inputs with closed fills. **Filled closed shapes** honors SVG fill rules and
preserves DXF nested holes; open paths remain strokes. **Path outlines** strokes
all contours. Outline width is in normalized shader units. Curve detail changes
the polyline approximation used to generate a signed distance field.

All 60 styles from [Shadertrace](https://github.com/jonasfrey/shadertracev2) are
available, from silhouette and neon through contours, materials, diagnostics and
particles. Pause, restart or scrub the animation; adjust its loop length and
render resolution. Source choice, style and preview controls are saved in
`.v2sproj` under `shaderPreview`. Older projects use defaults. Shader inspection
does not rebuild or alter the 3D model.

- **Save PNG** captures the current animation frame at the selected resolution.
- **Save shader bundle** downloads `.shader.json` containing generated SDF GLSL,
  style GLSL, complete GLSL ES 3.00 vertex/fragment stages, uniforms, normalized
  geometry bounds, source metadata, warnings and draw-pass instructions. Particle
  styles include both particle stages and their additional blended point pass.
  The JSON is suitable for integration into a WebGL 2 renderer; it is not an STL.

Parsing and rendering run locally in the browser. Opening a library file fetches
its original from this app; nothing is uploaded to Shadertrace. One shader canvas
is shared across previews. Animation stops when the dialog or browser tab is
hidden, and GPU programs are disposed when the dialog closes. A lost WebGL context
is reported and the preview rebuilds when the browser restores it.

WebGL 2 is required. The upstream converter supports SVG and ASCII DXF, with
limits of 2 MB, 1,024 flattened segments and 100 KB generated SDF code. Invalid,
nonplanar or overly complex inputs show errors; unsupported entities and ambiguous
DXF joins show warnings. Use **Fast** curve detail or simplify the source to reduce
segment count. Repeated-field styles (materials, ray tracing and volume) can be
slow on complex paths; use 256 × 256 for those. These preview limits do not change
the application's existing model import limits.

Vendored module provenance and local changes are recorded in
[`static/vendor/shadertrace/README.md`](../static/vendor/shadertrace/README.md).
Run `deno task test:shaders` for parser and integration regression tests.

For browser checks against a running server, run
`PLAYWRIGHT_MODULE=/path/to/playwright-core node tools/test_shader_browser.mjs`.
`CHROME_PATH` selects the browser, `APP_URL` selects the local server, and
`SHADER_PROJECT` can select a project fixture. The browser suite renders all 60
styles and checks exports, project save/open, source previews, mobile layout,
invalid input, stale requests, GPU context recovery and unavailable WebGL.
