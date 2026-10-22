import { findOpenScad } from "./openscad.ts";

/** The BIC J26 lighter case source. Its wall and height are overridable with
 * -D; the cavity (lighter_width/depth) and fit stay fixed to the real J26. */
export const LIGHTER_SCAD =
  "hgc_requirements_documentation/simple_lighter_case/bicj26.scad";

// Fixed cavity and chamfer, mirrored in tools/lighter.py.
export const LIGHTER_FIXED = {
  width: 25.0,
  depth: 14.5,
  fit: 0.25,
  edgeChamfer: 0.4,
} as const;

export type LighterSettings = {
  wall: number;
  height: number;
  repeatX: number;
  sweepThenRepeat: boolean;
  // Where the pattern seam sits: a vertex (1–4) plus a degree offset.
  startVertex: number;
  startOffset: number;
  width: number;
  depth: number;
  fit: number;
  edgeChamfer: number;
};

export function lighterSettings(raw: unknown): LighterSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Expected lighter settings");
  }
  const input = raw as Record<string, unknown>;
  const wall = Number(input.wall ?? 1.0);
  const height = Number(input.height ?? 70.9);
  if (!Number.isFinite(wall) || wall < 0.4 || wall > 20) {
    throw new Error("Lighter wall thickness must be 0.4–20 mm");
  }
  if (!Number.isFinite(height) || height < 10 || height > 200) {
    throw new Error("Lighter case height must be 10–200 mm");
  }
  const repeatX = Math.trunc(Number(input.repeatX ?? 1));
  if (!Number.isFinite(repeatX) || repeatX < 1 || repeatX > 12) {
    throw new Error("Lighter repeat count must be 1–12");
  }
  const startVertex = Math.trunc(Number(input.startVertex ?? 1));
  if (![1, 2, 3, 4].includes(startVertex)) {
    throw new Error("Lighter start vertex must be 1, 2, 3 or 4");
  }
  const startOffset = Number(input.startOffset ?? 0);
  if (!Number.isFinite(startOffset)) {
    throw new Error("Lighter start offset must be a number of degrees");
  }
  return {
    wall,
    height,
    repeatX,
    sweepThenRepeat: input.sweepThenRepeat === true,
    startVertex,
    startOffset,
    ...LIGHTER_FIXED,
  };
}

// Bounded cache: the shell render is reused across repaints and export.
const cache = new Map<string, Promise<Uint8Array>>();

export async function lighterMeshes(
  c: LighterSettings,
  dir: string,
): Promise<{ body: Uint8Array }> {
  const key = JSON.stringify({ wall: c.wall, height: c.height });
  let pending = cache.get(key);
  if (!pending) {
    pending = (async () => {
      const command = await findOpenScad();
      const path = `${dir}/lighter-shell.stl`;
      const child = new Deno.Command(command, {
        args: [
          "-o",
          path,
          "-D",
          `wall=${c.wall}`,
          "-D",
          `height=${c.height}`,
          LIGHTER_SCAD,
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
            `OpenSCAD could not build the lighter case: ${
              new TextDecoder().decode(result.stderr).slice(-2000)
            }`,
          );
        }
        return await Deno.readFile(path);
      } finally {
        clearTimeout(timeout);
      }
    })();
    cache.set(key, pending);
    if (cache.size > 8) cache.delete(cache.keys().next().value!);
  }
  try {
    return { body: await pending };
  } catch (error) {
    cache.delete(key);
    throw error;
  }
}
