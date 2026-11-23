// Vector conversion regression tests adapted from jonasfrey/shadertracev2.
// Source revision and local changes: static/vendor/shadertrace/README.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  convertParsed,
  convertVector,
  parseVector,
} from "../static/vendor/shadertrace/vector-import/index.js";
import {
  evaluateGeometry,
  flatten,
  LIMITS,
  Path,
} from "../static/vendor/shadertrace/vector-import/geometry.js";
import { parsePath } from "../static/vendor/shadertrace/vector-import/svg-path.js";
import { transform } from "../static/vendor/shadertrace/vector-import/svg.js";

export const entity = (type, pairs = []) => [[0, type], ...pairs];
export function dxf(entities, blocks = []) {
  const pairs = [
    ...(blocks.length
      ? [[0, "SECTION"], [2, "BLOCKS"], ...blocks.flat(), [0, "ENDSEC"]]
      : []),
    [0, "SECTION"],
    [2, "ENTITIES"],
    ...entities.flat(),
    [0, "ENDSEC"],
    [0, "EOF"],
  ];
  return pairs.flat().join("\n") + "\n";
}
const circle = (x, y, r) => entity("CIRCLE", [[10, x], [20, y], [40, r]]);
const line = (x, y, a, b) =>
  entity("LINE", [[10, x], [20, y], [11, a], [21, b]]);
const value = (result, p) => evaluateGeometry(result.geometry.groups, p);
// Concentric circles: 64 segments each at the default tolerance, 256 at the finest.
const rings = (count) =>
  dxf(Array.from({ length: count }, (_, i) => circle(0, 0, 10 + i * 0.01)));

test("DXF circles preserve nested holes, signs, and distance magnitude", () => {
  const result = convertVector(dxf([circle(0, 0, 10), circle(0, 0, 4)]), "dxf");
  assert.ok(value(result, [0, 0]) > 0.29);
  assert.ok(value(result, [0.5, 0]) < 0);
  assert.ok(value(result, [0.9, 0]) > 0);
  assert.ok(Math.abs(value(result, [0.9, 0]) - 0.15) < 0.003);
  assert.match(result.code, /float sdf\(vec2 p\)/);
  assert.ok(result.stats.segments < 200);
});
test("DXF stitches shuffled and reversed LINE edges into a filled contour", () => {
  const r = convertVector(
    dxf([
      line(10, 10, 0, 10),
      line(0, 0, 10, 0),
      line(0, 10, 0, 0),
      line(10, 10, 10, 0),
    ]),
    "dxf",
  );
  assert.equal(r.stats.segments, 4);
  assert.ok(value(r, [0, 0]) < -0.7);
});
test("Entities exported more than once are drawn once", () => {
  // CAD sketches repeat shared edges: here a circle twice and one side of a square
  // three times, once reversed and once off by rounding.
  const square = [
    line(0, 0, 10, 0),
    line(10, 0, 10, 10),
    line(10, 10, 0, 10),
    line(0, 10, 0, 0),
  ];
  const clean = convertVector(dxf([...square, circle(5, 5, 2)]), "dxf");
  const r = convertVector(
    dxf([
      ...square,
      line(10, 0, 0, 0),
      line(1e-9, 0, 10, 1e-9),
      circle(5, 5, 2),
      circle(5, 5, 2),
    ]),
    "dxf",
  );
  assert.deepEqual(r.warnings, ["3 duplicate DXF entities were skipped."]);
  assert.deepEqual(r.geometry, clean.geometry);
  assert.ok(value(r, [0.6, 0.6]) < 0, "the square still closes and fills");
  assert.ok(value(r, [0, 0]) > 0, "a repeated hole does not cancel itself");
  // Curves that merely share their ends are different entities.
  const lens = convertVector(
    dxf([
      entity("ARC", [[10, 0], [20, 0], [40, 10], [50, 0], [51, 180]]),
      entity("ARC", [[10, 0], [20, 0], [40, 10], [50, 180], [51, 0]]),
      line(-10, 0, 10, 0),
    ]),
    "dxf",
  );
  assert.equal(lens.warnings.filter((w) => /duplicate/.test(w)).length, 0);
  assert.ok(lens.stats.segments > 20);
});
test("Open DXF lines have configurable positive stroke thickness", () => {
  const r = convertVector(dxf([line(0, 0, 10, 0)]), "dxf", {
    strokeWidth: 0.024,
  });
  assert.ok(Math.abs(value(r, [0, 0]) + 0.012) < 1e-8);
  assert.ok(value(r, [0, 0.1]) > 0);
});
test("DXF arcs wrap counterclockwise through zero degrees", () => {
  const r = convertVector(
    dxf([entity("ARC", [[10, 0], [20, 0], [40, 10], [50, 270], [51, 90]])]),
    "dxf",
  );
  assert.ok(r.geometry.bounds[0] > -1e-8);
  assert.ok(Math.abs(r.geometry.bounds[2] - 10) < 1e-8);
  assert.ok(Math.abs(r.geometry.bounds[1] + 10) < 1e-8);
});
test("Positive and negative DXF bulges make opposite semicircles", () => {
  for (const bulge of [1, -1]) {
    const r = convertVector(
      dxf([
        entity("LWPOLYLINE", [
          [90, 2],
          [70, 1],
          [10, -10],
          [20, 0],
          [42, bulge],
          [10, 10],
          [20, 0],
        ]),
      ]),
      "dxf",
    );
    assert.ok(r.stats.segments > 10);
    assert.ok(
      bulge === 1 ? r.geometry.bounds[1] < -9.9 : r.geometry.bounds[3] > 9.9,
    );
    assert.ok(value(r, [0, 0]) < 0);
  }
});
test("Old POLYLINE/VERTEX records and ellipses are supported", () => {
  const r = convertVector(
    dxf([
      entity("POLYLINE", [[70, 1]]),
      ...[[0, 0], [10, 0], [5, 10]].map(([x, y]) =>
        entity("VERTEX", [[10, x], [20, y]])
      ),
      entity("SEQEND"),
    ]),
    "dxf",
  );
  assert.ok(value(r, [0, 0]) < 0);
  const e = convertVector(
    dxf([
      entity("ELLIPSE", [[10, 0], [20, 0], [11, 10], [21, 0], [40, 0.5], [
        41,
        0,
      ], [42, Math.PI * 2]]),
    ]),
    "dxf",
  );
  assert.ok(Math.abs(e.geometry.bounds[3] - 5) < 1e-8);
});
test("DXF rational splines are sampled from knots and control points", () => {
  const r = convertVector(
    dxf([
      entity("SPLINE", [
        [71, 2],
        ...[0, 0, 0, 1, 1, 1].map((v) => [40, v]),
        [10, 0],
        [20, 0],
        [10, 5],
        [20, 10],
        [10, 10],
        [20, 0],
      ]),
    ]),
    "dxf",
  );
  assert.ok(r.stats.segments > 5);
  assert.ok(Math.abs(r.geometry.bounds[3] - 5) < 1e-8);
});
test("DXF block base points, rotation, scaling, and nested insertion apply", () => {
  const blocks = [
    entity("BLOCK", [[2, "shape"], [10, 10], [20, 10]]),
    line(10, 10, 20, 10),
    entity("ENDBLK"),
  ];
  const r = convertVector(
    dxf([
      entity("INSERT", [[2, "shape"], [10, 30], [20, 40], [41, 2], [42, 2], [
        50,
        90,
      ]]),
    ], blocks),
    "dxf",
  );
  assert.ok(Math.abs(r.geometry.bounds[0] - 30) < 1e-8);
  assert.ok(Math.abs(r.geometry.bounds[1] - 40) < 1e-8);
  assert.ok(Math.abs(r.geometry.bounds[3] - 60) < 1e-8);
});
test("Unsupported DXF entities are reported, and malformed files fail clearly", () => {
  const r = convertVector(
    dxf([circle(0, 0, 1), entity("TEXT", [[1, "hello"]])]),
    "dxf",
  );
  assert.match(r.warnings.join(" "), /Skipped DXF TEXT/);
  assert.throws(
    () => convertVector("AutoCAD Binary DXF\0", "dxf"),
    /Binary DXF/,
  );
  assert.throws(() => convertVector("0\nSECTION\n2", "dxf"), /pairs/);
  assert.throws(
    () => convertVector(dxf([entity("CIRCLE", [[40, "oops"]])]), "dxf"),
    /Invalid DXF number/,
  );
  assert.throws(
    () => convertVector(dxf([entity("TEXT")]), "dxf"),
    /No supported/,
  );
  assert.throws(
    () => convertVector(dxf([entity("INSERT", [[2, "missing"]])]), "dxf"),
    /missing/,
  );
});
test("Recursive DXF blocks and unsupported extrusion planes are rejected", () => {
  const blocks = [
    entity("BLOCK", [[2, "loop"]]),
    entity("INSERT", [[2, "loop"]]),
    entity("ENDBLK"),
  ];
  assert.throws(
    () => convertVector(dxf([entity("INSERT", [[2, "loop"]])], blocks), "dxf"),
    /recursive/,
  );
  assert.throws(
    () => convertVector(dxf([entity("CIRCLE", [[40, 1], [210, 1]])]), "dxf"),
    /Tilted/,
  );
});
test("DXF off/frozen layers are excluded and nonplanar splines are rejected", () => {
  const table =
    "0\nSECTION\n2\nTABLES\n0\nLAYER\n2\nhidden\n62\n-7\n0\nENDSEC\n";
  const r = convertVector(
    table +
      dxf([
        circle(0, 0, 1),
        entity("CIRCLE", [[8, "hidden"], [10, 100], [20, 100], [40, 10]]),
      ]),
    "dxf",
  );
  assert.deepEqual(r.geometry.bounds, [-1, -1, 1, 1]);
  assert.match(r.warnings.join(" "), /off\/frozen/);
  assert.throws(
    () => convertVector(dxf([entity("SPLINE", [[30, 0], [30, 2]])]), "dxf"),
    /Nonplanar/,
  );
});
test("SVG paths support relative repeats, smooth curves, arcs, and close commands", () => {
  const paths = parsePath(
    "m 0 0 10 0 h 5 v 5 l -5 0 q -5 5 -10 0 t -10 0 c 0 -4 4 -4 4 0 s 4 4 4 0 a 2 3 30 01 2 -2 z",
  );
  const g = flatten([{ paths, fill: true, rule: "evenodd" }], 0.002, 0.012);
  assert.ok(g.segments > 10);
  assert.ok(g.groups[0].contours[0].closed);
  const compact = parsePath("M0 0 A10 10 0 0110 10");
  assert.ok(Math.abs(compact[0].current[0] - 10) < 1e-8);
  assert.throws(() => parsePath("M0 0 Lnope"), /Invalid SVG path/);
  assert.throws(() => parsePath("M0 0 A10 10 0 2 1 20 20"), /Invalid SVG path/);
});
test("SVG subpaths retain separate closure and transforms compose in order", () => {
  const paths = parsePath(
    "M0 0H10V10H0Z M2 2V8H8V2Z",
    transform("translate(20 30) scale(2)"),
  );
  assert.equal(paths.length, 2);
  const g = flatten([{ paths, fill: true, rule: "nonzero" }], 0.002, 0.012);
  assert.deepEqual(g.bounds, [20, 30, 40, 50]);
  assert.ok(evaluateGeometry(g.groups, [0, 0]) > 0);
});
test("Nonzero same-winding nested paths do not create internal distance seams", () => {
  const paths = parsePath("M0 0H10V10H0Z M2 2H8V8H2Z");
  const g = flatten([{ paths, fill: true, rule: "nonzero" }], 0.002, 0.012);
  assert.equal(g.segments, 4);
  assert.ok(Math.abs(evaluateGeometry(g.groups, [0, 0]) + 0.75) < 1e-8);
  assert.ok(evaluateGeometry(g.groups, [-0.45, 0]) < -0.29);
});
test("Compound path intersections remove inactive edges and preserve evenodd cutouts", () => {
  const paths = parsePath("M0 0H10V10H0Z M5 0H15V10H5Z");
  const solid = flatten([{ paths, fill: true, rule: "nonzero" }], 0.002, 0.012);
  assert.ok(evaluateGeometry(solid.groups, [0, 0]) < -0.49);
  const parity = flatten(
    [{ paths, fill: true, rule: "evenodd" }],
    0.002,
    0.012,
  );
  assert.ok(evaluateGeometry(parity.groups, [0, 0]) > 0);
});
test("Outline mode removes fill while preserving path edges", () => {
  const r = convertVector(dxf([circle(0, 0, 10)]), "dxf", { mode: "outline" });
  assert.ok(value(r, [0, 0]) > 0.7);
  assert.ok(r.geometry.groups.every((g) => !g.fill));
});
test("Limits reject large inputs, excessive geometry, and invalid settings", () => {
  assert.throws(
    () => convertVector(" ".repeat(LIMITS.bytes) + "x", "dxf"),
    /16 MB/,
  );
  assert.throws(
    () => convertVector(dxf([circle(0, 0, 1)]), "dxf", { tolerance: NaN }),
    /tolerance/,
  );
  assert.throws(
    () => convertVector(dxf([circle(0, 0, 1)]), "dxf", { strokeWidth: 0 }),
    /width/,
  );
  const p = new Path([0, 0]);
  for (let i = 1; i < 1100; i++) p.line([i, i % 2]);
  assert.equal(
    flatten([{ paths: [p], defaultStroke: true }], 0.002, 0.012).segments,
    1099,
  );
  assert.throws(
    () => convertVector(rings(200), "dxf", { tolerance: 0.0001 }),
    /32768 segments/,
  );
  assert.throws(() => {
    for (let i = 0; i <= LIMITS.pieces; i++) p.line([i, i % 2]);
  }, /Too many path commands/);
});
test("Drawings beyond the inline limits read their geometry from a data texture", () => {
  const small = convertVector(rings(16), "dxf", { mode: "outline" });
  assert.equal(small.stats.segments, LIMITS.inlineSegments);
  assert.equal(small.data, null);
  assert.match(small.code, /const vec4 stvi_edges_0\[1024\]/);
  // Fills and a stroke: edges, then a box per run of 16, then two texels per shape.
  const r = convertVector(
    dxf([
      ...Array.from({ length: 30 }, (_, i) => circle(0, 0, 10 + i)),
      line(0, 0, 60, 60),
    ]),
    "dxf",
  );
  const [fills, stroke] = r.geometry.groups;
  assert.ok(fills.fill && fills.edges.length > LIMITS.inlineSegments);
  assert.equal(stroke.edges.length, 1);
  assert.match(r.code, /uniform highp sampler2D stvi_data;/);
  assert.doesNotMatch(r.code, /stvi_edges_/);
  const { width, height, values } = r.data;
  assert.equal(values.length, width * height * 4);
  const texel = (i) => [...values.subarray(i * 4, i * 4 + 4)];
  const edges = [...fills.edges, ...stroke.edges], runs = Math.ceil(fills.edges.length / 16);
  edges.forEach(([a, b], i) =>
    assert.deepEqual(texel(i), [...a, ...b].map(Math.fround))
  );
  const within = ([ax, ay, bx, by], box) =>
    Math.min(ax, bx) >= box[0] && Math.min(ay, by) >= box[1] &&
    Math.max(ax, bx) <= box[2] && Math.max(ay, by) <= box[3];
  const boxes = edges.length, heads = boxes + runs + 1;
  for (let i = 0; i < fills.edges.length; i++) {
    assert.ok(within(texel(i), texel(boxes + Math.floor(i / 16))));
  }
  assert.ok(within(texel(fills.edges.length), texel(boxes + runs)));
  assert.deepEqual(texel(heads), [0, fills.edges.length, boxes, -2]);
  assert.deepEqual(texel(heads + 2), [
    fills.edges.length,
    1,
    boxes + runs,
    Math.fround(stroke.width / 2),
  ]);
  for (let run = 0; run < runs; run++) {
    assert.ok(within(texel(boxes + run), texel(heads + 1)));
  }
  assert.ok(within(texel(fills.edges.length), texel(heads + 3)));
  assert.ok(r.code.includes(`shape < 2;`));
  assert.ok(r.code.includes(`stvi_texel(${heads} + 2 * shape)`));
  assert.equal(height, Math.ceil((heads + 4) / width));
});
test("The shader stops growing with the drawing", () => {
  const r = convertVector(rings(200), "dxf", { mode: "outline" });
  assert.equal(r.stats.segments, 12800);
  assert.ok(r.code.length < 4000);
  // Many shapes used to mean one GLSL function each and a shader too large to compile.
  const squares = Array.from({ length: 400 }, (_, i) => {
    const x = (i % 20) * 3, y = Math.floor(i / 20) * 3;
    return `M${x} ${y}h2v2h-2z`;
  });
  const groups = squares.map((d, i) => ({
    paths: parsePath(d),
    fill: i % 2 === 0,
    rule: "nonzero",
    stroke: i % 2 ? 0.1 : 0,
  }));
  const many = convertParsed([{ groups, warnings: [], flipY: true, format: "svg" }]);
  assert.equal(many.stats.segments, 1600);
  assert.equal(many.stats.shapes, 400);
  assert.ok(many.code.length < 4000);
  // A few hundred shapes within the segment limit still outgrow the constant form.
  const few = convertParsed([{ groups: groups.slice(0, 200), warnings: [], flipY: true, format: "svg" }]);
  assert.equal(few.stats.segments, 800);
  assert.ok(few.data, "falls back to the texture instead of failing on shader size");
  assert.equal(convertParsed([{ groups: groups.slice(0, 20), warnings: [], flipY: true, format: "svg" }]).data, null);
});
test("Large fills and long chains of DXF lines stay quick to prepare", () => {
  // 16384 shuffled LINE entities forming 256 closed loops in a grid.
  const lines = [];
  for (let loop = 0; loop < 256; loop++) {
    const x = (loop % 16) * 3, y = Math.floor(loop / 16) * 3;
    for (let i = 0; i < 64; i++) {
      const a = i / 64 * 2 * Math.PI, b = (i + 1) / 64 * 2 * Math.PI;
      lines.push(line(x + Math.cos(a), y + Math.sin(a), x + Math.cos(b), y + Math.sin(b)));
    }
  }
  for (let i = lines.length - 1; i > 0; i--) {
    const j = (i * 7919) % (i + 1);
    [lines[i], lines[j]] = [lines[j], lines[i]];
  }
  const started = performance.now();
  const r = convertVector(dxf(lines), "dxf");
  assert.equal(r.stats.segments, 16384);
  assert.deepEqual(r.geometry.groups.map((g) => g.fill), [true]);
  assert.ok(value(r, [-0.7, -0.7]) < 0, "the corner loop is closed and filled");
  assert.ok(performance.now() - started < 5000, "stitching and fill boundaries do not scale quadratically");
});
test("Several drawings share one field, each in its own coordinates and mode", () => {
  const frame = parseVector(dxf([circle(0, 0, 10)]), "dxf"),
    dot = parseVector(dxf([circle(100, 0, 5)]), "dxf");
  const r = convertParsed([{ ...frame, mode: "outline" }, dot]);
  assert.deepEqual(r.geometry.bounds, [-10, -10, 105, 10]);
  assert.equal(r.stats.format, "dxf");
  const at = (x, y = 0) => [(x - 47.5) * r.geometry.scale, y * r.geometry.scale];
  assert.ok(value(r, at(0)) > 0);
  assert.ok(Math.abs(value(r, at(10)) + 0.006) < 1e-4);
  assert.ok(value(r, at(100)) < 0);
  // An SVG is y-down: beside a DXF it is mirrored, alone it is flipped about its own centre.
  const svg = {
    groups: [{ paths: parsePath("M0 0H10V4H0Z"), fill: true, rule: "nonzero" }],
    warnings: [],
    flipY: true,
    format: "svg",
  };
  const mixed = convertParsed([svg, dot]);
  assert.deepEqual(mixed.geometry.bounds, [0, -5, 105, 5]);
  assert.equal(mixed.stats.format, "svg+dxf");
  const point = (x, y) => [(x - 52.5) * mixed.geometry.scale, y * mixed.geometry.scale];
  assert.ok(evaluateGeometry(mixed.geometry.groups, point(5, -2)) < 0);
  assert.ok(evaluateGeometry(mixed.geometry.groups, point(5, 2)) > 0);
  assert.deepEqual(convertParsed([svg]).geometry.bounds, [0, 0, 10, 4]);
  assert.throws(() => convertParsed([{ ...frame, mode: "other" }]), /mode/);
});
