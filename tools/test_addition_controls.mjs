// Browser regression for a project with an enabled shelf.
// PLAYWRIGHT_MODULE=/path/to/playwright-core APP_URL=http://localhost:8789 \
//   node tools/test_addition_controls.mjs path/to/shelf.v2sproj
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const projectPath = process.argv[2];
if (!projectPath) throw new Error('Pass an existing project with an enabled shelf.');
const project = JSON.parse(await readFile(projectPath, 'utf8'));
const artifacts = '/tmp/mathmodels-additions';
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const generate = async action => {
  const pending = page.waitForResponse(r => r.url().endsWith('/api/regions'), { timeout: 120000 });
  await action();
  const response = await pending, data = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(data));
  await page.waitForFunction(() => !document.querySelector('#go').disabled);
  return data;
};
const number = id => page.locator('#' + id).inputValue().then(Number);
const edit = (id, value) => generate(async () => {
  await page.locator('#' + id).fill(String(value));
  await page.locator('#' + id).press('Tab');
});
function stlBounds(encoded) {
  const bytes = Buffer.from(encoded, 'base64'), result = [[Infinity, Infinity, Infinity], [-Infinity, -Infinity, -Infinity]];
  const count = bytes.readUInt32LE(80);
  assert.equal(bytes.length, 84 + count * 50);
  for (let i = 0; i < count; i++) for (let v = 0; v < 3; v++) for (let axis = 0; axis < 3; axis++) {
    const value = bytes.readFloatLE(84 + i * 50 + 12 + v * 12 + axis * 4);
    result[0][axis] = Math.min(result[0][axis], value);
    result[1][axis] = Math.max(result[1][axis], value);
  }
  return result;
}
function stlVolume(encoded) {
  const bytes = Buffer.from(encoded, 'base64');
  let volume = 0;
  for (let i = 0; i < bytes.readUInt32LE(80); i++) {
    const vertex = n => Array.from({ length: 3 }, (_, axis) => bytes.readFloatLE(84 + i * 50 + 12 + n * 12 + axis * 4));
    const [a, b, c] = [vertex(0), vertex(1), vertex(2)];
    volume += (a[0] * (b[1]*c[2] - b[2]*c[1]) + a[1] * (b[2]*c[0] - b[0]*c[2]) + a[2] * (b[0]*c[1] - b[1]*c[0])) / 6;
  }
  return volume;
}
try {
  await page.goto(process.env.APP_URL || 'http://localhost:8789/');
  await page.waitForSelector('#additionProfileScale', { state: 'attached', timeout: 60000 });
  const original = await generate(() => page.locator('#startProjectFileInput').setInputFiles(projectPath));
  await page.locator('[data-step="additions"]').click();
  assert(await page.locator('#additionTrimBack').isChecked());
  assert.equal(await page.locator('#additionKeepOriginalProfile').isChecked(), !!project.additions.keepOriginalProfile);
  const mainWidth = await number('profileScale'), mainHeight = await number('profileHeightScale');
  if (!project.additions.settings.additionProfileScale && !project.additions.profile) {
    assert.equal(await number('additionProfileScale'), mainWidth, 'migrate shared width once');
    assert.equal(await number('additionProfileHeightScale'), mainHeight, 'migrate shared height once');
  }
  const bed = stlBounds(original.wallMesh)[0][2];
  const uncut = await generate(() => page.locator('#additionTrimBack').uncheck());
  assert(stlBounds(uncut.wallMesh)[0][2] < bed - .01, 'fixture reproduces a rim extending behind the bed plane');
  const cut = await generate(() => page.locator('#additionTrimBack').check());
  assert(Math.abs(stlBounds(cut.wallMesh)[0][2] - bed) < 1e-5);
  console.log('PASS the real shelf project loses rear protrusions and keeps its frame bed plane');
  const scaledWidth = Number((mainWidth * .8).toFixed(5));
  const scaledHeight = Number((mainHeight * .75).toFixed(5));
  await edit('additionProfileScale', scaledWidth);
  await edit('additionProfileHeightScale', scaledHeight);
  assert.equal(await number('profileScale'), mainWidth);
  assert.equal(await number('profileHeightScale'), mainHeight);
  assert(Math.abs(await number('additionProfileScaleSlider') - scaledWidth) <= .0051);
  await generate(() => page.locator('#additionMirrorProfile').check());
  const mirrored = await generate(() => page.locator('#additionFlipProfile').check());
  const both = await generate(() => page.locator('#additionKeepOriginalProfile').check());
  assert(stlVolume(both.wallMesh) > stlVolume(mirrored.wallMesh) + .01,
    'both mode retains original material in addition to the mirrored sweep');
  assert(Math.abs(stlBounds(both.wallMesh)[0][2] - bed) < 1e-5);
  await writeFile(`${artifacts}/shelf-print-preview.stl`, Buffer.from(both.wallMesh, 'base64'));
  console.log('PASS both sweeps add material together and retain the flat bed plane');
  await page.screenshot({ path: `${artifacts}/shelf-print-controls.png` });
  await page.locator('[data-step="inputs"]').click();
  await generate(() => page.evaluate(value => {
    const input = document.getElementById('profileScale');
    input.value = value; input.dispatchEvent(new Event('change', { bubbles: true }));
  }, mainWidth * 1.02));
  await page.locator('[data-step="additions"]').click();
  assert.equal(await number('additionProfileScale'), scaledWidth);
  assert.equal(await number('additionProfileHeightScale'), scaledHeight);
  console.log('PASS independent sizing in both directions, numeric/slider sync, both mirror controls');
  await page.locator('[data-step="export"]').click();
  let pending = page.waitForEvent('download');
  await page.locator('#saveProject').click();
  const savedPath = `${artifacts}/shelf-print-settings.v2sproj`;
  await (await pending).saveAs(savedPath);
  const saved = JSON.parse(await readFile(savedPath, 'utf8'));
  assert.equal(saved.additions.trimBack, true);
  assert.equal(saved.additions.mirrorProfile, true);
  assert.equal(saved.additions.flipProfile, true);
  assert.equal(saved.additions.keepOriginalProfile, true);
  assert.equal(Number(saved.additions.settings.additionProfileScale), scaledWidth);
  await generate(() => page.locator('#startProjectFileInput').setInputFiles(savedPath));
  await page.locator('[data-step="additions"]').click();
  for (const id of ['additionMirrorProfile', 'additionFlipProfile', 'additionKeepOriginalProfile', 'additionTrimBack']) assert(await page.locator('#' + id).isChecked());
  assert.equal(await number('additionProfileScale'), scaledWidth);
  assert.equal(await number('additionProfileHeightScale'), scaledHeight);
  await page.locator('[data-step="export"]').click();
  pending = page.waitForEvent('download', { timeout: 120000 });
  await page.locator('#download').click();
  await (await pending).saveAs(`${artifacts}/shelf-print-export.stl`);
  const exported = await readFile(`${artifacts}/shelf-print-export.stl`);
  assert(Math.abs(stlBounds(exported.toString('base64'))[0][2] - bed) < 1e-5);
  await page.locator('[data-step="additions"]').click();
  await generate(() => page.locator('#additionMatchProfile').click());
  assert.equal(await number('additionProfileScale'), await number('profileScale'));
  assert.equal(await number('additionProfileHeightScale'), await number('profileHeightScale'));
  assert.deepEqual(errors, []);
  console.log('PASS settings survive save/reopen, flat STL export and one-time copy of main size');
} catch (error) {
  console.error('App status:', await page.locator('#status').textContent().catch(() => ''));
  await page.screenshot({ path: `${artifacts}/shelf-print-failure.png` });
  throw error;
} finally {
  await browser.close();
}
