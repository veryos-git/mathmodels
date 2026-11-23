import {
  flatten,
  generateDataGLSL,
  generateGLSL,
  LIMITS,
  Path,
  point,
} from "./geometry.js";
import { parseSVG } from "./svg.js";
import { parseDXF } from "./dxf.js";

export function parseVector(text, format, options = {}) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("The drawing is empty.");
  }
  if (new TextEncoder().encode(text).length > LIMITS.bytes) {
    throw new Error(
      `Drawing exceeds the ${LIMITS.bytes / 1048576} MB import limit.`,
    );
  }
  format = format.toLowerCase().replace(/^\./, "");
  if (!["svg", "dxf"].includes(format)) {
    throw new Error("Choose an SVG or ASCII DXF file.");
  }
  const parsed = format === "svg"
    ? parseSVG(text, options.DOMParser)
    : parseDXF(text, options.layers);
  return { ...parsed, format };
}

// flatten() flips every drawing or none, so a y-down drawing that joins y-up
// ones is mirrored beforehand.
function mirrored(path) {
  const flip = (p) => [p[0], -p[1]];
  const output = new Path(flip(point(path.matrix, path.start)));
  output.pieces = path.pieces.map((f) => (t) => flip(f(t)));
  output.closed = path.closed;
  return output;
}

// Several parsed drawings become one field. Each keeps its own coordinates, so
// sketches exported from the same CAD document line up; `mode` on a drawing
// overrides options.mode for that drawing.
export function convertParsed(drawings, options = {}) {
  const tolerance = options.tolerance ?? 0.002,
    strokeWidth = options.strokeWidth ?? 0.012,
    modes = drawings.map((d) => d.mode ?? options.mode ?? "filled");
  if (!Number.isFinite(tolerance) || tolerance < 0.0001 || tolerance > 0.02) {
    throw new Error("Curve tolerance must be between 0.0001 and 0.02.");
  }
  if (
    !Number.isFinite(strokeWidth) || strokeWidth < 0.001 || strokeWidth > 0.2
  ) throw new Error("Line width must be between 0.001 and 0.2.");
  if (modes.some((mode) => !["filled", "outline"].includes(mode))) {
    throw new Error("Unknown import mode.");
  }
  const flipY = drawings.every((d) => d.flipY);
  const groups = drawings.flatMap((d, i) =>
    d.groups.map((g) => ({
      ...g,
      paths: d.flipY && !flipY ? g.paths.map(mirrored) : g.paths,
      outline: modes[i] === "outline",
    }))
  );
  const geometry = flatten(groups, tolerance, strokeWidth, false, flipY);
  const warnings = [...new Set(drawings.flatMap((d) => d.warnings))];
  // Small drawings stay self-contained GLSL; the rest read a data texture.
  let shader = geometry.segments <= LIMITS.inlineSegments
    ? { code: generateGLSL(geometry), data: null }
    : null;
  if (
    !shader ||
    new TextEncoder().encode(shader.code).length > LIMITS.inlineBytes
  ) shader = generateDataGLSL(geometry);
  // A textured field skips distant edges, which makes each segment several times cheaper.
  const slow = shader.data ? 8192 : 256;
  if (geometry.segments > slow) {
    warnings.push(
      `This drawing has over ${slow} segments; gradient styles and large exports may render slowly.`,
    );
  }
  return {
    ...shader,
    geometry,
    warnings,
    stats: {
      segments: geometry.segments,
      shapes: geometry.groups.length,
      format: [...new Set(drawings.map((d) => d.format))].join("+"),
    },
  };
}

export function convertVector(text, format, options = {}) {
  return convertParsed([parseVector(text, format, options)], options);
}
