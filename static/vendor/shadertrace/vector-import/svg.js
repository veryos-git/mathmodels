import { identity, LIMITS, multiply, Path } from "./geometry.js";
import { parsePath } from "./svg-path.js";

export function numbers(text) {
  const result = [], re = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/gy;
  let index = 0;
  while (index < text.length) {
    while (/[\s,]/.test(text[index] || "") && index < text.length) index++;
    if (index === text.length) break;
    re.lastIndex = index;
    const m = re.exec(text);
    if (!m || !Number.isFinite(Number(m[0]))) {
      throw new Error("Invalid SVG numeric list.");
    }
    result.push(Number(m[0]));
    index = re.lastIndex;
  }
  return result;
}
export function transform(text = "") {
  let result = identity, rest = text.trim();
  while (rest) {
    const m = rest.match(/^([a-zA-Z]+)\s*\(([^)]*)\)\s*,?\s*/);
    if (!m) throw new Error("Invalid SVG transform.");
    const v = numbers(m[2]), name = m[1];
    let local;
    if (name === "matrix" && v.length === 6) local = v;
    if (name === "translate" && [1, 2].includes(v.length)) {
      local = [1, 0, 0, 1, v[0], v[1] || 0];
    }
    if (name === "scale" && [1, 2].includes(v.length)) {
      local = [v[0], 0, 0, v[1] ?? v[0], 0, 0];
    }
    if (name === "rotate" && [1, 3].includes(v.length)) {
      const a = v[0] * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
      local = [c, s, -s, c, 0, 0];
      if (v.length === 3) {
        local = multiply(multiply([1, 0, 0, 1, v[1], v[2]], local), [
          1,
          0,
          0,
          1,
          -v[1],
          -v[2],
        ]);
      }
    }
    if (["skewX", "skewY"].includes(name) && v.length === 1) {
      local = [1, 0, 0, 1, 0, 0];
      local[name === "skewX" ? 2 : 1] = Math.tan(v[0] * Math.PI / 180);
    }
    if (!local || !local.every(Number.isFinite)) {
      throw new Error(`Unsupported or invalid SVG transform: ${name}.`);
    }
    result = multiply(result, local);
    rest = rest.slice(m[0].length);
  }
  return result;
}
function length(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const m = String(value).trim().match(
    /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(px|pt|pc|mm|cm|in|q)?$/i,
  );
  if (!m) {
    throw new Error(
      `Unsupported SVG length “${value}”. Use absolute units instead of percentages or font units.`,
    );
  }
  const scale = {
    px: 1,
    pt: 96 / 72,
    pc: 16,
    mm: 96 / 25.4,
    cm: 96 / 2.54,
    in: 96,
    q: 96 / 101.6,
  };
  const n = Number(m[1]) * (scale[(m[2] || "px").toLowerCase()]);
  if (!Number.isFinite(n)) throw new Error("Invalid SVG length.");
  return n;
}

export function parseSVG(text, Parser = globalThis.DOMParser) {
  if (!Parser) throw new Error("SVG parsing requires a browser DOMParser.");
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(text)) {
    throw new Error(
      "Remove the SVG DOCTYPE/entity declarations before importing.",
    );
  }
  const doc = new Parser().parseFromString(text, "image/svg+xml");
  if (
    doc.querySelector("parsererror") || doc.documentElement.localName !== "svg"
  ) throw new Error("This is not a valid SVG document.");
  const groups = [], warnings = new Set(), ids = new Map();
  let visited = 0;
  for (const el of doc.querySelectorAll("[id]")) {
    ids.set(el.getAttribute("id"), el);
  }
  if ([...doc.querySelectorAll("style")].some((el) => el.textContent.trim())) {
    throw new Error(
      "SVG stylesheets are not supported. Export with inline styles or presentation attributes.",
    );
  }
  const inherited = [
    "fill",
    "fill-rule",
    "fill-opacity",
    "stroke",
    "stroke-width",
    "stroke-opacity",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-dasharray",
    "visibility",
  ];
  const defaults = {
    fill: "black",
    "fill-rule": "nonzero",
    "fill-opacity": "1",
    stroke: "none",
    "stroke-width": "1",
    "stroke-opacity": "1",
    visibility: "visible",
  };
  function walk(
    el,
    parent,
    matrix,
    opacity = 1,
    stack = [],
    referenced = false,
  ) {
    if (++visited > LIMITS.pieces || stack.length > 32) {
      throw new Error(
        "SVG contains too many elements or recursive references.",
      );
    }
    const tag = el.localName;
    if (
      [
        "defs",
        "symbol",
        "clipPath",
        "mask",
        "pattern",
        "marker",
        "linearGradient",
        "radialGradient",
      ].includes(tag) && !referenced
    ) return;
    const own = {};
    for (
      const key of [
        ...inherited,
        "display",
        "opacity",
        "clip-path",
        "mask",
        "filter",
        "vector-effect",
        "transform",
      ]
    ) if (el.hasAttribute(key)) own[key] = el.getAttribute(key);
    for (const entry of (el.getAttribute("style") || "").split(";")) {
      const colon = entry.indexOf(":");
      if (colon < 0) continue;
      const key = entry.slice(0, colon).trim(),
        value = entry.slice(colon + 1).trim().replace(/\s*!important\s*$/, "");
      if (value) own[key] = value;
    }
    const style = { ...parent };
    for (const key of inherited) {
      if (own[key] && own[key] !== "inherit") style[key] = own[key];
    }
    if (own.display === "none") return;
    const op = Number(own.opacity ?? 1);
    if (!Number.isFinite(op)) throw new Error("Unsupported SVG opacity.");
    opacity *= Math.max(0, Math.min(1, op));
    if (opacity === 0) return;
    for (const key of ["clip-path", "mask", "filter"]) {
      if (own[key] && own[key] !== "none") {
        throw new Error(
          `SVG ${key} is not supported. Flatten the effect into vector paths first.`,
        );
      }
    }
    let m = multiply(matrix, transform(own.transform || ""));
    if (tag === "svg" && el !== doc.documentElement) {
      const x = length(el.getAttribute("x")), y = length(el.getAttribute("y"));
      m = multiply(m, [1, 0, 0, 1, x, y]);
    }
    if (tag === "svg" && el.hasAttribute("viewBox")) {
      const box = numbers(el.getAttribute("viewBox"));
      if (box.length !== 4 || box[2] <= 0 || box[3] <= 0) {
        throw new Error("Invalid SVG viewBox.");
      }
      const root = el === doc.documentElement;
      // Root viewport whitespace is intentionally removed by the final geometry fit.
      const width = el.getAttribute("width"),
        height = el.getAttribute("height");
      const w = root && (!width || width.includes("%"))
        ? box[2]
        : length(width, box[2]);
      const h = root && (!height || height.includes("%"))
        ? box[3]
        : length(height, box[3]);
      if (w <= 0 || h <= 0) return;
      let sx = w / box[2], sy = h / box[3], tx = 0, ty = 0;
      const aspect = (el.getAttribute("preserveAspectRatio") || "xMidYMid meet")
        .trim();
      if (aspect !== "none") {
        const a = aspect.match(
          /^(xMin|xMid|xMax)(YMin|YMid|YMax)(?:\s+(meet|slice))?$/,
        );
        if (!a) throw new Error("Unsupported SVG preserveAspectRatio.");
        sx = sy = a[3] === "slice" ? Math.max(sx, sy) : Math.min(sx, sy);
        tx = (w - box[2] * sx) * ({ xMin: 0, xMid: 0.5, xMax: 1 }[a[1]]);
        ty = (h - box[3] * sy) * ({ YMin: 0, YMid: 0.5, YMax: 1 }[a[2]]);
        if (a[3] === "slice") {
          warnings.add(
            "Viewport clipping is not applied; geometry outside the viewport is included.",
          );
        }
      }
      m = multiply(m, [sx, 0, 0, sy, tx - box[0] * sx, ty - box[1] * sy]);
    }
    if (tag === "use") {
      const href = el.getAttribute("href") ||
        el.getAttributeNS("http://www.w3.org/1999/xlink", "href") || "";
      if (!href.startsWith("#") || !ids.has(href.slice(1))) {
        throw new Error("SVG use requires an existing, local #id reference.");
      }
      const target = ids.get(href.slice(1));
      if (stack.includes(target)) {
        throw new Error("SVG contains a recursive use reference.");
      }
      if (target.localName === "symbol") {
        throw new Error(
          "SVG symbol instances are not supported. Expand the instance to paths.",
        );
      }
      walk(
        target,
        style,
        multiply(m, [
          1,
          0,
          0,
          1,
          length(el.getAttribute("x")),
          length(el.getAttribute("y")),
        ]),
        opacity,
        [...stack, target],
        true,
      );
      return;
    }
    if (["svg", "g", "a"].includes(tag)) {
      for (const child of el.children) walk(child, style, m, opacity, stack);
      return;
    }
    if (["title", "desc", "metadata", "style"].includes(tag)) return;
    if (style.visibility === "hidden" || style.visibility === "collapse") {
      return;
    }
    const attr = (name, fallback = 0) =>
      length(el.getAttribute(name), fallback);
    let paths = [];
    if (tag === "path") paths = parsePath(el.getAttribute("d") || "", m);
    else if (tag === "line") {
      const p = new Path([attr("x1"), attr("y1")], m);
      p.line([attr("x2"), attr("y2")]);
      paths = [p];
    } else if (tag === "polyline" || tag === "polygon") {
      const values = numbers(el.getAttribute("points") || "");
      if (values.length % 2) {
        throw new Error("SVG points must contain coordinate pairs.");
      }
      if (values.length >= 4) {
        const p = new Path(values.slice(0, 2), m);
        for (let i = 2; i < values.length; i += 2) {
          p.line(values.slice(i, i + 2));
        }
        if (tag === "polygon") p.close();
        paths = [p];
      }
    } else if (tag === "circle" || tag === "ellipse") {
      const cx = attr("cx"),
        cy = attr("cy"),
        rx = tag === "circle" ? attr("r") : attr("rx"),
        ry = tag === "circle" ? rx : attr("ry");
      if (rx < 0 || ry < 0) throw new Error("SVG radii cannot be negative.");
      if (rx > 0 && ry > 0) {
        const p = new Path([cx + rx, cy], m);
        p.ellipse([cx, cy], [rx, 0], [0, ry], 0, 2 * Math.PI);
        p.close();
        paths = [p];
      }
    } else if (tag === "rect") {
      const x = attr("x"), y = attr("y"), w = attr("width"), h = attr("height");
      if (w < 0 || h < 0) {
        throw new Error("SVG rectangle sizes cannot be negative.");
      }
      if (w > 0 && h > 0) {
        let rx = attr("rx", attr("ry")), ry = attr("ry", rx);
        if (rx < 0 || ry < 0) throw new Error("SVG radii cannot be negative.");
        rx = Math.min(rx, w / 2);
        ry = Math.min(ry, h / 2);
        const p = new Path([x + rx, y], m);
        if (rx && ry) {
          p.line([x + w - rx, y]);
          p.ellipse(
            [x + w - rx, y + ry],
            [rx, 0],
            [0, ry],
            -Math.PI / 2,
            Math.PI / 2,
          );
          p.line([x + w, y + h - ry]);
          p.ellipse([x + w - rx, y + h - ry], [rx, 0], [0, ry], 0, Math.PI / 2);
          p.line([x + rx, y + h]);
          p.ellipse(
            [x + rx, y + h - ry],
            [rx, 0],
            [0, ry],
            Math.PI / 2,
            Math.PI / 2,
          );
          p.line([x, y + ry]);
          p.ellipse([x + rx, y + ry], [rx, 0], [0, ry], Math.PI, Math.PI / 2);
        } else {
          p.line([x + w, y]);
          p.line([x + w, y + h]);
          p.line([x, y + h]);
        }
        p.close();
        paths = [p];
      }
    } else {
      warnings.add(
        `Skipped SVG <${tag}>. Convert text/images and unsupported objects to paths.`,
      );
      return;
    }
    if (!paths.length) return;
    const fill = tag !== "line" && style.fill !== "none" &&
      Number(style["fill-opacity"]) > 0;
    let stroke = style.stroke !== "none" && Number(style["stroke-opacity"]) > 0
      ? length(style["stroke-width"], 1)
      : 0;
    if (stroke < 0) throw new Error("SVG stroke width cannot be negative.");
    if (!["nonzero", "evenodd"].includes(style["fill-rule"])) {
      throw new Error("Invalid SVG fill-rule.");
    }
    if (stroke > 0) {
      if (own["vector-effect"] && own["vector-effect"] !== "none") {
        throw new Error(
          "SVG vector-effect is not supported. Outline the stroke before importing.",
        );
      }
      const sx = Math.hypot(m[0], m[1]), sy = Math.hypot(m[2], m[3]);
      if (
        Math.abs(sx - sy) > 1e-6 || Math.abs(m[0] * m[2] + m[1] * m[3]) > 1e-6
      ) {
        warnings.add(
          "Nonuniformly transformed strokes use an approximate uniform width.",
        );
      }
      stroke *= Math.max(sx, sy);
      if (style["stroke-dasharray"] && style["stroke-dasharray"] !== "none") {
        warnings.add("Dashed SVG strokes are imported as continuous strokes.");
      }
      warnings.add(
        "SVG strokes use round caps and joins. Outline strokes in your drawing editor for exact cap/join shapes.",
      );
    }
    if (
      opacity < 1 || Number(style["fill-opacity"]) < 1 ||
      Number(style["stroke-opacity"]) < 1
    ) warnings.add("Partial opacity is treated as solid geometry.");
    if (fill || stroke > 0) {
      groups.push({ paths, fill, stroke, rule: style["fill-rule"] });
    }
  }
  walk(doc.documentElement, defaults, identity);
  return { groups, warnings: [...warnings], flipY: true };
}
