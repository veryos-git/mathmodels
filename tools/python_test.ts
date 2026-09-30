import { findPython, type PythonCommand } from "./python.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

Deno.test("Windows setup prefers the Python launcher without requiring PATH python", async () => {
  const python = await findPython("windows", () => Promise.resolve(true));
  assert(
    python.command === "py" && python.args.join(" ") === "-3",
    "expected py -3",
  );
});

Deno.test("Windows setup falls back past missing or unsupported interpreters", async () => {
  const attempted: string[] = [];
  const python = await findPython("windows", (candidate: PythonCommand) => {
    attempted.push(candidate.command);
    return Promise.resolve(candidate.command === "python3");
  });
  assert(
    attempted.join(",") === "py,python,python3",
    "expected all Windows candidates",
  );
  assert(
    python.command === "python3" && python.args.length === 0,
    "unexpected interpreter",
  );
});

Deno.test("Unix setup supports both python3 and python installations", async () => {
  for (const os of ["linux", "darwin"] as const) {
    const python = await findPython(
      os,
      (candidate) => Promise.resolve(candidate.command === "python"),
    );
    assert(python.command === "python", "expected python fallback");
  }
});

Deno.test("missing supported Python gives installation guidance", async () => {
  for (const os of ["windows", "linux"] as const) {
    try {
      await findPython(os, () => Promise.resolve(false));
      throw new Error("expected setup to fail");
    } catch (error) {
      assert(
        error instanceof Error && error.message.includes("Python 3.12"),
        "expected version guidance",
      );
      assert(
        error.message.includes(os === "windows" ? "PATH" : "python3-venv"),
        "expected platform guidance",
      );
    }
  }
});
