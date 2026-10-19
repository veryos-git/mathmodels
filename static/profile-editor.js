import { moveProfile, resizeProfile, sectionBounds, sectionHit, snapProfileOffset } from './profile-editor-geometry.js';

const ROLES = {
  main: { label: 'Main', color: '#60a5fa' },
  groove: { label: 'Groove', color: '#fb7185' },
  cusp: { label: 'Cusp', color: '#34d399' },
};
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** A single, dimensionally accurate view shared by all three profile sections. */
export class ProfileEditor {
  constructor({ host, read, change }) {
    this.host = host; this.read = read; this.change = change; this.selected = 'main';
    host.classList.add('profile-editor');
    host.innerHTML = `<div class="profile-editor-content">
      <header><strong>Profile alignment</strong><button type="button" class="ghost" data-action="expand">Expand ↗</button></header>
      <div class="profile-editor-legend" role="group" aria-label="Select a profile">${Object.entries(ROLES).map(([key, role]) =>
        `<button type="button" class="ghost" data-profile="${key}" style="--profile-color:${role.color}"><i aria-hidden="true"></i>${role.label}</button>`).join('')}</div>
      <div class="profile-editor-stage"><canvas tabindex="0" role="group" aria-label="Profile alignment in millimetres. Click a section to select. Drag vertically to move; drag square handles to resize. Up and down move by 0.1 mm. Scroll to zoom."></canvas></div>
      <div class="profile-editor-view"><button type="button" class="ghost" data-action="out" aria-label="Zoom out">−</button><button type="button" class="ghost" data-action="in" aria-label="Zoom in">+</button><button type="button" class="ghost" data-action="fit">Fit all</button><span>Vertical snap · 0.1 mm</span></div>
      <p class="profile-editor-status" role="status"></p><button type="button" class="ghost profile-editor-retry" hidden>Retry preview</button>
      <div class="profile-editor-fields">
        <label>Width (mm)<input type="number" data-field="width" min="0.001" step="0.1"></label>
        <label>Height (mm)<input type="number" data-field="height" min="0.001" step="0.1"></label>
        <label class="profile-editor-offset">Vertical offset (mm)<input type="number" data-field="z" step="0.1"></label>
        <label class="check"><input type="checkbox" data-field="locked">Keep proportions</label>
      </div><p class="profile-editor-help">Click a section to select it. Drag ↑↓ to move; square handles resize. Scroll to zoom; drag empty space to pan.</p>
      </div>`;
    this.content = host.firstElementChild;
    this.canvas = host.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.stage = host.querySelector('.profile-editor-stage');
    this.status = host.querySelector('.profile-editor-status');
    this.retry = host.querySelector('.profile-editor-retry');
    this.inputs = Object.fromEntries([...host.querySelectorAll('[data-field]')].map(input => [input.dataset.field, input]));
    this.legend = [...host.querySelectorAll('[data-profile]')];
    this.content.addEventListener('click', event => {
      const role = event.target.closest('[data-profile]')?.dataset.profile;
      if (role) { this.selected = role; this.render(); }
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (action === 'fit') this.fit();
      if (action === 'in') this.zoom(1.4);
      if (action === 'out') this.zoom(1 / 1.4);
      if (action === 'expand') this.expand();
    });
    this.retry.onclick = () => { this.sources = null; this.sync(); };
    for (const [field, input] of Object.entries(this.inputs)) input.onchange = () => this.editNumber(field);
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
      else if (['0', 'Home'].includes(event.key)) this.fit();
      else if (['+', '=', '-'].includes(event.key)) this.zoom(event.key === '-' ? 1 / 1.4 : 1.4);
      else if (this.geometry?.[this.selected] && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
        this.change(this.selected, moveProfile(this.read().values[this.selected], event.key === 'ArrowUp' ? .1 : -.1), true);
      }
    });
    this.resizeObserver = new ResizeObserver(() => {
      if (!this.view) this.fit(); else this.render();
    });
    this.resizeObserver.observe(this.stage);
    this.sync();
  }

  activeRoles() {
    const state = this.read();
    return Object.keys(ROLES).filter(key => this.geometry?.[key] && (key !== 'cusp' || state.hasCusp));
  }

  async sync() {
    const state = this.read();
    const sources = [state.files.main, state.files.groove, state.files.cusp, state.sagitta];
    if (this.sources?.every((value, i) => value === sources[i])) { this.render(); return; }
    this.sources = sources;
    this.request?.abort();
    const request = this.request = new AbortController();
    this.geometry = null; this.view = null; this.gesture = null;
    this.error = ''; this.retry.hidden = true;
    this.loading = !!state.files.main;
    this.render();
    if (!state.files.main) return;
    try {
      const form = new FormData();
      form.set('file', state.files.main);
      if (state.files.groove) form.set('grooveProfile', state.files.groove);
      if (state.files.cusp) form.set('cuspProfile', state.files.cusp);
      form.set('sagitta', state.sagitta);
      const response = await fetch('/api/profiles/preview', { method: 'POST', body: form, signal: request.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load profile sections.');
      if (request.signal.aborted) return;
      this.geometry = data; this.loading = false;
      if (!this.activeRoles().includes(this.selected)) this.selected = 'main';
      this.fit();
    } catch (error) {
      if (request.signal.aborted) return;
      this.loading = false; this.error = error.message; this.retry.hidden = false; this.render();
    }
  }

  editNumber(field) {
    if (!this.geometry?.[this.selected]) return;
    const start = this.read().values[this.selected], next = { ...start };
    const bounds = this.geometry[this.selected].bounds;
    const value = Number(this.inputs[field].value);
    if (field === 'locked') next.locked = this.inputs.locked.checked;
    else if (!this.inputs[field].value.trim() || !Number.isFinite(value) || (field !== 'z' && value <= 0)) { this.render(); return; }
    else if (field === 'z') next.z = snapProfileOffset(value);
    else if (field === 'width') {
      next.sx = value / (bounds[2] - bounds[0]);
      if (start.locked) next.sy = start.sy * next.sx / start.sx;
    } else {
      next.sy = value / (bounds[3] - bounds[1]);
      if (start.locked) next.sx = start.sx * next.sy / start.sy;
    }
    this.change(this.selected, next, true);
  }

  fit() {
    const roles = this.activeRoles();
    const width = this.stage.clientWidth, height = this.stage.clientHeight;
    if (!roles.length || !width || !height) { this.render(); return; }
    const state = this.read(), bounds = roles.map(key => sectionBounds(this.geometry[key], state.values[key]));
    const left = Math.min(0, ...bounds.map(b => b[0])), bottom = Math.min(0, ...bounds.map(b => b[1]));
    const right = Math.max(0, ...bounds.map(b => b[2])), top = Math.max(0, ...bounds.map(b => b[3]));
    this.fitScale = Math.min((width - 64) / (right - left || 1), (height - 64) / (top - bottom || 1));
    this.view = { scale: this.fitScale, x: (left + right) / 2, y: (bottom + top) / 2 };
    this.render();
  }

  pixel(event) { const box = this.canvas.getBoundingClientRect(); return { x: event.clientX - box.left, y: event.clientY - box.top }; }
  world(point) { return { x: (point.x - this.width / 2) / this.view.scale + this.view.x, y: (this.height / 2 - point.y) / this.view.scale + this.view.y }; }
  screen(x, y) { return { x: (x - this.view.x) * this.view.scale + this.width / 2, y: this.height / 2 - (y - this.view.y) * this.view.scale }; }
  zoom(factor, point = { x: this.width / 2, y: this.height / 2 }) {
    if (!this.view || this.gesture) return;
    const before = this.world(point);
    this.view.scale = clamp(this.view.scale * factor, this.fitScale / 10, this.fitScale * 64);
    const after = this.world(point);
    this.view.x += before.x - after.x; this.view.y += before.y - after.y;
    this.render();
  }

  handles() {
    if (!this.geometry?.[this.selected] || !this.view) return [];
    const [left, bottom, right, top] = sectionBounds(this.geometry[this.selected], this.read().values[this.selected]);
    const z = this.read().values[this.selected].z;
    const x = Math.abs(right) >= Math.abs(left) ? right : left;
    const y = Math.abs(top - z) >= Math.abs(bottom - z) ? top : bottom;
    return [{ kind: 'width', ...this.screen(x, (bottom + top) / 2) },
      { kind: 'height', ...this.screen((left + right) / 2, y) }, { kind: 'corner', ...this.screen(x, y) }];
  }

  hit(point) {
    const state = this.read();
    return this.activeRoles().map(key => ({ key, distance: sectionHit(this.geometry[key], state.values[key], point, 7 / this.view.scale) }))
      .filter(hit => hit.distance !== null).sort((a, b) => {
        if (a.distance !== b.distance) return a.distance - b.distance;
        const area = key => { const b = sectionBounds(this.geometry[key], state.values[key]); return (b[2] - b[0]) * (b[3] - b[1]); };
        return area(a.key) - area(b.key);
      })[0]?.key;
  }

  pointerDown(event) {
    if (!this.view || this.gesture || ![0, 1].includes(event.button)) return;
    event.preventDefault(); this.canvas.focus({ preventScroll: true });
    const pixel = this.pixel(event), point = this.world(pixel);
    const handle = event.button === 0 && this.handles().find(h => Math.hypot(h.x - pixel.x, h.y - pixel.y) <= 9);
    const hit = event.button === 0 && this.hit(point);
    if (handle || hit) {
      if (!handle) this.selected = hit;
      this.gesture = { id: event.pointerId, kind: handle?.kind || 'move', point,
        anchor: handle ? this.world(handle) : null,
        start: { ...this.read().values[this.selected] }, changed: false };
    } else this.gesture = { id: event.pointerId, kind: 'pan', pixel, view: { ...this.view } };
    this.canvas.setPointerCapture(event.pointerId);
    this.render();
  }

  pointerMove(event) {
    if (!this.view) return;
    const pixel = this.pixel(event), gesture = this.gesture;
    if (!gesture) {
      const handle = this.handles().find(h => Math.hypot(h.x - pixel.x, h.y - pixel.y) <= 9);
      this.canvas.style.cursor = handle ? ({ width: 'ew-resize', height: 'ns-resize', corner: 'nesw-resize' })[handle.kind]
        : this.hit(this.world(pixel)) ? 'ns-resize' : 'grab';
      return;
    }
    if (gesture.id !== event.pointerId) return;
    if (gesture.kind === 'pan') {
      this.view.x = gesture.view.x - (pixel.x - gesture.pixel.x) / this.view.scale;
      this.view.y = gesture.view.y + (pixel.y - gesture.pixel.y) / this.view.scale;
      this.render(); return;
    }
    const point = this.world(pixel);
    const next = gesture.kind === 'move' ? moveProfile(gesture.start, point.y - gesture.point.y)
      : resizeProfile(this.geometry[this.selected], gesture.start, gesture.kind,
        { x: gesture.anchor.x + point.x - gesture.point.x, y: gesture.anchor.y + point.y - gesture.point.y });
    gesture.changed = ['sx', 'sy', 'z'].some(key => next[key] !== gesture.start[key]);
    this.change(this.selected, next, false);
  }

  endGesture(event, cancel) {
    const gesture = this.gesture;
    if (!gesture || gesture.id !== event.pointerId) return;
    this.gesture = null;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    if (gesture.kind !== 'pan' && gesture.changed) this.change(this.selected, cancel ? gesture.start : this.read().values[this.selected], true);
    this.render();
  }

  render() {
    const state = this.read(), roles = this.activeRoles();
    if (roles.length && !roles.includes(this.selected)) this.selected = roles[0];
    for (const button of this.legend) {
      button.disabled = !roles.includes(button.dataset.profile);
      button.setAttribute('aria-pressed', String(button.dataset.profile === this.selected && !button.disabled));
    }
    this.canvas.setAttribute('aria-busy', String(this.loading));
    const section = this.geometry?.[this.selected], transform = state.values[this.selected];
    for (const input of Object.values(this.inputs)) input.disabled = !section;
    if (section) {
      const b = sectionBounds(section, transform);
      this.inputs.width.value = Number((b[2] - b[0]).toFixed(4));
      this.inputs.height.value = Number((b[3] - b[1]).toFixed(4));
      this.inputs.z.value = Number(transform.z.toFixed(4));
      this.inputs.locked.checked = transform.locked;
    } else for (const input of Object.values(this.inputs)) if (input.type !== 'checkbox') input.value = '';
    const name = state.files[this.selected]?.name || (this.selected === 'cusp' ? 'scaled main profile' : '');
    this.status.textContent = this.error || (this.loading ? 'Loading aligned sections…' : section ? `${ROLES[this.selected].label} · ${name}${this.selected === 'groove' ? ' · subtracts from the frame' : ''}` : 'Load a main sweep profile to compare and edit sections.');
    this.width = this.stage.clientWidth; this.height = this.stage.clientHeight;
    if (!this.width || !this.height) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.width * dpr); this.canvas.height = Math.round(this.height * dpr);
    const ctx = this.ctx; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    if (!this.view) return;
    this.drawGrid();
    for (const key of [...roles.filter(key => key !== this.selected), ...roles.filter(key => key === this.selected)]) {
      const shape = this.geometry[key], t = state.values[key];
      ctx.beginPath();
      for (const ring of [shape.exterior, ...shape.holes]) {
        ring.forEach(([x, y], i) => { const p = this.screen(x * t.sx, y * t.sy + t.z); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
        ctx.closePath();
      }
      ctx.fillStyle = ROLES[key].color + (key === this.selected ? '35' : '1c'); ctx.fill('evenodd');
      ctx.strokeStyle = ROLES[key].color; ctx.lineWidth = key === this.selected ? 2.5 : 1.5;
      ctx.setLineDash(key === 'groove' ? [6, 4] : []); ctx.stroke(); ctx.setLineDash([]);
    }
    if (section) {
      const b = sectionBounds(section, transform), a = this.screen(b[0], b[3]), z = this.screen(b[2], b[1]);
      ctx.strokeStyle = ROLES[this.selected].color; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
      ctx.strokeRect(a.x - 3, a.y - 3, z.x - a.x + 6, z.y - a.y + 6); ctx.setLineDash([]);
      for (const h of this.handles()) { ctx.fillStyle = '#f8fafc'; ctx.fillRect(h.x - 4, h.y - 4, 8, 8); ctx.strokeRect(h.x - 4, h.y - 4, 8, 8); }
    }
  }

  drawGrid() {
    const ctx = this.ctx, scale = this.view.scale;
    let step = .1;
    while (step * scale < 24) step *= 10;
    if (step * scale > 120) step /= 5;
    else if (step * scale > 60) step /= 2;
    const min = this.world({ x: 0, y: this.height }), max = this.world({ x: this.width, y: 0 });
    ctx.font = '10px system-ui'; ctx.lineWidth = 1;
    const label = value => String(Number(value.toFixed(3)));
    for (let x = Math.ceil(min.x / step) * step; x <= max.x; x += step) {
      const p = this.screen(x, 0); ctx.strokeStyle = '#263144'; ctx.beginPath(); ctx.moveTo(p.x, 0); ctx.lineTo(p.x, this.height); ctx.stroke();
      ctx.fillStyle = '#8093ad'; ctx.fillText(label(x), p.x + 3, this.height - 7);
    }
    for (let y = Math.ceil(min.y / step) * step; y <= max.y; y += step) {
      const p = this.screen(0, y); ctx.strokeStyle = '#263144'; ctx.beginPath(); ctx.moveTo(0, p.y); ctx.lineTo(this.width, p.y); ctx.stroke();
      ctx.fillStyle = '#8093ad'; ctx.fillText(label(y), 5, p.y - 4);
    }
    const zero = this.screen(0, 0); ctx.strokeStyle = '#7186a5'; ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(zero.x, 0); ctx.lineTo(zero.x, this.height); ctx.moveTo(0, zero.y); ctx.lineTo(this.width, zero.y); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#b6c7de'; ctx.fillText('Height (mm)', 8, 15);
  }

  expand() {
    if (!this.dialog) {
      this.dialog = document.createElement('dialog'); this.dialog.className = 'profile-editor-dialog profile-editor';
      this.dialog.setAttribute('aria-label', 'Edit aligned profiles');
      const close = document.createElement('button'); close.className = 'ghost profile-editor-close'; close.textContent = 'Done'; close.onclick = () => this.dialog.close();
      this.dialog.append(close); document.body.append(this.dialog);
      this.dialog.addEventListener('keydown', event => event.stopPropagation());
      this.dialog.addEventListener('close', () => {
        if (this.gesture) this.endGesture({ pointerId: this.gesture.id }, true);
        this.host.append(this.content); this.content.querySelector('[data-action="expand"]').hidden = false;
        this.fit(); this.content.querySelector('[data-action="expand"]').focus({ preventScroll: true });
      });
    }
    this.dialog.append(this.content); this.content.querySelector('[data-action="expand"]').hidden = true;
    this.dialog.showModal(); this.fit(); this.canvas.focus();
  }
}
