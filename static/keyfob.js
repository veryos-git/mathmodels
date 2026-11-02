// Keyfob mode: a subject's silhouette gets a neck and is mirrored across a fold
// in its middle, giving one fold-over keyfob as an SVG in millimetres.
// The server (tools/keyfob.py) builds the geometry; this screen edits the
// settings, previews the result, aims the neck with its two rings and saves
// the keyfob as a project beside the 3D ones.

const SVG_NS = 'http://www.w3.org/2000/svg';
const NUMBER_FIELDS = {
  kfSize: 'size', kfNeckWidth: 'neckWidth', kfNeckLength: 'neckLength',
  kfNeckAngle: 'neckAngle', kfNeckOffset: 'neckOffset', kfFillet: 'fillet', kfCloseGaps: 'closeGaps',
};
const DEFAULTS = {
  size: 50, neckWidth: 12, neckLength: 30, neckAngle: 0, neckOffset: 0, fillet: 3, closeGaps: 0.6,
  mirror: 'silhouette', stitch: false, stitchOffset: 3, foldMark: false, anchorAlong: 0,
  keyRing: true, keyRingDiameter: 25, keyRingWire: 2.5,
};
const REBUILD_DELAY = 300;
const FOLD_PX = 9;
const ANCHOR_PX = 6;
// The server's own rule for project names.
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

/** Unit vectors along the neck (0° = up, clockwise) and to its right, y up. */
function axis(angle) {
  const a = angle * Math.PI / 180;
  const d = [Math.sin(a), Math.cos(a)];
  return { d, n: [d[1], -d[0]] };
}

const round = (value, step) => Math.round(value / step) * step;

/**
 * The neck that runs from `from` towards `to` (y-up millimetres, relative to
 * the subject's centre): its angle, its sideways offset from the centre, and
 * how far along the neck `from` sits. The angle snaps to `snap` degrees and
 * the neck still passes exactly through `from`.
 */
export function neckThrough(from, to, snap = 1) {
  const deg = Math.atan2(to[0] - from[0], to[1] - from[1]) * 180 / Math.PI;
  const angle = ((round(deg, snap) % 360) + 360) % 360;
  const { d, n } = axis(angle);
  return {
    angle,
    offset: round(from[0] * n[0] + from[1] * n[1], 0.01),
    along: round(from[0] * d[0] + from[1] * d[1], 0.01),
  };
}

/** Where the neck's base ring sits, y up: `offset` to the side, `along` up the neck. */
export function anchorPoint(angle, offset, along) {
  const { d, n } = axis(angle);
  return [offset * n[0] + along * d[0], offset * n[1] + along * d[1]];
}

/**
 * The key ring as it hangs on the finished keyfob: its wire runs through the
 * fold, and the ring lies beyond it along the neck's direction `u` (unit, the
 * SVG's y-down coordinates). Null when the sizes cannot make a ring.
 */
export function keyRingAt(fold, u, diameter, wire) {
  if (!(wire > 0) || !(diameter > 2 * wire)) return null;
  const radius = (diameter - wire) / 2;          // the wire's centre line
  return { cx: fold[0] + radius * u[0], cy: fold[1] + radius * u[1], radius, wire, diameter };
}

/** A file name turned into a project name the server accepts. */
export function projectNameFor(fileName) {
  const base = String(fileName || 'keyfob').replace(/\.[^.]+$/, '')
    .replace(/[^A-Za-z0-9 ._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 56).trim();
  return `${base || 'subject'} keyfob`;
}

export function initKeyfob({ $, showScreen, openPicker, saveBlob, libraryRemember, filePreview,
  fileBase64, fromBase64, refreshShelf, projectFormat }) {
  let subject = null;        // the loaded subject (File)
  let result = null;         // the last /api/keyfob response
  let along = 0;             // how far up the neck its base ring sits, mm (display only)
  let view = null;           // [x, y, w, h] of the preview, in the SVG's mm
  let userView = false;      // the user zoomed or panned: keep their view on rebuilds
  let timer = 0, request = 0, controller = null, drag = null;

  const svg = $('kfPreview');
  const content = document.createElementNS(SVG_NS, 'g');
  const guides = document.createElementNS(SVG_NS, 'g');
  guides.id = 'kfGuides';
  svg.append(content, guides);

  const number = (id) => Number($(id).value) || 0;

  function settings() {
    const form = new FormData();
    for (const [id, key] of Object.entries(NUMBER_FIELDS)) form.append(key, $(id).value);
    form.append('mirror', document.querySelector('input[name="kfMirror"]:checked').value);
    form.append('stitch', $('kfStitch').checked ? $('kfStitchOffset').value : '0');
    form.append('foldMark', $('kfFoldMark').checked ? '1' : '0');
    return form;
  }

  /** Every setting, as saved in a project. */
  function snapshot() {
    return {
      ...Object.fromEntries(Object.entries(NUMBER_FIELDS).map(([id, key]) => [key, Number($(id).value)])),
      mirror: document.querySelector('input[name="kfMirror"]:checked').value,
      stitch: $('kfStitch').checked, stitchOffset: Number($('kfStitchOffset').value),
      foldMark: $('kfFoldMark').checked, anchorAlong: along,
      keyRing: $('kfRingShow').checked, keyRingDiameter: Number($('kfRingDiameter').value),
      keyRingWire: Number($('kfRingWire').value),
    };
  }

  function restoreSettings(saved = {}) {
    const value = (key) => saved[key] ?? DEFAULTS[key];
    for (const [id, key] of Object.entries(NUMBER_FIELDS)) {
      $(id).value = Number.isFinite(Number(value(key))) ? Number(value(key)) : DEFAULTS[key];
    }
    const mirror = value('mirror') === 'full' ? 'full' : 'silhouette';
    document.querySelector(`input[name="kfMirror"][value="${mirror}"]`).checked = true;
    $('kfStitch').checked = !!value('stitch');
    $('kfStitchOffset').value = Number(value('stitchOffset')) || DEFAULTS.stitchOffset;
    $('kfStitchOffset').disabled = !$('kfStitch').checked;
    $('kfFoldMark').checked = !!value('foldMark');
    along = Number(value('anchorAlong')) || 0;
    $('kfRingShow').checked = !!value('keyRing');
    $('kfRingDiameter').value = Number(value('keyRingDiameter')) || DEFAULTS.keyRingDiameter;
    $('kfRingWire').value = Number(value('keyRingWire')) || DEFAULTS.keyRingWire;
    ringInputs();
  }

  function ringInputs() {
    for (const id of ['kfRingDiameter', 'kfRingWire']) $(id).disabled = !$('kfRingShow').checked;
    $('kfLegendRing').hidden = !$('kfRingShow').checked;
  }

  /** The key ring for the current fold, or while a ring is dragged, the aimed one. */
  function keyRing(fold = result.fold, u = result.direction) {
    if (!$('kfRingShow').checked) return null;
    return keyRingAt(fold, u, number('kfRingDiameter'), number('kfRingWire'));
  }

  /** What the view has to show: the keyfob and the key ring hanging from it. */
  function extent() {
    const [x, y, w, h] = result.view;
    const ring = keyRing();
    if (!ring) return [x, y, w, h];
    const r = ring.diameter / 2 + 2;
    const x0 = Math.min(x, ring.cx - r), y0 = Math.min(y, ring.cy - r);
    return [x0, y0, Math.max(x + w, ring.cx + r) - x0, Math.max(y + h, ring.cy + r) - y0];
  }

  function say(text, error = false) {
    $('kfStatus').textContent = text;
    $('kfStatus').classList.toggle('error', error);
  }

  function schedule() {
    clearTimeout(timer);
    if (subject) timer = setTimeout(build, REBUILD_DELAY);
  }

  async function build() {
    clearTimeout(timer);
    if (!subject) return;
    const id = ++request;
    controller?.abort();
    controller = new AbortController();
    const form = settings();
    form.append('file', subject);
    say('Building the keyfob…');
    $('kfPreviewBox').setAttribute('aria-busy', 'true');
    try {
      const response = await fetch('/api/keyfob', { method: 'POST', body: form, signal: controller.signal });
      const data = await response.json();
      if (id !== request) return;
      if (!response.ok) throw new Error(data.error || 'Could not build the keyfob.');
      const fresh = !result;
      result = data;
      render(fresh);
      describe();
    } catch (error) {
      if (error.name === 'AbortError' || id !== request) return;
      say(error.message || String(error), true);
    } finally {
      if (id === request) $('kfPreviewBox').setAttribute('aria-busy', 'false');
      updateButtons();
    }
  }

  function updateButtons() {
    for (const id of ['kfDownload', 'kfSave', 'kfSaveFile']) $(id).disabled = !result;
  }

  function render(fresh) {
    const doc = new DOMParser().parseFromString(result.svg, 'image/svg+xml');
    // The original silhouette goes underneath: it shows through the keyfob's
    // translucent fill, and the cut line stays solid where the two coincide.
    const original = document.createElementNS(SVG_NS, 'path');
    original.setAttribute('d', result.silhouette);
    original.setAttribute('class', 'kf-silhouette');
    content.replaceChildren(original, ...[...doc.documentElement.children]
      .map((node) => document.importNode(node, true)));
    $('kfEmpty').hidden = true;
    if (fresh || !view) fit(false);
    else if (!userView) follow();
    paint();
  }

  function describe() {
    const i = result.info;
    const parts = [`Keyfob ${i.width.toFixed(1)} × ${i.height.toFixed(1)} mm`,
      `subject ${i.subject[0].toFixed(1)} × ${i.subject[1].toFixed(1)} mm`,
      `neck ${i.neckLength.toFixed(1)} mm between the halves`];
    if (i.details) parts.push(`${i.details} detail line${i.details === 1 ? '' : 's'} on the front`
      + (i.back ? ', mirrored on the back' : ''));
    const notes = [...i.notes];
    const ring = keyRing(), opening = ring && ring.diameter - 2 * ring.wire;
    if (ring && number('kfNeckWidth') > opening) {
      notes.push(`the ${number('kfNeckWidth')} mm neck is wider than the key ring's ${opening.toFixed(1)} mm opening`);
    }
    say(parts.join(' · ') + (notes.length ? `. Note: ${notes.join('; ')}.` : '.'));
    for (const [id, key] of [['kfLegendBack', 'back'], ['kfLegendStitch', 'stitch'], ['kfLegendDetails', 'details']]) {
      $(id).hidden = !i[key];
    }
    $('kfLegendFold').hidden = !$('kfFoldMark').checked;
  }

  /* ---------------------------------------------------------- preview view */

  function fit(user = true) {
    if (!result) return;
    view = extent();
    userView = false;
    if (user) paint();
  }

  /**
   * Keep the subject where it is on screen after a rebuild, so a ring that was
   * just dropped stays under the pointer; zoom out only as far as the whole
   * keyfob needs to stay in view.
   */
  function follow() {
    const box = svg.getBoundingClientRect(), ctm = svg.getScreenCTM();
    if (!ctm || box.width < 1 || box.height < 1) return fit(false);
    const scale = ctm.a;                                   // px per mm now
    const [cx, cy] = result.centre;
    const px = ctm.a * cx + ctm.e - box.left, py = ctm.d * cy + ctm.f - box.top;
    const [x, y, w, h] = extent();
    const limits = [scale];
    if (x < cx) limits.push(px / (cx - x));
    if (x + w > cx) limits.push((box.width - px) / (x + w - cx));
    if (y < cy) limits.push(py / (cy - y));
    if (y + h > cy) limits.push((box.height - py) / (y + h - cy));
    const fitted = Math.min(...limits);
    // A subject pushed off screen, or a keyfob far too big for this zoom: start over.
    if (!(fitted > scale / 5)) return fit(false);
    view = [cx - px / fitted, cy - py / fitted, box.width / fitted, box.height / fitted];
  }

  function paint() {
    if (!view) return;
    svg.setAttribute('viewBox', view.join(' '));
    const fitted = result ? Math.max(result.view[2] / view[2], result.view[3] / view[3]) : 1;
    $('kfZoom').textContent = `${Math.round(fitted * 100)}%`;
    drawGuides();
  }

  /** Millimetres per screen pixel at the current zoom (the viewBox is "meet"). */
  function mmPerPx() {
    const box = svg.getBoundingClientRect();
    return Math.max(view[2] / Math.max(box.width, 1), view[3] / Math.max(box.height, 1));
  }

  /** The pointer in the preview's millimetres, y up, relative to the subject's centre. */
  function pointer(event) {
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM().inverse());
    return [point.x - result.centre[0], result.centre[1] - point.y];
  }

  /** Back to the SVG's y-down coordinates. */
  const onScreen = ([x, y]) => [result.centre[0] + x, result.centre[1] - y];

  function element(tag, attributes, parent = guides) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    parent.append(node);
    return node;
  }

  /** The two rings: the neck's base (small) and its fold (big), on the neck's axis. */
  function drawGuides() {
    guides.replaceChildren();
    if (!result) return;
    const px = mmPerPx();
    const base = onScreen(drag?.base ?? anchorPoint(number('kfNeckAngle'), number('kfNeckOffset'), along));
    const fold = drag?.fold ? onScreen(drag.fold) : result.fold;
    // While a ring is dragged the neck points from the small ring to the big one.
    const length = Math.hypot(fold[0] - base[0], fold[1] - base[1]);
    const u = drag?.ring && length > 1e-9
      ? [(fold[0] - base[0]) / length, (fold[1] - base[1]) / length] : result.direction;
    const ring = keyRing(fold, u);
    if (ring) {
      // A steel band the width of the wire, with its two edges drawn crisp.
      element('circle', { cx: ring.cx, cy: ring.cy, r: ring.radius, 'stroke-width': ring.wire, class: 'kf-keyring' });
      for (const r of [ring.radius - ring.wire / 2, ring.radius + ring.wire / 2]) {
        element('circle', { cx: ring.cx, cy: ring.cy, r, class: 'kf-keyring-edge' }).style.strokeWidth = `${px}`;
      }
    }
    if (drag && !drag.pan) {
      // The neck as it will be aimed, at its real width.
      element('line', { x1: base[0], y1: base[1], x2: fold[0], y2: fold[1], class: 'kf-aim' })
        .style.strokeWidth = `${number('kfNeckWidth') || 1}`;
      const at = drag.ring === 'base' ? base : fold;
      element('text', { x: at[0] + 14 * px, y: at[1] - 14 * px, 'font-size': 13 * px }).textContent =
        `${drag.neck.angle}°` + (drag.neck.offset ? ` · offset ${drag.neck.offset.toFixed(1)} mm` : '');
    }
    const axisLine = element('line', { x1: base[0], y1: base[1], x2: fold[0], y2: fold[1], class: 'kf-axis' });
    axisLine.style.strokeWidth = `${1.5 * px}`;
    axisLine.style.strokeDasharray = `${5 * px} ${4 * px}`;
    const rings = [
      ['base', base, ANCHOR_PX, 'Drag to move the base of the neck; it pivots around the big ring (Shift snaps to 15°)'],
      ['fold', fold, FOLD_PX, 'Drag to swing the neck around the small ring (Shift snaps to 15°)'],
    ];
    for (const [ring, [cx, cy], r, tip] of rings) {
      const circle = element('circle', { cx, cy, r: r * px, class: 'kf-ring', 'data-ring': ring });
      circle.style.strokeWidth = `${2.5 * px}`;
      element('title', {}, circle).textContent = tip;
    }
  }

  function zoomAt(factor, clientX, clientY) {
    if (!view) return;
    const [px, py] = clientX === undefined
      ? [view[0] + view[2] / 2, view[1] + view[3] / 2]
      : (() => {
        const p = new DOMPoint(clientX, clientY).matrixTransform(svg.getScreenCTM().inverse());
        return [p.x, p.y];
      })();
    const w = Math.min(Math.max(view[2] / factor, result.view[2] / 40), result.view[2] * 10);
    const ratio = w / view[2];
    view = [px - (px - view[0]) * ratio, py - (py - view[1]) * ratio, w, view[3] * ratio];
    userView = true;
    paint();
  }

  svg.addEventListener('wheel', (event) => {
    if (!view) return;
    event.preventDefault();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1);
    zoomAt(Math.exp(-Math.max(-200, Math.min(200, delta)) * 0.005), event.clientX, event.clientY);
  }, { passive: false });

  svg.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !view) return;
    event.preventDefault();
    svg.setPointerCapture(event.pointerId);
    svg.focus({ preventScroll: true });
    const ring = event.target.dataset?.ring;
    if (!ring) {
      drag = { id: event.pointerId, pan: [event.clientX, event.clientY] };
      svg.classList.add('panning');
      return;
    }
    // Each ring moves on its own; the other one stays where it is.
    const base = anchorPoint(number('kfNeckAngle'), number('kfNeckOffset'), along);
    const fold = [result.fold[0] - result.centre[0], result.centre[1] - result.fold[1]];
    drag = { id: event.pointerId, ring, base, fold,
      neck: { angle: number('kfNeckAngle'), offset: number('kfNeckOffset'), along } };
  });
  svg.addEventListener('pointermove', (event) => {
    if (drag?.id !== event.pointerId) return;
    if (drag.pan) {
      const px = mmPerPx();
      view[0] -= (event.clientX - drag.pan[0]) * px;
      view[1] -= (event.clientY - drag.pan[1]) * px;
      drag.pan = [event.clientX, event.clientY];
      userView = true;
      paint();
      return;
    }
    const snap = event.shiftKey ? 15 : 1;
    drag[drag.ring] = pointer(event);
    drag.neck = neckThrough(drag.base, drag.fold, snap);
    paint();
  });
  const endDrag = (event) => {
    if (drag?.id !== event.pointerId) return;
    const neck = !drag.pan && event.type === 'pointerup' ? drag.neck : null;
    drag = null;
    svg.classList.remove('panning');
    if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
    if (neck && (neck.angle !== number('kfNeckAngle') || neck.offset !== number('kfNeckOffset')
      || neck.along !== along)) {
      $('kfNeckAngle').value = neck.angle;
      $('kfNeckOffset').value = neck.offset;
      along = neck.along;
      build();
    } else paint();
  };
  for (const type of ['pointerup', 'pointercancel']) svg.addEventListener(type, endDrag);
  svg.addEventListener('dblclick', () => fit());
  svg.addEventListener('keydown', (event) => {
    if (['+', '='].includes(event.key)) zoomAt(1.4);
    else if (event.key === '-') zoomAt(1 / 1.4);
    else if (['0', 'Home'].includes(event.key)) fit();
    else return;
    event.preventDefault();
  });
  new ResizeObserver(() => paint()).observe(svg);
  $('kfZoomIn').onclick = () => zoomAt(1.4);
  $('kfZoomOut').onclick = () => zoomAt(1 / 1.4);
  $('kfFit').onclick = () => fit();

  /* -------------------------------------------------------------- settings */

  for (const id of [...Object.keys(NUMBER_FIELDS), 'kfStitchOffset']) $(id).addEventListener('input', schedule);
  for (const input of document.querySelectorAll('input[name="kfMirror"], #kfStitch, #kfFoldMark')) {
    input.addEventListener('change', () => {
      $('kfStitchOffset').disabled = !$('kfStitch').checked;
      schedule();
    });
  }
  $('kfRingShow').addEventListener('change', () => { ringInputs(); if (result) { paint(); describe(); } });
  for (const id of ['kfRingDiameter', 'kfRingWire']) {
    $(id).addEventListener('input', () => { if (result) { paint(); describe(); } });
  }
  for (const button of document.querySelectorAll('#kfAimButtons button')) {
    button.onclick = () => { $('kfNeckAngle').value = button.dataset.angle; build(); };
  }

  /* --------------------------------------------------------------- subject */

  async function setSubject(file) {
    if (!/\.(svg|dxf)$/i.test(file?.name ?? '')) return say('The keyfob subject must be an .svg or .dxf file.', true);
    subject = file;
    result = null;
    userView = false;
    content.replaceChildren();
    guides.replaceChildren();
    $('kfName').textContent = file.name;
    $('kfTitleName').textContent = `· ${file.name}`;
    $('kfSource').source = filePreview(file);
    if (!$('kfProjectName').value.trim()) $('kfProjectName').value = projectNameFor(file.name);
    updateButtons();
    await build();
  }

  /** A fresh keyfob: no subject, default settings, no project name. */
  function reset() {
    clearTimeout(timer);
    request++;
    controller?.abort();
    subject = result = view = null;
    userView = false;
    restoreSettings();
    content.replaceChildren();
    guides.replaceChildren();
    $('kfProjectName').value = '';
    $('kfName').textContent = 'no subject loaded';
    $('kfTitleName').textContent = '';
    $('kfSource').source = null;
    $('kfEmpty').hidden = false;
    $('kfPreviewBox').setAttribute('aria-busy', 'false');
    say('Fold the neck through a key ring and the back half lies exactly behind the front.');
    updateButtons();
  }

  $('kfOpen').onclick = () => $('kfFile').click();
  $('kfEmptyOpen').onclick = () => $('kfFile').click();
  $('kfFile').onchange = (event) => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    setSubject(file);
    libraryRemember(file);          // starting from an upload keeps it reusable
  };
  $('kfLibrary').onclick = () => openPicker('keyfob');
  $('kfEmptyLibrary').onclick = () => openPicker('keyfob');
  $('kfBack').onclick = () => showScreen('start');
  $('kfDownload').onclick = () => {
    if (!result) return;
    const base = (subject?.name || 'subject').replace(/\.[^.]+$/, '');
    saveBlob(result.svg, 'image/svg+xml', `${base}-keyfob.svg`);
  };

  /* --------------------------------------------------------------- project */

  async function buildProject() {
    return {
      format: projectFormat, version: 1, saved: new Date().toISOString(), workflow: 'keyfob',
      drawing: { name: subject.name, data: await fileBase64(subject), resource: subject.resource ?? null },
      keyfob: snapshot(),
    };
  }

  /** The finished keyfob on paper, for the project tile on Start. */
  async function thumbnail() {
    try {
      const size = 320;
      const root = new DOMParser().parseFromString(result.svg, 'image/svg+xml').documentElement;
      const line = Math.max(result.view[2], result.view[3]) / size * 2;
      for (const group of root.querySelectorAll('g')) group.setAttribute('stroke-width', line);
      root.querySelector('[id="cut"]')?.setAttribute('fill', '#ead7c3');
      root.setAttribute('width', size);
      root.setAttribute('height', size);
      const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(root)], { type: 'image/svg+xml' }));
      const image = new Image();
      try {
        await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = url; });
      } finally {
        URL.revokeObjectURL(url);
      }
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#f4f6f9';
      ctx.fillRect(0, 0, size, size);
      ctx.drawImage(image, 0, 0, size, size);
      return canvas.toDataURL('image/png');
    } catch {
      return null;              // a project saves fine without its picture
    }
  }

  function projectName() {
    const name = $('kfProjectName').value.trim();
    if (!name) throw new Error('Give the keyfob project a name first.');
    if (!PROJECT_NAME.test(name)) throw new Error('A project name may use letters, digits, spaces, . _ and -.');
    return name;
  }

  $('kfSave').onclick = async () => {
    if (!result) return;
    try {
      const name = projectName();
      say('Saving to the server…');
      const response = await fetch(`/api/projects/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...(await buildProject()), thumbnail: await thumbnail() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? response.statusText);
      await refreshShelf();
      say(`Saved "${name}" on the server.`);
    } catch (error) {
      say(error.message || String(error), true);
    }
  };
  $('kfSaveFile').onclick = async () => {
    if (!result) return;
    const name = $('kfProjectName').value.trim() || projectNameFor(subject.name);
    saveBlob(new TextEncoder().encode(JSON.stringify(await buildProject())), 'application/json', `${name}.v2sproj`);
    say(`Project saved to your downloads as ${name}.v2sproj.`);
  };

  /** Reopen a saved keyfob project. */
  async function restore(project, name = '') {
    reset();
    showScreen('keyfob');
    if (!project.drawing?.data) return say('That keyfob project has no subject in it.', true);
    restoreSettings(project.keyfob);
    $('kfProjectName').value = name;
    const file = Object.assign(new File([fromBase64(project.drawing.data)], project.drawing.name || 'subject.svg'),
      { resource: project.drawing.resource ?? null });
    await setSubject(file);
  }

  return {
    open() { reset(); showScreen('keyfob'); },
    setSubject,
    restore,
  };
}
