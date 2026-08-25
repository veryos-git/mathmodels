/// Makes sure .venv exists and matches requirements.txt.
/// Runs before `deno task start`; a no-op once everything is in place.

const VENV = ".venv";
const PYTHON = `${VENV}/bin/python`;
const REQUIREMENTS = "requirements.txt";
const STAMP = `${VENV}/.requirements-sha256`;

// The modules dxf2stl.py imports. Importing them is the real proof the venv
// works: a venv copied from another machine (or a changed system Python) can
// leave the .venv directory in place while its interpreter can no longer find
// the packages, and only actually importing them catches that.
const PROBE = "import ezdxf, svgelements, shapely, trimesh, mapbox_earcut";

// The pinned stack (shapely 2.1, trimesh 4.x) needs a reasonably modern Python.
const MIN_PYTHON: [number, number] = [3, 10];
// Interpreters to build the venv from, newest first. `python3` is last because
// on some setups it is shadowed by an old distribution (e.g. an Anaconda 3.9),
// and we would rather use a newer python3.NN that is also on PATH.
const PYTHON_CANDIDATES = [
  "python3.13",
  "python3.12",
  "python3.11",
  "python3.10",
  "python3",
];

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** True when the venv's interpreter can import everything the app needs. */
async function healthy(): Promise<boolean> {
  if (!(await exists(PYTHON))) return false;
  try {
    const check = new Deno.Command(PYTHON, {
      args: ["-c", PROBE],
      stdout: "null",
      stderr: "null",
    }).spawn();
    return (await check.status).success;
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

/** (major, minor) an interpreter reports, or null if it will not run. */
async function pythonVersion(cmd: string): Promise<[number, number] | null> {
  try {
    const out = await new Deno.Command(cmd, {
      args: ["-c", "import sys; print(sys.version_info[0], sys.version_info[1])"],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!out.success) return null;
    const [maj, min] = new TextDecoder().decode(out.stdout).trim().split(/\s+/).map(Number);
    return Number.isFinite(maj) && Number.isFinite(min) ? [maj, min] : null;
  } catch {
    return null; // not installed / not permitted
  }
}

/** The newest available interpreter that meets MIN_PYTHON. */
async function pickPython(): Promise<string> {
  const [needMaj, needMin] = MIN_PYTHON;
  for (const cmd of PYTHON_CANDIDATES) {
    const v = await pythonVersion(cmd);
    if (v && (v[0] > needMaj || (v[0] === needMaj && v[1] >= needMin))) return cmd;
  }
  die(
    `no Python >= ${needMaj}.${needMin} found (needed by shapely/trimesh).\n` +
      "  Install one, e.g. on Debian/Ubuntu:\n" +
      `    sudo apt install python${needMaj}.${needMin} python${needMaj}.${needMin}-venv`,
  );
}

function die(message: string): never {
  console.error(`\nsetup failed: ${message}`);
  Deno.exit(1);
}

const wanted = await Deno.readTextFile(REQUIREMENTS).catch(() =>
  die(`${REQUIREMENTS} is missing`)
);
const wantedHash = await sha256(wanted);

// Fast path: the venv was built from these exact requirements and its
// interpreter can still import them. Both must hold — a matching stamp alone
// does not prove the packages are reachable.
const stamp = await Deno.readTextFile(STAMP).catch(() => "");
if (stamp.trim() === wantedHash && (await healthy())) Deno.exit(0);

// Rebuild whenever the venv is missing, broken (packages unreachable), or built
// from stale requirements. Reusing an unhealthy venv only reinstalls into a
// broken interpreter, so we recreate it from scratch in that case.
if (!(await healthy())) {
  const python = await pickPython();
  console.log(`setting up the Python environment in .venv (via ${python}) …`);
  // --clear rebuilds in place, so a half-built or mismatched venv (for example
  // one copied from another machine, or built from an older Python) gets
  // replaced rather than shadowing the new one.
  if (!(await run(python, ["-m", "venv", "--clear", VENV]))) {
    die(
      "could not create .venv.\n" +
        "  Python 3 with the venv module is required. On Debian/Ubuntu:\n" +
        "    sudo apt install python3-venv",
    );
  }
} else {
  console.log("requirements.txt changed — updating .venv …");
}

// A fresh venv can ship an old pip that cannot even see current wheels (it
// skips packages whose metadata is too new), so bring it up to date first.
if (!(await run(PYTHON, ["-m", "pip", "install", "--quiet", "--upgrade", "pip"]))) {
  die("could not upgrade pip in .venv (see the output above)");
}

if (!(await run(PYTHON, ["-m", "pip", "install", "--quiet", "-r", REQUIREMENTS]))) {
  die("pip could not install the requirements (see the output above)");
}

await Deno.writeTextFile(STAMP, wantedHash);
console.log("Python environment ready.\n");
