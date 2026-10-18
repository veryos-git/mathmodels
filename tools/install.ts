import { findOpenScad } from "./openscad.ts";

// Python setup runs first. Both start and dev depend on this task, so missing
// dependencies are installed before the server starts and existing ones reused.
try {
  console.log(`OpenSCAD ready: ${await findOpenScad()}`);
  Deno.exit(0);
} catch { /* Install below. */ }

async function available(command: string): Promise<boolean> {
  try {
    return (await new Deno.Command(command, {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).output()).success;
  } catch {
    return false;
  }
}

async function run(command: string, args: string[]) {
  const result = await new Deno.Command(command, {
    args,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (!result.success) {
    throw new Error(`${command} failed; see its output above.`);
  }
}

try {
  console.log(
    "Installing OpenSCAD (the system package manager may request administrator access)…",
  );
  if (Deno.build.os === "windows") {
    await run("winget", [
      "install",
      "--id=OpenSCAD.OpenSCAD",
      "-e",
      "--accept-package-agreements",
      "--accept-source-agreements",
    ]);
  } else if (Deno.build.os === "darwin") {
    await run("brew", ["install", "--cask", "openscad"]);
  } else {
    const manager = await available("apt-get")
      ? "apt-get"
      : await available("dnf")
      ? "dnf"
      : await available("pacman")
      ? "pacman"
      : null;
    if (!manager) {
      throw new Error(
        "Install OpenSCAD using your distribution's package manager, then rerun deno task install.",
      );
    }
    const root = Deno.uid() === 0;
    const install = (args: string[]) =>
      run(root ? manager : "sudo", root ? args : [manager, ...args]);
    if (manager === "apt-get") await install(["update"]);
    await install(
      manager === "pacman"
        ? ["-S", "--needed", "--noconfirm", "openscad"]
        : ["install", "-y", "openscad"],
    );
  }
  console.log(`OpenSCAD ready: ${await findOpenScad()}`);
} catch (error) {
  console.error(
    `Installation failed: ${error instanceof Error ? error.message : error}`,
  );
  Deno.exit(1);
}
