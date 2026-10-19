export const snapProfileOffset = value => Math.round((value + Number.EPSILON) * 10) / 10 || 0;

export function sectionBounds(section, transform) {
  const [left, bottom, right, top] = section.bounds;
  return [left * transform.sx, bottom * transform.sy + transform.z,
    right * transform.sx, top * transform.sy + transform.z];
}

export function moveProfile(start, dy) {
  return { ...start, z: snapProfileOffset(start.z + dy) };
}

/** Resize about the same centreline / base origin used by the model pipeline. */
export function resizeProfile(section, start, kind, point) {
  const [left, bottom, right, top] = section.bounds;
  const x = Math.abs(right) >= Math.abs(left) ? right : left;
  const y = Math.abs(top) >= Math.abs(bottom) ? top : bottom;
  let sx = start.sx, sy = start.sy;
  if (start.locked && kind === 'corner') {
    const ax = x * sx, ay = y * sy;
    const ratio = Math.max(.01 / Math.min(sx, sy),
      (point.x * ax + (point.y - start.z) * ay) / (ax * ax + ay * ay));
    sx *= ratio; sy *= ratio;
  } else {
    if (kind !== 'height' && x) sx = Math.max(.01, point.x / x);
    if (kind !== 'width' && y) sy = Math.max(.01, (point.y - start.z) / y);
    if (start.locked) {
      if (kind === 'height') sx = start.sx * sy / start.sy;
      else sy = start.sy * sx / start.sx;
    }
  }
  return { ...start, sx, sy };
}

function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[i], [bx, by] = ring[j];
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

/** Distance in model millimetres; filled overlap never hides a nearby outline. */
export function sectionHit(section, transform, point, tolerance) {
  const rings = [section.exterior, ...section.holes].map(ring =>
    ring.map(([x, y]) => [x * transform.sx, y * transform.sy + transform.z]));
  let distance = Infinity;
  for (const ring of rings) for (let i = 1; i < ring.length; i++) {
    const [ax, ay] = ring[i - 1], [bx, by] = ring[i];
    const dx = bx - ax, dy = by - ay, length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, ((point.x - ax) * dx + (point.y - ay) * dy) / length)) : 0;
    distance = Math.min(distance, Math.hypot(point.x - ax - t * dx, point.y - ay - t * dy));
  }
  if (distance <= tolerance) return distance;
  const p = [point.x, point.y];
  return inRing(p, rings[0]) && !rings.slice(1).some(ring => inRing(p, ring)) ? Infinity : null;
}
