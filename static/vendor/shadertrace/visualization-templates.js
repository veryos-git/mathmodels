// Catalogue numbers match hgc/sdf/signed_distance_field.md. Helpers are expanded
// into each template so saved copies stay self-contained and fully editable.
const helpers = {
  base: `const float stTau = 6.28318530718;
const vec3 stInk = vec3(0.035, 0.055, 0.09);
const vec3 stPaper = vec3(0.96, 0.94, 0.88);
const vec3 stMint = vec3(0.23, 0.83, 0.73);
const vec3 stOrange = vec3(0.98, 0.43, 0.18);
float stPixel() { return 2.0 / min(u_resolution.x, u_resolution.y); }
float stPhase() { return stTau * u_time / u_duration; }
float stFill(float d) { return 1.0 - smoothstep(-stPixel(), stPixel(), d); }
float stLine(float d, float level, float width) {
    float aa = max(0.5 * fwidth(d), 0.5 * stPixel());
    return 1.0 - smoothstep(width - aa, width + aa, abs(d - level));
}
float stBands(float d, float spacing, float width) {
    float footprint = max(fwidth(d), stPixel());
    float nearest = abs(mod(d + spacing * 0.5, spacing) - spacing * 0.5);
    float line = 1.0 - smoothstep(width - footprint * 0.5, width + footprint * 0.5, nearest);
    return mix(line, min(2.0 * width / spacing, 1.0), smoothstep(spacing * 0.5, spacing, footprint));
}`,
  palette: `vec3 stPalette(float t) {
    return 0.5 + 0.5 * cos(stTau * (t + vec3(0.02, 0.32, 0.62)));
}
vec3 stHeat(float v) {
    v = clamp(v, 0.0, 1.0);
    return mix(mix(vec3(0.06, 0.16, 0.35), stMint, min(v * 2.0, 1.0)), stOrange, max(v * 2.0 - 1.0, 0.0));
}`,
  gradient: `vec2 stGradient(vec2 p) {
    float e = max(0.001, stPixel());
    return vec2(sdf(p + vec2(e, 0.0)) - sdf(p - vec2(e, 0.0)),
                sdf(p + vec2(0.0, e)) - sdf(p - vec2(0.0, e))) / (2.0 * e);
}
vec2 stNormal(vec2 p) {
    vec2 g = stGradient(p);
    return g / max(length(g), 0.00001);
}`,
  noise: `float stHash(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
}
float stNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(stHash(i), stHash(i + vec2(1, 0)), f.x),
               mix(stHash(i + vec2(0, 1)), stHash(i + vec2(1)), f.x), f.y);
}
float stFbm(vec2 p) {
    return 0.6 * stNoise(p) + 0.27 * stNoise(p * 2.13) + 0.13 * stNoise(p * 4.37);
}`,
  segment: `float stSegment(vec2 p, vec2 a, vec2 b) {
    vec2 v = b - a;
    return length(p - a - v * clamp(dot(p - a, v) / max(dot(v, v), 0.000001), 0.0, 1.0));
}`,
  relief: `vec3 stRelief(vec2 p, float d) {
    // Height = 0.20 * (1 - exp(d / 0.10)) inside the shape.
    float dh = -2.0 * exp(min(d, 0.0) / 0.10);
    return normalize(vec3(-dh * stGradient(p), 1.0));
}
float stLighting(vec3 n) { return max(dot(n, normalize(vec3(-0.4, 0.6, 0.7))), 0.0); }`,
  background: `vec3 stBackground(vec2 p) {
    float checks = mod(floor(p.x * 7.0) + floor(p.y * 7.0), 2.0);
    return mix(vec3(0.10, 0.25, 0.38), vec3(0.73, 0.86, 0.75), checks);
}`,
  digits: `// Seven-segment glyphs: numeric values are rendered in the shader itself.
float stDigit(vec2 p, int digit) {
    const int masks[10] = int[10](63, 6, 91, 79, 102, 109, 125, 7, 127, 111);
    int bits = masks[clamp(digit, 0, 9)];
    const vec2 a[7] = vec2[7](vec2(-.2,.4),vec2(.24,.36),vec2(.24,-.04),vec2(-.2,-.4),vec2(-.24,-.36),vec2(-.24,.04),vec2(-.2,0));
    const vec2 b[7] = vec2[7](vec2(.2,.4),vec2(.24,.04),vec2(.24,-.36),vec2(.2,-.4),vec2(-.24,-.04),vec2(-.24,.36),vec2(.2,0));
    float distanceToGlyph = 10.0;
    for (int i = 0; i < 7; i++) if ((bits & (1 << i)) != 0)
        distanceToGlyph = min(distanceToGlyph, stSegment(p, a[i], b[i]));
    return 1.0 - smoothstep(0.045, 0.075, distanceToGlyph);
}
float stNumber(vec2 p, float value) {
    int rounded = int(floor(min(abs(value), 9.9) * 10.0 + 0.5));
    float glyph = stDigit(p - vec2(-.18, 0), rounded / 10);
    glyph = max(glyph, stDigit(p - vec2(.56, 0), rounded % 10));
    glyph = max(glyph, 1.0 - smoothstep(.055, .085, length(p - vec2(.18, -.39))));
    float signLine = stSegment(p, vec2(-1.0, 0), vec2(-.6, 0));
    if (value >= 0.0) signLine = min(signLine, stSegment(p, vec2(-.8,-.2), vec2(-.8,.2)));
    return max(glyph, 1.0 - smoothstep(.045, .075, signLine));
}
float stDecimal2(vec2 p, float value) {
    int rounded = int(floor(clamp(value, 0.0, 9.99) * 100.0 + .5));
    float glyph = stDigit(p - vec2(-.65,0), rounded / 100);
    glyph = max(glyph, stDigit(p, (rounded / 10) % 10));
    glyph = max(glyph, stDigit(p - vec2(.65,0), rounded % 10));
    return max(glyph, 1.0 - smoothstep(.055,.085,length(p - vec2(-.32,-.39))));
}`,
  legend: `vec3 stLegend(vec3 color, vec2 p, float maxValue) {
    // Fixed 0..maxValue scale; magenta in the main image marks singularities.
    if (p.x > -.88 && p.x < .88 && p.y > -.94 && p.y < -.72) {
        color = stInk;
        if (p.y > -.82 && p.y < -.75) color = stHeat(clamp((p.x + .8) / 1.6, 0.0, 1.0));
        float labels = stDecimal2((p - vec2(-.72,-.89)) / .055, 0.0);
        labels = max(labels, stDecimal2((p - vec2(0,-.89)) / .055, maxValue * .5));
        labels = max(labels, stDecimal2((p - vec2(.72,-.89)) / .055, maxValue));
        color = mix(color, stPaper, labels);
    }
    return color;
}`,
  scene: `// Lift the selected 2D SDF into a rounded, finite 3D extrusion.
// Sphere tracing assumes sdf() is a distance bound; arbitrary warps may need smaller steps.
float stScene(vec3 p) {
    vec2 w = vec2(sdf(p.xy), abs(p.z) - 0.16);
    return min(max(w.x, w.y), 0.0) + length(max(w, 0.0)) - 0.025;
}
vec3 stSceneNormal(vec3 p) {
    const float e = 0.001;
    vec3 g = vec3(stScene(p + vec3(e,0,0)) - stScene(p - vec3(e,0,0)),
                  stScene(p + vec3(0,e,0)) - stScene(p - vec3(0,e,0)),
                  stScene(p + vec3(0,0,e)) - stScene(p - vec3(0,0,e)));
    return g / max(length(g), 0.000001);
}`,
  camera: `void stCamera(vec2 p, out vec3 origin, out vec3 ray) {
    float angle = 0.25 * sin(stPhase());
    origin = vec3(1.3 + angle, 1.0, 2.4);
    vec3 forward = normalize(-origin);
    vec3 right = normalize(cross(forward, vec3(0,1,0)));
    vec3 up = cross(right, forward);
    ray = normalize(forward * 2.5 + right * p.x + up * p.y);
}`,
};
const dependencies = {
  relief: ["gradient"],
  digits: ["segment"],
  legend: ["palette", "digits"],
};
const groups = [
  [10, "Edges, fills, light & shadow"],
  [20, "Distance maps & contours"],
  [24, "Motion & broken contours"],
  [32, "Print, texture & erosion"],
  [38, "Directions, flows & projection"],
  [48, "Relief & materials"],
  [50, "Multiple fields"],
  [56, "Diagnostics & scientific views"],
  [60, "3D, shadows, volume & particles"],
];

function style(number, name, description, needs, code, id) {
  const included = new Set();
  const add = (key) => {
    for (const dependency of dependencies[key] || []) add(dependency);
    included.add(key);
  };
  add("base");
  needs.forEach(add);
  return {
    id: id || `style-${String(number).padStart(2, "0")}`,
    kind: "visualization",
    catalogNumber: number,
    category: groups.find(([last]) => number <= last)[1],
    name,
    description,
    code:
      code === null
        ? null
        : `// ${String(number).padStart(2, "0")} — ${name}\n// ${description}\n\n${[...included].map((key) => helpers[key]).join("\n\n")}\n\n${code}`,
  };
}

export const visualizationTemplates = [
  style(
    1,
    "Flat silhouette",
    "Antialiased fill of the negative-distance region.",
    [],
    null,
    "silhouette",
  ),
  style(
    2,
    "Boundary-only line",
    "A single contour on a warm paper background.",
    [],
    `vec3 shade(vec2 p, float d) {
    return mix(stPaper, stInk, stLine(d, 0.0, 0.012));
}`,
  ),
  style(
    3,
    "Double / nested outline",
    "Two independently colored offsets from the boundary.",
    [],
    `vec3 shade(vec2 p, float d) {
    vec3 color = mix(stInk, stMint, stLine(d, -0.035, 0.012));
    return mix(color, stOrange, stLine(d, 0.045, 0.012));
}`,
  ),
  style(
    4,
    "Inner or outer stroke",
    "Mint marks the inner stroke; orange marks the outer stroke.",
    [],
    `vec3 shade(vec2 p, float d) {
    float inside = stFill(d);
    float stroke = 1.0 - smoothstep(0.045 - stPixel(), 0.045 + stPixel(), abs(d));
    return mix(stInk, mix(stOrange, stMint, inside), stroke);
}`,
  ),
  style(
    5,
    "Feathered silhouette",
    "A wide, soft transition across the zero-distance boundary.",
    [],
    `vec3 shade(vec2 p, float d) {
    return mix(stInk, stMint, 1.0 - smoothstep(-0.10, 0.10, d));
}`,
  ),
  style(
    6,
    "Inner glow",
    "Light fades inward from the edge and stays inside the shape.",
    [],
    `vec3 shade(vec2 p, float d) {
    return stInk + stMint * stFill(d) * exp(-13.0 * abs(d));
}`,
  ),
  style(
    7,
    "Outer halo",
    "An exterior halo surrounding a dark silhouette.",
    [],
    `vec3 shade(vec2 p, float d) {
    return stInk + stMint * (1.0 - stFill(d)) * exp(-9.0 * abs(d));
}`,
  ),
  style(
    8,
    "Neon tube",
    "A bright narrow core with a wide violet halo.",
    [],
    null,
    "neon",
  ),
  style(
    9,
    "Drop shadow",
    "A displaced, softened field under the original face.",
    [],
    `vec3 shade(vec2 p, float d) {
    float shadow = 1.0 - smoothstep(-0.04, 0.09, sdf(p - vec2(0.10, -0.10)));
    return mix(mix(stPaper, stInk, shadow * 0.65), stMint, stFill(d));
}`,
  ),
  style(
    10,
    "Inner shadow / inset",
    "A displaced underlay clipped to the shape interior.",
    [],
    `vec3 shade(vec2 p, float d) {
    float shadow = smoothstep(-0.06, 0.04, sdf(p - vec2(0.055, -0.055)));
    vec3 face = mix(stMint, stInk, 0.8 * shadow);
    return mix(stPaper, face, stFill(d));
}`,
  ),
  style(
    11,
    "Signed grayscale",
    "Fixed range −0.5 to +0.5; midgray is the boundary.",
    [],
    `vec3 shade(vec2 p, float d) { return vec3(clamp(0.5 + d, 0.0, 1.0)); }`,
  ),
  style(
    12,
    "Diverging distance ramp",
    "Blue inside, neutral at zero, orange outside; range ±0.5.",
    [],
    `vec3 shade(vec2 p, float d) {
    vec3 color = mix(vec3(0.12,0.38,0.71), stPaper, clamp(1.0 + d / 0.5, 0.0, 1.0));
    return mix(color, stOrange, clamp(d / 0.5, 0.0, 1.0));
}`,
  ),
  style(
    13,
    "Cyclic / cosine color bands",
    "A periodic RGB distance palette; repeated colors do not encode unique distances.",
    [],
    null,
    "heatmap",
  ),
  style(
    14,
    "Quantized distance zones",
    "Discrete colored terraces at fixed distance intervals.",
    ["palette"],
    `vec3 shade(vec2 p, float d) {
    return stPalette(floor((d + 0.45) * 7.0) / 11.0);
}`,
  ),
  style(
    15,
    "Repeating isolines",
    "The original luminous contours, with a highlighted zero contour.",
    [],
    null,
    "contours",
  ),
  style(
    16,
    "Major/minor contour map",
    "Thin contours every 0.06 units; major lines every fifth level.",
    [],
    `vec3 shade(vec2 p, float d) {
    vec3 color = mix(stPaper, vec3(0.64,0.70,0.61), stBands(d, 0.06, 0.0015));
    color = mix(color, stInk, stBands(d, 0.30, 0.005));
    return mix(color, stOrange, stLine(d, 0.0, 0.006));
}`,
  ),
  style(
    17,
    "Nonlinear contour spacing",
    "Logarithmic levels pack more contours near the boundary.",
    [],
    `vec3 shade(vec2 p, float d) {
    float warped = sign(d) * log(1.0 + abs(d) / 0.06);
    vec3 paper = mix(stPaper, vec3(0.77,0.86,0.94), stFill(d));
    return mix(paper, stInk, stBands(warped, 0.4, 0.025));
}`,
  ),
  style(
    18,
    "Zebra / alternating bands",
    "Alternating dark and light distance bands.",
    [],
    `vec3 shade(vec2 p, float d) {
    float wave = sin(stTau * d / 0.15);
    float aa = max(fwidth(wave), 0.01);
    return mix(stPaper, stInk, smoothstep(-aa, aa, wave));
}`,
  ),
  style(
    19,
    "Sawtooth / beveled-looking bands",
    "Each distance interval ramps in brightness, then resets.",
    [],
    `vec3 shade(vec2 p, float d) { return mix(stInk, stMint, fract(d / 0.16)); }`,
  ),
  style(
    20,
    "Custom edge transfer texture",
    "An editable procedural color strip indexed by distance; no external image required.",
    [],
    `vec3 stTransfer(float u) {
    const vec3 stops[6] = vec3[6](vec3(.07,.10,.21), vec3(.9,.45,.22), vec3(1,.91,.54), vec3(.2,.3,.42), vec3(.76,.91,.89), vec3(.07,.10,.21));
    float x = clamp(u, 0.0, 1.0) * 5.0;
    int i = min(int(floor(x)), 4);
    return mix(stops[i], stops[i+1], x - float(i));
}
vec3 shade(vec2 p, float d) { return stTransfer((d + 0.22) / 0.50); }`,
  ),
  style(
    21,
    "Traveling pulse / expanding front",
    "An expanding front fades out before the loop resets.",
    [],
    `vec3 shade(vec2 p, float d) {
    float t = fract(u_time / u_duration);
    float radius = mix(-0.4, 1.0, t);
    float fade = sin(3.14159265 * t);
    return stInk + stMint * stLine(d, radius, 0.035) * fade * fade;
}`,
  ),
  style(
    22,
    "Moving contour train",
    "Equally bright contours travel one spacing per animation loop.",
    [],
    `vec3 shade(vec2 p, float d) {
    float lines = stBands(d - 0.14 * u_time / u_duration, 0.14, 0.009);
    return mix(stInk, stMint, lines);
}`,
  ),
  style(
    23,
    "Fading contour echoes",
    "Repeated rings fade with absolute distance from the boundary.",
    [],
    `vec3 shade(vec2 p, float d) {
    float echoes = stBands(d, 0.095, 0.006) * exp(-3.5 * abs(d));
    return mix(stInk, stMint, echoes);
}`,
  ),
  style(
    24,
    "Dashes / marching ants",
    "Animated angular dashes; spacing is angular, not uniform arc length.",
    [],
    `vec3 shade(vec2 p, float d) {
    float angle = atan(p.y, p.x + 0.000001);
    float wave = cos(30.0 * angle - stPhase());
    float dash = smoothstep(-0.12, 0.12, wave);
    return mix(stPaper, stInk, stLine(d, 0.0, 0.024) * dash);
}`,
  ),
  style(
    25,
    "Stippling",
    "Stable random dot density follows distance to the surface.",
    ["noise"],
    `vec3 shade(vec2 p, float d) {
    vec2 cell = floor(p * 110.0);
    float density = 0.75 * exp(-5.0 * abs(d));
    return mix(stPaper, stInk, step(stHash(cell), density));
}`,
  ),
  style(
    26,
    "Ordered dithering",
    "A visible 4×4 Bayer matrix converts distance intensity into coverage.",
    [],
    `vec3 shade(vec2 p, float d) {
    const int bayer[16] = int[16](0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5);
    ivec2 cell = ivec2(mod(floor(p * 80.0), 4.0));
    float threshold = (float(bayer[cell.y * 4 + cell.x]) + 0.5) / 16.0;
    return mix(stPaper, stInk, step(threshold, exp(-5.0 * abs(d))));
}`,
  ),
  style(
    27,
    "Halftone dots",
    "Dot area follows the distance sampled at each grid-cell center.",
    [],
    `vec3 shade(vec2 p, float d) {
    float cells = 18.0;
    vec2 center = (floor(p * cells) + 0.5) / cells;
    float density = exp(-5.0 * abs(sdf(center)));
    float radius = 0.48 * sqrt(density) / cells;
    return mix(stPaper, stInk, stFill(length(p - center) - radius));
}`,
  ),
  style(
    28,
    "Engraving / hatching",
    "Diagonal hatch coverage increases near the zero contour.",
    [],
    `vec3 shade(vec2 p, float d) {
    float density = exp(-5.0 * abs(d));
    float wave = sin((p.x + p.y) * 105.0);
    float aa = max(fwidth(wave), 0.02);
    float threshold = 1.0 - 1.8 * density;
    return mix(stPaper, stInk, smoothstep(threshold - aa, threshold + aa, wave));
}`,
  ),
  style(
    29,
    "Crosshatching",
    "Two crossing hatch layers build a denser tone near the shape.",
    [],
    `vec3 shade(vec2 p, float d) {
    float density = exp(-5.0 * abs(d));
    float a = sin((p.x + p.y) * 105.0), b = sin((p.x - p.y) * 105.0);
    float aa = max(fwidth(a), 0.02), ab = max(fwidth(b), 0.02);
    float threshold = 1.0 - 1.8 * density;
    float lines = smoothstep(threshold - aa, threshold + aa, a);
    lines = max(lines, smoothstep(0.2 - ab, 0.2 + ab, b) * smoothstep(0.55,0.65,density));
    return mix(stPaper, stInk, lines);
}`,
  ),
  style(
    30,
    "Rough / eroded boundary",
    "Procedural noise roughens the fill boundary; modified values are not exact distances.",
    ["noise"],
    `vec3 shade(vec2 p, float d) {
    float rough = d + 0.15 * (stFbm(p * 12.0) - 0.5);
    return mix(stPaper, stInk, stFill(rough));
}`,
  ),
  style(
    31,
    "Burn / dissolve edge",
    "A looping noisy erosion threshold reveals a bright burning rim.",
    ["noise"],
    `vec3 shade(vec2 p, float d) {
    float phase = 0.5 - 0.5 * cos(stPhase());
    float burn = d + 0.20 * (stFbm(p * 13.0) - 0.5) + 0.65 * phase;
    vec3 color = stInk + stOrange * exp(-65.0 * abs(burn));
    color = mix(color, vec3(1,.85,.35), stLine(burn, 0.0, 0.007));
    return mix(color, stPaper, stFill(burn + 0.016));
}`,
  ),
  style(
    32,
    "Textured face or border",
    "Procedural marble moves across an SDF-masked face and border.",
    ["noise", "palette"],
    `vec3 shade(vec2 p, float d) {
    vec2 offset = 0.08 * vec2(cos(stPhase()), sin(stPhase()));
    float marble = sin(30.0 * p.x + 12.0 * stFbm((p + offset) * 7.0));
    vec3 surface = stPalette(0.25 + 0.12 * marble);
    vec3 color = mix(stInk, surface, stFill(d));
    return mix(color, stPaper, stLine(d, 0.0, 0.012));
}`,
  ),
  style(
    33,
    "Gradient RGB",
    "Gradient direction encoded as red and green channels.",
    [],
    null,
    "normals",
  ),
  style(
    34,
    "Gradient-angle hue",
    "A full color wheel maps the direction of the field gradient.",
    ["gradient"],
    `vec3 shade(vec2 p, float d) {
    vec2 n = stNormal(p);
    float hue = atan(n.y, n.x + 0.000001) / stTau;
    vec3 rgb = clamp(abs(fract(hue + vec3(0,2.0/3.0,1.0/3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
    return mix(vec3(0.12), rgb, 0.9);
}`,
  ),
  style(
    35,
    "Gradient arrows",
    "Sparse arrows point toward increasing signed distance.",
    ["gradient", "segment"],
    `vec3 shade(vec2 p, float d) {
    vec2 center = (floor(p / 0.18) + 0.5) * 0.18;
    vec2 n = stNormal(center), side = vec2(-n.y, n.x);
    vec2 q = p - center, tip = n * 0.062;
    float arrow = stSegment(q, -n * 0.055, tip);
    arrow = min(arrow, stSegment(q, tip, tip - n * 0.032 + side * 0.025));
    arrow = min(arrow, stSegment(q, tip, tip - n * 0.032 - side * 0.025));
    vec3 color = mix(stPaper, vec3(.75,.86,.86), stFill(d));
    color = mix(color, stMint * 0.5, stFill(arrow - 0.003) * step(0.1, length(n)));
    return mix(color, stInk, stLine(d,0.0,0.004));
}`,
  ),
  style(
    36,
    "Normal streamlines",
    "Short bidirectional integration filters a sparse seed texture along the gradient.",
    ["gradient", "noise"],
    `float stStreamSeed(vec2 p) {
    vec2 cell = floor(p * 34.0);
    return step(0.84, stHash(cell)) * (1.0 - smoothstep(.12,.22,length(fract(p * 34.0) - .5)));
}
vec3 shade(vec2 p, float d) {
    float sum = stStreamSeed(p);
    for (int direction = -1; direction <= 1; direction += 2) {
        vec2 q = p;
        for (int i = 0; i < 14; i++) {
            vec2 n = stNormal(q);
            q += float(direction) * 0.012 * stNormal(q + float(direction) * 0.006 * n);
            sum += stStreamSeed(q);
        }
    }
    float lines = smoothstep(0.025, 0.17, sum / 29.0);
    return mix(stInk + stMint * stBands(d,.13,.002) * .18, stMint, lines);
}`,
  ),
  style(
    37,
    "Tangent fibers / LIC",
    "Line integral convolution of noise along the tangent creates contour-following fibers.",
    ["gradient", "noise"],
    `vec3 shade(vec2 p, float d) {
    float sum = stNoise(p * 160.0), weight = 1.0;
    for (int direction = -1; direction <= 1; direction += 2) {
        vec2 q = p;
        for (int i = 1; i <= 12; i++) {
            vec2 n = stNormal(q);
            q += float(direction) * 0.008 * vec2(-n.y, n.x);
            float w = 1.0 - float(i) / 13.0;
            sum += w * stNoise(q * 160.0);
            weight += w;
        }
    }
    float fibers = smoothstep(.32,.68,sum / weight);
    return mix(stInk, stMint, fibers) * (0.55 + 0.45 * exp(-abs(d)));
}`,
  ),
  style(
    38,
    "Closest-point texture projection",
    "A procedural checker sampled at p − d∇d extends boundary detail into the field.",
    ["gradient", "background"],
    `vec3 shade(vec2 p, float d) {
    vec2 q = p - d * stGradient(p);
    return mix(stBackground(q), stPaper, stLine(d,0.0,0.003));
}`,
  ),
  style(
    39,
    "Directional bevel",
    "A narrow raised rim lit by a directional light.",
    ["gradient"],
    `vec3 shade(vec2 p, float d) {
    float slope = d < 0.0 && d > -0.11 ? -2.1 : 0.0;
    vec3 n = normalize(vec3(-slope * stGradient(p), 1.0));
    float light = max(dot(n, normalize(vec3(-.4,.6,.7))), 0.0);
    return mix(stInk, stMint * (0.18 + 0.82 * light), stFill(d));
}`,
  ),
  style(
    40,
    "Embossed / debossed surface",
    "A lit recessed height profile; reverse depth to make an emboss.",
    ["gradient"],
    `vec3 shade(vec2 p, float d) {
    float depth = -0.13;
    float t = clamp((d + 0.08) / 0.10, 0.0, 1.0);
    float slope = -depth * 6.0 * t * (1.0 - t) / 0.10;
    vec3 n = normalize(vec3(-slope * stGradient(p), 1.0));
    float light = max(dot(n, normalize(vec3(-.4,.6,.7))), 0.0);
    return stPaper * (0.35 + 0.65 * light);
}`,
  ),
  style(
    41,
    "Rounded / inflated relief",
    "A curved height profile gives the filled shape rounded, glossy edges.",
    ["relief"],
    `vec3 shade(vec2 p, float d) {
    vec3 n = stRelief(p,d);
    float spec = pow(max(dot(n, normalize(vec3(-.22,.32,.92))), 0.0), 35.0);
    return mix(stInk, stMint * (0.2 + 0.8 * stLighting(n)) + 0.5 * spec, stFill(d));
}`,
  ),
  style(
    42,
    "Toon-shaded relief",
    "Rounded relief lighting quantized into four tones.",
    ["relief"],
    `vec3 shade(vec2 p, float d) {
    float light = floor(stLighting(stRelief(p,d)) * 4.0) / 4.0;
    vec3 color = mix(stPaper, stOrange * (0.18 + 0.82 * light), stFill(d));
    return mix(color, stInk, stLine(d,0.0,0.007));
}`,
  ),
  style(
    43,
    "Chrome / reflective bevel",
    "A relief normal reflects an editable procedural studio environment.",
    ["relief"],
    `vec3 shade(vec2 p, float d) {
    vec3 r = reflect(vec3(0,0,-1), stRelief(p,d));
    float bands = pow(0.5 + 0.5 * sin(10.0 * r.y + 3.0 * r.x), 3.0);
    vec3 environment = mix(vec3(.04,.08,.16), vec3(.82,.91,1), bands);
    environment += vec3(.7,.4,.15) * pow(max(r.x,0.0), 12.0);
    return mix(stInk, environment, stFill(d));
}`,
  ),
  style(
    44,
    "Fresnel-style rim",
    "Grazing relief normals create a view-dependent luminous rim.",
    ["relief"],
    `vec3 shade(vec2 p, float d) {
    vec3 n = stRelief(p,d);
    float fresnel = pow(1.0 - max(n.z, 0.0), 2.5);
    return mix(stInk, vec3(.035,.12,.16) + stMint * 2.0 * fresnel, stFill(d));
}`,
  ),
  style(
    45,
    "Glass-like background displacement",
    "A 2D refraction illusion displaces a procedural background near the edge.",
    ["gradient", "background"],
    `vec3 shade(vec2 p, float d) {
    float shift = 0.13 * exp(-11.0 * abs(d));
    vec3 glass = stBackground(p + stNormal(p) * shift);
    vec3 color = mix(stBackground(p), glass, stFill(d));
    return mix(color, vec3(.94,.99,1), stLine(d,0.0,0.007) * .7);
}`,
  ),
  style(
    46,
    "Spatially varying soft focus",
    "Stroke softness changes across a moving diagonal focal plane.",
    [],
    `vec3 shade(vec2 p, float d) {
    float focus = abs(p.x + 0.4 * p.y - 0.35 * sin(stPhase()));
    float blur = stPixel() + 0.10 * focus * focus;
    float stroke = (1.0 - smoothstep(0.014 - blur, 0.014 + blur, abs(d))) * 0.014 / max(0.014, blur);
    return stInk + stMint * stroke;
}`,
  ),
  style(
    47,
    "Paper-cut layers",
    "Four offset paper fills with displaced soft shadows.",
    [],
    `vec3 shade(vec2 p, float d) {
    const vec3 colors[4] = vec3[4](vec3(.66,.83,.74),vec3(.43,.67,.67),vec3(.33,.51,.57),vec3(.24,.37,.47));
    vec3 color = stPaper;
    for (int i = 3; i >= 0; i--) {
        float level = float(i) * 0.09;
        float shadow = 1.0 - smoothstep(-.01,.04,sdf(p - vec2(.025,-.03)) - level);
        color = mix(color, stInk, shadow * .35);
        color = mix(color, colors[i], stFill(d - level));
    }
    return color;
}`,
  ),
  style(
    48,
    "Faux extrusion / long shadow",
    "Overlapping displaced silhouettes build a continuous extrusion behind the face.",
    [],
    `vec3 shade(vec2 p, float d) {
    vec3 color = stInk;
    for (int i = 24; i >= 0; i--) {
        float t = float(i) / 24.0;
        float mask = stFill(sdf(p - vec2(.24,-.22) * t));
        color = mix(color, vec3(.14,.45,.43) * (1.0 - .4 * t), mask);
    }
    return mix(color, stMint, stFill(d));
}`,
  ),
  style(
    49,
    "Interference / moiré",
    "Periodic bands from two scaled, displaced copies of the selected SDF interfere.",
    [],
    `vec3 shade(vec2 p, float d) {
    float a = sdf((p + vec2(.30,0)) / .65) * .65;
    float b = sdf((p - vec2(.30,0)) / .65) * .65;
    float wave = (0.5 + 0.5 * cos(65.0 * a - stPhase())) * (0.5 + 0.5 * cos(65.0 * b + stPhase()));
    return mix(stInk, stMint, wave);
}`,
  ),
  style(
    50,
    "Nearest-shape regions",
    "Field ownership for two displaced copies; equality boundary and distance contours.",
    [],
    `vec3 shade(vec2 p, float d) {
    float a = sdf((p + vec2(.48,0)) / .55) * .55;
    float b = sdf((p - vec2(.48,0)) / .55) * .55;
    vec3 color = a < b ? vec3(.27,.40,.60) : vec3(.87,.47,.29);
    return mix(color, stPaper, max(stBands(min(a,b),.12,.003), stLine(a-b,0.0,.006)));
}`,
  ),
  style(
    51,
    "Distance-quality / Eikonal error",
    "Fixed scale 0–1 for |∇d| − 1 error magnitude. Magenta marks near-zero gradients.",
    ["gradient", "legend"],
    `vec3 shade(vec2 p, float d) {
    float magnitude = length(stGradient(p));
    vec3 color = stHeat(abs(magnitude - 1.0));
    if (magnitude < .2) color = vec3(.85,.1,.65);
    return stLegend(color,p,1.0);
}`,
  ),
  style(
    52,
    "Medial-axis / ridge emphasis",
    "Interior gradient discontinuities reveal ridges; this is a skeleton heuristic.",
    ["gradient"],
    `vec3 shade(vec2 p, float d) {
    float e = max(0.008, stPixel() * 2.0);
    float change = length(stNormal(p + vec2(e,0)) - stNormal(p - vec2(e,0)))
                 + length(stNormal(p + vec2(0,e)) - stNormal(p - vec2(0,e)));
    float ridge = smoothstep(.35,1.3,change) * (1.0 - smoothstep(-.04,0.0,d));
    vec3 color = mix(stInk, vec3(.10,.23,.27), stFill(d));
    color = mix(color, stOrange, ridge);
    return mix(color, stMint, stLine(d,0.0,.003));
}`,
  ),
  style(
    53,
    "Curvature map",
    "Boundary curvature from divergence of normalized gradients; colors clamp to ±8 field⁻¹.",
    ["gradient", "palette", "digits"],
    `vec3 shade(vec2 p, float d) {
    float e = max(.006, stPixel() * 2.0);
    float curvature = (stNormal(p + vec2(e,0)).x - stNormal(p - vec2(e,0)).x
                     + stNormal(p + vec2(0,e)).y - stNormal(p - vec2(0,e)).y) / (2.0 * e);
    vec3 color = mix(stInk, stHeat(0.5 + curvature / 16.0), stLine(d,0.0,.025));
    if (p.y > -.94 && p.y < -.72 && abs(p.x) < .88) {
        color = p.y > -.82 ? stHeat((p.x + .8) / 1.6) : stInk;
        float labels = stNumber((p-vec2(-.72,-.89))/.055,-8.0);
        labels = max(labels,stNumber((p-vec2(0,-.89))/.055,0.0));
        labels = max(labels,stNumber((p-vec2(.72,-.89))/.055,8.0));
        color = mix(color,stPaper,labels);
    }
    return color;
}`,
  ),
  style(
    54,
    "Boundary-projection error",
    "Residual |sdf(p − d∇d)| on a fixed 0–0.1 scale. Magenta marks ambiguous projections.",
    ["gradient", "legend"],
    `vec3 shade(vec2 p, float d) {
    vec2 g = stGradient(p);
    vec2 q = p - d * g;
    float residual = abs(sdf(q));
    vec3 color = stHeat(residual / .1);
    if (length(g) < .2) color = vec3(.85,.1,.65);
    return stLegend(color,p,.1);
}`,
  ),
  style(
    55,
    "Numeric sample grid",
    "Signed distance values rendered as real numeric glyphs at grid-cell centers.",
    ["digits"],
    `vec3 shade(vec2 p, float d) {
    float cells = 5.0;
    vec2 center = (floor(p * cells) + .5) / cells;
    float value = sdf(center);
    vec3 color = mix(vec3(.27,.48,.68),stPaper,clamp(.5+value,0.0,1.0));
    vec2 q = fract(p * cells);
    float grid = 1.0 - smoothstep(.01,.03,min(min(q.x,1.0-q.x),min(q.y,1.0-q.y)));
    color = mix(color, stInk, grid * .35);
    return mix(color, stInk, stNumber((p-center)/.055,value));
}`,
  ),
  style(
    56,
    "Height-surface plot",
    "An oblique ray-intersected graph z = d(x,y), with a grid and highlighted zero height.",
    ["gradient", "palette", "camera"],
    `vec3 shade(vec2 p, float d) {
    vec3 origin, ray;
    stCamera(p,origin,ray);
    float previous = 0.0;
    bool havePrevious = false;
    float hit = -1.0;
    // Scan then bisect the first sign change; this is a graph, not a distance bound.
    for (int i = 0; i < 96; i++) {
        float t = 0.5 + float(i) * .055;
        vec3 q = origin + t * ray;
        float value = q.z - sdf(q.xy);
        bool inDomain = max(abs(q.x),abs(q.y)) < .85;
        if (inDomain && havePrevious && value * previous <= 0.0) {
            float lo = t - .055, hi = t;
            for (int j = 0; j < 7; j++) {
                float mid = .5 * (lo + hi);
                vec3 m = origin + mid * ray;
                if ((m.z - sdf(m.xy)) * previous > 0.0) lo = mid; else hi = mid;
            }
            hit = .5 * (lo + hi); break;
        }
        previous = value; havePrevious = inDomain;
    }
    if (hit < 0.0) return stInk;
    vec3 q = origin + hit * ray;
    vec3 n = normalize(vec3(-stGradient(q.xy),1));
    vec3 color = stPalette(.4 + .6 * q.z) * (.35 + .65 * abs(dot(n,normalize(vec3(-.4,.6,1)))));
    vec2 grid = abs(mod(q.xy + .05,.1) - .05);
    color *= mix(1.0,.4,1.0-smoothstep(.002,.007,min(grid.x,grid.y)));
    return mix(color,stPaper,1.0-smoothstep(.003,.012,abs(q.z)));
}`,
  ),
  style(
    57,
    "Lit 3D surface via sphere tracing",
    "Sphere-traced rounded extrusion of the selected 2D SDF, with 3D normals and lighting.",
    ["scene", "camera"],
    `vec3 shade(vec2 p, float d) {
    vec3 origin, ray;
    stCamera(p,origin,ray);
    float t = 0.0;
    bool hit = false;
    for (int i = 0; i < 80; i++) {
        float distanceToSurface = stScene(origin + t * ray);
        if (distanceToSurface < .001) { hit = true; break; }
        t += max(distanceToSurface * .75, .0005);
        if (t > 6.0) break;
    }
    if (!hit) return stInk;
    vec3 q = origin + t * ray, n = stSceneNormal(q);
    vec3 light = normalize(vec3(-.5,.8,1.2));
    float diffuse = max(dot(n,light),0.0);
    float spec = pow(max(dot(n,normalize(light-ray)),0.0),40.0);
    return stMint * (.18+.82*diffuse) + .6*spec;
}`,
  ),
  style(
    58,
    "2D soft-shadow lighting",
    "Ray-marched clearance toward an orbiting point light gives soft cast shadows.",
    [],
    `vec3 shade(vec2 p, float d) {
    vec2 light = .82 * vec2(cos(stPhase()),sin(stPhase()));
    vec2 delta = light-p;
    float distanceToLight = max(length(delta),.0001);
    vec2 ray = delta / distanceToLight;
    float t = .012, visibility = 1.0;
    if (d > 0.0) for (int i = 0; i < 64; i++) {
        if (t >= distanceToLight) break;
        float h = sdf(p+t*ray);
        if (h < .001) { visibility = 0.0; break; }
        visibility = min(visibility, 10.0*h/t);
        t += max(h*.8,.003);
    }
    vec3 color = stInk + vec3(.65,.77,.58) * visibility * .35 / (1.0+2.0*distanceToLight*distanceToLight);
    color = mix(color,stMint*.65,stFill(d));
    return color + vec3(1,.85,.45)*exp(-120.0*distanceToLight*distanceToLight);
}`,
  ),
  style(
    59,
    "Translucent shells / emissive volume",
    "Front-to-back density integration through a 3D extrusion of the selected shape.",
    ["scene", "camera", "palette"],
    `vec3 shade(vec2 p, float d) {
    vec3 origin, ray;
    stCamera(p,origin,ray);
    vec3 color = vec3(0);
    float transmission = 1.0;
    const float stepLength = .045;
    for (int i = 0; i < 96; i++) {
        vec3 q = origin + (0.8 + float(i)*stepLength) * ray;
        float distanceToShell = stScene(q);
        float density = 12.0 * exp(-abs(distanceToShell)/.035);
        float alpha = 1.0-exp(-density*stepLength);
        vec3 emission = stPalette(.18 + .4*q.z + .06*sin(stPhase()));
        color += transmission * alpha * emission;
        transmission *= 1.0-alpha;
        if (transmission < .01) break;
    }
    return color + transmission*stInk;
}`,
  ),
  style(
    60,
    "Particle disintegration",
    "An SDF-masked face breaks into 2,304 deterministic particles and reassembles each loop.",
    [],
    `// @particles-begin
// This block is also compiled into the particle vertex pass. Keep it vertex-safe.
float stParticleHash(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * .1031);
    q += dot(q,q.yzx+33.33);
    return fract((q.x+q.y)*q.z);
}
float stBreakup() { return .5-.5*cos(6.28318530718*u_time/u_duration); }
float stRelease(vec2 seed) {
    float threshold = stParticleHash(floor((seed+1.0)*24.0)) * .7;
    return smoothstep(threshold,threshold+.3,stBreakup());
}
vec4 stParticle(vec2 seed) {
    float travel = stRelease(seed);
    float random = stParticleHash(seed*83.0);
    vec2 velocity = vec2((random-.5)*.9,.2+.6*random);
    vec2 position = seed + velocity * travel;
    position.x += .06*sin(9.0*travel+random*6.283185)*travel;
    float opacity = step(sdf(seed),0.0) * smoothstep(0.0,.12,travel) * (1.0-.75*travel);
    return vec4(position, .007 + .004*random, opacity);
}
vec3 stParticleColor(vec2 seed) { return mix(vec3(.23,.83,.73),vec3(1,.73,.3),stParticleHash(seed*19.0)); }
// @particles-end
vec3 shade(vec2 p, float d) {
    float remaining = 1.0-stRelease(p);
    return mix(stInk,stMint,stFill(d)*remaining);
}`,
  ),
];
