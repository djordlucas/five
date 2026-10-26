// Running code and managing generated tools.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Runner, RunResult } from "../../runner/index.ts";
import { type Bundled, bundleLibraries, importsLibraries } from "../../tools/libs.ts";
import { type StoredTool, TOOL_NAME, type ToolStore } from "../../tools/store.ts";
import { describeParams, inferParameters, isEmptySchema, normalizeParameters } from "../args.ts";
import { lintNotes } from "../lint.ts";
import {
  asDeps,
  awaitRun,
  type Builtin,
  type BuiltinContext,
  depsSchema,
  formatRun,
  positive,
  secs,
  withLastExpression,
} from "./shared.ts";

export function codeBuiltins(isBuiltin: (name: string) => boolean): Builtin[] {
  return [
    {
      name: "run_js",
      description:
        "Run TypeScript/JavaScript once, in a fresh Node.js process, and return its result and output. " +
        "The module's default export (a value, or a function called with `args`) is the result.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "ES module source." },
          args: { type: "object", description: "Passed to the default export when it is a function." },
          deps: depsSchema,
        },
        required: ["code"],
      },
      async run(a, ctx) {
        let code = withLastExpression(String(a.code));
        let deps = asDeps(a.deps);
        if (importsLibraries(code)) {
          try {
            const built = await bundleLibraries(code, ctx.libs, ctx.runner.home);
            code = built.code;
            deps = { ...built.deps, ...deps };
          } catch (err) {
            return `error: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
        const handle = ctx.runner.startEval(code, { args: a.args, deps, log: ctx.log });
        return formatRun(await awaitRun(handle, ctx.signal)) + lintNotes(String(a.code));
      },
    },
    {
      name: "define_tool",
      description:
        "Create or replace a tool. It becomes callable by `name` from your next step " +
        "and persists across turns and restarts. The source's default export is `async (args) => result`. When " +
        "test_args is given the tool is run once first, and it is only saved if that run succeeds. The source may " +
        'import your libraries (`import { f } from "lib:name"`): they are bundled into the tool as they are now.',
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: `snake_case, matching ${TOOL_NAME}.` },
          description: {
            type: "string",
            description: "What the tool does and returns; this is all a future caller sees.",
          },
          parameters: {
            type: "object",
            description:
              'JSON Schema for the arguments object, e.g. {"type": "object", "properties": {"a": {"type": "number"}}, "required": ["a"]}.',
          },
          code: {
            type: "string",
            description:
              "ES module source (TypeScript allowed) whose default export is the tool, e.g. `export default async ({ a, b }) => a + b`.",
          },
          deps: depsSchema,
          test_args: { type: "object", description: "Arguments for a trial run before saving." },
          timeout_ms: {
            type: "integer",
            description: "Run limit for this tool, for one that is meant to be slow. Defaults to the normal run limit.",
          },
        },
        required: ["name", "description", "code"],
      },
      async run(a, ctx) {
        const name = String(a.name);
        if (!TOOL_NAME.test(name)) return `error: name must match ${TOOL_NAME}`;
        if (isBuiltin(name)) return `error: "${name}" is a built-in tool and cannot be replaced`;
        if (typeof a.code !== "string" || !a.code.trim()) return "error: code is empty: send the tool's source as code";
        const source = a.code;
        if (!hasEntry(source)) return `not saved: ${NO_ENTRY}`;
        const previous = ctx.store.get(name);
        let parameters = normalizeParameters(a.parameters);
        // A tool saved with no parameters gets called with none. When the
        // model leaves them out, a revision keeps the previous ones; a new
        // tool takes them from its test arguments or its source.
        let inferred: Record<string, unknown> | undefined;
        if (isEmptySchema(parameters)) {
          if (previous && !isEmptySchema(previous.meta.parameters)) parameters = previous.meta.parameters;
          else {
            inferred = inferParameters(a.test_args, source);
            if (inferred) parameters = inferred;
          }
        }
        let built: Bundled | undefined;
        if (importsLibraries(source)) {
          try {
            built = await bundleLibraries(source, ctx.libs, ctx.runner.home);
          } catch (err) {
            return `not saved: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
        // What runs: the source, or the source with its libraries inlined.
        const runnable = built?.code ?? source;
        const unchanged =
          previous?.source === source && (previous.bundle ?? previous.source) === runnable
            ? previous.meta.revision
            : undefined;
        const deps = asDeps(a.deps) ?? {};
        const timeoutMs = positive(a.timeout_ms, 0) || undefined;

        let packages: Awaited<ReturnType<Runner["install"]>>;
        try {
          packages = await ctx.runner.install(runnable, { ...built?.deps, ...deps }, ctx.log);
        } catch (err) {
          return `error: ${err instanceof Error ? err.message : String(err)}`;
        }
        // Save what was installed: a range that matched nothing is not kept.
        for (const p of packages) if (p.unmatched) deps[p.name] = "latest";

        let trial = "";
        if (a.test_args !== undefined) {
          const r = await trialRun(ctx, name, runnable, a.test_args, timeoutMs);
          if (!r.ok) {
            ctx.log.info("tool not saved: trial run failed", { tool: name, error: r.error?.split("\n")[0] });
            return `not saved: the trial run failed${substituted(packages)}\n${formatRun(r)}${lintNotes(source)}`;
          }
          trial = `\ntrial run:\n${formatRun(r)}`;
        }

        const meta = ctx.store.save({
          meta: {
            name,
            description: String(a.description),
            parameters,
            deps,
            packages,
            ...(timeoutMs && { timeoutMs }),
            ...(built && { libs: built.libs }),
          },
          source,
          ...(built && { bundle: built.code }),
        });
        ctx.log.info("tool saved", { tool: name, revision: meta.revision, packages: packages.map((p) => p.name) });
        if (inferred)
          ctx.log.info("tool parameters inferred", {
            tool: name,
            parameters: Object.keys(inferred.properties as object),
          });
        const same =
          unchanged !== undefined
            ? `\nNote: this code is identical to revision ${unchanged}, so the tool behaves exactly as before. To fix a wrong result, change the code.`
            : "";
        const libs = built?.libs.length
          ? `\nBuilt on ${built.libs.map((l) => `lib:${l.name} r${l.revision}`).join(", ")}: it keeps these revisions until rebuild_tool.`
          : "";
        return `saved ${name} (revision ${meta.revision}). From your next step, call it as the tool ${name}, with arguments: ${describeParams(parameters)}${inferred ? " (taken from your test_args or code, since you gave no parameters)" : ""}.${same}${libs}${substituted(packages)}${trial}${lintNotes(source)}`;
      },
    },
    {
      name: "read_tool",
      description: "Show a tool: its definition and source. Use it before revising a tool.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      async run(a, ctx) {
        const t = ctx.store.get(String(a.name));
        if (!t) return `error: no tool named "${String(a.name)}"`;
        return `${JSON.stringify(t.meta, null, 2)}${libraryLines(t, ctx)}\n\n--- source ---\n${t.source}`;
      },
    },
    {
      name: "delete_tool",
      description: "Delete a tool.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      async run(a, ctx) {
        const name = String(a.name);
        if (!ctx.store.remove(name)) return `error: no tool named "${name}"`;
        ctx.log.info("tool deleted", { tool: name });
        return `deleted ${name}`;
      },
    },
    {
      name: "tool_health",
      description:
        "Show how a tool has been behaving: whether it is disabled, its run limit, and its recent runs with their " +
        "caller, outcome, duration and errors. Use it to decide whether to fix, disable or delete a tool.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          last: { type: "integer", description: "Runs to show, newest first. Default 10." },
        },
        required: ["name"],
      },
      async run(a, ctx) {
        const t = ctx.store.get(String(a.name));
        if (!t) return `error: no tool named "${String(a.name)}"`;
        return health(t, ctx.store, positive(a.last, 10));
      },
    },
    {
      name: "disable_tool",
      description:
        "Disable a tool that misbehaves: it disappears from your tool list and calls to it are refused, " +
        "but it is kept. Redefining it with define_tool, or enable_tool, brings it back.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          reason: { type: "string", description: "What is wrong with it; shown while it is disabled." },
        },
        required: ["name", "reason"],
      },
      async run(a, ctx) {
        const name = String(a.name);
        if (!ctx.store.setDisabled(name, String(a.reason))) return `error: no tool named "${name}"`;
        ctx.log.warn("tool disabled", { tool: name, reason: String(a.reason) });
        return `disabled ${name}`;
      },
    },
    {
      name: "enable_tool",
      description: "Re-enable a disabled tool as it is.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      async run(a, ctx) {
        const name = String(a.name);
        if (!ctx.store.setDisabled(name, null)) return `error: no tool named "${name}"`;
        ctx.log.info("tool enabled", { tool: name });
        return `enabled ${name}`;
      },
    },
  ];
}

/** Which libraries a tool was built on, and whether each has changed since. */
function libraryLines(tool: StoredTool, ctx: BuiltinContext): string {
  if (!tool.meta.libs?.length) return "";
  const lines = tool.meta.libs.map((l) => {
    const now = ctx.libs.get(l.name)?.meta.revision;
    if (now === undefined)
      return `- lib:${l.name} r${l.revision}: the library is gone; the tool still runs the copy bundled into it`;
    return now === l.revision
      ? `- lib:${l.name} r${l.revision}: current`
      : `- lib:${l.name} r${l.revision}: the library is at r${now} now; rebuild_tool builds the tool on it`;
  });
  return `\n\nlibraries bundled into it:\n${lines.join("\n")}`;
}

/** A line naming packages installed at their latest version because the range asked for matched none. */
function substituted(packages: { name: string; version: string; unmatched?: string }[]): string {
  const subs = packages.filter((p) => p.unmatched);
  if (subs.length === 0) return "";
  return `\nNo version matched ${subs.map((p) => `${p.name}@${p.unmatched}`).join(", ")}, so the latest was installed: ${subs.map((p) => `${p.name}@${p.version}`).join(", ")}.`;
}

const NO_ENTRY =
  "the code exports no function to call. A tool's source must export it as the default export: `export default async function (args) { …; return result; }`";

/**
 * Whether a tool's source exports something a run can call: a default export,
 * or a single exported function (which the runner calls in its place).
 */
export function hasEntry(source: string): boolean {
  if (/\bexport\s+default\b|\bas\s+default\b/.test(source)) return true;
  const fns =
    source.match(/\bexport\s+(async\s+)?function\b|\bexport\s+const\s+\w+\s*=\s*(async\b|function\b|\(|\w+\s*=>)/g) ??
    [];
  return fns.length === 1;
}

/** Run a candidate tool from a scratch file under the runner's home, so its imports resolve. */
export async function trialRun(
  ctx: BuiltinContext,
  name: string,
  source: string,
  args: unknown,
  timeoutMs?: number,
): Promise<RunResult> {
  const dir = fs.mkdtempSync(path.join(ctx.runner.home, "tmp", `trial-${name}-`));
  const file = path.join(dir, "source.ts");
  fs.writeFileSync(file, source);
  try {
    return await ctx.runner.runFile(file, args, timeoutMs, ctx.log.child({ tool: name, mode: "trial" }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function health(tool: StoredTool, store: ToolStore, last: number): string {
  const { meta } = tool;
  const runs = store.history(meta.name);
  const state = meta.disabled ? `disabled since ${meta.disabled.at}: ${meta.disabled.reason}` : "enabled";
  const lines = [
    `${meta.name} (revision ${meta.revision}): ${state}`,
    `run limit: ${meta.timeoutMs ? `${meta.timeoutMs}ms` : "default"}`,
  ];
  if (runs.length === 0) return [...lines, "no runs recorded"].join("\n");

  const ok = runs.filter((r) => r.ok).length;
  const durations = runs.map((r) => r.durationMs).sort((x, y) => x - y);
  const median = durations[Math.floor(durations.length / 2)] ?? 0;
  lines.push(
    `last ${runs.length} runs: ${ok} ok, ${runs.length - ok} failed; median ${secs(median)}, slowest ${secs(durations.at(-1) ?? 0)}`,
    "recent runs, newest first:",
    ...runs
      .slice(-last)
      .reverse()
      .map(
        (r) =>
          `- ${r.at} r${r.revision} ${r.agent} ${r.mode} ${secs(r.durationMs)} ${r.ok ? "ok" : `failed: ${r.error}`}`,
      ),
  );
  return lines.join("\n");
}
