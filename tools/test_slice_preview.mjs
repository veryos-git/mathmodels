// Dev-only dependencies: three and jsdom (resolve through NODE_PATH if installed in /tmp).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const THREE = require('three');
const { JSDOM } = require('jsdom');
const { window } = new JSDOM('<div id="list"></div><button id="add"></button><button id="export"></button><p id="range"></p>');
globalThis.document = window.document;
const source = readFileSync(new URL('../static/slice-preview.js', import.meta.url), 'utf8');
const { initSlicePreview } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const $ = id => document.getElementById(id);
const scene = new THREE.Scene(), modelGroup = new THREE.Group();
scene.add(modelGroup);
// Nonzero base and translated XY ensure the plane follows actual model coordinates.
const mesh = new THREE.Mesh(new THREE.BoxGeometry(20, 30, 10), new THREE.MeshBasicMaterial());
mesh.position.set(7, 9, 15);
modelGroup.add(mesh);
const exported = [];
const preview = initSlicePreview({ THREE, scene, modelGroup, list: $('list'),
  addButton: $('add'), exportButton: $('export'), rangeLabel: $('range'),
  exportSlices: async entries => exported.push(entries), reportError: e => { throw e; },
});
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
input.value = '2.125';input.dispatchEvent(new window.Event('input'));
assert.equal(preview.planes.children[0].position.z, 12.125);
await $('export').onclick();
assert.equal(exported[0][0].height, 2.125);
assert.equal(exported[0][0].color, preview.snapshot()[0].color);
for (const height of ['', '-1', '10', '100']) {
  input.value = height;input.dispatchEvent(new window.Event('input'));
  assert.equal(input.checkValidity(), false);
  assert.equal($('export').disabled, true);
  assert.equal(preview.planes.children[0].visible, false);
}
input.value = '0';input.dispatchEvent(new window.Event('input'));
assert.equal(input.checkValidity(), true);
assert.equal(preview.planes.children[0].position.z, 10);
const show = document.querySelector('.slice-show');
show.click();assert.equal(preview.planes.children[0].visible, false);
const saved = preview.snapshot();
preview.restore(saved);
assert.deepEqual(preview.snapshot(), saved);
const remaining = preview.planes.children[1];
let disposed = 0;
remaining.traverse(o => o.geometry?.addEventListener('dispose', () => disposed++));
document.querySelectorAll('.slice-remove')[1].click();
assert.equal(preview.snapshot().length, 1);
assert.equal(disposed, 2, 'plane and outline geometries released');
// Rebuilding updates the common origin while retaining explicit slice heights.
mesh.position.z = 25;preview.syncModel();
assert.equal(preview.planes.children[0].position.z, 20);
modelGroup.clear();preview.syncModel();
assert.equal($('add').disabled, true);
assert.equal(preview.planes.children[0].visible, false);
preview.clear();assert.equal(preview.planes.children.length, 0);
console.log('Slice preview checks passed: coordinates, colors, heights, validation, export, persistence, rebuild, cleanup.');
