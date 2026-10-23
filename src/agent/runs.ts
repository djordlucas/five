// Background runs: tool calls the agent started with start_tool and controls by
// id. Each is a row in the state database, so its result and output outlive
// the process; the live handle exists only in the process that started it. A
// run still going when that process exits is marked lost at the next start.

import type { Logger } from "../log.ts";
import type { RunHandle } from "../runner/index.ts";
import type { RunRow, State } from "../state.ts";
import { NO_RESULT } from "./builtins/shared.ts";

/** Output lines kept in the database for a finished run. */
const KEEP_LOG_LINES = 500;

export class RunTable {
  private readonly state: State;
  private readonly handles = new Map<string, RunHandle>();
  private closed = false;
  private readonly log: Logger;

  constructor(state: State, log: Logger) {
    this.state = state;
    this.log = log.child({ component: "runs" });
  }

  add(agent: string, tool: string, handle: RunHandle): string {
    const id = this.state.insertRun(agent, tool);
    this.handles.set(id, handle);
    this.log.info("background run started", { run: id, run_id: handle.id, agent, tool });
    void handle.done.then((r) => {
      this.handles.delete(id);
      if (!this.closed) {
        this.log.info("background run finished", {
          run: id,
          run_id: handle.id,
          agent,
          tool,
          ok: r.ok,
          duration_ms: r.durationMs,
        });
      }
      // A run killed by shutdown was already marked lost.
      if (!this.closed && this.state.isOpen) this.state.finishRun(id, { ...r, logs: r.logs.slice(-KEEP_LOG_LINES) });
    });
    return id;
  }

  get(id: string): RunRow | undefined {
    return this.state.getRun(id);
  }

  handle(id: string): RunHandle | undefined {
    return this.handles.get(id);
  }

  /** An agent's runs, oldest first. */
  list(agent: string): RunRow[] {
    return this.state.listRuns(agent);
  }

  /** Kill every live run an agent started. */
  killAll(agent: string): void {
    for (const run of this.list(agent)) this.handles.get(run.id)?.kill();
  }

  /** Wait until a run's result is recorded. */
  async settled(id: string): Promise<void> {
    const h = this.handles.get(id);
    if (!h) return;
    await h.done;
    // finishRun is chained on the same promise; let it run first.
    await new Promise((r) => setImmediate(r));
  }

  /** Kill every live run and mark it lost: its process goes with this one. */
  async shutdown(): Promise<void> {
    this.closed = true;
    const live = [...this.handles.values()];
    if (live.length > 0) this.log.warn("killing background runs at shutdown", { count: live.length });
    for (const h of live) h.kill();
    this.state.markLostRuns();
    await Promise.all(live.map((h) => h.done));
  }

  markChecked(id: string): void {
    this.state.markRunChecked(id);
  }
}

/** One line per run, for the system prompt and list_runs. */
export function summarize(run: RunRow, live?: RunHandle, now = Date.now()): string {
  const head = `${run.id} ${run.tool}`;
  if (run.status === "running") {
    const state = live?.state() ?? "running";
    return `${head}: ${state} for ${seconds(now - Date.parse(run.startedAt))}`;
  }
  if (run.status === "lost") return `${head}: ${run.error}`;
  const outcome = run.ok ? "ok" : `failed: ${firstLine(run.error)}`;
  return `${head}: finished in ${seconds(run.durationMs ?? 0)}, ${outcome}${run.checked ? "" : " (not checked yet)"}`;
}

/** Full status of one run: state, result once done, and the last `tail` output lines. Marks a finished run checked. */
export function describe(runs: RunTable, id: string, tail: number): string | undefined {
  const before = runs.get(id);
  if (!before) return undefined;
  const live = runs.handle(id);
  // Describing a finished run is the agent checking it.
  if (before.status !== "running") runs.markChecked(id);
  const run = runs.get(id) as RunRow;

  const lines = run.status === "running" ? (live?.logs() ?? []) : run.logs;
  const parts = [summarize(run, live)];
  if (run.status === "done") {
    parts.push(
      !run.ok
        ? `error: ${run.error}`
        : run.value === null || run.value === undefined
          ? lines.length > 0
            ? "(no return value; see the output)"
            : NO_RESULT
          : typeof run.value === "string"
            ? run.value
            : JSON.stringify(run.value, null, 2),
    );
  }
  if (lines.length > 0) {
    const shown = lines.slice(-tail);
    const label =
      shown.length < lines.length ? `last ${shown.length} of ${lines.length} lines` : `${lines.length} lines`;
    parts.push(`--- output (${label}) ---\n${shown.join("\n")}`);
  }
  return parts.join("\n");
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function firstLine(s: string | null | undefined): string {
  return (s ?? "").split("\n")[0] ?? "";
}
