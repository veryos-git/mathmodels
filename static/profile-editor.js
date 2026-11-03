import {
  moveProfile, resizeProfile, sectionBounds, sectionHit, snapProfileOffset,
  colourEdges, colourHit, colourRects, moveColour, newColour, resizeColour, setColourEdges, snapColour,
} from './profile-editor-geometry.js';

const ROLES = {
  main: { label: 'Main', color: '#60a5fa' },
  groove: { label: 'Groove', color: '#fb7185' },
  cusp: { label: 'Cusp', color: '#34d399' },
};
// The groove removes material, so only the sections that print can carry colours.
const COLOURED = ['main', 'cusp'];
const CORNERS = ['nw', 'ne', 'sw', 'se'];
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const round = value => Number(value.toFixed(4));
let colourIds = 0;
const colourId = () => `c${Date.now().toString(36)}${(colourIds++).toString(36)}`;

/**
 * A single, dimensionally accurate view shared by all three profile sections,
 * and the colour regions drawn over the main and cusp sections.
 *
 * `read()` returns { files, hasCusp, hasCuspPaths, sagitta, values, colours };
 * `change(role, transform, commit)` edits a section and
 * `changeColours(colours, commit)` replaces the colour list. Both rebuild the
 * model only when `commit` is true, at the end of a gesture.
 */
export class ProfileEditor {
  constructor({ host, read, change, changeColours = () => {}, select = () => {} }) {
    this.host = host; this.read = read; this.change = change; this.changeColours = changeColours;
    this.onSelect = select; this.selected = 'main'; this.colour = null;
    host.classList.add('profile-editor', 'section-editor');
    host.innerHTML = `<div class="profile-editor-content">
      <header><div class="profile-editor-view" role="group" aria-label="View and colours">
        <button type="button" class="ghost" data-action="out" aria-label="Zoom out">−</button><button type="button" class="ghost" data-action="in" aria-label="Zoom in">+</button><button type="button" class="ghost" data-action="fit" title="Fit all sections (0)">Fit</button>
        <button type="button" class="ghost profile-editor-add" data-action="add-colour" title="Add a colour region to the selected main or cusp section. The part of the frame it covers prints in that colour.">+ Colour</button></div>
        <button type="button" class="ghost" data-action="expand">Expand ↗</button></header>
      <div class="profile-editor-legend" role="group" aria-label="Select a profile">${Object.entries(ROLES).map(([key, role]) =>
        `<button type="button" class="ghost" data-profile="${key}" style="--profile-color:${role.color}"><i aria-hidden="true"></i>${role.label}</button>`).join('')}</div>
      <div class="profile-editor-stage"><canvas tabindex="0" role="group" aria-label="Profile sections in millimetres. Click a section or colour to select it. Drag a section vertically to move it; drag a colour to move it; drag square handles to resize. Arrow keys move the selection, Delete removes a colour. Scroll to zoom."></canvas></div>
      <p class="profile-editor-status" role="status"></p><button type="button" class="ghost profile-editor-retry" hidden>Retry preview</button>
      <div class="profile-editor-fields" data-panel="section">
        <label>Width (mm)<input type="number" data-field="width" min="0.001" step="0.1"></label>
        <label>Height (mm)<input type="number" data-field="height" min="0.001" step="0.1"></label>
        <label class="profile-editor-offset">Vertical offset (mm)<input type="number" data-field="z" step="0.1"></label>
        <label class="check"><input type="checkbox" data-field="locked">Keep proportions</label>
      </div>
      <div class="profile-editor-fields profile-editor-colour" data-panel="colour" hidden>
        <div class="profile-editor-colour-row">
          <label class="profile-editor-swatch" title="The filament colour this region prints in"><input type="color" data-colour="color" aria-label="Colour"></label>
          <label class="check" title="Add a mirror image across the centre line (the sweep path)"><input type="checkbox" data-colour="mirrorX">Mirror X</label>
          <label class="check" title="Add a mirror image across the section's mid-height"><input type="checkbox" data-colour="mirrorY">Mirror Y</label>
          <button type="button" class="ghost" data-action="remove-colour" title="Remove this colour (Delete)">Remove</button>
        </div>
        <div class="profile-editor-edges">
          <label>Left<input type="number" data-colour="0" step="0.05"></label><label>Right<input type="number" data-colour="2" step="0.05"></label>
          <label>Bottom<input type="number" data-colour="1" step="0.05"></label><label>Top<input type="number" data-colour="3" step="0.05"></label>
        </div>
      </div>
      <p class="profile-editor-help">Click a section or colour to select it. Drag a section ↑↓ to move it; drag a colour (or ✥) to move it, its corners to resize it, × to remove it. Where a colour covers the section, that part of the frame prints in the colour; mirror images move with it. Scroll to zoom; drag empty space to pan.</p>
      </div>`;
    this.content = host.firstElementChild;
    this.canvas = host.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.stage = host.querySelector('.profile-editor-stage');
    this.status = host.querySelector('.profile-editor-status');
    this.retry = host.querySelector('.profile-editor-retry');
    this.panels = Object.fromEntries([...host.querySelectorAll('[data-panel]')].map(panel => [panel.dataset.panel, panel]));
    this.inputs = Object.fromEntries([...host.querySelectorAll('[data-field]')].map(input => [input.dataset.field, input]));
    this.colourInputs = Object.fromEntries([...host.querySelectorAll('[data-colour]')].map(input => [input.dataset.colour, input]));
    this.legend = [...host.querySelectorAll('[data-profile]')];
    this.addButton = host.querySelector('[data-action="add-colour"]');
    this.content.addEventListener('click', event => {
      const role = event.target.closest('[data-profile]')?.dataset.profile;
      if (role) this.select(role);
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (action === 'fit') this.fit();
      if (action === 'in') this.zoom(1.4);
      if (action === 'out') this.zoom(1 / 1.4);
      if (action === 'expand') this.expand();
      if (action === 'add-colour') this.addColour();
      if (action === 'remove-colour') this.removeColour();
    });
    this.retry.onclick = () => { this.sources = null; this.sync(); };
    for (const [field, input] of Object.entries(this.inputs)) input.onchange = () => this.editNumber(field);
    for (const [field, input] of Object.entries(this.colourInputs)) {
      input.onchange = () => this.editColour(field, true);
      if (field === 'color') input.oninput = () => this.editColour(field, false);
    }
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
    this.canvas.addEventListener('keydown', event => this.keyDown(event));
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

  /** Select a section (from the legend or the source rows), leaving any colour. */
  select(role) {
    if (!ROLES[role]) return;
    this.selected = role; this.colour = null; this.render();
  }

  /** Colours over sections that are currently shown, with their section's shape and transform. */
  visibleColours(state = this.read()) {
    const roles = this.activeRoles();
    return (state.colours ?? []).filter(colour => roles.includes(colour.section))
      .map(colour => ({ colour, section: this.geometry[colour.section], transform: state.values[colour.section] }));
  }

  selectedColour(state = this.read()) {
    return this.visibleColours(state).find(item => item.colour.id === this.colour) ?? null;
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

  /** Replace one colour in the list, by id. */
  replaceColour(next, commit) {
    this.changeColours((this.read().colours ?? []).map(colour => colour.id === next.id ? next : colour), commit);
  }

  editColour(field, commit) {
    const item = this.selectedColour();
    if (!item) return;
    const input = this.colourInputs[field];
    let next;
    if (field === 'color') next = { ...item.colour, color: input.value.toLowerCase() };
    else if (field === 'mirrorX' || field === 'mirrorY') next = { ...item.colour, [field]: input.checked };
    else {
      const value = Number(input.value);
      if (!input.value.trim() || !Number.isFinite(value)) { this.render(); return; }
      const edges = colourEdges(item.colour, item.transform);
      edges[Number(field)] = value;
      next = setColourEdges(item.colour, item.transform, edges);
    }
    // A field that loses focus fires change again; an unchanged colour needs no rebuild.
    if (commit && JSON.stringify(next) === JSON.stringify(item.colour) && !this.colourEdited) { this.render(); return; }
    this.colourEdited = !commit;
    this.replaceColour(next, commit);
  }

  addColour() {
    const state = this.read(), roles = this.activeRoles();
    const role = COLOURED.includes(this.selected) && roles.includes(this.selected) ? this.selected : 'main';
    if (!roles.includes(role)) return;
    const colour = newColour(colourId(), role, this.geometry[role], state.colours ?? []);
    this.selected = role; this.colour = colour.id;
    this.changeColours([...(state.colours ?? []), colour], true);
    this.canvas.focus({ preventScroll: true });
  }

  removeColour() {
    const item = this.selectedColour();
    if (!item) return;
    this.colour = null;
    this.changeColours((this.read().colours ?? []).filter(colour => colour.id !== item.colour.id), true);
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

  /** Resize handles of the selected section; none while a colour is selected. */
  handles() {
    if (this.colour || !this.geometry?.[this.selected] || !this.view) return [];
    const [left, bottom, right, top] = sectionBounds(this.geometry[this.selected], this.read().values[this.selected]);
    const z = this.read().values[this.selected].z;
    const x = Math.abs(right) >= Math.abs(left) ? right : left;
    const y = Math.abs(top - z) >= Math.abs(bottom - z) ? top : bottom;
    return [{ kind: 'width', ...this.screen(x, (bottom + top) / 2) },
      { kind: 'height', ...this.screen((left + right) / 2, y) }, { kind: 'corner', ...this.screen(x, y) }];
  }

  /** Corner, move (✥) and remove (×) handles of the selected colour's primary rectangle. */
  colourHandles() {
    const item = this.view && this.selectedColour();
    if (!item) return [];
    const [left, bottom, right, top] = colourEdges(item.colour, item.transform);
    const inside = p => ({ x: clamp(p.x, 10, this.width - 10), y: clamp(p.y, 10, this.height - 10) });
    const ne = this.screen(right, top), mid = this.screen(right, (bottom + top) / 2);
    return [
      ...CORNERS.map(corner => ({ kind: 'corner', corner,
        ...this.screen(corner.includes('e') ? right : left, corner.includes('n') ? top : bottom) })),
      { kind: 'remove', ...inside({ x: ne.x + 13, y: ne.y - 13 }) },
      { kind: 'move', ...inside({ x: mid.x + 16, y: mid.y }) },
    ];
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

  /** The topmost colour (selected first, then last drawn) under the point, and which copy. */
  hitColour(point) {
    const items = this.visibleColours();
    const order = [...items.filter(i => i.colour.id === this.colour), ...items.filter(i => i.colour.id !== this.colour).reverse()];
    for (const item of order) {
      const copy = colourHit(item.colour, item.section, item.transform, point);
      if (copy) return { item, copy };
    }
    return null;
  }

  pointerDown(event) {
    if (!this.view || this.gesture || ![0, 1].includes(event.button)) return;
    event.preventDefault(); this.canvas.focus({ preventScroll: true });
    const pixel = this.pixel(event), point = this.world(pixel), primary = event.button === 0;
    const near = h => Math.hypot(h.x - pixel.x, h.y - pixel.y) <= 9;
    const colourHandle = primary && this.colourHandles().find(near);
    if (colourHandle?.kind === 'remove') { this.removeColour(); return; }
    const handle = primary && !colourHandle && this.handles().find(near);
    const colourAt = primary && !colourHandle && !handle && this.hitColour(point);
    const hit = primary && !colourHandle && !handle && !colourAt && this.hit(point);
    if (colourHandle || colourAt) {
      const item = colourAt ? colourAt.item : this.selectedColour();
      this.colour = item.colour.id; this.selected = item.colour.section;
      this.gesture = { id: event.pointerId, kind: colourHandle?.kind === 'corner' ? 'colour-resize' : 'colour-move',
        corner: colourHandle?.corner, copy: colourAt?.copy ?? {}, point, start: { ...item.colour }, changed: false };
    } else if (handle || hit) {
      if (!handle) { this.selected = hit; this.colour = null; }
      this.gesture = { id: event.pointerId, kind: handle?.kind || 'move', point,
        anchor: handle ? this.world(handle) : null,
        start: { ...this.read().values[this.selected] }, changed: false };
    } else this.gesture = { id: event.pointerId, kind: 'pan', pixel, view: { ...this.view }, moved: false };
    this.canvas.setPointerCapture(event.pointerId);
    this.render();
  }

  pointerMove(event) {
    if (!this.view) return;
    const pixel = this.pixel(event), gesture = this.gesture;
    if (!gesture) {
      const near = h => Math.hypot(h.x - pixel.x, h.y - pixel.y) <= 9;
      const colourHandle = this.colourHandles().find(near), handle = this.handles().find(near);
      const point = this.world(pixel);
      this.canvas.style.cursor = colourHandle ? ({ corner: ['ne', 'sw'].includes(colourHandle.corner) ? 'nesw-resize' : 'nwse-resize', move: 'move', remove: 'pointer' })[colourHandle.kind]
        : handle ? ({ width: 'ew-resize', height: 'ns-resize', corner: 'nesw-resize' })[handle.kind]
          : this.hitColour(point) ? 'move' : this.hit(point) ? 'ns-resize' : 'grab';
      return;
    }
    if (gesture.id !== event.pointerId) return;
    if (gesture.kind === 'pan') {
      gesture.moved ||= Math.hypot(pixel.x - gesture.pixel.x, pixel.y - gesture.pixel.y) > 3;
      this.view.x = gesture.view.x - (pixel.x - gesture.pixel.x) / this.view.scale;
      this.view.y = gesture.view.y + (pixel.y - gesture.pixel.y) / this.view.scale;
      this.render(); return;
    }
    const point = this.world(pixel);
    if (gesture.kind.startsWith('colour')) {
      const transform = this.read().values[gesture.start.section];
      const next = gesture.kind === 'colour-move'
        ? moveColour(gesture.start, transform, snapColour(point.x - gesture.point.x), snapColour(point.y - gesture.point.y), gesture.copy)
        : resizeColour(gesture.start, transform, gesture.corner, { x: snapColour(point.x), y: snapColour(point.y) });
      gesture.changed = next.rect.some((v, i) => v !== gesture.start.rect[i]);
      this.replaceColour(next, false);
      return;
    }
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
    if (gesture.kind === 'pan' && !gesture.moved && !cancel) this.colour = null;   // a click on empty space
    else if (gesture.kind.startsWith('colour') && gesture.changed) {
      const current = (this.read().colours ?? []).find(colour => colour.id === gesture.start.id);
      this.replaceColour(cancel || !current ? gesture.start : current, true);
    } else if (gesture.kind !== 'pan' && gesture.changed) this.change(this.selected, cancel ? gesture.start : this.read().values[this.selected], true);
    this.render();
  }

  keyDown(event) {
    const arrows = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    if (![...arrows, '+', '=', '-', '0', 'Home', 'Escape', 'Delete', 'Backspace'].includes(event.key)) return;
    if (event.key === 'Escape' && !this.gesture && !this.colour) return;
    const item = this.selectedColour();
    if (['Delete', 'Backspace'].includes(event.key) && !item) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Escape') {
      if (this.gesture) this.endGesture({ pointerId: this.gesture.id }, true);
      else { this.colour = null; this.render(); }
    } else if (['Delete', 'Backspace'].includes(event.key)) this.removeColour();
    else if (['0', 'Home'].includes(event.key)) this.fit();
    else if (['+', '=', '-'].includes(event.key)) this.zoom(event.key === '-' ? 1 / 1.4 : 1.4);
    else if (item && !this.gesture) {
      const step = event.shiftKey ? 1 : .1;
      const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
      const dy = event.key === 'ArrowDown' ? -step : event.key === 'ArrowUp' ? step : 0;
      this.replaceColour(moveColour(item.colour, item.transform, dx, dy), true);
    } else if (this.geometry?.[this.selected] && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
      this.change(this.selected, moveProfile(this.read().values[this.selected], event.key === 'ArrowUp' ? .1 : -.1), true);
    }
  }

  /** Trace a section's outline (exterior and holes) in screen coordinates. */
  sectionPath(shape, t) {
    const ctx = this.ctx;
    ctx.beginPath();
    for (const ring of [shape.exterior, ...shape.holes]) {
      ring.forEach(([x, y], i) => { const p = this.screen(x * t.sx, y * t.sy + t.z); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
      ctx.closePath();
    }
  }

  rectPath([left, bottom, right, top]) {
    const a = this.screen(left, top), b = this.screen(right, bottom);
    this.ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
  }

  updatePanels(state, roles) {
    const item = this.selectedColour(state);
    // Without a main profile there is nothing to draw: just the prompt.
    this.stage.hidden = !state.files.main;
    this.panels.colour.hidden = !item; this.panels.section.hidden = !!item || !state.files.main;
    this.addButton.disabled = !roles.some(role => COLOURED.includes(role));
    const section = this.geometry?.[this.selected], transform = state.values[this.selected];
    for (const input of Object.values(this.inputs)) input.disabled = !section;
    if (section) {
      const b = sectionBounds(section, transform);
      this.inputs.width.value = round(b[2] - b[0]);
      this.inputs.height.value = round(b[3] - b[1]);
      this.inputs.z.value = round(transform.z);
      this.inputs.locked.checked = transform.locked;
    } else for (const input of Object.values(this.inputs)) if (input.type !== 'checkbox') input.value = '';
    if (item) {
      const edges = colourEdges(item.colour, item.transform);
      if (document.activeElement !== this.colourInputs.color) this.colourInputs.color.value = item.colour.color;
      this.colourInputs.mirrorX.checked = !!item.colour.mirrorX;
      this.colourInputs.mirrorY.checked = !!item.colour.mirrorY;
      edges.forEach((value, i) => { this.colourInputs[i].value = Number(value.toFixed(3)); });
    }
    const count = (state.colours ?? []).filter(colour => colour.section === this.selected && roles.includes(colour.section)).length;
    const name = state.files[this.selected]?.name || (this.selected === 'cusp' ? 'scaled main profile' : '');
    const where = item?.colour.section === 'cusp' && !state.hasCuspPaths ? ' · applies once cusp paths are loaded' : '';
    this.status.textContent = this.error || (this.loading ? 'Loading aligned sections…'
      : item ? `${ROLES[item.colour.section].label} colour ${item.colour.color}${item.colour.mirrorX || item.colour.mirrorY ? ' · mirrored' : ''}${where}`
        : section ? `${ROLES[this.selected].label} · ${name}${this.selected === 'groove' ? ' · subtracts from the frame' : ''}${count ? ` · ${count} colour${count > 1 ? 's' : ''}` : ''}`
          : 'Load a main sweep profile to compare and edit sections.');
  }

  render() {
    const state = this.read(), roles = this.activeRoles();
    if (roles.length && !roles.includes(this.selected)) this.selected = roles[0];
    if (this.colour && !this.selectedColour(state)) this.colour = null;
    for (const button of this.legend) {
      button.disabled = !roles.includes(button.dataset.profile);
      button.setAttribute('aria-pressed', String(button.dataset.profile === this.selected && !button.disabled));
    }
    this.canvas.setAttribute('aria-busy', String(this.loading));
    this.updatePanels(state, roles);
    this.onSelect(roles.includes(this.selected) ? this.selected : null, this.colour);
    this.width = this.stage.clientWidth; this.height = this.stage.clientHeight;
    if (!this.width || !this.height) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.width * dpr); this.canvas.height = Math.round(this.height * dpr);
    const ctx = this.ctx; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    if (!this.view) return;
    this.drawGrid();
    const order = [...roles.filter(key => key !== this.selected), ...roles.filter(key => key === this.selected)];
    const focused = key => key === this.selected && !this.colour;
    for (const key of order) {
      this.sectionPath(this.geometry[key], state.values[key]);
      ctx.fillStyle = ROLES[key].color + (focused(key) ? '35' : '1c'); ctx.fill('evenodd');
    }
    // Colours fill only the part of their section they cover: what prints in them.
    const colours = this.visibleColours(state);
    for (const { colour, section, transform } of colours) {
      ctx.save();
      this.sectionPath(section, transform); ctx.clip('evenodd');
      ctx.beginPath();
      for (const { rect } of colourRects(colour, section, transform)) this.rectPath(rect);
      ctx.fillStyle = colour.color; ctx.globalAlpha = colour.id === this.colour ? .9 : .72; ctx.fill();
      ctx.restore();
    }
    for (const key of order) {
      this.sectionPath(this.geometry[key], state.values[key]);
      ctx.strokeStyle = ROLES[key].color; ctx.lineWidth = focused(key) ? 2.5 : 1.5;
      ctx.setLineDash(key === 'groove' ? [6, 4] : []); ctx.stroke(); ctx.setLineDash([]);
    }
    for (const { colour, section, transform } of colours) {
      const selected = colour.id === this.colour;
      colourRects(colour, section, transform).forEach(({ rect }, i) => {
        ctx.beginPath(); this.rectPath(rect);
        ctx.strokeStyle = colour.color; ctx.globalAlpha = i ? .6 : 1;
        ctx.lineWidth = selected && !i ? 2 : 1; ctx.setLineDash(selected && !i ? [] : [4, 3]); ctx.stroke();
      });
      ctx.globalAlpha = 1; ctx.setLineDash([]);
    }
    const section = this.geometry?.[this.selected];
    if (section && !this.colour) {
      const b = sectionBounds(section, state.values[this.selected]), a = this.screen(b[0], b[3]), z = this.screen(b[2], b[1]);
      ctx.strokeStyle = ROLES[this.selected].color; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
      ctx.strokeRect(a.x - 3, a.y - 3, z.x - a.x + 6, z.y - a.y + 6); ctx.setLineDash([]);
      for (const h of this.handles()) { ctx.fillStyle = '#f8fafc'; ctx.fillRect(h.x - 4, h.y - 4, 8, 8); ctx.strokeRect(h.x - 4, h.y - 4, 8, 8); }
    }
    this.drawColourHandles();
  }

  drawColourHandles() {
    const ctx = this.ctx, item = this.selectedColour();
    if (!item) return;
    ctx.lineWidth = 1.5; ctx.strokeStyle = item.colour.color; ctx.font = 'bold 12px system-ui';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const h of this.colourHandles()) {
      if (h.kind === 'corner') { ctx.fillStyle = '#f8fafc'; ctx.fillRect(h.x - 4, h.y - 4, 8, 8); ctx.strokeRect(h.x - 4, h.y - 4, 8, 8); continue; }
      ctx.beginPath(); ctx.arc(h.x, h.y, 8, 0, 2 * Math.PI);
      ctx.fillStyle = '#0f172a'; ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#f8fafc'; ctx.fillText(h.kind === 'remove' ? '×' : '✥', h.x, h.y + .5);
    }
    ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
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
    ctx.fillStyle = '#b6c7de'; ctx.fillText('mm', 8, 15);
  }

  expand() {
    if (!this.dialog) {
      this.dialog = document.createElement('dialog'); this.dialog.className = 'profile-editor-dialog profile-editor section-editor';
      this.dialog.setAttribute('aria-label', 'Edit aligned profiles and colours');
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
