import {
  cylinderRenderPlan,
  cylinderSettings,
  readThreadedDefaults,
} from "./cylinder.ts";

Deno.test("cylinder settings validate dimensions against the current SCAD defaults", () => {
  const scad = readThreadedDefaults();
  const plain = cylinderSettings({});
  if (plain.lid || plain.thickness !== scad.defaults.thickness) {
    throw new Error("Wrong shell defaults");
  }
  for (
    const bad of [
      { diameter: Infinity },
      { thickness: -1 },
      { lid: "true" },
      { diameter: 10, thickness: 3, lid: true },
      { bottom: 500 },
      { lid: true, thickness: 0.6 },
      { lid: true, thickness: 12 },
      { lid: true, height: 11 },
      { seamGap: 3 },
      { repeatX: 0 },
      { repeatY: 1.5 },
      { repeatX: 13 },
      { repeatX: 9, repeatY: 8 },
      { repeatX: "2" },
      { sweepThenRepeat: "true" },
      { topChamfer: -0.1 },
      { topChamfer: Infinity },
      { topChamfer: "0.3" },
      { thickness: 1.2, topChamfer: 0.6 },
      { height: 5, bottom: 4.8, topChamfer: 0.3 },
    ]
  ) {
    let failed = false;
    try {
      cylinderSettings(bad);
    } catch {
      failed = true;
    }
    if (!failed) {
      throw new Error(`Accepted invalid settings: ${JSON.stringify(bad)}`);
    }
  }
  cylinderSettings({ lid: true, threaded: false, clearance: 0.5, neck: 1 });
  const repeated = cylinderSettings({ repeatX: 4, repeatY: 3 });
  if (repeated.repeatX !== 4 || repeated.repeatY !== 3) {
    throw new Error("Lost repeats");
  }
  if (repeated.sweepThenRepeat || !cylinderSettings({ sweepThenRepeat: true }).sweepThenRepeat) {
    throw new Error("Sketch repeats are the default; sweeping first must be kept");
  }
});

Deno.test("top rim chamfer is optional, saved in settings and only applied without a lid", () => {
  if (cylinderSettings({}).topChamfer !== 0) throw new Error("Old projects must keep a square rim");
  const c = cylinderSettings({ thickness: 1.2, topChamfer: .4 });
  const plan = cylinderRenderPlan(c);
  if (c.topChamfer !== .4 || plan.parameters.top_chamfer !== .4 || plan.parameters.edge_chamfer !== 0) {
    throw new Error("The top chamfer must not change the bottom edge");
  }
  const plainLid = cylinderRenderPlan(cylinderSettings({ lid: true, threaded: false, topChamfer: .4 }));
  if (plainLid.parameters.top_chamfer !== 0) throw new Error("An open-rim chamfer changed a lidded shell");
  const screw = cylinderRenderPlan(cylinderSettings({ lid: true, topChamfer: .4 }));
  if ("top_chamfer" in screw.parameters) throw new Error("An open-rim chamfer changed the screw-lid design");
});

Deno.test("screw lids leave model defaults to the supplied SCAD and override only requested sizes", () => {
  const c = cylinderSettings({ lid: true });
  const plan = cylinderRenderPlan(c);
  if (plan.source !== "tools/threaded-container.scad") {
    throw new Error("Missing source adapter");
  }
  const modelKeys = (p: Record<string, number | boolean>) =>
    Object.keys(p).filter((k) => !k.startsWith("app_"));
  if (modelKeys(plan.parameters).length) {
    throw new Error("Default container overrides SCAD model parameters");
  }
  const sized = cylinderRenderPlan(
    cylinderSettings({ lid: true, diameter: 80, height: 60, thickness: 2 }),
  );
  if (
    modelKeys(sized.parameters).sort().join() !==
      "full_height,outer_diameter,wall_thickness"
  ) {
    throw new Error(
      "Sizing overrode thread, lid, chamfer or clearance defaults",
    );
  }
  const legacy = cylinderSettings({
    lid: true,
    bottom: 3,
    lidTop: 4,
    neck: 6,
    pitch: 1,
    clearance: .3,
  });
  if (
    legacy.pitch !== c.pitch || legacy.neck !== c.neck ||
    legacy.clearance !== c.clearance ||
    legacy.bottom !== legacy.thickness || legacy.lidTop !== legacy.thickness
  ) {
    throw new Error("Old project values masked the current screw-lid defaults");
  }
  const d = c.threadedDesign!;
  if (
    plan.parameters.app_lid_z !== c.height - c.neck + d.stop ||
    plan.parameters.app_lid_angle !== 360 * d.stop / c.pitch
  ) throw new Error("Lid alignment was lost");
  for (const settings of [{ lid: false }, { lid: true, threaded: false }]) {
    const plain = cylinderRenderPlan(cylinderSettings(settings));
    if (
      plain.source !== "tools/cylinder-container.scad" ||
      plain.parameters.threaded
    ) throw new Error("Wrong plain shell");
  }
});

Deno.test({
  name:
    "start installs OpenSCAD before serving, reuses it, and stops on installation failure",
  ignore: Deno.build.os !== "linux",
  async fn() {
    const root = await Deno.makeTempDir({ prefix: "mathmodels-openscad-" });
    try {
      await Deno.mkdir(`${root}/bin`);
      await Deno.mkdir(`${root}/tools`);
      for (const name of ["install.ts", "openscad.ts"]) {
        await Deno.copyFile(
          new URL(name, import.meta.url),
          `${root}/tools/${name}`,
        );
      }
      // Exercise the real task dependencies and permissions, with local stand-ins
      // for Python setup, the package manager, and the HTTP server.
      await Deno.copyFile(
        new URL("../deno.json", import.meta.url),
        `${root}/deno.json`,
      );
      await Deno.writeTextFile(`${root}/.env`, "");
      await Deno.symlink(Deno.execPath(), `${root}/bin/deno`);
      await Deno.writeTextFile(
        `${root}/tools/setup.ts`,
        'await Deno.mkdir(".venv", { recursive: true });\n' +
          'await Deno.writeTextFile(".venv/setup-done", "");\n',
      );
      await Deno.writeTextFile(
        `${root}/server.ts`,
        'await Deno.stat(".venv/setup-done");\n' +
          'await Deno.stat("installed");\n' +
          'await Deno.mkdir(".tmp", { recursive: true });\n' +
          'await Deno.writeTextFile(".tmp/server-started", "");\n',
      );
      const commands = {
        openscad: "#!/bin/sh\n[ -f installed ]\n",
        sudo: '#!/bin/sh\nexec "$@"\n',
        "apt-get":
          '#!/bin/sh\n[ "$1" = --version ] && exit 0\n[ -f .venv/setup-done ] || exit 1\n[ -f fail ] && exit 1\nprintf "%s\\n" "$*" >> calls\n[ "$1" = install ] && : > installed\nexit 0\n',
      };
      for (const [name, source] of Object.entries(commands)) {
        await Deno.writeTextFile(`${root}/bin/${name}`, source);
        await Deno.chmod(`${root}/bin/${name}`, 0o755);
      }
      const task = (name: string) =>
        new Deno.Command(Deno.execPath(), {
          args: ["task", name],
          cwd: root,
          env: { PATH: `${root}/bin` },
          stdout: "piped",
          stderr: "piped",
        }).output();
      const first = await task("start");
      if (!first.success) {
        throw new Error(new TextDecoder().decode(first.stderr));
      }
      await Deno.stat(`${root}/.tmp/server-started`);
      const calls = await Deno.readTextFile(`${root}/calls`);
      if (calls !== "update\ninstall -y openscad\n") {
        throw new Error(`Unexpected install: ${calls}`);
      }
      if (
        !(await task("start")).success ||
        !(await task("install")).success ||
        await Deno.readTextFile(`${root}/calls`) !== calls
      ) {
        throw new Error("An existing OpenSCAD install was not reused");
      }
      await Deno.remove(`${root}/installed`);
      await Deno.remove(`${root}/.tmp/server-started`);
      await Deno.writeTextFile(`${root}/fail`, "");
      const failed = await task("start");
      if (
        failed.success ||
        !new TextDecoder().decode(failed.stderr).includes("Installation failed")
      ) {
        throw new Error("Package-manager failure was hidden");
      }
      if (
        await Deno.stat(`${root}/.tmp/server-started`).catch(() => null)
      ) {
        throw new Error("Server started despite installation failure");
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
