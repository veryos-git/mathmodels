/// Makes sure .venv exists and matches requirements.txt.
/// Runs before `deno task start`; a no-op once everything is in place.

const VENV = ".venv";
const PYTHON = `${VENV}/bin/python`;
const REQUIREMENTS = "requirements.txt";
const STAMP = `${VENV}/.requirements-sha256`;

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Run a command with its output attached to our terminal. */
async function run(cmd: string, args: string[]): Promise<boolean> {
  const child = new Deno.Command(cmd, { args, stdout: "inherit", stderr: "inherit" }).spawn();
  return (await child.status).success;
}

function die(message: string): never {
  console.error(`\nsetup failed: ${message}`);
  Deno.exit(1);
}

const wanted = await Deno.readTextFile(REQUIREMENTS).catch(() =>
  die(`${REQUIREMENTS} is missing`)
);
const wantedHash = await sha256(wanted);

// Fast path: the venv is present and was built from these exact requirements.
if (await exists(PYTHON)) {
  const stamp = await Deno.readTextFile(STAMP).catch(() => "");
  if (stamp.trim() === wantedHash) Deno.exit(0);
}

if (!(await exists(PYTHON))) {
  console.log("setting up the Python environment in .venv …");
  // --clear rebuilds in place, so a half-built venv left by an interrupted
  // run gets replaced rather than shadowing the new one.
  if (!(await run("python3", ["-m", "venv", "--clear", VENV]))) {
    die(
      "could not create .venv.\n" +
        "  Python 3 with the venv module is required. On Debian/Ubuntu:\n" +
        "    sudo apt install python3-venv",
    );
  }
} else {
  console.log("requirements.txt changed — updating .venv …");
}

if (!(await run(PYTHON, ["-m", "pip", "install", "--quiet", "-r", REQUIREMENTS]))) {
  die("pip could not install the requirements (see the output above)");
}

await Deno.writeTextFile(STAMP, wantedHash);
console.log("Python environment ready.\n");
