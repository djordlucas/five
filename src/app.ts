// Wiring: one five, from configuration and a model client. main.ts uses it,
// and so do tests, with a scripted model.

import * as path from "node:path";
import { Loop } from "./agent/loop.ts";
import { ProcessTable } from "./agent/processes.ts";
import { RunTable } from "./agent/runs.ts";
import type { Config } from "./config.ts";
import type { ChatModel } from "./llm/model.ts";
import { type Logger, noopLogger } from "./log.ts";
import { createRunner, llmModule, type RunHandle, type Runner, toolsModule } from "./runner/index.ts";
import { State } from "./state.ts";
import { ToolStore } from "./tools/store.ts";

export interface Five {
  state: State;
  store: ToolStore;
  runner: Runner;
  runs: RunTable;
  /** Every child process started since five started. */
  processes: ProcessTable;
  loop: Loop;
  close(): Promise<void>;
}

export function createFive(cfg: Config, model: ChatModel, log: Logger = noopLogger): Five {
  const state = new State(cfg.stateDb);
  const lost = state.markLostRuns();
  if (lost > 0) log.warn("background runs lost at restart", { count: lost });
  const store = new ToolStore(state, path.join(cfg.home, "tools"));
  const runnerLog = log.child({ component: "runner" });
  // The loop is made below; a process only starts once it runs.
  let loop: Loop | undefined;
  const processes = new ProcessTable(cfg.home, () => ({ turn: loop?.ctx.turn ?? 0, step: loop?.status().step ?? 0 }));
  const runner: Runner = processes.watch(
    createRunner({
      home: cfg.home,
      cwd: cfg.workspace,
      timeoutMs: cfg.runTimeoutMs,
      memoryMb: cfg.runMemoryMb,
      host: { llm: llmModule(model), tools: toolsModule(store, () => runner, runnerLog) },
      // How five.db() in a run knows which database to refuse.
      env: { FIVE_STATE_DB: state.path },
      log: runnerLog,
    }),
  );
  const runs = new TaggedRunTable(state, log, processes);
  loop = new Loop({
    state,
    store,
    runner,
    runs,
    model,
    workspace: cfg.workspace,
    stateDb: state.path,
    contextTokens: cfg.contextTokens,
    maxSteps: cfg.maxSteps,
    turnDelayMs: cfg.turnDelayMs,
    contextWarn: cfg.contextWarn,
    contextTrim: cfg.contextTrim,
    foldReplies: cfg.foldReplies,
    idleTurns: cfg.idleTurns,
    resultChars: cfg.resultChars,
    log,
  });
  return {
    state,
    store,
    runner,
    runs,
    processes,
    loop,
    async close() {
      await loop.shutdown();
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
