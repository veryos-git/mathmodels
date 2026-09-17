import { atomicWrite, ResourceStore } from "./resources.ts";
function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
function drawing(name = "Ghost", kind = "pattern") {
  const form = new FormData();
  form.set("name", name);
  form.set("kind", kind);
  form.set(
    "drawing",
    new File([
      '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1"/></svg>',
    ], "ghost.svg"),
  );
  return form;
}
async function isolated(test: (store: ResourceStore) => Promise<void>) {
  const root = await Deno.makeTempDir();
  try {
    await test(new ResourceStore(root));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}
Deno.test("traced pattern survives restart, rename and replacement with recoverable revisions", () =>
  isolated(async (store) => {
    const form = drawing();
    form.set("original", new File([new Uint8Array([1, 2, 3])], "scan.png"));
    form.set("edited", new File([new Uint8Array([4, 5, 6])], "edited.png"));
    form.set("trace", JSON.stringify({ threshold: 123, invert: false }));
    const first = await store.save(form);
    const restart = new ResourceStore(store.root);
    const loaded = await restart.get(first.id);
    assert(loaded.trace?.threshold === 123);
    assert(
      (await Deno.readFile(
        `${store.root}/${first.id}/${loaded.files.original!.path}`,
      ))[0] === 1,
    );
    assert(
      (await Deno.readFile(
        `${store.root}/${first.id}/${loaded.files.edited!.path}`,
      ))[0] === 4,
    );
    const rename = new FormData();
    rename.set("name", "Crystal");
    const renamed = await restart.save(rename, first.id);
    assert(renamed.id === first.id && renamed.name === "Crystal");
    assert(renamed.files.original?.path === first.files.original?.path);
    assert(renamed.created === first.created);
    const updated = await restart.save(drawing("Crystal"), first.id);
    assert(updated.revision !== first.revision);
    const history = JSON.parse(
      await Deno.readTextFile(
        `${store.root}/${first.id}/revisions/${first.revision}/resource.json`,
      ),
    );
    assert(history.name === "Ghost" && history.trace.threshold === 123);
    assert((await restart.list()).length === 1);
  }));
Deno.test("HTTP resource CRUD and validation leave existing records intact", () =>
  isolated(async (store) => {
    const request = (path: string, method = "GET", body?: FormData) =>
      store.handle(
        new Request("http://localhost/api/resources" + path, { method, body }),
      );
    assert((await (await request(""))!.json()).resources.length === 0);
    const created = await request("", "POST", drawing("Lantern", "boundary"));
    assert(created?.status === 201);
    const record = await created.json();
    const bad = drawing("Bad", "calibration");
    assert((await request("/" + record.id, "PUT", bad))?.status === 400);
    assert((await store.get(record.id)).name === "Lantern");
    assert((await request("/" + record.id + "/drawing"))?.status === 200);
    assert((await request("/" + record.id + "/original"))?.status === 404);
    assert((await request("/not-an-id"))?.status === 400);
    assert((await request("/" + record.id, "DELETE"))?.status === 200);
    assert((await request("/" + record.id))?.status === 404);
    assert((await store.list()).length === 0);
  }));
Deno.test("invalid uploads and trace settings do not publish resources", () =>
  isolated(async (store) => {
    for (
      const change of [
        (f: FormData) => f.set("trace", "[1,2]"),
        (f: FormData) => f.set("drawing", new File(["bad"], "drawing.exe")),
        (f: FormData) => f.delete("drawing"),
        (f: FormData) => f.set("name", " "),
      ]
    ) {
      const form = drawing();
      change(form);
      const response = await store.handle(
        new Request("http://localhost/api/resources", {
          method: "POST",
          body: form,
        }),
      );
      assert(response?.status === 400);
    }
    assert((await store.list()).length === 0);
  }));
Deno.test("atomic replacement publishes complete content without temporary files", () =>
  isolated(async (store) => {
    const path = `${store.root}/project.json`;
    await atomicWrite(path, '{"version":1}');
    await atomicWrite(path, '{"version":2}');
    assert(JSON.parse(await Deno.readTextFile(path)).version === 2);
    const files = [];
    for await (const file of Deno.readDir(store.root)) files.push(file.name);
    assert(files.length === 1 && files[0] === "project.json");
  }));

Deno.test("project import preserves trace images and roles and is repeatable", async () => {
  const { importProjectResources } = await import("./import_projects.ts");
  await isolated(async (store) => {
    const projects = `${store.root}/projects`;
    await Deno.mkdir(projects);
    const embedded = (name: string, content: string) => ({
      name,
      data: btoa(content),
    });
    await Deno.writeTextFile(
      `${projects}/ghost.v2sproj`,
      JSON.stringify({
        format: "vector2stl-project",
        drawing: embedded("ghost.svg", "<svg/>"),
        boundary: embedded("frame.dxf", "frame"),
        profile: embedded("profile.dxf", "profile"),
        trace: {
          source: embedded("edited.png", "edited"),
          original: embedded("original.png", "original"),
          params: { threshold: 99 },
        },
      }),
    );
    const first = await importProjectResources(projects, store);
    assert(first.added === 3 && first.skipped.length === 0);
    const records = await store.list();
    assert(new Set(records.map((r) => r.kind)).size === 3);
    const pattern = records.find((r) => r.kind === "pattern")!;
    assert(pattern.trace?.threshold === 99);
    assert(
      await Deno.readTextFile(
        `${store.root}/${pattern.id}/${pattern.files.original!.path}`,
      ) === "original",
    );
    const repeated = await importProjectResources(projects, store);
    assert(repeated.added === 0 && repeated.existing === 3);
    assert((await store.list()).length === 3);
  });
});

Deno.test("resource previews cover SVG and DXF, reuse cached geometry, and refresh on replacement", () =>
  isolated(async (store) => {
    let renders = 0;
    const previewStore = new ResourceStore(store.root, async (path) => {
      renders++;
      return `<svg><text>${await Deno.readTextFile(path)}</text></svg>`;
    });
    const svg = await previewStore.save(drawing());
    const response = await previewStore.handle(
      new Request(`http://localhost/api/resources/${svg.id}/preview`),
    );
    assert(response?.status === 200);
    assert(response.headers.get("content-type")?.includes("image/svg+xml"));
    assert((await response.text()).includes("<path"));
    for (const kind of ["pattern", "boundary", "profile"]) {
      const form = drawing("DXF input", kind);
      form.set("drawing", new File(["first"], "input.dxf"));
      const record = await previewStore.save(form);
      const before = renders;
      const results = await Promise.all([
        previewStore.preview(record.id),
        previewStore.preview(record.id),
      ]);
      assert((await results[0].text()).includes("first"));
      assert((await results[1].text()).includes("first"));
      assert(
        renders === before + 1,
        "Concurrent requests should share generation",
      );
      const restarted = new ResourceStore(store.root, async () => {
        throw new Error("Cache should be reused");
      });
      assert(
        (await (await restarted.preview(record.id)).text()).includes("first"),
      );
      const rename = new FormData();
      rename.set("name", "Renamed");
      await previewStore.save(rename, record.id);
      await previewStore.preview(record.id);
      assert(renders === before + 1, "Renaming should retain the thumbnail");
      form.set("drawing", new File(["second"], "input.dxf"));
      await previewStore.save(form, record.id);
      assert(
        (await (await previewStore.preview(record.id)).text()).includes(
          "second",
        ),
      );
      assert(
        renders === before + 2,
        "Replacing geometry should generate a new thumbnail",
      );
    }
  }));
