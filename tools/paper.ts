/// Paper mode templates: OpenSCAD files in paper_templates/ whose Customizer
/// parameters the app edits. tools/paper.py builds the net from them.

export const PAPER_TEMPLATE_DIR = "paper_templates";

export type PaperOption = { value: string | number; label: string };
export type PaperParameter = {
  name: string;
  label: string;
  group: string;
  description: string;
  type: "number" | "boolean" | "string";
  default: number | boolean | string;
  min?: number;
  max?: number;
  step?: number;
  options?: PaperOption[];
};
export type PaperTemplate = {
  id: string;
  name: string;
  description: string;
  parameters: PaperParameter[];
};

// The [Output] group chooses what OpenSCAD renders; the app sets it itself.
const APP_GROUPS = new Set(["Output"]);
const TEMPLATE_ID = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}\.scad$/;
const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

function literal(source: string): number | boolean | string | undefined {
  if (NUMBER.test(source)) return Number(source);
  if (source === "true" || source === "false") return source === "true";
  const text = source.match(/^"((?:[^"\\]|\\.)*)"$/);
  return text ? text[1].replace(/\\(.)/g, "$1") : undefined;
}

/** A Customizer annotation: [min:step:max], [min:max], [max], [a, b] or [a:Label, b:Label]. */
function annotate(parameter: PaperParameter, annotation: string) {
  const body = annotation.match(/^\[(.*)\]$/)?.[1]?.trim();
  if (!body) return;
  const isNumber = (s: string) => NUMBER.test(s.trim());
  if (!body.includes(",") && body.split(":").every(isNumber)) {
    if (parameter.type !== "number") return;
    const values = body.split(":").map(Number);
    if (values.length === 1) [parameter.min, parameter.max] = [0, values[0]];
    else if (values.length === 2) [parameter.min, parameter.max] = values;
    else [parameter.min, parameter.step, parameter.max] = values;
    return;
  }
  parameter.options = body.split(",").map((item) => {
    const [raw, ...label] = item.trim().split(":");
    const value = parameter.type === "number" && isNumber(raw) ? Number(raw) : raw.trim();
    return { value, label: (label.join(":") || String(raw)).trim() };
  });
}

/** The Customizer parameters a template exposes, in order, up to its [Hidden] group. */
export function parseTemplate(id: string, source: string): PaperTemplate {
  const parameters: PaperParameter[] = [];
  let group = "Parameters";
  let comments: string[] = [];
  const lines = source.split(/\r?\n/);
  // The template's description: the first paragraph of its first comment block
  // that is not a copyright line (layout sketches and notes may follow it).
  const description: string[] = [];
  for (const line of lines) {
    const comment = line.match(/^\s*\/\/\s?(.*)$/);
    if (!comment || !comment[1].trim()) {
      if (description.length) break;
      continue;
    }
    if (/copyright|licen[cs]ed/i.test(comment[1])) continue;
    description.push(comment[1].trim());
  }
  for (const line of lines) {
    const header = line.match(/^\s*\/\*\s*\[([^\]]+)\]\s*\*\/\s*$/);
    if (header) {
      group = header[1].trim();
      if (group === "Hidden") break;
      comments = [];
      continue;
    }
    const comment = line.match(/^\s*\/\/\s?(.*)$/);
    if (comment) {
      comments.push(comment[1].trim());
      continue;
    }
    const assignment = line.match(/^\s*([A-Za-z_]\w*)\s*=\s*(.+?)\s*;\s*(?:\/\/\s*(.*?))?\s*$/);
    const value = assignment ? literal(assignment[2]) : undefined;
    if (assignment && value !== undefined && !APP_GROUPS.has(group)) {
      const parameter: PaperParameter = {
        name: assignment[1],
        label: assignment[1].replace(/_/g, " "),
        group,
        description: comments.join(" "),
        type: typeof value as PaperParameter["type"],
        default: value,
      };
      if (assignment[3]) annotate(parameter, assignment[3]);
      parameters.push(parameter);
    }
    comments = [];
  }
  return {
    id,
    name: id.replace(/\.scad$/, "").replace(/[_-]+/g, " "),
    description: description.join(" "),
    parameters,
  };
}

export async function listTemplates(dir = PAPER_TEMPLATE_DIR): Promise<PaperTemplate[]> {
  const templates: PaperTemplate[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile || !TEMPLATE_ID.test(entry.name)) continue;
      templates.push(parseTemplate(entry.name, await Deno.readTextFile(`${dir}/${entry.name}`)));
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  // The house comes first: it is the default.
  return templates.sort((a, b) =>
    Number(b.id === "house.scad") - Number(a.id === "house.scad") || a.name.localeCompare(b.name)
  );
}

/**
 * Only the template's own parameters, each of its own type, so nothing but a
 * plain value can reach OpenSCAD. Missing parameters keep the template default.
 */
export function checkParams(
  template: PaperTemplate,
  raw: unknown,
): Record<string, number | boolean | string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("Expected the template parameters as an object");
  const known = new Map(template.parameters.map((p) => [p.name, p]));
  const params: Record<string, number | boolean | string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const parameter = known.get(name);
    if (!parameter) throw new Error(`The ${template.name} template has no parameter "${name}"`);
    if (parameter.options && !parameter.options.some((o) => o.value === value)) {
      throw new Error(`${parameter.label} must be one of: ${parameter.options.map((o) => o.label).join(", ")}`);
    }
    if (parameter.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error(`${parameter.label} must be a number`);
    }
    if (parameter.type === "boolean" && typeof value !== "boolean") {
      throw new Error(`${parameter.label} must be on or off`);
    }
    if (parameter.type === "string" && (typeof value !== "string" || !/^[\w .,:+-]{0,64}$/.test(value))) {
      throw new Error(`${parameter.label} may use letters, digits, spaces and . , : + -`);
    }
    params[name] = value as number | boolean | string;
  }
  return params;
}
