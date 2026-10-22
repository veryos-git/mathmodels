import assert from 'node:assert/strict';
import { hookPaths, hookSvg } from '../static/hook-geometry.js';

assert.deepEqual(hookPaths(24, 36), [
  [[0, 36], [0, 0], [24, 0]],
  [[0, 36], [24, 0]],
]);
const svg = hookSvg(24, 36);
assert.match(svg, /width="24mm" height="36mm"/);
assert.match(svg, /M 0 0 V 36 H 24 M 0 0 L 24 36/);
for (const [reach, height] of [[0, 1], [1, 0], [Infinity, 1], [1, NaN]]) {
  assert.throws(() => hookPaths(reach, height), /positive number/);
}
console.log('Hook geometry: generated rails and SVG dimensions passed.');
