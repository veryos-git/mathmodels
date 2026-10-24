// Pointy tips of a gothic subject: two arcs meeting at an angle. An edit keeps
// every arc tangent to the lines and circles it touches, keeps joined arcs
// joined and, optionally, the subject's symmetry. Lines, circles and arcs
// inside blocks or polylines are fixed; model-space arcs are editable.
// Coordinates are the DXF's own. Pure functions, driven by tip-editor.js.

const TAU = 2 * Math.PI;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const angleAt = (c, p) => Math.atan2(p[1] - c[1], p[0] - c[0]);
/** Counter-clockwise turn from angle `from` to angle `to`, in [0, 2π). */
const turn = (from, to) => ((to - from) % TAU + TAU) % TAU;
const polar = (c, r, a) => [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];

/** How far a counter-clockwise arc turns from start to end (a full turn when they meet). */
export const arcSweep = arc => turn(angleAt(arc.c, arc.start), angleAt(arc.c, arc.end)) || TAU;

/** Does the arc's span include the direction of `p` (within `slack` radians)? */
export function withinArc(arc, p, slack = 0) {
  const t = turn(angleAt(arc.c, arc.start), angleAt(arc.c, p));
  return t <= arcSweep(arc) + slack || t >= TAU - slack;
}

/** Where along segment a→b the foot of `p` falls: 0 at a, 1 at b. */
function along(line, p) {
  const d = sub(line.b, line.a);
  return ((p[0] - line.a[0]) * d[0] + (p[1] - line.a[1]) * d[1]) / (d[0] ** 2 + d[1] ** 2);
}

function unitNormal(line) {
  const d = sub(line.b, line.a), length = Math.hypot(d[0], d[1]);
  return [-d[1] / length, d[0] / length];
}

function segmentDistance(p, line) {
  const t = Math.max(0, Math.min(1, along(line, p)));
  return dist(p, [line.a[0] + t * (line.b[0] - line.a[0]), line.a[1] + t * (line.b[1] - line.a[1])]);
}

/** Arc's bounding box, including the axis extremes inside its span. */
function arcBox(arc) {
  const points = [arc.start, arc.end];
  for (let k = 0; k < 4; k++) {
    const p = polar(arc.c, arc.r, k * Math.PI / 2);
    if (withinArc(arc, p)) points.push(p);
  }
  return points;
}

export function sketchBounds(sketch) {
  const points = [
    ...sketch.lines.flatMap(l => [l.a, l.b]),
    ...sketch.arcs.flatMap(a => arcBox({ c: a.center, r: a.radius, start: a.start, end: a.end })),
    ...sketch.circles.flatMap(c => [[c.center[0] - c.radius, c.center[1] - c.radius], [c.center[0] + c.radius, c.center[1] + c.radius]]),
    ...sketch.polylines.flatMap(p => p.points),
  ];
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Where two circles touch, if they are tangent within `tol`; else null. */
function circleTouch(c1, r1, c2, r2, tol) {
  const d = dist(c1, c2);
  if (d <= tol) return null;
  const u = [(c2[0] - c1[0]) / d, (c2[1] - c1[1]) / d];
  if (Math.abs(d - (r1 + r2)) <= tol) return { internal: false, point: polar(c1, r1, Math.atan2(u[1], u[0])) };
  if (Math.abs(d - Math.abs(r1 - r2)) <= tol) {
    // The touching point lies on the big circle, on the far side of the small one.
    const sign = r1 > r2 ? 1 : -1;
    return { internal: true, sign, point: [c1[0] + sign * u[0] * r1, c1[1] + sign * u[1] * r1] };
  }
  return null;
}

/** The affine maps (x → M·x + t) under which a set of points is unchanged. */
function symmetryCandidates(centre) {
  const [x, y] = centre, maps = [
    { name: 'mirror ↔', M: [[-1, 0], [0, 1]], t: [2 * x, 0] },
    { name: 'mirror ↕', M: [[1, 0], [0, -1]], t: [0, 2 * y] },
  ];
  for (let n = 2; n <= 8; n++) {
    const a = TAU / n, cos = Math.cos(a), sin = Math.sin(a);
    maps.push({ name: `${n}-fold rotation`, M: [[cos, -sin], [sin, cos]],
      t: [x - cos * x + sin * y, y - sin * x - cos * y] });
  }
  return maps;
}

const apply = (map, p) => [map.M[0][0] * p[0] + map.M[0][1] * p[1] + map.t[0],
  map.M[1][0] * p[0] + map.M[1][1] * p[1] + map.t[1]];

/**
 * Read the constraints the subject already satisfies.
 *
 * * nodes — where editable arcs end: joined to other arcs, pinned by a fixed
 *   endpoint, sliding on a fixed line or circle, or dangling free.
 * * tips — nodes where exactly two editable arcs meet at an angle: the
 *   pointy tips you drag.
 * * tangents — every arc tangent to a line, circle or other arc, kept so.
 * * symmetries — mirrors and rotations that map the editable arcs (and
 *   the fixed lines) onto themselves.
 */
export function analyseSketch(sketch) {
  const box = sketchBounds(sketch);
  const extent = Math.max(box[2] - box[0], box[3] - box[1]) || 1;
  const join = extent * 1e-4, touch = extent * 2e-4;
  const arcs = sketch.arcs.map(a => ({ c: [...a.center], r: a.radius, start: [...a.start], end: [...a.end],
    handle: a.handle, layer: a.layer }));
  const lines = sketch.lines.map(l => ({ a: l.a, b: l.b }));
  // Fixed circles and fixed arcs guide editable ones the same way.
  const guides = [...sketch.circles.map(c => ({ c: c.center, r: c.radius, start: null })),
    ...arcs.filter(a => !a.handle)];
  const editable = arcs.flatMap((a, i) => a.handle ? [i] : []);

  const nodes = [], ends = arcs.map(() => null);
  const nodeAt = p => {
    let j = nodes.findIndex(n => dist(n.p, p) <= join);
    if (j < 0) { j = nodes.length; nodes.push({ p: [...p], ends: [], fixed: false, lines: [], guides: [] }); }
    return j;
  };
  for (const i of editable) ends[i] = ['start', 'end'].map(end => {
    const j = nodeAt(arcs[i][end]);
    nodes[j].ends.push({ arc: i, end });
    return j;
  });
  const pins = [...lines.flatMap(l => [l.a, l.b]), ...guides.filter(g => g.start).flatMap(g => [g.start, g.end])];
  for (const n of nodes) {
    n.fixed = pins.some(q => dist(q, n.p) <= join);
    if (n.fixed) continue;
    lines.forEach((l, li) => { if (segmentDistance(n.p, l) <= join) n.lines.push(li); });
    guides.forEach((g, gi) => {
      if (Math.abs(dist(n.p, g.c) - g.r) <= join && (!g.start || withinArc(g, n.p, join / g.r))) n.guides.push(gi);
    });
    n.dangling = n.ends.length === 1 && !n.lines.length && !n.guides.length;
    if (n.dangling) n.angle = angleAt(arcs[n.ends[0].arc].c, n.p);
  }

  const tangent = (arc, p) => { const d = sub(p, arc.c); return [-d[1] / arc.r, d[0] / arc.r]; };
  const tips = nodes.flatMap((n, j) => {
    if (n.fixed || n.ends.length !== 2 || n.ends[0].arc === n.ends[1].arc) return [];
    const [t1, t2] = n.ends.map(e => tangent(arcs[e.arc], n.p));
    return Math.abs(t1[0] * t2[1] - t1[1] * t2[0]) > Math.sin(Math.PI / 90) ? [j] : [];
  });

  const tangents = [];
  for (const i of editable) {
    const arc = arcs[i], slack = touch / arc.r;
    lines.forEach((l, li) => {
      const n = unitNormal(l), d = n[0] * (arc.c[0] - l.a[0]) + n[1] * (arc.c[1] - l.a[1]);
      const foot = [arc.c[0] - d * n[0], arc.c[1] - d * n[1]], u = along(l, foot);
      const margin = touch / dist(l.a, l.b);
      if (Math.abs(Math.abs(d) - arc.r) <= touch && u >= -margin && u <= 1 + margin && withinArc(arc, foot, slack)) {
        tangents.push({ arc: i, line: li, side: Math.sign(d) });
      }
    });
    guides.forEach((g, gi) => {
      const hit = circleTouch(arc.c, arc.r, g.c, g.r, touch);
      if (hit && withinArc(arc, hit.point, slack) && (!g.start || withinArc(g, hit.point, touch / g.r))) {
        tangents.push({ arc: i, guide: gi, internal: hit.internal, sign: hit.sign });
      }
    });
    for (const k of editable) {
      if (k <= i) continue;
      const other = arcs[k], hit = circleTouch(arc.c, arc.r, other.c, other.r, touch);
      if (hit && withinArc(arc, hit.point, slack) && withinArc(other, hit.point, touch / other.r)) {
        tangents.push({ arc: i, other: k, internal: hit.internal, sign: hit.sign });
      }
    }
  }

  // A symmetry maps every editable arc onto one (its partner) and every line
  // onto a line, within a looser tolerance than CAD coincidence.
  const close = extent * 1e-3;
  const centres = [[(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]];
  if (editable.length) {
    const mean = [0, 1].map(k => editable.reduce((s, i) => s + arcs[i].c[k], 0) / editable.length);
    if (dist(mean, centres[0]) > close) centres.push(mean);
  }
  const symmetries = [];
  for (const centre of centres) for (const map of symmetryCandidates(centre)) {
    const partner = editable.map(i => {
      const c = apply(map, arcs[i].c), ends2 = [apply(map, arcs[i].start), apply(map, arcs[i].end)];
      return editable.find(k => dist(arcs[k].c, c) <= close && Math.abs(arcs[k].r - arcs[i].r) <= close
        && ends2.every(p => dist(p, arcs[k].start) <= close || dist(p, arcs[k].end) <= close));
    });
    const linesMap = lines.every(l => {
      const a = apply(map, l.a), b = apply(map, l.b);
      return lines.some(m => (dist(a, m.a) <= close && dist(b, m.b) <= close) || (dist(a, m.b) <= close && dist(b, m.a) <= close));
    });
    if (editable.length && partner.every(k => k !== undefined) && linesMap
      && !symmetries.some(s => s.name === map.name)) {
      symmetries.push({ ...map, partner: new Map(editable.map((i, n) => [i, partner[n]])) });
    }
  }

  return { arcs, lines, guides, editable, nodes, ends, tips, tangents, symmetries, extent, join, touch,
    polylines: sketch.polylines };
}

/** The editable state: every arc's centre and radius, every node's point. */
export function initialState(S) {
  return { c: S.arcs.map(a => [...a.c]), r: S.arcs.map(a => a.r), p: S.nodes.map(n => [...n.p]) };
}

/** Arcs as they stand in `state`, with their ends at the nodes. */
export function arcsOf(S, state) {
  return S.arcs.map((arc, i) => {
    if (!arc.handle) return arc;
    const c = state.c[i], r = state.r[i];
    const [start, end] = S.ends[i].map(j => S.nodes[j].dangling ? polar(c, r, S.nodes[j].angle) : state.p[j]);
    return { ...arc, c, r, start, end };
  });
}

/** How far the two circles of a tip overlap along the line of their centres. */
export function tipOverlap(S, state, node) {
  const [i, k] = S.nodes[node].ends.map(e => e.arc);
  return state.r[i] + state.r[k] - dist(state.c[i], state.c[k]);
}

/** Variables: x, y, r of each editable arc, then x, y of each moving node. */
function variables(S, state) {
  const index = { arc: new Map(), node: new Map() }, x = [];
  for (const i of S.editable) { index.arc.set(i, x.length); x.push(state.c[i][0], state.c[i][1], state.r[i]); }
  S.nodes.forEach((n, j) => {
    if (n.fixed || n.dangling) return;
    index.node.set(j, x.length); x.push(state.p[j][0], state.p[j][1]);
  });
  return { index, x };
}

/** Each row returns [value, [[variable, derivative], ...]] for the current x. */
function rows(S, index, targets, symmetric) {
  const out = [];
  const arc = (x, i) => { const v = index.arc.get(i); return { c: [x[v], x[v + 1]], r: x[v + 2], v }; };
  const node = (x, j) => {
    const v = index.node.get(j);
    return v === undefined ? { p: S.nodes[j].p, v } : { p: [x[v], x[v + 1]], v };
  };
  // |P - c| - r, with derivatives for whichever of P, c, r are variables.
  const onCircle = (P, pv, c, cv, r, rv) => {
    const d = sub(P, c), length = Math.hypot(d[0], d[1]) || 1e-12, u = [d[0] / length, d[1] / length], g = [];
    if (pv !== undefined) g.push([pv, u[0]], [pv + 1, u[1]]);
    if (cv !== undefined) g.push([cv, -u[0]], [cv + 1, -u[1]]);
    if (rv !== undefined) g.push([rv, -1]);
    return [length - r, g];
  };
  S.nodes.forEach((n, j) => {
    if (n.dangling) return;
    for (const { arc: i } of n.ends) out.push({ hard: true, f: x => {
      const a = arc(x, i), P = node(x, j);
      return onCircle(P.p, P.v, a.c, a.v, a.r, a.v + 2);
    } });
    if (n.fixed) return;
    for (const li of n.lines) {
      const l = S.lines[li], nn = unitNormal(l);
      out.push({ hard: true, f: x => {
        const P = node(x, j);
        return [nn[0] * (P.p[0] - l.a[0]) + nn[1] * (P.p[1] - l.a[1]), [[P.v, nn[0]], [P.v + 1, nn[1]]]];
      } });
    }
    for (const gi of n.guides) {
      const g = S.guides[gi];
      out.push({ hard: true, f: x => { const P = node(x, j); return onCircle(P.p, P.v, g.c, undefined, g.r, undefined); } });
    }
  });
  for (const t of S.tangents) {
    if (t.line !== undefined) {
      const l = S.lines[t.line], nn = unitNormal(l);
      out.push({ hard: true, f: x => {
        const a = arc(x, t.arc);
        return [t.side * (nn[0] * (a.c[0] - l.a[0]) + nn[1] * (a.c[1] - l.a[1])) - a.r,
          [[a.v, t.side * nn[0]], [a.v + 1, t.side * nn[1]], [a.v + 2, -1]]];
      } });
      continue;
    }
    out.push({ hard: true, f: x => {
      const a = arc(x, t.arc), b = t.other !== undefined ? arc(x, t.other) : { ...S.guides[t.guide], v: undefined };
      const [d, g] = onCircle(a.c, a.v, b.c, b.v, 0, undefined);
      // External: d = ra + rb. Internal: d = sign·(ra − rb).
      const ka = t.internal ? t.sign : 1, kb = t.internal ? -t.sign : 1;
      g.push([a.v + 2, -ka]);
      if (b.v !== undefined) g.push([b.v + 2, -kb]);
      return [d - ka * a.r - kb * b.r, g];
    } });
  }
  if (symmetric) for (const map of S.symmetries) for (const [i, k] of map.partner) {
    // Partner k is arc i mapped: c_k = M·c_i + t, r_k = r_i.
    for (const row of [0, 1]) out.push({ hard: true, f: x => {
      const a = arc(x, i), b = arc(x, k);
      const g = [[a.v, map.M[row][0]], [a.v + 1, map.M[row][1]]];
      const merged = new Map(g);
      merged.set(b.v + row, (merged.get(b.v + row) ?? 0) - 1);
      return [map.M[row][0] * a.c[0] + map.M[row][1] * a.c[1] + map.t[row] - b.c[row], [...merged]];
    } });
    if (i !== k) out.push({ hard: true, f: x => {
      const a = arc(x, i), b = arc(x, k);
      return [a.r - b.r, [[a.v + 2, 1], [b.v + 2, -1]]];
    } });
  }
  for (const target of targets) {
    if (target.type === 'node') for (const k of [0, 1]) out.push({ f: x => {
      const P = node(x, target.node);
      return [P.p[k] - target.at[k], [[P.v + k, 1]]];
    } });
    if (target.type === 'radius') out.push({ f: x => {
      const a = arc(x, target.arc);
      return [a.r - target.value, [[a.v + 2, 1]]];
    } });
    if (target.type === 'overlap') {
      const [i, k] = S.nodes[target.node].ends.map(e => e.arc);
      out.push({ f: x => {
        const a = arc(x, i), b = arc(x, k), [d, g] = onCircle(a.c, a.v, b.c, b.v, 0, undefined);
        return [a.r + b.r - d - target.value, [...g.map(([v, value]) => [v, -value]), [a.v + 2, 1], [b.v + 2, 1]]];
      } });
    }
  }
  return out;
}

/** Solve (A + λI)·y = b for a symmetric positive semi-definite A (Cholesky). */
function solveSPD(A, b) {
  const n = b.length, L = A.map(row => [...row]);
  const scale = Math.max(1e-30, ...A.map((row, i) => Math.abs(row[i])));
  for (let i = 0; i < n; i++) L[i][i] += scale * 1e-12;
  for (let j = 0; j < n; j++) {
    let s = L[j][j];
    for (let k = 0; k < j; k++) s -= L[j][k] ** 2;
    L[j][j] = Math.sqrt(Math.max(s, scale * 1e-14));
    for (let i = j + 1; i < n; i++) {
      let t = L[i][j];
      for (let k = 0; k < j; k++) t -= L[i][k] * L[j][k];
      L[i][j] = t / L[j][j];
    }
  }
  const y = [...b];
  for (let i = 0; i < n; i++) { for (let k = 0; k < i; k++) y[i] -= L[i][k] * y[k]; y[i] /= L[i][i]; }
  for (let i = n - 1; i >= 0; i--) { for (let k = i + 1; k < n; k++) y[i] -= L[k][i] * y[k]; y[i] /= L[i][i]; }
  return y;
}

/**
 * Move the subject so `targets` hold while every constraint keeps holding.
 *
 * Targets: `{type: 'node', node, at: [x, y]}` drags a tip, `{type:
 * 'radius', arc, value}` sets an arc's radius, `{type: 'overlap', node,
 * value}` sets how far a tip's two circles overlap. The arcs the target
 * names (and their symmetric copies) reshape; every other arc stays put
 * while that can work, else moves as little as it must, and nodes slide
 * freely. Returns `{ok: true, state}` or `{ok: false, reason}`.
 */
export function solve(S, state, targets, { symmetric = true } = {}) {
  const named = new Set(targets.flatMap(t => t.type === 'radius' ? [t.arc] : S.nodes[t.node].ends.map(e => e.arc)));
  if (symmetric) for (const map of S.symmetries) for (const [i, k] of map.partner) if (named.has(i)) named.add(k);
  const held = solveWith(S, state, targets, symmetric, named, true);
  return held.ok ? held : solveWith(S, state, targets, symmetric, named, false);
}

function solveWith(S, state, targets, symmetric, named, hold) {
  const { index, x } = variables(S, state);
  const all = rows(S, index, targets, symmetric);
  const weight = new Array(x.length).fill(1e-2), frozen = new Set();
  for (const [i, v] of index.arc) for (const k of [0, 1, 2]) {
    weight[v + k] = named.has(i) ? 1 : 1e3;
    if (hold && !named.has(i)) frozen.add(v + k);
  }

  // Only the rows tied (through shared, unfrozen variables) to a target take part.
  const varsOf = all.map(row => row.f(x)[1].map(([v]) => v)), rowsOf = new Map();
  varsOf.forEach((vs, r) => { for (const v of vs) rowsOf.set(v, [...rowsOf.get(v) ?? [], r]); });
  const seen = new Set(), touched = new Set(), pending = all.flatMap((row, r) => row.hard ? [] : [r]);
  while (pending.length) {
    const r = pending.pop();
    if (seen.has(r)) continue;
    seen.add(r);
    for (const v of varsOf[r]) if (!touched.has(v) && !frozen.has(v)) { touched.add(v); pending.push(...rowsOf.get(v)); }
  }
  const active = [...seen].map(r => all[r]);
  const vars = [...touched], column = new Map(vars.map((v, k) => [v, k]));
  const tolerance = S.extent * 1e-9, cap = S.extent / 4;
  let residual = Infinity;
  for (let iteration = 0; iteration < 60; iteration++) {
    const evaluated = active.map(row => row.f(x));
    const F = evaluated.map(([value]) => value);
    residual = Math.max(0, ...F.map(Math.abs));
    if (residual <= tolerance) break;
    // Weighted minimum-norm Gauss–Newton step: Δ = W⁻¹Jᵀ(JW⁻¹Jᵀ)⁻¹(−F).
    const J = evaluated.map(([, g]) => {
      const row = new Array(vars.length).fill(0);
      for (const [v, d] of g) if (column.has(v)) row[column.get(v)] += d;
      return row;
    });
    const A = J.map(a => J.map(b => a.reduce((s, value, k) => s + value * b[k] / weight[vars[k]], 0)));
    const y = solveSPD(A, F.map(value => -value));
    const step = vars.map((v, k) => J.reduce((s, row, m) => s + row[k] * y[m], 0) / weight[v]);
    const length = Math.hypot(...step);
    const factor = length > cap ? cap / length : 1;
    vars.forEach((v, k) => { x[v] += factor * step[k]; });
  }
  if (!(residual <= tolerance * 1e3)) return { ok: false, reason: 'No shape keeps every tangency with that change.' };

  const next = { c: state.c.map(c => [...c]), r: [...state.r], p: state.p.map(p => [...p]) };
  for (const [i, v] of index.arc) { next.c[i] = [x[v], x[v + 1]]; next.r[i] = x[v + 2]; }
  for (const [j, v] of index.node) next.p[j] = [x[v], x[v + 1]];
  const reason = invalid(S, state, next);
  return reason ? { ok: false, reason } : { ok: true, state: next };
}

/** Why a solved state cannot be drawn, or '' when it can. */
function invalid(S, before, after) {
  const was = arcsOf(S, before), now = arcsOf(S, after);
  for (const i of S.editable) {
    if (!(now[i].r > S.join)) return 'An arc would shrink to nothing.';
    const a = arcSweep(was[i]), b = arcSweep(now[i]);
    if (Math.abs(a - b) > TAU / 3) return 'An arc would turn inside out.';
  }
  for (const t of S.tangents) {
    const arc = now[t.arc];
    if (t.line === undefined) continue;
    const l = S.lines[t.line], n = unitNormal(l), d = n[0] * (arc.c[0] - l.a[0]) + n[1] * (arc.c[1] - l.a[1]);
    const foot = [arc.c[0] - d * n[0], arc.c[1] - d * n[1]], u = along(l, foot), margin = S.touch / dist(l.a, l.b);
    if (u < -margin || u > 1 + margin) return 'An arc would slide off the end of the line it touches.';
    if (!withinArc(arc, foot, S.touch / arc.r)) return 'An arc would lose the line it touches.';
  }
  for (const [j, n] of S.nodes.entries()) for (const li of n.lines || []) {
    const u = along(S.lines[li], after.p[j]);
    if (u < 0 || u > 1) return 'A tip would slide off the end of its line.';
  }
  return '';
}

/** Arc edits for the converter: every editable arc that changed. */
export function arcEdits(S, state) {
  const original = S.arcs, now = arcsOf(S, state);
  return S.editable.filter(i => ['c', 'start', 'end'].some(k => dist(original[i][k], now[i][k]) > 1e-9)
    || Math.abs(original[i].r - now[i].r) > 1e-9).map(i => ({
    handle: now[i].handle, center: now[i].c, radius: now[i].r, start: now[i].start, end: now[i].end }));
}

/** Distance from `p` to an arc. */
export function arcDistance(arc, p) {
  return withinArc(arc, p) ? Math.abs(dist(arc.c, p) - arc.r) : Math.min(dist(arc.start, p), dist(arc.end, p));
}

/** Where each kept tangency touches, for drawing. */
export function tangentPoints(S, state) {
  const now = arcsOf(S, state);
  return S.tangents.map(t => {
    const arc = now[t.arc];
    if (t.line !== undefined) {
      const l = S.lines[t.line], n = unitNormal(l), d = n[0] * (arc.c[0] - l.a[0]) + n[1] * (arc.c[1] - l.a[1]);
      return [arc.c[0] - d * n[0], arc.c[1] - d * n[1]];
    }
    const other = t.other !== undefined ? now[t.other] : S.guides[t.guide];
    const u = sub(other.c, arc.c), d = Math.hypot(u[0], u[1]) || 1, s = t.internal ? t.sign : 1;
    return [arc.c[0] + s * u[0] / d * arc.r, arc.c[1] + s * u[1] / d * arc.r];
  });
}
