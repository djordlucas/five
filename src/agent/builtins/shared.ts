// What every built-in gets: the shared machinery (from seven).

import { transformSync } from "esbuild";
import type { ToolDef } from "../../llm/model.ts";
import type { Logger } from "../../log.ts";
import type { RunHandle, Runner, RunResult } from "../../runner/index.ts";
import type { LibraryStore } from "../../tools/libs.ts";
import type { StoredTool, ToolStore } from "../../tools/store.ts";
import type { RunTable } from "../runs.ts";

export interface Builtin extends ToolDef {
  run(args: Record<string, unknown>, ctx: BuiltinContext): Promise<string>;
}

export interface BuiltinContext {
  /** Who makes the call, as recorded in run histories: always the agent, "five". */
  agentId: string;
  runner: Runner;
  store: ToolStore;
  /** The agent's libraries, bundled into the code that imports them. */
  libs: LibraryStore;
  runs: RunTable;
  workspace: string;
  /** Five's own database, which the sql built-in refuses to open. */
  stateDb: string;
  /** Aborted when the turn is stopped. */
  signal?: AbortSignal;
  /** Bound to the turn, step and tool call. */
  log: Logger;
}

export const depsSchema = {
  type: "object",
  description: 'npm packages and version ranges, e.g. {"lodash": "^4"}. Imports not listed install at latest.',
  additionalProperties: { type: "string" },
};

/** Start a generated tool, recording the outcome in its run history when it ends. */
export function startGenerated(
  ctx: BuiltinContext,
  tool: StoredTool,
  args: unknown,
  mode: "sync" | "async",
  timeoutMs?: number,
): RunHandle {
  const handle = ctx.runner.startFile(
    tool.file,
    args,
    timeoutMs ?? tool.meta.timeoutMs,
    ctx.log.child({ tool: tool.meta.name, revision: tool.meta.revision, mode }),
  );
  void handle.done.then(
    (r) =>
      ctx.store.isOpen &&
      ctx.store.recordRun(tool.meta.name, {
        at: new Date(handle.startedAt).toISOString(),
        revision: tool.meta.revision,
        agent: ctx.agentId,
        mode,
        ok: r.ok,
        durationMs: r.durationMs,
        ...(!r.ok && { error: (r.error ?? "").split("\n")[0] }),
      }),
  );
  return handle;
}

/** Await a run, killing it if `signal` aborts first (the turn was stopped or five is shutting down). */
export async function awaitRun(handle: RunHandle, signal?: AbortSignal): Promise<RunResult> {
  const kill = () => handle.kill();
  if (signal?.aborted) kill();
  signal?.addEventListener("abort", kill, { once: true });
  try {
    return await handle.done;
  } finally {
    signal?.removeEventListener("abort", kill);
  }
}

export function disabledError(tool: StoredTool): string {
  const d = tool.meta.disabled;
  return `error: tool "${tool.meta.name}" is disabled (${d?.reason}). Fix it with define_tool, or enable_tool to use it as is.`;
}

/** What a run that produced nothing returns, so the model notices instead of reading a bare `null`. */
export const NO_RESULT =
  "no result: the default export returned nothing and nothing was printed. Return the value from the default export, or print it.";

export function formatRun(r: RunResult): string {
  const parts: string[] = [];
  const empty = r.value === null || r.value === undefined;
  if (!r.ok) parts.push(`error: ${r.error}`);
  else if (empty && r.logs.length === 0) parts.push(NO_RESULT);
  else if (!empty) parts.push(typeof r.value === "string" ? r.value : JSON.stringify(r.value, null, 2));
  if (r.logs.length > 0) parts.push(`--- output ---\n${r.logs.join("\n")}`);
  return parts.join("\n");
}

/**
 * run_js code written like a REPL — ending in a bare expression such as
 * `count;`, with no export — returns that expression: the last line becomes
 * the default export. Code that exports anything, or whose last line is not a
 * whole expression, is left alone.
 */
export function withLastExpression(code: string): string {
  if (/\bexport\b/.test(code)) return code;
  const lines = code.split("\n");
  let i = lines.length - 1;
  while (i >= 0 && (lines[i]?.trim() === "" || /^\s*\/\//.test(lines[i] ?? ""))) i--;
  const line = lines[i];
  if (line === undefined || /^\s/.test(line)) return code;
  const expr = line.trim().replace(/;+$/, "").trim();
  if (
    !expr ||
    /^(const|let|var|function|async\s+function|class|if|else|for|while|do|switch|try|catch|finally|return|import|throw|break|continue|await\s+import)\b/.test(
      expr,
    ) ||
    /^[})\]/*]/.test(expr) ||
    /[{(,[]$/.test(expr) ||
    /^console\./.test(expr) ||
    /(^|[^=!<>])=($|[^=>])/.test(expr)
  ) {
    return code;
  }
  const rewritten = [...lines.slice(0, i), `export default await (${expr});`, ...lines.slice(i + 1)].join("\n");
  try {
    transformSync(rewritten, { loader: "ts", format: "esm" });
    return rewritten;
  } catch {
    return code;
  }
}

export function positive(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

export function asDeps(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object") return undefined;
  return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, String(val)]));
}

export function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Wait up to `ms`, or less if `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
