// Wiring: one five, from configuration and a model client. main.ts uses it,
// and so do tests, with a scripted model.

import * as fs from "node:fs";
import * as path from "node:path";
import { ProcessTable } from "./agent/processes.ts";
import { RunTable } from "./agent/runs.ts";
import type { Config } from "./config.ts";
import type { ChatModel } from "./llm/model.ts";
import { type Logger, noopLogger } from "./log.ts";
import { createRunner, llmModule, type RunHandle, type Runner, toolsModule } from "./runner/index.ts";
import { State } from "./state.ts";
import { LibraryStore } from "./tools/libs.ts";
import { ToolStore } from "./tools/store.ts";
import { HISTORY_DIR } from "./workers/history.ts";
import { runScope } from "./workers/run.ts";
import { Scheduler } from "./workers/scheduler.ts";
import { AGENT_ID } from "./workers/tools.ts";

export interface Five {
  state: State;
  store: ToolStore;
  libs: LibraryStore;
  runner: Runner;
  runs: RunTable;
  /** Every child process started since five started. */
  processes: ProcessTable;
  /** The main loop: the workers, the board, the settings. */
  five: Scheduler;
  /** Start over; with `clean`, also delete the agent's tools, libraries and workspace files. */
  reset(opts?: { clean?: boolean }): void;
  close(): Promise<void>;
}

/** leadModel: the lead's own model, when it has one. */
export function createFive(cfg: Config, model: ChatModel, log: Logger = noopLogger, leadModel?: ChatModel): Five {
  const state = new State(cfg.stateDb);
  const lost = state.markLostRuns();
  if (lost > 0) log.warn("background runs lost at restart", { count: lost });
  const store = new ToolStore(state, path.join(cfg.home, "tools"));
  const libs = new LibraryStore(state);
  const runnerLog = log.child({ component: "runner" });
  // A process belongs to the run whose code started it.
  const processes = new ProcessTable(cfg.home, () => {
    const run = runScope.getStore();
    return { run: run?.n ?? 0, step: run?.step ?? 0 };
  });
  // The model, for five.llm.chat in run_js: through the slots, like every call.
  let scheduler: Scheduler | undefined;
  const pooled: ChatModel = {
    complete: async (req) => {
      if (!scheduler) throw new Error("five is starting");
      return (await scheduler.pool.complete(req)).completion;
    },
  };
  const runner: Runner = processes.watch(
    createRunner({
      home: cfg.home,
      cwd: cfg.workspace,
      timeoutMs: cfg.runTimeoutMs,
      memoryMb: cfg.runMemoryMb,
      host: {
        llm: llmModule(pooled),
        tools: toolsModule(store, () => runner, runnerLog),
      },
      // How five.db() in a run knows which database to refuse.
      env: { FIVE_STATE_DB: state.path },
      log: runnerLog,
    }),
  );
  const runs = new TaggedRunTable(state, log, processes);
  scheduler = new Scheduler({
    state,
    store,
    libs,
    runner,
    runs,
    model,
    ...(leadModel && { leadModel }),
    workspace: cfg.workspace,
    settings: cfg.settings,
    tickMs: cfg.tickMs,
    log,
  });
  const five = scheduler;
  return {
    state,
    store,
    libs,
    runner,
    runs,
    processes,
    five,
    reset(opts = {}) {
      five.reset({
        clear: () => {
          // Runs are numbered afresh: the history of the old ones goes.
          fs.rmSync(path.join(cfg.workspace, HISTORY_DIR), { recursive: true, force: true });
          if (!opts.clean) return;
          // Run from the repo, the workspace is the repo: never delete that.
          if (fs.existsSync(path.join(cfg.workspace, ".git"))) {
            throw new Error(`the workspace ${cfg.workspace} is a git repository; its files are not deleted`);
          }
          runs.killAll(AGENT_ID);
          const tools = store.list().map((t) => t.name);
          for (const name of tools) store.remove(name);
          for (const lib of libs.list()) libs.remove(lib.name);
          state.db.exec("DELETE FROM runs");
          const files = fs.readdirSync(cfg.workspace).filter((f) => f !== ".five");
          for (const f of files) fs.rmSync(path.join(cfg.workspace, f), { recursive: true, force: true });
          log.info("workspace cleaned", { tools: tools.length, entries: files.length });
        },
      });
      log.info("five reset", { clean: Boolean(opts.clean) });
    },
    async close() {
      await five.shutdown();
      await runs.shutdown();
      state.close();
    },
  };
}

/** seven's run table, marking each background run's process with its run id. */
class TaggedRunTable extends RunTable {
  private readonly processes: ProcessTable;
  constructor(state: State, log: Logger, processes: ProcessTable) {
    super(state, log);
    this.processes = processes;
  }
  override add(agent: string, tool: string, handle: RunHandle): string {
    const id = super.add(agent, tool, handle);
    this.processes.tag(handle.id, id);
    return id;
  }
}
