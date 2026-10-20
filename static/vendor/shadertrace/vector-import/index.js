import { flatten, generateGLSL, LIMITS } from "./geometry.js";
import { parseSVG } from "./svg.js";
import { parseDXF } from "./dxf.js";

export function convertVector(text, format, options = {}) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("The drawing is empty.");
  }
  if (new TextEncoder().encode(text).length > LIMITS.bytes) {
    throw new Error("Drawing exceeds the 2 MB import limit.");
  }
  format = format.toLowerCase().replace(/^\./, "");
  if (!["svg", "dxf"].includes(format)) {
    throw new Error("Choose an SVG or ASCII DXF file.");
  }
  const tolerance = options.tolerance ?? 0.002,
    strokeWidth = options.strokeWidth ?? 0.012,
    mode = options.mode ?? "filled";
  if (!Number.isFinite(tolerance) || tolerance < 0.0001 || tolerance > 0.02) {
    throw new Error("Curve tolerance must be between 0.0001 and 0.02.");
  }
  if (
    !Number.isFinite(strokeWidth) || strokeWidth < 0.001 || strokeWidth > 0.2
  ) throw new Error("Line width must be between 0.001 and 0.2.");
  if (!["filled", "outline"].includes(mode)) {
    throw new Error("Unknown import mode.");
  }
  const parsed = format === "svg"
    ? parseSVG(text, options.DOMParser)
    : parseDXF(text, options.layers);
  const geometry = flatten(
    parsed.groups,
    tolerance,
    strokeWidth,
    mode === "outline",
    parsed.flipY,
  );
  const warnings = [...parsed.warnings];
  if (geometry.segments > 256) {
    warnings.push(
      "This drawing has over 256 segments; gradient styles and large exports may render slowly.",
    );
  }
  return {
    code: generateGLSL(geometry),
    geometry,
    warnings,
    stats: {
      segments: geometry.segments,
      shapes: geometry.groups.length,
      format,
    },
  };
}
