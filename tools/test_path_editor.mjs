// The path editor's geometry: DXF ends slide along their own line or circle,
// joined ends follow, typed fields reshape one end, and SVG path data reads
// and writes back point for point.
import assert from 'node:assert/strict';
import * as G from '../static/path-editor-geometry.js';

const near = (a, b, tol, message) => assert(Math.abs(a - b) <= tol, `${message}: ${a} vs ${b}`);
const nearPoint = (a, b, tol, message) => near(G.dist(a, b), 0, tol, message);
const deg = a => a * 180 / Math.PI, rad = a => a * Math.PI / 180;
const on = (c, r, a) => [c[0] + r * Math.cos(rad(a)), c[1] + r * Math.sin(rad(a))];

// A hanger hook as CAD exports it: the hook arc (−90° → 150° on r 40), a
// duplicate piece over its tip end (30° → 150°), a bar meeting its foot, and
// a fixed arc from a block.
const C = [0, 55];
const sketch = {
  lines: [{ handle: 'L1', layer: '0', a: [60, 15], b: on(C, 40, -90) }, { handle: null, layer: '0', a: [0, 0], b: [1, 0] }],
  arcs: [
    { handle: 'HOOK', layer: '0', center: C, radius: 40, start: on(C, 40, -90), end: on(C, 40, 150) },
    { handle: 'DUP', layer: '0', center: C, radius: 40, start: on(C, 40, 30), end: on(C, 40, 150) },
    { handle: null, layer: '0', center: [0, 0], radius: 5, start: [5, 0], end: [0, 5] },
  ],
  circles: [{ handle: 'EYE', layer: '0', center: [-60, 15], radius: 4 }],
  polylines: [{ layer: '0', points: [[0, 0], [1, 1]] }],
};
const { entities, fixed } = G.dxfEntities(sketch);
assert.deepEqual(entities.map(e => e.handle), ['L1', 'HOOK', 'DUP', 'EYE']);
assert.equal(fixed.length, 3, 'unhandled line, block arc and polyline stay fixed');
const hook = entities[1];
near(deg(hook.sweep), 240, 1e-9, 'hook sweep');
const tolerance = 1e-4 * 200;

// Dragging the hook's tip 30° further round extends it on its own circle;
// the duplicate's end follows, the bar at the foot does not move.
const joins = G.joinsOf(entities, 1, tolerance, ['end']);
assert.deepEqual(joins.get('end'), [[2, 'end']]);
const extended = G.dragHandle(hook, 'end', on(C, 55, 180));
near(deg(extended.sweep), 270, 1e-9, 'extended sweep');
assert.deepEqual([extended.c, extended.r, extended.start], [hook.c, hook.r, hook.start], 'centre, radius and foot stay');
let state = G.withFollowers(entities, 1, extended, joins, tolerance);
near(deg(state[2].start), 30, 1e-9, 'duplicate keeps its own start');
near(deg(state[2].sweep), 150, 1e-9, 'duplicate follows the tip');
assert.equal(state[0], entities[0], 'the bar is untouched');
const edits = G.dxfEdits(entities, state);
assert.deepEqual(edits.map(e => [e.kind, e.handle]), [['arc', 'HOOK'], ['arc', 'DUP']]);
nearPoint(edits[0].end, on(C, 40, 180), 1e-9, 'written tip');
nearPoint(edits[0].start, on(C, 40, -90), 1e-9, 'written foot');
const moves = G.movedEnds(entities, state);
assert.equal(moves.length, 1, 'the shared tip moved once');
nearPoint(moves[0][1], on(C, 40, 180), 1e-9, 'tip moved to');

// The tip cannot slide past the foot: the arc stops just short of a circle.
let previous = hook;
for (let a = 150; a <= 300; a += 10) previous = G.dragHandle(hook, 'end', on(C, 40, a), { previous });
near(deg(previous.sweep), 360 - deg(G.MIN_SWEEP), 1e-9, 'stops short of closing');
previous = hook;
for (let a = 150; a >= -120; a -= 10) previous = G.dragHandle(hook, 'end', on(C, 40, a), { previous });
near(previous.sweep, G.MIN_SWEEP, 1e-9, 'stops short of vanishing');

// Shift-drag: the end goes anywhere and the arc keeps its bend.
const free = G.dragHandle(hook, 'end', [-50, 50], { free: true });
near(free.sweep, hook.sweep, 1e-12, 'bend kept');
nearPoint(G.endsOf(free)[0][1], on(C, 40, -90), 1e-9, 'foot kept');
nearPoint(G.endsOf(free)[1][1], [-50, 50], 1e-9, 'tip where dropped');

// The middle handle bends the arc through the pointer, ends fixed.
const bent = G.dragHandle(state[2], 'mid', on(C, 30, 90));
nearPoint(G.endsOf(bent)[0][1], on(C, 40, 30), 1e-9, 'bent start kept');
nearPoint(G.endsOf(bent)[1][1], on(C, 40, 180), 1e-9, 'bent end kept');
near(G.dist(bent.c, on(C, 30, 90)), bent.r, 1e-9, 'passes through the pointer');
const flat = G.dragHandle(state[2], 'mid', [0, -100]);
assert.equal(flat.sweep, G.MIN_SWEEP, 'pulled through the chord it flattens');

// Line ends slide along the line, or anywhere with Shift; a joined arc end follows.
const bar = entities[0], foot = G.joinsOf(entities, 0, tolerance, ['b']);
assert.deepEqual(foot.get('b'), [[1, 'start']]);
const shorter = G.dragHandle(bar, 'b', [10, 30]);
assert.deepEqual(shorter.a, bar.a, 'the other end stays');
assert(G.dist(shorter.a, shorter.b) < G.dist(bar.a, bar.b), 'dragged inwards it shortens');
near(Math.abs((shorter.b[0] - bar.a[0]) * (bar.b[1] - bar.a[1]) - (shorter.b[1] - bar.a[1]) * (bar.b[0] - bar.a[0])), 0, 1e-9, 'stays on its line');
const moved = G.dragHandle(bar, 'b', [5, 20], { free: true });
state = G.withFollowers(entities, 0, moved, foot, tolerance);
nearPoint(G.endsOf(state[1])[0][1], [5, 20], 1e-9, 'hook foot follows the bar');
near(state[1].sweep, hook.sweep, 1e-12, 'off its circle, the hook keeps its bend');
nearPoint(G.endsOf(state[1])[1][1], on(C, 40, 150), 1e-9, 'and its tip');

// Moving the whole hook drags the bar's end and the duplicate along.
const all = G.joinsOf(entities, 1, tolerance);
state = G.withFollowers(entities, 1, G.translate(hook, [3, 4]), all, tolerance);
nearPoint(state[0].b, [3, 19], 1e-9, 'bar end follows a moved hook');
nearPoint(G.endsOf(state[2])[1][1], [on(C, 40, 150)[0] + 3, on(C, 40, 150)[1] + 4], 1e-9, 'duplicate tip follows');

// Typed fields reshape one end each.
near(deg(G.setField(hook, 'end', 180).sweep), 270, 1e-9, 'end angle extends');
const fromStart = G.setField(hook, 'start', -120);
near(deg(fromStart.start + fromStart.sweep) % 360, 150, 1e-9, 'start angle keeps the end');
near(deg(fromStart.sweep), 270, 1e-9, 'start angle extends the other way');
near(deg(G.setField(hook, 'sweep', 300).sweep), 300, 1e-9, 'sweep');
assert.equal(G.setField(hook, 'sweep', 400), null, 'no sweep beyond a circle');
assert.equal(G.setField(hook, 'radius', -1), null, 'no negative radius');
near(G.dist(...['a', 'b'].map(k => G.setField(bar, 'length', 100)[k])), 100, 1e-9, 'line length');
assert.deepEqual(G.setField(entities[3], 'cy', 20).c, [-60, 20], 'circle centre');
assert.match(G.invalid({ ...bar, b: bar.a }, 200), /nothing/);

/* ---------------------------------------------------------------- SVG */

const segs = G.parsePathData('m10 10 20 0 h5 v-5 c0-5 5-5 5 0 s5 5 10 0 q5-5 10 0 t10 0 a5 5 0 1010 0z M0 0L1 1');
assert.deepEqual(segs.map(s => s.cmd), ['M', 'L', 'L', 'L', 'C', 'C', 'Q', 'Q', 'A', 'Z', 'M', 'L']);
assert.deepEqual(segs[1].p, [30, 10], 'implicit lineto after a relative move');
assert.deepEqual([segs[2].p, segs[3].p], [[35, 10], [35, 5]], 'H and V');
assert.deepEqual(segs[5].c1, [40, 10], 'S reflects the previous control');
assert.deepEqual(segs[7].c1, [65, 10], 'T reflects the previous control');
assert.deepEqual([segs[8].large, segs[8].sweep, segs[8].p], [1, 0, [80, 5]], 'packed arc flags');
assert.deepEqual(G.parsePathData(G.formatPathData(segs)), segs, 'written path data reads back the same');
assert.throws(() => G.parsePathData('L0 0'), /move/);
assert.throws(() => G.parsePathData('M0 0 C1 1'), /cut short/);

// A path under a transform: points move in root units, controls come along,
// and an anchor of another path at the same point follows.
const m = [2, 0, 0, 2, 100, 0];
const curve = { kind: 'path', tag: 'path', m, segs: G.parsePathData('M0 0 C0 10 10 10 10 0 C10 -10 20 -10 20 0') };
const other = { kind: 'path', tag: 'path', m: [1, 0, 0, 1, 0, 0], segs: G.parsePathData('M120 0 L150 0') };
const paths = [curve, other];
assert.deepEqual(G.handlesOf(curve, 'p:1').filter(h => h.role === 'control').map(h => h.key), ['c2:1', 'c1:2']);
const pathJoins = G.joinsOf(paths, 0, 1e-6, ['p:1']);
assert.deepEqual(pathJoins.get('p:1'), [[1, 'p:0']]);
const dragged = G.dragHandle(curve, 'p:1', [124, 6]);
assert.deepEqual(dragged.segs[1].p, [12, 3], 'point in local units');
assert.deepEqual([dragged.segs[1].c2, dragged.segs[2].c1], [[12, 13], [12, -7]], 'its controls move with it');
assert.deepEqual(dragged.segs[1].c1, [0, 10], 'the far control stays');
const followed = G.withFollowers(paths, 0, dragged, pathJoins, 1e-6);
assert.deepEqual(followed[1].segs[0].p, [124, 6], 'the touching path follows');
assert.deepEqual(G.translate(curve, [2, 4]).segs[0].p, [1, 2], 'moves in root units');
assert.deepEqual(G.setField(curve, 'y', 8, 'p:0').segs[0].p, [0, 4], 'typed point');
assert.equal(G.formatPoints(G.pointSegments('1,2 3 4', true)), '1,2 3,4');

const root = values => ({ getAttribute: name => values[name] ?? null });
near(G.svgMillimetres(root({})), 25.4 / 96, 1e-12, 'plain pixels');
near(G.svgMillimetres(root({ width: '100mm', height: '50mm', viewBox: '0 0 100 50' })), 1, 1e-12, 'millimetre viewBox');
near(G.svgMillimetres(root({ width: '200mm', viewBox: '0 0 100 50' })), 2, 1e-12, 'width only');

console.log('path editor geometry: ok');
