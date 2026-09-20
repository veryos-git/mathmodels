import { atomicWrite, ResourceError } from "./resources.ts";
export interface Filament {
  schemaVersion: 1;
  id: string;
  name: string;
  brand: string;
  material: string;
  color: string;
  layerHeight: number;
  samples: Array<{ thickness: number; color: string }>;
  updated: string;
}
const ID = /^[0-9a-f-]{36}$/;
const COLOR = /^#[0-9a-f]{6}$/i;
export function validateFilament(raw: unknown, id: string): Filament {
  if (!raw || typeof raw !== "object") {
    throw new ResourceError(400, "Expected filament settings");
  }
  const f = raw as Record<string, unknown>;
  const name = String(f.name ?? "").trim();
  const layerHeight = Number(f.layerHeight);
  if (
    !name || name.length > 120 || !COLOR.test(String(f.color)) ||
    !(layerHeight >= 0.05 && layerHeight <= 1)
  ) {
    throw new ResourceError(
      400,
      "Give the filament a name, hex color and layer height between 0.05 and 1 mm",
    );
  }
  if (!Array.isArray(f.samples) || f.samples.length > 16) {
    throw new ResourceError(400, "Use at most 16 measured patches");
  }
  const samples = f.samples.map((p) => {
    const thickness = Number(p?.thickness);
    if (
      !Number.isFinite(thickness) || thickness <= 0 || thickness > 10 ||
      !COLOR.test(p?.color)
    ) {
      throw new ResourceError(
        400,
        "Each patch needs a thickness between 0 and 10 mm and a hex color",
      );
    }
    if (
      Math.abs(thickness / layerHeight - Math.round(thickness / layerHeight)) >
        1e-5
    ) {
      throw new ResourceError(
        400,
        "Patch thicknesses must be whole print layers",
      );
    }
    return { thickness, color: String(p.color).toLowerCase() };
  }).sort((a, b) => a.thickness - b.thickness);
  if (new Set(samples.map((p) => p.thickness)).size !== samples.length) {
    throw new ResourceError(400, "Patch thicknesses must be distinct");
  }
  return {
    schemaVersion: 1,
    id,
    name,
    brand: String(f.brand ?? "").slice(0, 120),
    material: String(f.material ?? "").slice(0, 80),
    color: String(f.color),
    layerHeight,
    samples,
    updated: new Date().toISOString(),
  };
}
export class FilamentStore {
  constructor(public root: string) {}
  private path(id: string) {
    if (!ID.test(id)) throw new ResourceError(400, "Invalid filament ID");
    return `${this.root}/${id}.json`;
  }
  async get(id: string): Promise<Filament> {
    try {
      return JSON.parse(await Deno.readTextFile(this.path(id)));
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        throw new ResourceError(404, "Filament not found");
      }
      throw e;
    }
  }
  async handle(req: Request): Promise<Response | null> {
    const path = new URL(req.url).pathname;
    if (path !== "/api/filaments" && !path.startsWith("/api/filaments/")) {
      return null;
    }
    try {
      const id = path.split("/")[3];
      if (!id && req.method === "GET") {
        const filaments: Filament[] = [];
        try {
          for await (const entry of Deno.readDir(this.root)) {
            if (
              entry.isFile && entry.name.endsWith(".json") &&
              ID.test(entry.name.slice(0, -5))
            ) filaments.push(await this.get(entry.name.slice(0, -5)));
          }
        } catch (e) {
          if (!(e instanceof Deno.errors.NotFound)) throw e;
        }
        return Response.json({
          filaments: filaments.sort((a, b) => a.name.localeCompare(b.name)),
        });
      }
      if ((!id && req.method === "POST") || (id && req.method === "PUT")) {
        if (id) await this.get(id);
        let raw;
        try {
          raw = await req.json();
        } catch {
          throw new ResourceError(400, "Expected JSON");
        }
        const record = validateFilament(raw, id ?? crypto.randomUUID());
        await Deno.mkdir(this.root, { recursive: true });
        await atomicWrite(
          this.path(record.id),
          JSON.stringify(record, null, 2) + "\n",
        );
        return Response.json(record, { status: id ? 200 : 201 });
      }
      if (id && req.method === "GET") return Response.json(await this.get(id));
      if (id && req.method === "DELETE") {
        await this.get(id);
        await Deno.remove(this.path(id));
        return Response.json({ deleted: true });
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
