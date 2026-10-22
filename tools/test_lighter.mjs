// Parity: static/lighter.js must wrap points exactly as tools/lighter.py does,
// so the browser preview matches the exported STL. Python computes the ellipse
// info table and the expected wrapped points; the JS side must reproduce them.
import assert from 'node:assert/strict';
import {
  wrapLighterPoint, wrapLighterTriangles, lighterFit, lighterSuggestions,
  LIGHTER_SEAM_OVERLAP,
} from '../static/lighter.js';

const PY = '.venv/bin/python';

// Flat sample points [x, y, z] over a tile, plus the tile bounds.
const bounds = [-10, 0, 90, 40];
const seam = LIGHTER_SEAM_OVERLAP;
const samples = [];
for (let i = 0; i <= 8; i++) {
  const x = bounds[0] + (bounds[2] - bounds[0]) * i / 8;
  samples.push([x, 5, 0.6], [x, 30, 1.2]);
}

// A non-default start (vertex 3 = top, plus a 20° offset) exercises the seam
// offset on both sides.
const settings = { wall: 1.0, height: 70.9, startVertex: 3, startOffset: 20 };
const script = `
import json, sys, numpy as np
sys.path.insert(0, 'tools')
from lighter import lighter_info, _ellipse_points, EMBED
settings = ${JSON.stringify(settings)}
info = lighter_info(settings)
bounds = ${JSON.stringify(bounds)}
seam = ${seam}
x0, y0, x1, y1 = bounds
width = x1 - x0
pts = ${JSON.stringify(samples)}
out = []
for x, y, z in pts:
    frac = ((x - x0) / width - 0.5) * (info["perimeter"] + seam) / info["perimeter"] + 0.5 + info["start"]
    px, py, nx, ny = (a[0] for a in _ellipse_points(info, np.array([frac])))
    depth = z - EMBED
    zr = info["z0"] + (y - y0) / (y1 - y0) * info["body_height"]
    out.append([px + depth * nx, py + depth * ny, zr])
json.dump({"info": info, "wrapped": out}, sys.stdout)
`;

const proc = new Deno.Command(PY, {
  args: ['-c', script],
  stdout: 'piped',
  stderr: 'piped',
}).outputSync();
if (!proc.success) {
  throw new Error(new TextDecoder().decode(proc.stderr));
}
const { info, wrapped } = JSON.parse(new TextDecoder().decode(proc.stdout));

for (let i = 0; i < samples.length; i++) {
  const got = wrapLighterPoint(samples[i], bounds, info, seam);
  for (let k = 0; k < 3; k++) {
    assert.ok(
      Math.abs(got[k] - wrapped[i][k]) < 1e-6,
      `point ${i} axis ${k}: JS ${got[k]} vs Python ${wrapped[i][k]}`,
    );
  }
}

// The seam overlaps: the two flat ends map to within one seam's arc of a point.
const left = wrapLighterPoint([bounds[0], 5, 0], bounds, info, seam);
const right = wrapLighterPoint([bounds[2], 5, 0], bounds, info, seam);
assert.ok(Math.hypot(left[0] - right[0], left[1] - right[1]) < seam + 1e-6,
  'the wrap ends meet with a small seam overlap');

// Height maps between the chamfers; relief rises outward past the ellipse.
assert.ok(Math.abs(wrapLighterPoint([0, 0, 0], bounds, info, seam)[2] - info.z0) < 1e-9);
assert.ok(Math.abs(wrapLighterPoint([0, 40, 0], bounds, info, seam)[2] - info.z1) < 1e-9);

// Fit suggestions: one scale fits both axes, errors ascend, perimeter-based.
const fits = lighterSuggestions(bounds, info);
assert.ok(fits.length > 0 && fits.length <= 10);
for (let i = 0; i < fits.length; i++) {
  const f = fits[i];
  const a = (bounds[2] - bounds[0]) / (info.perimeter / f.repeatX);
  const b = (bounds[3] - bounds[1]) / info.body_height;
  assert.ok(Math.abs(f.scale - (a + b) / (a * a + b * b)) < 1e-12);
  if (i) assert.ok(f.error >= fits[i - 1].error - 1e-10, 'nearest proportions first');
}
assert.ok(fits[0].error <= lighterFit(bounds, info, 1).error + 1e-12);
assert.throws(() => wrapLighterTriangles(new Float32Array(), [0, 0, 0, 0], info));

console.log(`ok — ${samples.length} points match Python, ${fits.length} fits ranked`);
