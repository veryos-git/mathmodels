import { FilamentStore } from "./storage/filaments.ts";
import { importProjectResources } from "./storage/import_projects.ts";
import { ResourceStore, atomicWrite } from "./storage/resources.ts";
import { PYTHON } from "./tools/python.ts";
/// Deno web server: upload a DXF or SVG, get back a relief STL.
/// The heavy lifting is done by tools/dxf2stl.py (ezdxf + svgelements +
/// shapely + trimesh).

const TEMP_DIR = ".tmp";
const SCRIPT = "tools/dxf2stl.py";
const TRACE_SCRIPT = "tools/trace.py";
const EXAMPLE = "reverse_engeneering/gothic_tracery_simple/sketch.dxf";
const DEFAULT_PROFILE = "reverse_engeneering/gothic_tracery_simple/default_profile.dxf";
const PORT = Number(Deno.env.get("PORT") ?? 8788);
const MAX_UPLOAD = 16 * 1024 * 1024;
const MAX_LAYERS = 8;
const MAX_ASSIGNMENTS = 1024 * 1024;
// The face effects the converter knows; "none" is simply left off.
const EFFECTS = ["maya-pyramid"];
const DRAWING = /\.(dxf|svg)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

// A raster uploaded for tracing, held in memory until it becomes a drawing.
const traces = new Map<string, { bytes: Uint8Array; name: string; ext: string }>();
const DEFAULT_TRACE_PARAMS = {
  traceMode: "centerline", // "centerline" | "outline"
  threshold: 128, // 0-255
  closeGaps: 0, // closing radius, px; 0 preserves intentional narrow gaps
  strokeWidth: 2, // px, preview only — the relief reads outlines
  simplify: 1.5, // RDP tolerance, px
  smoothing: 0.5, // 0-1
  skeletonize: false,
  invert: false,
  minArea: 10, // px; 0 = keep everything
};

const PROJECT_DIR = Deno.env.get("PROJECT_DIR") ?? "projects";
const PROJECT_EXT = ".v2sproj";
const MAX_PROJECT = 32 * 1024 * 1024;
// Leading character is alphanumeric, so "..", ".hidden" and absolute paths are
// all rejected before the name ever reaches the filesystem.
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

// The drawing library: every SVG (or DXF) the user uploads while working is
// kept here as a reusable resource, so a subject, boundary or profile can be
// swapped in later without re-uploading the file.
const LIBRARY_DIR = Deno.env.get("LIBRARY_DIR") ?? "library";
const filaments = new FilamentStore(`${LIBRARY_DIR}/filaments`);
const resources = new ResourceStore(`${LIBRARY_DIR}/resources`, async (path) => {
  const data = await runScript([path, "--preview", "--sagitta", String(THUMB_SAGITTA)]);
  return svgFromCurves((data.subject as { curves?: number[][][] })?.curves ?? []);
});
// An entry's name carries its extension. Leading alphanumeric keeps ".." and
// absolute paths out; the server never touches the filesystem with a name
// that failed this check.
const LIBRARY_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,95}\.(dxf|svg)$/i;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

/** Read the request body, writing the uploaded drawings into `dir`. */
async function takeUpload(
  req: Request,
  dir: string,
): Promise<{
  form: FormData;
  file: File;
  paths: string[];
  profilePath: string | null;
  cuspPath: string | null;
  cuspProfilePath: string | null;
  boundaryPath: string | null;
}> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_UPLOAD * MAX_LAYERS) {
    throw new HttpError(413, "those files are too large (16 MB each max)");
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(400, "expected a multipart form upload");
  }
  // Stacked drawings all arrive under "file", base layer first.
  const files = form.getAll("file").filter((f): f is File => f instanceof File);
  const file = files[0];
  if (!file || !DRAWING.test(file.name)) {
    throw new HttpError(400, "please upload a .dxf or .svg file");
  }
  if (files.length > MAX_LAYERS) {
    throw new HttpError(400, `at most ${MAX_LAYERS} drawing layers`);
  }
  const paths: string[] = [];
  for (const [i, f] of files.entries()) {
    if (!DRAWING.test(f.name)) {
      throw new HttpError(400, "every drawing layer must be a .dxf or .svg file");
    }
    if (f.size > MAX_UPLOAD) throw new HttpError(413, "that file is too large (16 MB max)");
    if (f.size === 0) throw new HttpError(400, "that file is empty");
    // Keep the extension — the converter picks its reader from it.
    const ext = f.name.toLowerCase().endsWith(".svg") ? ".svg" : ".dxf";
    const path = `${dir}/input${i === 0 ? "" : i + 1}${ext}`;
    await Deno.writeFile(path, new Uint8Array(await f.arrayBuffer()));
    paths.push(path);
  }

  // Advanced modes each add a second drawing: one holding the sweep profile,
  // one holding the polygon that bounds the pattern.
  const profilePath = await takeExtra(form, "profile", "profile", dir);
  const boundaryPath = await takeExtra(form, "boundary", "boundary", dir);
  const cuspPath = await takeExtra(form, "cusps", "cusp paths", dir);
  const cuspProfilePath = await takeExtra(form, "cuspProfile", "cusp profile", dir);
  return { form, file, paths, profilePath, boundaryPath, cuspPath, cuspProfilePath };
}

/**
 * One of the optional extra drawings — the sweep profile or the boundary
 * polygon — written beside the main upload. Missing or empty means it is off.
 */
async function takeExtra(
  form: FormData,
  field: string,
  what: string,
  dir: string,
): Promise<string | null> {
  const extra = form.get(field);
  if (!(extra instanceof File) || extra.size === 0) return null;
  if (!DRAWING.test(extra.name)) {
    throw new HttpError(400, `the ${what} must be a .dxf or .svg file`);
  }
  if (extra.size > MAX_UPLOAD) {
    throw new HttpError(413, `the ${what} is too large (16 MB max)`);
  }
  const ext = extra.name.toLowerCase().endsWith(".svg") ? ".svg" : ".dxf";
  const path = `${dir}/${field}${ext}`;
  await Deno.writeFile(path, new Uint8Array(await extra.arrayBuffer()));
  return path;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly log?: string) {
    super(message);
  }
}

/** Run the converter. Resolves with its JSON stdout, throws HttpError on failure. */
async function runScript(args: string[]): Promise<Record<string, unknown>> {
  const cmd = new Deno.Command(PYTHON, { args: [SCRIPT, ...args], stdout: "piped", stderr: "piped" });
  const { code, stdout, stderr } = await cmd.output();
  const err = new TextDecoder().decode(stderr).trim();
  if (code !== 0) {
    // The script prints a one-line reason for expected failures; anything
    // longer is a traceback, which belongs in the details, not the headline.
    const lines = err.split("\n").filter((l) => l.trim());
    const single = lines.length === 1;
    throw new HttpError(422, single ? lines[0] : "conversion failed", single ? undefined : err);
  }
  try {
    return JSON.parse(new TextDecoder().decode(stdout));
  } catch {
    throw new HttpError(500, "the converter returned no result", err);
  }
}

/** Numeric form fields, appended as CLI flags only when actually filled in. */
function numericFlags(form: FormData, fields: Record<string, string>): string[] {
  const args: string[] = [];
  for (const [name, flag] of Object.entries(fields)) {
    const v = form.get(name);
    if (typeof v === "string" && v !== "" && !Number.isNaN(Number(v))) args.push(flag, v);
  }
  return args;
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  await Deno.mkdir(TEMP_DIR, { recursive: true });
  const dir = await Deno.makeTempDir({ dir: TEMP_DIR, prefix: "dxf2stl-" });
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** POST /api/inspect — what layers and geometry does this drawing contain? */
function handleInspect(req: Request): Promise<Response> {
  return withTempDir(async (dir) => {
    const { form, paths } = await takeUpload(req, dir);
    // Scale and sagitta change the reported size, so honour them here too.
    const args = numericFlags(form, { sagitta: "--sagitta", scale: "--scale" });
    return Response.json(await runScript([paths[0], "--inspect", ...args]));
  });
}

/**
 * POST /api/preview — the raw subject and boundary outlines, so the browser can
 * draw the 2D window-position preview and reposition the subject inside the
 * boundary without a full 3D rebuild on every drag.
 */
function handlePreview(req: Request): Promise<Response> {
  return withTempDir(async (dir) => {
    const { form, paths, boundaryPath } = await takeUpload(req, dir);
    const args = numericFlags(form, { sagitta: "--sagitta" });
    if (form.get("layers")) args.push("--layers", String(form.get("layers")));
    return Response.json(await runScript([
      paths[0], "--preview", ...args,
      ...(boundaryPath ? ["--boundary", boundaryPath] : []),
    ]));
  });
}

/** The shape flags shared by /api/regions and /api/convert. */
function shapeFlags(form: FormData, boundaryPath: string | null = null): string[] {
  const args = numericFlags(form, {
    wallWidth: "--wall-width",
    wallHeight: "--wall-height",
    wallOverlap: "--wall-overlap",
    regionMin: "--region-min",
    regionMax: "--region-max",
    regionStep: "--region-step",
    sagitta: "--sagitta",
    scale: "--scale",
    profileScale: "--profile-scale",
    cuspWidth: "--cusp-width", cuspHeight: "--cusp-height", cuspZ: "--cusp-z",
    endAngle: "--end-angle", endSide: "--end-side",
    effectSteps: "--effect-steps",
    effectInset: "--effect-inset",
  });

  // A boundary polygon crops every subject: what falls outside it is cut off.
  // Its own placement fields only mean anything while one is loaded.
  if (boundaryPath) {
    args.push("--boundary", boundaryPath);
    args.push(...numericFlags(form, {
      boundaryScale: "--boundary-scale",
      boundaryX: "--boundary-x",
      boundaryY: "--boundary-y",
      subjectScale: "--subject-scale",
      subjectX: "--subject-x",
      subjectY: "--subject-y",
    }));
    // Centring and fitting is the default; only leaving it turns the flag off.
    if (form.get("boundaryFit") === "0") args.push("--no-boundary-fit");
    // The boundary is walled by default, so only turning that off travels.
    if (form.get("boundaryWall") === "0") args.push("--no-boundary-wall");
  }

  // Confining the walls keeps the model inside its outermost line instead of
  // letting the frame stand half its width outside the drawing.
  if (form.get("confineWalls") === "1") args.push("--confine-walls");

  // One effect shapes every face of every drawing, so it is not a per-layer
  // field. Only names the converter knows are passed on.
  const effect = form.get("effect");
  if (typeof effect === "string" && EFFECTS.includes(effect)) {
    args.push("--effect", effect);
  }

  // --seed is an int; a fractional value would only earn an argparse dump.
  const seed = form.get("seed");
  if (typeof seed === "string" && seed !== "" && Number.isFinite(Number(seed))) {
    args.push("--seed", String(Math.trunc(Number(seed))));
  }

  if (form.get("roundEnds") === "1") args.push("--round-ends");
  if (form.get("frameOnly") === "1") args.push("--frame-only");
  const layers = form.get("layers");
  if (typeof layers === "string" && layers !== "") args.push("--layers", layers);
  return args;
}

/**
 * POST /api/regions — the wall and face outlines, so the browser can extrude
 * them itself and repaint a region without a round trip.
 */
function handleRegions(req: Request): Promise<Response> {
  return withTempDir(async (dir) => {
    const { form, paths, profilePath, boundaryPath, cuspPath, cuspProfilePath } = await takeUpload(req, dir);
    return Response.json(await runScript([
      paths[0],
      "--regions",
      ...shapeFlags(form, boundaryPath),
      ...(profilePath ? ["--profile", profilePath] : []),
      ...(cuspPath ? ["--cusps", cuspPath] : []),
      ...(cuspProfilePath ? ["--cusp-profile", cuspProfilePath] : []),
      ...await mapFlag(form, "holes", "--holes", dir),
      ...await layerSpecs(form, dir, paths),
    ]));
  });
}

/**
 * Write a per-region JSON map from the form into the scratch dir, and return
 * the flag pair the converter needs for it.
 */
async function mapFlag(
  form: FormData,
  field: string,
  flag: string,
  dir: string,
): Promise<string[]> {
  const raw = form.get(field);
  if (typeof raw !== "string" || raw === "") return [];
  if (raw.length > MAX_ASSIGNMENTS) throw new HttpError(413, `too many ${field}`);
  try {
    JSON.parse(raw);
  } catch {
    throw new HttpError(400, `the ${field} are not valid JSON`);
  }
  const path = `${dir}/${field}.json`;
  await Deno.writeTextFile(path, raw);
  return [flag, path];
}

/**
 * Build the --also spec for every extra drawing layer. Layer N (N = 2, 3, …)
 * takes its per-layer fields with the N suffix: scaleN, layersN, stacksN,
 * heightsN, holesN — everything else is shared with the base layer.
 */
async function layerSpecs(
  form: FormData,
  dir: string,
  paths: string[],
): Promise<string[]> {
  const args: string[] = [];
  for (let i = 1; i < paths.length; i++) {
    const n = i + 1;
    const spec: Record<string, unknown> = { file: paths[i] };
    const scale = form.get(`scale${n}`);
    if (typeof scale === "string" && scale !== "" && !Number.isNaN(Number(scale))) {
      spec.scale = Number(scale);
    }
    const sublayers = form.get(`layers${n}`);
    if (typeof sublayers === "string" && sublayers !== "") spec.layers = sublayers;
    for (const field of ["stacks", "heights", "holes"]) {
      const raw = form.get(`${field}${n}`);
      if (typeof raw !== "string" || raw === "") continue;
      if (raw.length > MAX_ASSIGNMENTS) throw new HttpError(413, `too many ${field}`);
      try {
        spec[field] = JSON.parse(raw);
      } catch {
        throw new HttpError(400, `the ${field} are not valid JSON`);
      }
    }
    const path = `${dir}/layer${n}.json`;
    await Deno.writeTextFile(path, JSON.stringify(spec));
    args.push("--also", path);
  }
  return args;
}

/** POST /api/convert — the DXF plus settings in, an STL out. */
function handleConvert(req: Request, slice = false): Promise<Response> {
  return withTempDir(async (dir) => {
    const { form, file, paths, profilePath, boundaryPath, cuspPath, cuspProfilePath } = await takeUpload(req, dir);
    const height = form.get("sliceHeight");
    if (slice && (typeof height !== "string" || height.trim() === "" ||
      !Number.isFinite(Number(height)) || Number(height) < 0)) {
      throw new HttpError(400, "Slice height must be a finite, non-negative number");
    }
    const extension = slice ? "svg" : "stl";
    const output = `${dir}/output.${extension}`;
    const args = [
      paths[0],
      output,
      ...shapeFlags(form, boundaryPath),
      ...(profilePath ? ["--profile", profilePath] : []),
      ...(cuspPath ? ["--cusps", cuspPath] : []),
      ...(cuspProfilePath ? ["--cusp-profile", cuspProfilePath] : []),
      ...await mapFlag(form, "heights", "--heights", dir),
      ...await mapFlag(form, "stacks", "--stacks", dir),
      ...await mapFlag(form, "wallStack", "--wall-stack", dir),
      ...await mapFlag(form, "holes", "--holes", dir),
      ...await layerSpecs(form, dir, paths),
      ...(slice ? ["--slice-height", String(height)] : []),
    ];

    const stats = await runScript(args);
    const stl = await Deno.readFile(output);
    return new Response(stl, {
      headers: {
        "content-type": slice ? "image/svg+xml" : "application/sla",
        "content-disposition":
          `attachment; filename="${file.name.replace(DRAWING, "")}.${extension}"`,
        "x-stats": encodeURIComponent(JSON.stringify(stats)),
      },
    });
  });
}

/**
 * POST /api/export — one STL per colour group plus the walls.
 * Multi-material printing wants the parts separated, so they come back as a
 * list of files the browser saves individually rather than as one archive.
 */
function handleExport(req: Request): Promise<Response> {
  return withTempDir(async (dir) => {
    const { form, paths, profilePath, boundaryPath, cuspPath, cuspProfilePath } = await takeUpload(req, dir);
    // Colours travel either per layer (stacks) or per face (groups).
    const stacks = await mapFlag(form, "stacks", "--stacks", dir);
    const groups = await mapFlag(form, "groups", "--groups", dir);
    if (!stacks.length && !groups.length) {
      throw new HttpError(400, "no colour groups were given");
    }

    const output = `${dir}/stls`;
    const stats = await runScript([
      paths[0],
      output,
      "--split",
      ...shapeFlags(form, boundaryPath),
      ...(profilePath ? ["--profile", profilePath] : []),
      ...(cuspPath ? ["--cusps", cuspPath] : []),
      ...(cuspProfilePath ? ["--cusp-profile", cuspProfilePath] : []),
      ...await mapFlag(form, "heights", "--heights", dir),
      ...await mapFlag(form, "holes", "--holes", dir),
      ...await mapFlag(form, "wallStack", "--wall-stack", dir),
      ...stacks,
      ...groups,
      ...await layerSpecs(form, dir, paths),
    ]);

    const listed = (stats.files ?? []) as Array<Record<string, unknown>>;
    const files = await Promise.all(listed.map(async (entry) => ({
      ...entry,
      stl: (await Deno.readFile(`${output}/${entry.file}`)).toBase64(),
    })));
    return Response.json({ ...stats, files });
  });
}

/* ---------------------------------------------------------------- tracing */

/**
 * POST /api/trace/upload — hold a raster image in memory and hand back its id.
 * The image stays put while the frontend re-traces it with different settings,
 * so a slider drag never re-sends the bytes.
 */
async function handleTraceUpload(req: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(400, "expected a multipart form upload");
  }
  const image = form.get("image");
  if (!(image instanceof File)) throw new HttpError(400, "missing image file");
  if (!IMAGE.test(image.name)) {
    throw new HttpError(400, "please upload a png, jpg, gif or webp image");
  }
  if (image.size === 0) throw new HttpError(400, "that file is empty");
  if (image.size > MAX_UPLOAD) throw new HttpError(413, "that image is too large (16 MB max)");
  const ext = image.name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? ".png";
  const id = crypto.randomUUID();
  traces.set(id, { bytes: new Uint8Array(await image.arrayBuffer()), name: image.name, ext });
  return Response.json({ id, name: image.name });
}

/**
 * POST /api/trace — run tools/trace.py on a previously uploaded image with the
 * given settings, and return the resulting SVG. Settings travel as JSON; the
 * SVG and its stats come back the same way they do for a dxf2stl build.
 */
async function handleTrace(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "expected a JSON body");
  }
  const id = typeof body.id === "string" ? body.id : "";
  const entry = traces.get(id);
  if (!entry) throw new HttpError(404, "upload an image first");

  const incoming = body.params && typeof body.params === "object" && !Array.isArray(body.params)
    ? body.params as Record<string, unknown>
    : {};
  const params = { ...DEFAULT_TRACE_PARAMS, ...incoming };
  return withTempDir(async (dir) => {
    const imagePath = `${dir}/source${entry.ext}`;
    const paramsPath = `${dir}/params.json`;
    await Deno.writeFile(imagePath, entry.bytes);
    await Deno.writeTextFile(paramsPath, JSON.stringify(params));

    const cmd = new Deno.Command(PYTHON, {
      args: [TRACE_SCRIPT, "--params", paramsPath, imagePath],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await cmd.output();
    const svg = new TextDecoder().decode(stdout);
    const err = new TextDecoder().decode(stderr).trim();
    if (code !== 0) {
      const lines = err.split("\n").filter((l) => l.trim());
      const single = lines.length === 1;
      throw new HttpError(422, single ? lines[0] : "tracing failed", single ? undefined : err);
    }
    // The script reports its stats as a JSON line on stderr.
    let stats: Record<string, unknown> = { paths: 0, nodes: 0 };
    const lastLine = err.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
    try {
      stats = JSON.parse(lastLine);
    } catch { /* keep the defaults */ }
    return Response.json({
      svg,
      stats: { ...stats, bytes: new TextEncoder().encode(svg).length },
    });
  });
}

/* --------------------------------------------------------------- projects */

function projectPath(name: string): string {
  if (!PROJECT_NAME.test(name)) {
    throw new HttpError(400, "a project name may use letters, digits, spaces, . _ and -");
  }
  return `${PROJECT_DIR}/${name}${PROJECT_EXT}`;
}

/** The thumbnail beside a project — a small PNG the browser sent on save. */
function thumbPath(name: string): string {
  return `${PROJECT_DIR}/${name}.png`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Decode a base64 string (no data-URL prefix) into bytes. */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** GET /api/projects — what is on the shelf, newest first. */
async function listProjects(): Promise<Response> {
  const projects: Array<{ name: string; size: number; saved: string; thumb: boolean }> = [];
  try {
    for await (const entry of Deno.readDir(PROJECT_DIR)) {
      if (!entry.isFile || !entry.name.endsWith(PROJECT_EXT)) continue;
      const name = entry.name.slice(0, -PROJECT_EXT.length);
      const info = await Deno.stat(`${PROJECT_DIR}/${entry.name}`);
      projects.push({
        name,
        size: info.size,
        saved: (info.mtime ?? new Date()).toISOString(),
        thumb: await exists(thumbPath(name)),
      });
    }
  } catch {
    // No directory yet simply means nothing has been saved.
  }
  projects.sort((a, b) => b.saved.localeCompare(a.saved));
  return Response.json({ projects });
}

async function getProject(name: string): Promise<Response> {
  try {
    return new Response(await Deno.readFile(projectPath(name)), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(404, `no project called "${name}"`);
  }
}

/** PUT /api/projects/:name — body is the project JSON the browser assembled. */
async function putProject(req: Request, name: string): Promise<Response> {
  const path = projectPath(name);
  const body = await req.text();
  if (body.length > MAX_PROJECT) throw new HttpError(413, "that project is too large");
  let parsed: { format?: string; thumbnail?: unknown };
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new HttpError(400, "that project is not valid JSON");
  }
  if (parsed?.format !== "vector2stl-project") {
    throw new HttpError(400, "that is not a vector2stl project");
  }
  await Deno.mkdir(PROJECT_DIR, { recursive: true });
  await atomicWrite(path, body);
  // A thumbnail travels as a data URL; stored beside the project so the start
  // screen can show it without reading the whole project JSON.
  if (typeof parsed.thumbnail === "string" && parsed.thumbnail.startsWith("data:image/png;base64,")) {
    try {
      await Deno.writeFile(thumbPath(name),
        base64ToBytes(parsed.thumbnail.slice("data:image/png;base64,".length)));
    } catch { /* a bad thumbnail should not block the save */ }
  }
  return Response.json({ name, saved: new Date().toISOString() });
}

async function deleteProject(name: string): Promise<Response> {
  try {
    await Deno.remove(projectPath(name));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(404, `no project called "${name}"`);
  }
  await Deno.remove(thumbPath(name)).catch(() => {});   // no thumbnail is fine
  return Response.json({ name, deleted: true });
}

/**
 * POST /api/projects/:name/clone — copy a saved project to a new name ("name
 * copy", "name copy 2", …), thumbnail included.
 */
async function cloneProject(name: string): Promise<Response> {
  let body: string;
  try {
    body = await Deno.readTextFile(projectPath(name));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(404, `no project called "${name}"`);
  }
  let newName = `${name} copy`;
  for (let i = 2; await exists(projectPath(newName)); i++) newName = `${name} copy ${i}`;
  await Deno.mkdir(PROJECT_DIR, { recursive: true });
  await Deno.writeTextFile(projectPath(newName), body);
  if (await exists(thumbPath(name))) {
    await Deno.copyFile(thumbPath(name), thumbPath(newName));
  }
  return Response.json({ name: newName });
}

/** GET /api/projects/:name/thumbnail — the PNG saved beside the project. */
async function serveThumbnail(name: string): Promise<Response> {
  projectPath(name);
  try {
    const data = await Deno.readFile(thumbPath(name));
    return new Response(data, {
      headers: { "content-type": "image/png", "cache-control": "no-cache" },
    });
  } catch {
    throw new HttpError(404, `no thumbnail for "${name}"`);
  }
}

/* ---------------------------------------------------------------- library */

/** The on-disk name of a library entry, after validation. */
function libraryPath(name: string): string {
  if (!LIBRARY_NAME.test(name)) {
    throw new HttpError(
      400,
      "a library name must end in .svg or .dxf and use only letters, digits, spaces, . _ ( ) and -",
    );
  }
  return `${LIBRARY_DIR}/${name}`;
}

async function libraryExists(name: string): Promise<boolean> {
  try {
    await Deno.stat(libraryPath(name));
    return true;
  } catch {
    return false;
  }
}

/** Write bytes into the library atomically (temp file + rename). */
async function writeLibrary(name: string, bytes: Uint8Array): Promise<void> {
  await Deno.mkdir(LIBRARY_DIR, { recursive: true });
  const tmp = `${LIBRARY_DIR}/.${name}.tmp-${crypto.randomUUID()}`;
  await Deno.writeFile(tmp, bytes);
  await Deno.rename(tmp, libraryPath(name));
}

/** Content out of a create/update body: an uploaded file or pasted SVG text. */
async function libraryContent(
  form: FormData,
  kind: "svg" | "dxf",
): Promise<Uint8Array> {
  const file = form.get("file");
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_UPLOAD) throw new HttpError(413, "that file is too large (16 MB max)");
    const fileKind = file.name.toLowerCase().endsWith(".svg") ? "svg" : "dxf";
    if (fileKind !== kind) {
      throw new HttpError(400, `that is a .${fileKind} file, not a .${kind}`);
    }
    return new Uint8Array(await file.arrayBuffer());
  }
  const text = form.get("svg");
  if (kind === "svg" && typeof text === "string" && text.trim() !== "") {
    if (text.length > MAX_UPLOAD) {
      throw new HttpError(413, "that SVG is too large (16 MB max)");
    }
    // Cheap sanity check: the converter reads SVG XML, so insist on a root.
    if (!/<\s*(svg|!DOCTYPE)[\s>]/i.test(text)) {
      throw new HttpError(400, "that does not look like an SVG — paste SVG markup or upload a file");
    }
    return new TextEncoder().encode(text);
  }
  throw new HttpError(400, "give the drawing some content (upload a file or paste SVG)");
}

/** A name the caller proposed, made safe and given the right extension. */
function libraryEntryName(raw: string | null, kind: "svg" | "dxf"): string {
  const name = (raw ?? "").trim();
  const stem = name.replace(/\.(svg|dxf)$/i, "").trim() || `drawing`;
  const candidate = `${stem}.${kind}`;
  if (!LIBRARY_NAME.test(candidate)) {
    throw new HttpError(
      400,
      "a library name may use letters, digits, spaces, . _ ( ) and -, and must start with a letter or digit",
    );
  }
  return candidate;
}

/** GET /api/library — every saved drawing, newest first. */
async function listLibrary(): Promise<Response> {
  const entries: Array<{
    name: string;
    kind: "svg" | "dxf";
    size: number;
    saved: string;
  }> = [];
  try {
    for await (const entry of Deno.readDir(LIBRARY_DIR)) {
      if (!entry.isFile || !LIBRARY_NAME.test(entry.name)) continue;
      const info = await Deno.stat(`${LIBRARY_DIR}/${entry.name}`);
      entries.push({
        name: entry.name,
        kind: entry.name.toLowerCase().endsWith(".svg") ? "svg" : "dxf",
        size: info.size,
        saved: (info.mtime ?? new Date()).toISOString(),
      });
    }
  } catch {
    // No directory yet simply means nothing has been uploaded.
  }
  entries.sort((a, b) => b.saved.localeCompare(a.saved));
  return Response.json({ entries });
}

/**
 * POST /api/library — add a drawing to the library. The body is a multipart
 * form: `file` (an uploaded .svg/.dxf) or `svg` (pasted SVG markup), an
 * optional `name`, and optional `replace=1` to overwrite an existing entry.
 */
async function createLibrary(req: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(400, "expected a multipart form upload");
  }
  const file = form.get("file");
  const kind: "svg" | "dxf" =
    (file instanceof File && file.size > 0 && !file.name.toLowerCase().endsWith(".svg"))
      ? "dxf"
      : "svg";
  const name = libraryEntryName(
    typeof form.get("name") === "string" ? String(form.get("name")) : (file instanceof File ? file.name : null),
    kind,
  );
  if (await libraryExists(name) && form.get("replace") !== "1") {
    throw new HttpError(409, `a library entry called "${name}" already exists`);
  }
  const bytes = await libraryContent(form, kind);
  await writeLibrary(name, bytes);
  await dropThumbnail(name);   // new content, new preview
  const info = await Deno.stat(libraryPath(name));
  return Response.json({
    name,
    kind,
    size: info.size,
    saved: (info.mtime ?? new Date()).toISOString(),
  });
}

/** GET /api/library/:name — the drawing itself, as a download. */
async function getLibrary(name: string): Promise<Response> {
  try {
    const data = await Deno.readFile(libraryPath(name));
    const svg = name.toLowerCase().endsWith(".svg");
    return new Response(data, {
      headers: {
        "content-type": svg ? "image/svg+xml" : "application/dxf",
        "content-disposition": `attachment; filename="${name.replace(/"/g, "")}"`,
        "cache-control": "no-cache",
      },
    });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(404, `no library entry called "${name}"`);
  }
}

/** SHA-256 of some bytes, as hex — used to dedupe imported drawings. */
async function shaHex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ------------------------------------------------------- DXF thumbnails */

// DXF has no native bitmap and the browser cannot render it, so a library
// entry's preview is drawn by the converter — the same parser the 3D pipeline
// uses — as a lightweight SVG of flattened outlines, cached beside the entry
// under LIBRARY_DIR/.thumbnails (a dot-directory, so it never appears in the
// library listing). SVG entries preview as themselves.
const THUMB_DIR = `${LIBRARY_DIR}/.thumbnails`;
// A looser flattening than the model's: thumbnails only need the silhouette.
const THUMB_SAGITTA = 0.1;

function libThumbPath(name: string): string {
  return `${THUMB_DIR}/${name}.svg`;
}

async function dropThumbnail(name: string): Promise<void> {
  await Deno.remove(libThumbPath(name)).catch(() => {});
}

/** Flattened outline curves -> an SVG that looks right on a dark tile. */
function svgFromCurves(curves: number[][][]): string {
  const flat = curves.flat();
  if (!flat.length) throw new HttpError(422, "this drawing has no geometry to preview");
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const [x, y] of flat) {
    if (x < minx) minx = x;
    if (x > maxx) maxx = x;
    if (y < miny) miny = y;
    if (y > maxy) maxy = y;
  }
  const w = maxx - minx || 1, h = maxy - miny || 1;
  const extent = Math.max(w, h);
  const pad = extent * 0.02;
  const stroke = Math.max(0.02, extent * 0.004);
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const left = r2(minx - pad), top = r2(miny - pad);
  const right = r2(maxx + pad), bottom = r2(maxy + pad);
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${left} ${top} `
      + `${r2(right - left)} ${r2(bottom - top)}">`,
    `<rect x="${left}" y="${top}" width="${r2(right - left)}" `
      + `height="${r2(bottom - top)}" fill="#101216"/>`,
    `<g fill="none" stroke="#e6e9ed" stroke-width="${stroke}" `
      + 'stroke-linecap="round" stroke-linejoin="round">',
  ];
  // DXF's y axis points up; SVG's points down, so mirror about the middle.
  const flip = miny + maxy;
  for (const curve of curves) {
    let d = "";
    for (const [i, [x, y]] of curve.entries()) {
      d += `${i ? "L" : "M"}${x.toFixed(2)} ${(flip - y).toFixed(2)}`;
    }
    if (d) out.push(`<path d="${d}"/>`);
  }
  out.push("</g></svg>");
  return out.join("");
}

// One generation in flight per entry, so a grid of tiles does not race.
const previewsInFlight = new Map<string, Promise<string>>();

/**
 * GET /api/library/:name/preview — an SVG the browser can show as the entry's
 * thumbnail. SVG entries return their own file; DXF entries are flattened by
 * the converter on first request and cached beside the library.
 */
async function serveLibraryPreview(name: string): Promise<Response> {
  if (!LIBRARY_NAME.test(name)) throw new HttpError(400, "not a library entry name");
  const svg = name.toLowerCase().endsWith(".svg");
  try {
    await Deno.stat(libraryPath(name));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(404, `no library entry called "${name}"`);
  }
  // An SVG is its own thumbnail — the same pixels the user saved.
  if (svg) return getLibrary(name);

  let body: string;
  try {
    body = new TextDecoder().decode(await Deno.readFile(libThumbPath(name)));
  } catch {
    // Not cached yet: flatten the DXF once (shared by concurrent requests),
    // then cache the SVG beside the entry.
    await Deno.mkdir(THUMB_DIR, { recursive: true });
    let gen = previewsInFlight.get(name);
    if (!gen) {
      gen = (async () => {
        try {
          const bytes = await Deno.readFile(libraryPath(name));
          const tmp = `${THUMB_DIR}/.tmp-${crypto.randomUUID()}.dxf`;
          await Deno.writeFile(tmp, bytes);
          let svgText: string;
          try {
            const data = await runScript([tmp, "--preview", "--sagitta", String(THUMB_SAGITTA)]);
            const curves = (data.subject as { curves?: number[][][] })?.curves ?? [];
            svgText = svgFromCurves(curves);
          } finally {
            await Deno.remove(tmp).catch(() => {});
          }
          const cachePath = libThumbPath(name);
          const cacheTmp = `${THUMB_DIR}/.tmp-${crypto.randomUUID()}`;
          await Deno.writeTextFile(cacheTmp, svgText);
          await Deno.rename(cacheTmp, cachePath);
          return svgText;
        } finally {
          previewsInFlight.delete(name);
        }
      })();
      previewsInFlight.set(name, gen);
    }
    try {
      body = await gen;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(422, "could not draw a preview of this DXF");
    }
  }
  return new Response(body, {
    headers: {
      "content-type": "image/svg+xml",
      "cache-control": "no-cache",
    },
  });
}

/**
 * POST /api/library/import — unpack the drawings embedded in the saved
 * projects and add them to the library. Older projects predate the library,
 * so their drawing (subject), stacked drawings and boundary (frame) only
 * exist inside the .v2sproj blob; this is the backfill that turns them into
 * reusable resources. Anything whose content is already in the library — or
 * that turns up twice across projects — is skipped, so re-running is a no-op.
 */
async function importProjectsIntoLibrary(): Promise<Response> {
  await Deno.mkdir(LIBRARY_DIR, { recursive: true });

  // What the library already holds, by content hash, so nothing is duplicated.
  const present = new Map<string, string>();   // name -> hash
  for await (const entry of Deno.readDir(LIBRARY_DIR)) {
    if (!entry.isFile || !LIBRARY_NAME.test(entry.name)) continue;
    try {
      present.set(entry.name, await shaHex(await Deno.readFile(`${LIBRARY_DIR}/${entry.name}`)));
    } catch {
      // an unreadable entry is left alone
    }
  }
  const seen = new Set(present.values());

  const imported: Array<{ name: string; kind: "svg" | "dxf"; from: string }> = [];
  let duplicates = 0;    // already in the library (same bytes)
  let skipped = 0;       // unreadable or unusable
  let projectCount = 0;

  const takenNames = new Set(present.keys());
  const freeName = (wanted: string): string => {
    if (!takenNames.has(wanted)) return wanted;
    const stem = wanted.replace(/\.(svg|dxf)$/i, "");
    const ext = wanted.toLowerCase().endsWith(".svg") ? ".svg" : ".dxf";
    for (let n = 2; ; n++) {
      const cand = `${stem} (${n})${ext}`;
      if (!takenNames.has(cand)) return cand;
    }
  };

  /** Keep one embedded drawing: content-deduped, stored under `wanted`. */
  const keep = async (
    wantedStem: string,
    embeddedName: string,
    bytes: Uint8Array,
    from: string,
  ): Promise<void> => {
    const kind = embeddedName.toLowerCase().endsWith(".svg") ? "svg" : "dxf";
    if (!/\.(svg|dxf)$/i.test(embeddedName)) {
      skipped++;
      return;
    }
    const hash = await shaHex(bytes);
    if (seen.has(hash)) {
      duplicates++;
      return;
    }
    seen.add(hash);
    const stem = wantedStem.replace(/[\s.]+$/, "") || embeddedName.replace(/\.(svg|dxf)$/i, "");
    const name = freeName(`${stem}.${kind}`);
    const path = `${LIBRARY_DIR}/${name}`;
    const tmp = `${LIBRARY_DIR}/.${name}.tmp-${crypto.randomUUID()}`;
    await Deno.writeFile(tmp, bytes);
    await Deno.rename(tmp, path);
    takenNames.add(name);
    imported.push({ name, kind, from });
  };

  for await (const entry of Deno.readDir(PROJECT_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(PROJECT_EXT)) continue;
    projectCount++;
    const stem = entry.name.slice(0, -PROJECT_EXT.length);
    let project: {
      format?: unknown;
      drawing?: { name?: unknown; data?: unknown };
      drawings?: Array<{ name?: unknown; data?: unknown }>;
      boundary?: { name?: unknown; data?: unknown };
    };
    try {
      project = JSON.parse(await Deno.readTextFile(`${PROJECT_DIR}/${entry.name}`));
    } catch {
      skipped++;
      continue;
    }
    if (project?.format !== "vector2stl-project") {
      skipped++;
      continue;
    }
    const base = project.drawing;
    if (base?.data && typeof base.data === "string" && typeof base.name === "string") {
      try {
        await keep(stem, base.name, base64ToBytes(base.data), `${entry.name}`);
      } catch {
        skipped++;
      }
    } else {
      skipped++;
    }
    // Stacked drawings get their place in the stack as their name: 2, 3, …
    for (const [i, layer] of (Array.isArray(project.drawings) ? project.drawings : []).entries()) {
      if (!layer?.data || typeof layer.data !== "string" || typeof layer.name !== "string") {
        skipped++;
        continue;
      }
      try {
        await keep(`${stem} ${i + 2}`, layer.name, base64ToBytes(layer.data), `${entry.name} (layer ${i + 2})`);
      } catch {
        skipped++;
      }
    }
    // The boundary is the frame — kept as its own reusable resource too.
    const boundary = project.boundary;
    if (boundary?.data && typeof boundary.data === "string" && typeof boundary.name === "string") {
      try {
        await keep(`${stem} boundary`, boundary.name, base64ToBytes(boundary.data), `${entry.name} (boundary)`);
      } catch {
        skipped++;
      }
    }
  }

  return Response.json({
    projects: projectCount,
    imported,
    duplicates,
    skipped,
    added: imported.length,
  });
}

/** PUT /api/library/:name — replace an entry's content (its name stays). */
async function putLibrary(req: Request, name: string): Promise<Response> {
  if (!LIBRARY_NAME.test(name)) {
    throw new HttpError(400, "a library name must end in .svg or .dxf");
  }
  const kind: "svg" | "dxf" = name.toLowerCase().endsWith(".svg") ? "svg" : "dxf";
  if (!await libraryExists(name)) {
    throw new HttpError(404, `no library entry called "${name}"`);
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(400, "expected a multipart form upload");
  }
  const bytes = await libraryContent(form, kind);
  await writeLibrary(name, bytes);
  await dropThumbnail(name);   // new content, new preview
  const info = await Deno.stat(libraryPath(name));
  return Response.json({
    name,
    kind,
    size: info.size,
    saved: (info.mtime ?? new Date()).toISOString(),
  });
}

async function deleteLibrary(name: string): Promise<Response> {
  try {
    await Deno.remove(libraryPath(name));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(404, `no library entry called "${name}"`);
  }
  await dropThumbnail(name);
  return Response.json({ name, deleted: true });
}

/**
 * POST /api/export3mf — selectable colour assemblies with printer-specific
 * plate layout. slicerOptions.preview returns thumbnails and a packing plan;
 * the same options plus selected IDs produce the downloadable project.
 */
function handleExport3mf(req: Request): Promise<Response> {
  return withTempDir(async (dir) => {
    const { form, paths, profilePath, boundaryPath, cuspPath, cuspProfilePath } = await takeUpload(req, dir);
    const output = `${dir}/variations`;
    // Legacy callers may specify one pattern; the dialog sends slicerOptions.
    const patterns = form.get("patterns");
    const stats = await runScript([
      paths[0],
      output,
      "--variations",
      ...await mapFlag(form, "slicerOptions", "--slicer-options", dir),
      ...shapeFlags(form, boundaryPath),
      ...(profilePath ? ["--profile", profilePath] : []),
      ...(cuspPath ? ["--cusps", cuspPath] : []),
      ...(cuspProfilePath ? ["--cusp-profile", cuspProfilePath] : []),
      ...await mapFlag(form, "heights", "--heights", dir),
      ...await mapFlag(form, "stacks", "--stacks", dir),
      ...await mapFlag(form, "wallStack", "--wall-stack", dir),
      ...await mapFlag(form, "holes", "--holes", dir),
      ...await layerSpecs(form, dir, paths),
      ...(typeof patterns === "string" && patterns.trim() !== ""
        ? ["--patterns", patterns.trim()]
        : []),
    ]);

    const listed = (stats.files ?? []) as Array<Record<string, unknown>>;
    const files = await Promise.all(listed.map(async (entry) => ({
      ...entry,
      data: (await Deno.readFile(`${output}/${entry.file}`)).toBase64(),
    })));
    return Response.json({ ...stats, files });
  });
}

async function serveStatic(pathname: string): Promise<Response | null> {
  const path = pathname === "/" ? "/index.html" : pathname;
  if (path.includes("..")) return null;
  try {
    const data = await Deno.readFile(`static${path}`);
    const ext = path.slice(path.lastIndexOf("."));
    return new Response(data, {
      headers: { "content-type": MIME[ext] ?? "application/octet-stream" },
    });
  } catch {
    return null;
  }
}

async function calibrationCoupon(req: Request): Promise<Response> {
  let body: { thicknesses?: unknown; layerHeight?: unknown };
  try { body = await req.json(); } catch { throw new HttpError(400, "Expected coupon settings"); }
  const lh = Number(body.layerHeight);
  const values = body.thicknesses;
  if (!(lh >= 0.05 && lh <= 1) || !Array.isArray(values) || values.length < 2 || values.length > 16 ||
      values.some((t) => typeof t !== "number" || !Number.isFinite(t) || t <= 0 || t > 10 || Math.abs(t/lh-Math.round(t/lh)) > 1e-5)) {
    throw new HttpError(400, "Use 2–16 positive patch thicknesses in whole print layers (up to 10 mm)");
  }
  return withTempDir(async (dir) => {
    const output = `${dir}/calibration.stl`;
    const result = await new Deno.Command(PYTHON, {args:["tools/calibration.py", output, "--thicknesses", JSON.stringify(values)], stdout:"piped", stderr:"piped"}).output();
    if (!result.success) throw new HttpError(422, "Could not generate calibration coupon", new TextDecoder().decode(result.stderr));
    return new Response(await Deno.readFile(output), {headers:{"content-type":"model/stl", "content-disposition":"attachment; filename=filament-calibration.stl"}});
  });
}

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);
  try {
    if (url.pathname === "/api/resources/import" && req.method === "POST") {
      return Response.json(await importProjectResources(PROJECT_DIR, resources));
    }
    if (url.pathname === "/api/calibration" && req.method === "POST") return await calibrationCoupon(req);
    const filamentResponse = await filaments.handle(req);
    if (filamentResponse) return filamentResponse;
    const resourceResponse = await resources.handle(req);
    if (resourceResponse) return resourceResponse;
    if (url.pathname === "/api/trace/upload" && req.method === "POST") {
      return await handleTraceUpload(req);
    }
    if (url.pathname === "/api/trace" && req.method === "POST") return await handleTrace(req);

    if (url.pathname === "/api/inspect" && req.method === "POST") return await handleInspect(req);
    if (url.pathname === "/api/preview" && req.method === "POST") return await handlePreview(req);
    if (url.pathname === "/api/regions" && req.method === "POST") return await handleRegions(req);
    if (url.pathname === "/api/convert" && req.method === "POST") return await handleConvert(req);
    if (url.pathname === "/api/slice" && req.method === "POST") return await handleConvert(req, true);
    if (url.pathname === "/api/export" && req.method === "POST") return await handleExport(req);
    if (url.pathname === "/api/export3mf" && req.method === "POST") {
      return await handleExport3mf(req);
    }

    if (url.pathname === "/api/projects" && req.method === "GET") return await listProjects();

    // Sub-paths of a project: cloning and its thumbnail.
    const cloneMatch = url.pathname.match(/^\/api\/projects\/(.+)\/clone$/);
    if (cloneMatch && req.method === "POST") {
      return await cloneProject(decodeURIComponent(cloneMatch[1]));
    }
    const thumbMatch = url.pathname.match(/^\/api\/projects\/(.+)\/thumbnail$/);
    if (thumbMatch && req.method === "GET") {
      return await serveThumbnail(decodeURIComponent(thumbMatch[1]));
    }

    const named = url.pathname.match(/^\/api\/projects\/(.+)$/);
    if (named) {
      const name = decodeURIComponent(named[1]);
      if (req.method === "GET") return await getProject(name);
      if (req.method === "PUT") return await putProject(req, name);
      if (req.method === "DELETE") return await deleteProject(name);
    }

    // The drawing library — every uploaded SVG/DXF kept as a reusable resource.
    if (url.pathname === "/api/library" && req.method === "GET") return await listLibrary();
    if (url.pathname === "/api/library" && req.method === "POST") return await createLibrary(req);
    if (url.pathname === "/api/library/import" && req.method === "POST") {
      return await importProjectsIntoLibrary();
    }
    const libPreview = url.pathname.match(/^\/api\/library\/(.+)\/preview$/);
    if (libPreview && req.method === "GET") {
      return await serveLibraryPreview(decodeURIComponent(libPreview[1]));
    }
    const libNamed = url.pathname.match(/^\/api\/library\/(.+)$/);
    if (libNamed) {
      const name = decodeURIComponent(libNamed[1]);
      if (req.method === "GET") return await getLibrary(name);
      if (req.method === "PUT") return await putLibrary(req, name);
      if (req.method === "DELETE") return await deleteLibrary(name);
    }

    if (req.method === "GET") {
      if (url.pathname.startsWith("/api/spitzbogen-example/")) {
        const name = url.pathname.slice("/api/spitzbogen-example/".length);
        if (!["frame.dxf", "profile.svg"].includes(name)) throw new HttpError(404, "Unknown Spitzbogen reference");
        return new Response(await Deno.readFile(`examples/spitzbogen/${name}`), {headers:{"content-type":name.endsWith(".svg")?"image/svg+xml":"application/dxf"}});
      }
      if (url.pathname.startsWith("/api/gothic-example/")) {
        const name = url.pathname.slice("/api/gothic-example/".length);
        if (!["frame.dxf", "cusps.dxf", "frame-profile.svg", "cusp-profile.svg"].includes(name)) throw new HttpError(404, "Unknown gothic reference");
        return new Response(await Deno.readFile(`examples/gothic/${name}`), {headers:{"content-type":name.endsWith(".svg")?"image/svg+xml":"application/dxf"}});
      }
      if (url.pathname === "/api/example.dxf") {
        return new Response(await Deno.readFile(EXAMPLE), {
          headers: {
            "content-type": "application/dxf",
            "content-disposition": `attachment; filename="${EXAMPLE}"`,
          },
        });
      }
      if (url.pathname === "/api/default-profile.dxf") {
        try {
          return new Response(await Deno.readFile(DEFAULT_PROFILE), {
            headers: {
              "content-type": "application/dxf",
              "content-disposition": `attachment; filename="${DEFAULT_PROFILE}"`,
            },
          });
        } catch {
          return Response.json({ error: "no default profile" }, { status: 404 });
        }
      }
      const asset = await serveStatic(url.pathname);
      if (asset) return asset;
    }
  } catch (err) {
    if (err instanceof HttpError) {
      return Response.json({ error: err.message, log: err.log }, { status: err.status });
    }
    console.error(err);
    return Response.json({ error: String(err) }, { status: 500 });
  }

  return Response.json({ error: "not found" }, { status: 404 });
});

console.log(`listening on http://localhost:${PORT}`);
