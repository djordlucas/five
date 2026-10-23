// Wiring: one five, from configuration and a model client. main.ts uses it,
// and so do tests, with a scripted model.

import * as path from "node:path";
import { Loop } from "./agent/loop.ts";
import { RunTable } from "./agent/runs.ts";
import type { Config } from "./config.ts";
import type { ChatModel } from "./llm/model.ts";
import { type Logger, noopLogger } from "./log.ts";
import { createRunner, llmModule, type Runner, toolsModule } from "./runner/index.ts";
import { State } from "./state.ts";
import { ToolStore } from "./tools/store.ts";

export interface Five {
  state: State;
  store: ToolStore;
  runner: Runner;
  runs: RunTable;
  loop: Loop;
  close(): Promise<void>;
}

export function createFive(cfg: Config, model: ChatModel, log: Logger = noopLogger): Five {
  const state = new State(cfg.stateDb);
  const lost = state.markLostRuns();
  if (lost > 0) log.warn("background runs lost at restart", { count: lost });
  const store = new ToolStore(state, path.join(cfg.home, "tools"));
  const runnerLog = log.child({ component: "runner" });
  const runner: Runner = createRunner({
    home: cfg.home,
    cwd: cfg.workspace,
    timeoutMs: cfg.runTimeoutMs,
    memoryMb: cfg.runMemoryMb,
    host: { llm: llmModule(model), tools: toolsModule(store, () => runner, runnerLog) },
    // How five.db() in a run knows which database to refuse.
    env: { FIVE_STATE_DB: state.path },
    log: runnerLog,
  });
  const runs = new RunTable(state, log);
  const loop = new Loop({
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
    idleTurns: cfg.idleTurns,
    log,
  });
  return {
    state,
    store,
    runner,
    runs,
    loop,
    async close() {
      await loop.shutdown();
      await runs.shutdown();
      state.close();
    },
  };
}
