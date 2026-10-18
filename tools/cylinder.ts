import { findOpenScad } from "./openscad.ts";
import { readThreadedDefaults } from "./threaded_defaults.ts";
export { readThreadedDefaults } from "./threaded_defaults.ts";

export type CylinderSettings = {
  diameter: number;
  height: number;
  thickness: number;
  bottom: number;
  lid: boolean;
  threaded: boolean;
  lidTop: number;
  neck: number;
  pitch: number;
  clearance: number;
  seamGap: number;
  repeatX: number;
  repeatY: number;
  threadedDesign?: ReturnType<typeof readThreadedDefaults>["design"];
};

export function cylinderSettings(raw: unknown): CylinderSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Expected cylinder settings");
  }
  const input = { ...raw } as Record<string, unknown>;
  const scad = readThreadedDefaults();
  const { lid: _lid, threaded: _threaded, ...defaults } = scad.defaults;
  const result = {
    lid: input.lid ?? false,
    threaded: input.threaded ?? true,
  } as CylinderSettings;
  if (typeof result.lid !== "boolean" || typeof result.threaded !== "boolean") {
    throw new Error("Lid and thread options must be booleans");
  }
  if (result.lid && result.threaded) {
    const thickness = input.thickness ?? defaults.thickness;
    Object.assign(input, {
      bottom: thickness,
      lidTop: thickness,
      neck: scad.parameters.neck_height ||
        scad.design.lidHeight - Number(thickness) - scad.design.rimClearance,
      pitch: defaults.pitch,
      clearance: defaults.clearance,
    });
    result.threadedDesign = scad.design;
  }
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = input[key] ?? fallback;
    if (
      typeof value !== "number" || !Number.isFinite(value) || value <= 0 ||
      value > 500
    ) throw new Error(`Cylinder ${key} must be a positive number up to 500 mm`);
    Object.assign(result, { [key]: value });
  }
  const c = result;
  for (const key of ["repeatX", "repeatY"] as const) {
    const value = input[key] ?? 1;
    if (
      typeof value !== "number" || !Number.isInteger(value) || value < 1 ||
      value > 12
    ) {
      throw new Error("Use 1–12 repeats per direction");
    }
    c[key] = value;
  }
  if (c.repeatX * c.repeatY > 64) {
    throw new Error("Use at most 64 artwork copies");
  }
  if (
    c.diameter < 10 || c.height < 5 || c.thickness < 0.4 || c.bottom < 0.4 ||
    c.lidTop < 0.4
  ) {
    throw new Error(
      "Use a diameter of at least 10 mm, height of 5 mm and shell thicknesses of 0.4 mm",
    );
  }
  const inner = c.diameter / 2 -
    (c.lid
      ? 2 * c.thickness + c.clearance + (c.threaded ? 0.4 * c.pitch : 0)
      : c.thickness);
  const transition = c.lid && c.threaded
    ? c.thickness + c.clearance + 0.4 * c.pitch
    : 0;
  if (
    inner <= 0 ||
    c.height - (c.lid ? c.neck : 0) <= c.bottom + transition
  ) {
    throw new Error(
      "The diameter or height is too small for these walls, bottom and neck transition",
    );
  }
  if (c.threadedDesign) {
    const d = c.threadedDesign, depth = 0.4 * c.pitch;
    if (
      d.threadHeight < 2 * c.pitch || c.neck < d.threadHeight ||
      c.neck + d.rimClearance > d.lidHeight - c.thickness + 0.02
    ) {
      throw new Error(
        "The SCAD neck and thread band must fit inside the lid; reduce shell thickness or adjust the SCAD defaults",
      );
    }
    if (
      c.clearance >= depth || d.axialClearance < 0 ||
      d.axialClearance >= 0.1 * c.pitch ||
      d.stop < 0 || d.stop >= c.pitch || d.baseEntry < 0 || d.lidEntry < 0 ||
      d.baseEntry >= d.threadHeight || d.lidEntry + depth >= d.threadHeight ||
      (d.stop > 0 && d.stop + d.baseEntry + d.lidEntry >= d.threadHeight)
    ) {
      throw new Error(
        "The thread clearance, lead-ins or alignment stop in the SCAD defaults do not fit the thread band",
      );
    }
    if (
      Math.min(d.baseEntry, depth) >= c.thickness ||
      Math.max(
          Number(scad.parameters.base_chamfer),
          Number(scad.parameters.lid_chamfer),
        ) >= c.thickness
    ) {
      throw new Error(
        "Shell thickness must exceed the SCAD chamfers and thread-entry relief",
      );
    }
  }
  if (c.seamGap > 2 || c.seamGap >= c.neck) {
    throw new Error(
      "Lid seam gap must be at most 2 mm and smaller than the neck",
    );
  }
  return c;
}

export function cylinderRenderPlan(
  c: CylinderSettings,
): { source: string; parameters: Record<string, number | boolean> } {
  if (c.lid && c.threaded) {
    const scad = readThreadedDefaults();
    const d = c.threadedDesign!;
    // All thread, fit, chamfer and lid choices remain owned by the source.
    // Only the three app sizing controls can override model parameters.
    const requested = {
      outer_diameter: c.diameter,
      full_height: c.height - c.neck + d.lidHeight,
      wall_thickness: c.thickness,
    };
    const overrides = Object.fromEntries(
      Object.entries(requested)
        .filter(([key, value]) =>
          Math.abs(value - Number(scad.parameters[key])) > 1e-9
        ),
    );
    return {
      source: "tools/threaded-container.scad",
      parameters: {
        ...overrides,
        app_lid_z: c.height - c.neck + d.stop,
        app_lid_angle: 360 * d.stop / c.pitch,
      },
    };
  }
  return {
    source: "tools/cylinder-container.scad",
    parameters: {
      outer_diameter: c.diameter,
      container_height: c.height,
      wall_thickness: c.thickness,
      bottom_thickness: c.bottom,
      lid_top_thickness: c.lidTop,
      neck_height: c.neck,
      thread_pitch: c.pitch,
      radial_clearance: c.clearance,
      edge_chamfer: 0,
      has_lid: c.lid,
      threaded: false,
      quality: 128,
    },
  };
}

// Bounded cache: repainting and exporting reuse the expensive thread render.
const cache = new Map<
  string,
  Promise<{ body: Uint8Array; lid?: Uint8Array }>
>();
export async function cylinderMeshes(c: CylinderSettings, dir: string) {
  const { repeatX: _repeatX, repeatY: _repeatY, ...shellSettings } = c;
  const key = JSON.stringify(shellSettings) +
    (c.lid && c.threaded ? readThreadedDefaults().source : "");
  let pending = cache.get(key);
  if (!pending) {
    pending = (async () => {
      const command = await findOpenScad();
      const { source, parameters } = cylinderRenderPlan(c);
      const definitions = Object.entries(parameters).flatMap((
        [k, v],
      ) => ["-D", `${k}=${v}`]);
      const render = async (part: string) => {
        const path = `${dir}/cylinder-${part}.stl`;
        const child = new Deno.Command(command, {
          args: [
            "-o",
            path,
            "-D",
            `${c.lid && c.threaded ? "app_part" : "view"}=${
              JSON.stringify(part)
            }`,
            ...definitions,
            source,
          ],
          env: { QT_QPA_PLATFORM: "offscreen" },
          stdout: "piped",
          stderr: "piped",
        }).spawn();
        const timeout = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch { /* exited */ }
        }, 180_000);
        try {
          const result = await child.output();
          if (!result.success) {
            throw new Error(
              `OpenSCAD could not build the ${part}: ${
                new TextDecoder().decode(result.stderr).slice(-2000)
              }`,
            );
          }
          return await Deno.readFile(path);
        } finally {
          clearTimeout(timeout);
        }
      };
      return {
        body: await render("container"),
        ...(c.lid ? { lid: await render("lid-assembled") } : {}),
      };
    })();
    cache.set(key, pending);
    if (cache.size > 8) cache.delete(cache.keys().next().value!);
  }
  try {
    return await pending;
  } catch (error) {
    cache.delete(key);
    throw error;
  }
}

export async function cylinderFlags(
  raw: FormDataEntryValue | null,
  dir: string,
): Promise<string[]> {
  if (raw === null) return [];
  const c = cylinderSettings(JSON.parse(String(raw)));
  const meshes = await cylinderMeshes(c, dir);
  await Deno.writeFile(`${dir}/shell.stl`, meshes.body);
  if (meshes.lid) await Deno.writeFile(`${dir}/lid.stl`, meshes.lid);
  const path = `${dir}/cylinder.json`;
  await Deno.writeTextFile(
    path,
    JSON.stringify({
      ...c,
      bodyPath: `${dir}/shell.stl`,
      lidPath: meshes.lid ? `${dir}/lid.stl` : null,
    }),
  );
  return ["--cylinder", path];
}
