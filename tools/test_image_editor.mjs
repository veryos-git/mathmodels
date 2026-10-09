import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const source = readFileSync(new URL('../static/image-editor.js', import.meta.url), 'utf8');
const { adjustImage, compositeLineArt, DEFAULT_IMAGE_ADJUSTMENTS, denoiseImage, thresholdImage, mirrorImage, lineSide, ImageHistory } =
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
new Function('self', 'adjustImage', 'compositeLineArt', 'denoiseImage', 'thresholdImage', workerSource)(workerSelf, adjustImage, compositeLineArt, denoiseImage, thresholdImage);
function previewRequest(image, adjustments = null, params = {}, templates) {
  workerSelf.onmessage({ data: { id: 1, image, adjustments, params, templates } });
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
// Off-centre lines expand in every direction and preserve the original bounds.
const bounds = ({ width, height, offsetX, offsetY }) => [width, height, offsetX, offsetY];
const extended = mirrorImage(original, [1, 0], [1, 2]);
assert.deepEqual(bounds(extended), [6, 2, 2, 0]);
assert.deepEqual(rows(extended), [[40, 30, 20, 10, 255, 255], [80, 70, 60, 50, 255, 255]]);
assert.deepEqual(rows(mirrorImage(original, [3, 0], [3, 2])),
  [[255, 255, 40, 30, 20, 10], [255, 255, 80, 70, 60, 50]]);
assert.deepEqual(rows(mirrorImage(original, [0, .5], [4, .5])),
  [[50, 60, 70, 80], [10, 20, 30, 40], [255, 255, 255, 255]]);
assert.deepEqual(rows(mirrorImage(original, [0, 1.5], [4, 1.5])),
  [[255, 255, 255, 255], [50, 60, 70, 80], [10, 20, 30, 40]]);
// Only the selected half contributes mirrored content and expanded bounds.
assert.deepEqual(rows(mirrorImage(original, [1, 0], [1, 2], -1)),
  [[40, 30, 20, 20, 30, 40], [80, 70, 60, 60, 70, 80]]);
assert.deepEqual(bounds(mirrorImage(original, [1, 0], [1, 2], 1)), [4, 2, 0, 0]);
assert.deepEqual(rows(mirrorImage(original, [1, 0], [1, 2], 1)),
  [[10, 10, 255, 255], [50, 50, 255, 255]]);
assert.deepEqual(rows(mirrorImage(original, [3, 0], [3, 2], 1)),
  [[10, 20, 30, 30, 20, 10], [50, 60, 70, 70, 60, 50]]);
assert.deepEqual(rows(mirrorImage(original, [0, .5], [4, .5], 1)),
  [[50, 60, 70, 80], [10, 20, 30, 40], [50, 60, 70, 80]]);
assert.deepEqual(rows(mirrorImage(original, [0, 1.5], [4, 1.5], -1)),
  [[10, 20, 30, 40], [50, 60, 70, 80], [10, 20, 30, 40]]);
assert.deepEqual(bounds(mirrorImage(original, [0, 0], [0, 2], -1)), [8, 2, 4, 0]);
assert.deepEqual(rows(mirrorImage(original, [0, 0], [0, 2], -1)),
  [[40, 30, 20, 10, 10, 20, 30, 40], [80, 70, 60, 50, 50, 60, 70, 80]]);
assert.deepEqual(mirrorImage(original, [1, 0], [1, 2], -1), mirrorImage(original, [1, 2], [1, 0], 1),
  'reversing the line and selected side preserves bounds and pixels');
const rectangle = image([[1, 2, 3, 4, 5], [6, 7, 8, 9, 10], [11, 12, 13, 14, 15]]);
const tilted = mirrorImage(rectangle, [0, 0], [4, 2]);
assert.deepEqual(bounds(tilted), [6, 6, 0, 2], 'slanted reflection rounds expanded edges outwards');
assert.deepEqual(bounds(mirrorImage(rectangle, [0, 0], [4, 2], 1)), [6, 5, 0, 2],
  'copying below a slanted line expands above and to the right');
assert.deepEqual(bounds(mirrorImage(rectangle, [0, 0], [4, 2], -1)), [5, 4, 0, 0],
  'copying above a slanted line only expands below');
assert.equal(rows(tilted)[2][3], 13); // (3.5, .5) reflects to (2.5, 2.5).
assert.equal(rows(tilted)[4][0], 255);
assert.equal(rows(tilted)[0][2], 11, 'keep reflected content above the original');
assert.equal(rows(tilted)[5][3], 5, 'keep reflected content below the original');
assert.deepEqual(bounds(mirrorImage(original, [.2, .1], [2.6, 1.3])), [4, 6, 0, 2],
  'fractional line coordinates do not add padding at exact integer bounds');
assert.deepEqual([...original.data], before, 'mirror preview must not modify its source');
assert.throws(() => mirrorImage(original, [1, 1], [1, 1]), /different points/);
assert.throws(() => mirrorImage(original, [1, 0], [1, 1], 0), /Choose a side/);
assert.equal(Math.sign(lineSide([0, 1], [2, 0], [2, 2])), 1);
const colored = { width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 80, 240, 128]) };
assert.deepEqual([...mirrorImage(colored, [1, 0], [1, 1]).data], [0, 80, 240, 128, 255, 0, 0, 255]);
assert.deepEqual([...mirrorImage(colored, [0, 0], [0, 1], -1).data],
  [0, 80, 240, 128, 255, 0, 0, 255, 255, 0, 0, 255, 0, 80, 240, 128],
  'expansion preserves all RGBA channels');
assert.deepEqual(previewRequest(extended).image,
  thresholdImage(denoiseImage(extended), extended.width, extended.height),
  'the threshold worker accepts expanded previews and invalidates its cached dimensions');

const history = new ImageHistory(original.data.byteLength * 2);
history.remember(original);
assert.equal(history.undo(extended), original, 'undo restores the original dimensions and pixels');
assert.equal(history.redo(original), extended, 'redo restores the expanded dimensions and pixels');
history.clear();
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
const base = image([[160, 100, 200, 80]]), ink = image([[255, 0, 0, 128]]);
ink.data[2 * 4 + 3] = 128;
assert.deepEqual(rows(compositeLineArt(base, ink)), [[160, 0, 100, 40]],
  'white paper preserves the base, black draws over it, and alpha blends ink');
assert.deepEqual(rows(base), [[160, 100, 200, 80]], 'template compositing never changes the painted image');
assert.throws(() => compositeLineArt(base, original), /dimensions/);
const withInk = previewRequest(base, { contrast: 50 }, {}, ink);
assert.deepEqual(withInk.adjusted, adjustImage(base, { contrast: 50 }), 'applying tone adjustments must not bake in templates');
assert.deepEqual(withInk.image, thresholdImage(denoiseImage(compositeLineArt(withInk.adjusted, ink)), 4, 1));
assert.deepEqual(previewRequest(null).image, thresholdImage(denoiseImage(compositeLineArt(base, ink)), 4, 1),
  'cached templates remain present when parameters change');
assert.deepEqual(previewRequest(null, null, {}, null).image, thresholdImage(denoiseImage(base), 4, 1),
  'deleting the last template removes its pixels from the preview cache');

const templateSource = readFileSync(new URL('../static/lineart-templates.js', import.meta.url), 'utf8');
const { LineArtTemplates, templatePoint, templateLocalPoint, templateHandles, hitTemplate, transformTemplate } =
  await import(`data:text/javascript;base64,${Buffer.from(templateSource).toString('base64')}`);
const layer = { id: 'a', x: 100, y: 70, width: 40, height: 20, rotation: 90 };
const near = (actual, expected) => actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-8));
near(templatePoint(layer, 20, 10), [90, 90]);
near(templateLocalPoint(layer, [90, 90]), [20, 10]);
assert.equal(hitTemplate([layer], null, [100, 70], 2).kind, 'move');
assert.equal(hitTemplate([layer], null, [121, 70], 2), null, 'hit testing follows rotated bounds');
assert.equal(hitTemplate([layer, { ...layer, id: 'b' }], null, [100, 70], 2).layer.id, 'b', 'topmost template wins');
assert.equal(hitTemplate([layer], 'a', templateHandles(layer, 8)[4].point, 2).kind, 'rotate');
const resized = transformTemplate(layer, { kind: 'resize', sx: 1, sy: 1 }, templatePoint(layer, 60, 30));
near([resized.width, resized.height], [80, 40]);
near(templatePoint(resized, -40, -20), templatePoint(layer, -20, -10));
const rotated = transformTemplate(layer, { kind: 'rotate', start: [110, 70] }, [100, 80]);
assert.equal(rotated.rotation, 180);
const moved = transformTemplate(layer, { kind: 'move', start: [110, 70] }, [115, 85]);
near([moved.x, moved.y], [105, 85]);
const templates = new LineArtTemplates(), src = 'data:image/png;base64,dGVzdA==';
templates.assets.set(src, { naturalWidth: 40, naturalHeight: 20 });
templates.restore([{ ...layer, src, name: 'test' }]);
const saved = templates.snapshot();
templates.items[0].x = 999;
assert.equal(saved[0].x, 100, 'saved template placements are independent snapshots');
assert.ok(!('image' in saved[0]), 'saved templates contain portable data, not browser objects');
templates.restore(JSON.parse(JSON.stringify(saved)));
assert.equal(templates.items[0].x, 100);
assert.throws(() => templates.restore([{ ...saved[0], width: -1 }]), /Invalid saved template/);
await assert.rejects(() => templates.asset('https://example.com/image.svg'), /embedded SVG or PNG/);
console.log(`Image editor checks passed: adjustments, templates, worker caching, ${fixtures.length} Python preview comparisons, mirroring and undo/redo.`);
