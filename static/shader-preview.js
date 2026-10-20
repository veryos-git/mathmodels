import { builtins } from './vendor/shadertrace/templates.js';
import { convertVector } from './vendor/shadertrace/vector-import/index.js';
import { LIMITS } from './vendor/shadertrace/vector-import/geometry.js';

export const SHADER_STYLES = builtins.filter(item => item.kind === 'visualization');
export const SHADER_DEFAULTS = Object.freeze({
  source: '', style: 'contours', mode: 'auto', tolerance: .002,
  strokeWidth: .012, resolution: 512, duration: 8, playing: true,
});
const allowed = (value, values, fallback) => values.includes(value) ? value : fallback;

export function shaderSettings(value = {}) {
  value = value && typeof value === 'object' ? value : {};
  return {
    source: typeof value.source === 'string' ? value.source : '',
    style: allowed(value.style, SHADER_STYLES.map(s => s.id), SHADER_DEFAULTS.style),
    mode: allowed(value.mode, ['auto', 'filled', 'outline'], 'auto'),
    tolerance: allowed(Number(value.tolerance), [.008, .002, .0005], .002),
    strokeWidth: Number.isFinite(Number(value.strokeWidth))
      ? Math.max(.001, Math.min(.2, Number(value.strokeWidth))) : .012,
    resolution: allowed(Number(value.resolution), [256, 512, 1024], 512),
    duration: Number.isFinite(Number(value.duration))
      ? Math.max(1, Math.min(60, Number(value.duration))) : 8,
    playing: typeof value.playing === 'boolean' ? value.playing : true,
  };
}

const conversions = new WeakMap();
export async function sourceShader(source, settings) {
  const file = source.file;
  if (!file || !/\.(dxf|svg)$/i.test(file.name)) throw new Error('Choose an SVG or ASCII DXF drawing or profile.');
  if (file.size > LIMITS.bytes) throw new Error('Shader previews support files up to 2 MB. Simplify this drawing to preview it.');
  const options = {
    mode: settings.mode === 'auto' ? source.mode || 'outline' : settings.mode,
    tolerance: settings.tolerance, strokeWidth: settings.strokeWidth,
    layers: source.layers || null,
  };
  const key = JSON.stringify(options);
  const cache = conversions.get(file) || new Map();
  if (cache.has(key)) return cache.get(key);
  const result = convertVector(await file.text(), file.name.split('.').pop(), options);
  // Bound memory when someone repeatedly adjusts the line width.
  if (cache.size >= 8) cache.delete(cache.keys().next().value);
  cache.set(key, result);
  conversions.set(file, cache);
  return result;
}

export function shaderBundle(source, settings, conversion, stages, time) {
  const style = SHADER_STYLES.find(s => s.id === settings.style);
  return {
    format: 'vector2stl-shader', version: 1,
    source: { name: source.file.name, role: source.label, layers: source.layers || null },
    style: { id: style.id, name: style.name }, settings,
    geometry: { bounds: conversion.geometry.bounds, scale: conversion.geometry.scale, ...conversion.stats },
    warnings: conversion.warnings,
    sdf: conversion.code, visualization: style.code, shaders: { ...stages },
    uniforms: { u_resolution: [settings.resolution, settings.resolution], u_time: time,
      u_duration: settings.duration, u_frame: Math.floor(time * 30) },
    passes: [
      { vertex: 'vertex', fragment: 'fragment', mode: 'TRIANGLES', count: 3 },
      ...(stages.particleVertex
        ? [{ vertex: 'particleVertex', fragment: 'particleFragment', mode: 'POINTS', count: 2304,
          blend: ['SRC_ALPHA', 'ONE_MINUS_SRC_ALPHA'] }] : []),
    ],
    coordinates: 'Centered source, +Y up, longest side fitted to 1.5 shader units. Original bounds retained above.',
    engine: 'https://github.com/jonasfrey/shadertracev2/tree/01d6f1e02aee1913bfbd7ec3cb0ac23bf02a1069',
  };
}
