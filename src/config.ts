// Configuration comes from the environment only. `npm start` loads .env when
// present; the container sets the same variables.

import * as path from "node:path";
import { DEFAULTS, type SupervisorSettings } from "./agent/supervisor.ts";
import { OLLAMA_ENDPOINT } from "./llm/ollama.ts";
import { type Level, parseLevel } from "./log.ts";

export interface Config {
  model: string;
  endpoint: string;
  /** The context window Ollama loads the model with (num_ctx), in tokens. */
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
  /** Model calls one turn may take before the supervisor ends it. */
  maxSteps: number;
  /** Wall-clock budget of one run. */
  runTimeoutMs: number;
  /** V8 heap cap of one run, in MiB. */
  runMemoryMb: number;
  /** Pause between two turns. */
  turnDelayMs: number;
  /** The supervisor's settings, before any change made through the API: see src/agent/supervisor.ts. */
  supervisor: SupervisorSettings;
  /** Start looping as soon as five starts, even if it was paused when it last stopped. */
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
    model: env.FIVE_OLLAMA_MODEL ?? "qwen3.5:9b",
    endpoint: env.FIVE_OLLAMA_ENDPOINT ?? OLLAMA_ENDPOINT,
    contextTokens: int(env.FIVE_CONTEXT_TOKENS, 32_768),
    keepAlive: env.FIVE_OLLAMA_KEEP_ALIVE ?? "",
    think: flag(env.FIVE_THINK, "FIVE_THINK"),
    workspace,
    home,
    stateDb: path.join(home, "five.db"),
    maxSteps: int(env.FIVE_MAX_STEPS, 30),
    runTimeoutMs: int(env.FIVE_RUN_TIMEOUT_MS, 60_000),
    runMemoryMb: int(env.FIVE_RUN_MEMORY_MB, 1024),
    turnDelayMs: int(env.FIVE_TURN_DELAY_MS, 1000),
    supervisor: supervisorDefaults(env),
    autostart: flag(env.FIVE_AUTOSTART, "FIVE_AUTOSTART"),
    apiAddr: env.FIVE_API_ADDR ?? "127.0.0.1:5555",
    logLevel: parseLevel(env.FIVE_LOG_LEVEL, "info"),
    logFile: env.FIVE_LOG_FILE === "off" ? "" : path.resolve(workspace, env.FIVE_LOG_FILE ?? ".five/five.log"),
  };
}

/** The supervisor's defaults, with what the environment sets. FIVE_FOLD_REPLIES=off also keeps idle turns. */
function supervisorDefaults(env: NodeJS.ProcessEnv): SupervisorSettings {
  const fold = flag(env.FIVE_FOLD_REPLIES ?? "on", "FIVE_FOLD_REPLIES");
  return {
    ...DEFAULTS,
    contextWarn: Math.min(int(env.FIVE_CONTEXT_WARN, DEFAULTS.contextWarn), 100),
    contextTrim: Math.min(int(env.FIVE_CONTEXT_TRIM, DEFAULTS.contextTrim), 100),
    foldReplies: fold,
    dropIdle: fold,
    idleTurns: int(env.FIVE_IDLE_TURNS, DEFAULTS.idleTurns),
    resultChars: Math.min(int(env.FIVE_RESULT_CHARS, DEFAULTS.resultChars), 16_000),
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
