import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GifEncoder, buildPalette } from '../static/gif-encoder.js';

/** Minimal GIF decoder: global palette, transparency, "keep" disposal, LZW. */
function decodeGif(bytes) {
  let at = 0;
  const byte = () => bytes[at++], word = () => bytes[at++] | bytes[at++] << 8;
  assert.equal(String.fromCharCode(...bytes.subarray(0, 6)), 'GIF89a');
  at = 6;
  const width = word(), height = word(), packed = byte();
  at += 2;
  const palette = bytes.subarray(at, at += 3 << (packed & 7) + 1);
  const canvas = new Uint8Array(width * height * 3), frames = [];
  let transparent = -1, delay = 0, loop = null;
  for (;;) {
    const block = byte();
    if (block === 0x3b) break;
    if (block === 0x21) {
      const label = byte();
      const data = [];
      for (let n = byte(); n; n = byte()) data.push(...bytes.subarray(at, at += n));
      if (label === 0xf9) { transparent = data[0] & 1 ? data[3] : -1; delay = data[1] | data[2] << 8; }
      if (label === 0xff) loop = data[12] | data[13] << 8;
      continue;
    }
    assert.equal(block, 0x2c);
    const left = word(), top = word(), w = word(), h = word();
    assert.equal(byte() & 0x80, 0, 'no local colour tables');
    const min = byte(), data = [];
    for (let n = byte(); n; n = byte()) data.push(...bytes.subarray(at, at += n));
    const clear = 1 << min, end = clear + 1, out = [];
    let size = min + 1, dict = [], previous = null, acc = 0, bits = 0, i = 0;
    const reset = () => { dict = Array.from({ length: clear + 2 }, (_, k) => [k]); size = min + 1; previous = null; };
    reset();
    for (;;) {
      while (bits < size) { acc |= data[i++] << bits; bits += 8; }
      const code = acc & (1 << size) - 1;
      acc >>>= size; bits -= size;
      if (code === clear) { reset(); continue; }
      if (code === end) break;
      const entry = code < dict.length ? dict[code] : [...previous, previous[0]];
      out.push(...entry);
      if (previous && dict.length < 4096) dict.push([...previous, entry[0]]);
      if (dict.length === 1 << size && size < 12) size++;
      previous = entry;
    }
    assert.equal(out.length, w * h);
    out.forEach((index, p) => {
      if (index === transparent) return;
      const q = 3 * ((top + Math.floor(p / w)) * width + left + p % w);
      canvas.set(palette.subarray(3 * index, 3 * index + 3), q);
    });
    frames.push({ rgb: canvas.slice(), rect: [left, top, w, h], delay });
  }
  return { width, height, loop, frames };
}

const bytesOf = async parts => new Uint8Array(await new Blob(parts).arrayBuffer());
const rgbOf = rgba => rgba.filter((_, i) => i % 4 !== 3);

test('Frames with few colours decode exactly, as a looping animation of changed rectangles', async () => {
  const w = 37, h = 23;
  // Colours sit at histogram bin centres, so the palette reproduces them exactly.
  const colour = n => [(n * 52 % 64) * 4 + 2, (n * 23 % 64) * 4 + 2, (n * 11 % 64) * 4 + 2, 255];
  const frame = shift => {
    const rgba = new Uint8Array(w * h * 4);
    for (let p = 0; p < w * h; p++) {
      const x = p % w, y = Math.floor(p / w);
      rgba.set(colour(x > 10 && x < 20 && y > shift && y < shift + 5 ? 200 : (x + 3 * y) % 150), 4 * p);
    }
    return rgba;
  };
  const frames = [frame(2), frame(6), frame(6), frame(2)];
  const encoder = new GifEncoder(w, h);
  frames.forEach(f => encoder.sample(f));
  const parts = [];
  for (const f of frames) { encoder.addFrame(f, 5); parts.push(...encoder.take()); }
  const gif = decodeGif(await bytesOf([...parts, ...encoder.finish()]));
  assert.equal(gif.loop, 0, 'loops forever');
  assert.deepEqual([gif.width, gif.height, gif.frames.length], [w, h, 4]);
  gif.frames.forEach((decoded, i) => assert.deepEqual(decoded.rgb, rgbOf(frames[i]), `frame ${i}`));
  assert.deepEqual(gif.frames[0].rect, [0, 0, w, h]);
  assert.deepEqual(gif.frames[1].rect, [11, 3, 9, 8], 'only the moved bar is stored');
  assert.deepEqual(gif.frames[2].rect, [0, 0, 1, 1], 'a repeated frame stores one transparent pixel');
  assert(gif.frames.every(f => f.delay === 5));
});

test('Noisy frames survive LZW dictionary resets and code-size changes', async () => {
  const w = 211, h = 97;
  let seed = 7;
  const random = () => (seed = seed * 16807 % 2147483647) % 256;
  const rgba = new Uint8Array(w * h * 4).map((_, i) => i % 4 === 3 ? 255 : random());
  const encoder = new GifEncoder(w, h);
  encoder.addFrame(rgba, 4); // without samples, the first frame builds the palette
  const gif = decodeGif(await bytesOf(encoder.finish()));
  const palette = encoder.palette;
  let worst = 0;
  for (let p = 0; p < w * h; p++) {
    const got = gif.frames[0].rgb.subarray(3 * p, 3 * p + 3);
    assert(palette.some((_, i) => i % 3 === 0 && palette[i] === got[0] && palette[i + 1] === got[1] && palette[i + 2] === got[2]));
    worst = Math.max(worst, Math.hypot(got[0] - rgba[4 * p], got[1] - rgba[4 * p + 1], got[2] - rgba[4 * p + 2]));
  }
  assert(worst < 120, `random colours map to a nearby palette entry (worst ${worst})`);
});

test('Smooth gradients keep fine steps with a 255-colour palette', () => {
  const counts = new Uint32Array(1 << 18), sums = new Float64Array(3 << 18);
  for (let v = 0; v < 256; v++) {
    for (const [r, g, b] of [[v, v * .76, 0], [v, v, v]]) {
      const key = (r >> 2) << 12 | (g >> 2) << 6 | b >> 2;
      counts[key]++; sums[3 * key] += r; sums[3 * key + 1] += g; sums[3 * key + 2] += b;
    }
  }
  const palette = buildPalette(counts, sums, 255);
  assert(palette.length / 3 <= 255);
  for (let v = 0; v < 256; v += 3) {
    let best = Infinity;
    for (let i = 0; i < palette.length; i += 3) best = Math.min(best, Math.hypot(palette[i] - v, palette[i + 1] - v * .76, palette[i + 2]));
    assert(best < 6, `amber level ${v} is within ${best.toFixed(1)}`);
  }
});

test('Mismatched frames and empty animations are rejected', () => {
  assert.throws(() => new GifEncoder(0, 10));
  assert.throws(() => new GifEncoder(70000, 10));
  const encoder = new GifEncoder(4, 4);
  assert.throws(() => encoder.addFrame(new Uint8Array(12), 5), /size/);
  assert.throws(() => encoder.finish(), /at least one frame/);
  encoder.addFrame(new Uint8Array(64), 5);
  assert.throws(() => encoder.sample(new Uint8Array(64)), /before adding/);
});
