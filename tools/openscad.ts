/** OpenSCAD discovery shared by the installer and HTTP backend. */
export function openScadCandidates(): string[] {
  return Deno.build.os === "windows"
    ? ["openscad.com", "C:/Program Files/OpenSCAD/openscad.com"]
    : Deno.build.os === "darwin"
    ? ["openscad", "/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD"]
    : ["openscad"];
}

export async function findOpenScad(): Promise<string> {
  for (const command of openScadCandidates()) {
    try {
      const result = await new Deno.Command(command, {
        args: ["--version"],
        stdout: "null",
        stderr: "null",
      }).output();
      if (result.success) return command;
    } catch { /* Try the next platform location. */ }
  }
  throw new Error(
    "OpenSCAD is missing. Run deno task install, then restart the server.",
  );
}
