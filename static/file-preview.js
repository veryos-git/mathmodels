// Inspect source artwork without changing its placement or model settings.
const drawingPreviews = new WeakMap();
const limit = (value, min, max) => Math.max(min, Math.min(max, value));

/** Keep DXF coordinates precise, including tiny sections and negative origins. */
export function outlineSvg(curves) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const paths = [];
  for (const curve of curves) {
    const points = curve.filter(point => Number.isFinite(point[0]) && Number.isFinite(point[1]));
    if (points.length < 2) continue;
    for (const [x, y] of points) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, -y); maxY = Math.max(maxY, -y);
    }
    paths.push(points.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${-y}`).join(' '));
  }
  if (!paths.length) throw new Error('This drawing has no outlines to preview.');
  const extent = Math.max(maxX - minX, maxY - minY) || 1;
  const pad = extent * .04;
  const width = maxX - minX + 2 * pad, height = maxY - minY + 2 * pad;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${minX - pad} ${minY - pad} ${width} ${height}">`
    + '<g fill="none" stroke="#d9e9ff" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round">'
    + paths.map(d => `<path d="${d}" vector-effect="non-scaling-stroke"/>`).join('') + '</g></svg>';
}

async function previewBlob(file, signal) {
  if (!/\.dxf$/i.test(file.name)) {
    const type = /\.svg$/i.test(file.name) ? 'image/svg+xml' : file.type;
    return type === file.type ? file : new Blob([file], { type });
  }
  if (drawingPreviews.has(file)) return drawingPreviews.get(file);
  const form = new FormData();
  form.append('file', file);
  form.append('sagitta', '0.025');
  const response = await fetch('/api/preview', { method: 'POST', body: form, signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not read this DXF.');
  const blob = new Blob([outlineSvg(data.subject?.curves ?? [])], { type: 'image/svg+xml' });
  drawingPreviews.set(file, blob);
  return blob;
}

export function filePreview(file, name = file?.name) {
  return file ? { file, name, dark: /\.dxf$/i.test(file.name) } : null;
}

let inspector;
export function inspectPreview(source, opener) {
  if (!source) return;
  if (!inspector) {
    inspector = document.createElement('dialog');
    inspector.className = 'file-inspector';
    inspector.setAttribute('aria-labelledby', 'fileInspectorTitle');
    inspector.innerHTML = `<header><div><strong id="fileInspectorTitle"></strong><p>Source preview</p></div><button type="button" class="ghost" autofocus>Close <span aria-hidden="true">×</span></button></header><asset-preview expanded></asset-preview>`;
    document.body.append(inspector);
    inspector.querySelector('button').onclick = () => inspector.close();
    inspector.addEventListener('click', event => {
      if (event.target !== inspector) return;
      const box = inspector.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) inspector.close();
    });
    // Escape must close only this inspector, leaving a library picker underneath open.
    inspector.addEventListener('keydown', event => event.stopPropagation());
    inspector.addEventListener('close', () => {
      inspector.querySelector('asset-preview').source = null;
      if (inspector.opener?.isConnected) inspector.opener.focus({ preventScroll: true });
      inspector.opener = null;
    });
  }
  inspector.opener = opener;
  inspector.querySelector('strong').textContent = source.name || 'File preview';
  const size = source.file ? ` · ${(source.file.size / 1024).toFixed(1)} KB` : '';
  inspector.querySelector('header p').textContent = `Source preview${size} · zoom and pan to inspect`;
  inspector.querySelector('asset-preview').source = source.detail
    ? { ...source, src: null, loadFile: source.detail } : source;
  if (!inspector.open) inspector.showModal();
}

export class AssetPreview extends HTMLElement {
  connectedCallback() {
    if (!this.viewport) this.build();
    this.observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) this.load();
    });
    this.observer.observe(this);
  }

  disconnectedCallback() {
    this.observer?.disconnect();
    this.release();
  }

  get source() { return this._source; }
  set source(value) {
    const old = this._source;
    if (old && value && old.file === value.file && old.src === value.src && old.name === value.name
      && old.loadFile === value.loadFile && old.dark === value.dark) return;
    this.release();
    this._source = value;
    this.hidden = !value;
    if (!this.viewport) return;
    this.viewport.setAttribute('aria-label', `${value?.name || 'File'} preview. Scroll to zoom, drag to pan. Use plus, minus, arrow keys or 0 to fit.`);
    this.dataset.tone = value?.dark ? 'dark' : 'light';
    this.fit();
    this.setState('loading', 'Loading preview…');
    this.observer?.unobserve(this);
    this.observer?.observe(this);
  }

  build() {
    this.innerHTML = `<div class="file-preview-viewport" tabindex="0" role="group">
      <img class="file-preview-image" draggable="false" alt="">
      <div class="file-preview-message" role="status"><span>Loading preview…</span><button type="button" class="ghost" hidden>Retry</button></div>
      </div><div class="file-preview-toolbar" role="group" aria-label="Preview controls">
      <button type="button" class="ghost" data-action="out" aria-label="Zoom out" title="Zoom out (−)">−</button>
      <output class="file-preview-zoom" aria-label="Zoom relative to fitted view">100%</output>
      <button type="button" class="ghost" data-action="in" aria-label="Zoom in" title="Zoom in (+)">+</button>
      <button type="button" class="ghost" data-action="fit" title="Fit preview (0)">Fit</button>
      <button type="button" class="ghost" data-action="background" aria-label="Toggle light or dark preview background" title="Toggle light / dark background">◐</button>
      <button type="button" class="ghost file-preview-expand" data-action="expand" title="Open a larger preview">Expand ↗</button>
      </div><div class="file-preview-hint">Scroll to zoom · Drag to pan</div>`;
    this.viewport = this.querySelector('.file-preview-viewport');
    this.img = this.querySelector('img');
    this.message = this.querySelector('.file-preview-message');
    this.retry = this.message.querySelector('button');
    this.zoomLabel = this.querySelector('output');
    this.querySelector('[data-action="expand"]').hidden = this.hasAttribute('expanded');
    this.retry.onclick = () => { this.release(); this.load(); };
    // Preview interaction must not select a library entry or open a project.
    this.addEventListener('click', event => event.stopPropagation());
    this.addEventListener('pointerdown', event => event.stopPropagation());
    this.querySelector('.file-preview-toolbar').addEventListener('click', event => {
      const action = event.target.closest('button')?.dataset.action;
      if (action === 'fit') this.fit();
      if (action === 'in') this.zoomAt(1.4);
      if (action === 'out') this.zoomAt(1 / 1.4);
      if (action === 'background') this.dataset.tone = this.dataset.tone === 'dark' ? 'light' : 'dark';
      if (action === 'expand') inspectPreview(this.source, event.target.closest('button'));
    });
    this.viewport.addEventListener('wheel', event => {
      if (this.dataset.state !== 'ready') return;
      event.preventDefault(); event.stopPropagation();
      const box = this.viewport.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.height : 1);
      this.zoomAt(Math.exp(-limit(delta, -200, 200) * .005), event.clientX - box.left - box.width / 2, event.clientY - box.top - box.height / 2);
    }, { passive: false });
    this.viewport.addEventListener('pointerdown', event => {
      if (event.button !== 0 || this.dataset.state !== 'ready' || this.drag) return;
      event.preventDefault();
      this.viewport.focus({ preventScroll: true });
      this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      this.viewport.setPointerCapture(event.pointerId);
      this.viewport.classList.add('dragging');
    });
    this.viewport.addEventListener('pointermove', event => {
      if (this.drag?.id !== event.pointerId) return;
      this.x += event.clientX - this.drag.x; this.y += event.clientY - this.drag.y;
      this.drag.x = event.clientX; this.drag.y = event.clientY;
      this.paint();
    });
    const stopDrag = event => {
      if (this.drag?.id !== event.pointerId) return;
      this.drag = null; this.viewport.classList.remove('dragging');
      if (this.viewport.hasPointerCapture(event.pointerId)) this.viewport.releasePointerCapture(event.pointerId);
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) this.viewport.addEventListener(type, stopDrag);
    this.viewport.addEventListener('dblclick', () => this.fit());
    this.viewport.addEventListener('keydown', event => {
      if (!['+', '=', '-', '0', 'Home', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      if (['+', '='].includes(event.key)) this.zoomAt(1.4);
      else if (event.key === '-') this.zoomAt(1 / 1.4);
      else if (['0', 'Home'].includes(event.key)) this.fit();
      else {
        this.x += event.key === 'ArrowLeft' ? -30 : event.key === 'ArrowRight' ? 30 : 0;
        this.y += event.key === 'ArrowUp' ? -30 : event.key === 'ArrowDown' ? 30 : 0;
        this.paint();
      }
    });
    const source = this._source;
    this._source = null;
    this.source = source;
  }

  release() {
    this.request?.abort();
    this.request = null;
    if (this.img) { this.img.onload = this.img.onerror = null; this.img.removeAttribute('src'); }
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.started = false;
    if (this.drag && this.viewport.hasPointerCapture(this.drag.id)) this.viewport.releasePointerCapture(this.drag.id);
    this.drag = null;
    this.viewport?.classList.remove('dragging');
  }

  async load() {
    if (!this.source || this.started || !this.isConnected) return;
    this.started = true;
    const request = this.request = new AbortController();
    const source = this.source;
    this.setState('loading', 'Loading preview…');
    try {
      const file = source.loadFile ? await source.loadFile() : source.file;
      const blob = file ? await previewBlob(file, request.signal) : null;
      if (request.signal.aborted) return;
      const url = blob ? (this.objectUrl = URL.createObjectURL(blob)) : source.src;
      this.img.alt = source.name || 'File preview';
      this.img.onload = () => {
        if (!request.signal.aborted) { this.setState('ready'); this.fit(); }
      };
      this.img.onerror = () => {
        if (!request.signal.aborted) this.setState('error', 'Preview unavailable. Try loading the file again.');
      };
      this.img.src = url;
    } catch (error) {
      if (!request.signal.aborted) this.setState('error', error.message || 'Preview unavailable.');
    }
  }

  setState(state, text = '') {
    this.dataset.state = state;
    this.message.hidden = state === 'ready';
    this.message.querySelector('span').textContent = text;
    this.retry.hidden = state !== 'error';
    this.viewport.setAttribute('aria-busy', String(state === 'loading'));
    for (const button of this.querySelectorAll('[data-action]')) button.disabled = state !== 'ready' && button.dataset.action !== 'expand';
  }

  fit() { this.zoom = 1; this.x = this.y = 0; this.paint(); }
  zoomAt(factor, x = 0, y = 0) {
    const zoom = limit(this.zoom * factor, .1, 32), ratio = zoom / this.zoom;
    this.x = x - (x - this.x) * ratio; this.y = y - (y - this.y) * ratio;
    this.zoom = zoom; this.paint();
  }
  paint() {
    if (!this.img) return;
    this.img.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.zoom})`;
    this.zoomLabel.value = `${Math.round(this.zoom * 100)}%`;
  }
}

customElements.define('asset-preview', AssetPreview);
