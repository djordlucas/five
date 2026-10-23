// Five's own state, in one SQLite file: <workspace>/.five/five.db.
//
// The context (system prompt, messages, next prompt), the event log the web UI
// follows, generated tools and their run history, and background runs all
// live here, so a restart resumes where the last process stopped. The tool and
// run tables are seven's.

import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Event, EventBody } from "./api/types.ts";
import type { Message } from "./llm/model.ts";

export type { Event, EventBody, TurnEnd } from "./api/types.ts";

/** Everything the model sees, and the prompt that starts its next turn. */
export interface Context {
  system: string;
  messages: Message[];
  /** The user message that starts the next turn. */
  next: string;
  /** Turns started so far. */
  turn: number;
}

export interface RunRow {
  id: string;
  agent: string;
  tool: string;
  status: "running" | "done" | "lost";
  ok: boolean | null;
  value: unknown;
  error: string | null;
  logs: string[];
  durationMs: number | null;
  startedAt: string;
  checked: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  turn INTEGER NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_turn ON events (turn, seq);
CREATE TABLE IF NOT EXISTS tools (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  parameters TEXT NOT NULL,
  deps TEXT NOT NULL,
  packages TEXT NOT NULL,
  timeout_ms INTEGER,
  disabled_at TEXT,
  disabled_reason TEXT,
  revision INTEGER NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tool_runs (
  id INTEGER PRIMARY KEY,
  tool TEXT NOT NULL,
  revision INTEGER NOT NULL,
  agent TEXT NOT NULL,
  mode TEXT NOT NULL,
  ok INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  error TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tool_runs_tool ON tool_runs (tool, id);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  tool TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'done', 'lost')),
  ok INTEGER,
  value TEXT,
  error TEXT,
  logs TEXT,
  duration_ms INTEGER,
  started_at TEXT NOT NULL,
  checked INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO meta (key, value) VALUES ('run_seq', '0');
`;

const now = () => new Date().toISOString();

export class State {
  readonly db: DatabaseSync;
  readonly path: string;

  constructor(file: string) {
    this.path = path.resolve(file);
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  get isOpen(): boolean {
    return this.db.isOpen;
  }

  // ── context ───────────────────────────────────────────────────────────────

  /** The saved context, or none before the first save. */
  loadContext(): Context | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'context'").get() as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as Context) : undefined;
  }

  saveContext(ctx: Context): void {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES ('context', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run(JSON.stringify(ctx));
  }

  /** A small saved setting, or undefined when never set. */
  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  // ── events ────────────────────────────────────────────────────────────────

  addEvent(turn: number, body: EventBody): Event {
    const at = now();
    const r = this.db
      .prepare("INSERT INTO events (at, turn, body) VALUES (?, ?, ?)")
      .run(at, turn, JSON.stringify(body));
    return { ...body, seq: Number(r.lastInsertRowid), at, turn };
  }

  /** Events after `seq`, oldest first, at most `limit`. */
  eventsAfter(seq: number, limit: number): Event[] {
    return this.db.prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?").all(seq, limit).map(toEvent);
  }

  /** Every event of the last `turns` turns, oldest first. */
  recentEvents(turns: number): Event[] {
    return this.db
      .prepare("SELECT * FROM events WHERE turn > (SELECT COALESCE(MAX(turn), 0) FROM events) - ? ORDER BY seq")
      .all(turns)
      .map(toEvent);
  }

  /** The events of one turn, oldest first. */
  turnEvents(turn: number): Event[] {
    return this.db.prepare("SELECT * FROM events WHERE turn = ? ORDER BY seq").all(turn).map(toEvent);
  }

  lastSeq(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get() as { seq: number };
    return Number(row.seq);
  }

  clearEvents(): void {
    this.db.exec("DELETE FROM events");
  }

  // ── background runs (seven's) ─────────────────────────────────────────────

  insertRun(agent: string, tool: string): string {
    const row = this.db
      .prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'run_seq' RETURNING value")
      .get() as { value: number | string };
    const id = `r${Number(row.value)}`;
    this.db
      .prepare("INSERT INTO runs (id, agent, tool, status, started_at) VALUES (?, ?, ?, 'running', ?)")
      .run(id, agent, tool, now());
    return id;
  }

  finishRun(id: string, r: { ok: boolean; value?: unknown; error?: string; logs: string[]; durationMs: number }): void {
    this.db
      .prepare("UPDATE runs SET status = 'done', ok = ?, value = ?, error = ?, logs = ?, duration_ms = ? WHERE id = ?")
      .run(
        r.ok ? 1 : 0,
        r.value === undefined ? null : JSON.stringify(r.value),
        r.error ?? null,
        JSON.stringify(r.logs),
        r.durationMs,
        id,
      );
  }

  markRunChecked(id: string): void {
    this.db.prepare("UPDATE runs SET checked = 1 WHERE id = ?").run(id);
  }

  getRun(id: string): RunRow | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
    return row ? toRun(row) : undefined;
  }

  listRuns(agent: string, limit = 50): RunRow[] {
    return this.db
      .prepare(
        "SELECT * FROM (SELECT rowid AS seq, * FROM runs WHERE agent = ? ORDER BY rowid DESC LIMIT ?) ORDER BY seq",
      )
      .all(agent, limit)
      .map(toRun);
  }

  /** Runs recorded as running belong to a process that is gone; their output is lost. */
  markLostRuns(): number {
    const r = this.db
      .prepare(
        "UPDATE runs SET status = 'lost', ok = 0, error = 'lost: five restarted while it ran' WHERE status = 'running'",
      )
      .run();
    return Number(r.changes);
  }
}

type Row = Record<string, SQLInputValue>;

function toEvent(r: unknown): Event {
  const x = r as Row;
  return { ...(JSON.parse(String(x.body)) as EventBody), seq: Number(x.seq), at: String(x.at), turn: Number(x.turn) };
}

function toRun(r: unknown): RunRow {
  const x = r as Row;
  return {
    id: String(x.id),
    agent: String(x.agent),
    tool: String(x.tool),
    status: x.status as RunRow["status"],
    ok: x.ok === null ? null : Boolean(x.ok),
    value: x.value === null ? undefined : JSON.parse(String(x.value)),
    error: x.error === null ? null : String(x.error),
    logs: x.logs === null ? [] : (JSON.parse(String(x.logs)) as string[]),
    durationMs: x.duration_ms === null ? null : Number(x.duration_ms),
    startedAt: String(x.started_at),
    checked: Boolean(x.checked),
  };
}
