function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[i], [bx, by] = ring[j];
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

function contains(region, point) {
  return inRing(point, region.polygon.exterior)
    && !region.polygon.holes.some((ring) => inRing(point, ring));
}

const areaOf = (region) => Number(region.area) || 0;

/**
 * Restore by location; a split inherits paint, a conflicting merge is refused.
 *
 * Moving the window content or its boundary redraws the crop, so a face can be
 * trimmed, absorbed by a neighbour or dropped. `strict` (the default) keeps the
 * old refusal for shape edits that would genuinely destroy paint; placement
 * passes `strict: false` so the rebuild always lands: the biggest predecessor
 * wins a merge and a face with no successor is simply reset. The returned array
 * carries `lost` (faces with no successor) and `merged` (faces absorbed, their
 * paint dropped) so the caller can say so.
 */
export function remapPaint(previous, stacks, next, { strict = true } = {}) {
  const used = new Set();
  let lost = 0, merged = 0;
  const result = next.map((region) => {
    const matches = previous.flatMap((old, i) =>
      contains(old, region.point) || contains(region, old.point) ? [i] : []);
    if (!matches.length) return null;
    // A predecessor whose own point lies inside the new face is the one that
    // survived; the rest merely merged into it. That keeps a sliver that got
    // absorbed from dictating the paint of the face around it.
    const inside = matches.filter((i) => contains(region, previous[i].point));
    const pool = inside.length ? inside : matches;
    const pick = pool.reduce((a, b) => (areaOf(previous[b]) > areaOf(previous[a]) ? b : a));
    const stack = stacks[pick];
    const conflict = matches.some((i) => JSON.stringify(stacks[i]) !== JSON.stringify(stack));
    if (conflict) {
      if (strict) {
        throw new Error('These settings merge faces with different paint. Your previous model is kept; undo the input change to save or export.');
      }
      merged += matches.filter((i) => i !== pick).length;
    }
    matches.forEach((i) => used.add(i));
    return stack.map((layer) => ({ ...layer }));
  });
  stacks.forEach((stack, i) => { if (stack.length && !used.has(i)) lost++; });
  if (strict && lost) {
    throw new Error('These settings remove painted faces. Your previous model is kept; undo the input change to save or export.');
  }
  // Non-enumerable so the array still compares equal to a plain stack list.
  Object.defineProperty(result, 'lost', { value: lost });
  Object.defineProperty(result, 'merged', { value: merged });
  return result;
}
