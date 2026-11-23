import { builtins } from './vendor/shadertrace/templates.js';
import { convertParsed, parseVector } from './vendor/shadertrace/vector-import/index.js';
import { LIMITS } from './vendor/shadertrace/vector-import/geometry.js';

// The default preview: style 8 (Neon tube) in #ffc100. Every ripple is an exact
// offset of the source paths, which only a geometrically correct field can draw.
const AMBER_NEON = {
  id: 'amber-neon', kind: 'visualization', category: 'Featured', name: 'Amber neon',
  description: 'A white-hot tube with a breathing #ffc100 halo. Faint ripples travel outward along exact offsets of the paths.',
  code: `// Amber neon — the default preview.
// A white-hot tube with a #ffc100 halo. The halo breathes, and faint echoes travel
// outward along exact offset curves: every ripple stays parallel to the source path.

const float neonTau = 6.28318530718;
const vec3 neonAmber = vec3(1.0, 0.757, 0.0); // #ffc100

vec3 shade(vec2 p, float d) {
    float phase = neonTau * u_time / u_duration;
    float breath = 0.5 + 0.5 * sin(2.0 * phase); // two slow breaths per loop

    // Distance to the tube: the stroke itself, or a thin band inside a filled edge.
    float r = max(d, 0.0) + max(-d - 0.008, 0.0);

    float reach = mix(0.010, 0.020, breath);
    float halo = reach / (r + reach) * mix(0.85, 1.0, breath);
    float echo = pow(0.5 + 0.5 * cos(neonTau * r / 0.075 - 4.0 * phase), 24.0);
    echo *= 0.40 * exp(-r / 0.10) * smoothstep(0.015, 0.05, r);
    float core = exp(-220.0 * r);

    return vec3(0.020, 0.014, 0.008) + neonAmber * (halo + echo) + vec3(1.0, 0.96, 0.86) * core;
}`,
};

export const SHADER_STYLES = [AMBER_NEON, ...builtins.filter(item => item.kind === 'visualization')];
export const SHADER_DEFAULTS = Object.freeze({
  sources: Object.freeze([]), style: AMBER_NEON.id, mode: 'auto', tolerance: .002,
  strokeWidth: .012, resolution: 512, duration: 8, playing: true,
  exportSize: 512, gifFps: 20,
});
// Square PNG/GIF export sizes. GIF frame delays are whole hundredths of a second.
export const EXPORT_SIZES = [256, 512, 1024, 2048, 4096];
export const GIF_FRAME_RATES = [10, 20, 25, 50];
const allowed = (value, values, fallback) => values.includes(value) ? value : fallback;

export function shaderSettings(value = {}) {
  value = value && typeof value === 'object' ? value : {};
  return {
    // Projects saved before several sources could be combined name a single one.
    sources: Array.isArray(value.sources) ? [...new Set(value.sources.filter(id => typeof id === 'string'))]
      : typeof value.source === 'string' && value.source ? [value.source] : [],
    style: allowed(value.style, SHADER_STYLES.map(s => s.id), SHADER_DEFAULTS.style),
    mode: allowed(value.mode, ['auto', 'filled', 'outline'], 'auto'),
    tolerance: allowed(Number(value.tolerance), [.008, .002, .0005], .002),
    strokeWidth: Number.isFinite(Number(value.strokeWidth))
      ? Math.max(.001, Math.min(.2, Number(value.strokeWidth))) : .012,
    resolution: allowed(Number(value.resolution), [256, 512, 1024], 512),
    duration: Number.isFinite(Number(value.duration))
      ? Math.max(1, Math.min(60, Number(value.duration))) : 8,
    playing: typeof value.playing === 'boolean' ? value.playing : true,
    exportSize: allowed(Number(value.exportSize), EXPORT_SIZES, 512),
    gifFps: allowed(Number(value.gifFps), GIF_FRAME_RATES, 20),
  };
}

const megabytes = LIMITS.bytes / 1048576;
const parses = new WeakMap(), fileIds = new WeakMap(), conversions = new Map();
let fileCount = 0;
const fileId = file => fileIds.get(file) || (fileIds.set(file, ++fileCount), fileCount);
// Bound memory when someone repeatedly adjusts the line width or the DXF layers.
function remember(cache, key, value) {
  if (cache.size >= 8) cache.delete(cache.keys().next().value);
  cache.set(key, value);
  return value;
}

async function parsedSource(source) {
  const file = source.file;
  if (!file || !/\.(dxf|svg)$/i.test(file.name)) throw new Error('Choose an SVG or ASCII DXF drawing or profile.');
  if (file.size > LIMITS.bytes) throw new Error(`Shader previews support files up to ${megabytes} MB. Simplify this drawing to preview it.`);
  const layers = source.layers || null, key = JSON.stringify(layers);
  if (!parses.has(file)) parses.set(file, new Map());
  const cache = parses.get(file);
  return cache.get(key) || remember(cache, key, parseVector(await file.text(), file.name.split('.').pop(), { layers }));
}

/** One field from one source or several. Each source keeps its own drawing coordinates. */
export async function sourceShader(sources, settings) {
  sources = [sources].flat();
  const many = sources.length > 1, drawings = [];
  for (const source of sources) {
    const name = source.file?.name || source.name;
    try {
      const parsed = await parsedSource(source);
      // One empty drawing among several is reported without hiding the others.
      const warnings = !many ? parsed.warnings
        : [...parsed.warnings, ...(parsed.groups.some(group => group.paths.length) ? [] : ['No supported visible vector geometry was found.'])]
          .map(warning => `${name}: ${warning}`);
      drawings.push({ ...parsed, warnings, mode: settings.mode === 'auto' ? source.mode || 'outline' : settings.mode });
    } catch (error) {
      throw many ? new Error(`${name}: ${error.message}`) : error;
    }
  }
  const options = { tolerance: settings.tolerance, strokeWidth: settings.strokeWidth };
  const key = JSON.stringify([options, sources.map((source, i) => [fileId(source.file), source.layers || null, drawings[i].mode])]);
  return conversions.get(key) || remember(conversions, key, convertParsed(drawings, options));
}

function base64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(text);
}

export function shaderBundle(sources, settings, conversion, stages, time) {
  const style = SHADER_STYLES.find(s => s.id === settings.style), data = conversion.data;
  return {
    format: 'vector2stl-shader', version: 2,
    sources: sources.map(source => ({ name: source.file.name, role: source.label, layers: source.layers || null })),
    style: { id: style.id, name: style.name }, settings,
    geometry: { bounds: conversion.geometry.bounds, scale: conversion.geometry.scale, ...conversion.stats },
    warnings: conversion.warnings,
    sdf: conversion.code, visualization: style.code, shaders: { ...stages },
    uniforms: { u_resolution: [settings.resolution, settings.resolution], u_time: time,
      u_duration: settings.duration, u_frame: Math.floor(time * 30), ...(data && { [data.uniform]: 0 }) },
    // Drawings too large for shader constants keep their edges here; the SDF source describes the layout.
    textures: data ? [{ uniform: data.uniform, unit: 0, width: data.width, height: data.height,
      internalFormat: 'RGBA32F', format: 'RGBA', type: 'FLOAT', filter: 'NEAREST',
      encoding: 'base64, little-endian float32', data: base64(new Uint8Array(data.values.buffer)) }] : [],
    passes: [
      { vertex: 'vertex', fragment: 'fragment', mode: 'TRIANGLES', count: 3 },
      ...(stages.particleVertex
        ? [{ vertex: 'particleVertex', fragment: 'particleFragment', mode: 'POINTS', count: 2304,
          blend: ['SRC_ALPHA', 'ONE_MINUS_SRC_ALPHA'] }] : []),
    ],
    coordinates: 'Centered sources, +Y up, longest side fitted to 1.5 shader units. Original bounds retained above.',
    engine: 'https://github.com/jonasfrey/shadertracev2/tree/01d6f1e02aee1913bfbd7ec3cb0ac23bf02a1069',
  };
}
