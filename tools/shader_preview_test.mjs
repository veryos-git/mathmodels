import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SHADER_STYLES, SHADER_DEFAULTS, shaderSettings, sourceShader, shaderBundle } from '../static/shader-preview.js';
import { evaluateGeometry, LIMITS } from '../static/vendor/shadertrace/vector-import/geometry.js';

const dxf = (...entities) => ['0', 'SECTION', '2', 'ENTITIES', ...entities.flat(), '0', 'ENDSEC', '0', 'EOF'].join('\n');
const circle = (layer, x, r) => [0, 'CIRCLE', 8, layer, 10, x, 20, 0, 40, r];
const file = new File([dxf(circle('frame', 0, 10), circle('ornament', 100, 5))], 'drawing.dxf');

test('Settings from older or malformed projects have safe defaults', () => {
  assert.deepEqual(shaderSettings(), SHADER_DEFAULTS);
  assert.deepEqual(shaderSettings(null), SHADER_DEFAULTS);
  const s = shaderSettings({ source: 42, style: '<script>', mode: 'other', resolution: 50000,
    tolerance: -1, strokeWidth: Infinity, duration: -1, playing: false });
  assert.deepEqual(s.sources, []);
  assert.deepEqual(shaderSettings({ source: 'profile' }).sources, ['profile'], 'projects saved with one source keep it');
  assert.deepEqual(shaderSettings({ sources: ['drawing', 7, 'cusps', 'drawing'] }).sources, ['drawing', 'cusps']);
  assert.equal(s.style, SHADER_DEFAULTS.style);
  assert.equal(s.resolution, 512);
  assert.equal(s.duration, 1);
  assert.equal(s.playing, false);
  assert.equal(new Set(SHADER_STYLES.map(s => s.id)).size, 61);
  assert(SHADER_STYLES.every(s => s.code.includes('vec3 shade(')));
});

test('Export size and GIF frame rate accept only supported values', () => {
  assert.deepEqual([shaderSettings().exportSize, shaderSettings().gifFps], [512, 20]);
  const s = shaderSettings({ exportSize: '4096', gifFps: '25' });
  assert.deepEqual([s.exportSize, s.gifFps], [4096, 25]);
  const bad = shaderSettings({ exportSize: 8192, gifFps: 30 });
  assert.deepEqual([bad.exportSize, bad.gifFps], [512, 20], 'GIF delays must be whole hundredths');
});

test('Input roles, selected DXF layers and mode changes generate different fields', async () => {
  const source = { file, id: 'profile', mode: 'filled', layers: ['frame'] };
  const filled = await sourceShader(source, shaderSettings());
  assert.deepEqual(filled.geometry.bounds, [-10, -10, 10, 10]);
  assert(evaluateGeometry(filled.geometry.groups, [0, 0]) < 0);
  const outlined = await sourceShader(source, shaderSettings({ mode: 'outline' }));
  assert(evaluateGeometry(outlined.geometry.groups, [0, 0]) > 0);
  const other = await sourceShader({ ...source, layers: ['ornament'] }, shaderSettings());
  assert.deepEqual(other.geometry.bounds, [95, -5, 105, 5]);
  assert.equal(await sourceShader(source, shaderSettings()), filled, 'unchanged inputs reuse conversion');
  const replaced = await sourceShader({ ...source, file: new File([dxf(circle('frame', 0, 2))], file.name) }, shaderSettings());
  assert.deepEqual(replaced.geometry.bounds, [-2, -2, 2, 2], 'same filename never reuses old geometry');
});

test('Selecting a DXF INSERT includes its block geometry', async () => {
  const block = [0, 'SECTION', 2, 'BLOCKS', 0, 'BLOCK', 2, 'part', 10, 0, 20, 0,
    ...circle('0', 0, 10), 0, 'ENDBLK', 0, 'ENDSEC'].join('\n');
  const drawing = new File([block + '\n' + dxf([0, 'INSERT', 8, 'frame', 2, 'part', 10, 0, 20, 0])], 'block.dxf');
  const result = await sourceShader({ file: drawing, layers: ['frame'] }, shaderSettings());
  assert(result.stats.segments > 8);
  assert.deepEqual(result.geometry.bounds, [-10, -10, 10, 10]);
});

test('Invalid and oversized files fail before producing a shader', async () => {
  for (const bad of [new File(['oops'], 'bad.dxf'), new File(['anything'], 'photo.png'),
    new File(['x'], 'photo.dxf.png')]) {
    await assert.rejects(() => sourceShader({ file: bad }, shaderSettings()));
  }
  await assert.rejects(() => sourceShader({ file: new File(['x'.repeat(LIMITS.bytes + 1)], 'large.dxf') }, shaderSettings()), /16 MB/);
  await assert.rejects(() => sourceShader({ file, layers: ['missing'] }, shaderSettings()));
});

test('Several sources share one field in their own coordinates and modes', async () => {
  const frame = new File([dxf(circle('0', 0, 10))], 'frame.dxf'), dot = new File([dxf(circle('0', 100, 5))], 'dot.dxf');
  const sources = [{ file: frame, mode: 'outline' }, { file: dot, mode: 'filled' }];
  const both = await sourceShader(sources, shaderSettings());
  assert.deepEqual(both.geometry.bounds, [-10, -10, 105, 10]);
  const at = x => [(x - 47.5) * both.geometry.scale, 0];
  assert(evaluateGeometry(both.geometry.groups, at(0)) > 0, 'the frame is an outline');
  assert(evaluateGeometry(both.geometry.groups, at(100)) < 0, 'the dot is filled');
  assert(evaluateGeometry((await sourceShader(sources, shaderSettings({ mode: 'filled' }))).geometry.groups, at(0)) < 0);
  assert.equal(await sourceShader(sources, shaderSettings()), both, 'unchanged selections reuse conversion');
  assert.notEqual(await sourceShader(sources.slice(0, 1), shaderSettings()), both);

  const label = new File([dxf([0, 'TEXT', 8, '0', 1, 'hello'])], 'label.dxf');
  const warned = await sourceShader([...sources, { file: label }], shaderSettings());
  assert.deepEqual(warned.geometry.bounds, both.geometry.bounds);
  assert(warned.warnings.includes('label.dxf: No supported visible vector geometry was found.'));
  assert(warned.warnings.some(warning => /^label\.dxf: Skipped DXF TEXT/.test(warning)));
  await assert.rejects(() => sourceShader([...sources, { file: new File(['oops'], 'bad.dxf') }], shaderSettings()), /bad\.dxf: /);
  await assert.rejects(() => sourceShader([], shaderSettings()), /No supported/);
});

test('Shader bundles preserve geometry, uniforms and the additional particle draw pass', async () => {
  const source = { file, label: 'Main drawing' }, settings = shaderSettings();
  const conversion = await sourceShader(source, settings);
  const stages = { vertex: 'vertex source', fragment: 'fragment source', particleVertex: 'particles', particleFragment: 'points' };
  const bundle = shaderBundle([source, { ...source, label: 'Cusp paths' }], settings, conversion, stages, 2.5);
  assert.deepEqual(bundle.sources.map(item => [item.name, item.role]), [['drawing.dxf', 'Main drawing'], ['drawing.dxf', 'Cusp paths']]);
  assert.deepEqual(bundle.textures, []);
  assert.equal(bundle.uniforms.u_time, 2.5);
  assert.equal(bundle.uniforms.u_frame, 75);
  assert.equal(bundle.passes[1].count, 2304);
  assert.equal(bundle.shaders.particleVertex, 'particles');
  assert.match(bundle.sdf, /float sdf/);
  assert.equal(JSON.parse(JSON.stringify(bundle)).geometry.segments, conversion.stats.segments);
});

test('Bundles of drawings beyond the inline limit carry their edge texture', async () => {
  const rings = new File([dxf(...Array.from({ length: 200 }, (_, i) => circle('0', 0, 10 + i * .01)))], 'rings.dxf');
  const source = { file: rings, label: 'Main drawing', mode: 'outline' }, settings = shaderSettings();
  const conversion = await sourceShader(source, settings);
  assert(conversion.stats.segments > LIMITS.inlineSegments);
  const bundle = JSON.parse(JSON.stringify(shaderBundle([source], settings, conversion, { vertex: 'v', fragment: 'f' }, 0)));
  const [texture] = bundle.textures;
  assert.equal(bundle.uniforms[texture.uniform], texture.unit);
  assert.match(bundle.sdf, new RegExp(`uniform highp sampler2D ${texture.uniform};`));
  const bytes = Uint8Array.from(atob(texture.data), c => c.charCodeAt(0));
  assert.deepEqual(new Float32Array(bytes.buffer), conversion.data.values);
  assert.equal(texture.width * texture.height * 4, conversion.data.values.length);
});

test('Reference DXF cross-section and frame generate usable GLSL', async () => {
  for (const [path, mode] of [['library/Part Studio 1 - frame.dxf', 'outline'], ['library/Part Studio 1 - profile.dxf', 'filled']]) {
    const text = await Deno.readTextFile(path);
    const result = await sourceShader({ file: new File([text], path.split('/').pop()), mode }, shaderSettings());
    assert(result.stats.segments > 4);
    assert(result.stats.segments <= 1024);
    assert.match(result.code, /float sdf\(vec2 p\)/);
  }
});
