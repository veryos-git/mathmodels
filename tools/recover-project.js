/*
 * Rescue a session started before "Save project" existed.
 *
 * The page keeps its state (drawing, face heights, hues, holes) in module
 * scope, so the console cannot read it directly — but every save button packs
 * that state into a FormData. This intercepts the next such request and writes
 * a .v2sproj from it.
 *
 * How to use, in the tab you already have open — do NOT reload it first:
 *   1. Open DevTools -> Console.
 *   2. Paste this whole file and press Enter.
 *   3. Click "Export STLs by colour" (best — carries the colours too).
 *      If that button does not exist in your version, click "Download STL".
 *   4. A .v2sproj downloads alongside the normal export.
 *   5. Now reload the page and drop the .v2sproj onto it.
 */
(() => {
  const HUE_NAMES = ['amber', 'teal', 'violet'];
  const original = window.fetch;

  function toBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return btoa(bin);
  }

  /** Face id -> value, as a dense array ordered by id. */
  function byId(json, fallback) {
    if (!json) return null;
    const map = JSON.parse(json);
    const ids = Object.keys(map).map(Number).sort((a, b) => a - b);
    if (!ids.length) return null;
    const out = new Array(ids[ids.length - 1] + 1).fill(fallback);
    for (const id of ids) out[id] = map[id];
    return out;
  }

  const field = (id) => {
    const el = document.getElementById(id);
    return el ? el.value : undefined;
  };

  async function recover(form) {
    const file = form.get('file');
    if (!(file instanceof File)) throw new Error('no drawing in the request');

    const heights = byId(form.get('heights'), 0.2);
    if (!heights) throw new Error('this version does not send face heights');

    // "Export STLs by colour" sends groups like "2-teal"; that is the hue.
    const groupNames = byId(form.get('groups'), '1-amber');
    const hues = heights.map((_, i) => {
      const name = groupNames && groupNames[i];
      if (typeof name !== 'string') return 0;
      const n = parseInt(name, 10);
      if (Number.isFinite(n) && n >= 1) return n - 1;
      const guess = HUE_NAMES.indexOf(name.replace(/^\d+-/, ''));
      return guess < 0 ? 0 : guess;
    });

    const settings = {};
    for (const id of ['wallWidth', 'wallHeight', 'regionMin', 'regionMax', 'sagitta',
                      'scale', 'seed']) {
      const v = field(id);
      if (v !== undefined) settings[id] = v;
    }

    const project = {
      format: 'vector2stl-project',
      version: 1,
      saved: new Date().toISOString(),
      recovered: true,
      drawing: { name: file.name, data: toBase64(new Uint8Array(await file.arrayBuffer())) },
      settings,
      layers: form.get('layers') ?? '',
      faces: { heights, hues },
      holes: JSON.parse(form.get('holes') ?? '[]'),
    };

    const url = URL.createObjectURL(
      new Blob([JSON.stringify(project)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name.replace(/\.(dxf|svg)$/i, '') + '.v2sproj';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);

    console.log(`%crecovered ${heights.length} faces, ${project.holes.length} holes`
      + `${groupNames ? '' : ' (no colours — used Download STL, so all faces are hue 1)'}`,
      'color:#16a34a;font-weight:bold');
  }

  window.fetch = function (input, init) {
    const body = init && init.body;
    if (body instanceof FormData && body.get('file') && body.get('heights')) {
      window.fetch = original;                  // one shot, then get out of the way
      recover(body).catch((e) => console.error('recovery failed:', e));
    }
    return original.apply(this, arguments);
  };

  console.log('%cready — now click "Export STLs by colour" (or "Download STL")',
    'color:#3b82f6;font-weight:bold');
})();
