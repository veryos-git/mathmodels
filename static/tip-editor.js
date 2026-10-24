import { analyseSketch, initialState, solve, arcsOf, arcSweep, tipOverlap, arcEdits, arcDistance, tangentPoints, sketchBounds } from './tip-editor-geometry.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const COLORS = { fixed: '#64748b', arc: '#60a5fa', chosen: '#fbbf24', tip: '#f59e0b', tangent: '#34d399', ghost: '#3b4b63' };
const round = value => Number(value.toFixed(4));

/**
 * Reshape a DXF subject's pointy tips: drag where two arcs meet, or type a
 * tip position, the overlap of its two circles or an arc's radius. Each arc
 * stays tangent to the lines and circles it touched, joined arcs stay joined,
 * and with "Keep symmetry" every mirrored or rotated copy follows.
 * `apply(edits)` receives the changed arcs and replaces the subject.
 */
export class TipEditor {
  constructor({ apply }) {
    this.apply = apply;
    const dialog = this.dialog = document.createElement('dialog');
    dialog.className = 'profile-editor-dialog profile-editor tip-editor';
    dialog.setAttribute('aria-label', 'Edit pointy tips');
    dialog.innerHTML = `<div class="profile-editor-content">
      <header><strong>Pointy tips · <span data-name></span></strong></header>
      <div class="profile-editor-stage"><canvas tabindex="0" role="group" aria-label="Subject paths. Drag a pointy tip to reshape its two arcs; click an arc to select it. Arrow keys move the selected tip by 0.1, with Shift by 1. Scroll to zoom."></canvas></div>
      <div class="profile-editor-view">
        <button type="button" class="ghost" data-action="out" aria-label="Zoom out">−</button>
        <button type="button" class="ghost" data-action="in" aria-label="Zoom in">+</button>
        <button type="button" class="ghost" data-action="fit">Fit all</button>
        <label class="check tip-editor-symmetry"><input type="checkbox" data-field="symmetric" checked> Keep symmetry <small data-symmetries></small></label>
        <span>● tip · ◆ kept tangency</span>
      </div>
      <p class="profile-editor-status" role="status"></p>
      <div class="profile-editor-fields">
        <label>Tip X<input type="number" data-field="x" step="0.1"></label>
        <label>Tip Y<input type="number" data-field="y" step="0.1"></label>
        <label>Circle overlap<input type="number" data-field="overlap" step="0.1"></label>
        <label>Arc radius<input type="number" data-field="radius" min="0.001" step="0.1"></label>
      </div>
      <p class="profile-editor-help">Drag a pointy tip (●) where two arcs meet. Each arc keeps touching the lines and circles it touched (◆), and the arcs stay joined. Select a tip to type its position or how far its two circles overlap; select an arc to type its radius. Sizes are the DXF's own units, before the model's scale.</p>
      <div class="tip-editor-actions">
        <button type="button" class="ghost" data-action="reset">Reset</button>
        <button type="button" class="ghost" data-action="cancel">Cancel</button>
        <button type="button" data-action="apply">Apply to subject</button>
      </div>
    </div>`;
    document.body.append(dialog);
    this.canvas = dialog.querySelector('canvas'); this.ctx = this.canvas.getContext('2d');
    this.stage = dialog.querySelector('.profile-editor-stage');
    this.status = dialog.querySelector('.profile-editor-status');
    this.inputs = Object.fromEntries([...dialog.querySelectorAll('[data-field]')].map(input => [input.dataset.field, input]));
    dialog.addEventListener('click', event => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (action === 'fit') this.fit();
      if (action === 'in' || action === 'out') this.zoom(action === 'in' ? 1.4 : 1 / 1.4);
      if (action === 'reset' && this.S) { this.state = initialState(this.S); this.note = 'Back to the subject as loaded.'; this.render(); }
      if (action === 'cancel') dialog.close();
      if (action === 'apply') this.commit();
    });
    // Escape cancels an active drag before it closes the editor.
    dialog.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Escape' && this.gesture) { event.preventDefault(); this.endGesture({ pointerId: this.gesture.id }, true); }
    });
    dialog.addEventListener('close', () => { this.gesture = null; this.request?.abort(); });
    this.inputs.symmetric.onchange = () => this.render();
    for (const key of ['x', 'y', 'overlap', 'radius']) this.inputs[key].onchange = () => this.editNumber(key);
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
    new ResizeObserver(() => { if (this.dialog.open) { if (!this.view) this.fit(); else this.render(); } }).observe(this.stage);
  }

  /** Load `file`'s exact lines and arcs and show the editor. */
  async open(file, sagitta = 0.02) {
    this.request?.abort();
    const request = this.request = new AbortController();
    this.file = file; this.S = null; this.state = null; this.view = null; this.selected = null; this.gesture = null;
    this.note = 'Loading the subject’s arcs…'; this.error = '';
    this.dialog.querySelector('[data-name]').textContent = file.name;
    if (!this.dialog.open) this.dialog.showModal();
    this.render();
    try {
      const form = new FormData();
      form.set('file', file); form.set('sagitta', sagitta);
      const response = await fetch('/api/sketch', { method: 'POST', body: form, signal: request.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not read this subject’s arcs.');
      if (request.signal.aborted) return;
      this.sketch = data; this.S = analyseSketch(data); this.state = initialState(this.S);
      this.selected = this.S.tips.length ? { kind: 'tip', node: this.S.tips[0] } : null;
      this.note = this.S.tips.length ? `${this.S.tips.length} pointy tips, ${this.S.tangents.length} kept tangencies.`
        : 'No pointy tips found: no two editable arcs meet at an angle.';
      const names = this.S.symmetries.map(s => s.name).filter(name => name !== '2-fold rotation' || this.S.symmetries.length === 1);
      this.dialog.querySelector('[data-symmetries]').textContent = names.length ? `(${names.join(', ')})` : '(none found)';
      this.inputs.symmetric.disabled = !names.length;
      this.inputs.symmetric.checked = !!names.length;
      this.fit();
      this.canvas.focus();
    } catch (error) {
      if (request.signal.aborted) return;
      this.error = error.message; this.render();
    }
  }

  get symmetric() { return this.inputs.symmetric.checked; }

  /** Try a target; a drag that cannot get all the way goes as far as it can. */
  attempt(target, partial = false) {
    const result = solve(this.S, this.state, [target], { symmetric: this.symmetric });
    if (result.ok || !partial || target.type !== 'node') return result;
    const from = this.state.p[target.node];
    let best = result, lo = 0, hi = 1;
    for (let step = 0; step < 8; step++) {
      const mid = (lo + hi) / 2;
      const at = [from[0] + mid * (target.at[0] - from[0]), from[1] + mid * (target.at[1] - from[1])];
      const tried = solve(this.S, this.state, [{ ...target, at }], { symmetric: this.symmetric });
      if (tried.ok) { best = { ...tried, reason: result.reason }; lo = mid; } else hi = mid;
    }
    return best;
  }

  editNumber(key) {
    const input = this.inputs[key], value = Number(input.value);
    if (!this.S || !this.selected || !input.value.trim() || !Number.isFinite(value)) { this.render(); return; }
    const { kind, node, arc } = this.selected;
    const target = key === 'radius' ? { type: 'radius', arc: kind === 'arc' ? arc : null, value }
      : key === 'overlap' ? { type: 'overlap', node, value }
        : { type: 'node', node, at: key === 'x' ? [value, this.state.p[node][1]] : [this.state.p[node][0], value] };
    if (target.arc === null) { this.render(); return; }
    const result = this.attempt(target);
    if (result.ok) { this.state = result.state; this.note = ''; } else this.note = result.reason;
    this.render();
  }

  key(event) {
    if (['+', '=', '-', '0', 'Home'].includes(event.key)) {
      event.preventDefault();
      if (event.key === '0' || event.key === 'Home') this.fit(); else this.zoom(event.key === '-' ? 1 / 1.4 : 1.4);
      return;
    }
    const move = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[event.key];
    if (!move || this.selected?.kind !== 'tip' || this.gesture) return;
    event.preventDefault();
    const step = event.shiftKey ? 1 : .1, p = this.state.p[this.selected.node];
    const result = this.attempt({ type: 'node', node: this.selected.node, at: [p[0] + move[0] * step, p[1] + move[1] * step] });
    if (result.ok) { this.state = result.state; this.note = ''; } else this.note = result.reason;
    this.render();
  }

  async commit() {
    if (!this.S) { this.dialog.close(); return; }
    const edits = arcEdits(this.S, this.state);
    if (!edits.length) { this.dialog.close(); return; }
    const button = this.dialog.querySelector('[data-action="apply"]');
    button.disabled = true; this.note = 'Writing the new arcs into the subject…'; this.render();
    try {
      await this.apply(edits);
      this.dialog.close();
    } catch (error) {
      this.note = String(error.message ?? error); this.render();
    } finally { button.disabled = false; }
  }

  fit() {
    const width = this.stage.clientWidth, height = this.stage.clientHeight;
    if (!this.sketch || !this.S || !width || !height) { this.render(); return; }
    const [left, bottom, right, top] = sketchBounds(this.sketch);
    this.fitScale = Math.min((width - 64) / (right - left || 1), (height - 64) / (top - bottom || 1));
    this.view = { scale: this.fitScale, x: (left + right) / 2, y: (bottom + top) / 2 };
    this.render();
  }

  pixel(event) { const box = this.canvas.getBoundingClientRect(); return { x: event.clientX - box.left, y: event.clientY - box.top }; }
  world(point) { return [(point.x - this.width / 2) / this.view.scale + this.view.x, (this.height / 2 - point.y) / this.view.scale + this.view.y]; }
  screen([x, y]) { return { x: (x - this.view.x) * this.view.scale + this.width / 2, y: this.height / 2 - (y - this.view.y) * this.view.scale }; }
  zoom(factor, point = { x: this.width / 2, y: this.height / 2 }) {
    if (!this.view || this.gesture) return;
    const before = this.world(point);
    this.view.scale = clamp(this.view.scale * factor, this.fitScale / 10, this.fitScale * 200);
    const after = this.world(point);
    this.view.x += before[0] - after[0]; this.view.y += before[1] - after[1];
    this.render();
  }

  /** The tip or editable arc under a pixel, tips first. */
  hit(pixel) {
    if (!this.S) return null;
    const node = this.S.tips.map(j => ({ j, d: Math.hypot(this.screen(this.state.p[j]).x - pixel.x, this.screen(this.state.p[j]).y - pixel.y) }))
      .filter(h => h.d <= 10).sort((a, b) => a.d - b.d)[0];
    if (node) return { kind: 'tip', node: node.j };
    const point = this.world(pixel), arcs = arcsOf(this.S, this.state);
    const arc = this.S.editable.map(i => ({ i, d: arcDistance(arcs[i], point) * this.view.scale }))
      .filter(h => h.d <= 7).sort((a, b) => a.d - b.d)[0];
    return arc ? { kind: 'arc', arc: arc.i } : null;
  }

  pointerDown(event) {
    if (!this.view || this.gesture || ![0, 1].includes(event.button)) return;
    event.preventDefault(); this.canvas.focus({ preventScroll: true });
    const pixel = this.pixel(event), hit = event.button === 0 && this.hit(pixel);
    if (hit) this.selected = hit;
    this.gesture = hit?.kind === 'tip'
      ? { id: event.pointerId, kind: 'tip', node: hit.node, start: this.state }
      : { id: event.pointerId, kind: 'pan', pixel, view: { ...this.view } };
    this.canvas.setPointerCapture(event.pointerId);
    this.render();
  }

  pointerMove(event) {
    if (!this.view) return;
    const pixel = this.pixel(event), gesture = this.gesture;
    if (!gesture) {
      const hit = this.hit(pixel);
      this.canvas.style.cursor = hit?.kind === 'tip' ? 'move' : hit ? 'pointer' : 'grab';
      return;
    }
    if (gesture.id !== event.pointerId) return;
    if (gesture.kind === 'pan') {
      this.view.x = gesture.view.x - (pixel.x - gesture.pixel.x) / this.view.scale;
      this.view.y = gesture.view.y + (pixel.y - gesture.pixel.y) / this.view.scale;
      this.render(); return;
    }
    const result = this.attempt({ type: 'node', node: gesture.node, at: this.world(pixel) }, true);
    if (result.ok) this.state = result.state;
    this.note = result.reason || '';
    this.render();
  }

  endGesture(event, cancel) {
    const gesture = this.gesture;
    if (!gesture || gesture.id !== event.pointerId) return;
    this.gesture = null;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    if (gesture.kind === 'tip' && cancel) { this.state = gesture.start; this.note = 'Drag cancelled.'; }
    this.render();
  }

  render() {
    const S = this.S, state = this.state, selected = this.selected;
    const tipChosen = selected?.kind === 'tip', arcChosen = selected?.kind === 'arc';
    this.inputs.x.disabled = this.inputs.y.disabled = this.inputs.overlap.disabled = !tipChosen;
    this.inputs.radius.disabled = !arcChosen;
    if (S && tipChosen) {
      const p = state.p[selected.node];
      this.inputs.x.value = round(p[0]); this.inputs.y.value = round(p[1]);
      this.inputs.overlap.value = round(tipOverlap(S, state, selected.node));
    } else this.inputs.x.value = this.inputs.y.value = this.inputs.overlap.value = '';
    this.inputs.radius.value = S && arcChosen ? round(state.r[selected.arc]) : '';
    let detail = '';
    if (S && tipChosen) {
      const [i, k] = S.nodes[selected.node].ends.map(e => e.arc);
      detail = `Tip between arcs of radius ${round(state.r[i])} and ${round(state.r[k])}.`;
    } else if (S && arcChosen) detail = `Arc of radius ${round(state.r[selected.arc])}, turning ${round(arcSweep(arcsOf(S, state)[selected.arc]) * 180 / Math.PI)}°.`;
    this.status.textContent = this.error || [this.note, detail].filter(Boolean).join(' ');
    this.status.classList.toggle('error', !!this.error);
    this.dialog.querySelector('[data-action="apply"]').disabled = !S || !arcEdits(S, state).length;
    this.draw();
  }

  draw() {
    this.width = this.stage.clientWidth; this.height = this.stage.clientHeight;
    if (!this.width || !this.height) return;
    const dpr = window.devicePixelRatio || 1, ctx = this.ctx;
    this.canvas.width = Math.round(this.width * dpr); this.canvas.height = Math.round(this.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    if (!this.view || !this.S) return;
    const S = this.S, state = this.state, arcs = arcsOf(S, state), original = S.arcs;
    const stroke = (color, width, dash = []) => { ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash); ctx.stroke(); ctx.setLineDash([]); };
    const path = arc => {
      const c = this.screen(arc.c), r = arc.r * this.view.scale, sweep = arcSweep(arc);
      const a0 = Math.atan2(arc.start[1] - arc.c[1], arc.start[0] - arc.c[0]);
      ctx.beginPath();
      // Screen y points down, so a counter-clockwise arc runs anticlockwise on screen too.
      if (sweep >= 2 * Math.PI - 1e-9) ctx.arc(c.x, c.y, r, 0, 2 * Math.PI);
      else ctx.arc(c.x, c.y, r, -a0, -(a0 + sweep), true);
    };
    const line = (a, b) => { const p = this.screen(a), q = this.screen(b); ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); };

    if (this.symmetric) for (const map of S.symmetries) {
      if (!map.name.startsWith('mirror')) continue;
      const [x, y] = [map.t[0] / 2, map.t[1] / 2];
      if (map.name === 'mirror ↔') line([x, this.world({ x: 0, y: this.height })[1]], [x, this.world({ x: 0, y: 0 })[1]]);
      else line([this.world({ x: 0, y: 0 })[0], y], [this.world({ x: this.width, y: 0 })[0], y]);
      stroke('#2b3a52', 1, [6, 5]);
    }
    for (const l of S.lines) { line(l.a, l.b); stroke(COLORS.fixed, 1.5); }
    for (const g of S.guides) { path(g.start ? g : { ...g, start: [g.c[0] + g.r, g.c[1]], end: [g.c[0] + g.r, g.c[1]] }); stroke(COLORS.fixed, 1.5); }
    for (const p of S.polylines) {
      ctx.beginPath();
      p.points.forEach((q, k) => { const s = this.screen(q); if (k) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y); });
      stroke(COLORS.fixed, 1);
    }
    // The subject as loaded, faintly, wherever an arc has moved.
    for (const i of S.editable) {
      if (original[i].r !== arcs[i].r || original[i].c[0] !== arcs[i].c[0] || original[i].c[1] !== arcs[i].c[1]) {
        path(original[i]); stroke(COLORS.ghost, 1.5, [4, 4]);
      }
    }
    // A selected tip shows both of its circles, so their overlap reads at a glance.
    if (this.selected?.kind === 'tip') for (const { arc } of S.nodes[this.selected.node].ends) {
      const c = this.screen(arcs[arc].c);
      ctx.beginPath(); ctx.arc(c.x, c.y, arcs[arc].r * this.view.scale, 0, 2 * Math.PI); stroke('#475569', 1, [3, 5]);
      ctx.beginPath(); ctx.arc(c.x, c.y, 2.5, 0, 2 * Math.PI); ctx.fillStyle = '#94a3b8'; ctx.fill();
    }
    for (const i of S.editable) {
      const chosen = this.selected?.kind === 'arc' && this.selected.arc === i;
      path(arcs[i]); stroke(chosen ? COLORS.chosen : COLORS.arc, chosen ? 3 : 2);
    }
    for (const p of tangentPoints(S, state)) {
      const s = this.screen(p);
      ctx.beginPath(); ctx.moveTo(s.x, s.y - 4); ctx.lineTo(s.x + 4, s.y); ctx.lineTo(s.x, s.y + 4); ctx.lineTo(s.x - 4, s.y); ctx.closePath();
      ctx.fillStyle = COLORS.tangent; ctx.fill();
    }
    for (const j of S.tips) {
      const s = this.screen(state.p[j]), chosen = this.selected?.kind === 'tip' && this.selected.node === j;
      ctx.beginPath(); ctx.arc(s.x, s.y, chosen ? 7 : 5.5, 0, 2 * Math.PI);
      ctx.fillStyle = COLORS.tip; ctx.fill();
      if (chosen) stroke('#f8fafc', 2);
    }
  }
}
