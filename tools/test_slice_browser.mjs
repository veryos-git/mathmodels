// Browser regression for the CNC slice list: open a gothic frame whose project
// saved one slice, add another, and see each slice's SVG outline and shader
// render. Then change a height, enlarge a thumbnail, save one SVG and download
// every slice with its render as one zip.
// PLAYWRIGHT_MODULE=/path/to/playwright-core APP_URL=http://localhost:8789 \
//   node tools/test_slice_browser.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = process.env.ARTIFACTS || '/tmp/mathmodels-slices';
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const rows = page.locator('.slice-row');
const ready = () => page.waitForFunction(() => {
  const previews = [...document.querySelectorAll('.slice-preview')];
  return previews.length && previews.every(preview => preview.dataset.state === 'ready');
}, null, { timeout: 120000 });
const saveDownload = async (button) => {
  const pending = page.waitForEvent('download');
  await button.click();
  const download = await pending, path = `${artifacts}/${download.suggestedFilename()}`;
  await download.saveAs(path);
  return path;
};
// How much of a render is the lit sheet, its shadowed table, and neither.
const renderStats = async row => row.locator('.slice-render img').evaluate(async (image, color) => {
  await image.decode();
  const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
  canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  const sheet = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) * .84), table = [22, 24, 29];
  const near = (i, rgb) => rgb.every((value, k) => Math.abs(data[i + k] - value) < 12);
  let onSheet = 0, onTable = 0;
  for (let i = 0; i < data.length; i += 4) { if (near(i, sheet)) onSheet++; else if (near(i, table)) onTable++; }
  const pixels = data.length / 4;
  return { size: [canvas.width, canvas.height], sheet: onSheet / pixels, table: onTable / pixels };
}, await row.evaluate(element => element.style.getPropertyValue('--slice-color')));

try {
  await page.goto(process.env.APP_URL || 'http://localhost:8788/');
  await page.waitForSelector('#shelfPlacementEditor canvas', { state: 'attached', timeout: 60000 });
  const embedded = async path => ({ name: path.split('/').pop(), data: (await readFile(root + path)).toString('base64') });
  const project = { format: 'vector2stl-project', version: 1, workflow: 'gothic',
    drawing: await embedded('library/Part Studio 1 - frame.dxf'),
    profile: await embedded('library/Part Studio 1 - profile.dxf'), settings: {},
    slices: [{ height: .1, color: '#e0a35c', visible: true }] };
  const built = page.waitForResponse(r => r.url().endsWith('/api/regions'), { timeout: 120000 });
  await page.locator('#startProjectFileInput').setInputFiles({
    name: 'slice-test.v2sproj', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)),
  });
  assert.equal((await built).status(), 200);
  await page.waitForFunction(() => !document.querySelector('#go').disabled);

  // Previews wait until the list is on screen: nothing is sliced on the other steps.
  let slices = 0;
  page.on('request', request => { if (request.url().endsWith('/api/slice')) slices++; });
  await page.waitForTimeout(1000);
  assert.equal(slices, 0);
  await page.locator('#modelSteps [data-step=export]').click();
  await page.locator('#addSlice').click();
  await ready();
  assert.equal(await rows.count(), 2);
  assert.equal(slices, 2);
  for (const row of await rows.all()) {
    const color = await row.evaluate(element => getComputedStyle(element).getPropertyValue('--slice-color'));
    const outline = row.locator('.slice-outline svg');
    assert.ok(await outline.locator('path').count() > 0);
    assert.equal(await outline.locator('g').getAttribute('stroke'), color);
    // The whole sheet is framed the same way at every height, so renders line up.
    const stats = await renderStats(row);
    assert.equal(Math.max(...stats.size), 1024);
    assert.ok(stats.sheet > .01 && stats.table > .2, JSON.stringify(stats));
  }
  const sizes = await rows.locator('.slice-render img').evaluateAll(images => images.map(i => `${i.naturalWidth}x${i.naturalHeight}`));
  assert.equal(sizes[0], sizes[1]);
  await page.locator('#modelPanel-export').screenshot({ path: `${artifacts}/slices.png` });

  // A new height replaces that slice's preview and leaves the other alone.
  const first = rows.first(), before = await first.locator('.slice-render img').getAttribute('src');
  const other = await rows.nth(1).locator('.slice-render img').getAttribute('src');
  await first.locator('.slice-height').fill('0.4');
  await page.waitForFunction(old => document.querySelector('.slice-render img').src !== old, before, { timeout: 120000 });
  await ready();
  assert.equal(slices, 3);
  assert.equal(await rows.nth(1).locator('.slice-render img').getAttribute('src'), other);
  assert.match(await first.locator('.slice-outline title').textContent(), /0\.4 mm above model base/);

  // A height above the model shows no preview and asks for nothing.
  await first.locator('.slice-height').fill('9999');
  await first.locator('.slice-preview').waitFor({ state: 'hidden' });
  await first.locator('.slice-height').fill('0.4');
  await ready();
  assert.equal(slices, 3, 'the preview for this height is still current');

  // Either thumbnail opens the zoomable inspector on the file itself.
  await first.locator('.slice-outline').click();
  const inspector = page.locator('.file-inspector[open]');
  assert.equal(await inspector.locator('#fileInspectorTitle').textContent(), 'slice-1-0.4mm.svg');
  await inspector.locator('asset-preview[data-state=ready]').waitFor();
  await page.screenshot({ path: `${artifacts}/outline.png` });
  await inspector.locator('[data-inspector=close]').click();
  await first.locator('.slice-render').click();
  assert.equal(await inspector.locator('#fileInspectorTitle').textContent(), 'slice-1-0.4mm.png');
  await inspector.locator('asset-preview[data-state=ready]').waitFor();
  await page.screenshot({ path: `${artifacts}/render.png` });
  await inspector.locator('[data-inspector=close]').click();

  // Downloads reuse the previews: one SVG, or everything in one zip, named after the project.
  await page.locator('#projectName').fill('slice-test');
  const svg = await readFile(await saveDownload(first.locator('.slice-download')), 'utf8');
  assert.match(svg, /^<svg[^>]* width="[\d.]+mm"[^>]*>\s*<title>Cross-section 0\.4 mm above model base<\/title>/);
  assert.match(svg, /stroke="#e0a35c"/);
  const zip = await saveDownload(page.locator('#exportSlices'));
  assert.match(zip, /slice-test-slices\.zip$/);
  assert.equal(slices, 3);
  const list = script => execFileSync(root + '.venv/bin/python', ['-c', script, zip], { encoding: 'utf8' });
  const names = JSON.parse(list('import json, sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps(z.namelist()))'));
  assert.equal(names.length, 4);
  assert.deepEqual(names.slice(0, 2), ['slice-test-slice-1-0.4mm.svg', 'slice-test-slice-1-0.4mm.png']);
  assert.match(names[2], /^slice-test-slice-2-[\d.]+mm\.svg$/);
  assert.equal(names[3], names[2].replace(/svg$/, 'png'));
  const sameFiles = list(`import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
assert z.read(z.namelist()[0]) == open(sys.argv[1].replace('slice-test-slices.zip', z.namelist()[0]), 'rb').read()
assert all(z.read(name)[:8] == b'\\x89PNG\\r\\n\\x1a\\n' for name in z.namelist() if name.endswith('.png'))
print('ok')`);
  assert.equal(sameFiles.trim(), 'ok');
  assert.match(await page.locator('#status').textContent(), /saved 2 slice SVGs and 2 renders in one zip/);
  assert.deepEqual(errors, []);
  console.log(`Slice browser checks passed: lazy previews, outlines, renders, heights, inspector, SVG and zip downloads. Artifacts: ${artifacts}`);
} finally {
  await browser.close();
}
