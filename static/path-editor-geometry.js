// Small edits to a subject's own paths: extend or shorten a DXF line or arc,
// bend an arc, move a circle, or drag an SVG path's points. Ends that touch
// stay together: a neighbour's end follows the end it touched. Pure functions,
// driven by path-editor.js.
//
// Entities are plain objects, replaced rather than changed:
//   { kind: 'line', handle, a, b }                 DXF, drawing units, y up
//   { kind: 'arc', handle, c, r, start, sweep }    counter-clockwise, radians
//   { kind: 'circle', handle, c, r }
//   { kind: 'path', m, segs }                       SVG: segs in the element's
//     own coordinates, m maps them to the root's user units (y down)

import { transform as svgTransform } from './vendor/shadertrace/vector-import/svg.js';
import { multiply } from './vendor/shadertrace/vector-import/geometry.js';

const TAU = 2 * Math.PI;
/** Half a degree: an arc never shrinks to a point or closes into a circle. */
export const MIN_SWEEP = TAU / 720;
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const scale = (a, k) => [a[0] * k, a[1] * k];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const angleAt = (c, p) => Math.atan2(p[1] - c[1], p[0] - c[0]);
const polar = (c, r, a) => [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];
/** Counter-clockwise turn from angle `from` to angle `to`, in [0, 2π). */
const turn = (from, to) => ((to - from) % TAU + TAU) % TAU;
const clampSweep = s => Math.max(MIN_SWEEP, Math.min(TAU - MIN_SWEEP, s));
const degrees = a => a * 180 / Math.PI;
const radians = a => a * Math.PI / 180;

/* ------------------------------------------------------------ matrices */

/** Affine [a, b, c, d, e, f], as in SVG: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export const apply = (m, p) => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
const linear = (m, v) => [m[0] * v[0] + m[2] * v[1], m[1] * v[0] + m[3] * v[1]];
export function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det) throw new Error('This SVG element is squashed flat by its transform.');
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}
/** How much `m` enlarges lengths, on average. */
export const stretch = m => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;

/* ------------------------------------------------------------ entities */

/** Editable DXF entities and the fixed rest, from an /api/sketch answer. */
export function dxfEntities(sketch) {
  const entities = [], fixed = [];
  for (const l of sketch.lines) {
    (l.handle ? entities : fixed).push({ kind: 'line', handle: l.handle, layer: l.layer, a: [...l.a], b: [...l.b] });
  }
  for (const a of sketch.arcs) {
    const start = angleAt(a.center, a.start);
    (a.handle ? entities : fixed).push({ kind: 'arc', handle: a.handle, layer: a.layer, c: [...a.center], r: a.radius,
      start, sweep: turn(start, angleAt(a.center, a.end)) || TAU });
  }
  for (const c of sketch.circles) {
    (c.handle ? entities : fixed).push({ kind: 'circle', handle: c.handle, layer: c.layer, c: [...c.center], r: c.radius });
  }
  for (const p of sketch.polylines) fixed.push({ kind: 'polyline', points: p.points });
  return { entities, fixed };
}

const arcEnd = (e, key) => polar(e.c, e.r, key === 'start' ? e.start : e.start + e.sweep);
/** A path point or control (`p:3`, `c1:3`, `c2:3`) in root coordinates. */
export const pointAt = (e, key) => {
  const [role, k] = key.split(':');
  return apply(e.m, e.segs[k][role]);
};

/** Where an entity can join another: line and arc ends, SVG path points. */
export function endsOf(e) {
  if (e.kind === 'line') return [['a', e.a], ['b', e.b]];
  if (e.kind === 'arc') return [['start', arcEnd(e, 'start')], ['end', arcEnd(e, 'end')]];
  if (e.kind === 'path') return e.segs.flatMap((s, k) => s.p ? [[`p:${k}`, apply(e.m, s.p)]] : []);
  return [];
}

/**
 * The points of an entity a pointer can drag. `role` is `end` (joins other
 * entities), `bend`, `centre`, `rim` or `control`; a control carries the
 * point it hangs from. For a path only the controls next to `near` (a
 * selected point's key) are offered, so a long curve stays readable.
 */
export function handlesOf(e, near = null) {
  if (e.kind === 'line') return [{ key: 'a', role: 'end', at: e.a }, { key: 'b', role: 'end', at: e.b }];
  if (e.kind === 'arc') {
    return [{ key: 'start', role: 'end', at: arcEnd(e, 'start') }, { key: 'end', role: 'end', at: arcEnd(e, 'end') },
      { key: 'mid', role: 'bend', at: polar(e.c, e.r, e.start + e.sweep / 2) }];
  }
  if (e.kind === 'circle') return [{ key: 'centre', role: 'centre', at: e.c }, { key: 'rim', role: 'rim', at: polar(e.c, e.r, -Math.PI / 4) }];
  const handles = endsOf(e).map(([key, at]) => ({ key, role: 'end', at }));
  if (!near) return handles;
  // The selected point's own controls: the one before it, the one after it.
  const k = Number(near.split(':')[1]), here = e.segs[k], next = e.segs[k + 1], from = apply(e.m, here.p);
  if (here.cmd === 'C') handles.push({ key: `c2:${k}`, role: 'control', at: apply(e.m, here.c2), from });
  if (here.cmd === 'Q') handles.push({ key: `c1:${k}`, role: 'control', at: apply(e.m, here.c1), from });
  if (next?.cmd === 'C' || next?.cmd === 'Q') handles.push({ key: `c1:${k + 1}`, role: 'control', at: apply(e.m, next.c1), from });
  return handles;
}

/** The circular arc from p0 to p1 turning `sweep` counter-clockwise, or null. */
function arcThrough(p0, p1, sweep, e) {
  const chord = dist(p0, p1);
  if (!(chord > 1e-12)) return null;
  const r = chord / (2 * Math.sin(sweep / 2));
  const u = scale(sub(p1, p0), 1 / chord), centre = add(scale(add(p0, p1), .5), scale([-u[1], u[0]], r * Math.cos(sweep / 2)));
  return { ...e, c: centre, r, start: angleAt(centre, p0), sweep };
}

/** The counter-clockwise arc from p0 through q to p1; kept bulging the way it did. */
function arcThroughPoint(e, q) {
  const p0 = arcEnd(e, 'start'), p1 = arcEnd(e, 'end'), d = sub(p1, p0);
  // A counter-clockwise arc bulges to the right of its chord.
  if (!(cross(d, sub(q, p0)) < 0)) return arcThrough(p0, p1, MIN_SWEEP, e);
  const a = sub(q, p0), b = sub(p1, p0), k = 2 * cross(a, b);
  const centre = add(p0, [(b[1] * (a[0] ** 2 + a[1] ** 2) - a[1] * (b[0] ** 2 + b[1] ** 2)) / k,
    (a[0] * (b[0] ** 2 + b[1] ** 2) - b[0] * (a[0] ** 2 + a[1] ** 2)) / k]);
  const start = angleAt(centre, p0);
  return { ...e, c: centre, r: dist(centre, p0), start, sweep: clampSweep(turn(start, angleAt(centre, p1))) };
}

/** Slide one end of an arc round its circle to the direction of `at`; the other end stays. */
function slideArc(e, key, at, previous) {
  const angle = angleAt(e.c, at), stay = e.start + e.sweep;
  let sweep = key === 'end' ? turn(e.start, angle) : turn(angle, stay);
  // Crossing the other end would flip the arc to its complement: stop short instead.
  if (Math.abs(sweep - previous.sweep) > Math.PI) sweep = previous.sweep > Math.PI ? TAU : 0;
  sweep = clampSweep(sweep);
  return key === 'end' ? { ...e, sweep } : { ...e, start: stay - sweep, sweep };
}

/** Move an SVG path point (in root coordinates) and the controls hanging from it. */
function movePoint(e, key, at) {
  const [role, k] = key.split(':'), j = Number(k), local = apply(invert(e.m), at);
  const segs = e.segs.slice(), delta = sub(local, segs[j][role]);
  segs[j] = { ...segs[j], [role]: local };
  if (role === 'p') {
    if (segs[j].cmd === 'C') segs[j].c2 = add(segs[j].c2, delta);
    const next = segs[j + 1];
    if (next?.cmd === 'C') segs[j + 1] = { ...next, c1: add(next.c1, delta) };
  }
  return { ...e, segs };
}

/**
 * The entity with handle `key` dragged to `at` (drawing coordinates). An end
 * slides along its own line or circle, extending or shortening it, unless
 * `free`: then a line end goes anywhere and an arc keeps its bend through the
 * new end. `previous` is the entity as the drag last left it, so an arc end
 * does not jump past the other end. Returns null when the shape cannot be made.
 */
export function dragHandle(e, key, at, { free = false, previous = e } = {}) {
  if (e.kind === 'line') {
    if (free) return { ...e, [key]: at };
    const stay = key === 'a' ? e.b : e.a, length = dist(e.a, e.b);
    const u = scale(sub(e[key], stay), 1 / length), along = Math.max(length * 1e-3, (at[0] - stay[0]) * u[0] + (at[1] - stay[1]) * u[1]);
    return { ...e, [key]: add(stay, scale(u, along)) };
  }
  if (e.kind === 'arc') {
    if (key === 'mid') return arcThroughPoint(e, at);
    if (!free) return slideArc(e, key, at, previous);
    return key === 'end' ? arcThrough(arcEnd(e, 'start'), at, e.sweep, e) : arcThrough(at, arcEnd(e, 'end'), e.sweep, e);
  }
  if (e.kind === 'circle') return key === 'centre' ? { ...e, c: at } : { ...e, r: Math.max(dist(e.c, at), 1e-9) };
  return movePoint(e, key, at);
}

/** A neighbour's end following the end it touched to `at`. */
export function followEnd(e, key, at, tolerance) {
  if (e.kind === 'line') return { ...e, [key]: at };
  if (e.kind === 'arc') {
    // On the same circle (a duplicate or a continuation) it slides; otherwise it keeps its bend.
    if (Math.abs(dist(e.c, at) - e.r) <= tolerance) return slideArc(e, key, at, e);
    return (key === 'end' ? arcThrough(arcEnd(e, 'start'), at, e.sweep, e) : arcThrough(at, arcEnd(e, 'end'), e.sweep, e)) ?? e;
  }
  if (e.kind === 'path') return movePoint(e, key, at);
  return e;
}

/** The entity moved by `delta`, in drawing coordinates. */
export function translate(e, delta) {
  if (e.kind === 'line') return { ...e, a: add(e.a, delta), b: add(e.b, delta) };
  if (e.kind === 'arc' || e.kind === 'circle') return { ...e, c: add(e.c, delta) };
  const d = linear(invert(e.m), delta), shift = p => p && add(p, d);
  return { ...e, segs: e.segs.map(s => ({ ...s, p: shift(s.p), c1: shift(s.c1), c2: shift(s.c2) })) };
}

/** Every entity's ends bucketed by position, so the ends at a point are found quickly. */
function endGrid(entities, tolerance) {
  const cell = 2 * tolerance || 1e-9, grid = new Map(), at = p => `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)}`;
  entities.forEach((e, i) => {
    for (const [key, p] of endsOf(e)) {
      const bucket = at(p);
      if (!grid.has(bucket)) grid.set(bucket, []);
      grid.get(bucket).push([i, key, p]);
    }
  });
  return p => {
    const gx = Math.floor(p[0] / cell), gy = Math.floor(p[1] / cell), out = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const end of grid.get(`${gx + dx},${gy + dy}`) ?? []) if (dist(end[2], p) <= tolerance) out.push(end);
    }
    return out;
  };
}

/**
 * For each end of entity `index` (or just the ends named in `keys`): the
 * other ends of `entities` at the same point, as [index, key].
 */
export function joinsOf(entities, index, tolerance, keys = null) {
  const near = endGrid(entities, tolerance), joins = new Map();
  for (const [key, at] of endsOf(entities[index])) {
    if (keys && !keys.includes(key)) continue;
    joins.set(key, near(at).filter(([i, k]) => i !== index || k !== key).map(([i, k]) => [i, k]));
  }
  return joins;
}

/** Every distinct end point, with how many ends meet there. */
export function endPoints(entities, tolerance) {
  const near = endGrid(entities, tolerance), seen = new Set(), points = [];
  entities.forEach((e, i) => {
    for (const [key, at] of endsOf(e)) {
      if (seen.has(`${i} ${key}`)) continue;
      const here = near(at);
      for (const [j, k] of here) seen.add(`${j} ${k}`);
      points.push({ at, count: here.length });
    }
  });
  return points;
}

/**
 * `entities` with entity `index` replaced by `next`: every end of it that
 * moved takes the ends joined to it along (see `joinsOf`, taken before the
 * edit). Neighbours change only at the joined end, so nothing ripples further.
 */
export function withFollowers(entities, index, next, joins, tolerance) {
  const out = entities.slice(), before = new Map(endsOf(entities[index]));
  out[index] = next;
  for (const [key, at] of endsOf(next)) {
    if (dist(at, before.get(key)) === 0) continue;
    for (const [i, k] of joins.get(key) ?? []) out[i] = followEnd(out[i], k, at, tolerance);
  }
  return out;
}

/** Why an entity cannot be written, or ''. */
export function invalid(e, extent) {
  const tiny = extent * 1e-6;
  if (e.kind === 'line' && !(dist(e.a, e.b) > tiny)) return 'A line would shrink to nothing.';
  if ((e.kind === 'arc' || e.kind === 'circle') && !(e.r > tiny && e.r < extent * 1e4)) return 'An arc would shrink to nothing or grow without end.';
  if (e.kind === 'arc' && !(e.sweep >= MIN_SWEEP / 2)) return 'An arc would shrink to nothing.';
  return '';
}

/* -------------------------------------------------------------- fields */

/**
 * The numbers to type for an entity: id, label, value. A path offers the
 * selected point's position (root user units).
 */
export function fieldsOf(e, point = null) {
  if (e.kind === 'line') {
    return [['x1', 'Start X', e.a[0]], ['y1', 'Start Y', e.a[1]], ['x2', 'End X', e.b[0]], ['y2', 'End Y', e.b[1]],
      ['length', 'Length', dist(e.a, e.b)]];
  }
  if (e.kind === 'arc') {
    return [['radius', 'Radius', e.r], ['start', 'Start angle °', degrees(e.start)], ['end', 'End angle °', degrees(e.start + e.sweep)],
      ['sweep', 'Sweep °', degrees(e.sweep)], ['cx', 'Centre X', e.c[0]], ['cy', 'Centre Y', e.c[1]]];
  }
  if (e.kind === 'circle') return [['cx', 'Centre X', e.c[0]], ['cy', 'Centre Y', e.c[1]], ['radius', 'Radius', e.r]];
  if (!point) return [];
  const at = pointAt(e, point);
  return [['x', 'X', at[0]], ['y', 'Y', at[1]]];
}

/** The entity with one typed field changed, or null when the value cannot apply. */
export function setField(e, field, value, point = null) {
  if (!Number.isFinite(value)) return null;
  if (e.kind === 'line') {
    if (field === 'length') {
      const length = dist(e.a, e.b);
      return value > 0 ? { ...e, b: add(e.a, scale(sub(e.b, e.a), value / length)) } : null;
    }
    const [end, axis] = { x1: ['a', 0], y1: ['a', 1], x2: ['b', 0], y2: ['b', 1] }[field];
    const p = [...e[end]]; p[axis] = value;
    return { ...e, [end]: p };
  }
  if (field === 'cx' || field === 'cy') return { ...e, c: field === 'cx' ? [value, e.c[1]] : [e.c[0], value] };
  if (field === 'radius') return value > 0 ? { ...e, r: value } : null;
  if (e.kind === 'arc') {
    // Each angle moves one end: start keeps the end where it is, end and sweep keep the start.
    if (field === 'sweep') return value > 0 && value < 360 ? { ...e, sweep: clampSweep(radians(value)) } : null;
    if (field === 'end') return { ...e, sweep: clampSweep(turn(e.start, radians(value))) };
    if (field === 'start') {
      const stay = e.start + e.sweep, sweep = clampSweep(turn(radians(value), stay));
      return { ...e, start: stay - sweep, sweep };
    }
  }
  if (e.kind === 'path' && point) {
    const at = pointAt(e, point);
    return movePoint(e, point, field === 'x' ? [value, at[1]] : [at[0], value]);
  }
  return null;
}

/* ------------------------------------------------------------- results */

const same = (a, b) => Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));
const samePoint = (a, b) => (!a && !b) || (a && b && same(a[0], b[0]) && same(a[1], b[1]));
export function changed(before, after) {
  if (before.kind === 'line') return !samePoint(before.a, after.a) || !samePoint(before.b, after.b);
  if (before.kind === 'path') {
    return before.segs.some((s, k) => ['p', 'c1', 'c2'].some(role => !samePoint(s[role], after.segs[k][role])));
  }
  return !samePoint(before.c, after.c) || !same(before.r, after.r)
    || (before.kind === 'arc' && (!same(before.start, after.start) || !same(before.sweep, after.sweep)));
}

/** What /api/sketch/apply writes: every DXF entity that changed. */
export function dxfEdits(original, entities) {
  return entities.flatMap((e, i) => {
    if (!changed(original[i], e)) return [];
    if (e.kind === 'line') return [{ kind: 'line', handle: e.handle, a: e.a, b: e.b }];
    if (e.kind === 'circle') return [{ kind: 'circle', handle: e.handle, center: e.c, radius: e.r }];
    return [{ kind: 'arc', handle: e.handle, center: e.c, radius: e.r, start: arcEnd(e, 'start'), end: arcEnd(e, 'end') }];
  });
}

/** Every end that moved, as [from, to], each starting point once. */
export function movedEnds(original, entities) {
  const moves = [];
  original.forEach((e, i) => {
    const now = new Map(endsOf(entities[i]));
    for (const [key, from] of endsOf(e)) {
      const to = now.get(key);
      const slack = 1e-9 * (1 + Math.hypot(...from));
      if (dist(from, to) > slack && !moves.some(([f]) => dist(f, from) <= slack)) moves.push([from, to]);
    }
  });
  return moves;
}

/** Bounding box [left, bottom, right, top] of entities, sampling arcs. */
export function bounds(entities) {
  const points = entities.flatMap(e => {
    if (e.kind === 'line') return [e.a, e.b];
    if (e.kind === 'polyline') return e.points;
    if (e.kind === 'circle') return [sub(e.c, [e.r, e.r]), add(e.c, [e.r, e.r])];
    if (e.kind === 'arc') return Array.from({ length: 33 }, (_, k) => polar(e.c, e.r, e.start + e.sweep * k / 32));
    return e.segs.flatMap(s => [s.p, s.c1, s.c2].filter(Boolean).map(p => apply(e.m, p)));
  });
  if (!points.length) return [0, 0, 1, 1];
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/* ----------------------------------------------------------- SVG paths */

const COUNTS = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

/**
 * SVG path data as absolute segments: M, L, C, Q, A (with `p`, the point it
 * ends at, and `c1`/`c2` controls) and Z. H and V become L, S and T become C
 * and Q, so every point can be dragged on its own.
 */
export function parsePathData(d) {
  const tokens = String(d).match(/[MmLlHhVvCcSsQqTtAaZz]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) ?? [];
  const segs = [];
  let i = 0, cmd = '', current = [0, 0], start = [0, 0], last = null;
  const number = () => {
    const t = tokens[i++];
    if (t === undefined || /[a-z]/i.test(t)) throw new Error('This SVG path data is cut short.');
    return Number(t);
  };
  // Arc flags may be written without separators: "a5 5 0 1010 10".
  const flag = () => {
    const t = tokens[i];
    if (t === undefined || /[a-z]/i.test(t)) throw new Error('This SVG path data is cut short.');
    if (/^[01]$/.test(t)) { i++; return Number(t); }
    if (/^[01]/.test(t)) { tokens[i] = t.slice(1); return Number(t[0]); }
    throw new Error('This SVG path has an arc flag other than 0 or 1.');
  };
  while (i < tokens.length) {
    if (/[a-z]/i.test(tokens[i])) cmd = tokens[i++];
    else if (!cmd) throw new Error('SVG path data must start with a move.');
    const upper = cmd.toUpperCase(), rel = cmd !== upper;
    const at = (x, y) => rel ? [current[0] + x, current[1] + y] : [x, y];
    if (upper === 'Z') {
      segs.push({ cmd: 'Z' }); current = start; last = null;
      continue;
    }
    if (i >= tokens.length || /[a-z]/i.test(tokens[i])) {
      if (COUNTS[upper]) throw new Error('This SVG path data is cut short.');
      continue;
    }
    let seg;
    if (upper === 'M') {
      seg = { cmd: 'M', p: at(number(), number()) }; start = seg.p;
      cmd = rel ? 'l' : 'L';                                   // further pairs are lines
    } else if (upper === 'L') seg = { cmd: 'L', p: at(number(), number()) };
    else if (upper === 'H') seg = { cmd: 'L', p: [rel ? current[0] + number() : number(), current[1]] };
    else if (upper === 'V') seg = { cmd: 'L', p: [current[0], rel ? current[1] + number() : number()] };
    else if (upper === 'C') seg = { cmd: 'C', c1: at(number(), number()), c2: at(number(), number()), p: at(number(), number()) };
    else if (upper === 'S') {
      const c1 = last?.cmd === 'C' ? sub(scale(current, 2), last.c2) : current;
      seg = { cmd: 'C', c1, c2: at(number(), number()), p: at(number(), number()) };
    } else if (upper === 'Q') seg = { cmd: 'Q', c1: at(number(), number()), p: at(number(), number()) };
    else if (upper === 'T') {
      const c1 = last?.cmd === 'Q' ? sub(scale(current, 2), last.c1) : current;
      seg = { cmd: 'Q', c1, p: at(number(), number()) };
    } else if (upper === 'A') {
      const rx = number(), ry = number(), rotation = number(), large = flag(), sweep = flag();
      seg = { cmd: 'A', rx, ry, rotation, large, sweep, p: at(number(), number()) };
    } else throw new Error(`Unknown SVG path command ${cmd}.`);
    segs.push(seg); current = seg.p; last = seg;
  }
  if (segs.length && segs[0].cmd !== 'M') throw new Error('SVG path data must start with a move.');
  return segs;
}

const num = v => String(Number(v.toFixed(4)) || 0);
const pair = p => `${num(p[0])} ${num(p[1])}`;

/** Absolute path data for `parsePathData` segments. */
export function formatPathData(segs) {
  return segs.map(s => {
    if (s.cmd === 'Z') return 'Z';
    if (s.cmd === 'C') return `C${pair(s.c1)} ${pair(s.c2)} ${pair(s.p)}`;
    if (s.cmd === 'Q') return `Q${pair(s.c1)} ${pair(s.p)}`;
    if (s.cmd === 'A') return `A${num(s.rx)} ${num(s.ry)} ${num(s.rotation)} ${s.large} ${s.sweep} ${pair(s.p)}`;
    return `${s.cmd}${pair(s.p)}`;
  }).join(' ');
}

/** Points of an SVG polyline or polygon `points` attribute, as segments. */
export function pointSegments(text, closed) {
  const values = (String(text).match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) ?? []).map(Number);
  const segs = [];
  for (let k = 0; k + 1 < values.length; k += 2) segs.push({ cmd: segs.length ? 'L' : 'M', p: [values[k], values[k + 1]] });
  if (closed && segs.length) segs.push({ cmd: 'Z' });
  return segs;
}

/** The `points` attribute for segments made by `pointSegments`. */
export const formatPoints = segs => segs.filter(s => s.p).map(s => `${num(s.p[0])},${num(s.p[1])}`).join(' ');

/** The transform from an element's own coordinates to the root SVG's user units. */
export function elementMatrix(element, root) {
  const chain = [];
  for (let node = element; node && node !== root; node = node.parentElement) chain.unshift(node);
  return chain.reduce((m, node) => multiply(m, svgTransform(node.getAttribute('transform') ?? '')), [1, 0, 0, 1, 0, 0]);
}

/** Millimetres per root user unit, as the converter reads the SVG (96 px to the inch). */
export function svgMillimetres(root) {
  const px = { px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, q: 96 / 101.6 };
  const length = value => {
    const m = String(value ?? '').trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(px|pt|pc|mm|cm|in|q)?$/i);
    return m ? Number(m[1]) * px[(m[2] || 'px').toLowerCase()] : null;
  };
  const box = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  const width = length(root.getAttribute('width')), height = length(root.getAttribute('height'));
  let k = 1;
  if (box.length === 4 && box[2] > 0 && box[3] > 0) {
    const kx = width ? width / box[2] : null, ky = height ? height / box[3] : null;
    k = kx && ky ? Math.min(kx, ky) : kx ?? ky ?? 1;
  }
  return k * 25.4 / 96;
}
