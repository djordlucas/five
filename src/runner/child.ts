// The entry point of every run's child process. The parent sends one `start`
// message naming a module file; this imports it, calls its default export, and
// sends the result back. stdout and stderr are the parent's to capture.

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { keepWrites } from "./keep.ts";

export type ToChild =
  | { type: "start"; file: string; args: unknown }
  | { type: "reply"; id: number; ok: boolean; value?: unknown; error?: string };

export type ToParent =
  | { type: "call"; id: number; name: string; args: unknown[] }
  | { type: "result"; ok: true; json: string }
  | { type: "result"; ok: false; error: string };

// A run whose changes five keeps: every write to the workspace is kept first.
if (process.env.FIVE_KEEP_DIR) keepWrites(process.cwd(), process.env.FIVE_KEEP_DIR);

const send = (m: ToParent) => process.send?.(m);
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let nextId = 0;

// five.<module>.<fn>(...args) → a host call over IPC. `then` is excluded at
// both levels so that awaiting `five` or `five.llm` does not look like a promise.
const module_ = (mod: string) =>
  new Proxy(
    {},
    {
      get: (_, fn) =>
        typeof fn !== "string" || fn === "then"
          ? undefined
          : (...args: unknown[]) =>
              new Promise((resolve, reject) => {
                const id = ++nextId;
                pending.set(id, { resolve, reject });
                send({ type: "call", id, name: `${mod}.${fn}`, args });
              }),
    },
  );
// five.db(path): a SQLite database in the workspace (the working directory),
// opened here in the child rather than over IPC so it is synchronous like any
// node:sqlite database. Five's own state database is refused.
function openDb(file: string): DatabaseSync {
  const workspace = process.cwd();
  const abs = path.resolve(workspace, file);
  const rel = path.relative(workspace, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`five.db: "${file}" is outside the workspace; databases live in the workspace`);
  }
  if (process.env.FIVE_STATE_DB && sameFile(abs, process.env.FIVE_STATE_DB)) {
    throw new Error(`five.db: "${file}" is five's own database; use another file`);
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  return new DatabaseSync(abs);
}

/** Whether two paths name the same file, through symlinks (/var vs /private/var on macOS). */
function sameFile(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}

Object.defineProperty(globalThis, "five", {
  value: new Proxy(
    {},
    {
      get: (_, mod) => (mod === "db" ? openDb : typeof mod !== "string" || mod === "then" ? undefined : module_(mod)),
    },
  ),
});

// The Node modules code uses most, as globals, and CommonJS's require: code
// that forgets an import, or uses require in this ES module, still runs. An
// import of the same name in the code takes precedence.
for (const [name, value] of Object.entries({ fs, path })) {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
}

process.on("message", async (m: ToChild) => {
  if (m.type === "reply") {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.ok) p?.resolve(m.value);
    else p?.reject(new Error(m.error));
    return;
  }

  try {
    // require resolves from the run's own file, so it finds .five/node_modules.
    Object.defineProperty(globalThis, "require", { value: createRequire(m.file), writable: true, configurable: true });
    const mod = await import(pathToFileURL(m.file).href);
    const entry = entryOf(mod);
    // A non-function default export may itself be a promise; it is awaited too.
    const out = await (typeof entry === "function" ? entry(m.args) : entry);
    send({ type: "result", ok: true, json: JSON.stringify(out === undefined ? null : out) ?? "null" });
  } catch (err) {
    send({ type: "result", ok: false, error: describe(err) });
  }
});

/**
 * What a run calls: the default export, or else the module's only exported
 * function — models often write `export async function name(args)` for a tool.
 */
function entryOf(mod: Record<string, unknown>): unknown {
  if ("default" in mod) return mod.default;
  const fns = Object.values(mod).filter((v) => typeof v === "function");
  return fns.length === 1 ? fns[0] : undefined;
}

function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  // A stack already starts with "Name: message". Frames inside Node itself
  // say nothing about the code that failed, and cost the model context.
  const text = (err.stack ?? `${err.name}: ${err.message}`)
    .split("\n")
    .filter((line) => !/^\s+at .*(node:internal|\(node:|processTicksAndRejections)/.test(line))
    .join("\n");
  return text + hint(err);
}

/** A next step for errors models get stuck on. */
function hint(err: Error & { code?: string }): string {
  if (err.code === "ERR_MODULE_NOT_FOUND" && /Cannot find module '[^']*\/\.five\//.test(err.message)) {
    return "\nHint: generated tools are not files to import. Call a tool by its name as a tool call, or from code with `await five.tools.<name>(args)`.";
  }
  return "";
}
