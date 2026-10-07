import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const source = readFileSync(new URL('../static/image-editor.js', import.meta.url), 'utf8');
const { denoiseImage, thresholdImage, mirrorImage, lineSide, ImageHistory } =
  await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const image = (rows) => ({ width: rows[0].length, height: rows.length,
  data: new Uint8ClampedArray(rows.flatMap(row => row.flatMap(value => [value, value, value, 255]))) });
const rows = ({ data, width, height }) => Array.from({ length: height }, (_, y) =>
  Array.from({ length: width }, (_, x) => data[(y * width + x) * 4]));

// Match the real Python preprocessing, including median border handling,
// colored/transparent input, threshold equality, inversion and 8-way specks.
const python = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
const fixtures = JSON.parse(execFileSync(python, ['-c', `
import json, sys
import numpy as np
sys.path.insert(0, 'tools')
from trace import preprocess
rng = np.random.default_rng(2026)
fixtures = []
for h, w in [(1, 1), (1, 13), (11, 1), (17, 23), (80, 90)]:
    rgba = rng.integers(0, 256, (h, w, 4), dtype=np.uint8)
    rgba[:, :, 3] = 255
    if w > 1 and h > 1:
        rgba[0:3, 0:3, 3] = rng.integers(0, 256, (3, 3), dtype=np.uint8)
    for t in [0, 64, 127, 128, 192, 255]:
        for invert in [False, True]:
            for area in [0, 2, 10]:
                for closing in [0, 1, 2, 4]:
                    if closing and t not in [64, 128]:
                        continue
                    params = dict(threshold=t, invert=invert, minArea=area, closeGaps=closing, traceMode='outline')
                    result = preprocess(rgba[:, :, [2, 1, 0, 3]], params)
                    fixtures.append(dict(width=w, height=h, data=rgba.flatten().tolist(), params=params,
                                         expected=(255-result).flatten().tolist()))
print(json.dumps(fixtures))
`], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
for (const fixture of fixtures) {
  const pixels = { ...fixture, data: new Uint8ClampedArray(fixture.data) };
  const preview = thresholdImage(denoiseImage(pixels), pixels.width, pixels.height, fixture.params);
  assert.deepEqual(Array.from(preview.data.filter((_, i) => i % 4 === 0)), fixture.expected,
    `Python parity ${pixels.width}×${pixels.height} ${JSON.stringify(fixture.params)}`);
  assert.ok(preview.data.every((value, i) => i % 4 !== 3 || value === 255));
}
assert.deepEqual(rows(thresholdImage(new Uint8Array([127, 128, 129]), 3, 1)), [[0, 0, 255]]);
assert.deepEqual(rows(thresholdImage(new Uint8Array([127, 128, 129]), 3, 1, { invert: true })), [[255, 255, 0]]);
// Diagonally touching dark pixels form one component of area two.
assert.deepEqual(rows(thresholdImage(new Uint8Array([0, 255, 255, 0]), 2, 2, { minArea: 2 })), [[0, 255], [255, 0]]);

const original = image([[10, 20, 30, 40], [50, 60, 70, 80]]);
const before = [...original.data];
assert.deepEqual(rows(mirrorImage(original, [2, 0], [2, 2])), [[40, 30, 20, 10], [80, 70, 60, 50]]);
assert.deepEqual(rows(mirrorImage(original, [0, 1], [4, 1])), [[50, 60, 70, 80], [10, 20, 30, 40]]);
assert.deepEqual(rows(mirrorImage(original, [2, 0], [2, 2], 1)), [[10, 20, 20, 10], [50, 60, 60, 50]]);
assert.deepEqual(rows(mirrorImage(original, [2, 0], [2, 2], -1)), [[40, 30, 30, 40], [80, 70, 70, 80]]);
assert.deepEqual(rows(mirrorImage(original, [2, 2], [2, 0], -1)), [[10, 20, 20, 10], [50, 60, 60, 50]]);
const square = image([[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
assert.deepEqual(rows(mirrorImage(square, [0, 0], [3, 3])), [[1, 4, 7], [2, 5, 8], [3, 6, 9]]);
assert.deepEqual(rows(mirrorImage(square, [0, 0], [3, 3], 1)), [[1, 4, 7], [4, 5, 8], [7, 8, 9]]);
assert.deepEqual(rows(mirrorImage(square, [0, 3], [3, 0])), [[9, 6, 3], [8, 5, 2], [7, 4, 1]]);
// An off-centre axis clips reflected pixels and fills uncovered space white.
assert.deepEqual(rows(mirrorImage(original, [1, 0], [1, 2])), [[20, 10, 255, 255], [60, 50, 255, 255]]);
const tilted = mirrorImage(image([[1, 2, 3, 4, 5], [6, 7, 8, 9, 10], [11, 12, 13, 14, 15]]), [0, 0], [4, 2]);
assert.equal(rows(tilted)[0][3], 13); // (3.5, .5) reflects to (2.5, 2.5).
assert.equal(rows(tilted)[2][0], 255);
assert.deepEqual([...original.data], before, 'mirror preview must not modify its source');
assert.throws(() => mirrorImage(original, [1, 1], [1, 1]), /different points/);
assert.throws(() => mirrorImage(original, [1, 0], [1, 1], 0), /Choose a side/);
assert.equal(Math.sign(lineSide([0, 1], [2, 0], [2, 2])), 1);
const colored = { width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 80, 240, 128]) };
assert.deepEqual([...mirrorImage(colored, [1, 0], [1, 1]).data], [0, 80, 240, 128, 255, 0, 0, 255]);

const history = new ImageHistory(original.data.byteLength * 2);
const a = image([[1]]), b = image([[2]]), c = image([[3]]);
history.remember(a); history.remember(b);
assert.equal(history.undo(c), b);
assert.equal(history.undo(b), a);
assert.equal(history.undo(a), null);
assert.equal(history.redo(a), b);
history.remember(b);
assert.equal(history.redo(c), null, 'editing after undo discards redo');
history.clear();
assert.equal(history.undo(c), null);
for (let i = 0; i < 5; i++) history.remember(original);
assert.equal(history.undoStack.length, 2, 'history respects its memory budget');
const smallBudget = new ImageHistory(1);
smallBudget.remember(original);
assert.equal(smallBudget.undo(a), original, 'keep at least one undo for large images');
const shortHistory = new ImageHistory(1024, 2);
shortHistory.remember(a); shortHistory.remember(b); shortHistory.remember(c);
assert.equal(shortHistory.undo(a), c);
assert.equal(shortHistory.undo(c), b);
assert.equal(shortHistory.undo(b), null, 'history also respects its step limit');
console.log(`Image editor checks passed: ${fixtures.length} Python preview comparisons, mirroring and undo/redo.`);
