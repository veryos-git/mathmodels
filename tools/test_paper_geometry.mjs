import assert from 'node:assert/strict';
import {
  apply, decorationCorners, decorationMatrix, emptiestWall, fitsA4, foldMatrices, geometryPath,
  placeAt, resizedWidth, transformPoint, wallLocal, wallPoint,
} from '../static/paper-geometry.js';

const close = (a, b, message) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-9, `${message}: ${a} vs ${b}`));

// The house's walls as tools/paper.py reports them, seen from outside (y down):
// wall 1 on top of the floor, wall 2 to its right, wall 3 below, wall 4 left.
const walls = [
  { origin: [-25, -25], x: [1, 0], y: [0, -1], size: [50, 73] },
  { origin: [25, -25], x: [0, 1], y: [1, 0], size: [50, 73] },
  { origin: [25, 25], x: [-1, 0], y: [0, 1], size: [50, 73] },
  { origin: [-25, 25], x: [0, -1], y: [-1, 0], size: [50, 73] },
];

// A wall's outside coordinates and the net agree both ways.
for (const wall of walls) close(wallLocal(wall, wallPoint(wall, [12, 34])), [12, 34], 'round trip');
close(wallPoint(walls[0], [0, 0]), [-25, -25], 'wall 1 starts at the floor\'s top-left corner');
close(wallPoint(walls[0], [10, 20]), [-15, -45], 'up the wall is up the sheet');

// Unturned, a decoration is its drawing scaled to width, y up on the wall.
const d = { x: 25, y: 30, width: 20, rotation: 0 };
close(apply(decorationMatrix(walls[0], d), [0.5, 0.25]), wallPoint(walls[0], [35, 35]), 'unturned');
// Turned 90° clockwise as seen from outside: the drawing's right edge points down the wall.
close(apply(decorationMatrix(walls[0], { ...d, rotation: 90 }), [0.5, 0]), wallPoint(walls[0], [25, 20]), 'clockwise');
// On wall 3, below the floor, the same decoration is upside down on the sheet.
close(apply(decorationMatrix(walls[2], d), [0, 0.5]), wallPoint(walls[2], [25, 40]), 'wall 3');
assert.ok(apply(decorationMatrix(walls[2], d), [0, 0.5])[1] > apply(decorationMatrix(walls[2], d), [0, 0])[1]);
assert.equal(decorationCorners(walls[0], d, 1.5).length, 4);
close(decorationCorners(walls[0], d, 1.5)[2], wallPoint(walls[0], [35, 45]), 'top-right corner');

// Dragging: onto the wall under the pointer, else clamped onto its own wall.
assert.deepEqual(placeAt(walls, 0, wallPoint(walls[1], [10, 20])), { wall: 1, x: 10, y: 20 });
assert.deepEqual(placeAt(walls, 2, [0, 0]), { wall: 2, x: 25, y: 0 }, 'the floor belongs to no wall');
assert.deepEqual(placeAt(walls, 0, [-25.04, -60.06]), { wall: 0, x: 0, y: 35.1 }, 'snapped to 0.1 mm');

assert.equal(resizedWidth(20, [0, 0], [10, 0], [15, 0]), 30);
assert.equal(resizedWidth(20, [0, 0], [10, 0], [0, 0]), 1, 'never below 1 mm');
assert.equal(emptiestWall(4, [{ wall: 0 }, { wall: 1 }, { wall: 0 }]), 2);
assert.equal(emptiestWall(0, []), 0);
assert.equal(fitsA4(196, 196), true);
assert.equal(fitsA4(280, 200), true);
assert.equal(fitsA4(300, 200), false);
assert.equal(geometryPath({ points: [[0, 0], [1, 0], [0, 1]], paths: [[0, 1, 2]] }), 'M0 0 L1 0 L0 1 Z');

// Folding: a flap hinged along y = 10 (left to right) rises as it folds.
const faces = [
  { rings: [], parent: -1, hinge: null, angle: 0 },
  { rings: [], parent: 0, hinge: [[0, 10], [10, 10]], angle: 90 },
  // Hinges run so that turning about them lifts the face (tools/paper.py orients them).
  { rings: [], parent: 1, hinge: [[10, 20], [10, 10]], angle: 90 },
];
const flat = foldMatrices(faces, 0);
close(transformPoint(flat[2], [11, 15]), [11, 15, 0], 'unfolded');
const [, flap, tab] = foldMatrices(faces, 1);
close(transformPoint(flap, [5, 20]), [5, 10, 10], 'the flap stands up');
// 5 mm up the flap, and turned 2 mm inward from it, towards where the floor is.
close(transformPoint(tab, [12, 15]), [10, 8, 5], 'the tab turns with its flap, then on its own hinge');
const half = foldMatrices(faces, 0.5)[1];
close(transformPoint(half, [0, 20]), [0, 10 + 10 * Math.SQRT1_2, 10 * Math.SQRT1_2], 'half way');

console.log('paper geometry tests passed');
