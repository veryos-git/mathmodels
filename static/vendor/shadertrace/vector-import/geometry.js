// Shared, DOM-independent geometry and GLSL generation.
export const LIMITS = Object.freeze({
  bytes: 2 * 1024 * 1024,
  segments: 1024,
  pieces: 10000,
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
  const inside = (p) => {
    let winding = 0;
    for (const [a, b] of edges) {
      const side = cross(sub(b, a), sub(p, a));
      if (a[1] <= p[1] && b[1] > p[1] && side > 0) winding++;
      if (a[1] > p[1] && b[1] <= p[1] && side < 0) winding--;
    }
    return group.rule === "evenodd"
      ? Math.abs(winding) % 2 === 1
      : winding !== 0;
  };
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
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
      let epsilon = Math.min(size * 1e-5, 1e-7);
      for (const [c, d] of edges) {
        const gap = segmentDistance(mid, c, d);
        if (gap > 1e-10) epsilon = Math.min(epsilon, gap * 0.1);
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
    (1.5 - (outline || groups.some((g) => g.defaultStroke) ? strokeWidth : 0)) /
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
    if (g.fill && !outline) {
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
    const width = outline || g.defaultStroke
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

export function generateGLSL(geometry) {
  const num = (v) => {
    const n = Number(v.toFixed(8));
    return Number.isInteger(n) ? `${n}.0` : String(n);
  };
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
  if (new TextEncoder().encode(code).length > 100000) {
    throw new Error(
      "Generated shader exceeds the template size limit. Simplify the drawing.",
    );
  }
  return code;
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
