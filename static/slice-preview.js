/** Editable CNC slice list and Z-up preview planes. No geometry is exported here. */
export function initSlicePreview({ THREE, scene, modelGroup, list, addButton,
  exportButton, rangeLabel, exportSlices, reportError }) {
  const planes = new THREE.Group();
  planes.name = 'CNC slice planes';
  scene.add(planes); // Outside the model: cannot affect framing or face picking.
  let rows = [], bounds = null, busy = false, nextId = 1;

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

  async function download(selected) {
    if (busy || !selected.every(r => r.input.reportValidity())) return;
    const entries = selected.map(r => ({ id: r.id, height: r.input.valueAsNumber, color: r.color }));
    busy = true;
    refresh();
    try { await exportSlices(entries); }
    catch (error) { reportError(error); }
    finally { busy = false; refresh(); }
  }

  function remove(row) {
    planes.remove(row.plane);
    row.plane.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
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
    const row = { id, color, hue: hsl.h * 360, element, plane,
      input: element.querySelector('.slice-height'), show: element.querySelector('.slice-show'),
      error: element.querySelector('.slice-error'), download: element.querySelector('.slice-download'),
      remove: element.querySelector('.slice-remove') };
    const depth = bounds ? bounds.max.z - bounds.min.z : 1;
    row.input.value = Number.isFinite(saved.height) && saved.height >= 0
      ? saved.height : Number((depth * (rows.length + 1) / (rows.length + 2)).toPrecision(6));
    row.show.checked = saved.visible !== false;
    row.input.oninput = row.show.onchange = refresh;
    row.remove.onclick = () => remove(row);
    row.download.onclick = () => download([row]);
    rows.push(row);
    list.append(element);
    refresh();
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
  }

  addButton.onclick = () => {
    if (!busy && bounds) { const row = add(); row.input.focus(); row.input.select(); }
  };
  exportButton.onclick = () => download(rows);
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
