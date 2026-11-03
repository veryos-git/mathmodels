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

/* ------------------------------------------------------- profile colours */
// A colour is a rectangle over the main or cusp section, stored in that
// section's own unscaled coordinates so it follows the section's width,
// height and vertical offset. Mirror X reflects it across the centre line
// (x = 0, the sweep path); mirror Y across the section's mid-height. The
// converter (tools/profile_colours.py) uses exactly the same rules.

export const COLOUR_SNAP = .05;
export const COLOUR_MIN = .05;
export const COLOUR_PALETTE = ['#e11d48', '#f59e0b', '#10b981', '#8b5cf6', '#0ea5e9', '#f97316', '#d946ef', '#84cc16'];
export const snapColour = value => Math.round((value + Number.EPSILON) / COLOUR_SNAP) * COLOUR_SNAP || 0;
const tidy = value => Number(value.toPrecision(12));

/** The primary rectangle in finished millimetres: [left, bottom, right, top]. */
export function colourEdges(colour, transform) {
  const [x0, y0, x1, y1] = colour.rect;
  return [x0 * transform.sx, y0 * transform.sy + transform.z, x1 * transform.sx, y1 * transform.sy + transform.z];
}

/** Store finished-millimetre edges back in section coordinates, ordered and at least COLOUR_MIN wide. */
export function setColourEdges(colour, transform, edges) {
  let [left, bottom, right, top] = edges;
  if (left > right) [left, right] = [right, left];
  if (bottom > top) [bottom, top] = [top, bottom];
  right = Math.max(right, left + COLOUR_MIN); top = Math.max(top, bottom + COLOUR_MIN);
  return { ...colour, rect: [tidy(left / transform.sx), tidy((bottom - transform.z) / transform.sy),
    tidy(right / transform.sx), tidy((top - transform.z) / transform.sy)] };
}

/** The rectangle and its mirror images in finished mm, each tagged with how it was mirrored. */
export function colourRects(colour, section, transform) {
  const rects = [{ rect: colourEdges(colour, transform), mirrorX: false, mirrorY: false }];
  if (colour.mirrorX) rects.push(...rects.map(({ rect: [l, b, r, t], mirrorY }) =>
    ({ rect: [-r, b, -l, t], mirrorX: true, mirrorY })));
  if (colour.mirrorY) {
    const [, bottom, , top] = sectionBounds(section, transform), mid2 = bottom + top;
    rects.push(...rects.map(({ rect: [l, b, r, t], mirrorX }) => ({ rect: [l, mid2 - t, r, mid2 - b], mirrorX, mirrorY: true })));
  }
  return rects;
}

/** Which copy of the colour (primary first) contains the point, or null. */
export function colourHit(colour, section, transform, point) {
  return colourRects(colour, section, transform).find(({ rect: [l, b, r, t] }) =>
    point.x >= l && point.x <= r && point.y >= b && point.y <= t) ?? null;
}

/** Move by finished mm. Dragging a mirror image moves the original the mirrored way. */
export function moveColour(colour, transform, dx, dy, copy = {}) {
  const [l, b, r, t] = colourEdges(colour, transform);
  const x = copy.mirrorX ? -dx : dx, y = copy.mirrorY ? -dy : dy;
  return setColourEdges(colour, transform, [l + x, b + y, r + x, t + y]);
}

/** Drag one corner ('ne', 'nw', 'se' or 'sw') of the primary rectangle to a finished-mm point. */
export function resizeColour(colour, transform, corner, point) {
  let [l, b, r, t] = colourEdges(colour, transform);
  if (corner.includes('e')) r = Math.max(point.x, l + COLOUR_MIN); else l = Math.min(point.x, r - COLOUR_MIN);
  if (corner.includes('n')) t = Math.max(point.y, b + COLOUR_MIN); else b = Math.min(point.y, t - COLOUR_MIN);
  return setColourEdges(colour, transform, [l, b, r, t]);
}

/** A new band over the top third of a section, overhanging its sides, in an unused colour. */
export function newColour(id, sectionKey, section, colours = []) {
  const [left, bottom, right, top] = section.bounds;
  const overhang = (right - left) * .06, used = new Set(colours.map(c => c.color));
  const color = COLOUR_PALETTE.find(c => !used.has(c)) ?? COLOUR_PALETTE[colours.length % COLOUR_PALETTE.length];
  return { id, section: sectionKey, color, mirrorX: false, mirrorY: false,
    rect: [tidy(left - overhang), tidy(top - (top - bottom) / 3), tidy(right + overhang), tidy(top + (top - bottom) * .06)] };
}
