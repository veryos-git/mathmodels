/** Looping GIF89a encoder for rendered animation frames.
 *
 * Two passes: sample() a few representative RGBA frames to build one shared
 * 255-colour palette, then addFrame() every frame in order. A shared palette
 * keeps colours from flickering between frames; index 255 stays transparent so
 * each frame after the first only stores the pixels that changed. */

const BITS = 6; // histogram and lookup precision per channel
const BINS = 1 << (3 * BITS);
const TRANSPARENT = 255;
const SAMPLE_PIXELS = 1 << 20; // per sampled frame; larger frames are subsampled
const bin = (r, g, b) => (r >> 8 - BITS) << 2 * BITS | (g >> 8 - BITS) << BITS | b >> 8 - BITS;
const ascii = text => [...text].map(c => c.charCodeAt(0));

class ByteWriter {
  constructor() { this.parts = []; this.buffer = new Uint8Array(1 << 20); this.length = 0; this.total = 0; }
  reserve(n) {
    if (this.length + n <= this.buffer.length) return;
    this.flush();
    if (n > this.buffer.length) this.buffer = new Uint8Array(n);
  }
  byte(value) { this.reserve(1); this.buffer[this.length++] = value; this.total++; }
  word(value) { this.byte(value & 255); this.byte(value >> 8 & 255); }
  bytes(values) {
    this.reserve(values.length);
    this.buffer.set(values, this.length);
    this.length += values.length; this.total += values.length;
  }
  flush() {
    if (this.length) this.parts.push(this.buffer.slice(0, this.length));
    this.length = 0;
  }
  take() { this.flush(); const parts = this.parts; this.parts = []; return parts; }
}

/** Splits the colour histogram greedily, always cutting the box with the largest
 * squared error where the two halves have the least combined error. */
export function buildPalette(counts, sums, maxColors = 255) {
  let n = 0;
  for (let i = 0; i < counts.length; i++) if (counts[i]) n++;
  const order = new Int32Array(n), weight = new Float64Array(n), mean = new Float64Array(3 * n);
  for (let i = 0, j = 0; i < counts.length; i++) {
    if (!counts[i]) continue;
    order[j] = j; weight[j] = counts[i];
    for (let c = 0; c < 3; c++) mean[3 * j + c] = sums[3 * i + c] / counts[i];
    j++;
  }
  const box = (start, end) => {
    let w = 0; const s = [0, 0, 0], sq = [0, 0, 0];
    for (let i = start; i < end; i++) {
      const p = order[i], pw = weight[p];
      w += pw;
      for (let c = 0; c < 3; c++) {
        const v = mean[3 * p + c];
        s[c] += pw * v; sq[c] += pw * v * v;
      }
    }
    const spread = sq.map((value, c) => value - s[c] * s[c] / w);
    const error = end - start > 1 ? spread[0] + spread[1] + spread[2] : 0;
    return { start, end, w, s, error, axis: spread.indexOf(Math.max(...spread)) };
  };
  const boxes = n ? [box(0, n)] : [];
  while (boxes.length < maxColors) {
    let worst = -1;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].error > 0 && (worst < 0 || boxes[i].error > boxes[worst].error)) worst = i;
    }
    if (worst < 0) break;
    const { start, end, axis, w: total, s: totals } = boxes[worst];
    order.subarray(start, end).sort((a, b) => mean[3 * a + axis] - mean[3 * b + axis]);
    // A half's error is its sum of squares minus |S|²/w, so the best cut
    // maximises |S_left|²/w_left + |S_right|²/w_right.
    let cut = start + 1, bestScore = -Infinity, w = 0; const s = [0, 0, 0];
    for (let i = start; i < end - 1; i++) {
      const p = order[i];
      w += weight[p];
      let score = 0;
      for (let c = 0; c < 3; c++) {
        s[c] += weight[p] * mean[3 * p + c];
        score += s[c] * s[c] / w + (totals[c] - s[c]) ** 2 / (total - w);
      }
      if (score > bestScore) { bestScore = score; cut = i + 1; }
    }
    boxes.splice(worst, 1, box(start, cut), box(cut, end));
  }
  const palette = new Uint8Array(3 * boxes.length);
  boxes.forEach(({ s, w }, i) => {
    for (let c = 0; c < 3; c++) palette[3 * i + c] = Math.round(s[c] / w);
  });
  return palette;
}

export class GifEncoder {
  constructor(width, height) {
    if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width < 65536 && height < 65536)) {
      throw new Error('GIF frames must be 1–65535 pixels wide and high.');
    }
    this.width = width; this.height = height;
    this.counts = new Uint32Array(BINS);
    this.sums = new Float64Array(3 * BINS);
    this.out = new ByteWriter();
    this.frames = 0;
  }

  /** Adds a top-down RGBA frame to the colour histogram. */
  sample(rgba) {
    if (this.palette) throw new Error('Sample frames before adding the first frame.');
    this.check(rgba);
    const { counts, sums } = this, pixels = rgba.length / 4;
    // An odd stride never lines up with whole rows, so subsampling stays spread out.
    const stride = 4 * (Math.floor(pixels / SAMPLE_PIXELS) | 1);
    for (let i = 0; i < rgba.length; i += stride) {
      const key = bin(rgba[i], rgba[i + 1], rgba[i + 2]);
      counts[key]++;
      sums[3 * key] += rgba[i]; sums[3 * key + 1] += rgba[i + 1]; sums[3 * key + 2] += rgba[i + 2];
    }
  }

  /** Appends a top-down RGBA frame shown for delay hundredths of a second. */
  addFrame(rgba, delay) {
    this.check(rgba);
    if (!this.palette) this.start(rgba);
    const { width, height, lookup } = this, previous = this.frames ? this.indices : null;
    const indices = this.frames ? this.spare : this.indices;
    for (let i = 0, p = 0; p < indices.length; i += 4, p++) {
      const key = bin(rgba[i], rgba[i + 1], rgba[i + 2]);
      let index = lookup[key];
      if (index < 0) index = lookup[key] = this.nearest(key);
      indices[p] = index;
    }
    // Only the rectangle that changed is stored; unchanged pixels inside it are
    // transparent and leave the previous frame showing through.
    let left = 0, top = 0, right = width - 1, bottom = height - 1, pixels = indices;
    if (previous) {
      left = width; top = height; right = bottom = -1;
      for (let y = 0, p = 0; y < height; y++) {
        for (let x = 0; x < width; x++, p++) {
          if (indices[p] === previous[p]) continue;
          if (x < left) left = x;
          if (x > right) right = x;
          if (y < top) top = y;
          bottom = y;
        }
      }
      if (right < 0) left = right = top = bottom = 0; // identical frame: one transparent pixel
      const w = right - left + 1, h = bottom - top + 1;
      pixels = this.rect.subarray(0, w * h);
      for (let y = 0, q = 0; y < h; y++) {
        for (let x = 0, p = (top + y) * width + left; x < w; x++, p++, q++) {
          pixels[q] = indices[p] === previous[p] ? TRANSPARENT : indices[p];
        }
      }
      this.spare = previous; this.indices = indices;
    }
    const out = this.out;
    out.bytes([0x21, 0xf9, 4, 1 << 2 | (previous ? 1 : 0)]); // keep previous frame; transparency
    out.word(Math.max(2, Math.round(delay)));
    out.bytes([TRANSPARENT, 0, 0x2c]);
    out.word(left); out.word(top); out.word(right - left + 1); out.word(bottom - top + 1);
    out.byte(0);
    this.compress(pixels);
    this.frames++;
  }

  /** Bytes written since the last call, as Blob parts. */
  take() { return this.out.take(); }

  /** Ends the file and returns its remaining bytes as Blob parts. */
  finish() {
    if (!this.frames) throw new Error('Add at least one frame before finishing the GIF.');
    this.out.byte(0x3b);
    this.indices = this.spare = this.rect = this.raw = this.table = null;
    return this.out.take();
  }

  /** Total bytes written so far. */
  get size() { return this.out.total; }

  check(rgba) {
    if (rgba?.length !== this.width * this.height * 4) throw new Error('Frame size does not match the GIF size.');
  }

  start(rgba) {
    if (!this.counts.some(Boolean)) this.sample(rgba);
    this.palette = buildPalette(this.counts, this.sums, 255);
    this.counts = this.sums = null;
    this.lookup = new Int16Array(BINS).fill(-1);
    const pixels = this.width * this.height;
    this.indices = new Uint8Array(pixels); this.spare = new Uint8Array(pixels); this.rect = new Uint8Array(pixels);
    // Worst case: one 12-bit code per pixel, plus clear codes and the end code.
    this.raw = new Uint8Array(Math.ceil(pixels * 1.51) + 16);
    this.table = new Int16Array(4096 << 8);
    this.used = new Int32Array(4096);
    const out = this.out;
    out.bytes(ascii('GIF89a'));
    out.word(this.width); out.word(this.height);
    out.bytes([0xf7, 0, 0]); // 256-entry global colour table
    const table = new Uint8Array(768);
    table.set(this.palette);
    out.bytes(table);
    out.bytes([0x21, 0xff, 11, ...ascii('NETSCAPE2.0'), 3, 1, 0, 0, 0]); // loop forever
  }

  nearest(key) {
    const step = 1 << 8 - BITS, mask = (1 << BITS) - 1, half = step / 2;
    const r = (key >> 2 * BITS) * step + half, g = (key >> BITS & mask) * step + half, b = (key & mask) * step + half;
    const palette = this.palette;
    let best = 0, bestDistance = Infinity;
    for (let i = 0; i < palette.length; i += 3) {
      const distance = (palette[i] - r) ** 2 + (palette[i + 1] - g) ** 2 + (palette[i + 2] - b) ** 2;
      if (distance < bestDistance) { bestDistance = distance; best = i / 3; }
    }
    return best;
  }

  /** Variable-length LZW with 8-bit roots, written as 255-byte sub-blocks. */
  compress(pixels) {
    const { out, raw, table, used } = this, clear = 256, end = 257;
    let size = 9, next = 258, count = 0, acc = 0, bits = 0, length = 0;
    const emit = code => {
      acc |= code << bits; bits += size;
      while (bits >= 8) { raw[length++] = acc & 255; acc >>>= 8; bits -= 8; }
    };
    const reset = () => {
      for (let i = 0; i < count; i++) table[used[i]] = 0;
      count = 0; size = 9; next = 258;
    };
    emit(clear);
    let prefix = pixels[0];
    for (let i = 1; i < pixels.length; i++) {
      const k = pixels[i], key = prefix << 8 | k, code = table[key];
      if (code) { prefix = code; continue; }
      emit(prefix);
      if (next < 4096) {
        table[key] = next++; used[count++] = key;
        if (next > 1 << size) size++;
      } else {
        emit(clear); reset();
      }
      prefix = k;
    }
    emit(prefix);
    // The decoder adds its entry for the last code before it reads the end code.
    if (next === 1 << size && size < 12) size++;
    emit(end);
    if (bits) raw[length++] = acc & 255;
    reset();
    out.byte(8);
    for (let i = 0; i < length; i += 255) {
      const n = Math.min(255, length - i);
      out.byte(n); out.bytes(raw.subarray(i, i + n));
    }
    out.byte(0);
  }
}
