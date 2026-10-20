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

Application UI, project persistence, exports and lifecycle management live in
`../../shader-inspector.js` and `../../shader-preview.js`.
