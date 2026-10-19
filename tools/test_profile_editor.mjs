import assert from 'node:assert/strict';
import { moveProfile, resizeProfile, sectionBounds, sectionHit, snapProfileOffset } from '../static/profile-editor-geometry.js';

const main = { bounds: [-2, 0, 2, 3], exterior: [[-2, 0], [2, 0], [2, 3], [-2, 3], [-2, 0]], holes: [] };
const groove = { bounds: [0, 1, 1, 4], exterior: [[0, 1], [1, 1], [1, 4], [0, 4], [0, 1]], holes: [] };
const start = { sx: 2, sy: .5, z: 1.2, locked: false };

for (const [dy, expected] of [[.24, 1.4], [-.26, .9], [-1.51, -.3], [0, 1.2]]) {
  const moved = moveProfile(start, dy);
  assert.equal(moved.z, expected);
  assert.deepEqual([moved.sx, moved.sy, moved.locked], [2, .5, false], 'translation cannot change width or horizontal registration');
  const before = sectionBounds(groove, start), after = sectionBounds(groove, moved);
  assert.equal(after[0], before[0]); assert.equal(after[2], before[2]);
  assert(Math.abs((after[1] - before[1]) - (moved.z - start.z)) < 1e-12);
}
assert.equal(snapProfileOffset(-.01), 0);
assert.equal(snapProfileOffset(123.456), 123.5);
assert.equal(start.z, 1.2, 'gestures do not mutate their starting state');

const wider = resizeProfile(main, start, 'width', {x:6,y:100});
assert.deepEqual(wider, {...start,sx:3}, 'width handle leaves height and offset fixed');
const taller = resizeProfile(main, start, 'height', {x:100,y:4.2});
assert.deepEqual(taller, {...start,sy:1}, 'height handle leaves width and offset fixed');
const corner = resizeProfile(main, {...start,locked:true}, 'corner', {x:8,y:4.2});
assert.equal(corner.sx, 4); assert.equal(corner.sy, 1); assert.equal(corner.z, start.z);
const locked = resizeProfile(main, {...start,locked:true}, 'width', {x:8,y:99});
assert.equal(locked.sy / locked.sx, start.sy / start.sx);
const clamped = resizeProfile(main, start, 'corner', {x:-100,y:-100});
assert(clamped.sx > 0 && clamped.sy > 0, 'dragging through the origin never inverts a section');
assert.deepEqual(sectionBounds(groove, start), [0, 1.7, 2, 3.2], 'groove keeps imported registration after independent scaling');

const plain = {sx:1,sy:1,z:0,locked:false};
assert(Math.abs(sectionHit(main, plain, {x:2.05,y:1}, .1) - .05) < 1e-12);
assert.equal(sectionHit(main, plain, {x:0,y:1}, .1), Infinity);
assert.equal(sectionHit(main, plain, {x:10,y:1}, .1), null);
const holed = {...main, holes:[[[-1,1],[1,1],[1,2],[-1,2],[-1,1]]]};
assert.equal(sectionHit(holed, plain, {x:0,y:1.5}, .1), null, 'holes do not intercept section selection');
assert.equal(sectionHit(holed, plain, {x:1,y:1.5}, .1), 0, 'hole edges remain selectable');
console.log('Profile editor: signed 0.1 mm movement, fixed horizontal position, resize handles, locks, registration and selection passed.');
