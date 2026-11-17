// Geometry for the paper screen, free of the DOM so it can be tested on its own.
//
// The net is shown from outside (SVG coordinates, millimetres, y down). A wall
// is { origin, x, y, size }: the point (x, y) of the wall seen from outside,
// from its bottom-left corner with y up, lies at origin + x·x + y·y. A
// decoration is { wall, x, y, width, rotation } — its centre on that wall,
// its drawing's width and a clockwise turn — and its geometry is normalized:
// the drawing 1 wide, centred on (0, 0), y up.

/** Round to a step of 1/n (0.1, 0.01, 0.5) without float noise like 0.30000000000000004. */
export const snap = (value, step = 0.1) => Math.round(value / step) / Math.round(1 / step) + 0;
const round = (value) => Math.round(value * 1000) / 1000 + 0;

/** SVG matrix(a b c d e f) taking a decoration's normalized geometry onto the net. */
export function decorationMatrix(wall, d) {
  const t = d.rotation * Math.PI / 180, c = Math.cos(t) * d.width, s = Math.sin(t) * d.width;
  // Clockwise in the wall's y-up coordinates: (px, py) → (c·px + s·py, −s·px + c·py).
  const [X, Y, O] = [wall.x, wall.y, wall.origin];
  return [
    X[0] * c - Y[0] * s, X[1] * c - Y[1] * s,
    X[0] * s + Y[0] * c, X[1] * s + Y[1] * c,
    O[0] + X[0] * d.x + Y[0] * d.y, O[1] + X[1] * d.x + Y[1] * d.y,
  ];
}

export const apply = (m, [x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** A net direction (dx, dy) in a wall's own coordinates. */
export function wallVector(wall, [dx, dy]) {
  const [X, Y] = [wall.x, wall.y], det = X[0] * Y[1] - X[1] * Y[0];
  return [(dx * Y[1] - dy * Y[0]) / det, (X[0] * dy - X[1] * dx) / det];
}

/** A net point in a wall's outside coordinates. */
export const wallLocal = (wall, [px, py]) => wallVector(wall, [px - wall.origin[0], py - wall.origin[1]]);

export const wallPoint = (wall, [x, y]) =>
  [wall.origin[0] + wall.x[0] * x + wall.y[0] * y, wall.origin[1] + wall.x[1] * x + wall.y[1] * y];

const inside = (wall, [x, y]) => x >= 0 && y >= 0 && x <= wall.size[0] && y <= wall.size[1];

/**
 * Where a decoration dragged to the net point `point` ends up: on the wall
 * under it (its current wall first), or clamped onto its current wall when
 * the point is on no wall at all — the floor, a tab, empty paper.
 */
export function placeAt(walls, current, point) {
  const order = [current, ...walls.keys()].filter((i, n, all) => i in walls && all.indexOf(i) === n);
  for (const i of order) {
    const local = wallLocal(walls[i], point);
    if (inside(walls[i], local)) return { wall: i, x: snap(local[0]), y: snap(local[1]) };
  }
  const wall = walls[current] ?? walls[0];
  const [x, y] = wallLocal(wall, point);
  return {
    wall: walls[current] ? current : 0,
    x: snap(Math.min(Math.max(x, 0), wall.size[0])),
    y: snap(Math.min(Math.max(y, 0), wall.size[1])),
  };
}

/** The decoration's width after a corner handle moved from `from` to `to`, its centre fixed. */
export function resizedWidth(width, centre, from, to) {
  const before = Math.hypot(from[0] - centre[0], from[1] - centre[1]);
  const after = Math.hypot(to[0] - centre[0], to[1] - centre[1]);
  if (!(before > 1e-9)) return width;
  return Math.min(Math.max(snap(width * after / before), 1), 1000);
}

/** The four corners of a decoration's drawing on the net. */
export function decorationCorners(wall, d, aspect) {
  const m = decorationMatrix(wall, d), h = aspect / 2;
  return [[-0.5, -h], [0.5, -h], [0.5, h], [-0.5, h]].map((p) => apply(m, p));
}

/** SVG path data for normalized geometry { points, paths }. */
export function geometryPath(geometry) {
  return (geometry?.paths ?? []).map((path) => path.map((i, n) => {
    const [x, y] = geometry.points[i];
    return `${n ? 'L' : 'M'}${round(x)} ${round(y)}`;
  }).join(' ') + ' Z').join(' ');
}

/** The wall a new decoration goes on: the one with the fewest so far. */
export function emptiestWall(wallCount, decorations) {
  const counts = Array.from({ length: Math.max(wallCount, 1) }, () => 0);
  for (const d of decorations) if (d.wall < counts.length) counts[d.wall]++;
  return counts.indexOf(Math.min(...counts));
}

/** Whether a sheet this size fits on A4, either way round. */
export const fitsA4 = (w, h) => (w <= 210 && h <= 297) || (w <= 297 && h <= 210);

/**
 * Column-major 4×4 matrices folding each face of the net `progress` (0 flat,
 * 1 folded) of the way. Faces come from tools/paper.py in the template's
 * coordinates: each turns about its hinge (a → b, right-handed) by its angle,
 * on top of how its parent turned.
 */
export function foldMatrices(faces, progress) {
  const matrices = new Array(faces.length);
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const visit = (i, seen = new Set()) => {
    if (matrices[i]) return matrices[i];
    const face = faces[i];
    if (face.parent < 0 || !face.hinge || seen.has(i)) return (matrices[i] = identity);
    seen.add(i);
    const parent = visit(face.parent, seen);
    matrices[i] = multiply(parent, hingeMatrix(face.hinge, face.angle * progress));
    return matrices[i];
  };
  faces.forEach((_, i) => visit(i));
  return matrices;
}

/** Turn `degrees` about the line a → b in the z = 0 plane. */
function hingeMatrix([a, b], degrees) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
  const t = degrees * Math.PI / 180, c = Math.cos(t), s = Math.sin(t), k = 1 - c;
  // Rodrigues about (ux, uy, 0), as rows.
  const r = [
    [c + ux * ux * k, ux * uy * k, uy * s],
    [ux * uy * k, c + uy * uy * k, -ux * s],
    [-uy * s, ux * s, c],
  ];
  // p' = r (p − a) + a
  const tx = a[0] - (r[0][0] * a[0] + r[0][1] * a[1]);
  const ty = a[1] - (r[1][0] * a[0] + r[1][1] * a[1]);
  const tz = -(r[2][0] * a[0] + r[2][1] * a[1]);
  return [r[0][0], r[1][0], r[2][0], 0, r[0][1], r[1][1], r[2][1], 0, r[0][2], r[1][2], r[2][2], 0, tx, ty, tz, 1];
}

function multiply(a, b) {
  const out = new Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

export const transformPoint = (m, [x, y, z = 0]) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];
