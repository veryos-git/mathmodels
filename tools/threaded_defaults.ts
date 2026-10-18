const sourceUrl = new URL(
  "../hgc/cylinder_shell_mode/threaded_container.scad",
  import.meta.url,
);

// Read the numeric/boolean Customizer defaults; the supplied design stays intact.
// Reject expressions here rather than silently using stale application values.
export function readThreadedDefaults() {
  const source = Deno.readTextFileSync(sourceUrl);
  const parameters: Record<string, number | boolean> = {};
  const customizer = source.split("/* [Hidden] */")[0];
  for (
    const match of customizer.matchAll(
      /^\s*(\w+)\s*=\s*(-?\d+(?:\.\d*)?(?:e[+-]?\d+)?|true|false)\s*;/gmi,
    )
  ) {
    parameters[match[1]] = match[2] === "true"
      ? true
      : match[2] === "false"
      ? false
      : Number(match[2]);
  }
  const number = (name: string) => {
    const value = parameters[name];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(
        `Expected a numeric ${name} default in threaded_container.scad`,
      );
    }
    return value;
  };
  const top = parameters.top_chamfer_enabled !== false;
  const bottom = parameters.bottom_chamfer_enabled !== false;
  const design = {
    lidHeight: number("lid_height"),
    threadHeight: number("lid_thread_height"),
    rimClearance: number("rim_clearance"),
    axialClearance: number("axial_clearance"),
    stop: number("external_thread_top_surface_extrusion"),
    baseEntry: number("base_thread_entry_chamfer"),
    lidEntry: number("lid_thread_entry_chamfer"),
    baseTopChamfer: top ? number("base_chamfer") : 0,
    baseBottomChamfer: bottom ? number("base_chamfer") : 0,
    lidTopChamfer: top ? number("lid_chamfer") : 0,
    lidBottomChamfer: bottom ? number("lid_chamfer") : 0,
  };
  const thickness = number("wall_thickness");
  const neck = number("neck_height") ||
    design.lidHeight - thickness - design.rimClearance;
  return {
    source,
    parameters,
    design,
    defaults: {
      diameter: number("outer_diameter"),
      height: number("full_height") - design.lidHeight + neck,
      thickness,
      bottom: thickness,
      lidTop: thickness,
      neck,
      pitch: number("thread_pitch"),
      clearance: number("radial_clearance"),
      seamGap: 0.2,
      lid: false,
      threaded: true,
    },
  };
}
