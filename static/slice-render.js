/** A simple shader render of one CNC slice: the cut sheet, lit from the top left, in the slice's colour. */
import { ShaderRenderer } from './vendor/shadertrace/renderer.js';
import { parseVector } from './vendor/shadertrace/vector-import/index.js';
import { flatten, generateDataGLSL, generateGLSL, LIMITS } from './vendor/shadertrace/vector-import/geometry.js';

// Pixels along the longer side of a render.
const SIZE = 1024;

const float = value => {
  const text = String(Number(value.toPrecision(9)));
  return /[.e]/.test(text) ? text : `${text}.0`;
};

/**
 * Where the sheet sits on the canvas. `view` is the SVG's viewBox size in mm;
 * `bounds` and `scale` describe how the vector import fitted this slice alone.
 * Every slice of a model gets the same canvas, so their renders line up.
 */
export function sliceFrame([width, height], bounds, scale, size = SIZE) {
  const margin = .04 * Math.max(width, height);
  const frame = [width + 2 * margin, height + 2 * margin], longest = Math.max(...frame);
  const unit = Math.min(...frame) / 2; // mm per canvas unit: the shorter side spans -1 to 1
  return {
    pixels: frame.map(side => Math.max(1, Math.round(size * side / longest))),
    unit, lift: .012 * Math.max(width, height),
    // Canvas units to the import's own centred, y-up field coordinates.
    zoom: unit * scale,
    offset: [(width / 2 - (bounds[0] + bounds[2]) / 2) * scale, ((bounds[1] + bounds[3]) / 2 - height / 2) * scale],
  };
}

/** The slice's outlines as a signed distance field: filled, holes open, in the import's fitted units. */
function sliceField(svg) {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml'), root = doc.documentElement;
  const view = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  if (doc.querySelector('parsererror') || view.length !== 4 || !(view[2] > 0 && view[3] > 0)) {
    throw new Error('The slice SVG has no usable viewBox.');
  }
  // Without a physical size the import keeps viewBox units, which are millimetres.
  root.removeAttribute('width');
  root.removeAttribute('height');
  // The outlines bound material: fill them, with holes left open by the even-odd rule.
  for (const node of root.querySelectorAll('[stroke]')) {
    node.setAttribute('fill', 'black');
    node.setAttribute('stroke', 'none');
  }
  const drawing = parseVector(new XMLSerializer().serializeToString(doc), 'svg');
  const geometry = flatten(drawing.groups, .002, .012, false, drawing.flipY);
  // The exporter's rings never cross, so they already are the boundary of the
  // fill. Resolving them again can lose one edge of a hair-thin sliver, and a
  // ring left open flips the fill along whole rows. Without `edges` the field
  // is built from the rings as drawn.
  for (const group of geometry.groups) delete group.edges;
  // Small slices stay self-contained GLSL; the rest read a data texture.
  const inline = geometry.segments <= LIMITS.inlineSegments ? generateGLSL(geometry) : null;
  const shader = inline && new TextEncoder().encode(inline).length <= LIMITS.inlineBytes
    ? { code: inline, data: null } : generateDataGLSL(geometry);
  return { ...shader, geometry, view: view.slice(2) };
}

/** Everything a render needs: GLSL for the field and its shading, the field's data and the canvas size. */
export function sliceShader(svg, color, size = SIZE) {
  const { code, data, geometry, view } = sliceField(svg);
  const frame = sliceFrame(view, geometry.bounds, geometry.scale, size);
  const rgb = [1, 3, 5].map(i => float(parseInt(color.slice(i, i + 2), 16) / 255));
  return {
    data, geometry, frame,
    // The import's sdf() fits each drawing to the canvas; this one answers in the sheet's frame.
    sdf: `#define sdf sliceField
${code}
#undef sdf

// Distance to the cut outline in millimetres, negative inside the material.
float sdf(vec2 p) {
    return sliceField(p * ${float(frame.zoom)} + vec2(${frame.offset.map(float).join(', ')})) / ${float(geometry.scale)};
}`,
    shade: `const vec3 sheet = vec3(${rgb.join(', ')});
const float unit = ${float(frame.unit)}; // millimetres per canvas unit
const float lift = ${float(frame.lift)}; // how far the sheet's shadow falls, in millimetres

vec3 shade(vec2 p, float d) {
    float pixel = 2.0 * unit / min(u_resolution.x, u_resolution.y);
    // The same field a short step toward the light.
    float lit = sdf(p + vec2(-0.7071, 0.7071) * lift / unit);
    float shadow = 0.6 * (1.0 - smoothstep(-0.6 * lift, 0.6 * lift, lit));
    vec3 table = vec3(0.085, 0.095, 0.115) * (1.0 - shadow);
    // Cut edges facing the light catch it, the others fall dark; both fade into the face.
    float edge = 1.0 - smoothstep(0.0, 1.5 * lift, -d);
    float facing = clamp((lit - d) / lift, -1.0, 1.0);
    vec3 face = sheet * (0.84 + 0.34 * facing * edge);
    return mix(table, face, 1.0 - smoothstep(-pixel, pixel, d));
}`,
  };
}

let renderer = null;

async function render(svg, color) {
  const shader = sliceShader(svg, color);
  if (renderer?.gl.isContextLost()) renderer = null;
  renderer ??= new ShaderRenderer(document.createElement('canvas'));
  const result = renderer.compile(shader.sdf, shader.shade, { data: shader.data });
  if (!result.ok) throw new Error(result.errors.map(error => error.message).join('\n'));
  renderer.resize(...shader.frame.pixels);
  renderer.render(0, 1);
  const blob = await new Promise(resolve => renderer.canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('The browser could not encode the render.');
  return blob;
}

let queue = Promise.resolve();

/** PNG blob of a slice SVG, as text, in `color` (#rrggbb). Renders share one GPU canvas, so they take turns. */
export function renderSlice(svg, color) {
  const turn = queue.then(() => render(svg, color));
  queue = turn.catch(() => {});
  return turn;
}
