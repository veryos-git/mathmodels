Deno.test("setup creates and reuses a venv, and repairs an interrupted pip install", async () => {
  // Spaces also exercise Windows-style project paths. No packages or network needed.
  const root = await Deno.makeTempDir({ prefix: "mathmodels setup " });
  try {
    await Deno.mkdir(`${root}/tools`);
    for (const name of ["setup.ts", "python.ts"]) {
      await Deno.copyFile(
        new URL(name, import.meta.url),
        `${root}/tools/${name}`,
      );
    }
    const config = JSON.parse(
      await Deno.readTextFile(new URL("../deno.json", import.meta.url)),
    );
    await Deno.writeTextFile(
      `${root}/deno.json`,
      JSON.stringify({ tasks: { setup: config.tasks.setup } }),
    );
    await Deno.writeTextFile(`${root}/requirements.txt`, "");
    const setup = async () => {
      const result = await new Deno.Command(Deno.execPath(), {
        args: ["task", "setup"],
        cwd: root,
        env: { PIP_NO_INDEX: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1" },
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (!result.success) {
        throw new Error(new TextDecoder().decode(result.stderr));
      }
      return new TextDecoder().decode(result.stdout);
    };
    if (!(await setup()).includes("Python environment ready")) {
      throw new Error("first run did not set up Python");
    }
    const stamp = await Deno.readTextFile(`${root}/.venv/.requirements-sha256`);
    if ((await setup()).trim()) {
      throw new Error("second run should reuse the environment");
    }

    let pipMain = `${root}/.venv/Lib/site-packages/pip/__main__.py`;
    if (Deno.build.os !== "windows") {
      for await (const entry of Deno.readDir(`${root}/.venv/lib`)) {
        if (entry.name.startsWith("python3")) {
          pipMain =
            `${root}/.venv/lib/${entry.name}/site-packages/pip/__main__.py`;
          break;
        }
      }
    }
    await Deno.writeTextFile(
      pipMain,
      "raise ImportError('interrupted pip install')\n",
    );
    await Deno.writeTextFile(
      `${root}/requirements.txt`,
      "# changed requirements\n",
    );
    if (!(await setup()).includes("Python environment ready")) {
      throw new Error("setup did not repair pip");
    }
    if (
      await Deno.readTextFile(`${root}/.venv/.requirements-sha256`) === stamp
    ) {
      throw new Error("setup did not record changed requirements");
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
