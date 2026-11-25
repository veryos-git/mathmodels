// Dev-only dependencies: three and jsdom (resolve through NODE_PATH if installed in /tmp).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const THREE = require('three');
const { JSDOM } = require('jsdom');
const { window } = new JSDOM('<div id="list"></div><button id="add"></button><button id="export"></button><p id="range"></p>');
globalThis.document = window.document;
globalThis.DOMParser = window.DOMParser;
globalThis.XMLSerializer = window.XMLSerializer;
const source = readFileSync(new URL('../static/slice-preview.js', import.meta.url), 'utf8');
const { initSlicePreview } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const $ = id => document.getElementById(id);
const scene = new THREE.Scene(), modelGroup = new THREE.Group();
scene.add(modelGroup);
// Nonzero base and translated XY ensure the plane follows actual model coordinates.
const mesh = new THREE.Mesh(new THREE.BoxGeometry(20, 30, 10), new THREE.MeshBasicMaterial());
mesh.position.set(7, 9, 15);
modelGroup.add(mesh);

// The page's side of the bargain: a model that can be sliced, rendered, zipped and saved.
const model = { key: 'model 1', error: null, emptyAt: 7, renders: true, delay: 5 };
const loads = [], saved = [], inspected = [], statuses = [], errors = [];
const sliceSvg = height => `<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="30mm" viewBox="0 0 20 30">
<title>Cross-section ${height} mm above model base</title>
<g fill="none" stroke="black" stroke-width="0.1" fill-rule="evenodd"><path d="M0,0 L20,0 L20,30 L0,30 Z"/></g></svg>`;
const preview = initSlicePreview({ THREE, scene, modelGroup, list: $('list'),
  addButton: $('add'), exportButton: $('export'), rangeLabel: $('range'),
  sliceSource() {
    if (model.error) throw new Error(model.error);
    return { key: model.key, name: 'demo', async load(height, signal) {
      loads.push(height);
      await new Promise(resolve => setTimeout(resolve, model.delay));
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (height === model.emptyAt) throw new Error('This height does not intersect any solid');
      return sliceSvg(height);
    } };
  },
  async renderSlice(svg, color) {
    if (!model.renders) throw new Error('WebGL 2 is unavailable.');
    return new Blob([`render ${color} ${svg.length}`], { type: 'image/png' });
  },
  zipFiles: async files => files,
  saveBlob: (data, type, name) => saved.push({ data, type, name }),
  inspect: (file, opener) => inspected.push({ file, opener }),
  reportStatus: text => statuses.push(text), reportError: error => errors.push(error.message),
});
const rowParts = () => [...document.querySelectorAll('.slice-row')].map(row => ({
  preview: row.querySelector('.slice-preview'), outline: row.querySelector('.slice-outline'),
  render: row.querySelector('.slice-render'), image: row.querySelector('.slice-render img'),
  note: row.querySelector('.slice-note'), input: row.querySelector('.slice-height'),
  download: row.querySelector('.slice-download'),
}));
// Previews load after a short pause, one slice at a time.
const settled = async (...states) => {
  for (let waited = 0; ; waited += 10) {
    const pending = rowParts().filter((row, i) =>
      !row.preview.hidden && row.preview.dataset.state !== (states[i] ?? states[0] ?? 'ready'));
    if (!pending.length && waited >= 400) return;
    assert.ok(waited < 3000, `previews did not reach ${states.join(', ') || 'ready'}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
const type = (input, value) => { input.value = value; input.dispatchEvent(new window.Event('input')); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

assert.equal($('add').disabled, true);
preview.syncModel();
$('add').click();
$('add').click();
assert.equal(preview.snapshot().length, 2);
assert.notEqual(...preview.snapshot().map(s => s.color));
assert.equal(modelGroup.children.length, 1, 'planes must not pollute model bounds or raycasting');
assert.equal(preview.planes.children[0].position.z, 15, 'height 5 above model base Z=10');
assert.equal(preview.planes.children[0].position.x, 7);
assert.equal(preview.planes.children[0].position.y, 9);
const input = document.querySelector('.slice-height');
type(input, '2.125');
assert.equal(preview.planes.children[0].position.z, 12.125);

// Each slice shows its SVG outline in its own colour, and its shader render.
await settled();
const colors = preview.snapshot().map(s => s.color);
assert.deepEqual(loads, [2.125, preview.snapshot()[1].height], 'one request per slice, for the height typed last');
for (const [i, row] of rowParts().entries()) {
  const svg = row.outline.querySelector('svg');
  assert.equal(svg.getAttribute('viewBox'), '0 0 20 30');
  assert.equal(svg.hasAttribute('width'), false, 'the thumbnail sizes the outline');
  assert.equal(svg.querySelector('g').getAttribute('stroke'), colors[i]);
  assert.match(row.image.getAttribute('src'), /^blob:/);
  assert.equal(row.outline.disabled || row.render.disabled, false);
  assert.equal(row.note.hidden, true);
}
rowParts()[0].outline.click();
rowParts()[1].render.click();
assert.deepEqual(inspected.map(({ file }) => [file.name, file.type]),
  [['slice-1-2.125mm.svg', 'image/svg+xml'], [`slice-2-${preview.snapshot()[1].height}mm.png`, 'image/png']]);
assert.match(await inspected[0].file.text(), new RegExp(`stroke="${colors[0]}"`));

// One slice's SVG comes from its preview; all of them come as one zip, renders included.
await rowParts()[0].download.onclick();
assert.equal(loads.length, 2, 'a current preview is not requested again');
assert.deepEqual([saved[0].type, saved[0].name], ['image/svg+xml', 'demo-slice-1-2.125mm.svg']);
assert.match(saved[0].data, new RegExp(`stroke="${colors[0]}"`));
await $('export').onclick();
assert.deepEqual([saved[1].type, saved[1].name], ['application/zip', 'demo-slices.zip']);
const second = `demo-slice-2-${preview.snapshot()[1].height}mm`;
assert.deepEqual(saved[1].data.map(file => file.name),
  ['demo-slice-1-2.125mm.svg', 'demo-slice-1-2.125mm.png', `${second}.svg`, `${second}.png`]);
assert.equal(await saved[1].data[1].data.text(), `render ${colors[0]} ${saved[0].data.length}`);
assert.match(statuses.at(-1), /2 slice SVGs and 2 renders in one zip/);
assert.deepEqual(errors, []);

for (const height of ['', '-1', '10', '100']) {
  type(input, height);
  assert.equal(input.checkValidity(), false);
  assert.equal($('export').disabled, true);
  assert.equal(preview.planes.children[0].visible, false);
  assert.equal(rowParts()[0].preview.hidden, true, 'no preview for a height outside the model');
}
type(input, '0');
assert.equal(input.checkValidity(), true);
assert.equal(preview.planes.children[0].position.z, 10);
await settled();
assert.deepEqual(loads.slice(2), [0], 'only the edited slice is requested again');

// A height the exporter rejects says why in its row, once, and blocks the zip.
type(input, '7');
await settled('error', 'ready');
assert.match(rowParts()[0].note.textContent, /does not intersect/);
assert.equal(rowParts()[0].outline.querySelector('svg'), null);
preview.syncModel();
await pause(450);
assert.deepEqual(loads.slice(3), [7], 'a failed height is not retried until something changes');
await $('export').onclick();
assert.equal(saved.length, 2);
assert.match(errors.pop(), /^Slice 1 at 7 mm: This height does not intersect/);

// A changed model refreshes every preview; without WebGL the SVGs still work.
type(input, '1');
model.key = 'model 2';
model.renders = false;
preview.syncModel();
await settled();
assert.deepEqual(loads.slice(5), [1, preview.snapshot()[1].height]);
for (const row of rowParts()) {
  assert.ok(row.outline.querySelector('svg'));
  assert.equal(row.image.hasAttribute('src'), false);
  assert.equal(row.render.disabled, true);
  assert.match(row.note.textContent, /Shader render unavailable: WebGL 2/);
}
await $('export').onclick();
assert.deepEqual(saved[2].data.map(file => file.name), ['demo-slice-1-1mm.svg', `${second}.svg`]);
assert.match(statuses.at(-1), /2 shader renders are unavailable/);

// While the model cannot be exported, the previews are kept but marked as out of date.
model.error = 'Restore valid shape settings before exporting';
preview.syncModel();
await settled('stale');
assert.match(rowParts()[0].note.textContent, /Restore valid shape settings/);
assert.equal(rowParts()[0].outline.disabled, true);
model.error = null;
preview.syncModel();
await settled();
assert.equal(loads.length, 7, 'the same model and heights need no new requests');

// A request that is still wanted survives an edit elsewhere, and a download joins it.
model.key = 'model 3';
model.delay = 800;
preview.syncModel();
await pause(450);
assert.deepEqual(loads.slice(7), [1], 'slices load one at a time');
type(rowParts()[1].input, '3');
await pause(450);
assert.deepEqual(loads.slice(7), [1], 'slice 1 keeps loading; slice 2 waits for its turn with its new height');
await $('export').onclick();
assert.deepEqual(loads.slice(7), [1, 3]);
assert.deepEqual(saved[3].data.map(file => file.name), ['demo-slice-1-1mm.svg', 'demo-slice-2-3mm.svg']);
model.delay = 5;
await settled();
assert.equal(loads.length, 9);

const show = document.querySelector('.slice-show');
show.click();assert.equal(preview.planes.children[0].visible, false);
const snapshot = preview.snapshot();
preview.restore(snapshot);
assert.deepEqual(preview.snapshot(), snapshot);
const remaining = preview.planes.children[1];
let disposed = 0;
remaining.traverse(o => o.geometry?.addEventListener('dispose', () => disposed++));
document.querySelectorAll('.slice-remove')[1].click();
assert.equal(preview.snapshot().length, 1);
assert.equal(disposed, 2, 'plane and outline geometries released');
// Rebuilding updates the common origin while retaining explicit slice heights.
mesh.position.z = 25;preview.syncModel();
assert.equal(preview.planes.children[0].position.z, 21, 'height 1 above the new base Z=20');
modelGroup.clear();preview.syncModel();
assert.equal($('add').disabled, true);
assert.equal(preview.planes.children[0].visible, false);
// A slice removed while its preview loads leaves nothing behind.
preview.clear();assert.equal(preview.planes.children.length, 0);
await pause(450);
assert.equal(document.querySelectorAll('.slice-row').length, 0);
console.log('Slice preview checks passed: coordinates, colors, heights, validation, outlines, renders, downloads, zip, errors, persistence, rebuild, cleanup.');
