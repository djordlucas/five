#!/usr/bin/env node
// five: runs the loop, with the HTTP API and web UI, until stopped.
// The loop resumes if it was running when five last stopped; otherwise it
// waits for Start in the UI, unless FIVE_AUTOSTART=on.

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createApi } from "./api/server.ts";
import { createFive } from "./app.ts";
import { loadConfig } from "./config.ts";
import { Ollama } from "./llm/ollama.ts";
import { createLogger, fileSink, type Sink, stderrSink } from "./log.ts";

const cfg = (() => {
  try {
    return loadConfig();
  } catch (err) {
    console.error(`five: ${(err as Error).message}`);
    process.exit(2);
  }
})();

const sinks: Sink[] = [stderrSink()];
if (cfg.logFile) sinks.push(fileSink(cfg.logFile));
const log = createLogger({ level: cfg.logLevel, sinks });

const model = new Ollama({
  model: cfg.model,
  endpoint: cfg.endpoint,
  contextTokens: cfg.contextTokens,
  think: cfg.think,
  ...(cfg.keepAlive && { keepAlive: cfg.keepAlive }),
});
const five = createFive(cfg, model, log);
log.info("five started", {
  model: cfg.model,
  endpoint: cfg.endpoint,
  context_tokens: cfg.contextTokens,
  think: cfg.think,
  workspace: cfg.workspace,
  turn: five.loop.ctx.turn,
  messages: five.loop.ctx.messages.length,
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = createApi({ five, cfg, log, webDir: path.join(root, "web", "dist") });
const sep = cfg.apiAddr.lastIndexOf(":");
const host = cfg.apiAddr.slice(0, sep).replace(/^\[|\]$/g, "");
const port = Number(cfg.apiAddr.slice(sep + 1));
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, host, resolve);
}).catch((err: unknown) => {
  log.error("api could not listen", { addr: cfg.apiAddr, error: err });
  process.exit(1);
});
log.info("api listening", { addr: cfg.apiAddr, url: `http://${host.includes(":") ? `[${host}]` : host}:${port}` });

if (cfg.autostart || five.loop.wasRunning) five.loop.start();

let closing = false;
async function close(code: number): Promise<void> {
  if (closing) process.exit(code);
  closing = true;
  log.info("five stopping", { busy: five.loop.status().busy });
  server.closeAllConnections();
  server.close();
  await five.close();
  log.info("five stopped", { exit_code: code });
  process.exit(code);
}
process.on("SIGINT", () => void close(130));
process.on("SIGTERM", () => void close(143));
