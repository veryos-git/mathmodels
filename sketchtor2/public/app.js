/* Line Tracer frontend — three-zone workspace: projects / canvas / controls. */
"use strict";

const $ = (id) => document.getElementById(id);
const els = {
  projectList: $("projectList"),
  btnNew: $("btnNew"),
  fileInput: $("fileInput"),
  viewport: $("viewport"),
  stage: $("stage"),
  origImg: $("origImg"),
  svgLayer: $("svgLayer"),
  splitDivider: $("splitDivider"),
  emptyState: $("emptyState"),
  spinner: $("spinner"),
  btnFit: $("btnFit"),
  zoomLabel: $("zoomLabel"),
  stats: $("stats"),
  statsDetail: $("statsDetail"),
  projectName: $("projectName"),
  dirtyDot: $("dirtyDot"),
  threshold: $("threshold"),
  strokeWidth: $("strokeWidth"),
  simplify: $("simplify"),
  smoothing: $("smoothing"),
  skeletonize: $("skeletonize"),
  invert: $("invert"),
  despeckle: $("despeckle"),
  minArea: $("minArea"),
  btnTrace: $("btnTrace"),
  btnDownload: $("btnDownload"),
  btnSave: $("btnSave"),
  menu: $("menu"),
};

const state = {
  projects: [],
  current: null, // project meta {id, name, source, params, ...}
  dirty: false,
  svg: "",
  view: "svg", // original | svg | split | overlay
  scale: 1,
  panX: 0,
  panY: 0,
  splitPos: 0.5,
  imgW: 0,
  imgH: 0,
};

/* ---------------- API ---------------- */

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ---------------- Params ---------------- */

const PARAM_CONTROLS = ["threshold", "strokeWidth", "simplify", "smoothing"];

function gatherParams() {
  return {
    traceMode: document.querySelector('input[name="traceMode"]:checked').value,
    threshold: +els.threshold.value,
    strokeWidth: +els.strokeWidth.value,
    simplify: +els.simplify.value,
    smoothing: +els.smoothing.value,
    skeletonize: els.skeletonize.checked,
    invert: els.invert.checked,
    minArea: els.despeckle.checked ? +els.minArea.value : 0,
  };
}

function applyParams(p) {
  document.querySelector(`input[name="traceMode"][value="${p.traceMode}"]`).checked = true;
  for (const key of PARAM_CONTROLS) els[key].value = p[key];
  els.skeletonize.checked = !!p.skeletonize;
  els.invert.checked = !!p.invert;
  els.despeckle.checked = p.minArea > 0;
  els.minArea.disabled = !els.despeckle.checked;
  if (p.minArea > 0) els.minArea.value = p.minArea;
  updateValLabels();
}

function updateValLabels() {
  for (const key of PARAM_CONTROLS) $(key + "Val").textContent = els[key].value;
  $("minAreaVal").textContent = els.minArea.value;
}

function markDirty() {
  state.dirty = true;
  els.dirtyDot.hidden = false;
  renderProjectList();
}

function markSaved() {
  state.dirty = false;
  els.dirtyDot.hidden = true;
  renderProjectList();
}

/* ---------------- Tracing ---------------- */

let traceSeq = 0;
let traceTimer = null;

function scheduleTrace() {
  clearTimeout(traceTimer);
  traceTimer = setTimeout(runTrace, 400);
}

async function runTrace() {
  if (!state.current) return;
  const seq = ++traceSeq;
  els.spinner.hidden = false;
  try {
    const params = gatherParams();
    const data = await api("/api/trace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: state.current.id, params }),
    });
    if (seq !== traceSeq) return; // a newer trace superseded this one
    state.svg = data.svg;
    els.svgLayer.innerHTML = data.svg;
    const svgEl = els.svgLayer.querySelector("svg");
    if (svgEl && state.imgW) {
      svgEl.setAttribute("width", state.imgW);
      svgEl.setAttribute("height", state.imgH);
    }
    applyView();
    showStats(data.stats);
    if (state.current) {
      state.current.params = params;
    }
  } catch (err) {
    console.error("trace failed:", err);
    els.stats.textContent = "trace failed: " + err.message;
  } finally {
    if (seq === traceSeq) els.spinner.hidden = true;
  }
}

function showStats(s) {
  const kb = (s.bytes / 1024).toFixed(1);
  els.stats.textContent = `${s.paths} paths · ${s.nodes} nodes · ${kb} KB`;
  els.statsDetail.textContent = `Output: ${s.paths} paths, ${s.nodes} nodes, ${kb} KB`;
}

/* ---------------- Projects ---------------- */

async function loadProjects() {
  state.projects = await api("/api/projects");
  renderProjectList();
}

function renderProjectList() {
  els.projectList.innerHTML = "";
  for (const p of state.projects) {
    const li = document.createElement("li");
    li.dataset.id = p.id;
    if (state.current && p.id === state.current.id) li.classList.add("active");

    const img = document.createElement("img");
    img.src = `/api/projects/${p.id}/thumbnail`;
    img.alt = "";

    const mid = document.createElement("div");
    const name = document.createElement("div");
    name.className = "pname";
    name.textContent =
      (state.current && p.id === state.current.id && state.dirty ? "● " : "") + p.name;
    const date = document.createElement("div");
    date.className = "pdate";
    date.textContent = new Date(p.updatedAt).toLocaleDateString();
    mid.append(name, date);

    const dots = document.createElement("button");
    dots.className = "dots";
    dots.textContent = "⋯";
    dots.title = "Project actions";
    dots.addEventListener("click", (e) => {
      e.stopPropagation();
      openMenu(p.id, e.clientX, e.clientY);
    });

    li.append(img, mid, dots);
    li.addEventListener("click", () => openProject(p.id));
    els.projectList.append(li);
  }
}

async function openProject(id) {
  const meta = await api(`/api/projects/${id}`);
  state.current = meta;
  els.projectName.value = meta.name;
  applyParams(meta.params);
  markSaved();
  els.emptyState.hidden = true;
  els.svgLayer.innerHTML = "";
  state.svg = "";
  els.stats.textContent = "";
  els.origImg.src = `/api/projects/${meta.id}/source?t=${Date.now()}`;
  runTrace();
}

async function saveProject() {
  if (!state.current) return;
  const name = els.projectName.value.trim() || "Untitled";
  const meta = await api("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: state.current.id, name, params: gatherParams() }),
  });
  state.current = meta;
  markSaved();
  await loadProjects();
}

async function uploadImage(file) {
  const form = new FormData();
  form.append("image", file);
  const meta = await api("/api/upload", { method: "POST", body: form });
  await loadProjects();
  await openProject(meta.id);
}

/* ---------------- Context menu ---------------- */

let menuProjectId = null;

function openMenu(id, x, y) {
  menuProjectId = id;
  els.menu.hidden = false;
  els.menu.style.left = Math.min(x, innerWidth - 150) + "px";
  els.menu.style.top = Math.min(y, innerHeight - 130) + "px";
}

function closeMenu() {
  els.menu.hidden = true;
  menuProjectId = null;
}

els.menu.addEventListener("click", async (e) => {
  const action = e.target.dataset.action;
  const id = menuProjectId;
  closeMenu();
  if (!action || !id) return;
  const proj = state.projects.find((p) => p.id === id);
  try {
    if (action === "rename") {
      const name = prompt("Rename project:", proj ? proj.name : "");
      if (name && name.trim()) {
        await api("/api/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, name: name.trim() }),
        });
        if (state.current && state.current.id === id) els.projectName.value = name.trim();
      }
    } else if (action === "duplicate") {
      await api("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ duplicateOf: id }),
      });
    } else if (action === "delete") {
      if (!confirm(`Delete “${proj ? proj.name : id}”? This cannot be undone.`)) return;
      await api(`/api/projects/${id}`, { method: "DELETE" });
      if (state.current && state.current.id === id) {
        state.current = null;
        els.stage.classList.add("hidden");
        els.emptyState.hidden = false;
        els.projectName.value = "";
      }
    }
    await loadProjects();
  } catch (err) {
    alert(err.message);
  }
});
document.addEventListener("click", (e) => {
  if (!els.menu.hidden && !els.menu.contains(e.target)) closeMenu();
});

/* ---------------- Canvas: pan / zoom / views ---------------- */

function applyTransform() {
  els.stage.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.scale})`;
  els.zoomLabel.textContent = Math.round(state.scale * 100) + "%";
}

function fitToScreen() {
  if (!state.imgW) return;
  const rect = els.viewport.getBoundingClientRect();
  const s = Math.min(rect.width / state.imgW, rect.height / state.imgH, 1) * 0.95;
  state.scale = s;
  state.panX = (rect.width - state.imgW * s) / 2;
  state.panY = (rect.height - state.imgH * s) / 2;
  applyTransform();
}

els.viewport.addEventListener(
  "wheel",
  (e) => {
    if (!state.current) return;
    e.preventDefault();
    const rect = els.viewport.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const next = Math.min(16, Math.max(0.05, state.scale * factor));
    state.panX = mx - ((mx - state.panX) / state.scale) * next;
    state.panY = my - ((my - state.panY) / state.scale) * next;
    state.scale = next;
    applyTransform();
  },
  { passive: false },
);

let drag = null;
els.viewport.addEventListener("pointerdown", (e) => {
  if (!state.current || e.target === els.splitDivider) return;
  drag = { x: e.clientX, y: e.clientY, panX: state.panX, panY: state.panY };
  els.viewport.classList.add("panning");
  els.viewport.setPointerCapture(e.pointerId);
});
els.viewport.addEventListener("pointermove", (e) => {
  if (!drag) return;
  state.panX = drag.panX + (e.clientX - drag.x);
  state.panY = drag.panY + (e.clientY - drag.y);
  applyTransform();
});
els.viewport.addEventListener("pointerup", () => {
  drag = null;
  els.viewport.classList.remove("panning");
});

els.splitDivider.addEventListener("pointerdown", (e) => {
  e.stopPropagation();
  els.splitDivider.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const rect = els.stage.getBoundingClientRect();
    state.splitPos = Math.min(0.98, Math.max(0.02, (ev.clientX - rect.left) / rect.width));
    applyView();
  };
  const up = () => {
    els.splitDivider.removeEventListener("pointermove", move);
    els.splitDivider.removeEventListener("pointerup", up);
  };
  els.splitDivider.addEventListener("pointermove", move);
  els.splitDivider.addEventListener("pointerup", up);
});

function applyView() {
  const v = state.view;
  els.origImg.style.display = v === "svg" ? "none" : "block";
  els.svgLayer.style.display = v === "original" ? "none" : "block";
  els.svgLayer.classList.toggle("paper", v === "svg");
  els.svgLayer.classList.toggle("overlay", v === "overlay");
  els.splitDivider.hidden = v !== "split";
  const splitPx = Math.round(state.splitPos * state.imgW);
  els.splitDivider.style.left = splitPx + "px";
  els.svgLayer.style.clipPath = v === "split" ? `inset(0 0 0 ${splitPx}px)` : "";
}

document.querySelectorAll("#viewSwitch button").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.view = btn.dataset.view;
    document
      .querySelectorAll("#viewSwitch button")
      .forEach((b) => b.classList.toggle("active", b === btn));
    applyView();
  });
});

els.origImg.addEventListener("load", () => {
  state.imgW = els.origImg.naturalWidth;
  state.imgH = els.origImg.naturalHeight;
  els.stage.style.width = state.imgW + "px";
  els.stage.style.height = state.imgH + "px";
  els.origImg.style.width = state.imgW + "px";
  els.origImg.style.height = state.imgH + "px";
  els.stage.classList.remove("hidden");
  const svgEl = els.svgLayer.querySelector("svg");
  if (svgEl) {
    svgEl.setAttribute("width", state.imgW);
    svgEl.setAttribute("height", state.imgH);
  }
  fitToScreen();
  applyView();
});

/* ---------------- Wiring ---------------- */

els.btnNew.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", () => {
  if (els.fileInput.files[0]) uploadImage(els.fileInput.files[0]).catch((e) => alert(e.message));
  els.fileInput.value = "";
});

function onParamChange() {
  updateValLabels();
  markDirty();
  scheduleTrace();
}
for (const key of PARAM_CONTROLS) els[key].addEventListener("input", onParamChange);
els.minArea.addEventListener("input", onParamChange);
els.despeckle.addEventListener("change", () => {
  els.minArea.disabled = !els.despeckle.checked;
  onParamChange();
});
for (const el of [els.skeletonize, els.invert]) el.addEventListener("change", onParamChange);
document.querySelectorAll('input[name="traceMode"]').forEach((r) =>
  r.addEventListener("change", onParamChange),
);

els.projectName.addEventListener("input", markDirty);
els.projectName.addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveProject().catch((err) => alert(err.message));
});

els.btnTrace.addEventListener("click", runTrace);
els.btnSave.addEventListener("click", () => saveProject().catch((e) => alert(e.message)));
els.btnDownload.addEventListener("click", () => {
  if (!state.svg) return;
  const name = (els.projectName.value.trim() || "trace") + ".svg";
  const url = URL.createObjectURL(new Blob([state.svg], { type: "image/svg+xml" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
});
els.btnFit.addEventListener("click", fitToScreen);

els.stage.classList.add("hidden");
loadProjects()
  .then(() => {
    const pid = new URLSearchParams(location.search).get("p");
    if (pid && state.projects.some((p) => p.id === pid)) return openProject(pid);
  })
  .catch((e) => console.error(e));
