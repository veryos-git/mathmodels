// Run against a local server. Set PLAYWRIGHT_MODULE to an installed Playwright
// module and optionally SHADER_PROJECT, APP_URL, CHROME_PATH, SHADER_ARTIFACTS.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = process.env.SHADER_ARTIFACTS || '/tmp/mathmodels-shaders';
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const dialog = page.locator('.shader-inspector[open]');
const field = name => dialog.locator(`[data-field="${name}"]`);
const action = name => dialog.locator(`[data-action="${name}"]`);
const ready = async () => {
  await page.waitForFunction(() =>
    ['ready', 'error'].includes(document.querySelector('.shader-inspector[open]')?.dataset.state), null, { timeout: 60000 });
  assert.equal(await dialog.getAttribute('data-state'), 'ready', await dialog.locator('.shader-message').textContent());
};
const download = async (name, filename) => {
  const pending = page.waitForEvent('download');
  await action(name).click();
  const result = await pending;
  const path = `${artifacts}/${filename}`;
  await result.saveAs(path);
  return readFile(path);
};
try {
  await page.goto(process.env.APP_URL || 'http://localhost:8788/');
  await page.waitForSelector('#shelfPlacementEditor canvas', { state: 'attached', timeout: 60000 });
  await page.locator('#startGothic').click();
  await page.locator('#shaderPreview').click();
  assert.equal(await dialog.getAttribute('data-state'), 'empty');
  await action('close').click();
  const embedded = async path => ({ name: path.split('/').pop(), data: (await readFile(root + path)).toString('base64') });
  const project = process.env.SHADER_PROJECT
    ? JSON.parse(await readFile(process.env.SHADER_PROJECT, 'utf8'))
    : { format: 'vector2stl-project', version: 1, workflow: 'gothic',
      drawing: await embedded('library/Part Studio 1 - frame.dxf'),
      profile: await embedded('library/Part Studio 1 - profile.dxf'), settings: {},
      additions: { enabled: false, outline: { name: 'shelf.svg',
        data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0H40L30 20H10Z"/></svg>').toString('base64') } } };
  project.shaderPreview = { playing: false, resolution: 256 };
  const built = page.waitForResponse(r => r.url().endsWith('/api/regions'), { timeout: 120000 });
  await page.locator('#startProjectFileInput').setInputFiles({
    name: 'shader-test.v2sproj', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)),
  });
  assert.equal((await built).status(), 200);
  await page.waitForFunction(() => !document.querySelector('#go').disabled);
  let rebuilds = 0;
  page.on('request', request => { if (request.url().endsWith('/api/regions')) rebuilds++; });
  await page.locator('#shaderPreview').click();
  await ready();
  assert.equal(await field('style').locator('option').count(), 60);
  const options = await field('source').locator('option').evaluateAll(nodes => nodes.map(n => n.value));
  assert(options.includes('drawing') && options.includes('profile') && options.includes('additionOutline'));
  for (const id of options) {
    await field('source').selectOption(id); await ready();
    assert.match(await dialog.locator('.shader-stats').textContent(), /\d+ segments/);
  }
  await field('source').selectOption('drawing'); await ready();
  await field('style').selectOption('neon'); await ready();
  await page.screenshot({ path: `${artifacts}/project-shader.png` });
  const png = await download('png', 'frame.png');
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const bundle = JSON.parse(await download('shader', 'frame.shader.json'));
  assert.match(bundle.shaders.fragment, /#version 300 es/);
  assert.equal(bundle.source.name, project.drawing.name);
  assert.match(bundle.sdf, /float sdf/);
  await action('play').click();
  await page.waitForFunction(() => Number(document.querySelector('.shader-inspector [data-time]').value) > .15);
  await action('play').click();
  const paused = await dialog.locator('[data-time]').inputValue();
  await page.waitForTimeout(150);
  assert.equal(await dialog.locator('[data-time]').inputValue(), paused);
  await action('close').click();
  assert.equal(rebuilds, 0, 'shader inspection never rebuilds the model');

  // Project save/open preserves shader preferences.
  const saved = page.waitForEvent('download');
  await page.locator('[data-step="export"]').click();
  await page.locator('#saveProject').click();
  await (await saved).saveAs(`${artifacts}/shader.v2sproj`);
  const roundtrip = JSON.parse(await readFile(`${artifacts}/shader.v2sproj`, 'utf8'));
  assert.equal(roundtrip.shaderPreview.style, 'neon');
  assert.equal(roundtrip.shaderPreview.resolution, 256);
  assert.equal(roundtrip.shaderPreview.playing, false);
  const reopened = page.waitForResponse(r => r.url().endsWith('/api/regions'), { timeout: 120000 });
  await page.locator('#startProjectFileInput').setInputFiles(`${artifacts}/shader.v2sproj`);
  assert.equal((await reopened).status(), 200);
  await page.waitForFunction(() => !document.querySelector('#go').disabled);
  await page.locator('[data-step="inputs"]').click();
  await page.locator('#subjectPreview [data-action="shader"]').click();
  await ready();
  assert.equal(await field('source').inputValue(), 'drawing');
  assert.equal(await field('style').inputValue(), 'neon');
  await action('close').click();
  console.log('PASS project sources, live rendering, playback, PNG/GLSL exports, persistence, preview entry point');

  // Compile/render the complete style catalog with an SVG that has a hole.
  const catalog = await page.evaluate(async () => {
    const { ShaderRenderer } = await import('/vendor/shadertrace/renderer.js');
    const { SHADER_STYLES } = await import('/shader-preview.js');
    const { convertVector } = await import('/vendor/shadertrace/vector-import/index.js');
    const { evaluateGeometry } = await import('/vendor/shadertrace/vector-import/geometry.js');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" d="M0 0H10V10H0Z M3 3H7V7H3Z"/></svg>';
    const converted = convertVector(svg, 'svg');
    if (!(evaluateGeometry(converted.geometry.groups, [0, 0]) > 0)) throw new Error('SVG hole was filled');
    const renderer = new ShaderRenderer(document.createElement('canvas'));
    renderer.resize(32, 32);
    const pixels = new Uint8Array(32 * 32 * 4);
    const verified = [];
    for (const style of SHADER_STYLES) {
      const result = renderer.compile(converted.code, style.code);
      if (!result.ok) throw new Error(`${style.name}: ${JSON.stringify(result.errors)}`);
      renderer.render(.7, 8, 21);
      renderer.readPixels(pixels);
      if (!pixels.some((value, i) => i % 4 !== 3 && value > 0)) throw new Error(`${style.name}: empty canvas`);
      if (style.catalogNumber === 60 && !renderer.sources.particleVertex) throw new Error('Missing particle stage');
      verified.push(style.id);
    }
    const distance = renderer.compile(converted.code, 'vec3 shade(vec2 p,float d){return vec3(clamp((d+1.0)*0.5,0.0,1.0));}');
    if (!distance.ok) throw new Error('Distance diagnostic failed');
    renderer.render(0, 8);
    renderer.readPixels(pixels);
    for (const [x, y] of [[16, 16], [25, 16], [1, 1]]) {
      const expected = Math.max(0, Math.min(1, (evaluateGeometry(converted.geometry.groups,
        [(2 * x + 1) / 32 - 1, (2 * y + 1) / 32 - 1]) + 1) / 2));
      if (Math.abs(pixels[4 * (y * 32 + x)] / 255 - expected) > .012) throw new Error('CPU/GPU distance mismatch');
    }
    renderer.dispose();
    if (renderer.program) throw new Error('GPU program was not released');
    renderer.gl.getExtension('WEBGL_lose_context')?.loseContext();
    return verified;
  });
  assert.equal(catalog.length, 60);
  console.log('PASS all 60 styles rendered, SVG holes, CPU/GPU distances, particle export and disposal');

  // Recover from bad input; race changing sources; use library-style lazy files.
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('shader-preview', { detail: {
    source: { name: 'broken.dxf', file: new File(['broken'], 'broken.dxf') },
  } })));
  await page.waitForFunction(() => document.querySelector('.shader-inspector').dataset.state === 'error');
  assert(await action('shader').isDisabled());
  await field('source').selectOption('profile'); await ready();
  await action('close').click();
  await page.evaluate(() => {
    const original = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>';
    const preview = document.createElement('asset-preview');
    preview.id = 'shader-test-lazy';
    document.body.append(preview);
    preview.source = { name: 'library-shape.svg', detail: async () => new File([original], 'library-shape.svg') };
    preview.querySelector('[data-action="shader"]').click();
  });
  await ready();
  assert.match(await field('source').locator('option:checked').textContent(), /library-shape/);
  const particleStyle = 'style-60';
  await field('style').selectOption(particleStyle); await ready();
  const particle = JSON.parse(await download('shader', 'particles.shader.json'));
  assert.equal(particle.passes.length, 2);
  assert.match(particle.shaders.particleVertex, /stParticle/);
  await action('close').click();
  await page.evaluate(() => document.querySelector('#shader-test-lazy').remove());

  // A late library fetch cannot replace a newer selected source.
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('shader-preview', { detail: { source: {
      name: 'slow.svg', detail: () => new Promise(resolve => { window.finishShaderFile = resolve; }),
    } } }));
  });
  await page.waitForFunction(() => !!window.finishShaderFile);
  await field('source').selectOption('profile'); await ready();
  await page.evaluate(() => window.finishShaderFile(new File(['bad'], 'slow.svg')));
  await page.waitForTimeout(100);
  assert.equal(await dialog.getAttribute('data-state'), 'ready');
  assert.equal(await field('source').inputValue(), 'profile');
  // Native close is queued: reopening in the same task must preserve the new render.
  await page.evaluate(() => {
    document.querySelector('.shader-inspector').close();
    document.querySelector('#shaderPreview').click();
  });
  await ready();
  const canLoseContext = await page.evaluate(() => {
    const gl = document.querySelector('.shader-inspector canvas').getContext('webgl2');
    const extension = gl.getExtension('WEBGL_lose_context');
    window.restoreShaderContext = () => extension.restoreContext();
    if (extension) extension.loseContext();
    return !!extension;
  });
  if (canLoseContext) {
    await page.waitForFunction(() => document.querySelector('.shader-inspector').dataset.state === 'error');
    assert(await action('png').isDisabled());
    await page.evaluate(() => new Promise(resolve => {
      document.querySelector('.shader-inspector canvas').addEventListener('webglcontextrestored', () => resolve(), { once: true });
      window.restoreShaderContext();
    }));
    await ready();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${artifacts}/mobile-shader.png` });
  assert(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'mobile layout fits dialog');
  await action('close').click();
  // The inspector reports unavailable WebGL without throwing into the host app.
  const unsupported = await page.evaluate(async () => {
    const { ShaderInspector } = await import('/shader-inspector.js');
    const inspector = new ShaderInspector(() => [{
      id: 'test', label: 'Test', file: new File([
        '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>',
      ], 'test.svg'),
    }]);
    inspector.build();
    inspector.canvas.getContext = () => null;
    inspector.open();
    await new Promise(resolve => {
      const observer = new MutationObserver(() => {
        if (inspector.dialog.dataset.state === 'error') { observer.disconnect(); resolve(); }
      });
      observer.observe(inspector.dialog, { attributes: true, attributeFilter: ['data-state'] });
    });
    const message = inspector.message.textContent;
    inspector.dialog.close();
    inspector.dialog.remove();
    return message;
  });
  assert.match(unsupported, /WebGL 2 is unavailable/);
  assert.deepEqual(errors, []);
  console.log('PASS malformed input recovery, lazy library source, stale request guard, particle bundle, context recovery/unavailability, mobile layout');
} finally {
  await browser.close();
}
