import { distance, Path } from "./geometry.js";

// SVG endpoint arcs -> center parameterization (SVG implementation notes F.6).
export function endpointArc(path, rx, ry, rotation, large, sweep, end) {
  const start = path.current;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (distance(start, end) < 1e-12) return;
  if (!rx || !ry) return path.line(end);
  const phi = rotation * Math.PI / 180, c = Math.cos(phi), s = Math.sin(phi);
  const dx = (start[0] - end[0]) / 2, dy = (start[1] - end[1]) / 2;
  const x = c * dx + s * dy, y = -s * dx + c * dy;
  const lambda = x * x / (rx * rx) + y * y / (ry * ry);
  if (lambda > 1) {
    const k = Math.sqrt(lambda);
    rx *= k;
    ry *= k;
  }
  const factor = (large === sweep ? -1 : 1) *
    Math.sqrt(
      Math.max(
        0,
        (rx * rx * ry * ry - rx * rx * y * y - ry * ry * x * x) /
          (rx * rx * y * y + ry * ry * x * x),
      ),
    );
  const cx = factor * rx * y / ry, cy = -factor * ry * x / rx;
  const center = [
    c * cx - s * cy + (start[0] + end[0]) / 2,
    s * cx + c * cy + (start[1] + end[1]) / 2,
  ];
  const a = Math.atan2((y - cy) / ry, (x - cx) / rx);
  const b = Math.atan2((-y - cy) / ry, (-x - cx) / rx);
  let delta = b - a;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  path.ellipse(center, [rx * c, rx * s], [-ry * s, ry * c], a, delta);
  path.current = end;
}

export function parsePath(data, matrix) {
  let i = 0, cmd = "", path = null, current = [0, 0], last = "", control = null;
  const paths = [];
  const skip = () => {
    while (i < data.length && /[\s,]/.test(data[i])) i++;
  };
  function number(flag = false) {
    skip();
    const match = data.slice(i).match(
      flag ? /^[01]/ : /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/,
    );
    if (!match || !Number.isFinite(Number(match[0]))) {
      throw new Error(`Invalid SVG path near character ${i + 1}.`);
    }
    i += match[0].length;
    return Number(match[0]);
  }
  function finish() {
    if (path?.pieces.length) paths.push(path);
    path = null;
  }
  while (true) {
    skip();
    if (i >= data.length) break;
    if (/[a-zA-Z]/.test(data[i])) cmd = data[i++];
    else if (!cmd || cmd.toUpperCase() === "Z") {
      throw new Error(`Missing SVG path command near character ${i + 1}.`);
    }
    const upper = cmd.toUpperCase(), relative = cmd !== upper;
    if (!"MLHVCSQTAZ".includes(upper)) {
      throw new Error(`Unsupported SVG path command: ${cmd}.`);
    }
    if (!path && upper !== "M" && !paths.length) {
      throw new Error("An SVG path must begin with M.");
    }
    const origin = current;
    const xy = () => {
      const p = [number(), number()];
      return relative ? [p[0] + origin[0], p[1] + origin[1]] : p;
    };
    const reflected = () =>
      control
        ? [2 * current[0] - control[0], 2 * current[1] - control[1]]
        : current;
    if (upper === "M") {
      const p = xy();
      finish();
      path = new Path(p, matrix);
      current = p;
      cmd = relative ? "l" : "L";
      control = null;
    } else {
      if (!path) path = new Path(current, matrix);
      if (upper === "Z") {
        path.close();
        current = path.start;
        finish();
        control = null;
      }
      if (upper === "L") {
        current = xy();
        path.line(current);
        control = null;
      }
      if (upper === "H") {
        current = [number() + (relative ? current[0] : 0), current[1]];
        path.line(current);
        control = null;
      }
      if (upper === "V") {
        current = [current[0], number() + (relative ? current[1] : 0)];
        path.line(current);
        control = null;
      }
      if (upper === "C") {
        const a = xy(), b = xy();
        current = xy();
        path.cubic(a, b, current);
        control = b;
      }
      if (upper === "S") {
        const a = ["C", "S"].includes(last) ? reflected() : current, b = xy();
        current = xy();
        path.cubic(a, b, current);
        control = b;
      }
      if (upper === "Q") {
        const a = xy();
        current = xy();
        path.quadratic(a, current);
        control = a;
      }
      if (upper === "T") {
        const a = ["Q", "T"].includes(last) ? reflected() : current;
        current = xy();
        path.quadratic(a, current);
        control = a;
      }
      if (upper === "A") {
        const rx = number(),
          ry = number(),
          rotation = number(),
          large = number(true),
          sweep = number(true),
          end = xy();
        endpointArc(path, rx, ry, rotation, large, sweep, end);
        current = end;
        control = null;
      }
    }
    last = upper;
  }
  finish();
  return paths;
}
