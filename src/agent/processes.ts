// Every child process five starts — a run_js, a call of a tool the agent
// built, a define_tool trial, a background run, a tool called from inside
// another run — recorded as it starts, for the web UI to follow and kill.
// The runner is seven's and stays as it is: the table wraps it.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ProcessDetail, ProcessInfo } from "../api/types.ts";
import type { Logger } from "../log.ts";
import type { EvalOptions, RunHandle, Runner, RunResult } from "../runner/index.ts";

/** Finished processes kept, newest first; live ones are always kept. */
const KEEP = 200;
/** The longest source kept with a process. */
const MAX_SOURCE_CHARS = 100_000;
/** Output lines a detail returns, the last ones. */
const MAX_LOG_LINES = 2000;

interface Proc {
  kind: ProcessInfo["kind"];
  label: string;
  source: string;
  args: unknown;
  turn: number;
  step: number;
  handle: RunHandle;
  result?: RunResult;
  runId?: string;
}

export class ProcessTable {
  private readonly procs: Proc[] = [];
  private readonly home: string;
  private readonly where: () => { turn: number; step: number };

  /** where: the loop's turn and step, when a process starts. */
  constructor(home: string, where: () => { turn: number; step: number }) {
    this.home = path.resolve(home);
    this.where = where;
  }

  /** The runner, recording every process it starts here. */
  watch(runner: Runner): Runner {
    const watched: Runner = {
      home: runner.home,
      install: (source, deps, log) => runner.install(source, deps, log),
      startFile: (file, args, timeoutMs, log) => {
        const handle = runner.startFile(file, args, timeoutMs, log);
        this.add(handle, { ...this.describeFile(file), args });
        return handle;
      },
      startEval: (source: string, opts: EvalOptions = {}) => {
        const handle = runner.startEval(source, opts);
        this.add(handle, { kind: "code", label: "run_js", source, args: opts.args });
        return handle;
      },
      runFile: (file: string, args?: unknown, timeoutMs?: number, log?: Logger) =>
        watched.startFile(file, args, timeoutMs, log).done,
      eval: (source: string, opts?: EvalOptions) => watched.startEval(source, opts).done,
    };
    return watched;
  }

  /** Mark a process as the background run with this id (r1, r2, …). */
  tag(handleId: string, runId: string): void {
    const p = this.procs.find((x) => x.handle.id === handleId);
    if (p) p.runId = runId;
  }

  /** Newest first. */
  list(): ProcessInfo[] {
    return this.procs.map((p) => this.info(p));
  }

  get(id: string): ProcessDetail | undefined {
    const p = this.procs.find((x) => x.handle.id === id);
    if (!p) return undefined;
    const logs = p.result?.logs ?? p.handle.logs();
    return {
      ...this.info(p),
      source: p.source,
      args: p.args ?? null,
      logs: logs.slice(-MAX_LOG_LINES),
      ...(p.result?.ok && { value: p.result.value ?? null }),
    };
  }

  /** Kill a live process; false when there is none by that id, or it is done. */
  kill(id: string): boolean {
    const p = this.procs.find((x) => x.handle.id === id);
    if (!p || p.result) return false;
    p.handle.kill();
    return true;
  }

  private add(handle: RunHandle, what: Pick<Proc, "kind" | "label" | "source" | "args">): void {
    const p: Proc = { ...what, ...this.where(), handle };
    if (p.source.length > MAX_SOURCE_CHARS) p.source = `${p.source.slice(0, MAX_SOURCE_CHARS)}\n… [cut]`;
    this.procs.unshift(p);
    void handle.done.then((r) => {
      p.result = r;
      this.prune();
    });
  }

  private prune(): void {
    let done = 0;
    for (let i = 0; i < this.procs.length; i++) {
      if (!(this.procs[i] as Proc).result) continue;
      if (++done > KEEP) this.procs.splice(i--, 1);
    }
  }

  private info(p: Proc): ProcessInfo {
    const r = p.result;
    return {
      id: p.handle.id,
      kind: p.kind,
      label: p.label,
      turn: p.turn,
      step: p.step,
      startedAt: new Date(p.handle.startedAt).toISOString(),
      state: !r
        ? p.handle.state() === "installing"
          ? "installing"
          : "running"
        : r.ok
          ? "ok"
          : r.error === "killed"
            ? "killed"
            : "failed",
      durationMs: r ? r.durationMs : Date.now() - p.handle.startedAt,
      lines: (r?.logs ?? p.handle.logs()).length,
      ...(r && !r.ok && r.error && { error: r.error }),
      ...(p.runId && { runId: p.runId }),
    };
  }

  /** What a module file is: a tool the agent built, a define_tool trial, or another file. */
  private describeFile(file: string): Pick<Proc, "kind" | "label" | "source"> {
    let source = "";
    try {
      source = fs.readFileSync(file, "utf8");
    } catch {
      // Gone already: the run will fail and say so.
    }
    const rel = path.relative(this.home, path.resolve(file)).split(path.sep);
    if (rel[0] === "tools" && rel[1]) return { kind: "tool", label: rel[1], source };
    const trial = rel[0] === "tmp" ? /^trial-(.+)-[^-]+$/.exec(rel[1] ?? "") : null;
    if (trial) return { kind: "trial", label: `define_tool ${trial[1]}`, source };
    return { kind: "tool", label: path.basename(file), source };
  }
}
