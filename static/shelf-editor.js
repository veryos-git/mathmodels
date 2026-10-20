import { shelfSize, shelfProjection, shelfBounds, hitShelf, moveShelf, resizeShelf } from './shelf-editor-geometry.js';

const clamp = (x, min, max) => Math.max(min, Math.min(max, x));
const axes = { top: 'X / Y · footprint', front: 'X / Z · height' };

/** Orthographic placement, using the converter's frame projections and shelf outline. */
export class ShelfEditor {
  constructor({ host, read, change }) {
    this.host = host; this.read = read; this.change = change; this.plane = 'top';
    host.classList.add('profile-editor', 'shelf-editor');
    host.innerHTML = `<div class="profile-editor-content">
      <header><strong>Shelf placement</strong><button type="button" class="ghost" data-action="expand">Expand ↗</button></header>
      <div class="profile-editor-legend" role="group" aria-label="Shelf placement view">
        <button type="button" class="ghost" data-plane="top" style="--profile-color:#fbbf24">Top · X/Y</button>
        <button type="button" class="ghost" data-plane="front" style="--profile-color:#fbbf24">Front · X/Z</button>
      </div>
      <div class="shelf-editor-key"><span>● Main frame</span><span>● Shelf outline</span></div>
      <div class="profile-editor-stage"><canvas tabindex="0" role="group"></canvas></div>
      <div class="profile-editor-view">
        <button type="button" class="ghost" data-action="out" aria-label="Zoom out">−</button>
        <button type="button" class="ghost" data-action="in" aria-label="Zoom in">+</button>
        <button type="button" class="ghost" data-action="fit">Fit all</button><span>Snap · 0.1 mm</span>
      </div>
      <p class="profile-editor-status" role="status"></p>
      <button type="button" class="ghost" data-action="retry" hidden>Retry preview</button>
      <div class="profile-editor-fields shelf-editor-fields">
        <label>Width (mm)<input data-field="width" type="number" min="0.2" step="any"></label>
        <label>Depth (mm)<input data-field="depth" type="number" min="0.2" step="any"></label>
        <label>X · left/right (mm)<input data-field="x" type="number" step="0.1"></label>
        <label>Y · depth (mm)<input data-field="y" type="number" step="0.1"></label>
        <label>Z · height (mm)<input data-field="z" type="number" step="0.1"></label>
        <label class="check"><input data-field="locked" type="checkbox">Keep proportions</label>
      </div>
      <p class="profile-editor-help"></p>
    </div>`;
    this.content = host.firstElementChild;
    this.canvas = host.querySelector('canvas'); this.ctx = this.canvas.getContext('2d');
    this.stage = host.querySelector('.profile-editor-stage');
    this.status = host.querySelector('.profile-editor-status');
    this.help = host.querySelector('.profile-editor-help');
    this.inputs = Object.fromEntries([...host.querySelectorAll('[data-field]')].map(el => [el.dataset.field, el]));
    this.content.addEventListener('click', event => {
      const plane = event.target.closest('[data-plane]')?.dataset.plane;
      if (plane && !this.gesture) { this.plane = plane; this.fit(); }
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (action === 'fit') this.fit();
      if (action === 'in' || action === 'out') this.zoom(action === 'in' ? 1.4 : 1 / 1.4);
      if (action === 'expand') this.expand();
      if (action === 'retry') { this.sources = null; this.sync(); }
    });
    for (const [key, input] of Object.entries(this.inputs)) input.onchange = () => {
      if (!this.geometry?.shelf) return;
      const state = this.read().values, next = { ...state };
      if (key === 'locked') next.locked = input.checked;
      else {
        const value = Number(input.value);
        if (!input.value.trim() || !Number.isFinite(value) || !input.checkValidity()) { this.render(); return; }
        next[key] = value;
        if (state.locked && ['width', 'depth'].includes(key)) {
          const size = shelfSize(this.geometry.shelf, state), other = key === 'width' ? 'depth' : 'width';
          next[other] = size[other] * value / size[key];
        }
      }
      this.change(next, true);
    };
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
    this.canvas.addEventListener('keydown', event => {
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', '+', '=', '-', '0', 'Home', 'Escape'].includes(event.key)) return;
      if (event.key === 'Escape' && !this.gesture) return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === 'Escape') this.endGesture({ pointerId: this.gesture.id }, true);
      else if (this.gesture) return;
      else if (['0', 'Home'].includes(event.key)) this.fit();
      else if (['+', '=', '-'].includes(event.key)) this.zoom(event.key === '-' ? 1 / 1.4 : 1.4);
      else if (this.geometry?.shelf) {
        const step = event.shiftKey ? 1 : .1;
        const dx = event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0;
        const dy = event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0;
        if (this.plane === 'top' || dy) this.change(moveShelf(this.read().values, this.plane, dx, dy), true);
      }
    });
    this.observer = new ResizeObserver(() => { if (!this.view) this.fit(); else this.render(); });
    this.observer.observe(this.stage);
    this.sync();
  }

  async sync() {
    if (!this.host.offsetWidth && !this.dialog?.open) return;
    const state = this.read();
    if (!state.form) {
      this.request?.abort(); this.sources = null; this.geometry = null; this.view = null;
      this.loading = false; this.error = state.message; this.render(); return;
    }
    const sources = [...state.form.entries()].flat();
    if (this.sources?.length === sources.length && this.sources.every((value, i) => value === sources[i])) { this.render(); return; }
    if (this.gesture) this.endGesture({ pointerId: this.gesture.id }, true);
    this.sources = sources;
    this.request?.abort();
    const request = this.request = new AbortController();
    this.geometry = null; this.view = null; this.loading = true; this.error = '';
    this.render();
    try {
      const response = await fetch('/api/additions/preview', { method: 'POST', body: state.form, signal: request.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load the placement preview.');
      if (request.signal.aborted) return;
      this.geometry = data; this.loading = false; this.fit();
    } catch (error) {
      if (request.signal.aborted) return;
      this.loading = false; this.error = error.message; this.render();
    }
  }

  projection() { return this.geometry?.shelf ? shelfProjection(this.geometry.shelf, this.read().values, this.plane) : null; }
  pixel(event) { const b = this.canvas.getBoundingClientRect(); return { x: event.clientX - b.left, y: event.clientY - b.top }; }
  world(p) { return { x: this.view.x + (p.x - this.width / 2) / this.view.scale, y: this.view.y + (this.height / 2 - p.y) / this.view.scale }; }
  screen(x, y) { return { x: (x - this.view.x) * this.view.scale + this.width / 2, y: this.height / 2 - (y - this.view.y) * this.view.scale }; }

  fit() {
    if (this.gesture) return;
    const shapes = [...(this.geometry?.frame[this.plane] || []), ...(this.projection() ? [this.projection()] : [])];
    const width = this.stage.clientWidth, height = this.stage.clientHeight;
    if (!shapes.length || !width || !height) { this.render(); return; }
    const boxes = shapes.map(shelfBounds);
    const l = Math.min(...boxes.map(b => b[0])), b = Math.min(...boxes.map(b => b[1]));
    const r = Math.max(...boxes.map(b => b[2])), t = Math.max(...boxes.map(b => b[3]));
    this.fitScale = Math.max(.001, Math.min((width - 56) / (r - l || 1), (height - 56) / (t - b || 1)));
    this.view = { scale: this.fitScale, x: (l + r) / 2, y: (b + t) / 2 }; this.render();
  }

  zoom(factor, pixel = { x: this.width / 2, y: this.height / 2 }) {
    if (!this.view || this.gesture) return;
    const before = this.world(pixel);
    this.view.scale = clamp(this.view.scale * factor, this.fitScale / 10, this.fitScale * 64);
    const after = this.world(pixel);
    this.view.x += before.x - after.x; this.view.y += before.y - after.y; this.render();
  }

  handles() {
    if (!this.view || !this.geometry?.shelf || this.plane !== 'top') return [];
    const v = this.read().values, size = shelfSize(this.geometry.shelf, v);
    return [{ kind: 'width', ...this.screen(v.x + size.width / 2, v.y + size.depth / 2) },
      { kind: 'depth', ...this.screen(v.x, v.y + size.depth) },
      { kind: 'corner', ...this.screen(v.x + size.width / 2, v.y + size.depth) }];
  }

  target(pixel) {
    const handle = this.handles().find(h => Math.hypot(h.x - pixel.x, h.y - pixel.y) < 10);
    if (handle) return handle.kind;
    const shape = this.projection();
    return shape && hitShelf(shape, this.world(pixel), 7 / this.view.scale) ? 'move' : 'pan';
  }

  pointerDown(event) {
    if (!this.view || this.gesture || ![0, 1].includes(event.button)) return;
    event.preventDefault(); this.canvas.focus({ preventScroll: true });
    const pixel = this.pixel(event), kind = event.button === 1 ? 'pan' : this.target(pixel);
    this.gesture = { id: event.pointerId, kind, pixel, point: this.world(pixel),
      view: { ...this.view }, start: { ...this.read().values },
      size: this.geometry.shelf ? shelfSize(this.geometry.shelf, this.read().values) : null, changed: false };
    this.canvas.setPointerCapture(event.pointerId);
  }

  pointerMove(event) {
    if (!this.view) return;
    const pixel = this.pixel(event), g = this.gesture;
    if (!g) {
      const kind = this.target(pixel);
      this.canvas.style.cursor = { width: 'ew-resize', depth: 'ns-resize', corner: 'nesw-resize',
        move: this.plane === 'top' ? 'move' : 'ns-resize', pan: 'grab' }[kind]; return;
    }
    if (g.id !== event.pointerId) return;
    if (g.kind === 'pan') {
      this.view.x = g.view.x - (pixel.x - g.pixel.x) / this.view.scale;
      this.view.y = g.view.y + (pixel.y - g.pixel.y) / this.view.scale;
      this.render(); return;
    }
    const point = this.world(pixel), dx = point.x - g.point.x, dy = point.y - g.point.y;
    const next = g.kind === 'move' ? moveShelf(g.start, this.plane, dx, dy) : resizeShelf(g.start, g.size, g.kind, dx, dy);
    g.changed ||= ['width', 'depth', 'x', 'y', 'z'].some(key => next[key] !== g.start[key]);
    this.change(next, false);
  }

  endGesture(event, cancel) {
    const g = this.gesture;
    if (!g || event.pointerId !== g.id) return;
    this.gesture = null;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    if (g.kind !== 'pan' && g.changed) this.change(cancel ? g.start : this.read().values, true);
    this.render();
  }

  render() {
    const state = this.read(), shelf = this.geometry?.shelf;
    for (const b of this.content.querySelectorAll('[data-plane]')) b.setAttribute('aria-pressed', String(b.dataset.plane === this.plane));
    const size = shelf ? shelfSize(shelf, state.values) : {};
    for (const [key, input] of Object.entries(this.inputs)) {
      input.disabled = !shelf;
      if (key === 'locked') input.checked = state.values.locked;
      else if (document.activeElement !== input) input.value = shelf ? Number((size[key] ?? state.values[key]).toFixed(4)) : '';
    }
    this.help.textContent = this.plane === 'top'
      ? 'Drag the yellow shelf to move X/Y. Square handles resize from its rear centre. Scroll to zoom; drag empty space to pan.'
      : 'Drag the yellow shelf up/down to change Z. X/Y stay fixed. Arrow keys move 0.1 mm (Shift: 1 mm). Escape cancels a drag.';
    this.canvas.setAttribute('aria-label', `Shelf placement, ${axes[this.plane]}. ${this.help.textContent}`);
    this.canvas.setAttribute('aria-busy', String(this.loading));
    this.status.textContent = this.error || (this.loading ? 'Loading frame and shelf outlines…' : !shelf ? 'Choose a shelf outline to position it against the frame.'
      : `${size.width.toFixed(1)} × ${size.depth.toFixed(1)} mm · ${state.values.thickness.toFixed(1)} mm thick${state.enabled ? '' : ' · shelf disabled'}`);
    this.content.querySelector('[data-action="retry"]').hidden = !this.error || !state.form;
    this.width = this.stage.clientWidth; this.height = this.stage.clientHeight;
    if (!this.width || !this.height) return;
    const dpr = window.devicePixelRatio || 1, ctx = this.ctx;
    this.canvas.width = Math.round(this.width * dpr); this.canvas.height = Math.round(this.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, this.width, this.height);
    if (!this.view) return;
    this.grid();
    const draw = (shape, color, fill) => {
      ctx.beginPath();
      for (const ring of [shape.exterior, ...shape.holes]) {
        ring.forEach(([x, y], i) => { const p = this.screen(x, y); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }); ctx.closePath();
      }
      ctx.fillStyle = fill; ctx.fill('evenodd'); ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
    };
    for (const shape of this.geometry.frame[this.plane]) draw(shape, '#60a5fa', '#60a5fa30');
    const shape = this.projection();
    if (shape) {
      ctx.setLineDash(state.enabled ? [] : [5, 4]); draw(shape, '#fbbf24', '#fbbf2438'); ctx.setLineDash([]);
      const b = shelfBounds(shape), a = this.screen(b[0], b[3]), c = this.screen(b[2], b[1]);
      ctx.strokeStyle = '#fbbf24'; ctx.setLineDash([3, 4]); ctx.strokeRect(a.x - 2, a.y - 2, c.x - a.x + 4, c.y - a.y + 4); ctx.setLineDash([]);
      for (const h of this.handles()) { ctx.fillStyle = '#fff7db'; ctx.fillRect(h.x - 4, h.y - 4, 8, 8); ctx.strokeRect(h.x - 4, h.y - 4, 8, 8); }
    }
  }

  grid() {
    const ctx = this.ctx; let step = .1;
    while (step * this.view.scale < 30) step *= 10;
    if (step * this.view.scale > 150) step /= 5; else if (step * this.view.scale > 75) step /= 2;
    const min = this.world({ x: 0, y: this.height }), max = this.world({ x: this.width, y: 0 });
    ctx.font = '10px system-ui'; ctx.lineWidth = 1;
    for (let x = Math.ceil(min.x / step) * step; x <= max.x; x += step) {
      const p = this.screen(x, 0); ctx.strokeStyle = '#263144'; ctx.beginPath(); ctx.moveTo(p.x, 0); ctx.lineTo(p.x, this.height); ctx.stroke();
      ctx.fillStyle = '#8093ad'; ctx.fillText(String(Number(x.toFixed(2))), p.x + 3, this.height - 7);
    }
    for (let y = Math.ceil(min.y / step) * step; y <= max.y; y += step) {
      const p = this.screen(0, y); ctx.strokeStyle = '#263144'; ctx.beginPath(); ctx.moveTo(0, p.y); ctx.lineTo(this.width, p.y); ctx.stroke();
      ctx.fillStyle = '#8093ad'; ctx.fillText(String(Number(y.toFixed(2))), 5, p.y - 4);
    }
    const p = this.screen(0, 0); ctx.strokeStyle = '#7186a5'; ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(p.x, 0); ctx.lineTo(p.x, this.height); ctx.moveTo(0, p.y); ctx.lineTo(this.width, p.y); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#c0cfe3'; ctx.fillText(`${axes[this.plane]} · mm`, 8, 16);
  }

  expand() {
    if (!this.dialog) {
      const dialog = this.dialog = document.createElement('dialog');
      dialog.className = 'profile-editor-dialog profile-editor shelf-editor';
      dialog.setAttribute('aria-label', 'Position and resize the shelf');
      const close = document.createElement('button');
      close.className = 'ghost profile-editor-close'; close.textContent = 'Done'; close.onclick = () => dialog.close();
      dialog.append(close); document.body.append(dialog);
      dialog.addEventListener('keydown', event => event.stopPropagation());
      dialog.addEventListener('close', () => {
        if (this.gesture) this.endGesture({ pointerId: this.gesture.id }, true);
        this.host.append(this.content); this.content.querySelector('[data-action="expand"]').hidden = false;
        this.fit(); this.content.querySelector('[data-action="expand"]').focus({ preventScroll: true });
      });
    }
    this.dialog.append(this.content); this.content.querySelector('[data-action="expand"]').hidden = true;
    this.dialog.showModal(); this.fit(); this.canvas.focus();
  }
}
