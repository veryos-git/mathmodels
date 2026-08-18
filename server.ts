/// Deno web server: upload a DXF or SVG, get back a relief STL.
/// The heavy lifting is done by tools/dxf2stl.py (ezdxf + svgelements +
/// shapely + trimesh).

const PYTHON = ".venv/bin/python";
const SCRIPT = "tools/dxf2stl.py";
const EXAMPLE = "sketch.dxf";
const DEFAULT_PROFILE = "default_profile.dxf";
const PORT = Number(Deno.env.get("PORT") ?? 8788);
const MAX_UPLOAD = 16 * 1024 * 1024;
const MAX_LAYERS = 8;
const MAX_ASSIGNMENTS = 1024 * 1024;
// The face effects the converter knows; "none" is simply left off.
const EFFECTS = ["maya-pyramid"];
const DRAWING = /\.(dxf|svg)$/i;

const PROJECT_DIR = Deno.env.get("PROJECT_DIR") ?? "projects";
const PROJECT_EXT = ".v2sproj";
const MAX_PROJECT = 32 * 1024 * 1024;
// Leading character is alphanumeric, so "..", ".hidden" and absolute paths are
// all rejected before the name ever reaches the filesystem.
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

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
): Promise<{ form: FormData; file: File; paths: string[]; profilePath: string | null }> {
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

  // Advanced mode: an optional second drawing holding the sweep profile.
  const profile = form.get("profile");
  let profilePath: string | null = null;
  if (profile instanceof File && profile.size > 0) {
    if (!DRAWING.test(profile.name)) {
      throw new HttpError(400, "the profile must be a .dxf or .svg file");
    }
    if (profile.size > MAX_UPLOAD) {
      throw new HttpError(413, "the profile is too large (16 MB max)");
    }
    profilePath = `${dir}/profile${profile.name.toLowerCase().endsWith(".svg") ? ".svg" : ".dxf"}`;
    await Deno.writeFile(profilePath, new Uint8Array(await profile.arrayBuffer()));
  }
  return { form, file, paths, profilePath };
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
  const dir = await Deno.makeTempDir({ prefix: "dxf2stl-" });
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

/** The shape flags shared by /api/regions and /api/convert. */
function shapeFlags(form: FormData): string[] {
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
    effectSteps: "--effect-steps",
    effectInset: "--effect-inset",
  });

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
    const { form, paths, profilePath } = await takeUpload(req, dir);
    return Response.json(await runScript([
      paths[0],
      "--regions",
      ...shapeFlags(form),
      ...(profilePath ? ["--profile", profilePath] : []),
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
function handleConvert(req: Request): Promise<Response> {
  return withTempDir(async (dir) => {
    const { form, file, paths, profilePath } = await takeUpload(req, dir);
    const output = `${dir}/output.stl`;
    const args = [
      paths[0],
      output,
      ...shapeFlags(form),
      ...(profilePath ? ["--profile", profilePath] : []),
      ...await mapFlag(form, "heights", "--heights", dir),
      ...await mapFlag(form, "stacks", "--stacks", dir),
      ...await mapFlag(form, "wallStack", "--wall-stack", dir),
      ...await mapFlag(form, "holes", "--holes", dir),
      ...await layerSpecs(form, dir, paths),
    ];

    const stats = await runScript(args);
    const stl = await Deno.readFile(output);
    return new Response(stl, {
      headers: {
        "content-type": "application/sla",
        "content-disposition":
          `attachment; filename="${file.name.replace(DRAWING, "")}.stl"`,
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
    const { form, paths, profilePath } = await takeUpload(req, dir);
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
      ...shapeFlags(form),
      ...(profilePath ? ["--profile", profilePath] : []),
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

/* --------------------------------------------------------------- projects */

function projectPath(name: string): string {
  if (!PROJECT_NAME.test(name)) {
    throw new HttpError(400, "a project name may use letters, digits, spaces, . _ and -");
  }
  return `${PROJECT_DIR}/${name}${PROJECT_EXT}`;
}

/** GET /api/projects — what is on the shelf, newest first. */
async function listProjects(): Promise<Response> {
  const projects: Array<{ name: string; size: number; saved: string }> = [];
  try {
    for await (const entry of Deno.readDir(PROJECT_DIR)) {
      if (!entry.isFile || !entry.name.endsWith(PROJECT_EXT)) continue;
      const info = await Deno.stat(`${PROJECT_DIR}/${entry.name}`);
      projects.push({
        name: entry.name.slice(0, -PROJECT_EXT.length),
        size: info.size,
        saved: (info.mtime ?? new Date()).toISOString(),
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
  let parsed: { format?: string };
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new HttpError(400, "that project is not valid JSON");
  }
  if (parsed?.format !== "vector2stl-project") {
    throw new HttpError(400, "that is not a vector2stl project");
  }
  await Deno.mkdir(PROJECT_DIR, { recursive: true });
  await Deno.writeTextFile(path, body);
  return Response.json({ name, saved: new Date().toISOString() });
}

async function deleteProject(name: string): Promise<Response> {
  try {
    await Deno.remove(projectPath(name));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(404, `no project called "${name}"`);
  }
  return Response.json({ name, deleted: true });
}

/**
 * POST /api/export3mf — the whole model as one 3MF project.
 * Colour lives in Metadata/model_settings.config as an extruder per part, the
 * way Snapmaker's slicer (a Bambu Studio fork) writes it.
 */
function handleExport3mf(req: Request): Promise<Response> {
  return withTempDir(async (dir) => {
    const { form, file, paths, profilePath } = await takeUpload(req, dir);
    const output = `${dir}/project.3mf`;
    const stats = await runScript([
      paths[0],
      output,
      ...shapeFlags(form),
      ...(profilePath ? ["--profile", profilePath] : []),
      ...await mapFlag(form, "heights", "--heights", dir),
      ...await mapFlag(form, "stacks", "--stacks", dir),
      ...await mapFlag(form, "wallStack", "--wall-stack", dir),
      ...await mapFlag(form, "holes", "--holes", dir),
      ...await layerSpecs(form, dir, paths),
    ]);
    return new Response(await Deno.readFile(output), {
      headers: {
        "content-type": "model/3mf",
        "content-disposition":
          `attachment; filename="${file.name.replace(DRAWING, "")}.3mf"`,
        "x-stats": encodeURIComponent(JSON.stringify(stats)),
      },
    });
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

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);
  try {
    if (url.pathname === "/api/inspect" && req.method === "POST") return await handleInspect(req);
    if (url.pathname === "/api/regions" && req.method === "POST") return await handleRegions(req);
    if (url.pathname === "/api/convert" && req.method === "POST") return await handleConvert(req);
    if (url.pathname === "/api/export" && req.method === "POST") return await handleExport(req);
    if (url.pathname === "/api/export3mf" && req.method === "POST") {
      return await handleExport3mf(req);
    }

    if (url.pathname === "/api/projects" && req.method === "GET") return await listProjects();
    const named = url.pathname.match(/^\/api\/projects\/(.+)$/);
    if (named) {
      const name = decodeURIComponent(named[1]);
      if (req.method === "GET") return await getProject(name);
      if (req.method === "PUT") return await putProject(req, name);
      if (req.method === "DELETE") return await deleteProject(name);
    }

    if (req.method === "GET") {
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
