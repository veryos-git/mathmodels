// Browser regression for the paper screen: start a paper house, add two window
// decorations, drag one onto another wall and resize it, thicken its bars, cut
// the other one as drawn, clone one, change a template parameter, fold the 3D view, download the SVG, then save
// the paper project and reopen it from Start and from a downloaded project
// file. The saved test project is deleted again; like any upload, the window
// drawing is kept in the resource library.
// PLAYWRIGHT_MODULE=/path/to/playwright-core APP_URL=http://localhost:8789 \
//   node tools/test_paper_browser.mjs [window.svg]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const windowPath = process.argv[2] || new URL('./fixtures/paper-window.svg', import.meta.url).pathname;
const app = process.env.APP_URL || 'http://localhost:8788';
const projectName = `zz paper browser test ${Date.now()}`;
const artifacts = process.env.ARTIFACTS || '/tmp/mathmodels-paper';
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
const rebuild = async action => {
  const pending = page.waitForResponse(r => r.url().endsWith('/api/paper'), { timeout: 60000 });
  await action();
  const response = await pending, data = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(data));
  await page.waitForFunction(() => document.querySelector('#ppNetBox').getAttribute('aria-busy') === 'false');
  return data;
};
// A point in the net's millimetres, on screen.
const onScreen = point => page.evaluate(([x, y]) => {
  const p = new DOMPoint(x, y).matrixTransform(document.querySelector('#ppNet').getScreenCTM());
  return [p.x, p.y];
}, point);
const wallPoint = (wall, [x, y]) => [wall.origin[0] + wall.x[0] * x + wall.y[0] * y,
  wall.origin[1] + wall.x[1] * x + wall.y[1] * y];
const value = id => page.locator('#' + id).inputValue();
const emptyWall = (decorations, walls) => {
  const counts = Array(walls).fill(0);
  for (const d of decorations) counts[d.wall]++;
  return counts.indexOf(Math.min(...counts));
};

try {
  await page.goto(app);
  let data = await rebuild(() => page.locator('#startPaper').click());
  assert.equal(await page.locator('#paperScreen').isVisible(), true);
  assert.equal(await value('ppTemplate'), 'house.scad', 'the house is the default template');
  assert.equal(data.walls.length, 4);
  assert.equal(data.faces.length, 9, 'floor, four walls and four glue tabs');
  assert.equal(data.info.cutouts, 0, 'the default house has no windows');
  assert.equal(await page.locator('#ppNet .pp-wall-label').count(), 4);
  assert.ok(await page.locator('#ppParams [data-param="house_size"]').count() === 1, 'template parameters are editable');
  assert.equal(await page.locator('#ppParams [data-param="output"]').count(), 0, 'the output switch is the app\'s own');

  data = await rebuild(() => page.locator('#ppFile').setInputFiles(windowPath));
  assert.equal(data.decorations.length, 1);
  assert.equal(data.decorations[0].wall, 0);
  assert.equal(data.info.cutouts, 4, 'a window cross leaves four panes');
  assert.match(await page.locator('#ppStatus').textContent(), /^Net \d+ × \d+ mm/);
  assert.match(await value('ppProjectName'), / paper$/, 'a project name is suggested');
  data = await rebuild(() => page.locator('#ppFile').setInputFiles(windowPath));
  assert.deepEqual(data.decorations.map(d => d.wall), [0, 1], 'a new decoration goes on the emptiest wall');
  assert.equal(data.info.cutouts, 8);
  const cards = page.locator('#ppDecoList .pp-deco-card');
  assert.equal(await cards.count(), 2);
  for (const kind of ['cut', 'line']) {
    assert.equal(await page.locator(`#ppDecoList .pp-thumb .pp-thumb-${kind}`).count(), 2, `thumbnails show the ${kind}s`);
  }
  assert.equal(await cards.first().locator('input[type=checkbox]').isChecked(), true, 'a frame cutout by default');
  await page.screenshot({ path: `${artifacts}/two-windows.png` });

  // Drag the first window from wall 1 onto the middle of wall 3.
  const [first] = data.decorations;
  const from = await onScreen(wallPoint(data.walls[0], [first.x, first.y]));
  const target = data.walls[2], to = await onScreen(wallPoint(target, [target.size[0] / 2, 30]));
  data = await rebuild(async () => {
    await page.mouse.move(...from);
    await page.mouse.down();
    await page.mouse.move(to[0], to[1], { steps: 10 });
    assert.equal(await page.locator('#ppNet .pp-deco.moving').count(), 1, 'the dragged window is highlighted');
    await page.mouse.up();
  });
  assert.equal(data.decorations[0].wall, 2, 'dropped on wall 3');
  assert.ok(Math.abs(data.decorations[0].x - target.size[0] / 2) < 0.6 && Math.abs(data.decorations[0].y - 30) < 0.6,
    JSON.stringify(data.decorations[0]));
  assert.equal(await value('ppSelWall'), '2');

  // Drag a corner outwards: the window grows about its centre.
  const width = data.decorations[0].width;
  const handle = await page.locator('#ppNet .pp-handle').first().boundingBox();
  const corner = [handle.x + handle.width / 2, handle.y + handle.height / 2];
  const centre = await onScreen(wallPoint(data.walls[2], [data.decorations[0].x, data.decorations[0].y]));
  data = await rebuild(async () => {
    await page.mouse.move(...corner);
    await page.mouse.down();
    await page.mouse.move(centre[0] + (corner[0] - centre[0]) * 1.3, centre[1] + (corner[1] - centre[1]) * 1.3, { steps: 6 });
    await page.mouse.up();
  });
  assert.ok(Math.abs(data.decorations[0].width / width - 1.3) < 0.05, `${width} → ${data.decorations[0].width}`);

  // Thicker bars change the cut-outs, not the placement.
  const before = data.decorations[0].geometry.key;
  data = await rebuild(() => cards.first().getByRole('button', { name: '+', exact: true }).click());
  assert.equal(data.decorations[0].thickness, 2.5);
  assert.notEqual(data.decorations[0].geometry.key, before);
  assert.equal(await cards.first().locator('.pp-bars input').inputValue(), '2.5');

  // Typing slowly lets rebuilds land mid-number; the field keeps its focus and every digit.
  const typed = cards.nth(1).locator('.pp-bars input');
  await typed.fill('');
  const settled = page.waitForResponse(async r => r.url().endsWith('/api/paper')
    && (await r.json()).decorations?.[1]?.thickness === 1.5, { timeout: 60000 });
  await typed.pressSequentially('1.5', { delay: 700 });
  data = await (await settled).json();
  await page.waitForFunction(() => document.querySelector('#ppNetBox').getAttribute('aria-busy') === 'false');
  assert.equal(data.decorations[1].thickness, 1.5);
  assert.equal(await typed.inputValue(), '1.5');
  assert.equal(await typed.evaluate(input => input === document.activeElement), true);

  // Unticked, the drawing already is the cutout: the whole window is one hole.
  data = await rebuild(() => cards.nth(1).locator('input[type=checkbox]').uncheck());
  assert.equal(data.decorations[1].mode, 'drawn');
  assert.equal(data.info.cutouts, 4 + 1);
  assert.equal(await cards.nth(1).locator('.pp-bars input').isDisabled(), true, 'no bars to thicken');
  assert.equal(await cards.nth(1).locator('.pp-thumb .pp-thumb-cut').count(), 1);

  // A clone goes on the emptiest wall, at the same place, right after its original.
  const original = data.decorations[0];
  data = await rebuild(() => cards.first().getByRole('button', { name: 'clone +' }).click());
  assert.equal(data.decorations.length, 3);
  const copy = data.decorations[1];
  assert.equal(copy.wall, 0, 'wall 1 had none');
  for (const key of ['x', 'y', 'width', 'rotation', 'thickness', 'mode']) assert.equal(copy[key], original[key], key);
  assert.equal(data.info.cutouts, 4 + 4 + 1);
  assert.equal(await cards.nth(1).getAttribute('aria-selected'), 'true', 'the clone is selected');
  await page.screenshot({ path: `${artifacts}/cards.png` });

  data = await rebuild(() => page.locator('#ppParams [data-param="roof_style"]').selectOption('gable'));
  assert.equal(data.info.cutouts, 9, 'decorations stay through a template change');
  await page.locator('#ppFold').fill('50');
  await page.locator('#pp3dToggle').click();
  await page.screenshot({ path: `${artifacts}/moved-resized-gable.png` });
  await page.locator('#pp3dToggle').click();

  const svgDownload = page.waitForEvent('download');
  await page.locator('#ppDownload').click();
  const svg = await readFile(await (await svgDownload).path(), 'utf8');
  for (const layer of ['cut', 'fold']) assert.match(svg, new RegExp(`<g id="${layer}"`));
  assert.match(svg, /width="[\d.]+mm"/);
  assert.doesNotMatch(svg, /pp-area|wall 1/, 'the decoration area and labels are guides only');

  // Save on the server, then reopen it from the Start screen's project grid.
  const placement = ({ wall, x, y, width, thickness, mode }) => ({ wall, x, y, width, thickness, mode });
  const saved = data.decorations.map(placement);
  await page.locator('#ppProjectName').fill(projectName);
  const put = page.waitForResponse(r => r.url().includes('/api/projects/') && r.request().method() === 'PUT');
  await page.locator('#ppSave').click();
  assert.equal((await put).status(), 200);
  await page.waitForFunction(() => /^Saved /.test(document.querySelector('#ppStatus').textContent));
  await page.locator('#ppBack').click();
  const tile = page.locator('#startProjects .project-tile', { hasText: projectName });
  await tile.locator('img').waitFor();
  data = await rebuild(() => tile.locator('.tile-name').click());
  assert.equal(await page.locator('#paperScreen').isVisible(), true);
  assert.equal(await value('ppProjectName'), projectName);
  assert.equal(await page.locator('#ppParams [data-param="roof_style"]').inputValue(), 'gable');
  assert.deepEqual(data.decorations.map(placement), saved);
  assert.equal(await cards.nth(2).locator('input[type=checkbox]').isChecked(), false, 'cut as drawn, still');

  // A downloaded project file reopens through Start → Open a project file.
  const projectDownload = page.waitForEvent('download');
  await page.locator('#ppSaveFile').click();
  const projectFile = await projectDownload;
  const project = JSON.parse(await readFile(await projectFile.path(), 'utf8'));
  assert.equal(project.workflow, 'paper');
  assert.equal(project.paper.decorations.length, 3);
  await page.locator('#ppBack').click();
  await rebuild(() => page.locator('#startPaper').click());
  assert.equal(await cards.count(), 0, 'the Paper card starts a fresh house');
  await page.locator('#ppBack').click();
  const projectPath = await projectFile.path();
  data = await rebuild(() => page.locator('#startProjectFileInput').setInputFiles(projectPath));
  assert.equal(data.decorations.length, 3);

  // Delete removes the selected decoration, and so does its trash button.
  await cards.first().locator('.pp-thumb').click();
  data = await rebuild(async () => {
    await page.locator('#ppNet').focus();
    await page.keyboard.press('Delete');
  });
  assert.equal(data.decorations.length, 2);
  data = await rebuild(() => cards.first().getByRole('button', { name: /^Remove / }).click());
  assert.equal(data.decorations.length, 1);

  // The row house: drawn outside face up, folds perforated in the cut, no floor.
  data = await rebuild(() => page.locator('#ppTemplate').selectOption('papercut_fold_house2.scad'));
  assert.equal(data.netTop, 'outside');
  assert.equal(data.foldLayer, false);
  assert.match(await page.locator('#ppTemplateNote').textContent(), /^One-piece paper house net for an A4 sheet\./);
  assert.equal(await page.locator('#ppFoldKey').textContent(), 'fold (perforated in the cut)');
  assert.equal(await page.locator('#ppParams [data-param="door_width"]').count(), 1);
  assert.equal(await page.locator('#ppNet .pp-wall-label').count(), 4);
  data = await rebuild(() => page.locator('#ppFile').setInputFiles(windowPath));
  assert.equal(data.decorations.at(-1).wall, emptyWall(data.decorations.slice(0, -1), 4), 'the emptiest wall');
  const rowSvg = page.waitForEvent('download');
  await page.locator('#ppDownload').click();
  assert.doesNotMatch(await readFile(await (await rowSvg).path(), 'utf8'), /<g id="fold"/, 'no score layer to cut through');
  await page.locator('#pp3dToggle').click();
  await page.screenshot({ path: `${artifacts}/row-house.png` });
  await page.locator('#pp3dToggle').click();

  await page.locator('#ppLibrary').click();
  assert.equal(await page.locator('#libPickTitle').textContent(), 'Decoration from the library');
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  console.log(`paper browser test passed; screenshots in ${artifacts}`);
} finally {
  await page.request.delete(`${app}/api/projects/${encodeURIComponent(projectName)}`).catch(() => {});
  await browser.close();
}
