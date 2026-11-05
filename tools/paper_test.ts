import { checkParams, listTemplates, parseTemplate } from "./paper.ts";

const assert = (ok: boolean, message: string) => {
  if (!ok) throw new Error(message);
};
const throws = (fn: () => unknown, pattern: RegExp) => {
  try {
    fn();
  } catch (error) {
    assert(pattern.test((error as Error).message), `unexpected error: ${(error as Error).message}`);
    return;
  }
  throw new Error(`expected an error matching ${pattern}`);
};

const SOURCE = `// Copyright (C) someone
// A box that folds.
// Second line.
//
//   +---+  a layout sketch, not part of the description

/* [Output] */
output = "flat"; // [flat, cut]

/* [Box] */
// How wide.
size = 50; // [30:1:90]
lid = true;
style = "plain"; // [plain:Plain box, fancy:Fancy box]
count = 3; // [2, 3, 4]
depth = 10; // [20]
span = size * 2;
label = "box";

/* [Hidden] */
secret = 1;
`;

Deno.test("customizer parameters are read in order, up to [Hidden], without the app's [Output]", () => {
  const t = parseTemplate("folding_box.scad", SOURCE);
  assert(t.name === "folding box", t.name);
  assert(t.description === "A box that folds. Second line.", t.description);
  assert(t.parameters.map((p) => p.name).join() === "size,lid,style,count,depth,label", t.parameters.map((p) => p.name).join());
  const [size, lid, style, count, depth] = t.parameters;
  assert(size.group === "Box" && size.description === "How wide.", JSON.stringify(size));
  assert(size.min === 30 && size.step === 1 && size.max === 90 && size.default === 50, JSON.stringify(size));
  assert(lid.type === "boolean" && lid.default === true, JSON.stringify(lid));
  assert(style.options?.[1].value === "fancy" && style.options?.[1].label === "Fancy box", JSON.stringify(style));
  assert(count.options?.map((o) => o.value).join() === "2,3,4" && typeof count.options[0].value === "number",
    JSON.stringify(count));
  assert(depth.min === 0 && depth.max === 20, JSON.stringify(depth));
});

Deno.test("only the template's own parameters, of their own types, pass", () => {
  const t = parseTemplate("box.scad", SOURCE);
  const ok = checkParams(t, { size: 60, lid: false, style: "fancy", count: 4, label: "my box" });
  assert(ok.size === 60 && ok.style === "fancy", JSON.stringify(ok));
  assert(Object.keys(checkParams(t, undefined)).length === 0, "nothing given, nothing set");
  throws(() => checkParams(t, { output: "cut" }), /no parameter "output"/);
  throws(() => checkParams(t, { secret: 2 }), /no parameter "secret"/);
  throws(() => checkParams(t, { size: "60" }), /must be a number/);
  throws(() => checkParams(t, { size: Infinity }), /must be a number/);
  throws(() => checkParams(t, { lid: 1 }), /on or off/);
  throws(() => checkParams(t, { style: 'plain"; system("x")' }), /must be one of: Plain box, Fancy box/);
  throws(() => checkParams(t, { count: "3" }), /must be one of/);
  throws(() => checkParams(t, { label: 'a"; b = 1; c="' }), /may use letters/);
  throws(() => checkParams(t, [1]), /as an object/);
});

Deno.test("the house template ships first, with plain walls", async () => {
  const [house, ...others] = await listTemplates();
  const row = others.find((t) => t.id === "papercut_fold_house2.scad");
  assert(!!row, "the row house template is listed");
  assert(row!.description.startsWith("One-piece paper house net for an A4 sheet.") && !row!.description.includes("+---"),
    row!.description);
  assert(row!.parameters.some((p) => p.name === "door_width") && !row!.parameters.some((p) => p.name === "output"),
    "its own parameters, without the app's [Output]");
  assert(!row!.parameters.some((p) => /window/.test(p.name)), "windows come from decorations, not the template");
  assert(house.id === "house.scad", house.id);
  const names = house.parameters.map((p) => p.name);
  for (const name of ["house_size", "wall_height", "roof_height", "roof_style", "glue_tab_width", "tab_inset"]) {
    assert(names.includes(name), `missing ${name}`);
  }
  for (const name of ["output", "show_fold_guides", "paper_thickness", "decorations", "wall_index"]) {
    assert(!names.includes(name), `${name} is not the user's to set`);
  }
  assert(!/window/i.test(names.join()), "windows come from decorations, not the template");
});
