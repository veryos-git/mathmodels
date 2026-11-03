import assert from 'node:assert/strict';
import { moveProfile, resizeProfile, sectionBounds, sectionHit, snapProfileOffset,
  colourEdges, colourHit, colourRects, moveColour, newColour, resizeColour, setColourEdges, snapColour, COLOUR_MIN } from '../static/profile-editor-geometry.js';

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
// Colours live in section coordinates and follow the section's width, height and offset.
const scaled = { sx: 2, sy: .5, z: 1, locked: false };
const strip = { id: 'a', section: 'main', color: '#e11d48', rect: [1, 0, 1.5, 3], mirrorX: true, mirrorY: false };
assert.deepEqual(colourEdges(strip, scaled), [2, 1, 3, 2.5]);
assert.deepEqual(setColourEdges(strip, scaled, [3, 2.5, 2, 1]).rect, strip.rect, 'finished edges map back, in any order');
assert.deepEqual(colourRects(strip, main, scaled).map(r => r.rect), [[2, 1, 3, 2.5], [-3, 1, -2, 2.5]], 'mirror X reflects across the centre line');
const flipped = colourRects({ ...strip, rect: [1, 0, 1.5, 1], mirrorY: true }, main, plain);
assert.deepEqual(flipped.map(r => r.rect), [[1, 0, 1.5, 1], [-1.5, 0, -1, 1], [1, 2, 1.5, 3], [-1.5, 2, -1, 3]], 'mirror Y reflects across mid-height');
assert.deepEqual(flipped.map(r => [r.mirrorX, r.mirrorY]), [[false, false], [true, false], [false, true], [true, true]]);
assert.equal(colourHit(strip, main, scaled, { x: -2.5, y: 2 }).mirrorX, true, 'mirror images are hit-testable');
assert.equal(colourHit(strip, main, scaled, { x: 0, y: 2 }), null);
assert.deepEqual(colourEdges(moveColour(strip, scaled, .5, .25), scaled), [2.5, 1.25, 3.5, 2.75]);
assert.deepEqual(colourEdges(moveColour(strip, scaled, .5, .25, { mirrorX: true }), scaled), [1.5, 1.25, 2.5, 2.75], 'dragging a mirror image moves the original mirrored');
assert.deepEqual(colourEdges(resizeColour(strip, scaled, 'ne', { x: 4, y: 3 }), scaled), [2, 1, 4, 3]);
assert.deepEqual(colourEdges(resizeColour(strip, scaled, 'sw', { x: 99, y: 99 }), scaled).map(v => Number(v.toFixed(9))), [3 - COLOUR_MIN, 2.5 - COLOUR_MIN, 3, 2.5], 'corners cannot invert a colour');
assert.equal(snapColour(.123), .1); assert.equal(snapColour(-.026), -.05);
const band = newColour('b', 'main', main, [strip]);
assert.notEqual(band.color, strip.color, 'new colours pick an unused colour');
assert(band.rect[0] < -2 && band.rect[2] > 2 && band.rect[1] > 1.5 && band.rect[3] > 3, 'a new colour is a band over the top third, overhanging the sides');
assert.equal(strip.rect[0], 1, 'colour edits do not mutate their input');
console.log('Profile editor: signed 0.1 mm movement, fixed horizontal position, resize handles, locks, registration, selection and colour regions passed.');
