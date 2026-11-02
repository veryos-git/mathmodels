// Browser regression for the keyfob screen: load a subject, switch the back
// side to the whole subject, move the neck with both of its rings, download
// the SVG, then save the keyfob as a project and reopen it from Start and from
// a downloaded project file. The saved test project is deleted again.
// PLAYWRIGHT_MODULE=/path/to/playwright-core APP_URL=http://localhost:8789 \
//   node tools/test_keyfob_browser.mjs [subject.svg]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
// A drawing already in the library, so the upload does not add a new entry.
const subjectPath = process.argv[2] || new URL('../library/ghost2.svg', import.meta.url).pathname;
const app = process.env.APP_URL || 'http://localhost:8788';
const projectName = `zz keyfob browser test ${Date.now()}`;
const artifacts = '/tmp/mathmodels-keyfob';
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const rebuild = async action => {
  const pending = page.waitForResponse(r => r.url().endsWith('/api/keyfob'), { timeout: 60000 });
  await action();
  const response = await pending, data = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(data));
  await page.waitForFunction(() => document.querySelector('#kfPreviewBox').getAttribute('aria-busy') === 'false');
  return data;
};
const centreOf = async selector => {
  const box = await page.locator(selector).boundingBox();
  return [box.x + box.width / 2, box.y + box.height / 2];
};
const dragRing = (ring, to) => rebuild(async () => {
  await page.mouse.move(...await centreOf(`#kfPreview .kf-ring[data-ring="${ring}"]`));
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps: 8 });
  assert.equal(await page.locator('#kfPreview .kf-aim').count(), 1, 'neck guide while dragging');
  await page.mouse.up();
});
const value = id => page.locator('#' + id).inputValue();
// Positions in the preview's own millimetres, which a refit or zoom leaves alone.
const toMm = point => page.evaluate(([x, y]) => {
  const p = new DOMPoint(x, y).matrixTransform(document.querySelector('#kfPreview').getScreenCTM().inverse());
  return [p.x, p.y];
}, point);
const ringMm = ring => page.locator(`#kfPreview .kf-ring[data-ring="${ring}"]`)
  .evaluate(c => [Number(c.getAttribute('cx')), Number(c.getAttribute('cy'))]);
const apart = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

try {
  await page.goto(app);
  await page.locator('#startKeyfob').click();
  assert.equal(await page.locator('#keyfobScreen').isVisible(), true);
  assert.equal(await page.locator('#kfEmpty').isVisible(), true);
  for (const id of ['kfDownload', 'kfSave', 'kfSaveFile']) assert.equal(await page.locator('#' + id).isDisabled(), true);

  let data = await rebuild(() => page.locator('#kfFile').setInputFiles(subjectPath));
  assert.equal(data.info.subject.some(side => Math.abs(side - 50) < 0.01), true, 'longest side is the 50 mm default');
  assert.equal(await page.locator('#kfPreview #cut path').count(), 1);
  assert.equal(await page.locator('#kfPreview #details-back').count(), 0, 'silhouette-only back by default');
  assert.match(await page.locator('#kfStatus').textContent(), /^Keyfob /);
  assert.match(await value('kfProjectName'), / keyfob$/, 'a project name is suggested');
  assert.equal(await page.locator('#kfPreview .kf-ring').count(), 2);
  assert.equal(await page.locator('#kfPreview .kf-silhouette').count(), 1, 'original silhouette shown');
  // The key ring hangs from the fold: its wire's centre line runs through it.
  const keyRing = () => page.locator('#kfPreview .kf-keyring')
    .evaluate(c => ({ c: [Number(c.getAttribute('cx')), Number(c.getAttribute('cy'))], r: Number(c.getAttribute('r')) }));
  let ring = await keyRing();
  assert.ok(Math.abs(ring.r - (25 - 2.5) / 2) < 1e-6);
  assert.ok(Math.abs(apart(ring.c, await ringMm('fold')) - ring.r) < 1e-3, 'wire through the fold');
  await page.locator('#kfRingShow').uncheck();
  assert.equal(await page.locator('#kfPreview .kf-keyring').count(), 0);
  await page.locator('#kfRingShow').check();
  await page.locator('#kfRingDiameter').fill('30');
  ring = await keyRing();
  assert.ok(Math.abs(ring.r - (30 - 2.5) / 2) < 1e-6, 'diameter applies without a rebuild');
  await page.locator('#kfRingDiameter').fill('12');
  assert.match(await page.locator('#kfStatus').textContent(), /wider than the key ring's 7\.0 mm opening/);
  await page.locator('#kfRingDiameter').fill('30');
  await page.screenshot({ path: `${artifacts}/silhouette.png` });

  data = await rebuild(() => page.locator('input[name="kfMirror"][value="full"]').check());
  assert.equal(data.info.back, data.info.details);
  assert.ok(await page.locator('#kfPreview #details-back path').count() > 0);

  // Big ring to the right of the small one: the neck points right, through the centre.
  const base = await centreOf('#kfPreview .kf-ring[data-ring="base"]');
  data = await dragRing('fold', [base[0] + 200, base[1]]);
  assert.equal(await value('kfNeckAngle'), '90');
  assert.equal(Number(await value('kfNeckOffset')), 0);
  assert.ok(Math.abs(data.direction[0] - 1) < 1e-6 && Math.abs(data.direction[1]) < 1e-6);

  // Small ring up and towards the fold: the neck pivots around the big ring and
  // runs through the spot where the small ring was dropped.
  // The view refits after each rebuild, so measure the rings afresh.
  const fold = await centreOf('#kfPreview .kf-ring[data-ring="fold"]');
  const start = await centreOf('#kfPreview .kf-ring[data-ring="base"]');
  const drop = [start[0] + 40, start[1] - 30];
  const dropMm = await toMm(drop);
  data = await dragRing('base', drop);
  const angle = Number(await value('kfNeckAngle'));
  const expected = Math.atan2(fold[0] - drop[0], drop[1] - fold[1]) * 180 / Math.PI;
  assert.ok(Math.abs(angle - Math.round(expected)) <= 1, `angle ${angle} vs ${expected}`);
  assert.notEqual(Number(await value('kfNeckOffset')), 0, 'the neck moved off the centre');
  const moved = await ringMm('base');
  assert.ok(apart(moved, dropMm) < 0.1, `small ring stays where dropped: ${moved} vs ${dropMm}`);

  data = await rebuild(async () => {
    await page.locator('#kfStitch').check();
    await page.locator('#kfFoldMark').check();
  });
  assert.ok(data.info.stitch > 0);
  assert.equal(await page.locator('#kfPreview #fold path').count(), 1);
  await page.screenshot({ path: `${artifacts}/full-moved-stitched.png` });

  const svgDownload = page.waitForEvent('download');
  await page.locator('#kfDownload').click();
  const svgFile = await svgDownload;
  assert.match(svgFile.suggestedFilename(), /-keyfob\.svg$/);
  const svg = await readFile(await svgFile.path(), 'utf8');
  for (const layer of ['cut', 'details-back', 'stitch']) assert.match(svg, new RegExp(`<g id="${layer}"`));
  assert.match(svg, /width="[\d.]+mm"/);
  assert.doesNotMatch(svg, /kf-silhouette/, 'the original silhouette is a preview guide only');

  // Save on the server, then reopen it from the Start screen's project grid.
  const saved = { angle: await value('kfNeckAngle'), offset: await value('kfNeckOffset') };
  await page.locator('#kfProjectName').fill(projectName);
  const put = page.waitForResponse(r => r.url().includes('/api/projects/') && r.request().method() === 'PUT');
  await page.locator('#kfSave').click();
  assert.equal((await put).status(), 200);
  await page.waitForFunction(() => /^Saved /.test(document.querySelector('#kfStatus').textContent));
  await page.locator('#kfBack').click();
  const tile = page.locator('#startProjects .project-tile', { hasText: projectName });
  await tile.locator('img').waitFor();   // the saved thumbnail
  await page.screenshot({ path: `${artifacts}/start-tile.png` });
  data = await rebuild(() => tile.locator('.tile-name').click());
  assert.equal(await page.locator('#keyfobScreen').isVisible(), true);
  assert.equal(await value('kfProjectName'), projectName);
  assert.equal(await value('kfNeckAngle'), saved.angle);
  assert.equal(await value('kfNeckOffset'), saved.offset);
  assert.equal(await page.locator('input[name="kfMirror"][value="full"]').isChecked(), true);
  assert.equal(await page.locator('#kfStitch').isChecked(), true);
  assert.equal(await page.locator('#kfFoldMark').isChecked(), true);
  assert.equal(await value('kfRingDiameter'), '30');
  assert.ok(apart(await ringMm('base'), moved) < 0.01, 'small ring restored');

  // A downloaded project file reopens through Start → Open a project file.
  const projectDownload = page.waitForEvent('download');
  await page.locator('#kfSaveFile').click();
  const projectFile = await projectDownload;
  assert.equal(projectFile.suggestedFilename(), `${projectName}.v2sproj`);
  const project = JSON.parse(await readFile(await projectFile.path(), 'utf8'));
  assert.equal(project.format, 'vector2stl-project');
  assert.equal(project.workflow, 'keyfob');
  assert.equal(project.keyfob.mirror, 'full');
  await page.locator('#kfBack').click();
  await page.locator('#startKeyfob').click();
  assert.equal(await page.locator('#kfEmpty').isVisible(), true, 'the Keyfob card starts a fresh keyfob');
  assert.equal(await value('kfNeckAngle'), '0');
  await page.locator('#kfBack').click();
  const projectPath = await projectFile.path();
  await rebuild(() => page.locator('#startProjectFileInput').setInputFiles(projectPath));
  assert.equal(await value('kfNeckAngle'), saved.angle);

  await page.locator('#kfLibrary').click();
  assert.equal(await page.locator('#libraryPicker').isVisible(), true);
  assert.equal(await page.locator('#libPickTitle').textContent(), 'Keyfob subject from the library');
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  console.log(`keyfob browser test passed; screenshots in ${artifacts}`);
} finally {
  await page.request.delete(`${app}/api/projects/${encodeURIComponent(projectName)}`).catch(() => {});
  await browser.close();
}
