import { sectionHit } from './profile-editor-geometry.js';

export const snapShelf = value => Math.round(value * 10) / 10 || 0;

export function shelfSize(outline, values) {
  const b = outline.bounds;
  return { width: values.width || b[2] - b[0], depth: values.depth || b[3] - b[1] };
}

/** Editor axes: X left/right, Y depth, Z height. Storage keeps its original axes. */
export function shelfProjection(outline, values, view) {
  const { width, depth } = shelfSize(outline, values);
  if (view === 'front') {
    const l = values.x - width / 2, r = values.x + width / 2;
    return { exterior: [[l, values.z], [r, values.z], [r, values.z - values.thickness],
      [l, values.z - values.thickness], [l, values.z]], holes: [] };
  }
  const [l, b, r, t] = outline.bounds;
  const transform = ring => ring.map(([x, y]) => [
    values.x + (x - (l + r) / 2) * width / (r - l),
    values.y + (values.flip ? t - y : y - b) * depth / (t - b),
  ]);
  return { exterior: transform(outline.exterior), holes: outline.holes.map(transform) };
}

export function shelfBounds(shape) {
  const xs = shape.exterior.map(p => p[0]), ys = shape.exterior.map(p => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function hitShelf(shape, point, tolerance) {
  return sectionHit(shape, { sx: 1, sy: 1, z: 0 }, point, tolerance) !== null;
}

export function moveShelf(start, view, dx, dy) {
  return view === 'top' ? { ...start, x: snapShelf(start.x + dx), y: snapShelf(start.y + dy) }
    : { ...start, z: snapShelf(start.z + dy) };
}

/** Keep the rear centre attached while resizing the footprint. */
export function resizeShelf(start, size, kind, dx, dy) {
  let width = size.width, depth = size.depth;
  if (start.locked) {
    const factor = kind === 'width' ? 1 + 2 * dx / width : kind === 'depth' ? 1 + dy / depth
      : 1 + (dx * width / 2 + dy * depth) / ((width / 2) ** 2 + depth ** 2);
    const safe = Math.max(.2 / Math.min(width, depth), factor);
    width *= safe; depth *= safe;
  } else {
    if (kind !== 'depth') width += 2 * dx;
    if (kind !== 'width') depth += dy;
  }
  // Preserve the ratio when locked; model coordinates can retain sub-snap dimensions.
  return { ...start, width: Math.max(.2, start.locked ? width : snapShelf(width)),
    depth: Math.max(.2, start.locked ? depth : snapShelf(depth)) };
}
