import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const source = readFileSync(new URL('../static/image-editor.js', import.meta.url), 'utf8');
const { adjustImage, DEFAULT_IMAGE_ADJUSTMENTS, denoiseImage, thresholdImage, mirrorImage, lineSide, ImageHistory } =
  await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const image = (rows) => ({ width: rows[0].length, height: rows.length,
  data: new Uint8ClampedArray(rows.flatMap(row => row.flatMap(value => [value, value, value, 255]))) });
const rows = ({ data, width, height }) => Array.from({ length: height }, (_, y) =>
  Array.from({ length: width }, (_, x) => data[(y * width + x) * 4]));

const ramp = image([Array.from({ length: 256 }, (_, i) => i)]);
assert.deepEqual(adjustImage(ramp), ramp, 'neutral adjustments preserve every level exactly');
const sample = image([[0, 32, 64, 128, 192, 224, 255]]);
const adjustedRows = (params) => rows(adjustImage(sample, params))[0];
const contrastUp = adjustedRows({ contrast: 50 }), contrastDown = adjustedRows({ contrast: -50 });
assert.ok(contrastUp[2] < 64 && contrastUp[4] > 192, 'contrast separates dark and light tones');
assert.ok(contrastDown[2] > 64 && contrastDown[4] < 192, 'negative contrast softens tones');
for (const key of ['lights', 'shadows']) {
  const up = adjustedRows({ [key]: 100 }), down = adjustedRows({ [key]: -100 });
  assert.equal(up[0], 0); assert.equal(up[6], 255);
  assert.equal(down[0], 0); assert.equal(down[6], 255);
  assert.ok(up.slice(1, -1).every((v, i) => v > rows(sample)[0][i + 1]));
  assert.ok(down.slice(1, -1).every((v, i) => v < rows(sample)[0][i + 1]));
  assert.ok(key === 'shadows' ? up[2] - 64 > up[4] - 192 : up[4] - 192 > up[2] - 64,
    `${key} primarily affects its intended tones`);
}
assert.deepEqual(rows(adjustImage(image([[0, 32, 128, 224, 255]]), { blackPoint: 32, whitePoint: 224 })),
  [[0, 0, 128, 255, 255]], 'input levels clip and rescale the full tonal range');
for (const blackPoint of [0, 64, 254]) for (const whitePoint of [1, 192, 255]) {
  for (const contrast of [-100, 0, 100]) for (const lights of [-100, 0, 100]) for (const shadows of [-100, 0, 100]) {
    const values = rows(adjustImage(ramp, { blackPoint, whitePoint, contrast, lights, shadows }))[0];
    assert.ok(values.every((v, i) => i === 0 || v >= values[i - 1]),
      'extreme and crossed settings must not reverse tone order');
  }
}
assert.deepEqual(adjustImage(ramp, { contrast: NaN, lights: Infinity, whitePoint: NaN }), ramp,
  'nonfinite settings fall back to neutral values');
const rgba = { width: 2, height: 1, data: new Uint8ClampedArray([32, 128, 224, 128, 16, 64, 200, 0]) };
const rgbaBefore = rgba.data.slice();
assert.deepEqual([...adjustImage(rgba, { blackPoint: 32, whitePoint: 224 }).data],
  [0, 128, 255, 128, 0, 43, 223, 0], 'adjust RGB independently while preserving alpha');
assert.deepEqual(rgba.data, rgbaBefore, 'preview never mutates the source');

// Run the actual worker handler, including transfer detachment, to check that
// slider updates use the cached original rather than compounding adjustments.
let reply;
const workerSelf = { postMessage(message, transfer) { reply = structuredClone(message, { transfer }); } };
const workerSource = readFileSync(new URL('../static/threshold-worker.js', import.meta.url), 'utf8').replace(/^import .*;\n/, '');
new Function('self', 'adjustImage', 'denoiseImage', 'thresholdImage', workerSource)(workerSelf, adjustImage, denoiseImage, thresholdImage);
function previewRequest(image, adjustments = null, params = {}) {
  workerSelf.onmessage({ data: { id: 1, image, adjustments, params } });
  assert.ok(!reply.error, reply.error);
  return reply;
}
assert.equal(previewRequest(sample).adjusted, null);
const firstPreview = previewRequest(null, { contrast: 50 });
assert.deepEqual(firstPreview.adjusted, adjustImage(sample, { contrast: 50 }));
assert.deepEqual(previewRequest(null, { contrast: 50 }).adjusted, firstPreview.adjusted,
  'transferring a preview must not detach cached pixels');
assert.deepEqual(previewRequest(null, { shadows: 80 }).adjusted, adjustImage(sample, { shadows: 80 }),
  'a new slider value always starts from the original source');
assert.deepEqual(previewRequest(null).image, thresholdImage(denoiseImage(sample), sample.width, sample.height),
  'reset restores thresholding of the original');
const applied = adjustImage(sample, { blackPoint: 60, whitePoint: 180 });
assert.deepEqual(previewRequest(applied).image, thresholdImage(denoiseImage(applied), applied.width, applied.height),
  'applying adjustments invalidates the cached source');
assert.deepEqual(previewRequest(null, DEFAULT_IMAGE_ADJUSTMENTS).adjusted, applied);

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
console.log(`Image editor checks passed: tone adjustments, worker caching, ${fixtures.length} Python preview comparisons, mirroring and undo/redo.`);
