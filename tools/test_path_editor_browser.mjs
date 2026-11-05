// Browser regression for the path editor in the subject's Expand inspector:
// extend the hanger arc of the gothic cloth hook (its duplicate tip arc
// follows), undo, apply, and reopen the edited DXF; then drag a point of an
// SVG path under a transform and check the written file. Uploads land in the
// library, so point the server at a scratch one:
// LIBRARY_DIR=.tmp/test-library PROJECT_DIR=.tmp/test-projects deno task start
// PLAYWRIGHT_MODULE=/path/to/playwright-core APP_URL=http://localhost:8788 \
//   node tools/test_path_editor_browser.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const app = process.env.APP_URL || 'http://localhost:8788';
const artifacts = '/tmp/mathmodels-path-editor';
await mkdir(artifacts, { recursive: true });
const project = JSON.parse(await readFile(new URL('../projects/gothic_cloth_hook_nunshead2_multicolor.v2sproj', import.meta.url)));
const hookPath = `${artifacts}/${project.drawing.name}`;
await writeFile(hookPath, Buffer.from(project.drawing.data, 'base64'));

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('dialog', dialog => dialog.accept());
const near = (a, b, tol, message) => assert(Math.abs(a - b) <= tol, `${message}: ${a} vs ${b}`);
const editor = () => page.locator('dialog.file-inspector .path-editor');
const loaded = () => page.waitForFunction(() => document.querySelector('dialog.file-inspector')?.editor?.original);
/** Sweeps in degrees of the hook arc and its duplicate tip piece, as the editor holds them. */
const sweeps = () => page.evaluate(() => {
  const { entities } = document.querySelector('dialog.file-inspector').editor;
  return ['100000C6', '1000005A'].map(h => entities.find(e => e.handle === h).sweep * 180 / Math.PI);
});
/** Page pixels of drawing points, through the editor's own view. */
const pixels = points => page.evaluate(points => {
  const ed = document.querySelector('dialog.file-inspector').editor, box = ed.canvas.getBoundingClientRect();
  return points.map(p => { const s = ed.screen(p); return [box.left + s.x, box.top + s.y]; });
}, points);
const drag = async (from, to) => {
  await page.mouse.move(...from); await page.mouse.down();
  await page.mouse.move(...to, { steps: 10 }); await page.mouse.up();
};

try {
  await page.goto(app);
  await page.locator('#startGothic').click();
  await page.locator('#file').setInputFiles(hookPath);
  await page.waitForFunction(() => document.querySelector('#subjectPreview')?.dataset.state === 'ready');
  await page.locator('#subjectPreview [data-action="expand"]').click();
  const inspector = page.locator('dialog.file-inspector');
  await inspector.locator('[data-inspector="edit"]').click();
  await loaded();
  assert(await editor().isVisible(), 'the editor replaces the preview');
  assert(!await inspector.locator('asset-preview').isVisible());
  const [hook, dup] = await sweeps();
  near(hook, 241.94, .01, 'hook arc as drawn');

  // Drag the hook's tip 30° further round its circle.
  const C = [0, 55.55986841082963], r = 40, tip = a => [C[0] + r * Math.cos(a), C[1] + r * Math.sin(a)];
  const end = (-90 + hook) * Math.PI / 180;
  const [from, to] = await pixels([tip(end), tip(end + Math.PI / 6)]);
  await drag(from, to);
  let [hookNow, dupNow] = await sweeps();
  near(hookNow, hook + 30, .5, 'hook arc extended along its circle');
  near(dupNow, dup + 30, .5, 'the duplicate tip arc follows');
  assert.match(await editor().locator('.profile-editor-status').textContent(), /2 edited, not applied/);
  await page.screenshot({ path: `${artifacts}/hook-extended.png` });

  // Undo, then type the end angle instead.
  await editor().locator('[data-action="undo"]').click();
  assert.deepEqual(await sweeps(), [hook, dup], 'undo restores the drawing');
  await page.mouse.click(...(await pixels([tip(end - .3)]))[0]);
  assert.match(await editor().locator('.profile-editor-status').textContent(), /Arc · radius 40/);
  await editor().locator('input[data-field="end"]').fill('182');
  await editor().locator('input[data-field="end"]').press('Enter');
  [hookNow, dupNow] = await sweeps();
  near(hookNow, 272, 1e-6, 'typed end angle');
  near(dupNow, dup + 272 - hook, 1e-6, 'duplicate follows the typed end');

  const applied = page.waitForResponse(r => r.url().endsWith('/api/sketch/apply'));
  await editor().locator('[data-action="apply"]').click();
  assert.equal((await applied).status(), 200);
  await page.waitForFunction(() => !document.querySelector('dialog.file-inspector').editing);
  assert(await inspector.locator('asset-preview').isVisible(), 'back to the preview');
  assert.match(await page.locator('#dropHint').textContent(), /paths edited/);
  await page.waitForFunction(() => document.querySelector('dialog.file-inspector asset-preview').dataset.state === 'ready');
  await page.screenshot({ path: `${artifacts}/hook-applied.png` });

  // The written DXF reads back with the longer hook.
  await inspector.locator('[data-inspector="edit"]').click();
  await loaded();
  [hookNow, dupNow] = await sweeps();
  near(hookNow, 272, 1e-6, 'edited DXF keeps the longer hook');
  near(dupNow, dup + 272 - hook, 1e-6, 'and the longer duplicate');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('dialog.file-inspector').editing);
  assert(await inspector.isVisible(), 'Escape leaves the editor, not the inspector');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('dialog.file-inspector').open);

  // An SVG: drag the middle point of a transformed path up by 10 units.
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="60mm" viewBox="0 0 100 60">
  <g transform="translate(10 5)"><path id="leaf" d="M10 30 C20 10 40 10 50 30 S80 50 90 30"/></g>
  <polygon id="foot" points="60,35 80,50 40,50"/>
  <defs><path d="M0 0 L5 5"/></defs>
</svg>`;
  await page.locator('#file').setInputFiles({ name: 'leaf.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) });
  await page.waitForFunction(() => document.querySelector('#subjectPreview')?.source?.file?.name === 'leaf.svg'
    && document.querySelector('#subjectPreview').dataset.state === 'ready');
  await page.locator('#subjectPreview [data-action="expand"]').click();
  await inspector.locator('[data-inspector="edit"]').click();
  await loaded();
  assert.equal(await page.evaluate(() => document.querySelector('dialog.file-inspector').editor.entities.length), 2, 'defs stay out');
  const [onLeaf, point, up] = await pixels([[35, 20], [60, 35], [60, 25]]);
  await page.mouse.click(...onLeaf);
  assert.match(await editor().locator('.profile-editor-status').textContent(), /Path 1 of 2/);
  await drag(point, up);
  const written = page.evaluate(() => new Promise(resolve => {
    const preview = document.querySelector('#subjectPreview'), was = preview.source.file;
    const poll = () => preview.source.file !== was ? resolve(preview.source.file.text()) : setTimeout(poll, 50);
    poll();
  }));
  await editor().locator('[data-action="apply"]').click();
  const text = await written;
  assert.match(text, /^<\?xml version="1.0" encoding="UTF-8"\?>/, 'the XML declaration stays');
  assert.match(text, /<g transform="translate\(10 5\)"><path id="leaf" d="M10 30 C20 10 40 0 50 20 C60 40 80 50 90 30"\/>/,
    'the point and its handles moved, in the path’s own units');
  assert.match(text, /<polygon id="foot" points="60,25 80,50 40,50"\/>/, 'the touching polygon point followed');
  assert.match(await page.locator('#dropHint').textContent(), /paths edited/);
  await page.screenshot({ path: `${artifacts}/svg-applied.png` });
  assert.deepEqual(errors, []);
  console.log('path editor browser: ok');
} finally {
  await browser.close();
}
