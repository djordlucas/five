// Libraries: shared code the agent writes once and imports from its tools and
// run_js as `import { f } from "lib:<name>"`. A library is a module with
// revisions, like a tool, kept in the state database.
//
// A library is bundled into what imports it — a tool when it is defined, a
// run_js when it runs — so a tool keeps the revision it was built with:
// changing a library never changes a tool behind the agent's back. Each tool
// records the revisions it was built on, which is how five tells the agent
// which tools a change leaves behind, and rebuild_tool brings one up to date.

import type { SQLInputValue } from "node:sqlite";
import { build, type Plugin } from "esbuild";
import type { State } from "../state.ts";
import type { ToolStore } from "./store.ts";

export const LIB_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** How code names a library: "lib:<name>". */
export const LIB_PREFIX = "lib:";

export interface LibraryMeta {
  name: string;
  description: string;
  /** npm version ranges, as for a tool; a tool built on the library installs them too. */
  deps: Record<string, string>;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface Library {
  meta: LibraryMeta;
  source: string;
}

/** A library a tool was built on, at the revision bundled into it. */
export interface LibraryUse {
  name: string;
  revision: number;
}

export class LibraryStore {
  private readonly state: State;

  constructor(state: State) {
    this.state = state;
  }

  list(): LibraryMeta[] {
    return this.state.db
      .prepare("SELECT * FROM libs ORDER BY name")
      .all()
      .map((r) => toMeta(r as Row));
  }

  get(name: string): Library | undefined {
    if (!LIB_NAME.test(name)) return undefined;
    const row = this.state.db.prepare("SELECT * FROM libs WHERE name = ?").get(name) as Row | undefined;
    return row ? { meta: toMeta(row), source: String(row.source) } : undefined;
  }

  /** Create a library or save a new revision of it. */
  save(lib: { name: string; description: string; deps: Record<string, string>; source: string }): LibraryMeta {
    if (!LIB_NAME.test(lib.name)) throw new Error(`invalid library name "${lib.name}": must match ${LIB_NAME}`);
    const now = new Date().toISOString();
    this.state.db
      .prepare(
        `INSERT INTO libs (name, description, deps, source, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT (name) DO UPDATE SET
           description = excluded.description, deps = excluded.deps, source = excluded.source,
           revision = libs.revision + 1, updated_at = excluded.updated_at`,
      )
      .run(lib.name, lib.description, JSON.stringify(lib.deps), lib.source, now, now);
    const saved = this.get(lib.name);
    if (!saved) throw new Error(`library ${lib.name} vanished while saving`);
    return saved.meta;
  }

  remove(name: string): boolean {
    return this.state.db.prepare("DELETE FROM libs WHERE name = ?").run(name).changes > 0;
  }
}

export /** The tools built on a library, at the revision each has, and the libraries that import it. */
function usersOf(
  name: string,
  store: ToolStore,
  libs: LibraryStore,
): { tools: { name: string; revision: number }[]; libs: string[] } {
  const tools = store
    .list()
    .flatMap((t) => (t.libs ?? []).filter((l) => l.name === name).map((l) => ({ name: t.name, revision: l.revision })));
  const importers = libs
    .list()
    .filter((l) => l.name !== name && new RegExp(`["']${LIB_PREFIX}${name}["']`).test(libs.get(l.name)?.source ?? ""))
    .map((l) => l.name);
  return { tools, libs: importers };
}

/** Whether code imports a library. */
export function importsLibraries(source: string): boolean {
  return /["']lib:/.test(source);
}

export interface Bundled {
  /** The code with every library it imports inlined; npm packages and Node's modules stay imports. */
  code: string;
  /** The libraries inlined, directly or through another, at their revision. */
  libs: LibraryUse[];
  /** The npm ranges the libraries ask for. */
  deps: Record<string, string>;
}

/**
 * Inline the libraries `source` imports. `draft` stands in for one library's
 * stored source, to try a revision before it is saved. A missing library, or
 * a syntax error, throws with esbuild's message.
 */
export async function bundleLibraries(
  source: string,
  libs: LibraryStore,
  resolveDir: string,
  draft?: { name: string; source: string; deps: Record<string, string> },
): Promise<Bundled> {
  const used = new Map<string, number>();
  const deps: Record<string, string> = {};
  const plugin: Plugin = {
    name: "five-libraries",
    setup(b) {
      b.onResolve({ filter: /^lib:/ }, (args) => {
        const name = args.path.slice(LIB_PREFIX.length);
        if (draft?.name !== name && !libs.get(name)) {
          return { errors: [{ text: `no library "${name}": define_library creates one` }] };
        }
        return { path: name, namespace: "lib" };
      });
      // Anything else stays an import, resolved when the code runs.
      b.onResolve({ filter: /.*/ }, (args) =>
        args.kind === "entry-point" ? undefined : { path: args.path, external: true },
      );
      b.onLoad({ filter: /.*/, namespace: "lib" }, (args) => {
        const lib = draft?.name === args.path ? undefined : libs.get(args.path);
        const text = lib ? lib.source : (draft?.source ?? "");
        used.set(args.path, lib ? lib.meta.revision : (libs.get(args.path)?.meta.revision ?? 0) + 1);
        Object.assign(deps, lib ? lib.meta.deps : draft?.deps);
        return { contents: text, loader: "ts", resolveDir };
      });
    },
  };
  const out = await build({
    stdin: { contents: source, loader: "ts", sourcefile: "source.ts", resolveDir },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node24",
    plugins: [plugin],
    // Every import counts, used or not, as when Node runs TypeScript: a missing library is an error, and
    // each library imported is recorded.
    tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
    logLevel: "silent",
  }).catch((err: unknown) => {
    throw new Error(formatError(err));
  });
  return {
    code: out.outputFiles[0]?.text ?? "",
    libs: [...used].map(([name, revision]) => ({ name, revision })).sort((a, b) => a.name.localeCompare(b.name)),
    deps,
  };
}

function formatError(err: unknown): string {
  const errors = (
    err as { errors?: { text: string; location?: { file: string; line: number; column: number } | null }[] }
  ).errors;
  if (!errors?.length) return err instanceof Error ? err.message : String(err);
  return errors
    .map((e) => {
      const where = e.location
        ? `${e.location.file.replace(/^lib:/, "library ")}:${e.location.line}:${e.location.column}: `
        : "";
      return `${where}${e.text}`;
    })
    .join("\n");
}

type Row = Record<string, SQLInputValue>;

function toMeta(x: Row): LibraryMeta {
  return {
    name: String(x.name),
    description: String(x.description),
    deps: JSON.parse(String(x.deps)),
    revision: Number(x.revision),
    createdAt: String(x.created_at),
    updatedAt: String(x.updated_at),
  };
}
