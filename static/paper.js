// Paper mode: a foldable paper model. An OpenSCAD template (paper_templates/)
// draws the net — a house by default, with plain walls — and SVG/DXF drawings
// are cut into its walls as decorations: their lines thickened into paper bars,
// what they enclose cut out. The server (tools/paper.py) builds the net; this
// screen edits the template's parameters, places and sizes the decorations on
// the net, folds the cut net in a small 3D view and saves it as a project.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  decorationCorners, decorationMatrix, emptiestWall, fitsA4, foldMatrices, geometryPath,
  placeAt, resizedWidth, snap, wallLocal, wallPoint, wallVector,
} from './paper-geometry.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const REBUILD_DELAY = 250;
const DEFAULT_THICKNESS = 2;
const HANDLE_PX = 5;
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const SVG_TRASH = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg>';

/** A file name turned into a project name the server accepts. */
export function projectNameFor(name) {
  const base = String(name || 'paper').replace(/\.[^.]+$/, '')
    .replace(/[^A-Za-z0-9 ._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 56).trim();
  return `${base || 'paper'} paper`;
}

export function initPaper({ $, showScreen, openPicker, saveBlob, libraryRemember,
  fileBase64, fromBase64, refreshShelf, projectFormat }) {
  let templates = null;      // from /api/paper/templates
  let template = null;       // the chosen one
  let params = {};           // its parameters as edited
  // { id, file, name, wall, x, y, width, rotation, thickness, mode ('frame' | 'drawn'),
  //   geometry (its cut-outs, from the server), lines (the drawing, for the thumbnail), basis, notes }
  let decorations = [];
  let selected = null;       // the selected decoration's id
  let result = null;         // the last /api/paper answer
  let view = null, userView = false, drag = null;
  let timer = 0, request = 0, controller = null, nextId = 1;

  const svg = $('ppNet');
  const sheet = document.createElementNS(SVG_NS, 'g');
  const overlay = document.createElementNS(SVG_NS, 'g');
  svg.append(sheet, overlay);

  function say(text, error = false) {
    $('ppStatus').textContent = text;
    $('ppStatus').classList.toggle('error', error);
  }

  const find = (id) => decorations.find((d) => d.id === id);
  const walls = () => result?.walls ?? [];

  /* -------------------------------------------------------------- build */

  function schedule(delay = REBUILD_DELAY) {
    clearTimeout(timer);
    if (template) timer = setTimeout(build, delay);
  }

  /** The geometry a decoration can reuse: only while its size, line and mode are unchanged. */
  const reusable = (d) => d.geometry && d.basis
    && d.basis.width === d.width && d.basis.thickness === d.thickness && d.basis.mode === d.mode;

  async function build() {
    clearTimeout(timer);
    if (!template) return;
    const id = ++request;
    controller?.abort();
    controller = new AbortController();
    const form = new FormData();
    const sent = decorations.map((d) => ({ ...d }));
    form.append('job', JSON.stringify({
      template: template.id, params,
      decorations: sent.map((d) => ({
        name: d.name, wall: d.wall, x: d.x, y: d.y, width: d.width, rotation: d.rotation,
        thickness: d.thickness, mode: d.mode, geometry: reusable(d) ? d.geometry : null,
      })),
    }));
    sent.forEach((d, i) => { if (!reusable(d)) form.append(`decoration-${i}`, d.file); });
    $('ppNetBox').setAttribute('aria-busy', 'true');
    say('Building the net…');
    try {
      const response = await fetch('/api/paper', { method: 'POST', body: form, signal: controller.signal });
      const data = await response.json();
      if (id !== request) return;
      if (!response.ok) throw new Error(data.error || 'Could not build the net.');
      const fresh = !result;
      result = data;
      // What the server settled: a new decoration's place and size, and everyone's cut-outs.
      // Only what was left to the server: anything edited meanwhile (or being
      // dragged right now) stays as it is, and its next build follows.
      data.decorations.forEach((answer, i) => {
        const d = find(sent[i].id);
        if (!d) return;
        for (const key of ['x', 'y', 'width']) if (sent[i][key] === null && d[key] === null) d[key] = answer[key];
        if (d.wall === sent[i].wall && drag?.id !== d.id) d.wall = answer.wall;
        // The drawing's lines only come with freshly made geometry; they never go back.
        const { lines, ...geometry } = answer.geometry;
        Object.assign(d, { geometry, notes: answer.notes,
          basis: { width: answer.width, thickness: answer.thickness, mode: answer.mode } });
        if (lines) d.lines = lines;
      });
      showSelected();
      render(fresh);
      folded.show(data);
      describe();
    } catch (error) {
      if (error.name === 'AbortError' || id !== request) return;
      say(error.message || String(error), true);
    } finally {
      if (id === request) $('ppNetBox').setAttribute('aria-busy', 'false');
      updateButtons();
    }
  }

  function updateButtons() {
    for (const id of ['ppDownload', 'ppSave', 'ppSaveFile']) $(id).disabled = !result;
  }

  function describe() {
    const i = result.info;
    const parts = [`Net ${i.width.toFixed(0)} × ${i.height.toFixed(0)} mm`
      + (fitsA4(i.width, i.height) ? ' (fits A4)' : ' (larger than A4)'),
      `${i.cutouts} cut-out${i.cutouts === 1 ? '' : 's'}`];
    if (i.slits) parts.push(`${i.slits} fold slits`);
    say(parts.join(' · ') + (i.notes.length ? `. Note: ${i.notes.join('; ')}.` : '.'));
    renderList();
  }

  /* ----------------------------------------------------------- the net */

  function element(tag, attributes, parent) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    parent?.append(node);
    return node;
  }

  function render(fresh) {
    sheet.replaceChildren();
    element('path', { d: result.net, class: 'pp-paper', 'fill-rule': 'evenodd' }, sheet);
    element('path', { d: result.area, class: 'pp-area' }, sheet);
    // A template either scores its folds (their own layer) or perforates them
    // with slits, single cuts along the fold, which then are the fold marks.
    if (result.foldLayer) element('path', { d: result.folds, class: 'pp-fold' }, sheet);
    element('path', { d: result.slits, class: 'pp-slit' }, sheet);
    $('ppFoldKey').textContent = result.foldLayer ? 'fold (score)' : 'fold (perforated: slits in the cut)';
    $('ppFoldKey').classList.toggle('perforated', !result.foldLayer);
    walls().forEach((wall, i) => {
      // The wall's number, just above its floor fold, upright as seen from outside.
      const at = wallPoint(wall, [wall.size[0] / 2, Math.min(4, wall.size[1] / 4)]);
      const angle = Math.atan2(wall.x[1], wall.x[0]) * 180 / Math.PI;
      element('text', { x: at[0], y: at[1], class: 'pp-wall-label',
        transform: `rotate(${angle} ${at[0]} ${at[1]})` }, sheet).textContent = `wall ${i + 1}`;
    });
    $('ppEmpty').hidden = true;
    if (fresh || !view) fit(false);
    paint();
  }

  /** The decorations over the net: their cut-outs, and the selected one's box and handles. */
  function drawDecorations() {
    overlay.replaceChildren();
    if (!result || !view) return;
    const px = mmPerPx();
    for (const d of decorations) {
      const wall = walls()[d.wall];
      if (!wall || !d.geometry) continue;
      const m = decorationMatrix(wall, d);
      const group = element('g', { 'data-id': d.id, class: `pp-deco${d.id === selected ? ' selected' : ''}`
        + (drag?.id === d.id && drag.kind !== 'pan' ? ' moving' : '') }, overlay);
      const h = d.geometry.aspect / 2;
      const inner = element('g', { transform: `matrix(${m.join(' ')})` }, group);
      element('rect', { x: -0.5, y: -h, width: 1, height: 2 * h, class: 'pp-deco-hit' }, inner);
      element('path', { d: geometryPath(d.geometry), class: 'pp-deco-cut', 'fill-rule': 'evenodd' }, inner);
      element('title', {}, group).textContent = `${d.name} — drag to move, drag a corner to resize`;
      if (d.id !== selected) continue;
      for (const [cx, cy] of decorationCorners(wall, d, d.geometry.aspect)) {
        const handle = element('rect', { x: cx - HANDLE_PX * px, y: cy - HANDLE_PX * px,
          width: 2 * HANDLE_PX * px, height: 2 * HANDLE_PX * px, class: 'pp-handle', 'data-handle': d.id }, overlay);
        handle.style.strokeWidth = `${1.5 * px}`;
      }
    }
  }

  function fit(user = true) {
    if (!result) return;
    view = [...result.view];
    userView = false;
    if (user) paint();
  }

  function paint() {
    if (!view) return;
    svg.setAttribute('viewBox', view.join(' '));
    const fitted = result ? Math.max(result.view[2] / view[2], result.view[3] / view[3]) : 1;
    $('ppZoom').textContent = `${Math.round(fitted * 100)}%`;
    for (const label of sheet.querySelectorAll('.pp-wall-label')) label.style.fontSize = `${11 * mmPerPx()}px`;
    drawDecorations();
  }

  function mmPerPx() {
    const box = svg.getBoundingClientRect();
    return Math.max(view[2] / Math.max(box.width, 1), view[3] / Math.max(box.height, 1));
  }

  function pointer(event) {
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM().inverse());
    return [p.x, p.y];
  }

  function zoomAt(factor, clientX, clientY) {
    if (!view) return;
    const [px, py] = clientX === undefined ? [view[0] + view[2] / 2, view[1] + view[3] / 2]
      : pointer({ clientX, clientY });
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
    const at = pointer(event);
    const handle = event.target.closest?.('[data-handle]');
    const deco = event.target.closest?.('[data-id]');
    if (handle) {
      const d = find(Number(handle.dataset.handle));
      const centre = wallPoint(walls()[d.wall], [d.x, d.y]);
      drag = { pointer: event.pointerId, kind: 'resize', id: d.id, centre, from: at, width: d.width, before: { ...d } };
    } else if (deco) {
      const d = find(Number(deco.dataset.id));
      select(d.id);
      const centre = wallPoint(walls()[d.wall], [d.x, d.y]);
      drag = { pointer: event.pointerId, kind: 'move', id: d.id, offset: [centre[0] - at[0], centre[1] - at[1]],
        before: { ...d }, moved: false };
    } else {
      drag = { pointer: event.pointerId, kind: 'pan', last: [event.clientX, event.clientY], moved: false };
      svg.classList.add('panning');
    }
    paint();
  });
  svg.addEventListener('pointermove', (event) => {
    if (drag?.pointer !== event.pointerId) return;
    if (drag.kind === 'pan') {
      const px = mmPerPx();
      view[0] -= (event.clientX - drag.last[0]) * px;
      view[1] -= (event.clientY - drag.last[1]) * px;
      drag.moved ||= Math.hypot(event.clientX - drag.last[0], event.clientY - drag.last[1]) > 0;
      drag.last = [event.clientX, event.clientY];
      userView = true;
      paint();
      return;
    }
    const d = find(drag.id);
    if (!d) return;
    const at = pointer(event);
    if (drag.kind === 'move') {
      Object.assign(d, placeAt(walls(), d.wall, [at[0] + drag.offset[0], at[1] + drag.offset[1]]));
      drag.moved = true;
    } else {
      d.width = resizedWidth(drag.width, drag.centre, drag.from, at);
    }
    drawDecorations();
    showSelected();
  });
  const endDrag = (event) => {
    if (drag?.pointer !== event.pointerId) return;
    const done = drag;
    drag = null;
    svg.classList.remove('panning');
    if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
    if (done.kind === 'pan') {
      if (!done.moved && event.type === 'pointerup') select(null);
      return paint();
    }
    const d = find(done.id);
    if (d && event.type === 'pointercancel') Object.assign(d, done.before);
    else if (d && ['wall', 'x', 'y', 'width'].some((key) => d[key] !== done.before[key])) build();
    paint();
    showSelected();
  };
  for (const type of ['pointerup', 'pointercancel']) svg.addEventListener(type, endDrag);
  svg.addEventListener('dblclick', (event) => { if (!event.target.closest?.('[data-id]')) fit(); });
  svg.addEventListener('keydown', (event) => {
    const d = find(selected);
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (d && arrows[event.key] && walls()[d.wall]) {
      // Nudge on screen: 0.5 mm, Shift 5 mm.
      const step = event.shiftKey ? 5 : 0.5;
      const [dx, dy] = wallVector(walls()[d.wall], arrows[event.key].map((v) => v * step));
      Object.assign(d, placeAt(walls(), d.wall, wallPoint(walls()[d.wall], [d.x + dx, d.y + dy])));
      drawDecorations();
      showSelected();
      schedule();
    } else if (d && ['Delete', 'Backspace'].includes(event.key)) remove(d.id);
    else if (event.key === 'Escape') select(null);
    else if (['+', '='].includes(event.key)) zoomAt(1.4);
    else if (event.key === '-') zoomAt(1 / 1.4);
    else if (['0', 'Home'].includes(event.key)) fit();
    else return;
    event.preventDefault();
  });
  new ResizeObserver(() => paint()).observe(svg);
  $('ppZoomIn').onclick = () => zoomAt(1.4);
  $('ppZoomOut').onclick = () => zoomAt(1 / 1.4);
  $('ppFit').onclick = () => fit();

  /* -------------------------------------------------------- decorations */

  function select(id) {
    selected = id;
    renderList();
    showSelected();
    drawDecorations();
  }

  async function addDecoration(file) {
    if (!/\.(svg|dxf)$/i.test(file?.name ?? '')) return say('A decoration must be an .svg or .dxf file.', true);
    const d = { id: nextId++, file, name: file.name, wall: emptiestWall(walls().length || 4, decorations),
      x: null, y: null, width: null, rotation: 0, thickness: DEFAULT_THICKNESS, mode: 'frame',
      geometry: null, lines: null, basis: null, notes: [] };
    decorations.push(d);
    selected = d.id;
    renderList();
    showSelected();
    if (!$('ppProjectName').value.trim() && template) $('ppProjectName').value = projectNameFor(template.name);
    await build();
  }

  /**
   * A copy of a decoration — same drawing, size, turn, thickness and cut — on
   * the wall with the fewest, at the same place; beside the original when that
   * is its own wall. Its cut-outs are the original's, so nothing is re-read.
   */
  function clone(id) {
    const source = find(id);
    if (!source) return;
    const copy = { ...source, id: nextId++, notes: [] };
    copy.wall = emptiestWall(walls().length || 4, decorations);
    const wall = walls()[copy.wall];
    if (wall && source.x !== null && source.y !== null) {
      const x = copy.wall === source.wall ? source.x + (source.width ?? 0) + 2 : source.x;
      copy.x = snap(Math.min(Math.max(x, 0), wall.size[0]));
      copy.y = snap(Math.min(Math.max(source.y, 0), wall.size[1]));
    }
    decorations.splice(decorations.indexOf(source) + 1, 0, copy);
    select(copy.id);
    schedule(0);
  }

  function remove(id) {
    decorations = decorations.filter((d) => d.id !== id);
    if (selected === id) selected = null;
    renderList();
    showSelected();
    drawDecorations();
    schedule(0);
  }

  /**
   * One card per decoration, kept across rebuilds so a field being typed in
   * keeps its focus: a thumbnail of the drawing with what it cuts out, whether
   * it is a frame cutout (its lines thickened into paper bars) or already the
   * cutout itself, the bar thickness, clone and remove.
   */
  const cards = new Map();
  function renderList() {
    const list = $('ppDecoList');
    $('ppDecoEmpty').hidden = decorations.length > 0;
    for (const [id, card] of cards) if (!find(id)) { card.root.remove(); cards.delete(id); }
    decorations.forEach((d, i) => {
      const card = cards.get(d.id) ?? createCard(d);
      card.root.setAttribute('aria-selected', String(d.id === selected));
      card.name.textContent = (d.notes?.length ? '⚠ ' : '') + d.name;
      card.name.title = d.notes?.length ? `${d.name}: ${d.notes.join('; ')}` : `${d.name} · wall ${d.wall + 1}`;
      card.frame.checked = d.mode === 'frame';
      if (document.activeElement !== card.thickness) card.thickness.value = d.thickness;
      for (const control of [card.minus, card.thickness, card.plus]) control.disabled = d.mode !== 'frame';
      if (card.drawn !== d.geometry || card.drawnLines !== d.lines) drawThumbnail(card, d);
      // Moving a card in the DOM would blur its fields, so only new or reordered cards move.
      if (list.children[i] !== card.root) list.insertBefore(card.root, list.children[i] ?? null);
    });
  }

  function createCard(d) {
    const make = (tag, props = {}) => Object.assign(document.createElement(tag), props);
    const card = {
      root: make('div', { className: 'pp-deco-card' }),
      thumb: make('button', { className: 'pp-thumb', title: 'Select it on the net', onclick: () => select(d.id) }),
      name: make('div', { className: 'pp-deco-name' }),
      frame: make('input', { type: 'checkbox' }),
      thickness: make('input', { type: 'number', min: '0.2', step: '0.5',
        title: 'Paper bar thickness (mm): the drawing\'s lines are thickened to this before what they enclose is cut out' }),
      minus: make('button', { className: 'ghost', textContent: '−', title: 'Thinner paper bars (0.5 mm less)' }),
      plus: make('button', { className: 'ghost', textContent: '+', title: 'Thicker paper bars (0.5 mm more)' }),
      clone: make('button', { className: 'ghost pp-clone', textContent: 'clone +',
        title: 'Add a copy — on the wall with the fewest decorations, at the same place', onclick: () => clone(d.id) }),
      remove: make('button', { className: 'ghost pp-trash', innerHTML: SVG_TRASH, title: `Remove ${d.name}`,
        onclick: () => remove(d.id) }),
    };
    card.svg = document.createElementNS(SVG_NS, 'svg');
    card.svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    card.thumb.append(card.svg);
    card.thumb.setAttribute('aria-label', `Select ${d.name}`);
    card.remove.setAttribute('aria-label', `Remove ${d.name}`);
    card.thickness.setAttribute('aria-label', `${d.name} paper bar thickness in mm`);
    const frameLabel = make('label', { className: 'check pp-frame-check',
      title: 'On: the drawing\'s lines become paper bars and only what they enclose is cut out. '
        + 'Off: the drawing already is the cutout — every closed outline is cut out as drawn.' });
    frameLabel.append(card.frame, ' frame cutout');
    card.frame.onchange = () => {
      d.mode = card.frame.checked ? 'frame' : 'drawn';
      renderList();
      schedule(0);
    };
    const setThickness = (value, typed = false) => {
      if (!(value > 0)) return;
      d.thickness = snap(value, 0.01);
      if (!typed) card.thickness.value = d.thickness;
      schedule();
    };
    card.minus.onclick = () => setThickness(Math.max(0.2, d.thickness - 0.5));
    card.plus.onclick = () => setThickness(d.thickness + 0.5);
    card.thickness.oninput = () => setThickness(Number(card.thickness.value), true);
    const bars = make('div', { className: 'pp-bars' });
    bars.append(card.thickness, card.minus, card.plus);
    const controls = make('div', { className: 'pp-deco-controls' });
    controls.append(card.name, frameLabel, bars, card.clone);
    card.root.append(card.thumb, controls, card.remove);
    cards.set(d.id, card);
    return card;
  }

  /** The drawing as loaded, with what it cuts out of the paper filled in. */
  function drawThumbnail(card, d) {
    card.drawn = d.geometry;
    card.drawnLines = d.lines;
    card.svg.replaceChildren();
    card.thumb.classList.toggle('pending', !d.geometry);
    if (!d.geometry) return;
    const h = d.geometry.aspect / 2, pad = 0.06 * Math.max(1, 2 * h);
    card.svg.setAttribute('viewBox', `${-0.5 - pad} ${-h - pad} ${1 + 2 * pad} ${2 * h + 2 * pad}`);
    const flip = element('g', { transform: 'scale(1 -1)' }, card.svg);    // the geometry is y up
    element('path', { d: geometryPath(d.geometry), class: 'pp-thumb-cut', 'fill-rule': 'evenodd' }, flip);
    const lines = (d.lines ?? []).map((line) => line.map(([x, y], n) => `${n ? 'L' : 'M'}${x} ${y}`).join(' ')).join(' ');
    if (lines) element('path', { d: lines, class: 'pp-thumb-line' }, flip);
  }

  /** The selected decoration's own fields. */
  function showSelected() {
    const d = find(selected);
    $('ppSelected').hidden = !d;
    if (!d) return;
    $('ppSelName').textContent = d.name;
    const wallSelect = $('ppSelWall');
    const count = Math.max(walls().length, d.wall + 1, 1);
    if (wallSelect.options.length !== count) {
      wallSelect.replaceChildren(...Array.from({ length: count }, (_, i) => new Option(`Wall ${i + 1}`, i)));
    }
    wallSelect.value = d.wall;
    for (const [id, key] of [['ppSelX', 'x'], ['ppSelY', 'y'], ['ppSelWidth', 'width'], ['ppSelRotation', 'rotation']]) {
      if (document.activeElement !== $(id)) $(id).value = d[key] ?? '';
    }
    $('ppSelNotes').textContent = d.notes?.length ? `Note: ${d.notes.join('; ')}.` : '';
  }

  $('ppSelWall').onchange = () => {
    const d = find(selected);
    const wall = walls()[Number($('ppSelWall').value)];
    if (!d || !wall) return;
    // Keep it at the same place on its new wall, as far as that wall reaches.
    Object.assign(d, { wall: Number($('ppSelWall').value),
      x: snap(Math.min(d.x, wall.size[0])), y: snap(Math.min(d.y, wall.size[1])) });
    drawDecorations();
    schedule(0);
  };
  for (const [id, key, low] of [['ppSelX', 'x', -1e6], ['ppSelY', 'y', -1e6], ['ppSelWidth', 'width', 1], ['ppSelRotation', 'rotation', -1e6]]) {
    $(id).addEventListener('input', () => {
      const d = find(selected), value = Number($(id).value);
      if (!d || $(id).value === '' || !Number.isFinite(value) || value < low) return;
      d[key] = value;
      drawDecorations();
      schedule();
    });
  }
  for (const button of document.querySelectorAll('#ppSelected [data-turn]')) {
    button.onclick = () => {
      const d = find(selected);
      if (!d) return;
      d.rotation = ((d.rotation + Number(button.dataset.turn)) % 360 + 360) % 360;
      showSelected();
      drawDecorations();
      schedule();
    };
  }

  /* ---------------------------------------------------------- templates */

  async function loadTemplates() {
    if (templates) return templates;
    const response = await fetch('/api/paper/templates');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not list the paper templates.');
    templates = data.templates;
    $('ppTemplate').replaceChildren(...templates.map((t) => new Option(t.name, t.id)));
    return templates;
  }

  function chooseTemplate(id, saved = {}) {
    template = templates.find((t) => t.id === id) ?? templates[0] ?? null;
    if (!template) return say('There are no paper templates in paper_templates/.', true);
    $('ppTemplate').value = template.id;
    $('ppTemplateNote').textContent = template.description;
    params = {};
    for (const p of template.parameters) {
      const value = saved[p.name];
      if (value !== undefined && typeof value === typeof p.default
        && (!p.options || p.options.some((o) => o.value === value))) params[p.name] = value;
    }
    renderParams();
  }

  /** One fieldset per Customizer group, each parameter in the input its annotation asks for. */
  function renderParams() {
    const host = $('ppParams');
    host.replaceChildren();
    const groups = new Map();
    for (const p of template.parameters) {
      if (!groups.has(p.group)) {
        const fieldset = document.createElement('fieldset');
        fieldset.append(Object.assign(document.createElement('legend'), { textContent: p.group }));
        groups.set(p.group, fieldset);
        host.append(fieldset);
      }
      const value = params[p.name] ?? p.default;
      const label = document.createElement('label');
      label.title = p.description || p.label;
      let input;
      if (p.options) {
        input = document.createElement('select');
        input.append(...p.options.map((o) => new Option(o.label, String(o.value))));
        input.value = String(value);
        input.onchange = () => {
          const option = p.options.find((o) => String(o.value) === input.value);
          setParam(p, option.value);
        };
      } else if (p.type === 'boolean') {
        label.className = 'check';
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!value;
        input.onchange = () => setParam(p, input.checked);
      } else {
        input = document.createElement('input');
        input.type = p.type === 'number' ? 'number' : 'text';
        if (p.min !== undefined) input.min = p.min;
        if (p.max !== undefined) input.max = p.max;
        input.step = p.step ?? 'any';
        input.value = value;
        input.oninput = () => {
          if (p.type !== 'number') return setParam(p, input.value);
          if (input.value !== '' && Number.isFinite(Number(input.value))) setParam(p, Number(input.value));
        };
      }
      input.dataset.param = p.name;
      if (p.type === 'boolean') label.append(input, ` ${p.label}`);
      else label.append(p.label, input);
      groups.get(p.group).append(label);
    }
  }

  function setParam(p, value) {
    if (value === p.default) delete params[p.name];
    else params[p.name] = value;
    schedule();
  }

  $('ppTemplate').onchange = () => {
    chooseTemplate($('ppTemplate').value);
    result = null;
    view = null;
    folded.clear();
    schedule(0);
  };
  $('ppResetParams').onclick = () => {
    params = {};
    renderParams();
    schedule(0);
  };

  /* ------------------------------------------------------------ 3D view */

  const folded = (() => {
    const canvas = $('pp3d');
    let renderer = null, scene, camera, controls, model, faces = [], meshes = [], fresh = true, net = null;
    // Which side of a flat face is the outside depends on the template (netTop).
    const outside = new THREE.MeshStandardMaterial({ color: 0xf1e6d2, roughness: 0.9 });
    const insideFace = new THREE.MeshStandardMaterial({ color: 0xc9b597, roughness: 0.95 });
    const edges = new THREE.LineBasicMaterial({ color: 0x6b5232 });

    function setup() {
      if (renderer) return true;
      try {
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
      } catch {
        $('pp3dBox').hidden = true;      // no WebGL: the net is all there is
        return false;
      }
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(35, 1, 1, 5000);
      controls = new OrbitControls(camera, canvas);
      controls.enableDamping = false;
      controls.addEventListener('change', draw);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x50463a, 1.6));
      const sun = new THREE.DirectionalLight(0xffffff, 1.6);
      sun.position.set(1, 2, 1.5);
      scene.add(sun);
      // A candle inside: the cut-outs glow.
      scene.userData.candle = new THREE.PointLight(0xffb45a, 40, 0, 1.2);
      scene.add(scene.userData.candle);
      model = new THREE.Group();
      scene.add(model);
      new ResizeObserver(resize).observe(canvas);
      return true;
    }

    function resize() {
      const { width, height } = canvas.getBoundingClientRect();
      if (!renderer || width < 1 || height < 1) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      draw();
    }

    function draw() {
      if (renderer) renderer.render(scene, camera);
    }

    /** Fold the net of a /api/paper answer: its faces, which side is the outside, which way is up. */
    function show(answer) {
      if (!setup()) return;
      for (const mesh of meshes) mesh.traverse((o) => o.geometry?.dispose());
      model.clear();
      net = answer;
      faces = answer.faces;
      // A flat face's normal is the net's top face: the inside for the house, the outside for others.
      const insideUp = answer.netTop !== 'outside';
      outside.side = insideUp ? THREE.BackSide : THREE.FrontSide;
      insideFace.side = insideUp ? THREE.FrontSide : THREE.BackSide;
      outside.needsUpdate = insideFace.needsUpdate = true;
      // The template's up (the house's normal to its floor, or a wall's own up) becomes three's y.
      model.quaternion.setFromUnitVectors(new THREE.Vector3(...answer.up).normalize(), new THREE.Vector3(0, 1, 0));
      meshes = faces.map((face) => {
        const shape = new THREE.Shape(face.rings[0].map(([x, y]) => new THREE.Vector2(x, y)));
        shape.holes = face.rings.slice(1).map((ring) => new THREE.Path(ring.map(([x, y]) => new THREE.Vector2(x, y))));
        const geometry = new THREE.ShapeGeometry(shape);
        const group = new THREE.Group();
        group.matrixAutoUpdate = false;
        group.add(new THREE.Mesh(geometry, outside), new THREE.Mesh(geometry, insideFace),
          new THREE.LineSegments(new THREE.EdgesGeometry(geometry), edges));
        model.add(group);
        return group;
      });
      fold();
      if (fresh) frame();
      fresh = false;
      resize();
    }

    function fold() {
      const progress = Number($('ppFold').value) / 100;
      foldMatrices(faces, progress).forEach((m, i) => meshes[i].matrix.fromArray(m));
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      if (!box.isEmpty()) {
        const centre = box.getCenter(new THREE.Vector3());
        scene.userData.candle.position.set(centre.x, box.min.y + (box.max.y - box.min.y) * 0.35, centre.z);
      }
      draw();
    }

    /** Look at wall 1 of the folded model from outside, a little to the right and above. */
    function frame() {
      const saved = $('ppFold').value;
      $('ppFold').value = 100;
      const matrices = foldMatrices(faces, 1);
      matrices.forEach((m, i) => meshes[i].matrix.fromArray(m));
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      $('ppFold').value = saved;
      if (box.isEmpty()) return;
      const centre = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()).length();
      camera.near = size / 100;
      camera.far = size * 20;
      const up = new THREE.Vector3(0, 1, 0);
      const front = new THREE.Vector3(0, 0, 1);
      const wall = net.walls?.[0]?.face;
      if (matrices[wall]) {
        // Wall 1's normal is the net's top face turned with it; outward is away from the inside.
        front.set(0, 0, 1).transformDirection(new THREE.Matrix4().fromArray(matrices[wall]))
          .applyQuaternion(model.quaternion).multiplyScalar(net.netTop === 'outside' ? 1 : -1);
        front.addScaledVector(up, -front.dot(up));
        if (front.lengthSq() < 1e-6) front.set(0, 0, 1);
      }
      front.normalize();
      const right = new THREE.Vector3().crossVectors(up, front);
      const direction = front.clone().addScaledVector(up, 0.45).addScaledVector(right, 0.5).normalize();
      camera.position.copy(centre).addScaledVector(direction, size * 1.6);
      controls.target.copy(centre);
      controls.update();
      camera.updateProjectionMatrix();
      fold();
    }

    $('ppFold').addEventListener('input', () => {
      $('ppFoldValue').textContent = `${$('ppFold').value}%`;
      fold();
    });
    $('pp3dReset').onclick = () => { if (faces.length) frame(); };
    $('pp3dToggle').onclick = () => {
      const big = $('pp3dBox').classList.toggle('large');
      $('pp3dToggle').textContent = big ? '⤡' : '⤢';
      $('pp3dToggle').title = big ? 'Make the 3D view small again' : 'Make the 3D view larger';
      requestAnimationFrame(resize);
    };
    return { show, clear() { fresh = true; if (model) { model.clear(); draw(); } } };
  })();

  /* ------------------------------------------------------------ files */

  $('ppAdd').onclick = () => $('ppFile').click();
  $('ppEmptyAdd').onclick = () => $('ppFile').click();
  $('ppFile').onchange = async (event) => {
    const files = [...event.target.files];
    event.target.value = '';
    for (const file of files) {
      libraryRemember(file);          // an upload stays reusable from the library
      await addDecoration(file);
    }
  };
  $('ppLibrary').onclick = () => openPicker('paper');
  $('ppBack').onclick = () => showScreen('start');
  $('ppDownload').onclick = () => {
    if (!result) return;
    const name = $('ppProjectName').value.trim() || projectNameFor(template?.name);
    saveBlob(result.svg, 'image/svg+xml', `${name}.svg`);
  };

  /* ---------------------------------------------------------- project */

  async function buildProject() {
    return {
      format: projectFormat, version: 1, saved: new Date().toISOString(), workflow: 'paper',
      paper: {
        template: template.id, params,
        decorations: await Promise.all(decorations.map(async (d) => ({
          name: d.name, data: await fileBase64(d.file), resource: d.file.resource ?? null,
          wall: d.wall, x: d.x, y: d.y, width: d.width, rotation: d.rotation,
          thickness: d.thickness, mode: d.mode,
        }))),
      },
    };
  }

  /** The net on paper, for the project tile on Start. */
  async function thumbnail() {
    try {
      const size = 320;
      const root = new DOMParser().parseFromString(result.svg, 'image/svg+xml').documentElement;
      const line = Math.max(result.view[2], result.view[3]) / size * 1.5;
      for (const group of root.querySelectorAll('g')) group.setAttribute('stroke-width', line);
      root.querySelector('[id="cut"]')?.setAttribute('fill', '#ead7c3');
      root.querySelector('[id="cut"]')?.setAttribute('fill-rule', 'evenodd');
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
    const name = $('ppProjectName').value.trim();
    if (!name) throw new Error('Give the paper project a name first.');
    if (!PROJECT_NAME.test(name)) throw new Error('A project name may use letters, digits, spaces, . _ and -.');
    return name;
  }

  $('ppSave').onclick = async () => {
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
  $('ppSaveFile').onclick = async () => {
    if (!result) return;
    const name = $('ppProjectName').value.trim() || projectNameFor(template?.name);
    saveBlob(new TextEncoder().encode(JSON.stringify(await buildProject())), 'application/json', `${name}.v2sproj`);
    say(`Project saved to your downloads as ${name}.v2sproj.`);
  };

  /** Everything back to a fresh, undecorated default template. */
  function reset() {
    clearTimeout(timer);
    request++;
    controller?.abort();
    decorations = [];
    selected = result = view = null;
    userView = false;
    sheet.replaceChildren();
    overlay.replaceChildren();
    folded.clear();
    $('ppProjectName').value = '';
    $('ppEmpty').hidden = false;
    $('ppNetBox').setAttribute('aria-busy', 'false');
    $('ppFold').value = 100;
    $('ppFoldValue').textContent = '100%';
    renderList();
    showSelected();
    updateButtons();
  }

  async function start(templateId, saved, name = '') {
    reset();
    showScreen('paper');
    try {
      await loadTemplates();
    } catch (error) {
      return say(error.message || String(error), true);
    }
    chooseTemplate(templateId, saved);
    $('ppProjectName').value = name;
  }

  return {
    async open() {
      await start(templates?.[0]?.id, {});
      await build();
    },
    async addDecoration(file) {
      if (!template) await start(templates?.[0]?.id, {});
      await addDecoration(file);
    },
    /** Reopen a saved paper project. */
    async restore(project, name = '') {
      const saved = project.paper ?? {};
      await start(saved.template, saved.params ?? {}, name);
      if (saved.template && template?.id !== saved.template) {
        say(`The template ${saved.template} is gone; using ${template?.name} instead.`, true);
      }
      for (const raw of saved.decorations ?? []) {
        if (!raw?.data) continue;
        const file = Object.assign(new File([fromBase64(raw.data)], raw.name || 'decoration.svg'),
          { resource: raw.resource ?? null });
        const number = (v, fallback = null) => Number.isFinite(Number(v)) && v !== null ? Number(v) : fallback;
        decorations.push({ id: nextId++, file, name: file.name, wall: number(raw.wall, 0),
          x: number(raw.x), y: number(raw.y), width: number(raw.width), rotation: number(raw.rotation, 0),
          thickness: number(raw.thickness, DEFAULT_THICKNESS),
          // Older paper projects called a drawn cutout a "silhouette".
          mode: ['drawn', 'silhouette'].includes(raw.mode) ? 'drawn' : 'frame',
          geometry: null, lines: null, basis: null, notes: [] });
      }
      renderList();
      await build();
    },
  };
}
