import {
  bounds,
  distance,
  identity,
  LIMITS,
  multiply,
  Path,
  point,
} from "./geometry.js";

const TAU = 2 * Math.PI;
const first = (r, code, fallback) =>
  r.find((p) => p[0] === code)?.[1] ?? fallback;
function number(r, code, fallback = 0) {
  const raw = first(r, code, fallback), n = Number(raw);
  if (raw === "" || !Number.isFinite(n)) {
    throw new Error(`Invalid DXF number in group ${code}.`);
  }
  return n;
}
const xy = (r, code = 10) => [number(r, code), number(r, code + 10)];
function records(text) {
  if (text.startsWith("AutoCAD Binary DXF") || text.includes("\0")) {
    throw new Error("Binary DXF is not supported. Export an ASCII DXF.");
  }
  const lines = text.replace(/^\uFEFF/, "").trimEnd().split(/\r\n|\n|\r/);
  if (lines.length % 2) {
    throw new Error(
      "Invalid DXF: expected pairs of group-code and value lines.",
    );
  }
  const output = [];
  let record = [];
  for (let i = 0; i < lines.length; i += 2) {
    const code = Number(lines[i].trim());
    if (
      !lines[i].trim() || !Number.isInteger(code) || code < 0 || code > 1071
    ) throw new Error(`Invalid DXF group code on line ${i + 1}.`);
    const value = lines[i + 1].trim();
    if (code === 0 && record.length) {
      output.push(record);
      record = [];
    }
    record.push([code, value]);
  }
  if (record.length) output.push(record);
  if (!output.some((r) => first(r, 0) === "EOF")) {
    throw new Error("Invalid DXF: missing EOF record.");
  }
  return output;
}
function vertices(record) {
  const output = [];
  for (const [code, value] of record) {
    if (code === 10) output.push({ x: Number(value), y: NaN, bulge: 0 });
    else if (code === 20 && output.length) output.at(-1).y = Number(value);
    else if (code === 42 && output.length) output.at(-1).bulge = Number(value);
  }
  if (output.some((v) => ![v.x, v.y, v.bulge].every(Number.isFinite))) {
    throw new Error("Invalid DXF polyline vertex.");
  }
  return output;
}
function polyline(points, closed, matrix) {
  if (points.length < 2) return null;
  const path = new Path([points[0].x, points[0].y], matrix);
  const count = closed ? points.length : points.length - 1;
  for (let i = 0; i < count; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length],
      end = [b.x, b.y],
      bulge = a.bulge;
    if (Math.abs(bulge) < 1e-12 || distance([a.x, a.y], end) < 1e-12) {
      path.line(end);
      continue;
    }
    const dx = b.x - a.x,
      dy = b.y - a.y,
      offset = (1 - bulge * bulge) / (4 * bulge);
    const center = [
      (a.x + b.x) / 2 - dy * offset,
      (a.y + b.y) / 2 + dx * offset,
    ];
    const radius = distance([a.x, a.y], center),
      start = Math.atan2(a.y - center[1], a.x - center[0]);
    path.ellipse(center, [radius, 0], [0, radius], start, 4 * Math.atan(bulge));
    path.current = end;
  }
  if (closed) path.close();
  return path;
}
function spline(record, matrix) {
  const degree = number(record, 71),
    controls = vertices(record).map((v) => [v.x, v.y]);
  const knots = record.filter((p) => p[0] === 40).map((p) => Number(p[1]));
  let weights = record.filter((p) => p[0] === 41).map((p) => Number(p[1]));
  if (
    !Number.isInteger(degree) || degree < 1 || degree > 5 ||
    controls.length <= degree || knots.length !== controls.length + degree + 1
  ) {
    throw new Error(
      "DXF SPLINE needs degree 1–5, control points, and a complete knot vector. Export fit-only splines as polylines.",
    );
  }
  if (!weights.length) weights = controls.map(() => 1);
  if (
    weights.length !== controls.length ||
    weights.some((w) => !Number.isFinite(w) || w <= 0) ||
    knots.some((k, i) => !Number.isFinite(k) || (i > 0 && k < knots[i - 1]))
  ) throw new Error("Invalid DXF spline knots or weights.");
  const start = knots[degree], end = knots[controls.length];
  if (!(end > start)) throw new Error("DXF spline has an empty knot domain.");
  function evaluate(u) {
    let span = controls.length - 1;
    if (u < end) {
      for (let i = degree; i < controls.length; i++) {
        if (knots[i] <= u && u < knots[i + 1]) {
          span = i;
          break;
        }
      }
    }
    const d = [];
    for (let j = 0; j <= degree; j++) {
      const index = span - degree + j, w = weights[index];
      d.push([controls[index][0] * w, controls[index][1] * w, w]);
    }
    for (let r = 1; r <= degree; r++) {
      for (let j = degree; j >= r; j--) {
        const i = span - degree + j,
          denom = knots[i + degree - r + 1] - knots[i],
          a = denom ? (u - knots[i]) / denom : 0;
        d[j] = d[j].map((v, k) => (1 - a) * d[j - 1][k] + a * v);
      }
    }
    return [d[degree][0] / d[degree][2], d[degree][1] / d[degree][2]];
  }
  const path = new Path(evaluate(start), matrix);
  for (let i = degree; i < controls.length; i++) {
    if (knots[i + 1] > knots[i]) {
      const a = knots[i], b = knots[i + 1];
      path.add((t) => evaluate(a + t * (b - a)));
    }
  }
  if (number(record, 70) & 1) path.close();
  return path;
}

function worldPath(path) {
  const output = new Path(point(path.matrix, path.start));
  output.pieces = [...path.pieces];
  output.current = point(path.matrix, path.current);
  output.closed = path.closed;
  return output;
}
function reversed(path) {
  const output = new Path(path.current);
  output.pieces = [...path.pieces].reverse().map((f) => (t) => f(1 - t));
  output.current = path.start;
  return output;
}
function stitch(paths, warnings) {
  const all = paths.map(worldPath),
    closed = all.filter((p) => p.closed),
    open = all.filter((p) => !p.closed);
  if (!open.length) return closed;
  const box = bounds(all.flatMap((p) => [p.start, p.current]));
  const tolerance = Math.max(box[2] - box[0], box[3] - box[1], 1e-9) * 1e-7;
  const used = new Set();
  for (let i = 0; i < open.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    let chain = open[i];
    for (let direction = 0; direction < 2; direction++) {
      while (!chain.closed) {
        if (
          distance(chain.start, chain.current) < tolerance &&
          chain.pieces.length > 1
        ) {
          chain.close();
          break;
        }
        const choices = [];
        for (let j = 0; j < open.length; j++) {
          if (!used.has(j)) {
            if (distance(chain.current, open[j].start) < tolerance) {
              choices.push([j, false]);
            } else if (distance(chain.current, open[j].current) < tolerance) {
              choices.push([j, true]);
            }
          }
        }
        if (choices.length !== 1) {
          if (choices.length > 1) {
            warnings.add(
              "Branching DXF lines were left open where joining would be ambiguous.",
            );
          }
          break;
        }
        const [j, reverse] = choices[0],
          next = reverse ? reversed(open[j]) : open[j];
        used.add(j);
        chain.pieces.push(...next.pieces);
        chain.current = next.current;
      }
      if (chain.closed) break;
      if (direction === 0) chain = reversed(chain);
    }
    closed.push(chain);
  }
  return closed;
}

export function parseDXF(text, selectedLayers = null) {
  const input = records(text),
    entities = [],
    blocks = new Map(),
    warnings = new Set(),
    hiddenLayers = new Set();
  let section = "", block = null, found = false;
  for (const r of input) {
    const type = first(r, 0);
    if (type === "SECTION") {
      section = first(r, 2, "");
      if (section === "ENTITIES") found = true;
      continue;
    }
    if (type === "ENDSEC") {
      section = "";
      continue;
    }
    if (
      section === "TABLES" && type === "LAYER" &&
      (number(r, 62, 7) < 0 || (number(r, 70) & 1))
    ) hiddenLayers.add(first(r, 2));
    if (section === "ENTITIES") entities.push(r);
    if (section === "BLOCKS") {
      if (type === "BLOCK") {
        block = { base: xy(r), records: [] };
        blocks.set(first(r, 2), block);
      } else if (type === "ENDBLK") block = null;
      else if (block) block.records.push(r);
    }
  }
  if (!found) throw new Error("DXF has no ENTITIES section.");
  const paths = [];
  let visited = 0;
  function emit(list, matrix = identity, stack = []) {
    for (let index = 0; index < list.length; index++) {
      const r = list[index], type = first(r, 0);
      // Match the application's drawing layer filter, including complete INSERTs.
      if (!stack.length && selectedLayers && !selectedLayers.includes(first(r, 8, "0"))) continue;
      if (++visited > LIMITS.pieces || paths.length > LIMITS.segments) {
        throw new Error(
          "DXF is too complex. Simplify the drawing or remove unused entities.",
        );
      }
      if (number(r, 67) === 1 || number(r, 60) === 1) {
        warnings.add(
          "Paper-space or explicitly invisible DXF entities were skipped.",
        );
        continue;
      }
      if (hiddenLayers.has(first(r, 8, "0"))) {
        warnings.add("DXF entities on off/frozen layers were skipped.");
        continue;
      }
      let m = matrix;
      const nx = number(r, 210), ny = number(r, 220), nz = number(r, 230, 1);
      if (
        Math.abs(nx) > 1e-9 || Math.abs(ny) > 1e-9 ||
        Math.abs(Math.abs(nz) - 1) > 1e-9
      ) {
        throw new Error(
          "Tilted DXF extrusion planes are not supported. Export a flat XY drawing.",
        );
      }
      // OCS conversion applies to planar entities, not WCS LINE/SPLINE coordinates.
      if (nz < 0 && !["LINE", "SPLINE"].includes(type)) {
        m = multiply(m, [-1, 0, 0, 1, 0, 0]);
      }
      if (type === "INSERT") {
        const name = first(r, 2), block = blocks.get(name);
        if (!block) throw new Error(`DXF block “${name}” is missing.`);
        if (stack.includes(name) || stack.length >= 16) {
          throw new Error(
            "DXF contains recursive or excessively nested blocks.",
          );
        }
        const a = number(r, 50) * Math.PI / 180,
          c = Math.cos(a),
          s = Math.sin(a),
          sx = number(r, 41, 1),
          sy = number(r, 42, 1);
        const cols = number(r, 70, 1), rows = number(r, 71, 1);
        if (
          !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 ||
          rows < 1 || cols * rows > 1024
        ) throw new Error("Invalid or excessive DXF block array.");
        for (let row = 0; row < rows; row++) {
          for (let col = 0; col < cols; col++) {
            const rotation = [c, s, -s, c, number(r, 10), number(r, 20)];
            const local = multiply(
              multiply(rotation, [
                1,
                0,
                0,
                1,
                col * number(r, 44),
                row * number(r, 45),
              ]),
              [sx, 0, 0, sy, -block.base[0] * sx, -block.base[1] * sy],
            );
            emit(block.records, multiply(m, local), [...stack, name]);
          }
        }
        continue;
      }
      let path;
      if (type === "LINE") {
        if (Math.abs(number(r, 30) - number(r, 31)) > 1e-9) {
          throw new Error(
            "Nonplanar DXF lines are not supported. Export a flat XY drawing.",
          );
        }
        path = new Path(xy(r), m);
        path.line(xy(r, 11));
      } else if (type === "LWPOLYLINE") {
        const points = vertices(r);
        if (number(r, 90, points.length) !== points.length) {
          throw new Error("DXF polyline vertex count does not match its data.");
        }
        path = polyline(points, Boolean(number(r, 70) & 1), m);
      } else if (type === "POLYLINE") {
        const flags = number(r, 70), points = [];
        if (flags & (2 | 4 | 8 | 16 | 64)) {
          throw new Error(
            "Fitted, 3D, or mesh POLYLINE entities are not supported. Export a 2D polyline.",
          );
        }
        while (
          index + 1 < list.length && first(list[index + 1], 0) === "VERTEX"
        ) {
          const v = list[++index];
          points.push({
            x: number(v, 10),
            y: number(v, 20),
            bulge: number(v, 42),
          });
        }
        if (first(list[index + 1] || [], 0) !== "SEQEND") {
          throw new Error("DXF POLYLINE is missing SEQEND.");
        }
        index++;
        path = polyline(points, Boolean(flags & 1), m);
      } else if (type === "CIRCLE" || type === "ARC") {
        const center = xy(r), radius = number(r, 40);
        if (radius <= 0) {
          throw new Error("DXF circle/arc radius must be positive.");
        }
        const start = type === "CIRCLE" ? 0 : number(r, 50) * Math.PI / 180;
        const end = number(r, 51) * Math.PI / 180;
        const sweep = type === "CIRCLE"
          ? TAU
          : ((end - start) % TAU + TAU) % TAU;
        if (!sweep) {
          warnings.add("Zero-sweep DXF arcs were skipped.");
          continue;
        }
        path = new Path([
          center[0] + radius * Math.cos(start),
          center[1] + radius * Math.sin(start),
        ], m);
        path.ellipse(center, [radius, 0], [0, radius], start, sweep);
        if (type === "CIRCLE") path.close();
      } else if (type === "ELLIPSE") {
        // ELLIPSE center and major axis are WCS; only the minor-axis orientation uses the normal.
        const center = xy(r),
          major = xy(r, 11),
          ratio = number(r, 40),
          start = number(r, 41),
          end = number(r, 42, TAU);
        if (ratio <= 0 || ratio > 1 || Math.hypot(...major) === 0) {
          throw new Error("Invalid DXF ellipse axis or ratio.");
        }
        const minor = [
          -major[1] * ratio * Math.sign(nz),
          major[0] * ratio * Math.sign(nz),
        ];
        let sweep = ((end - start) % TAU + TAU) % TAU;
        const full = Math.abs(end - start) >= TAU - 1e-8;
        if (full) sweep = TAU;
        path = new Path([
          center[0] + major[0] * Math.cos(start) + minor[0] * Math.sin(start),
          center[1] + major[1] * Math.cos(start) + minor[1] * Math.sin(start),
        ], matrix);
        path.ellipse(center, major, minor, start, sweep);
        if (full) path.close();
      } else if (type === "SPLINE") {
        const elevations = r.filter((p) => p[0] === 30).map((p) =>
          Number(p[1])
        );
        if (
          elevations.some((z) =>
            !Number.isFinite(z) || Math.abs(z - elevations[0]) > 1e-9
          )
        ) {
          throw new Error(
            "Nonplanar DXF splines are not supported. Export a flat XY drawing.",
          );
        }
        path = spline(r, m);
      } else if (!["SEQEND", "VERTEX", "EOF"].includes(type)) {
        warnings.add(
          `Skipped DXF ${type}. Explode or convert unsupported entities to 2D curves.`,
        );
      }
      if (
        ["LWPOLYLINE", "POLYLINE"].includes(type) &&
        r.some(([code, value]) =>
          [40, 41, 43].includes(code) && Number(value) !== 0
        )
      ) {
        warnings.add(
          "DXF polyline widths are replaced by the import line width.",
        );
      }
      if (path?.pieces.length) paths.push(path);
    }
  }
  emit(entities);
  const joined = stitch(paths, warnings),
    closed = joined.filter((p) => p.closed),
    open = joined.filter((p) => !p.closed);
  const groups = [];
  if (closed.length) {
    groups.push({ paths: closed, fill: true, rule: "evenodd", stroke: 0 });
  }
  if (open.length) {
    groups.push({ paths: open, fill: false, defaultStroke: true });
  }
  return { groups, warnings: [...warnings], flipY: false };
}
