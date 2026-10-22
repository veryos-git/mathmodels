// Match tools/lighter.py: 128 segments, 0.05 mm seam overlap, 0.05 mm embed.
// The relief is mapped around the lighter's ellipse perimeter by arc length,
// so the ellipse math here must mirror tools/lighter.py exactly.
export const LIGHTER_SEGMENTS = 128;
export const LIGHTER_SEAM_OVERLAP = 0.05;
export const LIGHTER_EMBED = 0.05;
export const LIGHTER_MAX_REPEAT = 12;

// Seam position per vertex, as degrees around the perimeter. Matches
// VERTEX_DEG in tools/lighter.py: V1 = +a right, V2 = -a left, V3 = +b top,
// V4 = -b bottom. The vertices quarter the perimeter, so 90° steps a vertex.
export const LIGHTER_VERTEX_DEG = { 1: 0, 2: 180, 3: 90, 4: 270 };

/** Seam position as a fraction of the perimeter, from the start controls. */
export function lighterStart(settings) {
  const base = LIGHTER_VERTEX_DEG[settings?.startVertex] ?? 0;
  const deg = base + (Number(settings?.startOffset) || 0);
  return ((deg / 360) % 1 + 1) % 1;
}

// ---------------------------------------------------------------------------
// Geometry helpers

function clip(poly, axis, value, greater) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const da = (a[axis] - value) * (greater ? 1 : -1);
    const db = (b[axis] - value) * (greater ? 1 : -1);
    if (da >= 0) out.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db);
      const p = a.map((v, k) => v + t * (b[k] - v));
      p[axis] = value;
      out.push(p);
    }
  }
  return out;
}

/** Invert arc length s to an ellipse angle via the info lookup table. */
function thetaAtArc(info, s) {
  const { arclen, theta } = info;
  const n = arclen.length;
  // arclen is monotonic increasing from 0 to the perimeter; binary search.
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arclen[mid] <= s) lo = mid; else hi = mid;
  }
  const span = arclen[hi] - arclen[lo];
  const f = span > 1e-12 ? (s - arclen[lo]) / span : 0;
  return theta[lo] + f * (theta[hi] - theta[lo]);
}

/** Ellipse point and outward unit normal at a loop fraction (taken mod 1). */
function ellipsePoint(info, frac) {
  const { a, b, perimeter } = info;
  const wrapped = ((frac % 1) + 1) % 1;
  const t = thetaAtArc(info, wrapped * perimeter);
  const ct = Math.cos(t), st = Math.sin(t);
  let nx = ct / a, ny = st / b;
  const norm = Math.hypot(nx, ny);
  return [a * ct, b * st, nx / norm, ny / norm];
}

// ---------------------------------------------------------------------------
// Wrapping

/**
 * Map a single flat point [x, y, z] onto the lighter's elliptical body.
 *
 * bounds = [x0, y0, x1, y1] is the TOTAL flat extent covering all repeats.
 * y = 0 maps to case z = z0; y = (y1-y0) maps to z = z1 (the straight body
 * section between the chamfers). z is the relief height (outward).
 *
 * `seam` stretches the loop so its ends overlap; it is 0 for sketch repeats,
 * whose periodic columns already meet after exactly one loop.
 */
export function wrapLighterPoint([x, y, z], bounds, info, seam = LIGHTER_SEAM_OVERLAP) {
  const [x0, y0, x1, y1] = bounds;
  const { z0, body_height, perimeter } = info;
  const start = info.start ?? 0;
  const frac = ((x - x0) / (x1 - x0) - 0.5) * (perimeter + seam) / perimeter + 0.5 + start;
  const [px, py, nx, ny] = ellipsePoint(info, frac);
  const depth = z - LIGHTER_EMBED;
  const zRing = z0 + (y - y0) / (y1 - y0) * body_height;
  return [px + depth * nx, py + depth * ny, zRing];
}

// The flat strip that wraps once and where each copy of the artwork sits in it.
function lighterLayout(bounds, repeatX, tiling) {
  if (tiling) {
    const [px] = tiling.period;
    return { bounds: tiling.bounds, copies: Array.from({ length: tiling.repeatX }, (_, i) => px * i) };
  }
  const width = bounds[2] - bounds[0];
  return { bounds: [bounds[0], bounds[1], bounds[0] + repeatX * width, bounds[3]],
           copies: Array.from({ length: repeatX }, (_, i) => width * i) };
}

/**
 * Wrap flat triangle positions onto the lighter's elliptical body.
 *
 * positions — flat array, 9 values per triangle (x,y,z × 3) for ONE copy.
 * bounds — [x0, y0, x1, y1] flat extent of that one copy.
 */
export function wrapLighterTriangles(positions, bounds, info, { tiling = null, repeatX = 1 } = {}) {
  if (bounds.some(v => !Number.isFinite(v)) || bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) {
    throw new Error('The drawing needs a positive width and height to wrap.');
  }
  const layout = lighterLayout(bounds, repeatX, tiling);
  const [x0,, x1] = layout.bounds;
  const turn = x1 - x0;
  const dx = turn / LIGHTER_SEGMENTS;
  const seam = tiling ? 0 : LIGHTER_SEAM_OVERLAP;
  const result = [];
  for (const ox of layout.copies) for (let i = 0; i < positions.length; i += 9) {
    const placed = [
      [positions[i]   + ox, positions[i+1], positions[i+2]],
      [positions[i+3] + ox, positions[i+4], positions[i+5]],
      [positions[i+6] + ox, positions[i+7], positions[i+8]],
    ];
    const shifts = [0];
    if (tiling && Math.min(...placed.map(p => p[0])) < x0) shifts.push(turn);
    if (tiling && Math.max(...placed.map(p => p[0])) > x1) shifts.push(-turn);
    for (const shift of shifts) {
      const tri = shift ? placed.map(([x, y, z]) => [x + shift, y, z]) : placed;
      const minX = Math.min(...tri.map(p => p[0]));
      const maxX = Math.max(...tri.map(p => p[0]));
      const first = Math.max(0, Math.floor((minX - x0) / dx));
      const last = Math.min(LIGHTER_SEGMENTS - 1, Math.floor((maxX - x0) / dx));
      for (let s = first; s <= last; s++) {
        const strip = clip(clip(tri, 0, x0 + s * dx, true), 0, x0 + (s + 1) * dx, false);
        if (strip.length < 3) continue;
        const pts = strip.map(p => wrapLighterPoint(p, layout.bounds, info, seam));
        for (let k = 1; k < pts.length - 1; k++) {
          result.push(...pts[0], ...pts[k], ...pts[k + 1]);
        }
      }
    }
  }
  return new Float32Array(result);
}

// ---------------------------------------------------------------------------
// Fitting suggestions (mirror of ringFit / ringSuggestions)

/**
 * How well `repeatX` copies of the artwork (width × height in flat coords) fit
 * the lighter's elliptical body: perimeter around, body_height up.
 */
export function lighterFit(tileBounds, info, repeatX) {
  const [x0, y0, x1, y1] = tileBounds;
  const W = x1 - x0, A = y1 - y0;
  if (!(W > 0 && A > 0)) return null;
  if (!Number.isInteger(repeatX) || repeatX < 1 || repeatX > LIGHTER_MAX_REPEAT) return null;

  const C = info.perimeter;         // outer perimeter
  const H = info.body_height;       // wrappable height (fixed by the case)
  if (!(C > 0 && H > 0)) return null;

  const widthPerCopy = C / repeatX;
  const a = W / widthPerCopy, b = A / H;
  const scale = (a + b) / (a * a + b * b);
  if (!Number.isFinite(scale) || scale <= 0) return null;

  const error = Math.hypot(scale * W / widthPerCopy - 1, scale * A / H - 1);
  return { repeatX, scale, widthOnLighter: widthPerCopy, heightOnLighter: H, error };
}

/** Up to `limit` fitting suggestions, sorted by ascending error. */
export function lighterSuggestions(tileBounds, info, limit = 10) {
  const fits = [];
  for (let n = 1; n <= LIGHTER_MAX_REPEAT; n++) {
    const fit = lighterFit(tileBounds, info, n);
    if (fit) fits.push(fit);
  }
  fits.sort((a, b) => a.error - b.error || a.repeatX - b.repeatX);
  return fits.slice(0, limit);
}
