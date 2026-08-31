/**
 * main.ts — Deno server for the Image-to-SVG Line Tracer.
 *
 * Serves the static UI from public/ and the /api routes. Image processing is
 * delegated to the Python pipeline (preprocess.py -> trace.py -> simplify.py)
 * via subprocesses; parameters travel as a JSON file, SVG comes back on stdout.
 *
 * Run: deno run -A main.ts  (or: deno task start)
 */

const ROOT = import.meta.dirname!;
const PROJECTS_DIR = `${ROOT}/projects`;
const PYTHON = `${ROOT}/.venv/bin/python`;
const PORT = Number(Deno.env.get("PORT") ?? 8081);

const DEFAULT_PARAMS = {
  traceMode: "centerline", // "centerline" | "outline"
  threshold: 128, // 0-255
  strokeWidth: 2, // px
  simplify: 1.5, // RDP tolerance, px
  smoothing: 0.5, // 0-1
  skeletonize: false,
  invert: false,
  minArea: 10, // px; 0 = keep everything
};

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function validId(id: string): boolean {
  return /^[a-zA-Z0-9-]{1,64}$/.test(id);
}

function projectDir(id: string): string {
  return `${PROJECTS_DIR}/${id}`;
}

async function readProject(id: string) {
  const text = await Deno.readTextFile(`${projectDir(id)}/project.json`);
  return JSON.parse(text);
}

async function writeProject(meta: Record<string, unknown>) {
  await Deno.writeTextFile(
    `${projectDir(meta.id as string)}/project.json`,
    JSON.stringify(meta, null, 2),
  );
}

async function runPy(
  script: string,
  args: string[],
  stdin?: string,
): Promise<{ stdout: string; stderr: string }> {
  const cmd = new Deno.Command(PYTHON, {
    args: [`${ROOT}/python/${script}`, ...args],
    stdin: stdin !== undefined ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
  });
  const proc = cmd.spawn();
  if (stdin !== undefined) {
    const writer = proc.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdin));
    await writer.close();
  }
  const out = await proc.output();
  const stdout = new TextDecoder().decode(out.stdout);
  const stderr = new TextDecoder().decode(out.stderr);
  if (!out.success) {
    throw new Error(`${script} failed: ${stderr.trim() || `exit ${out.code}`}`);
  }
  return { stdout, stderr };
}

async function makeThumbnail(id: string, sourceFile: string) {
  await runPy("thumbnail.py", [
    `${projectDir(id)}/${sourceFile}`,
    `${projectDir(id)}/thumbnail.png`,
    "160",
  ]);
}

async function handleUpload(req: Request): Promise<Response> {
  const form = await req.formData();
  const file = form.get("image");
  if (!(file instanceof File)) return json({ error: "missing image file" }, 400);

  const name = (form.get("name") as string) || file.name.replace(/\.[^.]+$/, "") ||
    "Untitled";
  const ext = (file.name.match(/\.[a-zA-Z0-9]+$/)?.[0] ?? ".png").toLowerCase();
  const sourceFile = `source${ext}`;

  const id = crypto.randomUUID();
  await Deno.mkdir(projectDir(id), { recursive: true });
  await Deno.writeFile(
    `${projectDir(id)}/${sourceFile}`,
    new Uint8Array(await file.arrayBuffer()),
  );

  const now = new Date().toISOString();
  const meta = {
    id,
    name,
    createdAt: now,
    updatedAt: now,
    source: sourceFile,
    params: { ...DEFAULT_PARAMS },
  };
  await writeProject(meta);
  await makeThumbnail(id, sourceFile);
  return json(meta);
}

async function handleTrace(req: Request): Promise<Response> {
  const body = await req.json();
  const { id, params } = body;
  if (!id || !validId(id)) return json({ error: "invalid project id" }, 400);

  let meta;
  try {
    meta = await readProject(id);
  } catch {
    return json({ error: "project not found" }, 404);
  }
  const merged = { ...DEFAULT_PARAMS, ...(params ?? {}) };

  const tmp = await Deno.makeTempDir({ prefix: "traceline-" });
  try {
    const paramsFile = `${tmp}/params.json`;
    const preFile = `${tmp}/pre.png`;
    await Deno.writeTextFile(paramsFile, JSON.stringify(merged));

    await runPy("preprocess.py", [
      "--params", paramsFile,
      `${projectDir(id)}/${meta.source}`,
      preFile,
    ]);
    const { stdout: rawSvg } = await runPy("trace.py", [
      "--params", paramsFile, preFile,
    ]);
    const { stdout: svg, stderr } = await runPy(
      "simplify.py",
      ["--params", paramsFile],
      rawSvg,
    );

    let stats = { paths: 0, nodes: 0 };
    const lastLine = stderr.trim().split("\n").pop() ?? "";
    try {
      stats = JSON.parse(lastLine);
    } catch { /* keep defaults */ }

    await Deno.writeTextFile(`${projectDir(id)}/preview.svg`, svg);
    return json({ svg, stats: { ...stats, bytes: new TextEncoder().encode(svg).length } });
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}

async function handleSaveProject(req: Request): Promise<Response> {
  const body = await req.json();
  const now = new Date().toISOString();

  // Duplicate an existing project (new id, copied source image).
  if (body.duplicateOf) {
    const srcId = String(body.duplicateOf);
    if (!validId(srcId)) return json({ error: "invalid project id" }, 400);
    let src;
    try {
      src = await readProject(srcId);
    } catch {
      return json({ error: "project not found" }, 404);
    }
    const id = crypto.randomUUID();
    await Deno.mkdir(projectDir(id), { recursive: true });
    await Deno.copyFile(
      `${projectDir(srcId)}/${src.source}`,
      `${projectDir(id)}/${src.source}`,
    );
    const meta = {
      ...src,
      id,
      name: body.name || `${src.name} copy`,
      createdAt: now,
      updatedAt: now,
      params: { ...DEFAULT_PARAMS, ...(src.params ?? {}), ...(body.params ?? {}) },
    };
    await writeProject(meta);
    await makeThumbnail(id, src.source);
    return json(meta);
  }

  // Update an existing project.
  if (body.id) {
    const id = String(body.id);
    if (!validId(id)) return json({ error: "invalid project id" }, 400);
    let meta;
    try {
      meta = await readProject(id);
    } catch {
      return json({ error: "project not found" }, 404);
    }
    if (typeof body.name === "string" && body.name.trim()) meta.name = body.name.trim();
    if (body.params) meta.params = { ...DEFAULT_PARAMS, ...body.params };
    meta.updatedAt = now;
    await writeProject(meta);
    return json(meta);
  }

  return json({ error: "id or duplicateOf required" }, 400);
}

async function listProjects(): Promise<Response> {
  const out = [];
  try {
    for await (const entry of Deno.readDir(PROJECTS_DIR)) {
      if (!entry.isDirectory || !validId(entry.name)) continue;
      try {
        const meta = await readProject(entry.name);
        out.push({
          id: meta.id,
          name: meta.name,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
        });
      } catch { /* skip broken project dirs */ }
    }
  } catch { /* projects dir does not exist yet */ }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return json(out);
}

async function serveProjectFile(id: string, file: string): Promise<Response> {
  if (!validId(id)) return new Response("bad id", { status: 400 });
  try {
    if (file === "source") {
      const meta = await readProject(id);
      file = meta.source;
    } else if (file === "thumbnail") {
      file = "thumbnail.png";
    }
    if (!/^[a-zA-Z0-9.-]{1,64}$/.test(file)) return new Response("bad file", { status: 400 });
    const data = await Deno.readFile(`${projectDir(id)}/${file}`);
    const ext = file.match(/\.[a-z]+$/)?.[0] ?? "";
    return new Response(data, {
      headers: { "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream" },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

async function serveStatic(pathname: string): Promise<Response> {
  const file = pathname === "/" ? "index.html" : pathname.slice(1);
  const allowed: Record<string, string> = {
    "index.html": "text/html; charset=utf-8",
    "style.css": "text/css; charset=utf-8",
    "app.js": "text/javascript; charset=utf-8",
  };
  if (!(file in allowed)) return new Response("not found", { status: 404 });
  try {
    const data = await Deno.readFile(`${ROOT}/public/${file}`);
    return new Response(data, { headers: { "content-type": allowed[file] } });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  try {
    if (method === "POST" && path === "/api/upload") return await handleUpload(req);
    if (method === "POST" && path === "/api/trace") return await handleTrace(req);
    if (method === "POST" && path === "/api/projects") return await handleSaveProject(req);
    if (method === "GET" && path === "/api/projects") return await listProjects();

    const m = path.match(/^\/api\/projects\/([a-zA-Z0-9-]+)(?:\/(source|thumbnail|preview\.svg))?$/);
    if (m) {
      const [, id, file] = m;
      if (!validId(id)) return json({ error: "bad id" }, 400);
      if (method === "GET" && !file) {
        try {
          return json(await readProject(id));
        } catch {
          return json({ error: "project not found" }, 404);
        }
      }
      if (method === "GET" && file) return await serveProjectFile(id, file);
      if (method === "DELETE" && !file) {
        await Deno.remove(projectDir(id), { recursive: true });
        return json({ ok: true });
      }
    }

    if (method === "GET") return await serveStatic(path);
    return json({ error: "not found" }, 404);
  } catch (err) {
    console.error(err);
    return json({ error: String(err instanceof Error ? err.message : err) }, 500);
  }
}

await Deno.mkdir(PROJECTS_DIR, { recursive: true });
console.log(`Line tracer UI: http://localhost:${PORT}`);
Deno.serve({ port: PORT }, handler);
