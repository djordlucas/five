// Structured logging: one JSON object per line.
//
// Every component takes a Logger and narrows it with child() to the agent, turn
// or run it is working on, so any line can be traced back to who did what. The
// default is a logger that writes nothing, so tests and embedders opt in.
//
// Content — prompts, tool arguments, results — is logged at debug only, as a
// preview; nothing logs the API key.

import * as fs from "node:fs";
import * as path from "node:path";

export type Level = "debug" | "info" | "warn" | "error";
export const LEVELS: readonly Level[] = ["debug", "info", "warn", "error"];

export type Fields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  /** A logger whose every line carries `bindings`. */
  child(bindings: Fields): Logger;
  /** Whether a line at `level` would be written; for skipping expensive fields. */
  enabled(level: Level): boolean;
}

export type Sink = (line: string) => void;

export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => noopLogger,
  enabled: () => false,
};

export function createLogger(opts: { level: Level; sinks: Sink[]; bindings?: Fields }): Logger {
  const min = LEVELS.indexOf(opts.level);
  const make = (bindings: Fields): Logger => {
    const write = (level: Level, msg: string, fields?: Fields) => {
      if (LEVELS.indexOf(level) < min) return;
      const line = `${JSON.stringify({ t: new Date().toISOString(), level, msg, ...bindings, ...normalize(fields) })}\n`;
      for (const sink of opts.sinks) sink(line);
    };
    return {
      debug: (m, f) => write("debug", m, f),
      info: (m, f) => write("info", m, f),
      warn: (m, f) => write("warn", m, f),
      error: (m, f) => write("error", m, f),
      child: (more) => make({ ...bindings, ...more }),
      enabled: (level) => LEVELS.indexOf(level) >= min,
    };
  };
  return make(opts.bindings ?? {});
}

/**
 * Append lines to a file, synchronously so nothing is lost when the process
 * exits. When the file passes `maxBytes` it is renamed to `<file>.1`
 * (replacing an older one) and a new file is started.
 */
export function fileSink(file: string, maxBytes = 50 * 1024 * 1024): Sink {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd = fs.openSync(file, "a");
  let size = fs.fstatSync(fd).size;
  return (line) => {
    if (size + line.length > maxBytes && size > 0) {
      fs.closeSync(fd);
      fs.renameSync(file, `${file}.1`);
      fd = fs.openSync(file, "a");
      size = 0;
    }
    fs.writeSync(fd, line);
    size += Buffer.byteLength(line);
  };
}

export function stderrSink(): Sink {
  return (line) => process.stderr.write(line);
}

/** Error objects become `{ error, stack }`; everything else passes through. */
function normalize(fields?: Fields): Fields | undefined {
  if (!fields) return undefined;
  const out: Fields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v instanceof Error) {
      out[k] = v.message;
      if (v.stack) out[`${k}_stack`] = v.stack;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** A bounded preview of text for debug lines. */
export function preview(s: string | null | undefined, n = 500): string | undefined {
  if (s === null || s === undefined) return undefined;
  return s.length > n ? `${s.slice(0, n)}… (${s.length} chars)` : s;
}

export function parseLevel(v: string | undefined, fallback: Level): Level {
  return LEVELS.includes(v as Level) ? (v as Level) : fallback;
}
