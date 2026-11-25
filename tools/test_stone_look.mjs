import assert from 'node:assert/strict';
import { creasedNormals } from '../static/stone-look.js';

const near = (actual, expected, message) => {
  assert.equal(actual.length, expected.length, message);
  actual.forEach((value, i) => assert(Math.abs(value - expected[i]) < 1e-5, `${message}: ${[...actual]} vs ${expected}`));
};
const corner = (normals, i) => normals.slice(3 * i, 3 * i + 3);

// A box: every edge is a right angle, so each corner keeps its own face's normal.
const quad = (a, b, c, d) => [...a, ...b, ...c, ...a, ...c, ...d];
const box = new Float32Array([
  ...quad([0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]),     // top, +z
  ...quad([0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]),     // bottom, -z
  ...quad([0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]),     // front, -y
  ...quad([1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]),     // right, +x
]);
const boxNormals = creasedNormals(box);
for (const [face, normal] of [[0, [0, 0, 1]], [1, [0, 0, -1]], [2, [0, -1, 0]], [3, [1, 0, 0]]]) {
  for (let i = 0; i < 6; i++) near(corner(boxNormals, 6 * face + i), normal, `box face ${face} stays flat`);
}

// A drum: its side facets meet at 15°, so they blend into a round surface whose
// normals point straight out from the axis. The lids meet it at 90° and stay flat.
const drum = [];
// The last facet has to end on the very point the first began at, bit for bit.
const segments = 24, turn = (i) => 2 * Math.PI * (i % segments) / segments;
const rim = (i, z) => [Math.cos(turn(i)), Math.sin(turn(i)), z];
for (let i = 0; i < segments; i++) {
  drum.push(...quad(rim(i, 0), rim(i + 1, 0), rim(i + 1, 1), rim(i, 1)));
  drum.push(...rim(i, 1), ...rim(i + 1, 1), 0, 0, 1);
}
const drumSoup = new Float32Array(drum), drumNormals = creasedNormals(drumSoup);
for (let c = 0; c < drumSoup.length / 3; c++) {
  const [x, y] = corner(drumSoup, c), lid = c % 9 >= 6;
  near(corner(drumNormals, c), lid ? [0, 0, 1] : [x, y, 0], lid ? 'drum lid stays flat' : 'drum side is round');
}
// The same drum with every edge taken as an arris is faceted again.
const faceted = creasedNormals(drumSoup, Math.PI / 180);
assert.notDeepEqual(corner(faceted, 0), corner(faceted, 9), 'a tighter crease angle keeps the facets');
near(corner(faceted, 0), corner(faceted, 5), 'a facet has one normal');

// A shallow ridge, one slope a single triangle and the other cut into two. At
// the ridge's end both slopes span a right angle, so the blended normal leans
// to neither: counting triangles, or their areas, would tip it.
const rise = Math.tan(Math.PI / 18);
const ridge = new Float32Array([
  0, 0, 0, 0, 1, 0, -1, 0, -rise,
  0, 0, 0, 1, 0.5, -rise, 0, 1, 0,
  0, 0, 0, 1, 0, -rise, 1, 0.5, -rise,
]);
const ridgeNormals = creasedNormals(ridge);
near(corner(ridgeNormals, 0), [0, 0, 1], 'slopes weigh in by the angle they span, not by their triangles');
near(corner(ridgeNormals, 3), [0, 0, 1], 'every corner at the vertex agrees');

// -0 and +0 are the same point; a zero-area triangle has no normal to give.
const folded = creasedNormals(new Float32Array([
  0, 0, 0, 1, 0, 0, 0, 1, 0,
  -0, 0, -0, 0, 1, 0, -1, 0, 0.1,
  5, 5, 5, 5, 5, 5, 6, 6, 6,
]));
assert(folded[0] > 0.01 && folded[2] > 0.99, 'corners at -0 and +0 are welded');
near(corner(folded, 0), corner(folded, 3), 'welded corners share the blended normal');
near(folded.slice(18), new Array(9).fill(0), 'a zero-area triangle comes back empty');
assert.equal(creasedNormals(new Float32Array(0)).length, 0);

// Large soups stay quick: this is done on the page whenever a model is rebuilt.
const big = new Float32Array(9 * 300000);
for (let t = 0; t < 300000; t++) {
  const x = t % 1000, y = Math.floor(t / 1000);
  big.set([x, y, 0, x + 1, y, 0, x, y + 1, Math.sin(x) * 0.01], 9 * t);
}
const started = performance.now();
creasedNormals(big);
assert(performance.now() - started < 2000, 'creasing 300,000 triangles takes well under two seconds');

console.log('stone look tests passed');
