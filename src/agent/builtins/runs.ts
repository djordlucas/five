// Async tool calls: starting a tool in the background and controlling the run.

import type { RunHandle } from "../../runner/index.ts";
import { describe, summarize } from "../runs.ts";
import { asDeps, type Builtin, disabledError, positive, sleep, startGenerated, withLastExpression } from "./shared.ts";

const MAX_WAIT_MS = 300_000;

export function runBuiltins(isBuiltin: (name: string) => boolean): Builtin[] {
  return [
    {
      name: "start_tool",
      description:
        "Start a tool in the background and return a run id at once, instead of waiting for its result. " +
        "Works for any generated tool and for run_js. Use it for anything slow, long-running or that might hang; " +
        "then check it with run_status or wait_run, and stop it with kill_run.",
      parameters: {
        type: "object",
        properties: {
          tool: { type: "string", description: "A generated tool, or run_js." },
          args: { type: "object", description: "The tool's arguments (for run_js: code, args, deps)." },
          timeout_ms: {
            type: "integer",
            description: "Kill the run after this long. Defaults to the tool's own limit, or the normal run limit.",
          },
        },
        required: ["tool"],
      },
      async run(a, ctx) {
        const tool = String(a.tool);
        const args = (a.args as Record<string, unknown> | undefined) ?? {};
        const timeoutMs = positive(a.timeout_ms, 0) || undefined;
        let handle: RunHandle;
        if (tool === "run_js") {
          handle = ctx.runner.startEval(withLastExpression(String(args.code ?? "")), {
            args: args.args,
            deps: asDeps(args.deps),
            timeoutMs,
          });
        } else {
          const own = ctx.store.get(tool);
          if (!own) return `error: no tool named "${tool}"${isBuiltin(tool) ? " that can run in the background" : ""}`;
          if (own.meta.disabled) return disabledError(own);
          handle = startGenerated(ctx, own, args, "async", timeoutMs);
        }
        return `started ${ctx.runs.add(ctx.agentId, tool, handle)} (${tool})`;
      },
    },
    {
      name: "run_status",
      description: "Show a background run: whether it is still going, its result once finished, and its latest output.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The run id from start_tool, e.g. r3." },
          tail: { type: "integer", description: "Output lines to show, from the end. Default 50." },
        },
        required: ["id"],
      },
      async run(a, ctx) {
        return describe(ctx.runs, String(a.id), positive(a.tail, 50)) ?? `error: no run "${String(a.id)}"`;
      },
    },
    {
      name: "wait_run",
      description:
        "Wait for a background run to finish, up to timeout_ms, then show its status as run_status does. " +
        "Waiting does not stop the run.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          timeout_ms: { type: "integer", description: `How long to wait. Default 30000, at most ${MAX_WAIT_MS}.` },
          tail: { type: "integer", description: "Output lines to show, from the end. Default 50." },
        },
        required: ["id"],
      },
      async run(a, ctx) {
        const id = String(a.id);
        if (!ctx.runs.get(id)) return `error: no run "${id}"`;
        const wait = Math.min(positive(a.timeout_ms, 30_000), MAX_WAIT_MS);
        const timeout = new AbortController();
        await Promise.race([ctx.runs.settled(id), sleep(wait, anySignal(timeout.signal, ctx.signal))]);
        timeout.abort();
        return describe(ctx.runs, id, positive(a.tail, 50)) as string;
      },
    },
    {
      name: "kill_run",
      description: "Stop a background run and everything it started.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      async run(a, ctx) {
        const id = String(a.id);
        const run = ctx.runs.get(id);
        if (!run) return `error: no run "${id}"`;
        const live = ctx.runs.handle(id);
        if (!live) return `${id} is not running\n${describe(ctx.runs, id, 20)}`;
        live.kill();
        await ctx.runs.settled(id);
        return `killed ${id}\n${describe(ctx.runs, id, 20)}`;
      },
    },
    {
      name: "list_runs",
      description: "List your background runs: running ones and recently finished ones.",
      parameters: { type: "object", properties: {} },
      async run(_a, ctx) {
        const all = ctx.runs.list(ctx.agentId);
        return all.length === 0 ? "no background runs" : all.map((r) => summarize(r, ctx.runs.handle(r.id))).join("\n");
      },
    },
  ];
}

function anySignal(...signals: (AbortSignal | undefined)[]): AbortSignal {
  return AbortSignal.any(signals.filter((s): s is AbortSignal => s !== undefined));
}
