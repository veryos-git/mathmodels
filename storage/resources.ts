/** File-backed reusable inputs. A manifest is the atomic commit point; revisions
 * keep ordinary image/vector files browsable and previous saves recoverable. */
export type ResourceKind = "subject" | "boundary" | "profile";
// The subject role was stored as "pattern" before the terminology was settled;
// old manifests and old clients are read as "subject".
const LEGACY_KINDS: Record<string, ResourceKind> = { pattern: "subject" };
const KINDS: ResourceKind[] = ["subject", "boundary", "profile"];
function normalizeKind(value: unknown): ResourceKind | null {
  const kind = (LEGACY_KINDS[String(value ?? "subject")] ?? String(value ?? "subject")) as ResourceKind;
  return KINDS.includes(kind) ? kind : null;
}
export interface Resource {
  schemaVersion: 1;
  id: string;
  name: string;
  kind: ResourceKind;
  created: string;
  updated: string;
  revision: string;
  files: Partial<
    Record<"drawing" | "original" | "edited", { name: string; path: string }>
  >;
  trace: Record<string, unknown> | null;
}
export class ResourceError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
export async function atomicWrite(path: string, data: string | Uint8Array) {
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    if (typeof data === "string") await Deno.writeTextFile(temp, data);
    else await Deno.writeFile(temp, data);
    await Deno.rename(temp, path);
  } finally {
    await Deno.remove(temp).catch(() => {});
  }
}
async function readForm(req: Request): Promise<FormData> {
  try {
    return await req.formData();
  } catch {
    throw new ResourceError(400, "Expected a multipart form");
  }
}
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export class ResourceStore {
  private previews = new Map<string, Promise<string>>();
  constructor(
    public root: string,
    private renderDrawing?: (path: string) => Promise<string>,
  ) {}
  async preview(id: string): Promise<Response> {
    const record = await this.get(id);
    const drawing = record.files.drawing;
    if (!drawing) throw new ResourceError(404, "Resource drawing not found");
    const path = `${this.path(id)}/${drawing.path}`;
    let svg: string;
    if (drawing.name.toLowerCase().endsWith(".svg")) {
      svg = await Deno.readTextFile(path);
    } else {
      const cache = `${path}.preview.svg`;
      try {
        svg = await Deno.readTextFile(cache);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        if (!this.renderDrawing) {
          throw new ResourceError(422, "Drawing preview is unavailable");
        }
        let pending = this.previews.get(path);
        if (!pending) {
          pending = (async () => {
            const result = await this.renderDrawing!(path);
            await atomicWrite(cache, result);
            return result;
          })();
          this.previews.set(path, pending);
        }
        try {
          svg = await pending;
        } finally {
          if (this.previews.get(path) === pending) this.previews.delete(path);
        }
      }
    }
    return new Response(svg, {
      headers: {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": "no-cache",
        "content-security-policy":
          "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      },
    });
  }
  private path(id: string) {
    if (!ID.test(id)) throw new ResourceError(400, "Invalid resource ID");
    return `${this.root}/${id}`;
  }
  async get(id: string): Promise<Resource> {
    try {
      const record: Resource = JSON.parse(
        await Deno.readTextFile(`${this.path(id)}/resource.json`),
      );
      // Manifests written before the rename keep working: the note stays on
      // disk as it was, but every reader sees the canonical kind.
      record.kind = normalizeKind(record.kind) ?? record.kind;
      return record;
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        throw new ResourceError(404, "Resource not found");
      }
      throw e;
    }
  }
  async list() {
    const records: Resource[] = [];
    try {
      for await (const entry of Deno.readDir(this.root)) {
        if (entry.isDirectory && ID.test(entry.name)) {
          try {
            records.push(await this.get(entry.name));
          } catch (e) {
            if (!(e instanceof ResourceError && e.status === 404)) throw e;
          }
        }
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
    return records.sort((a, b) => b.updated.localeCompare(a.updated));
  }
  async save(
    form: FormData,
    id: string = crypto.randomUUID(),
  ): Promise<Resource> {
    let previous: Resource | undefined;
    try {
      previous = await this.get(id);
    } catch (e) {
      if (!(e instanceof ResourceError && e.status === 404)) throw e;
    }
    const name = String(form.get("name") ?? previous?.name ?? "").trim();
    const kind = normalizeKind(
      form.get("kind") ?? previous?.kind ?? "subject",
    );
    if (!name || name.length > 120) {
      throw new ResourceError(400, "Use a name between 1 and 120 characters");
    }
    if (!kind) {
      throw new ResourceError(400, "Invalid resource kind");
    }
    let trace = previous?.trace ?? null;
    if (form.has("trace")) {
      try {
        trace = JSON.parse(String(form.get("trace")));
      } catch {
        throw new ResourceError(400, "Invalid trace settings JSON");
      }
      if (
        trace !== null && (typeof trace !== "object" || Array.isArray(trace))
      ) {
        throw new ResourceError(400, "Trace settings must be an object");
      }
    }
    const uploads: Array<
      { slot: "drawing" | "original" | "edited"; file: File; ext: string }
    > = [];
    for (const slot of ["drawing", "original", "edited"] as const) {
      const file = form.get(slot);
      if (file === null) continue;
      if (
        !(file instanceof File) || !file.size || file.size > 16 * 1024 * 1024
      ) {
        throw new ResourceError(
          400,
          "Files must contain data and be at most 16 MB",
        );
      }
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      if (
        !(slot === "drawing"
          ? ["svg", "dxf"]
          : ["png", "jpg", "jpeg", "webp", "gif"]).includes(ext)
      ) {
        throw new ResourceError(400, `Unsupported ${slot} file format`);
      }
      uploads.push({ slot, file, ext });
    }
    const files = { ...previous?.files };
    if (!files.drawing && !uploads.some((u) => u.slot === "drawing")) {
      throw new ResourceError(400, "A resource needs an SVG or DXF drawing");
    }
    if (
      kind !== "subject" &&
      (trace || uploads.some((u) => u.slot !== "drawing") || files.original)
    ) {
      throw new ResourceError(400, "Only subjects have image tracing data");
    }
    const revision = crypto.randomUUID();
    const dir = `${this.path(id)}/revisions/${revision}`;
    await Deno.mkdir(dir, { recursive: true });
    for (const { slot, file, ext } of uploads) {
      const path = `revisions/${revision}/${slot}.${ext}`;
      await Deno.writeFile(
        `${this.path(id)}/${path}`,
        new Uint8Array(await file.arrayBuffer()),
      );
      files[slot] = { name: file.name, path };
    }
    const record: Resource = {
      schemaVersion: 1,
      id,
      name,
      kind,
      created: previous?.created ?? new Date().toISOString(),
      updated: new Date().toISOString(),
      revision,
      files,
      trace,
    };
    const json = JSON.stringify(record, null, 2) + "\n";
    await Deno.writeTextFile(`${dir}/resource.json`, json);
    await atomicWrite(`${this.path(id)}/resource.json`, json);
    return record;
  }
  async handle(req: Request): Promise<Response | null> {
    const path = new URL(req.url).pathname;
    if (path !== "/api/resources" && !path.startsWith("/api/resources/")) {
      return null;
    }
    try {
      const [, , , id, slot, extra] = path.split("/");
      if (extra) throw new ResourceError(404, "Unknown resource route");
      if (!id && req.method === "GET") {
        return Response.json({ resources: await this.list() });
      }
      if (!id && req.method === "POST") {
        return Response.json(await this.save(await readForm(req)), {
          status: 201,
        });
      }
      const record = await this.get(id);
      if (slot === "preview" && req.method === "GET") {
        return await this.preview(id);
      }
      if (slot && req.method === "GET") {
        if (!["drawing", "original", "edited"].includes(slot)) {
          throw new ResourceError(404, "Resource file not found");
        }
        const file = record.files[slot as keyof Resource["files"]];
        if (!file) throw new ResourceError(404, "Resource file not found");
        return new Response(
          await Deno.readFile(`${this.path(id)}/${file.path}`),
          {
            headers: {
              "content-type": "application/octet-stream",
              "x-content-type-options": "nosniff",
            },
          },
        );
      }
      if (!slot && req.method === "GET") return Response.json(record);
      if (!slot && req.method === "PUT") {
        return Response.json(await this.save(await readForm(req), id));
      }
      if (!slot && req.method === "DELETE") {
        await Deno.remove(this.path(id), { recursive: true });
        return Response.json({ deleted: true, id });
      }
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    } catch (e) {
      if (e instanceof ResourceError) {
        return Response.json({ error: e.message }, { status: e.status });
      }
      throw e;
    }
  }
}
