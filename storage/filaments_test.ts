import { FilamentStore, validateFilament } from "./filaments.ts";
import { transmission } from "../static/filaments.js";
function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
const sample = () => ({
  name: "Clear teal",
  brand: "Test",
  material: "PLA",
  color: "#00aabb",
  layerHeight: .2,
  samples: [{ thickness: .2, color: "#bbeeef" }, {
    thickness: .6,
    color: "#338899",
  }],
});
Deno.test("filament CRUD is file-backed and validates printable calibration steps", async () => {
  const root = await Deno.makeTempDir();
  const store = new FilamentStore(root);
  const request = (path = "", method = "GET", body?: unknown) =>
    store.handle(
      new Request("http://local/api/filaments" + path, {
        method,
        ...(body
          ? {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
          }
          : {}),
      }),
    );
  try {
    const created = await request("", "POST", sample());
    assert(created?.status === 201);
    const record = await created.json();
    const restored = await new FilamentStore(root).get(record.id);
    assert(restored.samples[1].thickness === .6);
    const invalid = sample();
    invalid.samples[0].thickness = .25;
    assert((await request("/" + record.id, "PUT", invalid))?.status === 400);
    assert((await store.get(record.id)).samples[0].thickness === .2);
    assert(
      (await request("/" + record.id, "PUT", {
        ...sample(),
        name: "Teal calibrated",
      }))?.status === 200,
    );
    assert((await store.get(record.id)).name === "Teal calibrated");
    await request("/" + record.id, "DELETE");
    assert((await request("/" + record.id))?.status === 404);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("transmission follows measured colors, darkens with thickness and interpolates optical density", () => {
  const f = validateFilament(sample(), crypto.randomUUID());
  const zero = transmission(f, 0),
    low = transmission(f, .2),
    mid = transmission(f, .4),
    high = transmission(f, .6);
  assert(zero.every((v: number) => Math.abs(v - 1) < 1e-8));
  for (let i = 0; i < 3; i++) {
    assert(low[i] > mid[i] && mid[i] > high[i]);
    assert(Math.abs(mid[i] - Math.sqrt(low[i] * high[i])) < 1e-8);
  }
});
