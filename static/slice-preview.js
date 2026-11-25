/**
 * Editable CNC slice list: a Z-up preview plane, an SVG outline and a shader
 * render per slice, and their downloads. The page supplies the geometry.
 */
export function initSlicePreview({ THREE, scene, modelGroup, list, addButton,
  exportButton, rangeLabel, sliceSource, renderSlice, zipFiles, saveBlob, inspect,
  reportStatus, reportError }) {
  const planes = new THREE.Group();
  planes.name = 'CNC slice planes';
  scene.add(planes); // Outside the model: cannot affect framing or face picking.
  let rows = [], bounds = null, busy = false, nextId = 1;
  // Each preview is a server round trip, so they wait for edits to settle and
  // for the list to be on screen, then load one at a time.
  let previewTimer = 0, previewPass = 0;
  let onScreen = typeof IntersectionObserver !== 'function';
  if (!onScreen) {
    new IntersectionObserver(entries => {
      onScreen = entries.at(-1).isIntersecting;
      if (onScreen) queuePreviews();
    }).observe(list);
  }

  function randomColor() {
    // Pick randomly from a spread of hues, avoiding near neighbours where possible.
    const hues = Array.from({ length: 24 }, (_, i) => i * 15);
    const free = hues.filter(h => rows.every(r => {
      const delta = Math.abs(h - r.hue);
      return Math.min(delta, 360 - delta) >= 30;
    }));
    const unused = hues.filter(h => rows.every(r => Math.abs(h - r.hue) > .01));
    const choices = free.length ? free : unused;
    const hue = choices.length ? choices[Math.floor(Math.random() * choices.length)] : Math.random() * 360;
    const color = new THREE.Color().setHSL(hue / 360, .8, .6).getHexString();
    return { hue, color: '#' + color };
  }

  function refresh() {
    const depth = bounds ? bounds.max.z - bounds.min.z : 0;
    rangeLabel.textContent = bounds
      ? `Heights above model base: 0 ≤ height < ${Number(depth.toFixed(6))} mm.`
      : 'Generate a model to position slices.';
    addButton.disabled = busy || !bounds;
    let allValid = rows.length > 0;
    for (const row of rows) {
      const height = row.input.valueAsNumber;
      const valid = !!bounds && Number.isFinite(height) && height >= 0 && height < depth;
      allValid &&= valid;
      const message = !bounds ? 'Generate the model first.' : !valid
        ? `Enter a height from 0 to below ${Number(depth.toFixed(6))} mm.` : '';
      row.input.setCustomValidity(message);
      row.error.textContent = message;
      row.error.hidden = !message;
      row.input.setAttribute('aria-invalid', String(!valid));
      row.download.disabled = busy || !valid;
      row.input.disabled = row.remove.disabled = row.show.disabled = busy;
      row.plane.visible = valid && row.show.checked;
      row.valid = valid;
      row.preview.hidden = !valid;
      if (bounds && valid) {
        const width = Math.max(bounds.max.x - bounds.min.x, .01) * 1.12;
        const length = Math.max(bounds.max.y - bounds.min.y, .01) * 1.12;
        row.plane.scale.set(width, length, 1);
        row.plane.position.set((bounds.min.x + bounds.max.x) / 2,
          (bounds.min.y + bounds.max.y) / 2, bounds.min.z + height);
      }
    }
    exportButton.disabled = busy || !allValid;
    exportButton.hidden = rows.length === 0;
    list.dataset.count = String(rows.length);
  }

  function snapshot() {
    return rows.map(r => ({ height: r.input.valueAsNumber, color: r.color, visible: r.show.checked }));
  }

  /**
   * What the row's preview area says. The thumbnails are dimmed while `loading`
   * or `stale`, hidden on `error`, and open a larger view only when `ready`.
   */
  function notePreview(row, state, text = '') {
    row.preview.dataset.state = state;
    row.note.textContent = text;
    row.note.hidden = !text;
    row.outline.disabled = state !== 'ready';
    row.render.disabled = state !== 'ready' || !row.shot?.render;
  }

  /** Show a shot in its row, or nothing; the row keeps it until the model or the height changes. */
  function showShot(row, shot, outline) {
    row.shot = shot;
    row.outline.replaceChildren(...(shot ? [outline] : []));
    if (row.renderUrl) URL.revokeObjectURL(row.renderUrl);
    row.renderUrl = shot?.render ? URL.createObjectURL(shot.render) : '';
    if (row.renderUrl) row.image.src = row.renderUrl;
    else row.image.removeAttribute('src');
  }

  const settle = row => notePreview(row, 'ready',
    row.shot.renderError && `Shader render unavailable: ${row.shot.renderError}`);
  const shotKey = (row, source) => `${row.input.valueAsNumber} ${source.key}`;

  /** Abandon whatever the row is loading. */
  function cancel(row) {
    row.loading?.request.abort();
    row.loading = null;
  }

  /** The slice's SVG and render for this model, loaded unless the row already shows or awaits them. */
  function shoot(row, source) {
    const height = row.input.valueAsNumber, key = shotKey(row, source);
    if (row.loading?.key === key) return row.loading.promise;
    cancel(row);
    if (row.shot?.key === key) { settle(row); return Promise.resolve(row.shot); }
    const request = new AbortController(), loading = row.loading = { key, request };
    notePreview(row, 'loading', row.shot ? 'Updating preview…' : 'Loading preview…');
    return loading.promise = (async () => {
      try {
        const svg = new DOMParser().parseFromString(await source.load(height, request.signal), 'image/svg+xml');
        if (svg.querySelector('parsererror')) throw new Error('The server returned an invalid SVG.');
        // Cutting outlines take the slice's colour, like its plane.
        for (const node of svg.querySelectorAll('[stroke]')) {
          if (node.getAttribute('stroke') !== 'none') node.setAttribute('stroke', row.color);
        }
        const shot = { key, height, svg: new XMLSerializer().serializeToString(svg), render: null, renderError: '' };
        try { shot.render = await renderSlice(shot.svg, row.color); }
        catch (error) { shot.renderError = String(error.message ?? error); }
        // Abandoned meanwhile: whoever asked still gets the shot, but the row has moved on.
        if (row.loading === loading) {
          const outline = document.importNode(svg.documentElement, true);
          // The thumbnail sizes it; the file keeps its millimetres.
          outline.removeAttribute('width');
          outline.removeAttribute('height');
          row.loading = row.failed = null;
          showShot(row, shot, outline);
          settle(row);
        }
        return shot;
      } catch (error) {
        if (row.loading === loading) {
          row.loading = null;
          row.failed = { key, reason: String(error.message ?? error) };
          showShot(row, null);
          notePreview(row, 'error', row.failed.reason);
        }
        throw error;
      }
    })();
  }

  function queuePreviews() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(loadPreviews, 350);
  }

  async function loadPreviews() {
    const pass = ++previewPass;
    const wanted = rows.filter(row => row.valid);
    if (busy || !onScreen || !wanted.length) return;
    let source;
    try { source = sliceSource(); }
    catch (error) {
      // Nothing can be exported right now, so what is shown may no longer match.
      for (const row of wanted) {
        cancel(row);
        notePreview(row, row.shot ? 'stale' : 'error', String(error.message ?? error));
      }
      return;
    }
    // A request for a height or model that has since changed is abandoned. One
    // that is still wanted keeps running and goes first, so requests stay in turn.
    for (const row of rows) if (!row.valid || row.loading?.key !== shotKey(row, source)) cancel(row);
    wanted.sort((a, b) => !!b.loading - !!a.loading);
    for (const row of wanted) {
      // A height that already failed for this model keeps its reason until either changes.
      if (row.failed?.key === shotKey(row, source)) { notePreview(row, 'error', row.failed.reason); continue; }
      await shoot(row, source).catch(() => {});
      if (pass !== previewPass || !onScreen) return;
    }
  }

  async function download(selected, bundle) {
    if (busy || !selected.every(r => r.input.reportValidity())) return;
    busy = true;
    previewPass++; // The download takes over; it reuses what is shown or already on its way.
    refresh();
    try {
      // Freeze geometry/settings and the filename for the complete batch.
      const source = sliceSource(), files = [];
      for (const [i, row] of selected.entries()) {
        const height = row.input.valueAsNumber, name = `${source.name}-slice-${row.id}-${height}mm`;
        reportStatus(`exporting slice ${row.id} at ${height} mm (${i + 1}/${selected.length})…`);
        const shot = await shoot(row, source).catch(error => {
          throw new Error(`Slice ${row.id} at ${height} mm: ${error.message ?? error}`);
        });
        files.push({ name: `${name}.svg`, data: shot.svg });
        if (bundle && shot.render) files.push({ name: `${name}.png`, data: shot.render });
      }
      if (bundle) {
        saveBlob(await zipFiles(files), 'application/zip', `${source.name}-slices.zip`);
        const renders = files.length - selected.length, missing = selected.length - renders;
        reportStatus(`saved ${selected.length} slice SVG${selected.length === 1 ? '' : 's'} and `
          + `${renders} render${renders === 1 ? '' : 's'} in one zip`
          + (missing ? `\n${missing} shader render${missing === 1 ? ' is' : 's are'} unavailable; see the slice list.` : ''));
      } else {
        saveBlob(files[0].data, 'image/svg+xml', files[0].name);
        reportStatus('saved 1 slice SVG');
      }
    } catch (error) { reportError(error); }
    finally { busy = false; refresh(); queuePreviews(); }
  }

  function remove(row) {
    planes.remove(row.plane);
    row.plane.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
    cancel(row);
    showShot(row, null);
    row.element.remove();
    rows = rows.filter(r => r !== row);
    refresh();
  }

  function add(saved = {}) {
    const id = nextId++;
    const random = randomColor();
    const color = /^#[0-9a-f]{6}$/i.test(saved.color ?? '') ? saved.color : random.color;
    const hsl = {};
    new THREE.Color(color).getHSL(hsl);
    const element = document.createElement('div');
    element.className = 'slice-row';
    element.style.setProperty('--slice-color', color);
    element.innerHTML = `<div class="slice-heading"><span class="slice-chip" aria-hidden="true"></span>
      <strong>Slice ${id}</strong><label class="check"><input class="slice-show" type="checkbox" checked> Show plane</label></div>
      <label for="cnc-slice-${id}">Height above model base (mm)</label>
      <input id="cnc-slice-${id}" class="slice-height" type="number" min="0" step="any" required>
      <div class="slice-error" role="status" hidden></div>
      <div class="slice-preview" hidden>
        <figure><button class="slice-thumb slice-outline" aria-label="Enlarge the SVG outline of slice ${id}" disabled></button>
          <figcaption>SVG outline</figcaption></figure>
        <figure><button class="slice-thumb slice-render" aria-label="Enlarge the shader render of slice ${id}" disabled><img alt=""></button>
          <figcaption>Shader render</figcaption></figure>
        <div class="slice-note" role="status" hidden></div>
      </div>
      <div class="btn-row"><button class="slice-download">Download SVG</button>
      <button class="slice-remove ghost" aria-label="Remove slice ${id}">Remove</button></div>`;
    const plane = new THREE.Group();
    plane.name = `Slice ${id}`;
    const surface = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .18,
        side: THREE.DoubleSide, depthWrite: false }));
    const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-.5, -.5, 0), new THREE.Vector3(.5, -.5, 0),
      new THREE.Vector3(.5, .5, 0), new THREE.Vector3(-.5, .5, 0),
    ]), new THREE.LineBasicMaterial({ color, transparent: true, opacity: .9, depthWrite: false }));
    plane.add(surface, outline);
    planes.add(plane);
    const row = { id, color, hue: hsl.h * 360, element, plane, valid: false, shot: null, loading: null, failed: null,
      input: element.querySelector('.slice-height'), show: element.querySelector('.slice-show'),
      error: element.querySelector('.slice-error'), download: element.querySelector('.slice-download'),
      remove: element.querySelector('.slice-remove'), preview: element.querySelector('.slice-preview'),
      outline: element.querySelector('.slice-outline'), render: element.querySelector('.slice-render'),
      image: element.querySelector('.slice-render img'), note: element.querySelector('.slice-note') };
    const depth = bounds ? bounds.max.z - bounds.min.z : 1;
    row.input.value = Number.isFinite(saved.height) && saved.height >= 0
      ? saved.height : Number((depth * (rows.length + 1) / (rows.length + 2)).toPrecision(6));
    row.show.checked = saved.visible !== false;
    row.show.onchange = refresh;
    row.input.oninput = () => { refresh(); queuePreviews(); };
    row.remove.onclick = () => remove(row);
    row.download.onclick = () => download([row], false);
    const stem = () => `slice-${id}-${row.shot.height}mm`;
    row.outline.onclick = () => row.shot && inspect(
      new File([row.shot.svg], `${stem()}.svg`, { type: 'image/svg+xml' }), row.outline);
    row.render.onclick = () => row.shot?.render && inspect(
      new File([row.shot.render], `${stem()}.png`, { type: 'image/png' }), row.render);
    rows.push(row);
    list.append(element);
    notePreview(row, 'loading', 'Loading preview…');
    refresh();
    queuePreviews();
    return row;
  }

  function clear() {
    for (const row of [...rows]) remove(row);
    nextId = 1;
  }

  function syncModel() {
    modelGroup.updateWorldMatrix(true, true);
    const box = new THREE.Box3();
    modelGroup.traverse(o => {
      // Invisible zero-height slabs are not part of the exported model.
      if (!o.isMesh || !o.visible) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      if (o.geometry.boundingBox) box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));
    });
    bounds = box.isEmpty() ? null : box;
    refresh();
    queuePreviews();
  }

  addButton.onclick = () => {
    if (!busy && bounds) { const row = add(); row.input.focus(); row.input.select(); }
  };
  exportButton.onclick = () => download(rows, true);
  refresh();
  return { syncModel, snapshot, clear, planes,
    restore(saved) {
      clear();
      for (const slice of Array.isArray(saved) ? saved : []) {
        if (slice && Number.isFinite(slice.height) && slice.height >= 0) add(slice);
      }
    },
  };
}
