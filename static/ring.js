// Match tools/ring.py: 128 segments, 0.05 mm seam overlap, 0.05 mm embed.
export const RING_SEGMENTS = 128;
export const RING_SEAM_OVERLAP = 0.05;
export const RING_EMBED = 0.05;
export const RING_MAX_REPEAT = 12;

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

/** Interpolate the ring's outer radius at axial height z. */
function rOuterAtZ(z, ringInfo) {
  const { z_profile, r_profile, r_outer } = ringInfo;
  if (!z_profile || !r_profile || z_profile.length < 2) return r_outer;
  const n = z_profile.length;
  const t = (z - z_profile[0]) / (z_profile[n - 1] - z_profile[0]) * (n - 1);
  const i = Math.max(0, Math.min(n - 2, Math.floor(t)));
  return r_profile[i] + (t - i) * (r_profile[i + 1] - r_profile[i]);
}

// ---------------------------------------------------------------------------
// Wrapping

/**
 * Map a single flat point [x, y, z] onto the ring surface.
 *
 * bounds = [x0, y0, x1, y1] is the TOTAL flat extent covering all repeats.
 * y = 0 maps to ring z = y_min; y = (y1-y0) maps to z = y_max.
 * z is the relief height (outward from the ring surface).
 *
 * `seam` stretches the turn so its ends overlap; it is 0 for sketch repeats,
 * where the periodic columns already meet in one plane after a full turn.
 */
export function wrapRingPoint([x, y, z], bounds, ringInfo, seam = RING_SEAM_OVERLAP) {
  const [x0, y0, x1, y1] = bounds;
  const { y_min, ring_height, r_outer } = ringInfo;
  const fullAngle = 2 * Math.PI + seam / r_outer;
  const angle = ((x - x0) / (x1 - x0) - 0.5) * fullAngle + Math.PI;
  const zRing = y_min + (y - y0) / (y1 - y0) * ring_height;
  const rBase = rOuterAtZ(zRing, ringInfo);
  const r = rBase - RING_EMBED + z;
  const cx = Math.cos(angle), cy = Math.sin(angle);
  return [r * (Math.abs(cx) < 1e-12 ? 0 : cx), r * (Math.abs(cy) < 1e-12 ? 0 : cy), zRing];
}

// The flat strip that wraps once and where each copy of the artwork sits in
// it. With `tiling` (sketch repeats) the swept frame is one periodic column
// repeated around; without it, finished copies of the relief sit side by side.
function ringLayout(bounds, repeatX, tiling) {
  if (tiling) {
    const [px] = tiling.period;
    return { bounds: tiling.bounds, copies: Array.from({ length: tiling.repeatX }, (_, i) => px * i) };
  }
  const width = bounds[2] - bounds[0];
  return { bounds: [bounds[0], bounds[1], bounds[0] + repeatX * width, bounds[3]],
           copies: Array.from({ length: repeatX }, (_, i) => width * i) };
}

/**
 * Wrap flat triangle positions onto the ring surface.
 *
 * positions — flat Float64/Float32 array, 9 values per triangle (x,y,z × 3),
 *             for ONE copy of the artwork (one tile, or one swept column).
 * bounds — [x0, y0, x1, y1] flat extent of that one copy.
 * The copies are laid out and wrapped here; with sketch repeats whatever
 * reaches past either end of the turn continues on the other.
 */
export function wrapRingTriangles(positions, bounds, ringInfo, { tiling = null, repeatX = 1 } = {}) {
  if (bounds.some(v => !Number.isFinite(v)) || bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) {
    throw new Error('The drawing needs a positive width and height to wrap.');
  }
  const layout = ringLayout(bounds, repeatX, tiling);
  const [x0,, x1] = layout.bounds;
  const turn = x1 - x0;
  const dx = turn / RING_SEGMENTS;
  const seam = tiling ? 0 : RING_SEAM_OVERLAP;
  const result = [];
  for (const ox of layout.copies) for (let i = 0; i < positions.length; i += 9) {
    const placed = [
      [positions[i]   + ox, positions[i+1], positions[i+2]],
      [positions[i+3] + ox, positions[i+4], positions[i+5]],
      [positions[i+6] + ox, positions[i+7], positions[i+8]],
    ];
    // A copy left at its original coordinates can straddle the seam; the part
    // that overshoots either end continues on the other end of the turn.
    const shifts = [0];
    if (tiling && Math.min(...placed.map(p => p[0])) < x0) shifts.push(turn);
    if (tiling && Math.max(...placed.map(p => p[0])) > x1) shifts.push(-turn);
    for (const shift of shifts) {
      const tri = shift ? placed.map(([x, y, z]) => [x + shift, y, z]) : placed;
      const minX = Math.min(...tri.map(p => p[0]));
      const maxX = Math.max(...tri.map(p => p[0]));
      const first = Math.max(0, Math.floor((minX - x0) / dx));
      const last = Math.min(RING_SEGMENTS - 1, Math.floor((maxX - x0) / dx));
      for (let s = first; s <= last; s++) {
        const strip = clip(clip(tri, 0, x0 + s * dx, true), 0, x0 + (s + 1) * dx, false);
        if (strip.length < 3) continue;
        const pts = strip.map(p => wrapRingPoint(p, layout.bounds, ringInfo, seam));
        for (let k = 1; k < pts.length - 1; k++) {
          result.push(...pts[0], ...pts[k], ...pts[k + 1]);
        }
      }
    }
  }
  return new Float32Array(result);
}

// ---------------------------------------------------------------------------
// Fitting suggestions (mirror of cylinderFit / cylinderSuggestions)

/**
 * Compute how well `repeatX` copies of the artwork (width × height in flat
 * coords) fit the ring's outer surface.
 *
 * The ring's outer circumference is approximated as 2π × r_outer; its
 * axial height is ring_height.  Both dimensions contribute equally to the
 * error in proportional mode.
 *
 * Returns { repeatX, scale, widthOnRing, error } or null if infeasible.
 */
export function ringFit(tileBounds, ringInfo, repeatX) {
  const [x0, y0, x1, y1] = tileBounds;
  const W = x1 - x0, A = y1 - y0;
  if (!(W > 0 && A > 0)) return null;
  if (!Number.isInteger(repeatX) || repeatX < 1 || repeatX > RING_MAX_REPEAT) return null;

  const C = 2 * Math.PI * ringInfo.r_outer;   // outer circumference
  const H = ringInfo.ring_height;              // ring height (fixed by profile)
  if (!(C > 0 && H > 0)) return null;

  const widthPerCopy = C / repeatX;   // mm available per copy around the ring

  // Proportional: minimize sum of squared relative errors for both axes.
  // s = (W/widthPerCopy + A/H) / (W²/widthPerCopy² + A²/H²)
  const a = W / widthPerCopy, b = A / H;
  const scale = (a + b) / (a * a + b * b);
  if (!Number.isFinite(scale) || scale <= 0) return null;

  const error = Math.hypot(scale * W / widthPerCopy - 1, scale * A / H - 1);
  return { repeatX, scale, widthOnRing: widthPerCopy, heightOnRing: H, error };
}

/**
 * Return up to `limit` ring fitting suggestions, sorted by ascending error.
 * Deduplicate by repeat count.
 */
export function ringSuggestions(tileBounds, ringInfo, limit = 10) {
  const fits = [];
  for (let n = 1; n <= RING_MAX_REPEAT; n++) {
    const fit = ringFit(tileBounds, ringInfo, n);
    if (fit) fits.push(fit);
  }
  fits.sort((a, b) => a.error - b.error || a.repeatX - b.repeatX);
  return fits.slice(0, limit);
}
