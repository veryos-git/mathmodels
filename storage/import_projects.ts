import { type ResourceKind, ResourceStore } from "./resources.ts";
type Embedded = { name?: string; data?: string };
type Project = {
  format?: string;
  drawing?: Embedded;
  drawings?: Embedded[];
  boundary?: Embedded;
  profile?: Embedded;
  tracery?: { cusps?: Embedded; profile?: Embedded };
  trace?: {
    source?: Embedded;
    original?: Embedded;
    params?: Record<string, unknown>;
  };
};
function file(value: Embedded | undefined): File | null {
  if (!value?.data || !value.name) return null;
  return new File(
    [Uint8Array.from(atob(value.data), (c) => c.charCodeAt(0))],
    value.name,
  );
}
/** Non-destructive and idempotent: include the role and complete trace inputs in
 * the identity, so identical SVGs with different editable sources stay distinct. */
export async function importProjectResources(
  root: string,
  store: ResourceStore,
) {
  const result = { added: 0, existing: 0, skipped: [] as string[] };
  try {
    for await (const entry of Deno.readDir(root)) {
      if (!entry.isFile || !entry.name.endsWith(".v2sproj")) continue;
      try {
        const project: Project = JSON.parse(
          await Deno.readTextFile(`${root}/${entry.name}`),
        );
        if (project?.format !== "vector2stl-project") {
          throw new Error("Unknown project format");
        }
        const inputs: Array<
          [ResourceKind, Embedded | undefined, Project["trace"]?]
        > = [
          ["subject", project.drawing, project.trace],
          ...(project.drawings ?? []).map((
            d,
          ): [ResourceKind, Embedded] => ["subject", d]),
          ["subject", project.tracery?.cusps],
          ["profile", project.tracery?.profile],
          ["boundary", project.boundary],
          ["profile", project.profile],
        ];
        const idFor = async (
          kind: string,
          input: Embedded,
          trace: Project["trace"],
        ) => {
          const key = JSON.stringify([kind, input.data, trace ?? null]);
          const digest = new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(key),
            ),
          );
          const hex = [...digest].map((b) => b.toString(16).padStart(2, "0"))
            .join("");
          return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${
            hex.slice(12, 16)
          }-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
        };
        for (const [kind, input, trace] of inputs) {
          if (!input) continue;
          try {
            const drawing = file(input);
            if (!drawing) throw new Error("Missing drawing");
            // Resources imported before the rename derived their id from the
            // old "pattern" role, so look for that id too and stay idempotent.
            const ids = kind === "subject"
              ? [
                await idFor("subject", input, trace),
                await idFor("pattern", input, trace),
              ]
              : [await idFor(kind, input, trace)];
            const id = ids[0];
            const records = await store.list();
            if (records.some((r) => ids.includes(r.id))) {
              result.existing++;
              continue;
            }
            const form = new FormData();
            form.set(
              "name",
              drawing.name.replace(/\.[^.]+$/, "").slice(0, 120),
            );
            form.set("kind", kind);
            form.set("drawing", drawing);
            if (trace?.source) {
              const original = file(trace.original ?? trace.source);
              const edited = file(trace.source);
              if (original) form.set("original", original);
              if (edited) form.set("edited", edited);
              form.set("trace", JSON.stringify(trace.params ?? {}));
            }
            await store.save(form, id);
            result.added++;
          } catch (e) {
            result.skipped.push(
              `${entry.name}: ${input.name ?? kind}: ${
                e instanceof Error ? e.message : e
              }`,
            );
          }
        }
      } catch (e) {
        result.skipped.push(
          `${entry.name}: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  return result;
}
