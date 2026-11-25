// Dev-only dependency: jsdom (resolve through NODE_PATH if installed in /tmp).
// The shader render of a CNC slice: the frame every slice of a model shares,
// and a fill that follows the exported rings however thin their slivers are.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const { JSDOM } = createRequire(import.meta.url)('jsdom');
const { window } = new JSDOM('');
globalThis.DOMParser = window.DOMParser;
globalThis.XMLSerializer = window.XMLSerializer;
const { sliceFrame, sliceShader } = await import('../static/slice-render.js');
const { evaluateGeometry } = await import('../static/vendor/shadertrace/vector-import/geometry.js');
const close = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-6, `${message}: ${a} vs ${b}`);

// A 40 × 20 mm sheet. One slice fills it; another is a small island, which the
// vector import fits to its own bounds. Both land on the same canvas.
const whole = sliceFrame([40, 20], [0, 0, 40, 20], 1.5 / 40), island = sliceFrame([40, 20], [30, 5, 34, 9], 1.5 / 4);
assert.deepEqual(whole.pixels, [1024, 550]);
assert.deepEqual(island.pixels, whole.pixels);
close(whole.unit, 11.6, 'the shorter side, margins included, spans two canvas units');
// The island's centre (32, 7) mm is the origin of its own field.
const centre = [(32 - 20) / island.unit, -(7 - 10) / island.unit];
close(centre[0] * island.zoom + island.offset[0], 0, 'island x');
close(centre[1] * island.zoom + island.offset[1], 0, 'island y');

// A slice as exported: an arch with hair-thin sliver holes where its sweeps meet.
const svg = readFileSync(new URL('./fixtures/slice-sliver.svg', import.meta.url), 'utf8');
const shader = sliceShader(svg, '#e0a35c');
const { frame, geometry } = shader, [width, height] = frame.pixels;
assert.deepEqual(frame.pixels, [1024, 917]);
// Distance in mm at a point of the sheet, through the same mapping as the shader's sdf().
const distance = (x, y) => {
  const p = [(x - 47.67257309 / 2) / frame.unit, -(y - 42.298015594 / 2) / frame.unit];
  return evaluateGeometry(geometry.groups, p.map((v, i) => v * frame.zoom + frame.offset[i])) / geometry.scale;
};
close(distance(20, 41.298015594), -1, '1 mm inside the straight bottom edge');
close(distance(20, 43.298015594), 1, '1 mm below it');
// One sliver's ring doubles back on itself. Its rows must stay filled inside the
// sheet and empty beside it, all the way across.
const pixel = 2 * frame.unit / Math.min(width, height);
for (let row = 0; row < height; row++) {
  const y = (row + .5) * pixel - (height * pixel - 42.298015594) / 2;
  assert.ok(distance(-1.5, y) > 0, `row ${row}: empty left of the sheet`);
  assert.ok(distance(49, y) > 0, `row ${row}: empty right of the sheet`);
  if (y > 30 && y < 42) assert.ok(distance(23.8, y) < 0, `row ${row}: material in the middle`);
}

// The generated GLSL answers in the sheet's frame, in the slice's colour.
assert.equal(shader.data, null, 'a small slice stays self-contained GLSL');
assert.equal(shader.sdf.match(/float sdf\(vec2 p\)/g).length, 2, 'the import\'s field, renamed, and the framed one');
assert.match(shader.sdf, /^#define sdf sliceField\n[\s\S]*\n#undef sdf\n[\s\S]*return sliceField\(p \* 0\.725445\d* \+ vec2\(0\.0, 0\.0\)\) \/ 0\.0314646\d*;/);
assert.match(shader.shade, /const vec3 sheet = vec3\(0\.878431373, 0\.639215686, 0\.360784314\);/);
assert.throws(() => sliceShader('<svg xmlns="http://www.w3.org/2000/svg"/>', '#e0a35c'), /no usable viewBox/);
console.log('Slice render checks passed: shared frame, millimetre distances, sliver rings, GLSL.');
