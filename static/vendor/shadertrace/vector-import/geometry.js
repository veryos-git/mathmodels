// Shared, DOM-independent geometry and GLSL generation.
export const LIMITS = Object.freeze({
  bytes: 16 * 1024 * 1024,
  segments: 32768,
  // Drawings within both of these are written into the shader as constants.
  // Compilers reject larger arrays, so anything beyond reads a data texture.
  inlineSegments: 1024,
  inlineBytes: 100000,
  pieces: 32768,
});
export const identity = [1, 0, 0, 1, 0, 0];
export const point = (
  m,
  p,
) => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
export function multiply(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
export const lerp = (
  a,
  b,
  t,
) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
export const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export function segmentDistance(p, a, b) {
  const x = b[0] - a[0], y = b[1] - a[1], size = x * x + y * y;
  return distance(
    p,
    lerp(
      a,
      b,
      size
        ? Math.max(
          0,
          Math.min(1, ((p[0] - a[0]) * x + (p[1] - a[1]) * y) / size),
        )
        : 0,
    ),
  );
}
export function bounds(points) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of points) {
    if (!p.every(Number.isFinite) || p.some((v) => Math.abs(v) > 1e15)) {
      throw new Error("Invalid or excessively large geometry coordinates.");
    }
    box[0] = Math.min(box[0], p[0]);
    box[1] = Math.min(box[1], p[1]);
    box[2] = Math.max(box[2], p[0]);
    box[3] = Math.max(box[3], p[1]);
  }
  return box;
}

function contourEdges(group) {
  return group.contours.flatMap((c) =>
    c.points.slice(1).map((b, i) => [c.points[i], b])
  ).filter(([a, b]) => distance(a, b) > 1e-9);
}
// Split intersecting compound paths and discard edges that do not separate fill
// from empty space. This avoids zero-distance seams on same-winding nested paths.
function fillBoundary(group) {
  const edges = contourEdges(group), cuts = edges.map(() => [0, 1]);
  const cross = (a, b) => a[0] * b[1] - a[1] * b[0],
    sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
  // Edges are indexed by horizontal band and paired by a sweep along x, so the
  // work follows local density rather than the square of the edge count.
  const box = edges.map(([a, b]) => [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
  ]);
  let low = Infinity, high = -Infinity;
  for (const b of box) {
    low = Math.min(low, b[1]);
    high = Math.max(high, b[3]);
  }
  const bands = Array.from(
    { length: Math.max(1, Math.ceil(Math.sqrt(edges.length))) },
    () => [],
  );
  const band = (y) =>
    Math.max(
      0,
      Math.min(
        bands.length - 1,
        Math.floor((y - low) / (high - low || 1) * bands.length),
      ),
    );
  box.forEach((b, i) => {
    for (let k = band(b[1]); k <= band(b[3]); k++) bands[k].push(i);
  });
  const inside = (p) => {
    let winding = 0;
    for (const i of bands[band(p[1])]) {
      const [a, b] = edges[i];
      const side = cross(sub(b, a), sub(p, a));
      if (a[1] <= p[1] && b[1] > p[1] && side > 0) winding++;
      if (a[1] > p[1] && b[1] <= p[1] && side < 0) winding--;
    }
    return group.rule === "evenodd"
      ? Math.abs(winding) % 2 === 1
      : winding !== 0;
  };
  // Only edges whose boxes come within reach of each other can meet.
  const reach = 1e-6;
  const order = edges.map((_, i) => i).sort((i, j) => box[i][0] - box[j][0]);
  for (let m = 0; m < order.length; m++) {
    for (
      let n = m + 1;
      n < order.length && box[order[n]][0] <= box[order[m]][2] + reach;
      n++
    ) {
      const i = Math.min(order[m], order[n]), j = Math.max(order[m], order[n]);
      if (box[j][1] > box[i][3] + reach || box[j][3] < box[i][1] - reach) {
        continue;
      }
      const [a, b] = edges[i],
        [c, d] = edges[j],
        r = sub(b, a),
        s = sub(d, c),
        delta = sub(c, a),
        denom = cross(r, s);
      if (Math.abs(denom) > 1e-15) {
        const t = cross(delta, s) / denom, u = cross(delta, r) / denom;
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
          cuts[i].push(t);
          cuts[j].push(u);
        }
      } else if (Math.abs(cross(delta, r)) < 1e-14) {
        for (
          const [id, p, q, other] of [[i, a, b, [c, d]], [j, c, d, [a, b]]]
        ) {
          const v = sub(q, p), size = v[0] * v[0] + v[1] * v[1];
          for (const e of other) {
            const t = ((e[0] - p[0]) * v[0] + (e[1] - p[1]) * v[1]) / size;
            if (t > 0 && t < 1) {
              cuts[id].push(t);
            }
          }
        }
      }
    }
  }
  const boundary = [];
  edges.forEach(([a, b], i) => {
    const sorted = [...new Set(cuts[i])].sort((a, b) => a - b);
    for (let j = 1; j < sorted.length; j++) {
      const p = lerp(a, b, sorted[j - 1]),
        q = lerp(a, b, sorted[j]),
        size = distance(p, q);
      if (size < 1e-9) continue;
      const mid = lerp(p, q, 0.5),
        normal = [-(q[1] - p[1]) / size, (q[0] - p[0]) / size];
      // The probe offset starts below reach / 10, so farther edges cannot shrink it.
      let epsilon = Math.min(size * 1e-5, 1e-7);
      for (let k = band(mid[1] - reach); k <= band(mid[1] + reach); k++) {
        for (const e of bands[k]) {
          const gap = segmentDistance(mid, edges[e][0], edges[e][1]);
          if (gap > 1e-10) epsilon = Math.min(epsilon, gap * 0.1);
        }
      }
      const left = inside([
        mid[0] + normal[0] * epsilon,
        mid[1] + normal[1] * epsilon,
      ]);
      const right = inside([
        mid[0] - normal[0] * epsilon,
        mid[1] - normal[1] * epsilon,
      ]);
      if (left !== right) boundary.push(left ? [p, q] : [q, p]);
      if (boundary.length > LIMITS.segments) {
        throw new Error(
          "Intersecting paths create too many boundary segments. Simplify the drawing.",
        );
      }
    }
  });
  return boundary;
}

export class Path {
  constructor(start, matrix = identity) {
    this.start = start;
    this.current = start;
    this.matrix = matrix;
    this.pieces = [];
    this.closed = false;
  }
  add(evaluate) {
    if (this.pieces.length >= LIMITS.pieces) {
      throw new Error(
        "Too many path commands. Simplify the drawing before importing.",
      );
    }
    const m = this.matrix;
    this.pieces.push((t) => point(m, evaluate(t)));
    this.current = evaluate(1);
  }
  line(end) {
    const start = this.current;
    this.add((t) => lerp(start, end, t));
  }
  cubic(a, b, end) {
    const start = this.current;
    this.add((t) => {
      const s = 1 - t;
      return [0, 1].map((i) =>
        s * s * s * start[i] + 3 * s * s * t * a[i] + 3 * s * t * t * b[i] +
        t * t * t * end[i]
      );
    });
  }
  quadratic(a, end) {
    const s = this.current;
    this.cubic(lerp(s, a, 2 / 3), lerp(end, a, 2 / 3), end);
  }
  ellipse(center, u, v, start, sweep) {
    // Split into quarter turns before adaptive sampling, including full circles.
    const count = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
    for (let i = 0; i < count; i++) {
      this.add((t) => {
        const a = start + sweep * (i + t) / count;
        return [
          center[0] + u[0] * Math.cos(a) + v[0] * Math.sin(a),
          center[1] + u[1] * Math.cos(a) + v[1] * Math.sin(a),
        ];
      });
    }
  }
  close() {
    if (distance(this.current, this.start) > 0) this.line(this.start);
    this.closed = true;
  }
}

export function flatten(
  groups,
  tolerance,
  strokeWidth,
  outline = false,
  flipY = false,
) {
  const paths = groups.flatMap((g) => g.paths);
  if (!paths.length) {
    throw new Error("No supported visible vector geometry was found.");
  }
  const pieces = paths.flatMap((p) => p.pieces);
  if (!pieces.length || pieces.length > LIMITS.pieces) {
    throw new Error(
      "Empty or overly complex drawing. Simplify its paths before importing.",
    );
  }
  const rough = bounds(pieces.flatMap((f) => [0, 0.25, 0.5, 0.75, 1].map(f)));
  const span = Math.max(rough[2] - rough[0], rough[3] - rough[1]);
  if (!(span > 1e-12)) throw new Error("The drawing has no measurable size.");
  // A group can ask for outlines by itself when drawings with different modes are combined.
  const outlined = (g) => outline || g.outline;
  let budget = 0;
  function sample(path) {
    const points = [point(path.matrix, path.start)];
    const push = (p) => {
      if (distance(points.at(-1), p) < span * 1e-12) return;
      if (++budget > LIMITS.segments) {
        throw new Error(
          `Drawing exceeds ${LIMITS.segments} segments. Use lower curve detail or simplify the drawing.`,
        );
      }
      points.push(p);
    };
    function split(f, t0, t1, a, b, depth = 0) {
      const tm = (t0 + t1) / 2, m = f(tm);
      const error = Math.max(
        segmentDistance(m, a, b),
        segmentDistance(f((t0 + tm) / 2), a, b),
        segmentDistance(f((tm + t1) / 2), a, b),
      );
      if (error <= tolerance * span / 1.5) return push(b);
      if (depth >= 20) {
        throw new Error(
          "Curve precision could not be reached. Simplify the drawing or lower curve detail.",
        );
      }
      split(f, t0, tm, a, m, depth + 1);
      split(f, tm, t1, m, b, depth + 1);
    }
    for (const f of path.pieces) split(f, 0, 1, f(0), f(1));
    return { points, closed: path.closed };
  }
  const sampled = groups.map((g) => ({ ...g, contours: g.paths.map(sample) }));
  const box = bounds(
    sampled.flatMap((g) => g.contours.flatMap((c) => c.points)),
  );
  const size = Math.max(box[2] - box[0], box[3] - box[1]);
  // Include the largest source stroke in the fit, with room for normalized DXF strokes.
  const margin = Math.max(0, ...groups.map((g) => g.stroke || 0));
  const scale =
    (1.5 -
      (groups.some((g) => outlined(g) || g.defaultStroke) ? strokeWidth : 0)) /
    (size + margin);
  const center = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
  const output = [];
  for (const g of sampled) {
    const contours = g.contours.map((c) => ({
      ...c,
      points: c.points.map(
        (p) => [
          (p[0] - center[0]) * scale,
          (p[1] - center[1]) * scale * (flipY ? -1 : 1),
        ],
      ),
    }));
    if (g.fill && !outlined(g)) {
      const filled = contours.filter((c) => c.points.length >= 3).map((c) => {
        const points = [...c.points];
        if (distance(points[0], points.at(-1)) > 1e-10) points.push(points[0]);
        return { ...c, points, closed: true };
      });
      if (filled.length) {
        output.push({
          contours: filled,
          fill: true,
          rule: g.rule || "nonzero",
          width: 0,
        });
      }
    }
    const width = outlined(g) || g.defaultStroke
      ? strokeWidth
      : (g.stroke || 0) * scale;
    if (width > 0) {
      output.push({ contours, fill: false, rule: "nonzero", width });
    }
  }
  if (!output.length) {
    throw new Error("The drawing has no visible fills or strokes.");
  }
  for (const group of output) {
    group.edges = group.fill ? fillBoundary(group) : contourEdges(group);
  }
  const count = output.reduce((sum, g) => sum + g.edges.length, 0);
  if (count > LIMITS.segments) {
    throw new Error(
      `Fills and strokes exceed ${LIMITS.segments} segments. Use outline mode or simplify the drawing.`,
    );
  }
  return { groups: output, bounds: box, scale, segments: count };
}

const num = (v) => {
  const n = Number(v.toFixed(8));
  return Number.isInteger(n) ? `${n}.0` : String(n);
};
export function generateGLSL(geometry) {
  const vec = (p) => `vec2(${num(p[0])}, ${num(p[1])})`;
  const declarations = [], calls = [];
  geometry.groups.forEach((g, id) => {
    const edges = g.edges || contourEdges(g);
    if (!edges.length) return;
    declarations.push(
      `const vec4 stvi_edges_${id}[${edges.length}] = vec4[${edges.length}](\n${
        edges.map(([a, b]) => `    vec4(${vec(a)}, ${vec(b)})`).join(",\n")
      }\n);\n
float stvi_shape_${id}(vec2 p) {
    float nearest = 1e20;
    int winding = 0;
    for (int i = 0; i < ${edges.length}; ++i) {
        vec2 a = stvi_edges_${id}[i].xy;
        vec2 b = stvi_edges_${id}[i].zw;
        vec2 edge = b - a;
        vec2 offset = p - a;
        float t = clamp(dot(offset, edge) / max(dot(edge, edge), 1e-20), 0.0, 1.0);
        nearest = min(nearest, length(offset - edge * t));${
        g.fill
          ? `
        float side = edge.x * offset.y - edge.y * offset.x;
        if (a.y <= p.y && b.y > p.y && side > 0.0) winding += 1;
        if (a.y > p.y && b.y <= p.y && side < 0.0) winding -= 1;`
          : ""
      }
    }
    return ${
        g.fill
          ? `((${
            g.rule === "evenodd" ? "abs(winding) % 2 == 1" : "winding != 0"
          }) ? -nearest : nearest)`
          : `nearest - ${num(g.width / 2)}`
      };
}`,
    );
    calls.push(`    result = min(result, stvi_shape_${id}(p));`);
  });
  if (!calls.length) {
    throw new Error("The drawing contains only zero-length geometry.");
  }
  const code =
    `// Imported vector geometry. Centered, fitted to 1.5 units, +Y up.\n// Curves are polylines; negative inside, positive outside.\n// Overlapping fills use a union; interior distances can be approximate.\n// Prefix stvi_ is reserved for this generated template.\n\n${
      declarations.join("\n\n")
    }\n\nfloat sdf(vec2 p) {\n    float result = 1e20;\n${
      calls.join("\n")
    }\n    return result;\n}\n`;
  return code;
}

// Drawings too large for constants keep their geometry in an RGBA32F texture:
// one edge per texel, then a bounding box per run of edges, then two texels per
// shape. The shader below is the same for every drawing. A pixel skips each run,
// and each whole shape, that cannot come nearer than what it has already found
// (or, inside a fill's bounds, that its ray cannot cross), so the field stays
// exact while most edges go unread.
const DATA_WIDTH = 1024, RUN = 16;
function enclose(texels) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [ax, ay, bx, by] of texels) {
    box[0] = Math.min(box[0], ax, bx);
    box[1] = Math.min(box[1], ay, by);
    box[2] = Math.max(box[2], ax, bx);
    box[3] = Math.max(box[3], ay, by);
  }
  return box;
}
export function generateDataGLSL(geometry) {
  // Boxes are taken from the stored single-precision values, so they always enclose them.
  const shapes = geometry.groups.map((g) => ({
    ...g,
    edges: (g.edges || contourEdges(g)).map(([a, b]) =>
      [...a, ...b].map(Math.fround)
    ),
  })).filter((g) => g.edges.length);
  if (!shapes.length) {
    throw new Error("The drawing contains only zero-length geometry.");
  }
  const edges = shapes.flatMap((g) => g.edges), boxes = [], heads = [];
  let first = 0;
  for (const g of shapes) {
    const run = boxes.length;
    for (let i = 0; i < g.edges.length; i += RUN) {
      boxes.push(enclose(g.edges.slice(i, i + RUN)));
    }
    heads.push(
      [
        first,
        g.edges.length,
        edges.length + run,
        g.fill ? (g.rule === "evenodd" ? -2 : -1) : g.width / 2,
      ],
      enclose(boxes.slice(run)),
    );
    first += g.edges.length;
  }
  const texels = [...edges, ...boxes, ...heads];
  const height = Math.ceil(texels.length / DATA_WIDTH);
  const values = new Float32Array(DATA_WIDTH * height * 4);
  texels.forEach((texel, i) => values.set(texel, i * 4));
  const code = `// Imported vector geometry. Centered, fitted to 1.5 units, +Y up.
// Curves are polylines; negative inside, positive outside.
// Overlapping fills use a union; interior distances can be approximate.
// Prefix stvi_ is reserved for this generated template.
//
// Geometry is read from the ${DATA_WIDTH} x ${height} RGBA32F texture stvi_data, row by row:
//   ${edges.length} edges (a.xy, b.zw);
//   ${boxes.length} bounding boxes (min.xy, max.zw), one per run of ${RUN} edges of a shape;
//   ${shapes.length} shapes of two texels: (first edge, edge count, first box, kind), then the
//   shape's bounding box. kind is half the stroke width, or -1.0 for a nonzero
//   fill and -2.0 for an even-odd fill.

uniform highp sampler2D stvi_data;

vec4 stvi_texel(int i) {
    return texelFetch(stvi_data, ivec2(i % ${DATA_WIDTH}, i / ${DATA_WIDTH}), 0);
}

float sdf(vec2 p) {
    float result = 1e18;
    for (int shape = 0; shape < ${shapes.length}; ++shape) {
        vec4 head = stvi_texel(${edges.length + boxes.length} + 2 * shape);
        vec4 hull = stvi_texel(${edges.length + boxes.length + 1} + 2 * shape);
        vec2 apart = max(max(hull.xy - p, p - hull.zw), 0.0);
        // Only within a fill's bounds can a point be inside it and need its exact distance.
        bool wound = head.w < 0.0 && apart == vec2(0.0);
        float nearest = 1e20;
        if (!wound) {
            // Any other shape counts only where it comes nearer than the result so far.
            float reach = result + max(head.w, 0.0);
            if (reach <= 0.0 || dot(apart, apart) >= reach * reach) continue;
            nearest = reach * reach;
        }
        int first = int(head.x);
        int end = first + int(head.y);
        int winding = 0;
        for (int run = 0; first + run * ${RUN} < end; ++run) {
            vec4 box = stvi_texel(int(head.z) + run);
            vec2 gap = max(max(box.xy - p, p - box.zw), 0.0);
            bool crossed = wound && p.y >= box.y && p.y <= box.w && p.x <= box.z;
            if (dot(gap, gap) >= nearest && !crossed) continue;
            int last = min(first + run * ${RUN} + ${RUN}, end);
            for (int i = first + run * ${RUN}; i < last; ++i) {
                vec4 ends = stvi_texel(i);
                vec2 a = ends.xy;
                vec2 b = ends.zw;
                vec2 edge = b - a;
                vec2 offset = p - a;
                float t = clamp(dot(offset, edge) / max(dot(edge, edge), 1e-20), 0.0, 1.0);
                vec2 away = offset - edge * t;
                nearest = min(nearest, dot(away, away));
                float side = edge.x * offset.y - edge.y * offset.x;
                if (a.y <= p.y && b.y > p.y && side > 0.0) winding += 1;
                if (a.y > p.y && b.y <= p.y && side < 0.0) winding -= 1;
            }
        }
        float d = sqrt(nearest);
        if (head.w >= 0.0) d -= head.w;
        else if (wound && (head.w < -1.5 ? abs(winding) % 2 == 1 : winding != 0)) d = -d;
        result = min(result, d);
    }
    return result;
}
`;
  return {
    code,
    data: { uniform: "stvi_data", width: DATA_WIDTH, height, values },
  };
}

// CPU reference for geometry tests and integrators that need a signed-distance query.
export function evaluateGeometry(groups, p) {
  return Math.min(...groups.map((g) => {
    let nearest = Infinity, winding = 0;
    for (const [a, b] of (g.edges || contourEdges(g))) {
      nearest = Math.min(nearest, segmentDistance(p, a, b));
      const side = (b[0] - a[0]) * (p[1] - a[1]) -
        (b[1] - a[1]) * (p[0] - a[0]);
      if (a[1] <= p[1] && b[1] > p[1] && side > 0) winding++;
      if (a[1] > p[1] && b[1] <= p[1] && side < 0) winding--;
    }
    return g.fill
      ? nearest *
        ((g.rule === "evenodd" ? Math.abs(winding) % 2 === 1 : winding !== 0)
          ? -1
          : 1)
      : nearest - g.width / 2;
  }));
}
