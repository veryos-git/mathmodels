// The tip editor's solver on the reference quatrefoil (hgc_requirements_
// documentation/change_path): four arcs, each tangent to two sides of a
// rhombus, meeting at four pointy tips. "lesspointz" is the same rhombus with
// the tips dragged out in CAD; dragging here must land on the same arcs.
import assert from 'node:assert/strict';
import { analyseSketch, initialState, solve, arcsOf, tipOverlap, arcEdits } from '../static/tip-editor-geometry.js';

const PY = Deno.build.os === 'windows' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
const DIR = 'hgc_requirements_documentation/change_path/examples';

async function sketch(path) {
  const { code, stdout, stderr } = await new Deno.Command(PY, { args: ['tools/dxf2stl.py', path, '--sketch'] }).output();
  assert.equal(code, 0, new TextDecoder().decode(stderr));
  return JSON.parse(new TextDecoder().decode(stdout));
}

const near = (a, b, tol, message) => assert(Math.abs(a - b) <= tol, `${message}: ${a} vs ${b}`);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

const pointy = await sketch(`${DIR}/Part Studio 1 - Sketch 1 (1).dxf`);
const goal = await sketch(`${DIR}/lesspointz/Part Studio 1 - Sketch 1 (2).dxf`);
const S = analyseSketch(pointy);
assert.equal(S.tips.length, 4, 'four pointy tips');
assert.equal(S.tangents.length, 8, 'each arc touches two sides of the rhombus');
assert.deepEqual(S.symmetries.map(s => s.name).filter(n => n.startsWith('mirror')), ['mirror ↔', 'mirror ↕']);
const start = initialState(S);
const tip = S.tips.find(j => S.nodes[j].p[0] > 0 && S.nodes[j].p[1] > 0);

/** Every kept tangency and junction holds in `state`. */
function holds(state) {
  const arcs = arcsOf(S, state);
  for (const t of S.tangents) {
    const l = S.lines[t.line], arc = arcs[t.arc];
    const d = Math.abs((l.b[0] - l.a[0]) * (arc.c[1] - l.a[1]) - (l.b[1] - l.a[1]) * (arc.c[0] - l.a[0])) / dist(l.a, l.b);
    near(d, arc.r, 1e-7, 'arc stays tangent to its line');
  }
  for (const [j, n] of S.nodes.entries()) for (const { arc } of n.ends) near(dist(state.p[j], arcs[arc].c), arcs[arc].r, 1e-7, 'tips stay on both arcs');
}

// Symmetric drag to the CAD reference's tip.
const target = goal.arcs.find(a => a.start[0] > 0 && a.start[1] < 0).end;     // right arc's upper end
const dragged = solve(S, start, [{ type: 'node', node: tip, at: target }]);
assert(dragged.ok, dragged.reason);
holds(dragged.state);
const arcs = arcsOf(S, dragged.state);
for (const want of goal.arcs) {
  const got = arcs.find(a => a.handle === want.handle);
  near(dist(got.c, want.center), 0, 2e-4, `${want.handle} centre`);
  near(got.r, want.radius, 2e-4, `${want.handle} radius`);
  near(dist(got.start, want.start), 0, 2e-4, `${want.handle} start`);
  near(dist(got.end, want.end), 0, 2e-4, `${want.handle} end`);
}
assert.equal(arcEdits(S, dragged.state).length, 4, 'all four arcs are written back');
assert.equal(arcEdits(S, start).length, 0, 'an untouched subject writes nothing');

// Without symmetry only the tip's own two arcs change; the neighbouring tips
// slide along the arcs that did not move.
const free = solve(S, start, [{ type: 'node', node: tip, at: target }], { symmetric: false });
assert(free.ok, free.reason);
holds(free.state);
const own = new Set(S.nodes[tip].ends.map(e => e.arc));
for (const i of S.editable) {
  const moved = dist(free.state.c[i], start.c[i]) + Math.abs(free.state.r[i] - start.r[i]);
  if (own.has(i)) assert(moved > 1, `arc ${i} at the tip reshapes`);
  else near(moved, 0, 1e-9, `arc ${i} away from the tip stays`);
}
near(dist(free.state.p[tip], target), 0, 1e-9, 'the tip lands where it was dragged');

// Typed values: an arc radius, and how far a tip's two circles overlap.
const right = S.editable.find(i => start.c[i][0] > 1);
const left = S.editable.find(i => start.c[i][0] < -1);
const sized = solve(S, start, [{ type: 'radius', arc: right, value: 10 }]);
assert(sized.ok, sized.reason);
holds(sized.state);
near(sized.state.r[right], 10, 1e-9, 'radius set');
near(sized.state.r[left], 10, 1e-9, 'its mirror image follows');
const overlap = solve(S, start, [{ type: 'overlap', node: tip, value: 1 }]);
assert(overlap.ok, overlap.reason);
holds(overlap.state);
near(tipOverlap(S, overlap.state, tip), 1, 1e-9, 'overlap set');
assert(tipOverlap(S, start, tip) > 2, 'the reference tip overlaps more');

// Impossible requests leave the subject alone and say why.
for (const request of [{ type: 'node', node: tip, at: [40, 40] }, { type: 'radius', arc: right, value: 60 }]) {
  const result = solve(S, start, [request]);
  assert.equal(result.ok, false, JSON.stringify(request));
  assert.match(result.reason, /\w/);
}
assert.deepEqual(initialState(S), start, 'solving never mutates its starting state');
console.log('Tip editor: reference drag, asymmetric drag, radius, overlap and impossible requests passed.');
