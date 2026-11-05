import * as G from './path-editor-geometry.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const round = value => Number(value.toFixed(4));
const COLORS = { path: '#60a5fa', chosen: '#fbbf24', fixed: '#64748b', ghost: '#3b4b63', end: '#cbd5e1',
  joined: '#34d399', bend: '#f59e0b', control: '#f472b6' };
const SVG_NS = 'http://www.w3.org/2000/svg';
const HIDDEN = 'defs, clipPath, mask, symbol, marker, pattern, metadata';
const NAMES = { line: 'Line', arc: 'Arc', circle: 'Circle', path: 'Path', polyline: 'Polyline', polygon: 'Polygon' };

/**
 * Small edits to a subject's own paths, inside the source inspector: drag a
 * DXF line or arc end to extend or shorten it along its own line or circle
 * (Shift: anywhere), bend an arc by its middle, move or resize a circle, or
 * drag an SVG path's points and curve handles. Selected paths move whole by
 * dragging them or with the arrow keys, and every field can be typed. Ends
 * that touch another path stay joined while "Keep joined ends together" is
 * on. `onApply(file, {count, shifts})` receives the edited copy of the file
 * and how far its moved ends went, in the converter's millimetres-before-
 * scale (y up); `onClose()` leaves the editor.
 */
export class PathEditor {
  constructor(host, { onApply, onClose }) {
    this.onApply = onApply; this.onClose = onClose;
    const root = this.root = document.createElement('div');
    root.className = 'profile-editor path-editor';
    root.hidden = true;
    root.innerHTML = `<div class="profile-editor-stage"><canvas tabindex="0" role="group" aria-label="Subject paths. Click a path to select it, drag its handles to edit it, drag the path to move it. Arrow keys move the selection by 0.1, with Shift by 1. Scroll to zoom, drag empty space to pan."></canvas></div>
      <div class="profile-editor-view">
        <button type="button" class="ghost" data-action="out" aria-label="Zoom out">−</button>
        <button type="button" class="ghost" data-action="in" aria-label="Zoom in">+</button>
        <button type="button" class="ghost" data-action="fit">Fit all</button>
        <button type="button" class="ghost" data-action="undo" title="Undo (Ctrl+Z)">Undo</button>
        <label class="check tip-editor-symmetry" title="An end that touches another path takes that path's end along"><input type="checkbox" data-option="joined" checked> Keep joined ends together</label>
        <span data-legend></span>
      </div>
      <p class="profile-editor-status" role="status"></p>
      <div class="profile-editor-fields"></div>
      <p class="profile-editor-help"></p>
      <div class="tip-editor-actions">
        <button type="button" class="ghost" data-action="reset">Reset</button>
        <button type="button" class="ghost" data-action="cancel">Back to preview</button>
        <button type="button" data-action="apply">Apply to subject</button>
      </div>`;
    host.append(root);
    this.canvas = root.querySelector('canvas'); this.ctx = this.canvas.getContext('2d');
    this.stage = root.querySelector('.profile-editor-stage');
    this.status = root.querySelector('.profile-editor-status');
    this.fields = root.querySelector('.profile-editor-fields');
    this.joined = root.querySelector('[data-option="joined"]');
    this.shapes = new WeakMap();
    root.addEventListener('click', event => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (action === 'fit') this.fit();
      if (action === 'in' || action === 'out') this.zoom(action === 'in' ? 1.4 : 1 / 1.4);
      if (action === 'undo') this.undo();
      if (action === 'reset' && this.original) { this.commitChange(this.original); this.note = 'Back to the subject as loaded.'; this.render(); }
      if (action === 'cancel') this.leave();
      if (action === 'apply') this.commit();
    });
    this.fields.addEventListener('change', event => this.editField(event.target));
    this.canvas.addEventListener('pointerdown', event => this.pointerDown(event));
    this.canvas.addEventListener('pointermove', event => this.pointerMove(event));
    this.canvas.addEventListener('pointerup', event => this.endGesture(event, false));
    for (const type of ['pointercancel', 'lostpointercapture']) this.canvas.addEventListener(type, event => this.endGesture(event, true));
    this.canvas.addEventListener('wheel', event => {
      if (!this.view) return;
      event.preventDefault();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.height : 1);
      this.zoom(Math.exp(-clamp(delta, -200, 200) * .005), this.pixel(event));
    }, { passive: false });
    this.canvas.addEventListener('keydown', event => this.key(event));
    root.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && event.target.tagName !== 'INPUT') {
        event.preventDefault(); this.undo();
      }
    });
    new ResizeObserver(() => { if (!this.root.hidden) { if (!this.view) this.fit(); else this.render(); } }).observe(this.stage);
  }

  get dirty() { return !!this.original && this.entities.some((e, i) => G.changed(this.original[i], e)); }

  /** Load `file`'s editable paths (a DXF through /api/sketch, an SVG here) and show the editor. */
  async open(file) {
    this.request?.abort();
    const request = this.request = new AbortController();
    Object.assign(this, { file, original: null, entities: [], fixed: [], view: null, selected: -1, point: null,
      gesture: null, history: [], error: '', note: 'Loading the subject’s paths…', svg: null });
    this.svgMode = /\.svg$/i.test(file.name);
    this.root.hidden = false;
    this.renderFields();
    this.render();
    try {
      if (this.svgMode) this.loadSvg(await file.text());
      else {
        const form = new FormData();
        form.set('file', file); form.set('sagitta', '0.025');
        const response = await fetch('/api/sketch', { method: 'POST', body: form, signal: request.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not read this subject’s paths.');
        if (request.signal.aborted) return;
        const { entities, fixed } = G.dxfEntities(data);
        this.load(entities, fixed);
        this.note = entities.length ? `${entities.length} editable lines, arcs and circles.`
          : 'Nothing to edit here: lines and arcs inside blocks or polylines stay as they are.';
      }
      this.fit();
      this.canvas.focus({ preventScroll: true });
    } catch (error) {
      if (request.signal.aborted) return;
      this.error = error.message || String(error); this.render();
    }
  }

  load(entities, fixed) {
    this.original = this.entities = entities; this.fixed = fixed;
    const [left, bottom, right, top] = G.bounds([...entities, ...fixed]);
    this.extent = Math.max(right - left, top - bottom) || 1;
    this.tolerance = this.extent * 1e-4;
    this.root.querySelector('[data-legend]').textContent = this.svgMode ? '● point · ■ curve handle' : '● end · ◆ bend · ■ centre or size';
    this.root.querySelector('.profile-editor-help').textContent = this.svgMode
      ? 'Click a path to select it, then drag its points (●); a selected point shows its curve handles (■). Drag the selected path to move it. Points that touch another path move together. Sizes are the SVG’s own user units, y downwards.'
      : 'Drag the end of a line or arc (●) to extend or shorten it along its own line or circle; hold Shift to move the end anywhere. Drag an arc’s middle (◆) to bend it, a circle’s centre or rim (■) to move or resize it, and a selected path to move it. Ends that touch another path take it along. Sizes are the DXF’s own units, before the model’s scale.';
  }

  /** Every path, polyline, polygon and line of an SVG; rects, circles and ellipses are shown for reference. */
  loadSvg(text) {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const root = doc.documentElement;
    if (doc.querySelector('parsererror') || root.localName !== 'svg') throw new Error('This SVG could not be read.');
    const entities = [], fixed = [], elements = [];
    let skipped = 0;
    for (const el of root.querySelectorAll('*')) {
      if (el.namespaceURI !== SVG_NS || el.closest(HIDDEN)) continue;
      const tag = el.localName, n = name => Number(el.getAttribute(name)) || 0;
      let segs, editable = true;
      try {
        if (tag === 'path') segs = G.parsePathData(el.getAttribute('d') ?? '');
        else if (tag === 'polyline' || tag === 'polygon') segs = G.pointSegments(el.getAttribute('points') ?? '', tag === 'polygon');
        else if (tag === 'line') segs = [{ cmd: 'M', p: [n('x1'), n('y1')] }, { cmd: 'L', p: [n('x2'), n('y2')] }];
        else if (tag === 'rect') {
          const x = n('x'), y = n('y'), w = n('width'), h = n('height');
          segs = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map((p, k) => ({ cmd: k ? 'L' : 'M', p }));
          segs.push({ cmd: 'Z' }); editable = false;
        } else if (tag === 'circle' || tag === 'ellipse') {
          const cx = n('cx'), cy = n('cy'), rx = tag === 'circle' ? n('r') : n('rx'), ry = tag === 'circle' ? n('r') : n('ry');
          const half = p => ({ cmd: 'A', rx, ry, rotation: 0, large: 1, sweep: 0, p });
          segs = [{ cmd: 'M', p: [cx - rx, cy] }, half([cx + rx, cy]), half([cx - rx, cy]), { cmd: 'Z' }];
          editable = false;
        } else continue;
        const m = G.elementMatrix(el, root);
        if (segs.length < 2 || !(G.stretch(m) > 0) || !(m[0] * m[3] - m[1] * m[2])) { skipped++; continue; }
        const entity = { kind: 'path', tag, m, segs };
        if (editable) { entities.push(entity); elements.push(el); } else fixed.push(entity);
      } catch { skipped++; }
    }
    this.svg = { doc, elements, prolog: text.match(/^\s*<\?xml[^>]*\?>\s*/)?.[0] ?? '', mm: G.svgMillimetres(root) };
    this.load(entities, fixed);
    this.note = (entities.length ? `${entities.length} editable paths.` : 'No paths, polylines or lines to edit in this SVG.')
      + (skipped ? ` ${skipped} could not be read and stay as they are.` : '');
  }

  /** Leave edit mode; unapplied edits need a yes first. */
  leave() {
    if (this.dirty && !confirm('Discard the path edits you have not applied?')) return false;
    this.close();
    this.onClose();
    return true;
  }

  close() {
    this.request?.abort();
    this.gesture = null;
    this.root.hidden = true;
  }

  /** Escape: a drag is cancelled first, then the editor is left. */
  escape() {
    if (this.gesture) { this.endGesture({ pointerId: this.gesture.id }, true); return; }
    this.leave();
  }

  commitChange(entities) {
    if (entities === this.entities) return;
    this.history.push(this.entities);
    if (this.history.length > 200) this.history.shift();
    this.entities = entities;
  }

  undo() {
    if (this.gesture || !this.history.length) return;
    this.entities = this.history.pop();
    this.note = 'Undone.';
    this.render();
  }

  async commit() {
    if (!this.original) { this.leave(); return; }
    const count = this.entities.filter((e, i) => G.changed(this.original[i], e)).length;
    if (!count) { this.close(); this.onClose(); return; }
    const reason = this.entities.map(e => G.invalid(e, this.extent)).find(Boolean);
    if (reason) { this.note = reason; this.render(); return; }
    const button = this.root.querySelector('[data-action="apply"]');
    button.disabled = true; this.note = 'Writing the edited paths into the subject…'; this.render();
    try {
      const file = this.svgMode ? this.writeSvg() : await this.writeDxf();
      // Model ends are y up, in millimetres before scale: the DXF's own units, or the SVG's at 96 dpi.
      const k = this.svgMode ? this.svg.mm : 1, shifts = [];
      for (const [from, to] of G.movedEnds(this.original, this.entities)) {
        const shift = [(to[0] - from[0]) * k, (to[1] - from[1]) * (this.svgMode ? -k : k)];
        if (!shifts.some(s => G.dist(s, shift) <= this.tolerance * k)) shifts.push(shift);
      }
      await this.onApply(file, { count, shifts });
      this.close();
      this.onClose();
    } catch (error) {
      this.note = String(error.message ?? error); this.render();
    } finally { button.disabled = false; }
  }

  async writeDxf() {
    const form = new FormData();
    form.append('file', this.file);
    form.append('edits', JSON.stringify(G.dxfEdits(this.original, this.entities)));
    const response = await fetch('/api/sketch/apply', { method: 'POST', body: form });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? response.statusText);
    return new File([await response.blob()], this.file.name, { type: 'application/dxf' });
  }

  writeSvg() {
    const { doc, elements, prolog } = this.svg;
    this.entities.forEach((e, i) => {
      if (!G.changed(this.original[i], e)) return;
      const el = elements[i];
      if (e.tag === 'path') el.setAttribute('d', G.formatPathData(e.segs));
      else if (e.tag === 'line') {
        const [a, b] = e.segs;
        for (const [name, value] of [['x1', a.p[0]], ['y1', a.p[1]], ['x2', b.p[0]], ['y2', b.p[1]]]) el.setAttribute(name, String(round(value)));
      } else el.setAttribute('points', G.formatPoints(e.segs));
    });
    return new File([prolog + new XMLSerializer().serializeToString(doc)], this.file.name, { type: 'image/svg+xml' });
  }

  /* --------------------------------------------------------------- view */

  fit() {
    const width = this.stage.clientWidth, height = this.stage.clientHeight;
    if (!this.original || !width || !height) { this.render(); return; }
    const [left, bottom, right, top] = G.bounds([...this.entities, ...this.fixed]);
    this.fitScale = Math.min((width - 64) / (right - left || 1), (height - 64) / (top - bottom || 1));
    this.view = { scale: this.fitScale, x: (left + right) / 2, y: (bottom + top) / 2 };
    this.render();
  }

  get flip() { return this.svgMode ? 1 : -1; }   // DXF y points up on screen, SVG y down
  pixel(event) { const box = this.canvas.getBoundingClientRect(); return { x: event.clientX - box.left, y: event.clientY - box.top }; }
  world(p) { return [(p.x - this.width / 2) / this.view.scale + this.view.x, this.flip * (p.y - this.height / 2) / this.view.scale + this.view.y]; }
  screen([x, y]) { return { x: (x - this.view.x) * this.view.scale + this.width / 2, y: this.height / 2 + this.flip * (y - this.view.y) * this.view.scale }; }
  matrix() {
    const { scale, x, y } = this.view;
    return new DOMMatrix([scale, 0, 0, this.flip * scale, this.width / 2 - x * scale, this.height / 2 - this.flip * y * scale]);
  }
  zoom(factor, point = { x: this.width / 2, y: this.height / 2 }) {
    if (!this.view || this.gesture) return;
    const before = this.world(point);
    this.view.scale = clamp(this.view.scale * factor, this.fitScale / 10, this.fitScale * 500);
    const after = this.world(point);
    this.view.x += before[0] - after[0]; this.view.y += before[1] - after[1];
    this.render();
  }

  /** The entity's outline in drawing coordinates, cached while it is unchanged. */
  shape(e) {
    let path = this.shapes.get(e);
    if (path) return path;
    path = new Path2D();
    if (e.kind === 'line') { path.moveTo(...e.a); path.lineTo(...e.b); }
    else if (e.kind === 'arc') path.arc(e.c[0], e.c[1], e.r, e.start, e.start + e.sweep);
    else if (e.kind === 'circle') path.arc(e.c[0], e.c[1], e.r, 0, 2 * Math.PI);
    else if (e.kind === 'polyline') e.points.forEach((p, k) => k ? path.lineTo(...p) : path.moveTo(...p));
    else path.addPath(new Path2D(G.formatPathData(e.segs)), new DOMMatrix(e.m));
    this.shapes.set(e, path);
    return path;
  }

  /* ----------------------------------------------------------- hit tests */

  /** The selected entity's handle under a pixel. */
  hitHandle(pixel) {
    const e = this.entities[this.selected];
    if (!e) return null;
    return G.handlesOf(e, this.point).map(h => ({ ...h, d: Math.hypot(this.screen(h.at).x - pixel.x, this.screen(h.at).y - pixel.y) }))
      .filter(h => h.d <= 9).sort((a, b) => a.d - b.d || (a.role === 'end' ? -1 : 1))[0] ?? null;
  }

  /** A DXF end under a pixel, the selected entity's first. */
  hitEnd(pixel) {
    if (this.svgMode) return null;
    let best = null;
    this.entities.forEach((e, index) => {
      for (const [key, at] of G.endsOf(e)) {
        const s = this.screen(at), d = Math.hypot(s.x - pixel.x, s.y - pixel.y) - (index === this.selected ? .5 : 0);
        if (d <= 8 && (!best || d < best.d)) best = { index, key, d };
      }
    });
    return best;
  }

  /** Every entity whose outline passes under a pixel, topmost last. */
  hitBodies(pixel) {
    const dpr = window.devicePixelRatio || 1, ctx = this.ctx;
    ctx.save();
    ctx.setTransform(new DOMMatrix([dpr, 0, 0, dpr, 0, 0]).multiply(this.matrix()));
    ctx.lineWidth = 12 / this.view.scale;
    const hits = this.entities.flatMap((e, i) => ctx.isPointInStroke(this.shape(e), pixel.x * dpr, pixel.y * dpr) ? [i] : []);
    ctx.restore();
    return hits;
  }

  /* ------------------------------------------------------------ gestures */

  select(index, point = null) {
    if (index !== this.selected) { this.selected = index; this.point = null; this.renderFields(); }
    if (point !== this.point && point?.startsWith('p:')) { this.point = point; this.renderFields(); }
  }

  /** The ends joined to entity `index`, for the ends named in `keys` (all when null). */
  joinsFor(index, keys = null) {
    return this.joined.checked ? G.joinsOf(this.entities, index, this.tolerance, keys) : new Map();
  }

  pointerDown(event) {
    if (!this.view || this.gesture || ![0, 1].includes(event.button)) return;
    event.preventDefault(); this.canvas.focus({ preventScroll: true });
    const pixel = this.pixel(event), base = { id: event.pointerId, pixel, start: this.entities };
    let gesture = { ...base, kind: 'pan', view: { ...this.view } };
    if (event.button === 0) {
      const handle = this.hitHandle(pixel), end = !handle && this.hitEnd(pixel);
      if (handle || end) {
        const index = handle ? this.selected : end.index, key = handle ? handle.key : end.key;
        this.select(index, key);
        // Only an end moves when its handle is dragged; bends, centres and controls carry no ends.
        const ends = new Set(G.endsOf(this.entities[index]).map(([k]) => k));
        gesture = { ...base, kind: 'handle', index, key, last: this.entities[index],
          joins: this.joinsFor(index, ends.has(key) ? [key] : []) };
      } else {
        const hits = this.hitBodies(pixel), again = hits.includes(this.selected);
        if (hits.length) {
          const index = again ? this.selected : hits[hits.length - 1];
          this.select(index);
          gesture = { ...base, kind: 'body', index, hits, again, origin: this.world(pixel), joins: this.joinsFor(index) };
        } else this.select(-1);
      }
    }
    this.gesture = gesture;
    this.canvas.setPointerCapture(event.pointerId);
    this.render();
  }

  pointerMove(event) {
    if (!this.view) return;
    const pixel = this.pixel(event), g = this.gesture;
    if (!g) {
      const handle = this.hitHandle(pixel) ?? this.hitEnd(pixel);
      this.canvas.style.cursor = handle ? 'move' : 'grab';
      return;
    }
    if (g.id !== event.pointerId) return;
    if (g.kind === 'pan') {
      this.view.x = g.view.x - (pixel.x - g.pixel.x) / this.view.scale;
      this.view.y = g.view.y - this.flip * (pixel.y - g.pixel.y) / this.view.scale;
      this.render(); return;
    }
    // A click selects; only a real drag edits.
    if (!g.moved && Math.hypot(pixel.x - g.pixel.x, pixel.y - g.pixel.y) < 4) return;
    g.moved = true;
    const at = this.world(pixel), from = g.start[g.index];
    const next = g.kind === 'handle'
      ? G.dragHandle(from, g.key, at, { free: event.shiftKey, previous: g.last })
      : G.translate(from, [at[0] - g.origin[0], at[1] - g.origin[1]]);
    const reason = next ? G.invalid(next, this.extent) : 'That shape cannot be drawn.';
    if (reason) { this.note = reason; this.render(); return; }
    g.last = next;
    this.entities = G.withFollowers(g.start, g.index, next, g.joins, this.tolerance);
    this.note = '';
    this.render();
  }

  endGesture(event, cancel) {
    const g = this.gesture;
    if (!g || g.id !== event.pointerId) return;
    this.gesture = null;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    if (cancel) {
      if (this.entities !== g.start) this.note = 'Drag cancelled.';
      this.entities = g.start;
    } else if (this.entities !== g.start) {
      const done = this.entities;
      this.entities = g.start; this.commitChange(done);
    } else if (g.kind === 'body' && g.again && g.hits.length > 1) {
      // Clicking a selected path again picks the next one under the pointer: overlapping duplicates are common.
      this.select(g.hits[(g.hits.indexOf(g.index) + g.hits.length - 1) % g.hits.length]);
    }
    this.render();
  }

  key(event) {
    if (['+', '=', '-', '0', 'Home'].includes(event.key)) {
      event.preventDefault();
      if (event.key === '0' || event.key === 'Home') this.fit(); else this.zoom(event.key === '-' ? 1 / 1.4 : 1.4);
      return;
    }
    const move = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -this.flip], ArrowDown: [0, this.flip] }[event.key];
    const e = this.entities[this.selected];
    if (!move || !e || this.gesture) return;
    event.preventDefault();
    const step = event.shiftKey ? 1 : .1, d = [move[0] * step, move[1] * step];
    const next = this.point ? G.dragHandle(e, this.point, G.pointAt(e, this.point).map((v, k) => v + d[k])) : G.translate(e, d);
    const joins = this.joinsFor(this.selected, this.point ? [this.point] : null);
    this.commitChange(G.withFollowers(this.entities, this.selected, next, joins, this.tolerance));
    this.render();
  }

  /* -------------------------------------------------------------- fields */

  /** Inputs for the selected entity; rebuilt only when the selection changes, so typing keeps its place. */
  renderFields() {
    const e = this.entities[this.selected];
    this.fields.replaceChildren(...(e ? G.fieldsOf(e, this.point) : []).map(([field, label]) => {
      const wrap = document.createElement('label'), input = document.createElement('input');
      input.type = 'number'; input.step = field === 'start' || field === 'end' || field === 'sweep' ? '1' : '0.1';
      input.dataset.field = field;
      wrap.append(label, input);
      return wrap;
    }));
  }

  editField(input) {
    const e = this.entities[this.selected], value = Number(input.value);
    if (!e || !input.value.trim()) { this.render(); return; }
    const next = G.setField(e, input.dataset.field, value, this.point);
    const reason = next ? G.invalid(next, this.extent) : 'That value cannot apply here.';
    if (reason) { this.note = reason; this.render(); return; }
    this.commitChange(G.withFollowers(this.entities, this.selected, next, this.joinsFor(this.selected), this.tolerance));
    this.note = '';
    this.render();
  }

  describe(e) {
    const name = NAMES[e.tag ?? e.kind];
    if (e.kind === 'line') return `${name} · length ${round(G.dist(e.a, e.b))}`;
    if (e.kind === 'arc') return `${name} · radius ${round(e.r)} · turning ${round(e.sweep * 180 / Math.PI)}°`;
    if (e.kind === 'circle') return `${name} · radius ${round(e.r)}`;
    const points = e.segs.filter(s => s.p).length;
    return `${name} ${this.selected + 1} of ${this.entities.length} · ${points} points${this.point ? ` · point ${Number(this.point.split(':')[1]) + 1} selected` : ''}`;
  }

  render() {
    const e = this.entities[this.selected];
    const values = e ? G.fieldsOf(e, this.point) : [];
    for (const input of this.fields.querySelectorAll('input')) {
      const field = values.find(f => f[0] === input.dataset.field);
      if (field && document.activeElement !== input) input.value = round(field[2]);
    }
    const changedCount = this.original ? this.entities.filter((x, i) => G.changed(this.original[i], x)).length : 0;
    this.status.textContent = this.error || [this.note, e && this.describe(e),
      changedCount && `${changedCount} edited, not applied yet.`].filter(Boolean).join(' ');
    this.status.classList.toggle('error', !!this.error);
    this.root.querySelector('[data-action="apply"]').disabled = !changedCount;
    this.root.querySelector('[data-action="undo"]').disabled = !this.history.length;
    this.root.querySelector('[data-action="reset"]').disabled = !changedCount;
    this.draw();
  }

  draw() {
    this.width = this.stage.clientWidth; this.height = this.stage.clientHeight;
    if (!this.width || !this.height) return;
    const dpr = window.devicePixelRatio || 1, ctx = this.ctx;
    this.canvas.width = Math.round(this.width * dpr); this.canvas.height = Math.round(this.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    if (!this.view || !this.original) return;
    const view = this.matrix();
    const stroke = (e, color, width, dash = []) => {
      const path = new Path2D();
      path.addPath(this.shape(e), view);
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash); ctx.stroke(path); ctx.setLineDash([]);
    };
    const dot = (at, radius, fill, ring = null) => {
      const s = this.screen(at);
      ctx.beginPath(); ctx.arc(s.x, s.y, radius, 0, 2 * Math.PI); ctx.fillStyle = fill; ctx.fill();
      if (ring) { ctx.strokeStyle = ring; ctx.lineWidth = 1.5; ctx.stroke(); }
    };
    const square = (at, size, fill) => { const s = this.screen(at); ctx.fillStyle = fill; ctx.fillRect(s.x - size, s.y - size, 2 * size, 2 * size); };
    ctx.lineCap = ctx.lineJoin = 'round';
    for (const f of this.fixed) stroke(f, COLORS.fixed, 1);
    // The subject as loaded, faintly, wherever a path has moved.
    this.entities.forEach((x, i) => { if (G.changed(this.original[i], x)) stroke(this.original[i], COLORS.ghost, 1.5, [4, 4]); });
    this.entities.forEach((x, i) => { if (i !== this.selected) stroke(x, COLORS.path, 1.5); });
    const chosen = this.entities[this.selected];
    if (chosen) stroke(chosen, COLORS.chosen, 2.5);
    // DXF ends, once per point: green where paths join.
    if (!this.svgMode) {
      for (const { at, count } of G.endPoints(this.entities, this.tolerance)) dot(at, 3, count > 1 ? COLORS.joined : COLORS.end);
    }
    if (!chosen) return;
    for (const h of G.handlesOf(chosen, this.point)) {
      if (h.role === 'control') {
        const a = this.screen(h.from), b = this.screen(h.at);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.strokeStyle = COLORS.control; ctx.lineWidth = 1; ctx.stroke();
        square(h.at, 3.5, COLORS.control);
      } else if (h.role === 'end') {
        const picked = h.key === this.point || h.key === this.gesture?.key;
        dot(h.at, picked ? 6.5 : this.svgMode ? 3.5 : 5, COLORS.chosen, picked ? '#f8fafc' : null);
      } else if (h.role === 'bend') {
        const s = this.screen(h.at);
        ctx.beginPath(); ctx.moveTo(s.x, s.y - 6); ctx.lineTo(s.x + 6, s.y); ctx.lineTo(s.x, s.y + 6); ctx.lineTo(s.x - 6, s.y); ctx.closePath();
        ctx.fillStyle = COLORS.bend; ctx.fill();
      } else square(h.at, 4.5, COLORS.bend);
    }
  }
}
