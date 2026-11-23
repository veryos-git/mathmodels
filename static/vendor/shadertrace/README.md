# Shadertrace components

Adapted from [jonasfrey/shadertracev2](https://github.com/jonasfrey/shadertracev2),
commit `01d6f1e02aee1913bfbd7ec3cb0ac23bf02a1069` (2026-10-19).

Source paths:

- `hgc/app/public/vector-import/{index,geometry,dxf,svg,svg-path}.js`
- `hgc/app/public/renderer.js`
- `hgc/app/{templates,visualization-templates}.js`

These browser modules provide vector parsing, signed distance GLSL generation,
60 visualization styles, and WebGL 2 rendering. They have no runtime dependencies.
No upstream license file was present at this revision; this notice records
provenance without assigning a license.

Local changes:

- Pass the project's selected DXF layers to the parser (top-level entities).
- Retain compiled shader sources for a complete export, including particle stages.
- Own and dispose GPU resources explicitly; bind the vertex array on rendering.
- Combine several parsed drawings into one field (`parseVector`, `convertParsed`),
  each with its own fill/outline mode; `convertVector` remains the one-file form.
- Raise the limits to 16 MB, 32,768 segments and 32,768 path commands. Past 1,024
  segments or 100 KB of constants, `generateDataGLSL` reads edges and shapes from
  an RGBA32F texture, culled by bounding boxes, and the renderer uploads and
  binds it. That size is no longer an error, so `generateGLSL` does not check it.
- Skip DXF entities that trace the same curve as an earlier one, in either
  direction, and report how many.
- Join DXF path ends through a grid index and find fill boundaries with a sweep
  and horizontal bands. Both give the results of the exhaustive searches they
  replace, whose cost grew with the square of the drawing's size.

Application UI, project persistence, exports and lifecycle management live in
`../../shader-inspector.js` and `../../shader-preview.js`.
