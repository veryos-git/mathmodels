import assert from 'node:assert/strict';
import { shelfSize, shelfProjection, shelfBounds, hitShelf, moveShelf, resizeShelf } from '../static/shelf-editor-geometry.js';

const outline = { bounds: [-30, 0, 30, 20],
  exterior: [[-30, 0], [30, 0], [20, 20], [-20, 20], [-30, 0]],
  holes: [[[-2, 5], [2, 5], [2, 10], [-2, 10], [-2, 5]]] };
const start = { x: 4, y: -1, z: 8, width: 0, depth: 0, thickness: 5, flip: false, locked: false };
assert.deepEqual(shelfSize(outline, start), { width: 60, depth: 20 });
assert.deepEqual(shelfBounds(shelfProjection(outline, start, 'top')), [-26, -1, 34, 19]);
assert.deepEqual(shelfBounds(shelfProjection(outline, start, 'front')), [-26, 3, 34, 8]);
const top = moveShelf(start, 'top', 2.34, -3.16);
assert.deepEqual([top.x, top.y, top.z], [6.3, -4.2, 8], 'top moves only footprint coordinates');
const front = moveShelf(start, 'front', 100, 1.28);
assert.deepEqual([front.x, front.y, front.z], [4, -1, 9.3], 'front dragging is vertical only');
assert.equal(hitShelf(shelfProjection(outline, start, 'top'), { x: 4, y: 6 }, .1), false, 'holes remain selectable as empty space');
assert.equal(hitShelf(shelfProjection(outline, start, 'top'), { x: 14, y: 6 }, .1), true);
assert.equal(hitShelf(shelfProjection(outline, start, 'front'), { x: 4, y: 8.2 }, .3), true, 'thin shelf edges are easy to grab');
const flipped = shelfProjection(outline, { ...start, flip: true }, 'top');
assert.deepEqual(flipped.exterior[0], [-26, 19], 'flipping reflects depth without changing the rear anchor');
assert.deepEqual(flipped.holes[0][0], [2, 14]);
const resized = resizeShelf(start, shelfSize(outline, start), 'corner', 5, 10);
assert.deepEqual([resized.width, resized.depth, resized.x, resized.y, resized.z], [70, 30, 4, -1, 8]);
const width = resizeShelf(start, shelfSize(outline, start), 'width', 5, 100);
assert.deepEqual([width.width, width.depth], [70, 20]);
const depth = resizeShelf(start, shelfSize(outline, start), 'depth', 100, 5);
assert.deepEqual([depth.width, depth.depth], [60, 25]);
for (const kind of ['width', 'depth', 'corner']) {
  const locked = resizeShelf({ ...start, locked: true }, { width: 60, depth: 20 }, kind, 5, 7);
  assert(Math.abs(locked.width / locked.depth - 3) < 1e-9, 'proportions remain exact');
  const clamped = resizeShelf({ ...start, locked: true }, { width: 60, depth: 20 }, kind, -500, -500);
  assert(clamped.width >= .2 && clamped.depth >= .2);
  assert(Math.abs(clamped.width / clamped.depth - 3) < 1e-9);
}
assert.deepEqual(start, { x: 4, y: -1, z: 8, width: 0, depth: 0, thickness: 5, flip: false, locked: false }, 'gestures never mutate their origin');
console.log('Shelf editor: top/front axis constraints, holes, flip, rear-anchored resize, aspect locks and minimum sizes passed.');
