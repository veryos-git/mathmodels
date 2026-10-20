import { ShaderRenderer } from './vendor/shadertrace/renderer.js';
import { SHADER_STYLES, shaderSettings, sourceShader, shaderBundle } from './shader-preview.js';

function download(blob, name) {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** One GPU canvas, shared by project inputs and library/file previews. */
export class ShaderInspector {
  constructor(getSources) {
    this.getSources = getSources;
    this.settings = shaderSettings();
    this.revision = 0;
    this.time = 0;
    document.addEventListener('visibilitychange', () => {
      this.stop();
      if (!document.hidden) this.animate();
    });
  }

  snapshot() { return { ...this.settings }; }
  restore(value) {
    this.dialog?.close();
    this.settings = shaderSettings(value);
    this.time = 0;
  }

  build() {
    const dialog = this.dialog = document.createElement('dialog');
    dialog.className = 'shader-inspector';
    dialog.setAttribute('aria-labelledby', 'shaderInspectorTitle');
    dialog.innerHTML = `
      <header><div><strong id="shaderInspectorTitle">Shader preview</strong>
        <p>Explore the paths and cross-sections in your project.</p></div>
        <button type="button" class="ghost" data-action="close" autofocus>Close ×</button></header>
      <div class="shader-layout">
        <div class="shader-stage">
          <canvas width="512" height="512" aria-label="Animated shader visualization"></canvas>
          <p class="shader-message" role="status"></p>
        </div>
        <div class="shader-controls">
          <label>Drawing or profile<select data-field="source"></select></label>
          <label>Visual style<select data-field="style"></select></label>
          <p class="shader-description"></p>
          <label>Geometry<select data-field="mode">
            <option value="auto">Automatic — based on input role</option>
            <option value="outline">Path outlines</option>
            <option value="filled">Filled closed shapes</option>
          </select></label>
          <div class="shader-control-row">
            <label>Curve detail<select data-field="tolerance">
              <option value="0.008">Fast</option><option value="0.002">Balanced</option>
              <option value="0.0005">Fine</option></select></label>
            <label>Resolution<select data-field="resolution">
              <option value="256">256 × 256</option><option value="512">512 × 512</option>
              <option value="1024">1024 × 1024</option></select></label>
          </div>
          <label>Outline width <span class="muted">(shader units)</span>
            <input data-field="strokeWidth" type="number" min="0.001" max="0.2" step="0.001"></label>
          <label>Loop length <span class="muted">(seconds)</span>
            <input data-field="duration" type="number" min="1" max="60" step="1"></label>
          <div class="shader-actions">
            <button type="button" class="ghost" data-action="play">Pause</button>
            <button type="button" class="ghost" data-action="restart">Restart</button>
            <button type="button" class="ghost" data-action="retry">Regenerate</button>
          </div>
          <label>Animation time <output data-time-label>0.00 s</output>
            <input data-time type="range" min="0" max="8" step="0.01" value="0"></label>
          <p class="shader-stats"></p>
          <p class="shader-warnings" role="status"></p>
          <div class="shader-actions">
            <button type="button" class="ghost" data-action="png" disabled>Save PNG</button>
            <button type="button" class="ghost" data-action="shader" disabled>Save shader bundle</button>
          </div>
          <p class="shader-note">Sources are centered and fitted to the canvas. Preview settings are saved with the project.
            The shader bundle contains GLSL, uniforms and draw passes.</p>
          <p class="shader-note">Powered by <a href="https://github.com/jonasfrey/shadertracev2" target="_blank" rel="noopener">Shadertrace</a> · WebGL 2</p>
        </div>
      </div>`;
    document.body.append(dialog);
    this.canvas = dialog.querySelector('canvas');
    this.message = dialog.querySelector('.shader-message');
    this.fields = Object.fromEntries([...dialog.querySelectorAll('[data-field]')].map(el => [el.dataset.field, el]));
    const categories = new Map();
    for (const style of SHADER_STYLES) {
      if (!categories.has(style.category)) {
        const group = document.createElement('optgroup');
        group.label = style.category;
        categories.set(style.category, group);
        this.fields.style.append(group);
      }
      categories.get(style.category).append(new Option(`${style.catalogNumber}. ${style.name}`, style.id));
    }
    dialog.addEventListener('keydown', event => event.stopPropagation());
    dialog.addEventListener('close', () => {
      // Native close events are queued. A newer open may already be using this
      // shared canvas by the time the previous close event is delivered.
      if (dialog.open) return;
      this.revision++;
      this.stop();
      this.renderer?.dispose();
      this.renderer = null;
      this.ready = false;
      this.sources = [];
      this.current = null;
      if (this.opener?.isConnected) this.opener.focus({ preventScroll: true });
    });
    dialog.addEventListener('click', event => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (action === 'close') dialog.close();
      if (action === 'play') {
        this.settings.playing = !this.settings.playing;
        this.stop(); this.updateTime(); this.animate();
      }
      if (action === 'restart') { this.time = 0; this.lastFrame = 0; this.render(); }
      if (action === 'retry') this.compile();
      if (action === 'png') this.savePng();
      if (action === 'shader') this.saveShader();
    });
    for (const [name, field] of Object.entries(this.fields)) {
      field.addEventListener('change', () => {
        this.settings = shaderSettings({ ...this.settings, [name]: field.value });
        this.syncControls();
        if (name === 'duration') {
          this.time %= this.settings.duration; this.render();
        } else if (name === 'resolution' && this.ready) {
          try { this.renderer.resize(this.settings.resolution, this.settings.resolution); this.render(); }
          catch (error) { this.fail(error); }
        } else this.compile();
      });
    }
    dialog.querySelector('[data-time]').addEventListener('input', event => {
      this.settings.playing = false;
      this.stop(); this.time = Number(event.target.value); this.render();
    });
    this.canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      this.revision++;
      this.fail(new Error('The GPU context was lost. The preview will reload when it becomes available.'));
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.renderer = null;
      if (dialog.open) this.compile();
    });
  }

  open(source = null, opener = document.activeElement) {
    if (!this.dialog) this.build();
    this.opener = opener;
    this.sources = this.getSources().filter(item => item.file && /\.(svg|dxf)$/i.test(item.file.name));
    let selected = this.settings.source;
    if (source) {
      const match = this.sources.find(item => item.file === source.file);
      if (match) selected = match.id;
      else {
        selected = 'inspected-file';
        this.sources.push({ id: selected, label: 'File preview', name: source.name, file: source.file,
          loadFile: source.detail || source.loadFile, mode: 'outline' });
      }
    }
    if (!this.sources.some(item => item.id === selected)) selected = this.sources[0]?.id || '';
    this.settings.source = selected;
    this.fields.source.replaceChildren(...this.sources.map(item =>
      new Option(`${item.label} · ${item.file?.name || item.name}`, item.id)));
    this.fields.source.disabled = !this.sources.length;
    this.syncControls();
    if (!this.dialog.open) this.dialog.showModal();
    this.compile();
  }

  syncControls() {
    for (const [name, field] of Object.entries(this.fields)) field.value = this.settings[name];
    const style = SHADER_STYLES.find(item => item.id === this.settings.style);
    this.dialog.querySelector('.shader-description').textContent = style.description;
    this.dialog.querySelector('[data-time]').max = this.settings.duration;
    this.updateTime();
  }

  state(value, message = '') {
    this.dialog.dataset.state = value;
    this.message.textContent = message;
    this.message.hidden = value === 'ready';
    this.canvas.hidden = value !== 'ready';
    this.canvas.setAttribute('aria-busy', String(value === 'loading'));
    for (const name of ['png', 'shader', 'play', 'restart']) {
      this.dialog.querySelector(`[data-action="${name}"]`).disabled = value !== 'ready';
    }
    this.dialog.querySelector('[data-time]').disabled = value !== 'ready';
  }

  async compile() {
    const revision = ++this.revision;
    this.stop(); this.ready = false; this.current = null;
    this.dialog.querySelector('.shader-stats').textContent = '';
    this.dialog.querySelector('.shader-warnings').textContent = '';
    const source = this.sources.find(item => item.id === this.settings.source);
    if (!source) { this.state('empty', 'Upload a DXF or SVG drawing or profile to see its shader preview.'); return; }
    this.state('loading', 'Generating shader from the source paths…');
    // Let the browser paint the loading state before parsing and compiling.
    await new Promise(resolve => setTimeout(resolve, 20));
    if (revision !== this.revision || !this.dialog.open) return;
    const settings = this.snapshot();
    try {
      if (!source.file && source.loadFile) source.file = await source.loadFile();
      if (revision !== this.revision || !this.dialog.open) return;
      const conversion = await sourceShader(source, settings);
      if (revision !== this.revision || !this.dialog.open) return;
      if (!this.renderer) this.renderer = new ShaderRenderer(this.canvas);
      if (this.renderer.gl.isContextLost()) throw new Error('Waiting for the GPU context to recover.');
      const style = SHADER_STYLES.find(item => item.id === settings.style);
      const result = this.renderer.compile(conversion.code, style.code);
      if (!result.ok) throw new Error(result.errors.map(error => error.message).join('\n'));
      this.renderer.resize(settings.resolution, settings.resolution);
      this.current = { source, conversion };
      this.ready = true;
      this.dialog.querySelector('.shader-stats').textContent =
        `${conversion.stats.segments} segments · ${conversion.stats.shapes} shape groups · ${settings.mode === 'auto' ? source.mode || 'outline' : settings.mode}`
        + (source.layers ? ` · layers: ${source.layers.join(', ')}` : '');
      const warnings = [...conversion.warnings];
      if (style.catalogNumber >= 57 || style.category === 'Relief & materials') {
        warnings.push('This style samples the field repeatedly. Use Fast detail or 256 × 256 for complex drawings.');
      }
      this.dialog.querySelector('.shader-warnings').textContent = warnings.join(' ');
      this.state('ready');
      this.render(); this.animate();
    } catch (error) {
      if (revision === this.revision && this.dialog.open) this.fail(error);
    }
  }

  fail(error) {
    this.stop(); this.ready = false;
    this.state('error', `${error.message || 'Shader preview failed.'} Try Fast detail or another source.`);
  }

  render() {
    if (this.ready) this.renderer.render(this.time, this.settings.duration, Math.floor(this.time * 30));
    this.updateTime();
  }

  updateTime() {
    if (!this.dialog) return;
    this.dialog.querySelector('[data-action="play"]').textContent = this.settings.playing ? 'Pause' : 'Play';
    this.dialog.querySelector('[data-time]').value = this.time;
    this.dialog.querySelector('[data-time-label]').textContent = `${this.time.toFixed(2)} s`;
  }

  animate() {
    if (this.raf || !this.ready || !this.dialog.open || !this.settings.playing || document.hidden) return;
    const tick = stamp => {
      this.raf = 0;
      if (!this.ready || !this.dialog.open || !this.settings.playing || document.hidden) return;
      if (!this.lastFrame) this.lastFrame = stamp;
      const elapsed = stamp - this.lastFrame;
      if (elapsed >= 1000 / 30) {
        this.time = (this.time + Math.min(elapsed, 250) / 1000) % this.settings.duration;
        this.lastFrame = stamp;
        this.render();
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = this.lastFrame = 0;
  }

  exportName() {
    return `${this.current.source.file.name.replace(/\.(svg|dxf)$/i, '')}-${this.settings.style}`;
  }

  savePng() {
    if (!this.ready) return;
    this.render();
    const name = this.exportName();
    this.canvas.toBlob(blob => { if (blob) download(blob, `${name}.png`); }, 'image/png');
  }

  saveShader() {
    if (!this.ready) return;
    const { source, conversion } = this.current;
    const bundle = shaderBundle(source, this.snapshot(), conversion, this.renderer.sources, this.time);
    download(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }), `${this.exportName()}.shader.json`);
  }
}
