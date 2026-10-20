// Vector conversion regression tests adapted from jonasfrey/shadertracev2.
// Source revision and local changes: static/vendor/shadertrace/README.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { convertVector } from "../static/vendor/shadertrace/vector-import/index.js";
import {
  evaluateGeometry,
  flatten,
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
    () => convertVector(" ".repeat(2 * 1024 * 1024) + "x", "dxf"),
    /2 MB/,
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
  assert.throws(
    () => flatten([{ paths: [p], defaultStroke: true }], 0.002, 0.012),
    /1024 segments/,
  );
});
