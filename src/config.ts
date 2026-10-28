// Configuration comes from the environment only. `npm start` loads .env when
// present; the container sets the same variables.

import * as path from "node:path";
import { OLLAMA_ENDPOINT } from "./llm/ollama.ts";
import { type Level, parseLevel } from "./log.ts";
import { DEFAULTS, type Settings } from "./workers/settings.ts";

export interface Config {
  model: string;
  endpoint: string;
  /** The context window of each of the model's slots (num_ctx), in tokens. */
  contextTokens: number;
  /** How long Ollama keeps the model loaded after a call; empty for Ollama's default. */
  keepAlive: string;
  /** Whether a thinking model thinks before each reply. */
  think: boolean;
  /** The working directory of every run; all of five's data lives in it. */
  workspace: string;
  /** Five's own data: <workspace>/.five — the state database, tool sources, node_modules. */
  home: string;
  /** Five's state database: <home>/five.db. */
  stateDb: string;
  /** Wall-clock budget of one run. */
  runTimeoutMs: number;
  /** V8 heap cap of one run, in MiB. */
  runMemoryMb: number;
  /** How often five looks for work to start. */
  tickMs: number;
  /** The settings, before any change made through the API: see src/workers/settings.ts. */
  settings: Settings;
  /** Start the workers as soon as five starts, even if it was paused when it last stopped. */
  autostart: boolean;
  /** Where the HTTP API and web UI listen (host:port). */
  apiAddr: string;
  logLevel: Level;
  /** JSON-lines log file; empty when logging to a file is off. */
  logFile: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const workspace = path.resolve(env.FIVE_WORKSPACE ?? process.cwd());
  const home = path.join(workspace, ".five");
  return {
    model: env.FIVE_OLLAMA_MODEL ?? "qwen3.5:4b",
    endpoint: env.FIVE_OLLAMA_ENDPOINT ?? OLLAMA_ENDPOINT,
    contextTokens: int(env.FIVE_CONTEXT_TOKENS, 16_384),
    keepAlive: env.FIVE_OLLAMA_KEEP_ALIVE ?? "",
    think: flag(env.FIVE_THINK, "FIVE_THINK"),
    workspace,
    home,
    stateDb: path.join(home, "five.db"),
    runTimeoutMs: int(env.FIVE_RUN_TIMEOUT_MS, 60_000),
    runMemoryMb: int(env.FIVE_RUN_MEMORY_MB, 1024),
    tickMs: int(env.FIVE_TICK_MS, 1000),
    settings: settingsDefaults(env),
    autostart: flag(env.FIVE_AUTOSTART, "FIVE_AUTOSTART"),
    apiAddr: env.FIVE_API_ADDR ?? "127.0.0.1:5555",
    logLevel: parseLevel(env.FIVE_LOG_LEVEL, "info"),
    logFile: env.FIVE_LOG_FILE === "off" ? "" : path.resolve(workspace, env.FIVE_LOG_FILE ?? ".five/five.log"),
  };
}

/** The settings' defaults, with what the environment sets. */
function settingsDefaults(env: NodeJS.ProcessEnv): Settings {
  return {
    ...DEFAULTS,
    slots: Math.max(1, int(env.FIVE_SLOTS, DEFAULTS.slots)),
    taskRuns: int(env.FIVE_TASK_RUNS, DEFAULTS.taskRuns),
    maxSteps: Math.max(1, int(env.FIVE_MAX_STEPS, DEFAULTS.maxSteps)),
    runTokens: Math.max(1000, int(env.FIVE_RUN_TOKENS, DEFAULTS.runTokens)),
    feedsEverySeconds: int(env.FIVE_FEEDS_EVERY, DEFAULTS.feedsEverySeconds),
  };
}

function flag(v: string | undefined, name: string): boolean {
  if (v === undefined || v === "" || v === "off" || v === "0") return false;
  if (v === "on" || v === "1") return true;
  throw new Error(`${name} must be on or off, not "${v}"`);
}

function int(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return v !== undefined && Number.isInteger(n) && n >= 0 ? n : fallback;
}
