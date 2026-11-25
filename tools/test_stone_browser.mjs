// Browser regression for the stone look: the gothic example opens in marble,
// the toolbar switch turns the frame plain and back, the Export step downloads
// a finished render on the dark background and cut out from it, and the switch
// is saved with the project and comes back with it. Nothing is saved on the
// server.
// PLAYWRIGHT_MODULE=/path/to/playwright-core APP_URL=http://localhost:8789 \
//   node tools/test_stone_browser.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const app = process.env.APP_URL || 'http://localhost:8788';
const artifacts = process.env.ARTIFACTS || '/tmp/mathmodels-stone';
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error' && /shader|WebGL|program/i.test(message.text())) errors.push(message.text()); });

const pressed = () => page.locator('#stone').getAttribute('aria-pressed');
const expectPressed = async (value, message) => {
  await page.waitForFunction(v => document.querySelector('#stone').getAttribute('aria-pressed') === v, value,
    { timeout: 10000 }).catch(() => {});
  assert.equal(await pressed(), value, message);
};
// The lit part of a picture: how much of it there is, and whether it leans
// warm (marble) or blue (the plain tracery colour). The picture is a PNG's
// bytes, or the viewer as it stands.
const tone = (png = null) => page.evaluate(async (b64) => {
  const picture = b64 ? await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob())
    : document.querySelector('#viewer');
  const flat = document.createElement('canvas');
  flat.width = picture.width; flat.height = picture.height;
  const ctx = flat.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(picture, 0, 0);
  const { data } = ctx.getImageData(0, 0, flat.width, flat.height);
  let lit = 0, warm = 0, clear = 0, solid = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) clear++;
    if (data[i + 3] === 255) solid++;
    if (data[i] + data[i + 1] + data[i + 2] < 330) continue;      // background, grid, shade
    lit++; warm += data[i] - data[i + 2];
  }
  return { lit: lit / (data.length / 4), warm: lit ? warm / lit : 0, clear, solid, pixels: data.length / 4 };
}, png && png.toString('base64'));
// The viewer redraws on its own clock, which software rendering makes slow.
const settle = async (check, message) => {
  for (let i = 0; i < 120; i++) {
    const seen = await tone();
    if (check(seen)) return seen;
    await page.waitForTimeout(250);
  }
  assert.fail(`${message}: ${JSON.stringify(await tone())}`);
};
const built = async action => {
  const pending = page.waitForResponse(r => r.url().endsWith('/api/regions'), { timeout: 180000 });
  await action();
  assert.equal((await pending).status(), 200);
  await page.waitForFunction(() => !document.querySelector('#stone').hidden && !document.querySelector('#go').disabled,
    null, { timeout: 180000 });
};
const download = async (action, name) => {
  const pending = page.waitForEvent('download', { timeout: 600000 });
  await action();
  const file = await pending, path = `${artifacts}/${name}`;
  await file.saveAs(path);
  return { name: file.suggestedFilename(), bytes: await readFile(path) };
};
const render = async (background, name) => {
  await page.locator('#renderBackground').selectOption(background);
  const file = await download(() => page.locator('#exportRender').click(), name);
  await page.waitForFunction(() => !document.querySelector('#exportRender').disabled);
  return file;
};

try {
  await page.goto(app);
  await page.waitForSelector('#shelfPlacementEditor canvas', { state: 'attached', timeout: 60000 });
  assert.equal(await pressed(), 'false', 'stained glass starts in its plain colours');
  await page.locator('#startGothic').click();
  await expectPressed('true', 'gothic tracery starts in stone');
  await built(() => page.locator('#gothicExample').click());

  const stone = await settle(seen => seen.lit > 0.01 && seen.warm > 0, 'the frame is drawn as pale, warm marble');
  await page.screenshot({ path: `${artifacts}/stone.png` });
  await page.locator('#stone').click();
  assert.equal(await pressed(), 'false');
  const plain = await settle(seen => seen.lit > 0.01 && seen.warm < -5, 'the plain frame is its blue-grey again');
  await page.screenshot({ path: `${artifacts}/plain.png` });
  assert(stone.warm - plain.warm > 8, `stone ${stone.warm} and plain ${plain.warm} are told apart`);
  await page.locator('#stone').click();
  await settle(seen => seen.warm > 0, 'the marble comes back');

  // The finished render: shaped like the viewer, the model alone on the background.
  await page.locator('#modelSteps [data-step=export]').click();
  await page.evaluate(() => {
    const sizes = document.querySelector('#renderSize');
    sizes.add(new Option('360', '360'));
    sizes.value = '360';
  });
  const shape = await page.evaluate(() => {
    const viewer = document.querySelector('#viewer');
    return viewer.clientWidth / viewer.clientHeight;
  });
  const size = shape >= 1 ? [360, Math.round(360 / shape)] : [Math.round(360 * shape), 360];
  const header = bytes => ({ png: bytes.subarray(1, 4).toString(), width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20), kind: bytes[25] });

  const dark = await render('dark', 'render-dark.png');
  assert.match(dark.name, /-stone\.png$/);
  assert.deepEqual(header(dark.bytes), { png: 'PNG', width: size[0], height: size[1], kind: 6 });
  assert.match(await page.locator('#status').textContent(), new RegExp(`stone render saved — ${size[0]} × ${size[1]} px`));
  const darkTone = await tone(dark.bytes);
  assert.equal(darkTone.solid, darkTone.pixels, 'the dark background is solid');
  assert(darkTone.lit > 0.01 && darkTone.warm > 0, `the render shows the marble: ${JSON.stringify(darkTone)}`);

  const cut = await render('transparent', 'render-cut-out.png');
  const cutTone = await tone(cut.bytes);
  assert(cutTone.clear > cutTone.pixels / 4, 'around the model the cut-out render is clear');
  assert(cutTone.solid > cutTone.pixels / 100, 'the model itself is solid');
  assert(Math.abs(cutTone.lit - darkTone.lit) < 0.02, 'both renders show the same model');

  assert.equal(await pressed(), 'true', 'rendering leaves the look as it was');
  await settle(seen => seen.lit > 0.01 && seen.warm > 0, 'the viewer carries on in stone after a render');

  // Rendering with the look off turns it on for the picture only.
  await page.locator('#stone').click();
  await settle(seen => seen.warm < -5, 'plain again before the render');
  const borrowed = await tone((await render('dark', 'render-from-plain.png')).bytes);
  assert(borrowed.warm > 0, 'the render is in stone even while the viewer is not');
  assert.equal(await pressed(), 'false');
  await settle(seen => seen.lit > 0.01 && seen.warm < -5, 'the viewer is plain again after the render');

  // The switch travels with the project; older projects take the workflow's default.
  const saved = JSON.parse((await download(() => page.locator('#saveProject').click(), 'stone-off.v2sproj')).bytes);
  assert.equal(saved.stoneLook, false);
  const open = project => built(() => page.locator('#startProjectFileInput').setInputFiles({
    name: 'stone-test.v2sproj', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)) }));
  const { stoneLook, ...older } = saved;
  await open(older);
  await expectPressed('true', 'a gothic project from before the stone look opens in stone');
  await open(saved);
  await expectPressed('false', 'a project saved plain opens plain');
  await open({ ...older, stoneLook: true });
  await expectPressed('true', 'a project saved in stone opens in stone');

  assert.deepEqual(errors, []);
  console.log('stone look browser test passed');
} finally {
  await browser.close();
}
