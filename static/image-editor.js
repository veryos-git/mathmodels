/** Pixel operations shared by the image editor, its preview worker and tests. */
export const DEFAULT_IMAGE_ADJUSTMENTS = Object.freeze({
  contrast: 0, lights: 0, shadows: 0, blackPoint: 0, whitePoint: 255,
});

/** Input levels, contrast about middle gray, then smooth shadow/highlight curves.
 * Always read from the unadjusted source so moving a slider never compounds it.
 * A shared RGB lookup table preserves neutral grays and leaves alpha untouched.
 */
export function adjustImage({ data, width, height }, adjustments = {}) {
  const value = (key, min, max) => {
    const n = adjustments[key] ?? DEFAULT_IMAGE_ADJUSTMENTS[key];
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : DEFAULT_IMAGE_ADJUSTMENTS[key];
  };
  const black = value('blackPoint', 0, 254);
  const white = Math.max(black + 1, value('whitePoint', 1, 255));
  const contrast = 2 ** (value('contrast', -100, 100) / 50);
  const shadows = value('shadows', -100, 100) / 100;
  const lights = value('lights', -100, 100) / 100;
  const curve = new Uint8ClampedArray(256);
  for (let i = 0; i < curve.length; i++) {
    const level = Math.max(0, Math.min(1, (i - black) / (white - black)));
    const x = contrast === 1 ? level : Math.max(0, Math.min(1, (level - .5) * contrast + .5));
    // Smooth, monotonic curves with more influence on dark or light tones.
    // Both endpoints of the tonal curve stay fixed.
    curve[i] = Math.round(255 * (x + x * (1 - x) * (shadows * (1 - x) + lights * x)));
  }
  const output = new Uint8ClampedArray(data.length);
  for (let p = 0; p < data.length; p += 4) {
    output[p] = curve[data[p]];
    output[p + 1] = curve[data[p + 1]];
    output[p + 2] = curve[data[p + 2]];
    output[p + 3] = data[p + 3];
  }
  return { data: output, width, height };
}

export function denoiseImage({ data, width, height }) {
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++) {
    const p = i * 4, alpha = data[p + 3] / 255;
    // Match trace.py: composite transparency onto white, then OpenCV RGB gray.
    const r = Math.floor(data[p] * alpha + 255 * (1 - alpha));
    const g = Math.floor(data[p + 1] * alpha + 255 * (1 - alpha));
    const b = Math.floor(data[p + 2] * alpha + 255 * (1 - alpha));
    gray[i] = (r * 9798 + g * 19235 + b * 3735 + 16384) >> 15;
  }
  const result = new Uint8Array(gray.length), window = new Uint8Array(9);
  // A 3×3 median with replicated borders, as in cv2.medianBlur(img, 3).
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const row = Math.max(0, Math.min(height - 1, y + dy)) * width;
        for (let dx = -1; dx <= 1; dx++) {
          const value = gray[row + Math.max(0, Math.min(width - 1, x + dx))];
          let j = n++;
          while (j > 0 && window[j - 1] > value) {
            window[j] = window[j - 1];
            j--;
          }
          window[j] = value;
        }
      }
      result[y * width + x] = window[4];
    }
  }
  return result;
}

// Separable square dilation/erosion. A rolling count keeps each pass linear in
// image size, even with a larger closing radius. Ignore out-of-image pixels,
// matching OpenCV's neutral morphology borders (0 for dilation, 1 for erosion).
function morphAxis(mask, width, height, radius, horizontal, dilate) {
  const output = new Uint8Array(mask.length);
  const length = horizontal ? width : height, lines = horizontal ? height : width;
  const step = horizontal ? 1 : width;
  for (let line = 0; line < lines; line++) {
    const base = horizontal ? line * width : line;
    let count = 0;
    for (let i = 0; i < Math.min(radius, length); i++) count += mask[base + i * step];
    for (let i = 0; i < length; i++) {
      if (i + radius < length) count += mask[base + (i + radius) * step];
      if (i - radius - 1 >= 0) count -= mask[base + (i - radius - 1) * step];
      const samples = Math.min(length - 1, i + radius) - Math.max(0, i - radius) + 1;
      output[base + i * step] = (dilate ? count > 0 : count === samples) ? 1 : 0;
    }
  }
  return output;
}

/** Black pixels are the foreground that will be traced, before skeletonizing. */
export function thresholdImage(gray, width, height, { threshold = 128, invert = false, minArea = 0, closeGaps = 0 } = {}) {
  let mask = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    mask[i] = (invert ? gray[i] > threshold : gray[i] <= threshold) ? 1 : 0;
  }
  const radius = Math.max(0, Math.min(4, Math.trunc(closeGaps)));
  if (radius) {
    for (const dilate of [true, false]) {
      mask = morphAxis(mask, width, height, radius, true, dilate);
      mask = morphAxis(mask, width, height, radius, false, dilate);
    }
  }
  if (minArea > 1) {
    const queue = new Uint32Array(mask.length);
    for (let start = 0; start < mask.length; start++) {
      if (mask[start] !== 1) continue;
      let tail = 1;
      queue[0] = start;
      mask[start] = 2;
      for (let head = 0; head < tail; head++) {
        const index = queue[head], x = index % width, y = Math.floor(index / width);
        for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny++) {
          for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx++) {
            const next = ny * width + nx;
            if (mask[next] === 1) {
              mask[next] = 2;
              queue[tail++] = next;
            }
          }
        }
      }
      if (tail < minArea) for (let i = 0; i < tail; i++) mask[queue[i]] = 0;
    }
  }
  const data = new Uint8ClampedArray(gray.length * 4);
  for (let i = 0; i < gray.length; i++) {
    const value = mask[i] ? 0 : 255, p = i * 4;
    data[p] = data[p + 1] = data[p + 2] = value;
    data[p + 3] = 255;
  }
  return { data, width, height };
}

export function lineSide([x, y], a, b) {
  return (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
}

/** Reflect pixel centres in an arbitrary line; null side flips the whole image.
 * Otherwise preserve the selected half and copy it onto the opposite half.
 * The canvas size stays fixed; reflected samples outside it become white.
 */
export function mirrorImage({ data, width, height }, a, b, sourceSide = null) {
  const dx = b[0] - a[0], dy = b[1] - a[1], length2 = dx * dx + dy * dy;
  if (length2 < 1e-8) throw new Error('Choose two different points for the mirror line.');
  if (sourceSide !== null && sourceSide !== -1 && sourceSide !== 1) {
    throw new Error('Choose a side of the mirror line to copy.');
  }
  const output = new Uint8ClampedArray(data);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const side = dx * (y + .5 - a[1]) - dy * (x + .5 - a[0]);
      if (sourceSide !== null && side * sourceSide >= 0) continue;
      const sx = Math.floor(x + .5 + 2 * dy * side / length2);
      const sy = Math.floor(y + .5 - 2 * dx * side / length2);
      const dst = (y * width + x) * 4;
      if (sx < 0 || sy < 0 || sx >= width || sy >= height) {
        output.fill(255, dst, dst + 4);
      } else {
        const src = (sy * width + sx) * 4;
        for (let c = 0; c < 4; c++) output[dst + c] = data[src + c];
      }
    }
  }
  return { data: output, width, height };
}

/** Bounded full-image undo history. Call remember before a committed edit. */
export class ImageHistory {
  constructor(maxBytes = 64 * 1024 * 1024, maxSteps = 20) {
    this.maxBytes = maxBytes;
    this.maxSteps = maxSteps;
    this.clear();
  }
  clear() { this.undoStack = []; this.redoStack = []; }
  remember(image) {
    this.redoStack = [];
    this.undoStack.push(image);
    let bytes = this.undoStack.reduce((sum, item) => sum + item.data.byteLength, 0);
    while (this.undoStack.length > 1 && (bytes > this.maxBytes || this.undoStack.length > this.maxSteps)) {
      bytes -= this.undoStack.shift().data.byteLength;
    }
  }
  undo(current) {
    if (!this.undoStack.length) return null;
    this.redoStack.push(current);
    return this.undoStack.pop();
  }
  redo(current) {
    if (!this.redoStack.length) return null;
    this.undoStack.push(current);
    return this.redoStack.pop();
  }
}
