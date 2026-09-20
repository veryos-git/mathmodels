import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const source = readFileSync(new URL('../static/region-paint.js', import.meta.url), 'utf8');
const { remapPaint } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const box = (x, w = 4) => ({ point: [x + w / 2, 2], area: w * 4, polygon: {
  exterior: [[x, 0], [x + w, 0], [x + w, 4], [x, 4], [x, 0]], holes: [],
} });
const red = [{ hue: 1, t: 0.7 }, { hue: 2, t: 0.3 }], blue = [{ hue: 3, t: 1.2 }];
assert.deepEqual(remapPaint([box(0), box(6)], [red, blue], [box(6), box(0)]), [blue, red]);
assert.deepEqual(remapPaint([box(0, 10)], [red], [box(0), box(6)]), [red, red]);
assert.deepEqual(remapPaint([box(0)], [red], [box(0), box(6)]), [red, null]);
assert.throws(() => remapPaint([box(0), box(6)], [red, blue], [box(0, 10)]), /merge/);
assert.throws(() => remapPaint([box(0), box(6)], [red, blue], [box(0)]), /remove/);
assert.deepEqual(remapPaint([box(0), box(6)], [red, red], [box(0, 10)]), [red]);
assert.deepEqual(remapPaint([box(0)], [[]], [box(0)]), [[]]);

// A placement rebuild is never refused: the biggest predecessor wins a merge
// and a face with no successor is reset, both counted for the status line.
const big = box(0, 10), small = box(8, 2);
const merged = remapPaint([big, small], [red, blue], [box(0, 10)], { strict: false });
assert.deepEqual(merged, [red]);
assert.equal(merged.merged, 1);
assert.equal(merged.lost, 0);
const dropped = remapPaint([box(0), box(6), box(12)], [red, blue, red], [box(0), box(6)], { strict: false });
assert.deepEqual(dropped, [red, blue]);
assert.equal(dropped.lost, 1);
assert.equal(dropped.merged, 0);

// Exercise the real converter with a scale change and wider walls, then
// reorder its output to ensure paint follows geometry rather than area rank.
const dir = mkdtempSync(join(tmpdir(), 'region-paint-'));
try {
  const file = join(dir, 'faces.svg');
  writeFileSync(file, '<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="20mm" viewBox="0 0 40 20"><path d="M0 0H40V20H0Z M15 0V20" fill="none" stroke="black"/></svg>');
  const generate = (...args) => JSON.parse(execFileSync('.venv/bin/python', ['tools/dxf2stl.py', file, '--regions', ...args], { encoding: 'utf8' }));
  const before = generate('--wall-width', '1');
  const after = generate('--wall-width', '2', '--scale', '2');
  assert.equal(before.regions.length, 2);
  const next = after.regions.map((r) => r.paintRegion).reverse();
  assert.deepEqual(remapPaint(before.regions.map((r) => r.paintRegion), [red, blue], next), [blue, red]);
  const holeFile = join(dir, 'holes.json');
  writeFileSync(holeFile, '[{"x":5,"y":5,"d":2}]');
  const holes = generate('--wall-width', '1', '--holes', holeFile);
  assert.deepEqual(holes.regions.map((r) => r.paintRegion), before.regions.map((r) => r.paintRegion));

  // Sliding the subject inside its boundary must leave the paint where it is:
  // the server reports faces in the subject's own frame, so a pure move is a
  // clean one-to-one mapping instead of a merge/removal clash.
  const frame = join(dir, 'frame.svg');
  writeFileSync(frame, '<svg xmlns="http://www.w3.org/2000/svg" width="48mm" height="28mm" viewBox="0 0 48 28"><path d="M2 2H46V26H2Z" fill="none" stroke="black"/></svg>');
  const window3d = (...args) => JSON.parse(execFileSync('.venv/bin/python',
    ['tools/dxf2stl.py', file, '--regions', '--boundary', frame, '--no-boundary-fit', ...args], { encoding: 'utf8' }));
  const at0 = window3d('--subject-x', '0'), at4 = window3d('--subject-x', '4');
  assert.equal(at0.regions.length, at4.regions.length);
  const paint = at0.regions.map((_, i) => [{ hue: i, t: 0.5 + i }]);
  const carried = remapPaint(at0.regions.map((r) => r.paintRegion), paint,
    at4.regions.map((r) => r.paintRegion));
  assert.deepEqual(carried, paint);
  assert.equal(carried.lost, 0);
  assert.equal(carried.merged, 0);

  console.log('Paint regression checks passed (reorder, split, added/removed faces, merge, paint stacks, scale, wall width, holes, subject slide).');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
