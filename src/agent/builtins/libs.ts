// Libraries (five's own; see tools/libs.ts): defining and reading them, what
// uses each, and rebuilding a tool on their current revisions.

import { bundleLibraries, LIB_NAME, LIB_PREFIX, type LibraryStore, usersOf } from "../../tools/libs.ts";
import type { ToolStore } from "../../tools/store.ts";
import { trialRun } from "./code.ts";
import { asDeps, awaitRun, type Builtin, depsSchema, formatRun } from "./shared.ts";

function describeUsers(name: string, revision: number, store: ToolStore, libs: LibraryStore): string {
  const users = usersOf(name, store, libs);
  const lines: string[] = [];
  if (users.tools.length === 0) lines.push("No tool is built on it yet.");
  else {
    const behind = users.tools.filter((t) => t.revision !== revision);
    lines.push(`Tools built on it: ${users.tools.map((t) => `${t.name} (r${t.revision})`).join(", ")}.`);
    if (behind.length) {
      lines.push(
        `${behind.map((t) => t.name).join(", ")} still run${behind.length === 1 ? "s" : ""} an older revision: rebuild_tool builds one on r${revision}; give it test_args to try it first.`,
      );
    }
  }
  if (users.libs.length) lines.push(`Libraries that import it: ${users.libs.join(", ")}.`);
  return lines.join("\n");
}

export function libraryBuiltins(): Builtin[] {
  return [
    {
      name: "define_library",
      description:
        "Create or revise a library: a module of code your tools and run_js share, imported as " +
        '`import { f } from "lib:name"`. A tool gets the library bundled in when it is defined and keeps that ' +
        "revision, so a change never breaks a tool by itself: the result names the tools on an older revision, " +
        "for rebuild_tool. With test_code — run_js code that imports the library — the new revision is tried " +
        "first and only saved if the test succeeds.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: `snake_case, matching ${LIB_NAME}.` },
          description: { type: "string", description: "What it offers: its exports and what they do." },
          code: { type: "string", description: "ES module source (TypeScript allowed) with named exports." },
          deps: depsSchema,
          test_code: {
            type: "string",
            description:
              'run_js code that imports the library, e.g. `import { f } from "lib:name"; export default f(2);`',
          },
        },
        required: ["name", "description", "code"],
      },
      async run(a, ctx) {
        const name = String(a.name);
        if (!LIB_NAME.test(name)) return `error: name must match ${LIB_NAME}`;
        if (typeof a.code !== "string" || !a.code.trim())
          return "error: code is empty: send the library's source as code";
        const draft = { name, source: a.code, deps: asDeps(a.deps) ?? {} };
        const previous = ctx.libs.get(name);
        if (
          previous &&
          previous.source === draft.source &&
          JSON.stringify(previous.meta.deps) === JSON.stringify(draft.deps)
        ) {
          return `unchanged: lib:${name} r${previous.meta.revision} already has this code.\n${describeUsers(name, previous.meta.revision, ctx.store, ctx.libs)}`;
        }
        try {
          // The library and what it imports must bundle, and their packages install.
          const checked = await bundleLibraries(
            `export * from "${LIB_PREFIX}${name}";`,
            ctx.libs,
            ctx.runner.home,
            draft,
          );
          await ctx.runner.install(checked.code, checked.deps, ctx.log);
        } catch (err) {
          return `not saved: ${err instanceof Error ? err.message : String(err)}`;
        }
        let trial = "";
        if (typeof a.test_code === "string" && a.test_code.trim()) {
          let test: Awaited<ReturnType<typeof bundleLibraries>>;
          try {
            test = await bundleLibraries(a.test_code, ctx.libs, ctx.runner.home, draft);
          } catch (err) {
            return `not saved: the test does not build: ${err instanceof Error ? err.message : String(err)}`;
          }
          const r = await awaitRun(ctx.runner.startEval(test.code, { deps: test.deps, log: ctx.log }), ctx.signal);
          if (!r.ok) return `not saved: the test failed\n${formatRun(r)}`;
          trial = `\ntest:\n${formatRun(r)}`;
        }
        const meta = ctx.libs.save({
          name,
          description: String(a.description),
          deps: draft.deps,
          source: draft.source,
        });
        ctx.log.info("library saved", { library: name, revision: meta.revision });
        return `saved lib:${name} (revision ${meta.revision}). Import it as \`import { … } from "${LIB_PREFIX}${name}"\`.\n${describeUsers(name, meta.revision, ctx.store, ctx.libs)}${trial}`;
      },
    },
    {
      name: "read_library",
      description:
        "Show a library — its description, the tools built on it and at which revision, the libraries that import " +
        "it, and its source. Without a name, list every library.",
      parameters: { type: "object", properties: { name: { type: "string" } } },
      async run(a, ctx) {
        if (a.name === undefined || a.name === "") {
          const all = ctx.libs.list();
          if (all.length === 0) return "No libraries yet: define_library creates one.";
          return all
            .map((l) => {
              const users = usersOf(l.name, ctx.store, ctx.libs).tools.map((t) => t.name);
              return `lib:${l.name} r${l.revision} — ${l.description}${users.length ? ` (used by ${users.join(", ")})` : ""}`;
            })
            .join("\n");
        }
        const lib = ctx.libs.get(String(a.name));
        if (!lib) return `error: no library named "${String(a.name)}"`;
        const { meta } = lib;
        const deps = Object.keys(meta.deps).length
          ? `\nnpm: ${Object.entries(meta.deps)
              .map(([n, v]) => `${n}@${v}`)
              .join(", ")}`
          : "";
        return `lib:${meta.name} r${meta.revision}, updated ${meta.updatedAt}\n${meta.description}${deps}\n${describeUsers(meta.name, meta.revision, ctx.store, ctx.libs)}\n\n--- source ---\n${lib.source}`;
      },
    },
    {
      name: "delete_library",
      description: "Delete a library. Refused while a tool is built on it or another library imports it.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      async run(a, ctx) {
        const name = String(a.name);
        if (!ctx.libs.get(name)) return `error: no library named "${name}"`;
        const users = usersOf(name, ctx.store, ctx.libs);
        if (users.tools.length || users.libs.length) {
          const who = [...users.tools.map((t) => `the tool ${t.name}`), ...users.libs.map((l) => `the library ${l}`)];
          return `error: lib:${name} is in use by ${who.join(", ")}: change or delete them first`;
        }
        ctx.libs.remove(name);
        ctx.log.info("library deleted", { library: name });
        return `deleted lib:${name}`;
      },
    },
    {
      name: "rebuild_tool",
      description:
        "Build a tool again on the current revisions of the libraries it imports, as a new revision of the tool. " +
        "With test_args it is tried first and only saved if that run succeeds.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          test_args: { type: "object", description: "Arguments for a trial run before saving." },
        },
        required: ["name"],
      },
      async run(a, ctx) {
        const tool = ctx.store.get(String(a.name));
        if (!tool) return `error: no tool named "${String(a.name)}"`;
        if (!tool.meta.libs?.length) return `${tool.meta.name} imports no library: there is nothing to rebuild.`;
        let built: Awaited<ReturnType<typeof bundleLibraries>>;
        try {
          built = await bundleLibraries(tool.source, ctx.libs, ctx.runner.home);
          await ctx.runner.install(built.code, { ...built.deps, ...tool.meta.deps }, ctx.log);
        } catch (err) {
          return `not rebuilt: ${err instanceof Error ? err.message : String(err)}`;
        }
        if (built.code === tool.bundle) return `${tool.meta.name} is already built on the current libraries.`;
        let trial = "";
        if (a.test_args !== undefined) {
          const r = await trialRun(ctx, tool.meta.name, built.code, a.test_args, tool.meta.timeoutMs);
          if (!r.ok) return `not rebuilt: the trial run failed\n${formatRun(r)}`;
          trial = `\ntrial run:\n${formatRun(r)}`;
        }
        const { createdAt, updatedAt, revision, disabled, ...meta } = tool.meta;
        const saved = ctx.store.save({ meta: { ...meta, libs: built.libs }, source: tool.source, bundle: built.code });
        ctx.log.info("tool rebuilt", { tool: saved.name, revision: saved.revision });
        return `rebuilt ${saved.name} (revision ${saved.revision}) on ${built.libs.map((l) => `lib:${l.name} r${l.revision}`).join(", ")}.${trial}`;
      },
    },
  ];
}
