// Checking a tool call's arguments against the tool's schema before running
// it. A model that leaves out a required argument, or sends one of the wrong
// type, gets an error that names the problem and the tool's parameters, instead
// of a tool running on `undefined`. Smaller models make these mistakes often.

type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  description?: string;
};

/** Parse a call's arguments: a JSON object, or empty for none. */
export function parseArgs(raw: string): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  if (!raw.trim()) return { ok: true, args: {} };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: `the arguments are not valid JSON (${err instanceof Error ? err.message : String(err)}); send one JSON object`,
    };
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    return { ok: false, error: "the arguments must be one JSON object, with a key per parameter" };
  }
  return { ok: true, args: v as Record<string, unknown> };
}

/**
 * Arguments sent as text where the schema wants another type, converted:
 * `"{}"` for an object, `"[1]"` for an array, `"50"` for a number, `"true"`
 * for a boolean. Models often stringify nested values. Anything that does
 * not convert cleanly is left for checkArgs to report.
 */
export function coerceArgs(parameters: unknown, args: Record<string, unknown>): Record<string, unknown> {
  const props = (parameters as Schema | undefined)?.properties;
  if (!props) return args;
  const out = { ...args };
  for (const [key, value] of Object.entries(args)) {
    const want = props[key]?.type;
    if (typeof value !== "string" || want === undefined) continue;
    const types = Array.isArray(want) ? want : [want];
    if (types.includes("string")) continue;
    const text = value.trim();
    if ((types.includes("object") || types.includes("array")) && /^[[{]/.test(text)) {
      try {
        const v = parseLenient(text);
        if (types.some((t) => isType(v, t))) out[key] = v;
      } catch {
        // left as is
      }
    } else if ((types.includes("number") || types.includes("integer")) && /^-?\d+(\.\d+)?$/.test(text)) {
      const n = Number(text);
      if (types.some((t) => isType(n, t))) out[key] = n;
    } else if (types.includes("boolean") && (text === "true" || text === "false")) {
      out[key] = text === "true";
    }
  }
  return out;
}

/** What is wrong with `args` for a tool with these parameters, or undefined when nothing is. */
export function checkArgs(parameters: unknown, args: Record<string, unknown>): string | undefined {
  const schema = parameters as Schema;
  if (!schema || typeof schema !== "object") return undefined;
  const problems: string[] = [];
  for (const key of schema.required ?? []) {
    if (args[key] === undefined || args[key] === null) problems.push(`missing required argument "${key}"`);
  }
  for (const [key, value] of Object.entries(args)) {
    const want = schema.properties?.[key]?.type;
    if (value === undefined || value === null || want === undefined) continue;
    const types = Array.isArray(want) ? want : [want];
    if (!types.some((t) => isType(value, t)))
      problems.push(`"${key}" must be ${types.join(" or ")}, not ${typeOf(value)}`);
  }
  if (problems.length === 0) return undefined;
  return `${problems.join("; ")}. Parameters: ${describeParams(schema)}`;
}

/** One line per parameter: name, type, required, description. */
export function describeParams(parameters: unknown): string {
  const schema = parameters as Schema;
  const props = Object.entries(schema?.properties ?? {});
  if (props.length === 0) return "none";
  const required = new Set(schema.required ?? []);
  return props
    .map(([k, p]) => {
      const type = Array.isArray(p?.type) ? p.type.join("|") : (p?.type ?? "any");
      return `${k} (${type}${required.has(k) ? ", required" : ""})`;
    })
    .join(", ");
}

function isType(v: unknown, t: string): boolean {
  switch (t) {
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number";
    case "integer":
      return Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
    case "array":
      return Array.isArray(v);
    case "object":
      return typeof v === "object" && v !== null && !Array.isArray(v);
    default:
      return true;
  }
}

function typeOf(v: unknown): string {
  return Array.isArray(v) ? "an array" : v === null ? "null" : `a ${typeof v}`;
}

/**
 * Parameters for a tool defined without any: the keys and JSON types of its
 * test arguments, or else the names destructured by its default export
 * (`export default async ({ text, limit }) => …`), all required. Undefined
 * when neither says anything.
 */
export function inferParameters(testArgs: unknown, source: string): Record<string, unknown> | undefined {
  if (testArgs && typeof testArgs === "object" && !Array.isArray(testArgs) && Object.keys(testArgs).length > 0) {
    const entries = Object.entries(testArgs);
    return {
      type: "object",
      properties: Object.fromEntries(entries.map(([k, v]) => [k, { type: jsonType(v) }])),
      required: entries.map(([k]) => k),
    };
  }
  const m = source.match(/export\s+default\s+(?:async\s+)?(?:function\s*\w*\s*)?\(\s*\{([^}]*)\}/);
  const names = (m?.[1] ?? "")
    .split(",")
    .map((p) => p.split(/[=:]/)[0]?.trim() ?? "")
    .filter((p) => /^[A-Za-z_$][\w$]*$/.test(p));
  if (names.length === 0) return undefined;
  return { type: "object", properties: Object.fromEntries(names.map((n) => [n, {}])), required: names };
}

function jsonType(v: unknown): string {
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  return typeof v === "object" ? "object" : typeof v;
}

/** Whether a schema declares no parameters at all. */
export function isEmptySchema(schema: Record<string, unknown>): boolean {
  const props = schema.properties as Record<string, unknown> | undefined;
  return !props || Object.keys(props).length === 0;
}

/**
 * A tool's parameters as a JSON Schema for an object. Models often send the
 * properties alone (`{"a": {"type": "number"}}`); those become the properties
 * of an object schema, all required. Anything else unusable becomes an empty
 * object schema.
 */
export function normalizeParameters(p: unknown): Record<string, unknown> {
  if (!p || typeof p !== "object" || Array.isArray(p)) return { type: "object", properties: {} };
  const o = p as Record<string, unknown>;
  if (o.type === "object" || "properties" in o) return { type: "object", ...o };
  const entries = Object.entries(o);
  const looksLikeProps =
    entries.length > 0 && entries.every(([, v]) => v !== null && typeof v === "object" && !Array.isArray(v));
  if (looksLikeProps) return { type: "object", properties: o, required: entries.map(([k]) => k) };
  // e.g. {"a": "number", "b": "number"}
  if (entries.length > 0 && entries.every(([, v]) => typeof v === "string")) {
    return {
      type: "object",
      properties: Object.fromEntries(entries.map(([k, v]) => [k, { type: v }])),
      required: entries.map(([k]) => k),
    };
  }
  return { type: "object", properties: {} };
}

/**
 * JSON.parse for JSON a model wrote, which is often slightly wrong: invalid
 * escapes inside strings (`"/\s+/"`), raw newlines in strings, single quotes
 * instead of double (`{'a': 1}`), or closing brackets missing at the end.
 * Each repair is tried only when the text does not parse as it is. Throws
 * when nothing makes it parse.
 */
export function parseLenient(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    const attempts = [repairStrings(text)];
    if (!text.includes('"') && text.includes("'")) attempts.push(repairStrings(text.replace(/'/g, '"')));
    for (const t of [...attempts]) attempts.push(closeBrackets(t));
    for (const t of attempts) {
      try {
        return JSON.parse(t);
      } catch {
        // next repair
      }
    }
    throw err;
  }
}

/** Inside string literals: double a backslash before a character JSON cannot escape, and escape raw control characters. */
function repairStrings(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
    } else if (ch === "\\") {
      const next = text[i + 1] ?? "";
      if (/["\\/bfnrtu]/.test(next)) {
        out += ch + next;
        i++;
      } else out += "\\\\";
    } else if (ch === '"') {
      inString = false;
      out += ch;
    } else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else out += ch;
  }
  return out;
}

/** The text with its unclosed strings, arrays and objects closed, innermost first. */
function closeBrackets(text: string): string {
  const open: string[] = [];
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") open.push("}");
    else if (ch === "[") open.push("]");
    else if (ch === "}" || ch === "]") open.pop();
  }
  return `${text.trimEnd()}${inString ? '"' : ""}${open.reverse().join("")}`;
}
