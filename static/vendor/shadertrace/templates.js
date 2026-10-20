import { visualizationTemplates } from "./visualization-templates.js";

// Keep the original IDs and code so existing template copies retain their parents.
const starters = [
  {
    id: "circle",
    kind: "sdf",
    name: "Circle",
    description: "The simplest signed distance field.",
    code: `// Negative inside. Zero on the edge. Positive outside.
float sdf(vec2 p) {
    float radius = 0.48;
    return length(p) - radius;
}`,
  },
  {
    id: "rounded-box",
    kind: "sdf",
    name: "Rounded box",
    description: "A rotating rectangle with soft corners.",
    code: `float sdf(vec2 p) {
    float angle = 6.283185 * u_time / u_duration;
    p = mat2(cos(angle), -sin(angle), sin(angle), cos(angle)) * p;
    vec2 q = abs(p) - vec2(0.42, 0.28);
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.12;
}`,
  },
  {
    id: "ring",
    kind: "sdf",
    name: "Ring",
    description: "A circular band with two boundaries.",
    code: `float sdf(vec2 p) {
    return abs(length(p) - 0.48) - 0.12;
}`,
  },
  {
    id: "hexagon",
    kind: "sdf",
    name: "Hexagon",
    description: "A regular six-sided polygon.",
    code: `float sdf(vec2 p) {
    const vec3 k = vec3(-0.8660254, 0.5, 0.5773503);
    p = abs(p);
    p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
    p -= vec2(clamp(p.x, -k.z * 0.5, k.z * 0.5), 0.5);
    return length(p) * sign(p.y);
}`,
  },
  {
    id: "orbit",
    kind: "sdf",
    name: "Soft orbit",
    description: "Two circles blending through a looping orbit.",
    code: `float sdf(vec2 p) {
    float angle = 6.283185 * u_time / u_duration;
    vec2 center = 0.34 * vec2(cos(angle), sin(angle));
    float a = length(p - center) - 0.30;
    float b = length(p + center) - 0.30;
    float blend = 0.22;
    float h = max(blend - abs(a - b), 0.0) / blend;
    return min(a, b) - h * h * blend * 0.25;
}`,
  },
  {
    id: "contours",
    kind: "visualization",
    name: "Luminous contours",
    description: "Moving isolines reveal the distance to the surface.",
    code: `vec3 shade(vec2 p, float d) {
    vec3 ink = vec3(0.025, 0.035, 0.055);
    vec3 mint = vec3(0.44, 0.95, 0.76);
    vec3 blue = vec3(0.20, 0.42, 0.68);
    vec3 tint = d < 0.0 ? blue : mint;
    float phase = 6.283185 * u_time / u_duration;
    float bands = pow(0.5 + 0.5 * cos(70.0 * d - phase), 14.0);
    float glow = exp(-4.0 * abs(d));
    float edge = 1.0 - smoothstep(0.0, 3.0 / u_resolution.y, abs(d));
    vec3 color = ink + tint * (0.06 + 0.32 * bands) * glow;
    return mix(color, vec3(0.86, 1.0, 0.94), edge);
}`,
  },
  {
    id: "silhouette",
    kind: "visualization",
    name: "Silhouette",
    description: "A clean, antialiased fill of the field.",
    code: `vec3 shade(vec2 p, float d) {
    float aa = 2.0 / min(u_resolution.x, u_resolution.y);
    float fill = 1.0 - smoothstep(-aa, aa, d);
    return mix(vec3(0.035, 0.045, 0.065), vec3(0.55, 0.95, 0.76), fill);
}`,
  },
  {
    id: "neon",
    kind: "visualization",
    name: "Neon glow",
    description: "A violet outline with a soft luminous falloff.",
    code: `vec3 shade(vec2 p, float d) {
    vec3 neon = vec3(0.65, 0.35, 1.0);
    float glow = 0.014 / (abs(d) + 0.014);
    float core = exp(-220.0 * abs(d));
    return vec3(0.018, 0.012, 0.035) + neon * glow + vec3(core);
}`,
  },
  {
    id: "heatmap",
    kind: "visualization",
    name: "Distance heatmap",
    description: "A continuous palette across negative and positive distance.",
    code: `vec3 shade(vec2 p, float d) {
    float value = 0.65 * d + 0.4;
    vec3 color = 0.5 + 0.5 * cos(6.283185 * (value + vec3(0.0, 0.33, 0.67)));
    float edge = 1.0 - smoothstep(0.0, 0.006, abs(d));
    return mix(color, vec3(1.0), edge);
}`,
  },
  {
    id: "normals",
    kind: "visualization",
    name: "Surface normals",
    description: "The local gradient, mapped into color.",
    code: `vec3 shade(vec2 p, float d) {
    float e = 2.0 / min(u_resolution.x, u_resolution.y);
    vec2 gradient = vec2(
        sdf(p + vec2(e, 0.0)) - sdf(p - vec2(e, 0.0)),
        sdf(p + vec2(0.0, e)) - sdf(p - vec2(0.0, e))
    );
    vec2 normal = gradient / max(length(gradient), 0.00001);
    vec3 color = vec3(normal * 0.5 + 0.5, 0.65);
    return color * (0.3 + 0.7 * exp(-2.0 * abs(d)));
}`,
  },
];

export const builtins = [
  ...starters.filter((template) => template.kind === "sdf"),
  ...visualizationTemplates.map((template) => ({
    ...template,
    code:
      template.code ??
      starters.find((original) => original.id === template.id).code,
  })),
].map((template) => ({ ...template, builtin: true, parentId: null }));
