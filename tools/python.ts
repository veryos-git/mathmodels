/** Shared interpreter selection for setup, the server and command-line tasks. */
export const VENV = ".venv";
export const PYTHON = Deno.build.os === "windows"
  ? `${VENV}/Scripts/python.exe`
  : `${VENV}/bin/python`;

export type PythonCommand = { command: string; args: string[] };

/** Probe the actual interpreter, skipping missing commands and Windows Store aliases. */
export async function supportsPython(command: PythonCommand): Promise<boolean> {
  try {
    const result = await new Deno.Command(command.command, {
      args: [
        ...command.args,
        "-c",
        "import sys; sys.exit(sys.version_info < (3, 12))",
      ],
      stdout: "null",
      stderr: "null",
    }).output();
    return result.success;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

export async function findPython(
  os = Deno.build.os,
  probe = supportsPython,
): Promise<PythonCommand> {
  const candidates = os === "windows"
    ? [{ command: "py", args: ["-3"] }, { command: "python", args: [] }, {
      command: "python3",
      args: [],
    }]
    : [{ command: "python3", args: [] }, { command: "python", args: [] }];
  for (const candidate of candidates) {
    if (await probe(candidate)) return candidate;
  }
  throw new Error(
    "Python 3.12 or newer is required. Install Python and reopen your terminal.\n" +
      (os === "windows"
        ? "  Install from https://www.python.org/downloads/windows/ with the Python launcher or Add Python to PATH enabled."
        : "  Make sure python3 is on PATH; on Debian/Ubuntu also install python3-venv."),
  );
}

if (import.meta.main) {
  const child = new Deno.Command(PYTHON, {
    args: Deno.args,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  Deno.exit((await child.status).code);
}
